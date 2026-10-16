import { SLOT_GEO, SLOT_VALUES, SPSC_SLOT_WORDS, SlotOffsetV2 } from './spsc-v2.ts';
import { isValidTick, type TickId } from './state-v2.ts';

// Actuator queue frames (docs/SPECS_SHARED_MEMORY.md section 5). Values are
// normalized [-1,1]; a motor_map profile defines what each channel drives.

export const ACTUATOR_FRAME_KIND = 1;
export const ActuatorFlagV2 = { Armed: 1 << 0 } as const;
export const ACTUATOR_FLAGS_MASK_V2 = 0x1;
export const MAX_ACTUATORS = 16;

export interface ActuatorFrameV2 {
  kind: number; epoch: number; tickId: TickId; actuatorTimeUs: TickId;
  actuatorFlags: number; actuatorCount: number;
  normalizedActuators: Float64Array;
  motorMapId: number;
}
export function newActuatorFrameV2(): ActuatorFrameV2 {
  return { kind: ACTUATOR_FRAME_KIND, epoch: 0, tickId: { lo: 0, hi: 0 }, actuatorTimeUs: { lo: 0, hi: 0 },
    actuatorFlags: 0, actuatorCount: 0, normalizedActuators: new Float64Array(SLOT_VALUES), motorMapId: 0 };
}

/** Allocation-free contract check used before encoding and after decoding. */
export function isValidActuatorFrameV2(f: ActuatorFrameV2): boolean {
  if (f.kind !== ACTUATOR_FRAME_KIND || !Number.isInteger(f.actuatorCount) || f.actuatorCount < 0 || f.actuatorCount > MAX_ACTUATORS ||
    f.normalizedActuators.length !== SLOT_VALUES || (f.epoch >>> 0) !== f.epoch || !isValidTick(f.tickId) || !isValidTick(f.actuatorTimeUs) ||
    (f.motorMapId >>> 0) !== f.motorMapId || (f.actuatorFlags >>> 0) !== f.actuatorFlags || (f.actuatorFlags & ~ACTUATOR_FLAGS_MASK_V2) !== 0) return false;
  for (let i = 0; i < SLOT_VALUES; i++) {
    const value = f.normalizedActuators[i]!;
    if (i < f.actuatorCount ? !(value >= -1 && value <= 1) : value !== 0) return false;
  }
  return true;
}

const O = SlotOffsetV2;
export class ActuatorFrameCodecV2 {
  readonly words = new Int32Array(SPSC_SLOT_WORDS);
  private readonly view = new DataView(this.words.buffer);

  encode(f: ActuatorFrameV2): boolean {
    if (!isValidActuatorFrameV2(f)) return false;
    const v = this.view;
    v.setUint32(O.kind, f.kind, true); v.setUint32(O.epoch, f.epoch, true);
    v.setUint32(O.tickId, f.tickId.lo, true); v.setUint32(O.tickId + 4, f.tickId.hi, true);
    v.setUint32(O.timeUs, f.actuatorTimeUs.lo, true); v.setUint32(O.timeUs + 4, f.actuatorTimeUs.hi, true);
    v.setUint32(O.flags, f.actuatorFlags, true); v.setUint32(O.count, f.actuatorCount, true);
    for (let i = 0; i < SLOT_VALUES; i++) v.setFloat32(O.values + i * 4, f.normalizedActuators[i]!, true);
    for (let i = 0; i < SLOT_GEO; i++) v.setFloat64(O.geo + i * 8, 0, true);
    v.setUint32(O.sourceId, f.motorMapId, true); v.setUint32(O.reserved, 0, true);
    return true;
  }
  decode(out: ActuatorFrameV2): boolean {
    const v = this.view;
    for (let i = 0; i < SLOT_GEO; i++) if (v.getFloat64(O.geo + i * 8, true) !== 0) return false;
    if (v.getUint32(O.reserved, true) !== 0) return false;
    out.kind = v.getUint32(O.kind, true); out.epoch = v.getUint32(O.epoch, true);
    out.tickId.lo = v.getUint32(O.tickId, true); out.tickId.hi = v.getUint32(O.tickId + 4, true);
    out.actuatorTimeUs.lo = v.getUint32(O.timeUs, true); out.actuatorTimeUs.hi = v.getUint32(O.timeUs + 4, true);
    out.actuatorFlags = v.getUint32(O.flags, true); out.actuatorCount = v.getUint32(O.count, true);
    for (let i = 0; i < SLOT_VALUES; i++) out.normalizedActuators[i] = v.getFloat32(O.values + i * 4, true);
    out.motorMapId = v.getUint32(O.sourceId, true);
    return isValidActuatorFrameV2(out);
  }
}
