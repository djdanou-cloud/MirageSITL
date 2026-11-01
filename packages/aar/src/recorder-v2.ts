// Recorder v2 (TASK-162): the producer fan-out in the physics Worker, its own
// SPSC queue, and the consumer that turns rows into format v2 chunks.
//
// The producer is the second consumer of nothing: it runs inside the session's
// record hook (PhysicsSessionV2.setRecorder), which hands it the tick's truth,
// pilot input, actuator frame, sensor frame and power telemetry, so the
// flight queues keep their single consumers. Per physics signal it keeps a
// tick when an integer accumulator of the effective rate reaches the physics
// rate, so N ticks keep exactly floor(N·effective/physics) samples and none
// twice; per sensor kind (aperiodic) it keeps a frame when at least
// physics/effective ticks passed since the last kept one. A kept sample whose
// source did not produce it (no electrical drive, no actuator frame this
// tick) writes no row and is counted as absent. The producer never waits and
// never allocates after construction: a full queue drops the row and counts
// it, and the next row it delivers carries the count.
//
// Queue (its own SharedArrayBuffer; every shared word is an atomic int32):
//   header 64 bytes: 0 magic "ARQ2", 4 version 1, 8 write, 12 read, 16 rows lost
//   counters 1024 bytes at 64: per signal ID 0..127, rows kept (u32) then absent (u32)
//   slots QUEUE_SLOTS × SLOT_BYTES at 1088: one padded format v2 row each
import type { ActuatorFrameV2, FlightStateV2, PowerTelemetrySource, SensorFrameV2 } from "@mirage/protocol";
import {
  ChunkBuilder, checkRow, MAX_ROW_BYTES, paddedRowBytes, ROW_HEADER_BYTES, RowFlag, RowOffset,
} from "./format-v2.ts";
import { SignalId, signalById, type RatePlan } from "./signal-catalog.ts";

export const QUEUE_MAGIC_V2 = 0x32515241; // "ARQ2"
export const QUEUE_SLOTS = 2048;
export const SLOT_BYTES = MAX_ROW_BYTES;
const SLOT_WORDS = SLOT_BYTES / 4;
const HEADER_BYTES = 64, COUNTER_BYTES = 128 * 8;
const SLOTS_AT = HEADER_BYTES + COUNTER_BYTES;
export const QUEUE_BYTES_V2 = SLOTS_AT + QUEUE_SLOTS * SLOT_BYTES;
const W = { magic: 0, version: 1, write: 2, read: 3, lost: 4 } as const;
const KEPT_WORD = HEADER_BYTES / 4, ABSENT_WORD = KEPT_WORD + 1;

export function createRecordingQueueV2(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(QUEUE_BYTES_V2), words = new Int32Array(buffer);
  Atomics.store(words, W.magic, QUEUE_MAGIC_V2);
  Atomics.store(words, W.version, 1);
  return buffer;
}
function queueWords(buffer: SharedArrayBuffer): Int32Array {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== QUEUE_BYTES_V2) throw new Error("Invalid recording queue v2");
  const words = new Int32Array(buffer);
  if (Atomics.load(words, W.magic) !== QUEUE_MAGIC_V2 || Atomics.load(words, W.version) !== 1) throw new Error("Recording queue v2 ABI mismatch");
  return words;
}

/** What the producer reads per tick: the fields of PhysicsSessionV2's SessionRecordSample. */
export interface ProducerSample {
  readonly state: FlightStateV2;
  readonly pilot: Float64Array;
  readonly actuator: ActuatorFrameV2 | null;
  readonly sensor: SensorFrameV2 | null;
  readonly power: PowerTelemetrySource | null;
}

/** The physics and sensor part of a plan, as plain numbers the physics Worker receives. */
export interface ProducerPlan {
  readonly physicsHz: number;
  /** Effective rate per signal ID (index), 0 when not recorded; physics signals 1..15 and sensors 16..20. */
  readonly effectiveHz: readonly number[];
}
export function producerPlan(plan: RatePlan): ProducerPlan {
  const effectiveHz = new Array<number>(21).fill(0);
  for (const signal of plan.signals) if ((signal.source === "physics" || signal.source === "sensor") && signal.effectiveHz) effectiveHz[signal.id] = signal.effectiveHz;
  return { physicsHz: plan.physicsHz, effectiveHz };
}
export function isProducerPlan(value: unknown): value is ProducerPlan {
  if (typeof value !== "object" || value === null || !("physicsHz" in value) || !("effectiveHz" in value)) return false;
  const { physicsHz, effectiveHz } = value;
  return typeof physicsHz === "number" && [400, 800, 1200].includes(physicsHz) && Array.isArray(effectiveHz) && effectiveHz.length === 21 &&
    effectiveHz.every((hz: unknown, id: number) => typeof hz === "number" && Number.isInteger(hz) && hz >= 0 && hz <= physicsHz && (hz === 0 || (id >= 1 && id <= 20)));
}

const PHYSICS_FIRST = SignalId.TruthPosition, PHYSICS_LAST = SignalId.Battery;
const SENSOR_FIRST = SignalId.SensorImu, SENSOR_LAST = SignalId.SensorAirspeed;
/** Power telemetry rows per motor: rpm, motor current, bus current, electrical power, command (power-v1.ts). */
const POWER_STRIDE = 5;

/** Writes kept samples of each physics tick into the queue. Zero allocation after construction. */
export class RecordingProducerV2 {
  private readonly words: Int32Array;
  private readonly physicsHz: number;
  private readonly effective = new Int32Array(21);
  private readonly accumulator = new Int32Array(21);
  private readonly lastKept = new Float64Array(21).fill(-1);
  private readonly row = new Uint8Array(SLOT_BYTES);
  private readonly rowView = new DataView(this.row.buffer);
  private readonly rowWords = new Int32Array(this.row.buffer);
  private pendingLost = 0;

  constructor(buffer: SharedArrayBuffer, plan: ProducerPlan) {
    if (!isProducerPlan(plan)) throw new Error("Invalid recording producer plan");
    this.words = queueWords(buffer);
    this.physicsHz = plan.physicsHz;
    for (let id = 0; id < 21; id++) this.effective[id] = plan.effectiveHz[id] ?? 0;
  }

  /** Called once per physics tick from the session's record hook. */
  record(sample: ProducerSample): void {
    const state = sample.state;
    const tick = state.tickId.hi * 4294967296 + state.tickId.lo;
    for (let id = PHYSICS_FIRST; id <= PHYSICS_LAST; id++) {
      const rate = this.effective[id]!;
      if (rate === 0) continue;
      const sum = this.accumulator[id]! + rate;
      if (sum < this.physicsHz) { this.accumulator[id] = sum; continue; }
      this.accumulator[id] = sum - this.physicsHz;
      if (this.encodePhysics(id, sample)) this.push(id);
      else Atomics.add(this.words, ABSENT_WORD + id * 2, 1);
    }
    const sensor = sample.sensor;
    if (sensor !== null && sensor.kind >= 1 && sensor.kind <= 5) {
      const id = SENSOR_FIRST - 1 + sensor.kind;
      const rate = this.effective[id]!;
      const last = this.lastKept[id]!;
      if (rate > 0 && id <= SENSOR_LAST && (last < 0 || (tick - last) * rate >= this.physicsHz)) {
        this.lastKept[id] = tick;
        this.encodeSensor(id, sensor);
        this.push(id);
      }
    }
  }

  private begin(id: number, channels: number, payload: number, presence: number): void {
    const v = this.rowView;
    v.setUint16(RowOffset.signal, id, true);
    v.setUint16(RowOffset.flags, 0, true);
    v.setUint32(RowOffset.presence, presence >>> 0, true);
    v.setUint16(RowOffset.channelCount, channels, true);
    v.setUint16(RowOffset.payloadBytes, payload, true);
    v.setUint32(RowOffset.reserved, 0, true);
  }
  private stamp(state: FlightStateV2): void {
    const v = this.rowView;
    v.setUint32(RowOffset.tickLo, state.tickId.lo, true);
    v.setUint32(RowOffset.tickHi, state.tickId.hi, true);
    v.setFloat64(RowOffset.simTimeS, state.simTimeS, true);
    v.setUint32(RowOffset.epoch, state.epoch, true);
  }
  /**
   * Encodes physics signal `id`; false when this tick's source did not produce it.
   * Values go straight into the row with DataView setters: a helper taking a
   * double argument that V8 does not inline would box the double on the heap.
   */
  private encodePhysics(id: number, sample: ProducerSample): boolean {
    const s = sample.state, v = this.rowView, at = ROW_HEADER_BYTES;
    this.stamp(s);
    switch (id) {
      case SignalId.TruthPosition:
        this.begin(id, 3, 24, 7); v.setFloat64(at, s.northM, true); v.setFloat64(at + 8, s.eastM, true); v.setFloat64(at + 16, s.downM, true); return true;
      case SignalId.TruthVelocity:
        this.begin(id, 3, 24, 7); v.setFloat64(at, s.vnMps, true); v.setFloat64(at + 8, s.veMps, true); v.setFloat64(at + 16, s.vdMps, true); return true;
      case SignalId.TruthAttitude:
        this.begin(id, 4, 32, 15); v.setFloat64(at, s.qw, true); v.setFloat64(at + 8, s.qx, true); v.setFloat64(at + 16, s.qy, true); v.setFloat64(at + 24, s.qz, true);
        return true;
      case SignalId.TruthRates:
        this.begin(id, 3, 24, 7); v.setFloat64(at, s.pRadS, true); v.setFloat64(at + 8, s.qRadS, true); v.setFloat64(at + 16, s.rRadS, true); return true;
      case SignalId.TruthAcceleration:
        this.begin(id, 3, 24, 7); v.setFloat64(at, s.anMps2, true); v.setFloat64(at + 8, s.aeMps2, true); v.setFloat64(at + 16, s.adMps2, true); return true;
      case SignalId.TruthSpecificForce:
        this.begin(id, 3, 24, 7); v.setFloat64(at, s.specificForceXBodyMps2, true); v.setFloat64(at + 8, s.specificForceYBodyMps2, true);
        v.setFloat64(at + 16, s.specificForceZBodyMps2, true); return true;
      case SignalId.TruthAir:
        this.begin(id, 3, 24, 7); v.setFloat64(at, s.trueAirspeedMps, true); v.setFloat64(at + 8, s.ambientPressurePa, true);
        v.setFloat64(at + 16, s.groundClearanceM, true); return true;
      case SignalId.Pilot: {
        const p = sample.pilot;
        this.begin(id, 4, 16, 15);
        // A ternary of a double and an integer zero would box the double; the value and the zero fill are separate loops.
        const given = p.length < 4 ? p.length : 4;
        for (let i = 0; i < given; i++) v.setFloat32(at + i * 4, p[i]!, true);
        for (let i = given; i < 4; i++) v.setFloat32(at + i * 4, 0, true);
        return true;
      }
      case SignalId.Actuators: {
        const a = sample.actuator;
        if (a === null || a.actuatorCount === 0) return false;
        const count = a.actuatorCount, outputs = a.normalizedActuators;
        this.begin(id, 16, 64, (1 << count) - 1);
        for (let i = 0; i < count; i++) v.setFloat32(at + i * 4, outputs[i]!, true);
        for (let i = count; i < 16; i++) v.setFloat32(at + i * 4, 0, true);
        return true;
      }
      case SignalId.MotorSpeed: case SignalId.MotorCurrent: case SignalId.MotorBusCurrent: case SignalId.MotorPower: case SignalId.MotorCommand: {
        const power = sample.power;
        if (power === null || power.motorCount === 0) return false;
        const count = power.motorCount < 16 ? power.motorCount : 16, column = id - SignalId.MotorSpeed, motors = power.motors;
        this.begin(id, 16, 64, (1 << count) - 1);
        for (let m = 0; m < count; m++) v.setFloat32(at + m * 4, motors[m * POWER_STRIDE + column]!, true);
        for (let m = count; m < 16; m++) v.setFloat32(at + m * 4, 0, true);
        return true;
      }
      case SignalId.Battery: {
        const power = sample.power;
        if (power === null || power.motorCount === 0) return false;
        const b = power.battery;
        this.begin(id, 5, 40, 31);
        // Battery slots (power-v1.ts): state of charge, voltage, current, power, remaining Ah, capacity Ah.
        for (let i = 0; i < 5; i++) v.setFloat64(at + i * 8, b[i]!, true);
        return true;
      }
      default: return false;
    }
  }

  private encodeSensor(id: number, sensor: SensorFrameV2): void {
    const v = this.rowView;
    v.setUint32(RowOffset.tickLo, sensor.tickId.lo, true);
    v.setUint32(RowOffset.tickHi, sensor.tickId.hi, true);
    v.setFloat64(RowOffset.simTimeS, (sensor.tickId.hi * 4294967296 + sensor.tickId.lo) / this.physicsHz, true);
    v.setUint32(RowOffset.epoch, sensor.epoch, true);
    const geo = sensor.geoLatLonAlt, values = sensor.values, at = ROW_HEADER_BYTES;
    if (id === SignalId.SensorGnss) {
      this.begin(id, 11, 88, 0x7ff);
      for (let i = 0; i < 3; i++) v.setFloat64(at + i * 8, geo[i]!, true);
      for (let i = 0; i < 8; i++) v.setFloat64(at + 24 + i * 8, values[i]!, true);
      return;
    }
    const count = sensor.valueCount;
    this.begin(id, count, count * 8, (1 << count) - 1);
    for (let i = 0; i < count; i++) v.setFloat64(at + i * 8, values[i]!, true);
  }

  private push(id: number): void {
    const words = this.words;
    const w = Atomics.load(words, W.write) >>> 0, r = Atomics.load(words, W.read) >>> 0;
    if ((w - r) >>> 0 >= QUEUE_SLOTS) {
      Atomics.add(words, W.lost, 1);
      this.pendingLost++;
      return;
    }
    this.rowView.setUint32(RowOffset.lost, this.pendingLost, true);
    const bytes = paddedRowBytes(this.rowView.getUint16(RowOffset.payloadBytes, true));
    const base = (SLOTS_AT >> 2) + (w % QUEUE_SLOTS) * SLOT_WORDS;
    for (let i = 0; i < bytes >> 2; i++) Atomics.store(words, base + i, this.rowWords[i]!);
    Atomics.store(words, W.write, (w + 1) | 0);
    Atomics.add(words, KEPT_WORD + id * 2, 1);
    this.pendingLost = 0;
  }
}

/** Consumer side of the queue: pops one row into `out` and returns its padded length, or 0 when empty. */
export class RecordingQueueReaderV2 {
  private readonly words: Int32Array;
  constructor(buffer: SharedArrayBuffer) { this.words = queueWords(buffer); }
  get lost(): number { return Atomics.load(this.words, W.lost) >>> 0; }
  /** Rows the producer delivered and found absent per signal ID. */
  kept(id: number): number { return Atomics.load(this.words, KEPT_WORD + id * 2) >>> 0; }
  absent(id: number): number { return Atomics.load(this.words, ABSENT_WORD + id * 2) >>> 0; }
  pop(out: Int32Array): number {
    const r = Atomics.load(this.words, W.read) >>> 0, w = Atomics.load(this.words, W.write) >>> 0;
    if (r === w) return 0;
    const base = (SLOTS_AT >> 2) + (r % QUEUE_SLOTS) * SLOT_WORDS;
    // The header word holding the payload size is copied first, then only the row's own words.
    out[RowOffset.channelCount >> 2] = Atomics.load(this.words, base + (RowOffset.channelCount >> 2));
    const payload = out[RowOffset.channelCount >> 2]! >>> 16;
    const bytes = paddedRowBytes(payload > SLOT_BYTES - ROW_HEADER_BYTES ? SLOT_BYTES - ROW_HEADER_BYTES : payload);
    for (let i = 0; i < bytes >> 2; i++) out[i] = Atomics.load(this.words, base + i);
    Atomics.store(this.words, W.read, (r + 1) | 0);
    return bytes;
  }
}

/** Cold: a gap row of `lost` rows at `tick`. */
export function gapRow(lost: number, tick: number, simTimeS: number, epoch: number): Uint8Array {
  const row = new Uint8Array(ROW_HEADER_BYTES), v = new DataView(row.buffer);
  v.setUint16(RowOffset.signal, SignalId.Gap, true);
  v.setUint16(RowOffset.flags, RowFlag.Gap, true);
  v.setUint32(RowOffset.tickLo, tick % 2 ** 32, true);
  v.setUint32(RowOffset.tickHi, Math.floor(tick / 2 ** 32), true);
  v.setFloat64(RowOffset.simTimeS, simTimeS, true);
  v.setUint32(RowOffset.epoch, epoch, true);
  v.setUint32(RowOffset.lost, lost, true);
  return row;
}
/** Cold: a row of `values` for a telemetry or event signal; channels beyond `values` are absent. */
export function valueRow(id: number, values: readonly number[], tick: number, simTimeS: number, epoch: number): Uint8Array {
  const signal = signalById(id);
  if (!signal || signal.valueType === "parameter" || signal.source === "physics" || values.length > signal.channels.length) throw new Error(`Invalid row for signal ${id}`);
  const f64 = signal.valueType === "f64", size = signal.channels.length * (f64 ? 8 : 4);
  const row = new Uint8Array(paddedRowBytes(size)), v = new DataView(row.buffer);
  v.setUint16(RowOffset.signal, id, true);
  v.setUint32(RowOffset.presence, (2 ** values.length - 1) >>> 0, true);
  v.setUint32(RowOffset.tickLo, tick % 2 ** 32, true);
  v.setUint32(RowOffset.tickHi, Math.floor(tick / 2 ** 32), true);
  v.setFloat64(RowOffset.simTimeS, simTimeS, true);
  v.setUint32(RowOffset.epoch, epoch, true);
  v.setUint16(RowOffset.channelCount, signal.channels.length, true);
  v.setUint16(RowOffset.payloadBytes, size, true);
  values.forEach((value, i) => {
    if (!Number.isFinite(value)) throw new Error(`Signal ${signal.name}: channel ${i} is not finite`);
    if (f64) v.setFloat64(ROW_HEADER_BYTES + i * 8, value, true);
    else v.setFloat32(ROW_HEADER_BYTES + i * 4, value, true);
  });
  return row;
}
/** Cold: a parameter row (snapshot or change) of an ArduPilot name of 1 to 16 printable characters. */
export function parameterRow(name: string, value: number, snapshot: boolean, tick: number, simTimeS: number, epoch: number): Uint8Array {
  if (!/^[\x21-\x7e]{1,16}$/.test(name) || !Number.isFinite(Math.fround(value))) throw new Error(`Invalid parameter row ${name}`);
  const row = new Uint8Array(paddedRowBytes(20)), v = new DataView(row.buffer);
  v.setUint16(RowOffset.signal, SignalId.Parameter, true);
  v.setUint16(RowOffset.flags, snapshot ? RowFlag.Snapshot : 0, true);
  v.setUint32(RowOffset.presence, 1, true);
  v.setUint32(RowOffset.tickLo, tick % 2 ** 32, true);
  v.setUint32(RowOffset.tickHi, Math.floor(tick / 2 ** 32), true);
  v.setFloat64(RowOffset.simTimeS, simTimeS, true);
  v.setUint32(RowOffset.epoch, epoch, true);
  v.setUint16(RowOffset.channelCount, 1, true);
  v.setUint16(RowOffset.payloadBytes, 20, true);
  for (let i = 0; i < name.length; i++) row[ROW_HEADER_BYTES + i] = name.charCodeAt(i);
  v.setFloat32(ROW_HEADER_BYTES + 16, value, true);
  return row;
}

/**
 * Main-side decimation of aperiodic telemetry: keeps a message when at least
 * 1/effective seconds of simulated time passed since the last kept one of
 * the same signal. Cold path, one call per received message.
 */
export class TelemetryDecimator {
  private readonly lastKeptS = new Map<number, number>();
  constructor(private readonly plan: RatePlan) {}
  keep(id: number, simTimeS: number): boolean {
    const signal = this.plan.signals.find(s => s.id === id);
    if (signal?.source !== "telemetry" || !signal.effectiveHz) return false;
    const last = this.lastKeptS.get(id);
    // Half a microsecond of slack absorbs float rounding of a time stamped exactly on the period.
    if (last !== undefined && simTimeS - last < 1 / signal.effectiveHz - 5e-7) return false;
    this.lastKeptS.set(id, simTimeS);
    return true;
  }
}

export interface ChunkSink {
  /** Takes a sealed chunk; `rows` per signal ID it holds. Must not block. */
  write(index: number, chunk: Uint8Array, rows: ReadonlyMap<number, number>): void;
}

/**
 * The recorder Worker's consumer: drains the queue and Main's event rows into
 * chunks. Cold path; it allocates only when it seals a chunk.
 */
export class RecordingConsumerV2 {
  private readonly builder: ChunkBuilder;
  private readonly slot = new Int32Array(SLOT_WORDS);
  private readonly slotBytes = new Uint8Array(this.slot.buffer);
  private readonly slotView = new DataView(this.slot.buffer);
  private readonly rowsInChunk = new Map<number, number>();
  private readonly rowsTotal = new Map<number, number>();
  private nextIndex = 0;
  /** Lost rows the delivered rows' `lost` fields account for. */
  private lostSeen = 0;
  private lastTick = 0;
  private lastTimeS = 0;
  private lastEpoch = 0;
  invalidRows = 0;

  constructor(private readonly queue: RecordingQueueReaderV2 | null, key: number, private readonly sink: ChunkSink) {
    this.builder = new ChunkBuilder(key);
  }
  get chunks(): number { return this.nextIndex; }
  rows(id: number): number { return this.rowsTotal.get(id) ?? 0; }
  /** Drains at most `limit` queued rows; returns how many it took. */
  drain(limit: number): number {
    if (!this.queue) return 0;
    let taken = 0;
    for (; taken < limit; taken++) {
      const bytes = this.queue.pop(this.slot);
      if (bytes === 0) break;
      this.lostSeen += this.slotView.getUint32(RowOffset.lost, true);
      this.add(this.slotBytes, bytes);
    }
    return taken;
  }
  /** Appends one encoded row from Main (an event or telemetry row); false for a row that fails the format check. */
  appendRow(row: Uint8Array): boolean {
    if (row.length > SLOT_BYTES || row.length % 8 !== 0) { this.invalidRows++; return false; }
    this.slotBytes.fill(0);
    this.slotBytes.set(row);
    return this.add(this.slotBytes, row.length);
  }
  private add(bytes: Uint8Array, length: number): boolean {
    try {
      if (checkRow(this.slotView, 0, length) !== length) throw new Error("Row length mismatch");
    } catch {
      this.invalidRows++;
      return false;
    }
    if (!this.builder.fits(length)) this.flush();
    this.builder.append(bytes, length);
    const id = this.slotView.getUint16(RowOffset.signal, true);
    this.rowsInChunk.set(id, (this.rowsInChunk.get(id) ?? 0) + 1);
    this.rowsTotal.set(id, (this.rowsTotal.get(id) ?? 0) + 1);
    const tick = this.slotView.getUint32(RowOffset.tickHi, true) * 2 ** 32 + this.slotView.getUint32(RowOffset.tickLo, true);
    if (tick >= this.lastTick) {
      this.lastTick = tick;
      this.lastTimeS = this.slotView.getFloat64(RowOffset.simTimeS, true);
      this.lastEpoch = this.slotView.getUint32(RowOffset.epoch, true);
    }
    return true;
  }
  /** Seals the open chunk, if it holds a row, and hands it to the sink. */
  flush(): void {
    if (this.builder.rowCount === 0) return;
    const rows = new Map(this.rowsInChunk);
    this.rowsInChunk.clear();
    this.sink.write(this.nextIndex, this.builder.seal(this.nextIndex), rows);
    this.nextIndex++;
  }
  /**
   * Final drain: rows the producer lost after its last delivered row are
   * written as one gap row, so every lost row is accounted for in the record.
   */
  finish(): void {
    this.drain(Number.MAX_SAFE_INTEGER);
    const unaccounted = (this.queue?.lost ?? 0) - this.lostSeen;
    if (unaccounted > 0) {
      this.appendRow(gapRow(unaccounted, this.lastTick, this.lastTimeS, this.lastEpoch));
      this.lostSeen += unaccounted;
    }
    this.flush();
  }
}
