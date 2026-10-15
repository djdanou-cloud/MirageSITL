import { AUTOPILOT_HEALTH_MASK_V2, EKF_FLAGS_MASK_V2, EW_FLAGS_MASK_V2, SENSOR_VALID_MASK_V2,
  STATE_WORDS_V2, StateOffsetV2, UNKNOWN_U32, VEHICLE_FLAGS_MASK_V2, VehicleFlagV2,
  type PhysicsHz } from './layout-v2.ts';

/** u64 step counter as two uint32 halves; avoids BigInt allocation on the hot path. */
export interface TickId { lo: number; hi: number }
export type Vec3 = readonly [number, number, number];
export interface FlightStateV2 {
  sampleId: number; tickId: TickId; epoch: number; simTimeS: number;
  northM: number; eastM: number; downM: number;
  qw: number; qx: number; qy: number; qz: number;
  vnMps: number; veMps: number; vdMps: number;
  anMps2: number; aeMps2: number; adMps2: number;
  pRadS: number; qRadS: number; rRadS: number;
  specificForceXBodyMps2: number; specificForceYBodyMps2: number; specificForceZBodyMps2: number;
  trueAirspeedMps: number; batteryVoltage: number; batteryCurrentA: number;
  ambientPressurePa: number; scheduledWallTimeMs: number;
  groundClearanceM: number; referenceRotorRpm: number;
  vehicleFlags: number; ekfFlags: number; ewFlags: number;
  sensorValidMask: number; modelId: number; autopilotMode: number;
  autopilotHealth: number; lastActuatorTick: TickId; autopilotStatusAgeMs: number;
}

export function incrementTickInPlace(t: TickId): void {
  t.lo = (t.lo + 1) >>> 0;
  if (t.lo === 0) t.hi = (t.hi + 1) >>> 0;
}
export function copyTickInto(source: TickId, target: TickId): void {
  target.lo = source.lo; target.hi = source.hi;
}
export function compareTicks(a: TickId, b: TickId): number {
  return a.hi !== b.hi ? (a.hi < b.hi ? -1 : 1) : a.lo === b.lo ? 0 : a.lo < b.lo ? -1 : 1;
}
/** Largest tick whose value is exactly representable as a Number (< 2^53). */
export const MAX_SAFE_TICK_HI = 0x1fffff;
export function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}
export function isValidTick(t: TickId): boolean {
  return isUint32(t.lo) && isUint32(t.hi) && t.hi <= MAX_SAFE_TICK_HI;
}
/** Exact for valid ticks (< 2^53). */
export function tickToNumber(t: TickId): number {
  return t.hi * 0x100000000 + t.lo;
}
/** sim_time = tick_id / physics_hz, derived from the tick rather than accumulated. */
export function simTimeFromTick(t: TickId, hz: PhysicsHz): number {
  return tickToNumber(t) / hz;
}

export function newFlightStateV2(): FlightStateV2 {
  return {
    sampleId: 0, tickId: { lo: 0, hi: 0 }, epoch: 0, simTimeS: 0,
    northM: 0, eastM: 0, downM: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    vnMps: 0, veMps: 0, vdMps: 0, anMps2: 0, aeMps2: 0, adMps2: 0,
    pRadS: 0, qRadS: 0, rRadS: 0,
    specificForceXBodyMps2: 0, specificForceYBodyMps2: 0, specificForceZBodyMps2: 0,
    trueAirspeedMps: 0, batteryVoltage: 0, batteryCurrentA: 0, ambientPressurePa: 0,
    scheduledWallTimeMs: 0, groundClearanceM: 0, referenceRotorRpm: 0,
    vehicleFlags: VehicleFlagV2.GroundContact | VehicleFlagV2.InputFailsafe | VehicleFlagV2.Paused,
    ekfFlags: 0, ewFlags: 0, sensorValidMask: 0, modelId: 0, autopilotMode: UNKNOWN_U32,
    autopilotHealth: 0, lastActuatorTick: { lo: 0, hi: 0 }, autopilotStatusAgeMs: 0,
  };
}
/** Copies every scalar without allocating; tick objects are reused. */
export function copyFlightStateV2(source: FlightStateV2, target: FlightStateV2): void {
  const tick = target.tickId, actuator = target.lastActuatorTick;
  Object.assign(target, source);
  target.tickId = tick; target.lastActuatorTick = actuator;
  copyTickInto(source.tickId, tick); copyTickInto(source.lastActuatorTick, actuator);
}

function finite32(value: number): boolean {
  return Number.isFinite(Math.fround(value));
}
/**
 * Writer-side contract check: truth is finite, f32 fields fit f32, integer fields are uint32,
 * ticks are < 2^53, and unassigned flag bits are zero. Allocation-free.
 */
export function isValidFlightStateV2(s: FlightStateV2): boolean {
  return isUint32(s.sampleId) && isValidTick(s.tickId) && isValidTick(s.lastActuatorTick) &&
    isUint32(s.epoch) && isUint32(s.modelId) && isUint32(s.autopilotMode) &&
    Number.isFinite(s.simTimeS) && Number.isFinite(s.northM) && Number.isFinite(s.eastM) &&
    Number.isFinite(s.downM) && Number.isFinite(s.scheduledWallTimeMs) &&
    finite32(s.qw) && finite32(s.qx) && finite32(s.qy) && finite32(s.qz) &&
    finite32(s.vnMps) && finite32(s.veMps) && finite32(s.vdMps) &&
    finite32(s.anMps2) && finite32(s.aeMps2) && finite32(s.adMps2) &&
    finite32(s.pRadS) && finite32(s.qRadS) && finite32(s.rRadS) &&
    finite32(s.specificForceXBodyMps2) && finite32(s.specificForceYBodyMps2) && finite32(s.specificForceZBodyMps2) &&
    finite32(s.trueAirspeedMps) && finite32(s.batteryVoltage) && finite32(s.batteryCurrentA) &&
    finite32(s.ambientPressurePa) && finite32(s.groundClearanceM) && finite32(s.referenceRotorRpm) &&
    finite32(s.autopilotStatusAgeMs) &&
    isUint32(s.vehicleFlags) && (s.vehicleFlags & ~VEHICLE_FLAGS_MASK_V2) === 0 &&
    isUint32(s.ekfFlags) && (s.ekfFlags & ~EKF_FLAGS_MASK_V2) === 0 &&
    isUint32(s.ewFlags) && (s.ewFlags & ~EW_FLAGS_MASK_V2) === 0 &&
    isUint32(s.sensorValidMask) && (s.sensorValidMask & ~SENSOR_VALID_MASK_V2) === 0 &&
    isUint32(s.autopilotHealth) && (s.autopilotHealth & ~AUTOPILOT_HEALTH_MASK_V2) === 0;
}

const O = StateOffsetV2;
/**
 * Packs/unpacks one 192-byte state record in a thread-local scratch frame.
 * Word 0 (seqlock) is owned by the transport and never written here; the
 * reserved word is always zero. pack/unpack allocate nothing.
 */
export class StateCodecV2 {
  readonly words = new Int32Array(STATE_WORDS_V2);
  private readonly view = new DataView(this.words.buffer);

  pack(s: FlightStateV2): void {
    const v = this.view;
    v.setUint32(O.sampleId, s.sampleId, true);
    v.setUint32(O.tickId, s.tickId.lo, true); v.setUint32(O.tickId + 4, s.tickId.hi, true);
    v.setFloat64(O.simTimeS, s.simTimeS, true);
    v.setFloat64(O.northM, s.northM, true); v.setFloat64(O.eastM, s.eastM, true); v.setFloat64(O.downM, s.downM, true);
    v.setFloat32(O.qw, s.qw, true); v.setFloat32(O.qx, s.qx, true); v.setFloat32(O.qy, s.qy, true); v.setFloat32(O.qz, s.qz, true);
    v.setFloat32(O.vnMps, s.vnMps, true); v.setFloat32(O.veMps, s.veMps, true); v.setFloat32(O.vdMps, s.vdMps, true);
    v.setFloat32(O.anMps2, s.anMps2, true); v.setFloat32(O.aeMps2, s.aeMps2, true); v.setFloat32(O.adMps2, s.adMps2, true);
    v.setFloat32(O.pRadS, s.pRadS, true); v.setFloat32(O.qRadS, s.qRadS, true); v.setFloat32(O.rRadS, s.rRadS, true);
    v.setFloat32(O.specificForceXBodyMps2, s.specificForceXBodyMps2, true);
    v.setFloat32(O.specificForceYBodyMps2, s.specificForceYBodyMps2, true);
    v.setFloat32(O.specificForceZBodyMps2, s.specificForceZBodyMps2, true);
    v.setFloat32(O.trueAirspeedMps, s.trueAirspeedMps, true);
    v.setFloat32(O.batteryVoltage, s.batteryVoltage, true);
    v.setFloat32(O.batteryCurrentA, s.batteryCurrentA, true);
    v.setFloat32(O.ambientPressurePa, s.ambientPressurePa, true);
    v.setFloat64(O.scheduledWallTimeMs, s.scheduledWallTimeMs, true);
    v.setFloat32(O.groundClearanceM, s.groundClearanceM, true);
    v.setFloat32(O.referenceRotorRpm, s.referenceRotorRpm, true);
    v.setUint32(O.vehicleFlags, s.vehicleFlags, true); v.setUint32(O.ekfFlags, s.ekfFlags, true);
    v.setUint32(O.ewFlags, s.ewFlags, true); v.setUint32(O.sensorValidMask, s.sensorValidMask, true);
    v.setUint32(O.epoch, s.epoch, true); v.setUint32(O.modelId, s.modelId, true);
    v.setUint32(O.autopilotMode, s.autopilotMode, true); v.setUint32(O.autopilotHealth, s.autopilotHealth, true);
    v.setUint32(O.lastActuatorTick, s.lastActuatorTick.lo, true);
    v.setUint32(O.lastActuatorTick + 4, s.lastActuatorTick.hi, true);
    v.setFloat32(O.autopilotStatusAgeMs, s.autopilotStatusAgeMs, true);
    v.setUint32(O.reserved, 0, true);
  }

  unpack(s: FlightStateV2): void {
    const v = this.view;
    s.sampleId = v.getUint32(O.sampleId, true);
    s.tickId.lo = v.getUint32(O.tickId, true); s.tickId.hi = v.getUint32(O.tickId + 4, true);
    s.simTimeS = v.getFloat64(O.simTimeS, true);
    s.northM = v.getFloat64(O.northM, true); s.eastM = v.getFloat64(O.eastM, true); s.downM = v.getFloat64(O.downM, true);
    s.qw = v.getFloat32(O.qw, true); s.qx = v.getFloat32(O.qx, true); s.qy = v.getFloat32(O.qy, true); s.qz = v.getFloat32(O.qz, true);
    s.vnMps = v.getFloat32(O.vnMps, true); s.veMps = v.getFloat32(O.veMps, true); s.vdMps = v.getFloat32(O.vdMps, true);
    s.anMps2 = v.getFloat32(O.anMps2, true); s.aeMps2 = v.getFloat32(O.aeMps2, true); s.adMps2 = v.getFloat32(O.adMps2, true);
    s.pRadS = v.getFloat32(O.pRadS, true); s.qRadS = v.getFloat32(O.qRadS, true); s.rRadS = v.getFloat32(O.rRadS, true);
    s.specificForceXBodyMps2 = v.getFloat32(O.specificForceXBodyMps2, true);
    s.specificForceYBodyMps2 = v.getFloat32(O.specificForceYBodyMps2, true);
    s.specificForceZBodyMps2 = v.getFloat32(O.specificForceZBodyMps2, true);
    s.trueAirspeedMps = v.getFloat32(O.trueAirspeedMps, true);
    s.batteryVoltage = v.getFloat32(O.batteryVoltage, true);
    s.batteryCurrentA = v.getFloat32(O.batteryCurrentA, true);
    s.ambientPressurePa = v.getFloat32(O.ambientPressurePa, true);
    s.scheduledWallTimeMs = v.getFloat64(O.scheduledWallTimeMs, true);
    s.groundClearanceM = v.getFloat32(O.groundClearanceM, true);
    s.referenceRotorRpm = v.getFloat32(O.referenceRotorRpm, true);
    s.vehicleFlags = v.getUint32(O.vehicleFlags, true); s.ekfFlags = v.getUint32(O.ekfFlags, true);
    s.ewFlags = v.getUint32(O.ewFlags, true); s.sensorValidMask = v.getUint32(O.sensorValidMask, true);
    s.epoch = v.getUint32(O.epoch, true); s.modelId = v.getUint32(O.modelId, true);
    s.autopilotMode = v.getUint32(O.autopilotMode, true); s.autopilotHealth = v.getUint32(O.autopilotHealth, true);
    s.lastActuatorTick.lo = v.getUint32(O.lastActuatorTick, true);
    s.lastActuatorTick.hi = v.getUint32(O.lastActuatorTick + 4, true);
    s.autopilotStatusAgeMs = v.getFloat32(O.autopilotStatusAgeMs, true);
  }
}
