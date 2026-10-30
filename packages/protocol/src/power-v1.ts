/**
 * Power telemetry v1 (TASK-146): per-motor and battery electrical values with
 * their warning and limited masks, in a SharedArrayBuffer separate from ABI v2.
 * The physics Worker is the only writer and publishes the latest step into one
 * seqlock record; Main reads it at display rate. Writer and reader use
 * preallocated scratch; neither allocates after construction.
 */
import { publishAtomicFrame, tryReadAtomicFrame } from './atomic-v2.ts';

export const POWER_MAGIC_V1 = 0x4d505752;
export const POWER_VERSION_V1 = 1;
export const POWER_HEADER_BYTES_V1 = 64;
export const POWER_MOTOR_CAPACITY_V1 = 16;
export const POWER_MOTOR_STRIDE_V1 = 32;
export const POWER_RECORD_BYTES_V1 = 96 + POWER_MOTOR_CAPACITY_V1 * POWER_MOTOR_STRIDE_V1;
export const POWER_BYTES_V1 = POWER_HEADER_BYTES_V1 + POWER_RECORD_BYTES_V1;
const RECORD_WORDS = POWER_RECORD_BYTES_V1 / 4;
const BASE_WORD = POWER_HEADER_BYTES_V1 / 4;

/** Header word indices. */
export const PowerHeaderV1 = Object.freeze({ Magic: 0, Version: 1, HeaderBytes: 2, RecordBytes: 3, MotorCapacity: 4, Published: 5 });
/** Record byte offsets, relative to the record at byte 64. */
export const PowerRecordV1 = Object.freeze({
  seqlock: 0, sampleId: 4, tickLo: 8, tickHi: 12, epoch: 16, modelId: 20, motorCount: 24, batteryWarning: 28, batteryLimited: 32,
  droppedEvents: 36, stateOfCharge: 40, voltageV: 48, currentA: 56, powerW: 64, remainingAh: 72, capacityAh: 80, motors: 96,
  motor: Object.freeze({ rpm: 0, motorCurrentA: 4, busCurrentA: 8, electricalPowerW: 12, command: 16, warning: 20, limited: 24 }),
});

/**
 * What the writer copies. The physics `PowerTelemetry` has this shape:
 * five doubles per motor (rpm, motor current, bus current, electrical power,
 * command) and six battery slots (state of charge, voltage, current, power,
 * remaining Ah, capacity Ah).
 */
export interface PowerTelemetrySource {
  readonly motorCount: number;
  readonly motors: Float64Array;
  readonly motorWarning: Uint32Array;
  readonly motorLimited: Uint32Array;
  readonly battery: Float64Array;
  readonly batteryMasks: Uint32Array;
}

/** A decoded record; `motorCount` 0 means the active model has no electrical drive. */
export interface PowerSnapshotV1 {
  sampleId: number; tickLo: number; tickHi: number; epoch: number; modelId: number; motorCount: number;
  batteryWarning: number; batteryLimited: number; droppedEvents: number;
  stateOfCharge: number; voltageV: number; currentA: number; powerW: number; remainingAh: number; capacityAh: number;
  /** Per motor: rpm, motor current A, bus current A, electrical power W, command; `POWER_MOTOR_CAPACITY_V1` rows. */
  readonly motors: Float32Array;
  readonly motorWarning: Uint32Array;
  readonly motorLimited: Uint32Array;
}
export function newPowerSnapshotV1(): PowerSnapshotV1 {
  return { sampleId: 0, tickLo: 0, tickHi: 0, epoch: 0, modelId: 0, motorCount: 0, batteryWarning: 0, batteryLimited: 0, droppedEvents: 0,
    stateOfCharge: 0, voltageV: 0, currentA: 0, powerW: 0, remainingAh: 0, capacityAh: 0,
    motors: new Float32Array(POWER_MOTOR_CAPACITY_V1 * 5), motorWarning: new Uint32Array(POWER_MOTOR_CAPACITY_V1),
    motorLimited: new Uint32Array(POWER_MOTOR_CAPACITY_V1) };
}

export function createPowerChannelV1(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(POWER_BYTES_V1), words = new Int32Array(buffer);
  Atomics.store(words, PowerHeaderV1.Magic, POWER_MAGIC_V1);
  Atomics.store(words, PowerHeaderV1.Version, POWER_VERSION_V1);
  Atomics.store(words, PowerHeaderV1.HeaderBytes, POWER_HEADER_BYTES_V1);
  Atomics.store(words, PowerHeaderV1.RecordBytes, POWER_RECORD_BYTES_V1);
  Atomics.store(words, PowerHeaderV1.MotorCapacity, POWER_MOTOR_CAPACITY_V1);
  return buffer;
}

/** Rejects any buffer that is not a power telemetry v1 channel. */
export function validatePowerChannelV1(buffer: unknown): asserts buffer is SharedArrayBuffer {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== POWER_BYTES_V1) throw new Error('Not a power telemetry v1 buffer');
  const words = new Int32Array(buffer);
  if (Atomics.load(words, PowerHeaderV1.Magic) !== POWER_MAGIC_V1 || Atomics.load(words, PowerHeaderV1.Version) !== POWER_VERSION_V1 ||
    Atomics.load(words, PowerHeaderV1.HeaderBytes) !== POWER_HEADER_BYTES_V1 ||
    Atomics.load(words, PowerHeaderV1.RecordBytes) !== POWER_RECORD_BYTES_V1 ||
    Atomics.load(words, PowerHeaderV1.MotorCapacity) !== POWER_MOTOR_CAPACITY_V1) throw new Error('Not a power telemetry v1 buffer');
}

const R = PowerRecordV1, M = PowerRecordV1.motor;

export class PowerWriterV1 {
  private readonly shared: Int32Array;
  private readonly scratch = new Int32Array(RECORD_WORDS);
  private readonly view = new DataView(this.scratch.buffer);
  constructor(buffer: SharedArrayBuffer) {
    validatePowerChannelV1(buffer);
    this.shared = new Int32Array(buffer);
  }
  /**
   * Publishes one step, or with `source` null a record with no motors (the
   * active model has no electrical drive). Allocation-free.
   */
  publish(source: PowerTelemetrySource | null, tickLo: number, tickHi: number, epoch: number, modelId: number, droppedEvents: number): void {
    const v = this.view, count = (Atomics.load(this.shared, PowerHeaderV1.Published) >>> 0) + 1;
    this.scratch.fill(0);
    v.setUint32(R.sampleId, count >>> 0, true);
    v.setUint32(R.tickLo, tickLo >>> 0, true); v.setUint32(R.tickHi, tickHi >>> 0, true);
    v.setUint32(R.epoch, epoch >>> 0, true); v.setUint32(R.modelId, modelId >>> 0, true);
    v.setUint32(R.droppedEvents, droppedEvents >>> 0, true);
    if (source) {
      const n = Math.min(source.motorCount, POWER_MOTOR_CAPACITY_V1), m = source.motors, b = source.battery;
      v.setUint32(R.motorCount, n, true);
      v.setUint32(R.batteryWarning, source.batteryMasks[0]!, true); v.setUint32(R.batteryLimited, source.batteryMasks[1]!, true);
      v.setFloat64(R.stateOfCharge, b[0]!, true); v.setFloat64(R.voltageV, b[1]!, true); v.setFloat64(R.currentA, b[2]!, true);
      v.setFloat64(R.powerW, b[3]!, true); v.setFloat64(R.remainingAh, b[4]!, true); v.setFloat64(R.capacityAh, b[5]!, true);
      for (let i = 0; i < n; i++) {
        const at = R.motors + i * POWER_MOTOR_STRIDE_V1, row = i * 5;
        v.setFloat32(at + M.rpm, m[row]!, true); v.setFloat32(at + M.motorCurrentA, m[row + 1]!, true);
        v.setFloat32(at + M.busCurrentA, m[row + 2]!, true); v.setFloat32(at + M.electricalPowerW, m[row + 3]!, true);
        v.setFloat32(at + M.command, m[row + 4]!, true);
        v.setUint32(at + M.warning, source.motorWarning[i]!, true); v.setUint32(at + M.limited, source.motorLimited[i]!, true);
      }
    }
    publishAtomicFrame(this.shared, this.scratch, BASE_WORD, RECORD_WORDS);
    Atomics.store(this.shared, PowerHeaderV1.Published, count | 0);
  }
}

export class PowerReaderV1 {
  private readonly shared: Int32Array;
  private readonly scratch = new Int32Array(RECORD_WORDS);
  private readonly view = new DataView(this.scratch.buffer);
  constructor(buffer: SharedArrayBuffer) {
    validatePowerChannelV1(buffer);
    this.shared = new Int32Array(buffer);
  }
  /** Copies the latest record into `out`; false (and `out` unchanged) when none was published or the read raced. */
  latest(out: PowerSnapshotV1): boolean {
    for (let attempt = 0; attempt < 3; attempt++) {
      const count = Atomics.load(this.shared, PowerHeaderV1.Published) >>> 0;
      if (count === 0) return false;
      if (!tryReadAtomicFrame(this.shared, this.scratch, BASE_WORD, RECORD_WORDS)) continue;
      const v = this.view;
      if (v.getUint32(R.sampleId, true) !== count || (Atomics.load(this.shared, PowerHeaderV1.Published) >>> 0) !== count) continue;
      const n = v.getUint32(R.motorCount, true);
      if (n > POWER_MOTOR_CAPACITY_V1) return false;
      out.sampleId = count; out.tickLo = v.getUint32(R.tickLo, true); out.tickHi = v.getUint32(R.tickHi, true);
      out.epoch = v.getUint32(R.epoch, true); out.modelId = v.getUint32(R.modelId, true); out.motorCount = n;
      out.batteryWarning = v.getUint32(R.batteryWarning, true); out.batteryLimited = v.getUint32(R.batteryLimited, true);
      out.droppedEvents = v.getUint32(R.droppedEvents, true);
      out.stateOfCharge = v.getFloat64(R.stateOfCharge, true); out.voltageV = v.getFloat64(R.voltageV, true);
      out.currentA = v.getFloat64(R.currentA, true); out.powerW = v.getFloat64(R.powerW, true);
      out.remainingAh = v.getFloat64(R.remainingAh, true); out.capacityAh = v.getFloat64(R.capacityAh, true);
      for (let i = 0; i < POWER_MOTOR_CAPACITY_V1; i++) {
        const at = R.motors + i * POWER_MOTOR_STRIDE_V1, row = i * 5;
        out.motors[row] = v.getFloat32(at + M.rpm, true); out.motors[row + 1] = v.getFloat32(at + M.motorCurrentA, true);
        out.motors[row + 2] = v.getFloat32(at + M.busCurrentA, true); out.motors[row + 3] = v.getFloat32(at + M.electricalPowerW, true);
        out.motors[row + 4] = v.getFloat32(at + M.command, true);
        out.motorWarning[i] = v.getUint32(at + M.warning, true); out.motorLimited[i] = v.getUint32(at + M.limited, true);
      }
      return true;
    }
    return false;
  }
}
