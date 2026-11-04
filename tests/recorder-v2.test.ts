// TASK-162: recording format v2, the producer fan-out, the consumer and
// streaming storage. Oracles: exact sample counts from the rate rule
// (floor(ticks · effective / source)), byte checks of every stored chunk,
// the A-08 budget (2 GB per simulated hour) and the record reopened from
// storage. The one-hour run is simulated time, accelerated: the producer
// sees every one of its 1,440,000 ticks.
import { limitDroppedRow, limitEventRow, limitMonitorRow } from '@mirage/physics/limit-monitor';
import { describe, expect, it } from 'vitest';
import { newActuatorFrameV2, newFlightStateV2, newSensorFrameV2, type PowerTelemetrySource } from '../packages/protocol/src/index.ts';
import { checkRow, chunkCrc, decodeChunk, headerFromPlan, parseRecordHeader, recordKey, RowOffset, CHUNK_HEADER_BYTES } from '../packages/aar/src/format-v2.ts';
import {
  gapRow, parameterRow, producerPlan, RecordingConsumerV2, RecordingProducerV2, RecordingQueueReaderV2, createRecordingQueueV2, TelemetryDecimator,
  valueRow, QUEUE_SLOTS, type ProducerSample,
} from '../packages/aar/src/recorder-v2.ts';
import { telemetryValues } from '../packages/aar/src/recorder-v2-host.ts';
import { planRates, signalByName, SignalId, SIGNAL_CATALOG, type RatePlan, type RateRequest } from '../packages/aar/src/signal-catalog.ts';
import {
  MemoryRecordingBackend, openRecording, recoverInterrupted, StreamWriter, type CatalogEntry, type RecordingBackend,
} from '../packages/aar/src/stream-storage.ts';
import { encodeInto, MavParser, type MavFrame } from '../packages/mavlink/src/codec.ts';
import { packInto } from '../packages/mavlink/src/messages.ts';

const RECORD_ID = '0123456789abcdef0123456789abcdef';
/** A-08: at most 2 GB of recording per simulated hour. */
const BUDGET_BYTES_PER_HOUR = 2e9;

function identity(recordId = RECORD_ID) {
  return { recordId, experimentId: 'experiment-1', startedAt: '2026-11-01T12:00:00.000Z', modelSha256: 'a'.repeat(64),
    firmware: { commit: '8ab6afde107a91df1b5f60ade8f333cb8a61b190', binarySha256: 'b'.repeat(64) } };
}

/** A physics tick source: the state advances, power telemetry for `motors` motors, actuators and an IMU frame every tick. */
class SyntheticSession {
  readonly state = newFlightStateV2();
  readonly pilot = new Float64Array([0.1, -0.2, 0.3, 0.55]);
  readonly actuator = newActuatorFrameV2();
  readonly sensor = newSensorFrameV2();
  readonly power: PowerTelemetrySource;
  readonly sample: { state: ProducerSample['state']; pilot: Float64Array; actuator: ProducerSample['actuator']; sensor: ProducerSample['sensor']; power: PowerTelemetrySource | null };
  powered = true;
  constructor(readonly hz: number, motors: number) {
    this.power = { motorCount: motors, motors: new Float64Array(80), motorWarning: new Uint32Array(16), motorLimited: new Uint32Array(16),
      battery: new Float64Array([0.9, 22.2, 31.5, 699.3, 4.1, 5.0]), batteryMasks: new Uint32Array(2) };
    for (let m = 0; m < motors; m++) this.power.motors.set([9000 + m, 7.5, 7.1, 157 + m, 0.55], m * 5);
    this.state.epoch = this.actuator.epoch = this.sensor.epoch = 1;
    this.actuator.actuatorCount = motors;
    this.sensor.kind = 1;
    this.sensor.valueCount = 6;
    this.sample = { state: this.state, pilot: this.pilot, actuator: this.actuator, sensor: this.sensor, power: this.power };
  }
  /** Advances one tick and returns the record hook's sample. */
  next(): ProducerSample {
    const s = this.state;
    s.tickId.lo = (s.tickId.lo + 1) >>> 0;
    if (s.tickId.lo === 0) s.tickId.hi++;
    const tick = s.tickId.hi * 4294967296 + s.tickId.lo;
    s.simTimeS = tick / this.hz;
    s.northM = Math.sin(s.simTimeS);
    this.sensor.tickId.lo = s.tickId.lo; this.sensor.tickId.hi = s.tickId.hi;
    this.sensor.values[0] = s.northM;
    this.sample.power = this.powered ? this.power : null;
    return this.sample;
  }
}

/** Walks a chunk's rows without decoding values: the per-signal counts and tick order, with every row checked. */
function walk(chunk: Uint8Array, counts: Map<number, number>, lastTick: Map<number, number>): void {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (let at = CHUNK_HEADER_BYTES; at < chunk.length;) {
    const length = checkRow(view, at, chunk.length);
    const id = view.getUint16(at + RowOffset.signal, true), tick = view.getUint32(at + RowOffset.tickLo, true) + view.getUint32(at + RowOffset.tickHi, true) * 2 ** 32;
    const previous = lastTick.get(id);
    // Physics and sensor rows of one signal are strictly increasing in tick: a sample is never written twice.
    if (id <= SignalId.SensorAirspeed && previous !== undefined && tick <= previous) throw new Error(`Signal ${id} repeats or reverses tick ${tick}`);
    lastTick.set(id, tick);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    at += length;
  }
}
/** A backend that verifies each chunk as it is stored and keeps only counts, for runs too long to hold. */
class CountingBackend extends MemoryRecordingBackend {
  readonly counts = new Map<number, number>();
  private readonly lastTick = new Map<number, number>();
  bytes = 0;
  chunkCount = 0;
  override async putChunk(entry: CatalogEntry, index: number, chunk: Uint8Array): Promise<void> {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (view.getUint32(44, true) !== chunkCrc(chunk) || view.getUint32(8, true) !== index || view.getUint32(36, true) !== recordKey(entry.recordId)) {
      throw new Error(`Chunk ${index} fails its checks`);
    }
    walk(chunk, this.counts, this.lastTick);
    this.bytes += chunk.length;
    this.chunkCount++;
    return super.putEntry(entry);
  }
}

async function record(plan: RatePlan, ticks: number, backend: RecordingBackend, options: { motors?: number; drainEvery?: number; before?: (tick: number, session: SyntheticSession, consumer: RecordingConsumerV2) => void;
  events?: (consumer: RecordingConsumerV2) => void } = {}) {
  const queue = createRecordingQueueV2();
  const producer = new RecordingProducerV2(queue, producerPlan(plan));
  const reader = new RecordingQueueReaderV2(queue);
  const writer = await StreamWriter.start(backend, headerFromPlan(plan, identity()));
  writer.bindCounters(reader);
  const consumer = new RecordingConsumerV2(reader, recordKey(RECORD_ID), writer);
  options.events?.(consumer);
  const session = new SyntheticSession(plan.physicsHz, options.motors ?? 8);
  const drainEvery = options.drainEvery ?? plan.physicsHz;
  for (let t = 1; t <= ticks; t++) {
    options.before?.(t, session, consumer);
    producer.record(session.next());
    if (t % drainEvery === 0) {
      consumer.drain(Number.MAX_SAFE_INTEGER);
      // A chunk is sealed once per simulated second, as the recorder Worker does per wall second.
      if (t % plan.physicsHz === 0) consumer.flush();
      await writer.settled();
    }
  }
  consumer.finish();
  const entry = await writer.close();
  return { entry, reader, consumer };
}
const expected = (ticks: number, effective: number, source: number): number => Math.floor(ticks * effective / source);

describe('signal catalog and rate plan', () => {
  it('records every signal at the common rate, capped at its source, with overrides by group and signal', () => {
    const plan = planRates({}, { physicsHz: 400, telemetryHz: 10 });
    expect(plan.commonHz).toBe(50);
    expect(plan.signals).toHaveLength(SIGNAL_CATALOG.length);
    const find = (name: string) => plan.signals.find(s => s.name === name);
    expect(find('truth.position')).toMatchObject({ sourceHz: 400, requestedHz: 50, effectiveHz: 50, capped: false, aperiodic: false });
    // The autopilot streams at 10 Hz, so the 50 Hz default is capped and shown as capped.
    expect(find('autopilot.attitude')).toMatchObject({ sourceHz: 10, requestedHz: 50, effectiveHz: 10, capped: true, aperiodic: true });
    expect(find('events.pause')).toMatchObject({ sourceHz: null, requestedHz: null, effectiveHz: null, capped: false });

    const request: RateRequest = { commonHz: 20, groups: { motors: 2000, pilot: 0 }, signals: { 'motors.power': 100, 'truth.position': 1200 } };
    const fast = planRates(request, { physicsHz: 1200, telemetryHz: 10 });
    const at = (name: string) => fast.signals.find(s => s.name === name);
    expect(at('motors.speed')).toMatchObject({ requestedHz: 2000, effectiveHz: 1200, capped: true });
    expect(at('motors.power')).toMatchObject({ requestedHz: 100, effectiveHz: 100, capped: false });
    expect(at('truth.position')).toMatchObject({ requestedHz: 1200, effectiveHz: 1200, capped: false });
    expect(at('pilot')).toMatchObject({ requestedHz: 0, effectiveHz: 0 });
    expect(at('battery')).toMatchObject({ requestedHz: 20, effectiveHz: 20 });
  });
  it('refuses unknown names, events and rates outside 1..2000 Hz', () => {
    const sources = { physicsHz: 400, telemetryHz: 10 };
    expect(() => planRates({ signals: { 'truth.nothing': 10 } }, sources)).toThrow(/Unknown signal/);
    expect(() => planRates({ signals: { 'events.pause': 10 } }, sources)).toThrow(/always recorded/);
    expect(() => planRates({ groups: { motors: 2001 } }, sources)).toThrow(/rate/);
    expect(() => planRates({ commonHz: 0.5 }, sources)).toThrow(/rate/);
    expect(() => planRates({}, { physicsHz: 500, telemetryHz: 10 })).toThrow(/physics rate/);
  });
  it('keeps a header only when its rates follow the rule and its signals equal the catalog', () => {
    const header = headerFromPlan(planRates({}, { physicsHz: 400, telemetryHz: 10 }), identity());
    expect(parseRecordHeader(JSON.parse(JSON.stringify(header)))).toEqual(header);
    const tamper = (change: (h: { signals: Record<string, unknown>[] } & Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(header)) as { signals: Record<string, unknown>[] } & Record<string, unknown>;
      change(copy);
      return () => parseRecordHeader(copy);
    };
    expect(tamper(h => { h.signals[0] = { ...h.signals[0], effectiveHz: 60 }; })).toThrow(/min\(requested, source\)/);
    expect(tamper(h => { h.signals[0] = { ...h.signals[0], capped: true }; })).toThrow(/capped/);
    expect(tamper(h => { h.signals[0] = { ...h.signals[0], channels: [{ name: 'north', unit: 'ft' }] }; })).toThrow(/catalog/);
    expect(tamper(h => { h.signals.pop(); })).toThrow(/every catalog signal/);
    expect(tamper(h => { h.formatVersion = 1; })).toThrow(/format version 2/);
    expect(tamper(h => { h.extra = 1; })).toThrow(/unexpected/);
  });
});

describe('recorder v2 over one simulated hour', () => {
  it('keeps exactly floor(ticks · effective / source) samples per signal, caps 2 kHz at the source, and stays within the A-08 budget', async () => {
    const hz = 400, ticks = 3600 * hz;
    const plan = planRates({ signals: { 'motors.speed': 2000, battery: 7, 'truth.position': 400, 'sensors.imu': 100 } }, { physicsHz: hz, telemetryHz: 10 });
    const backend = new CountingBackend();
    const telemetry = new TelemetryDecimator(plan);
    let pauses = 0;
    const { entry, reader } = await record(plan, ticks, backend, {
      events: c => {
        for (let i = 0; i < 1410; i++) c.appendRow(parameterRow(`PARAM_${i}`, i / 7, true, 0, 0, 1));
      },
      before: (t, session, consumer) => {
        // Autopilot telemetry arrives at 10 Hz (every 40 ticks); a pause event every simulated minute.
        if (t % 40 === 0 && telemetry.keep(SignalId.AutopilotAttitude, session.state.simTimeS)) {
          consumer.appendRow(valueRow(SignalId.AutopilotAttitude, [0.01, 0.02, 0.03, 0, 0, 0], t, t / hz, 1));
        }
        if (t % (60 * hz) === 0) { consumer.appendRow(valueRow(SignalId.Pause, [pauses++ % 2], t, t / hz, 1)); }
      },
    });
    for (const signal of plan.signals) {
      if (signal.source !== 'physics' && signal.source !== 'sensor') continue;
      const want = signal.source === 'sensor' ? expected(ticks, signal.effectiveHz ?? 0, hz) : expected(ticks, signal.effectiveHz ?? 0, signal.sourceHz ?? 1);
      // Every kept physics sample of a source that produced it is a row; IMU frames arrive every tick here.
      // Only IMU frames arrive in this session, so the other sensor signals have no sample at all.
      const produced = signal.source === 'physics' || signal.name === 'sensors.imu';
      expect([signal.name, backend.counts.get(signal.id) ?? 0]).toEqual([signal.name, produced ? want : 0]);
      expect(reader.kept(signal.id), signal.name).toBe(backend.counts.get(signal.id) ?? 0);
    }
    expect(plan.signals.find(s => s.name === 'motors.speed')).toMatchObject({ requestedHz: 2000, effectiveHz: 400, capped: true });
    expect(backend.counts.get(SignalId.MotorSpeed)).toBe(1_440_000);
    expect(backend.counts.get(SignalId.Battery)).toBe(25_200);
    expect(backend.counts.get(SignalId.TruthVelocity)).toBe(180_000);
    expect(backend.counts.get(SignalId.AutopilotAttitude)).toBe(36_000);
    expect(backend.counts.get(SignalId.Parameter)).toBe(1410);
    expect(backend.counts.get(SignalId.Pause)).toBe(60);
    expect(reader.lost).toBe(0);
    expect(entry).toMatchObject({ status: 'closed', droppedChunks: 0, droppedRows: 0, producerLost: 0, absent: {} });
    expect(entry.storedChunks).toBe(backend.chunkCount);
    expect(entry.bytes).toBe(backend.bytes);
    expect(entry.rows['motors.speed']).toBe(1_440_000);
    expect(backend.bytes).toBeLessThan(BUDGET_BYTES_PER_HOUR);
  }, 300_000);
});

describe('recorder v2 rows, gaps and storage', () => {
  const plan = planRates({ signals: { 'truth.position': 400 } }, { physicsHz: 400, telemetryHz: 10 });

  it('writes no row for a kept sample its source did not produce, and counts it absent', async () => {
    const backend = new MemoryRecordingBackend();
    const { entry } = await record(plan, 4000, backend, { before: (t, s) => { s.powered = t > 1000; } });
    const opened = await openRecording(backend, RECORD_ID);
    // 50 Hz of 4000 ticks keeps 500 motor samples; the first 1000 ticks (125 samples) had no electrical drive.
    expect(opened.rows.get('motors.speed')).toHaveLength(375);
    expect(entry.absent['motors.speed']).toBe(125);
    expect(entry.absent.battery).toBe(125);
    expect(opened.rows.get('motors.speed')?.[0]?.tick).toBe(1008);
    // Eight motors: the presence mask marks channels 1..8, and channels 9..16 are not samples.
    const row = opened.rows.get('motors.speed')?.[0];
    expect(row?.presence).toBe(0xff);
    expect(row?.values?.slice(0, 2)).toEqual([9000, 9001]);
    expect(opened.rows.get('truth.position')).toHaveLength(4000);
    expect(opened.rows.get('truth.position')?.[3999]).toMatchObject({ tick: 4000, simTimeS: 10, epoch: 1 });
    expect(opened.missingChunks).toEqual([]);
    expect(opened.corruptChunks).toEqual([]);
  });

  it('drops rows instead of waiting when the queue is full, and accounts for every lost row', async () => {
    const backend = new MemoryRecordingBackend();
    // Nothing drains for 2000 ticks: truth.position alone writes 2000 rows into 2048 slots, the 50 Hz signals the rest.
    const { entry, reader } = await record(plan, 2000, backend, { drainEvery: 4000 });
    const opened = await openRecording(backend, RECORD_ID);
    const stored = [...opened.rows.values()].reduce((sum, rows) => sum + rows.length, 0);
    const lostInRows = [...opened.rows.values()].flat().reduce((sum, row) => sum + row.lost, 0) + opened.gaps.reduce((sum, gap) => sum + gap.lost, 0);
    expect(stored).toBe(QUEUE_SLOTS);
    expect(reader.lost).toBeGreaterThan(0);
    expect(lostInRows).toBe(reader.lost);
    expect(entry.producerLost).toBe(reader.lost);
    expect(opened.gaps).toHaveLength(1);
  });

  it('detects a corrupted chunk and names a dropped one', async () => {
    const backend = new MemoryRecordingBackend();
    await record(plan, 4000, backend);
    backend.corrupt(RECORD_ID, 3, 200);
    const opened = await openRecording(backend, RECORD_ID);
    expect(opened.corruptChunks).toEqual([{ index: 3, reason: 'Chunk 3 fails its CRC-32' }]);
    expect(opened.rows.get('truth.position')?.length).toBeLessThan(4000);

    const failing = new MemoryRecordingBackend();
    failing.failNext = 1;
    const { entry } = await record(plan, 4000, failing);
    expect(entry).toMatchObject({ droppedChunks: 1, storedChunks: entry.chunks - 1 });
    expect(entry.droppedRows).toBeGreaterThan(0);
    const reopened = await openRecording(failing, RECORD_ID);
    expect(reopened.missingChunks).toEqual([0]);
  });

  it('refuses a chunk of another record, at another index, or with a bad row', async () => {
    const backend = new MemoryRecordingBackend();
    await record(plan, 800, backend);
    const chunk = await backend.getChunk(RECORD_ID, 0);
    if (!chunk) throw new Error('No chunk 0');
    expect(decodeChunk(chunk, recordKey(RECORD_ID), 0).rows.length).toBeGreaterThan(0);
    expect(() => decodeChunk(chunk, recordKey('ffffffff' + RECORD_ID.slice(8)), 0)).toThrow(/another record/);
    expect(() => decodeChunk(chunk, recordKey(RECORD_ID), 1)).toThrow(/carries index 0/);
    const consumer = new RecordingConsumerV2(null, recordKey(RECORD_ID), { write: () => undefined });
    const bad = valueRow(SignalId.Pause, [1], 1, 0.0025, 1);
    bad[RowOffset.payloadBytes] = 16;
    expect(consumer.appendRow(bad)).toBe(false);
    expect(consumer.appendRow(new Uint8Array(12))).toBe(false);
    expect(consumer.appendRow(gapRow(3, 10, 0.025, 1))).toBe(true);
    expect(consumer.invalidRows).toBe(2);
    expect(() => valueRow(SignalId.TruthPosition, [1, 2, 3], 1, 0, 1)).toThrow();
    expect(() => valueRow(SignalId.Pause, [Number.NaN], 1, 0, 1)).toThrow(/finite/);
    // TASK-172: a flight task's request leaves out what its stage does not request; the mask says which, and an absent channel is no zero.
    const request = valueRow(SignalId.FlightTaskRequest, [2, 1, null, 3, null, 5, 0, null, null], 1, 0, 1);
    expect(new DataView(request.buffer).getUint32(RowOffset.presence, true)).toBe(0b001101011);
    expect(new RecordingConsumerV2(null, recordKey(RECORD_ID), { write: () => undefined }).appendRow(request)).toBe(true);
    expect(() => parameterRow('NAME WITH SPACE', 1, false, 1, 0, 1)).toThrow();
    // TASK-177: a limit the model does not state stays absent, and a row of any code is one the recording takes.
    const clamp = valueRow(SignalId.LimitEvent, limitEventRow({ tick: 9, simTimeS: 1, subject: 'battery', quantity: 'pack-current-limit', kind: 'limited', edge: 'start', value: 80, limit: Number.NaN }), 9, 1, 1);
    expect(new DataView(clamp.buffer).getUint32(RowOffset.presence, true)).toBe(0b011111);
    const asConsumer = new RecordingConsumerV2(null, recordKey(RECORD_ID), { write: () => undefined });
    expect(asConsumer.appendRow(clamp)).toBe(true);
    expect(asConsumer.appendRow(valueRow(SignalId.LimitEvent, limitMonitorRow(), 0, 0, 1))).toBe(true);
    expect(asConsumer.appendRow(valueRow(SignalId.LimitEvent, limitDroppedRow(7), 10, 2, 1))).toBe(true);
  });

  it('reopens a record cut off by a restart as interrupted, with every chunk written before', async () => {
    const backend = new MemoryRecordingBackend();
    const queue = createRecordingQueueV2();
    const producer = new RecordingProducerV2(queue, producerPlan(plan));
    const reader = new RecordingQueueReaderV2(queue);
    const writer = await StreamWriter.start(backend, headerFromPlan(plan, identity()));
    const consumer = new RecordingConsumerV2(reader, recordKey(RECORD_ID), writer);
    const session = new SyntheticSession(400, 4);
    for (let t = 1; t <= 1200; t++) {
      producer.record(session.next());
      if (t % 400 === 0) { consumer.drain(4096); consumer.flush(); await writer.settled(); }
    }
    // The page restarts here: no close, the catalog entry still says recording.
    expect((await backend.getEntry(RECORD_ID))?.status).toBe('recording');
    expect(await recoverInterrupted(backend, id => id !== RECORD_ID)).toEqual([RECORD_ID]);
    const opened = await openRecording(backend, RECORD_ID);
    expect(opened.entry.status).toBe('interrupted');
    expect(opened.rows.get('truth.position')).toHaveLength(1200);
    expect(opened.rows.get('truth.position')?.at(-1)?.tick).toBe(1200);
    // A live recorder's record is left alone.
    const other = await StreamWriter.start(backend, headerFromPlan(plan, identity('fedcba9876543210fedcba9876543210')));
    expect(await recoverInterrupted(backend, () => true)).toEqual([]);
    expect(other.current.status).toBe('recording');
    await expect(StreamWriter.start(backend, headerFromPlan(plan, identity()))).rejects.toThrow(/already exists/);
  });
});

describe('aperiodic sources', () => {
  it('keeps an IMU frame every physics/effective ticks and decimates telemetry by simulated time', async () => {
    const plan = planRates({ signals: { 'sensors.imu': 100 } }, { physicsHz: 400, telemetryHz: 10 });
    const backend = new MemoryRecordingBackend();
    await record(plan, 4000, backend);
    const imu = (await openRecording(backend, RECORD_ID)).rows.get('sensors.imu') ?? [];
    expect(imu).toHaveLength(1000);
    expect(imu.slice(0, 3).map(row => row.tick)).toEqual([1, 5, 9]);
    expect(imu[1]?.values?.[0]).toBeCloseTo(Math.sin(5 / 400), 12);

    const slow = planRates({ groups: { autopilot: 5 } }, { physicsHz: 400, telemetryHz: 10 });
    const decimator = new TelemetryDecimator(slow);
    let kept = 0;
    // 10 Hz arrivals for 60 s, kept at 5 Hz.
    for (let i = 0; i < 600; i++) if (decimator.keep(SignalId.AutopilotEkf, i / 10)) kept++;
    expect(kept).toBe(300);
    expect(decimator.keep(SignalId.TruthPosition, 0)).toBe(false);
  });

  it('decodes the recorded telemetry messages from their MAVLink frames', () => {
    const frames: MavFrame[] = [];
    const parser = new MavParser(frame => frames.push({ ...frame, payload: frame.payload.slice(), view: new DataView(frame.payload.slice().buffer) }));
    const out = new Uint8Array(280);
    const send = (id: number, values: Record<string, number>, length: number) => {
      const payload = new Uint8Array(length);
      if (!packInto(id, values, payload)) throw new Error(`Message ${id} did not pack`);
      parser.push(out.slice(0, encodeInto(id, payload, 0, 1, 1, out)));
    };
    send(30, { time_boot_ms: 1, roll: 0.25, pitch: -0.5, yaw: 1.5, rollspeed: 0.125, pitchspeed: 0, yawspeed: -0.25 }, 28);
    send(193, { flags: 831, velocity_variance: 0.5, pos_horiz_variance: 0.25, pos_vert_variance: 0.125, compass_variance: 0.0625, terrain_alt_variance: 0 }, 26);
    send(33, { time_boot_ms: 2, lat: -353632610, lon: 1491652300, alt: 584000, relative_alt: 10000, vx: 150, vy: -50, vz: 0, hdg: 9000 }, 28);
    expect(frames.map(telemetryValues)).toEqual([
      { id: SignalId.AutopilotAttitude, values: [0.25, -0.5, 1.5, 0.125, 0, -0.25] },
      { id: SignalId.AutopilotEkf, values: [831, 0.5, 0.25, 0.125, 0.0625, 0] },
      { id: SignalId.AutopilotGlobalPosition, values: [-35.363261, 149.16523, 584, 10, 1.5, -0.5, 0, 90] },
    ]);
    expect(signalByName('autopilot.ekf')?.channels[0]).toEqual({ name: 'flags', unit: '1' });
  });
});
