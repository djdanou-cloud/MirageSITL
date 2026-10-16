import { MAX_MODE_SLOT_V2, PILOT_FLAGS_MASK_V2, PILOT_RESERVED_WORDS_V2, PILOT_WORDS_V2, PilotOffsetV2,
  UNKNOWN_U32 } from './layout-v2.ts';

/** Pilot mailbox v2 contents (docs/SPECS_SHARED_MEMORY.md section 3, "Pilot mailbox v2"). */
export interface PilotInputV2 {
  expectedEpoch: number; sampledWallTimeMs: number;
  /** roll/pitch/yaw in [-1,1], throttle in [0,1]. */
  roll: number; pitch: number; yaw: number; throttle: number;
  /** bit0 Connected, bit1 Armed. */
  flags: number;
  /** [0,5], or UNKNOWN_U32 when unavailable; not a PWM value or ArduPilot mode number. */
  calibratedModeSlot: number;
  /** ArduPilot custom_mode, or UNKNOWN_U32 for no request. */
  requestedMode: number;
  deviceGeneration: number; inputSampleId: number;
}
export function newPilotInputV2(): PilotInputV2 {
  return { expectedEpoch: 0, sampledWallTimeMs: 0, roll: 0, pitch: 0, yaw: 0, throttle: 0, flags: 0,
    calibratedModeSlot: UNKNOWN_U32, requestedMode: UNKNOWN_U32, deviceGeneration: 0, inputSampleId: 0 };
}
/**
 * Shape check for a decoded mailbox. A false result means the consumer must
 * treat the input as invalid and disarm (epoch/staleness/device checks are
 * the consumer's session policy and are applied separately). Allocation-free.
 */
export function isValidPilotInputV2(p: PilotInputV2): boolean {
  // Inline comparisons only (see isValidTick): range tests reject NaN; (x >>> 0) === x is exactly uint32.
  return (p.expectedEpoch >>> 0) === p.expectedEpoch && Math.abs(p.sampledWallTimeMs) <= Number.MAX_VALUE &&
    p.roll >= -1 && p.roll <= 1 && p.pitch >= -1 && p.pitch <= 1 && p.yaw >= -1 && p.yaw <= 1 &&
    p.throttle >= 0 && p.throttle <= 1 &&
    (p.flags >>> 0) === p.flags && (p.flags & ~PILOT_FLAGS_MASK_V2) === 0 &&
    (p.calibratedModeSlot >>> 0) === p.calibratedModeSlot &&
    (p.calibratedModeSlot <= MAX_MODE_SLOT_V2 || p.calibratedModeSlot === UNKNOWN_U32) &&
    (p.requestedMode >>> 0) === p.requestedMode && (p.deviceGeneration >>> 0) === p.deviceGeneration &&
    (p.inputSampleId >>> 0) === p.inputSampleId;
}

const O = PilotOffsetV2;
/** Packs/unpacks the 64-byte pilot mailbox in a thread-local scratch frame; word 0 belongs to the transport. */
export class PilotCodecV2 {
  readonly words = new Int32Array(PILOT_WORDS_V2);
  private readonly view = new DataView(this.words.buffer);

  pack(p: PilotInputV2): void {
    const v = this.view;
    v.setUint32(O.expectedEpoch, p.expectedEpoch, true);
    v.setFloat64(O.sampledWallTimeMs, p.sampledWallTimeMs, true);
    v.setFloat32(O.roll, p.roll, true); v.setFloat32(O.pitch, p.pitch, true);
    v.setFloat32(O.yaw, p.yaw, true); v.setFloat32(O.throttle, p.throttle, true);
    v.setUint32(O.flags, p.flags, true);
    v.setUint32(O.calibratedModeSlot, p.calibratedModeSlot, true);
    v.setUint32(O.requestedMode, p.requestedMode, true);
    v.setUint32(O.deviceGeneration, p.deviceGeneration, true);
    v.setUint32(O.inputSampleId, p.inputSampleId, true);
    for (let word = 0; word < PILOT_RESERVED_WORDS_V2; word++) v.setUint32(O.reserved + word * 4, 0, true);
  }

  unpack(p: PilotInputV2): void {
    const v = this.view;
    p.expectedEpoch = v.getUint32(O.expectedEpoch, true);
    p.sampledWallTimeMs = v.getFloat64(O.sampledWallTimeMs, true);
    p.roll = v.getFloat32(O.roll, true); p.pitch = v.getFloat32(O.pitch, true);
    p.yaw = v.getFloat32(O.yaw, true); p.throttle = v.getFloat32(O.throttle, true);
    p.flags = v.getUint32(O.flags, true);
    p.calibratedModeSlot = v.getUint32(O.calibratedModeSlot, true);
    p.requestedMode = v.getUint32(O.requestedMode, true);
    p.deviceGeneration = v.getUint32(O.deviceGeneration, true);
    p.inputSampleId = v.getUint32(O.inputSampleId, true);
  }
}
