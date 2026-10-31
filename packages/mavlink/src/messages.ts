import { definition, type FieldLayout, type FieldType, type MavFrame } from "./codec.ts";
/** HIL_ACTUATOR_CONTROLS only. Actual mapping/signing/firmware admission belongs to HITL gates. */
export interface HilActuators {
  timeLoUs: number;
  timeHiUs: number;
  flagsLo: number;
  flagsHi: number;
  mode: number;
  controls: Float64Array;
}
export function actuatorInto(frame: MavFrame, out: HilActuators): boolean {
  if (
    frame.id !== 93 ||
    frame.view.byteLength < 81 ||
    out.controls.length !== 16
  )
    return false;
  const v = frame.view;
  for (let i = 0; i < 16; i++) {
    const x = v.getFloat32(16 + i * 4, true);
    if (!Number.isFinite(x) || x < -1 || x > 1) return false;
  }
  out.timeLoUs = v.getUint32(0, true);
  out.timeHiUs = v.getUint32(4, true);
  out.flagsLo = v.getUint32(8, true);
  out.flagsHi = v.getUint32(12, true);
  out.mode = v.getUint8(80);
  for (let i = 0; i < 16; i++) out.controls[i] = v.getFloat32(16 + i * 4, true);
  return true;
}

// ---- TASK-150: Phase 1 ground-station messages ------------------------------------------------


/** A builder value: a number for a scalar, an array of numbers for an array field, ASCII text for a char field. */
export type FieldValue = number | string | readonly number[];

const SIZE: Record<FieldType, number> = { uint8_t: 1, int8_t: 1, char: 1, uint16_t: 2, int16_t: 2, uint32_t: 4, int32_t: 4,
  float: 4, uint64_t: 8, int64_t: 8, double: 8 };
const TWO32 = 4294967296;

/** The named field of a supported message, or null. */
export function fieldOf(id: number, name: string): FieldLayout | null {
  return definition(id)?.fields.find((f) => f.name === name) ?? null;
}

/**
 * Element `index` of a numeric field from a payload view. 64-bit fields are
 * read as two 32-bit words, so they never allocate a BigInt; above 2^53 the
 * result is the nearest double. Char fields read as their byte value.
 */
export function readNumber(view: DataView, field: FieldLayout, index = 0): number {
  const at = field.offset + index * SIZE[field.type];
  switch (field.type) {
    case "uint8_t": case "char": return view.getUint8(at);
    case "int8_t": return view.getInt8(at);
    case "uint16_t": return view.getUint16(at, true);
    case "int16_t": return view.getInt16(at, true);
    case "uint32_t": return view.getUint32(at, true);
    case "int32_t": return view.getInt32(at, true);
    case "uint64_t": return view.getUint32(at, true) + view.getUint32(at + 4, true) * TWO32;
    case "int64_t": return view.getUint32(at, true) + view.getInt32(at + 4, true) * TWO32;
    case "float": return view.getFloat32(at, true);
    case "double": return view.getFloat64(at, true);
  }
}

/** A char field as text, up to its first NUL (cold: allocates the string). */
export function readText(payload: Uint8Array, field: FieldLayout): string {
  let text = "";
  for (let i = 0; i < field.count; i++) {
    const c = payload[field.offset + i] ?? 0;
    if (c === 0) break;
    text += String.fromCharCode(c);
  }
  return text;
}

const RANGE: Partial<Record<FieldType, readonly [number, number]>> = {
  uint8_t: [0, 255], int8_t: [-128, 127], uint16_t: [0, 65535], int16_t: [-32768, 32767],
  uint32_t: [0, TWO32 - 1], int32_t: [-2147483648, 2147483647],
  uint64_t: [0, Number.MAX_SAFE_INTEGER], int64_t: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};
const scratch = new Uint8Array(255), scratchView = new DataView(scratch.buffer);

function writeNumber(field: FieldLayout, index: number, value: unknown): boolean {
  if (typeof value !== "number") return false;
  const at = field.offset + index * SIZE[field.type], range = RANGE[field.type];
  if (range) {
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) return false;
  } else if (!Number.isFinite(field.type === "float" ? Math.fround(value) : value)) return false;
  switch (field.type) {
    case "uint8_t": scratchView.setUint8(at, value); break;
    case "int8_t": scratchView.setInt8(at, value); break;
    case "uint16_t": scratchView.setUint16(at, value, true); break;
    case "int16_t": scratchView.setInt16(at, value, true); break;
    case "uint32_t": scratchView.setUint32(at, value, true); break;
    case "int32_t": scratchView.setInt32(at, value, true); break;
    case "uint64_t": case "int64_t": {
      // Two's complement over 64 bits from an exact integer of at most 53 bits.
      const high = Math.floor(value / TWO32);
      scratchView.setUint32(at, value - high * TWO32, true);
      scratchView.setInt32(at + 4, high, true);
      break;
    }
    case "float": scratchView.setFloat32(at, value, true); break;
    case "double": scratchView.setFloat64(at, value, true); break;
    case "char": return false;
  }
  return true;
}

/**
 * Packs named field values into a supported message's full-length payload
 * (cold path, for commands, parameters, missions and position targets).
 * Unset fields are zero. Returns false, leaving `payload` unchanged, for an
 * unknown message or field, a payload of the wrong length, a non-integer or
 * out-of-range integer, a value that is not finite in its wire type, an array
 * of the wrong length, or text that is not ASCII or does not fit.
 */
export function packInto(id: number, values: Readonly<Record<string, FieldValue>>, payload: Uint8Array): boolean {
  const layout = definition(id);
  if (!layout || payload.length !== layout.length) return false;
  scratch.fill(0, 0, layout.length);
  for (const [name, value] of Object.entries(values)) {
    const field = layout.fields.find((f) => f.name === name);
    if (!field) return false;
    if (field.type === "char") {
      if (typeof value !== "string" || value.length > field.count) return false;
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code > 127) return false;
        scratch[field.offset + i] = code;
      }
    } else if (field.count > 0) {
      if (!Array.isArray(value) || value.length !== field.count) return false;
      for (let i = 0; i < field.count; i++) if (!writeNumber(field, i, value[i])) return false;
    } else if (!writeNumber(field, 0, value)) return false;
  }
  payload.set(scratch.subarray(0, layout.length));
  return true;
}

// ---- High-rate telemetry decoders: preallocated targets, no allocation per frame -------------
// Each decoder reads its fields with direct DataView getters at offsets resolved once from the
// generated table, whose wire types are asserted here, so a decode stores numbers straight into
// the preallocated target and never calls a shared helper that would box its return value.

function at(id: number, name: string, type: FieldType, count = 0): number {
  const field = fieldOf(id, name);
  if (!field || field.type !== type || field.count !== count) throw new Error(`MAVLink table changed ${id}.${name}`);
  return field.offset;
}
const ATT = { time: at(30, "time_boot_ms", "uint32_t"), roll: at(30, "roll", "float"), pitch: at(30, "pitch", "float"), yaw: at(30, "yaw", "float"),
  p: at(30, "rollspeed", "float"), q: at(30, "pitchspeed", "float"), r: at(30, "yawspeed", "float") };
const LPN = { time: at(32, "time_boot_ms", "uint32_t"), x: at(32, "x", "float"), y: at(32, "y", "float"), z: at(32, "z", "float"),
  vx: at(32, "vx", "float"), vy: at(32, "vy", "float"), vz: at(32, "vz", "float") };
const GPI = { time: at(33, "time_boot_ms", "uint32_t"), lat: at(33, "lat", "int32_t"), lon: at(33, "lon", "int32_t"), alt: at(33, "alt", "int32_t"),
  rel: at(33, "relative_alt", "int32_t"), vx: at(33, "vx", "int16_t"), vy: at(33, "vy", "int16_t"), vz: at(33, "vz", "int16_t"),
  hdg: at(33, "hdg", "uint16_t") };
const HUD = { airspeed: at(74, "airspeed", "float"), groundspeed: at(74, "groundspeed", "float"), heading: at(74, "heading", "int16_t"),
  throttle: at(74, "throttle", "uint16_t"), alt: at(74, "alt", "float"), climb: at(74, "climb", "float") };
const SERVO_TIME = at(36, "time_usec", "uint32_t"), SERVO_PORT = at(36, "port", "uint8_t");
const SERVO_OUTPUTS = Int32Array.from({ length: 16 }, (_, i) => at(36, `servo${i + 1}_raw`, "uint16_t"));
const SYS = { present: at(1, "onboard_control_sensors_present", "uint32_t"), enabled: at(1, "onboard_control_sensors_enabled", "uint32_t"),
  health: at(1, "onboard_control_sensors_health", "uint32_t"), load: at(1, "load", "uint16_t"), voltage: at(1, "voltage_battery", "uint16_t"),
  current: at(1, "current_battery", "int16_t"), remaining: at(1, "battery_remaining", "int8_t"), drop: at(1, "drop_rate_comm", "uint16_t"),
  errors: at(1, "errors_comm", "uint16_t"),
  presentExtended: at(1, "onboard_control_sensors_present_extended", "uint32_t"),
  enabledExtended: at(1, "onboard_control_sensors_enabled_extended", "uint32_t"),
  healthExtended: at(1, "onboard_control_sensors_health_extended", "uint32_t") };
const SYS_COUNTS = Int32Array.from([1, 2, 3, 4], (k) => at(1, `errors_count${k}`, "uint16_t"));
const BAT = { id: at(147, "id", "uint8_t"), fn: at(147, "battery_function", "uint8_t"), type: at(147, "type", "uint8_t"),
  temperature: at(147, "temperature", "int16_t"), voltages: at(147, "voltages", "uint16_t", 10), voltagesExt: at(147, "voltages_ext", "uint16_t", 4),
  current: at(147, "current_battery", "int16_t"), consumed: at(147, "current_consumed", "int32_t"), energy: at(147, "energy_consumed", "int32_t"),
  remaining: at(147, "battery_remaining", "int8_t"), timeRemaining: at(147, "time_remaining", "int32_t"),
  chargeState: at(147, "charge_state", "uint8_t"), mode: at(147, "mode", "uint8_t"), fault: at(147, "fault_bitmask", "uint32_t") };

/** ATTITUDE (30): body attitude and rates. */
export interface Attitude { timeBootMs: number; rollRad: number; pitchRad: number; yawRad: number; rollRateRadS: number; pitchRateRadS: number; yawRateRadS: number }
export function newAttitude(): Attitude {
  return { timeBootMs: 0, rollRad: 0, pitchRad: 0, yawRad: 0, rollRateRadS: 0, pitchRateRadS: 0, yawRateRadS: 0 };
}
export function attitudeInto(frame: MavFrame, out: Attitude): boolean {
  if (frame.id !== 30) return false;
  const v = frame.view;
  out.timeBootMs = v.getUint32(ATT.time, true); out.rollRad = v.getFloat32(ATT.roll, true); out.pitchRad = v.getFloat32(ATT.pitch, true);
  out.yawRad = v.getFloat32(ATT.yaw, true); out.rollRateRadS = v.getFloat32(ATT.p, true); out.pitchRateRadS = v.getFloat32(ATT.q, true);
  out.yawRateRadS = v.getFloat32(ATT.r, true);
  return true;
}
/** LOCAL_POSITION_NED (32): position and velocity in the autopilot's local NED frame. */
export interface LocalPositionNed { timeBootMs: number; northM: number; eastM: number; downM: number; vnMps: number; veMps: number; vdMps: number }
export function newLocalPositionNed(): LocalPositionNed {
  return { timeBootMs: 0, northM: 0, eastM: 0, downM: 0, vnMps: 0, veMps: 0, vdMps: 0 };
}
export function localPositionNedInto(frame: MavFrame, out: LocalPositionNed): boolean {
  if (frame.id !== 32) return false;
  const v = frame.view;
  out.timeBootMs = v.getUint32(LPN.time, true); out.northM = v.getFloat32(LPN.x, true); out.eastM = v.getFloat32(LPN.y, true);
  out.downM = v.getFloat32(LPN.z, true); out.vnMps = v.getFloat32(LPN.vx, true); out.veMps = v.getFloat32(LPN.vy, true);
  out.vdMps = v.getFloat32(LPN.vz, true);
  return true;
}
/** GLOBAL_POSITION_INT (33): the fused global position in the wire's integer units. */
export interface GlobalPositionInt {
  timeBootMs: number; latitudeE7: number; longitudeE7: number; altitudeMslMm: number; relativeAltitudeMm: number;
  vnCmps: number; veCmps: number; vdCmps: number; headingCdeg: number;
}
export function newGlobalPositionInt(): GlobalPositionInt {
  return { timeBootMs: 0, latitudeE7: 0, longitudeE7: 0, altitudeMslMm: 0, relativeAltitudeMm: 0, vnCmps: 0, veCmps: 0, vdCmps: 0, headingCdeg: 0 };
}
export function globalPositionIntInto(frame: MavFrame, out: GlobalPositionInt): boolean {
  if (frame.id !== 33) return false;
  const v = frame.view;
  out.timeBootMs = v.getUint32(GPI.time, true); out.latitudeE7 = v.getInt32(GPI.lat, true); out.longitudeE7 = v.getInt32(GPI.lon, true);
  out.altitudeMslMm = v.getInt32(GPI.alt, true); out.relativeAltitudeMm = v.getInt32(GPI.rel, true); out.vnCmps = v.getInt16(GPI.vx, true);
  out.veCmps = v.getInt16(GPI.vy, true); out.vdCmps = v.getInt16(GPI.vz, true); out.headingCdeg = v.getUint16(GPI.hdg, true);
  return true;
}
/** VFR_HUD (74): the autopilot's heads-up summary; the heading is degrees as on the wire. */
export interface VfrHud { airspeedMps: number; groundspeedMps: number; headingDeg: number; throttlePercent: number; altitudeM: number; climbMps: number }
export function newVfrHud(): VfrHud {
  return { airspeedMps: 0, groundspeedMps: 0, headingDeg: 0, throttlePercent: 0, altitudeM: 0, climbMps: 0 };
}
export function vfrHudInto(frame: MavFrame, out: VfrHud): boolean {
  if (frame.id !== 74) return false;
  const v = frame.view;
  out.airspeedMps = v.getFloat32(HUD.airspeed, true); out.groundspeedMps = v.getFloat32(HUD.groundspeed, true);
  out.headingDeg = v.getInt16(HUD.heading, true); out.throttlePercent = v.getUint16(HUD.throttle, true);
  out.altitudeM = v.getFloat32(HUD.alt, true); out.climbMps = v.getFloat32(HUD.climb, true);
  return true;
}
/** SERVO_OUTPUT_RAW (36): all 16 outputs; outputs 9 to 16 are MAVLink2 extensions and read 0 from senders without them. */
export interface ServoOutputRaw { timeUs: number; port: number; outputsUs: Uint16Array }
export function newServoOutputRaw(): ServoOutputRaw {
  return { timeUs: 0, port: 0, outputsUs: new Uint16Array(16) };
}
export function servoOutputRawInto(frame: MavFrame, out: ServoOutputRaw): boolean {
  if (frame.id !== 36 || out.outputsUs.length !== 16) return false;
  const v = frame.view;
  out.timeUs = v.getUint32(SERVO_TIME, true); out.port = v.getUint8(SERVO_PORT);
  for (let i = 0; i < 16; i++) out.outputsUs[i] = v.getUint16(SERVO_OUTPUTS[i]!, true);
  return true;
}
/** SYS_STATUS (1): sensor bitmasks, load, battery and link error counters in the wire's units. */
export interface SysStatus {
  sensorsPresent: number; sensorsEnabled: number; sensorsHealth: number; loadPermille: number;
  batteryVoltageMv: number; batteryCurrentCa: number; batteryRemainingPercent: number;
  dropRateCommCentipercent: number; errorsComm: number; errorsCount: Uint16Array;
  sensorsPresentExtended: number; sensorsEnabledExtended: number; sensorsHealthExtended: number;
}
export function newSysStatus(): SysStatus {
  return { sensorsPresent: 0, sensorsEnabled: 0, sensorsHealth: 0, loadPermille: 0, batteryVoltageMv: 0, batteryCurrentCa: 0,
    batteryRemainingPercent: 0, dropRateCommCentipercent: 0, errorsComm: 0, errorsCount: new Uint16Array(4),
    sensorsPresentExtended: 0, sensorsEnabledExtended: 0, sensorsHealthExtended: 0 };
}
export function sysStatusInto(frame: MavFrame, out: SysStatus): boolean {
  if (frame.id !== 1 || out.errorsCount.length !== 4) return false;
  const v = frame.view;
  out.sensorsPresent = v.getUint32(SYS.present, true); out.sensorsEnabled = v.getUint32(SYS.enabled, true);
  out.sensorsHealth = v.getUint32(SYS.health, true); out.loadPermille = v.getUint16(SYS.load, true);
  out.batteryVoltageMv = v.getUint16(SYS.voltage, true); out.batteryCurrentCa = v.getInt16(SYS.current, true);
  out.batteryRemainingPercent = v.getInt8(SYS.remaining); out.dropRateCommCentipercent = v.getUint16(SYS.drop, true);
  out.errorsComm = v.getUint16(SYS.errors, true);
  for (let i = 0; i < 4; i++) out.errorsCount[i] = v.getUint16(SYS_COUNTS[i]!, true);
  out.sensorsPresentExtended = v.getUint32(SYS.presentExtended, true); out.sensorsEnabledExtended = v.getUint32(SYS.enabledExtended, true);
  out.sensorsHealthExtended = v.getUint32(SYS.healthExtended, true);
  return true;
}
/** BATTERY_STATUS (147): cells 1 to 10 and the extension cells 11 to 14 in one array, in the wire's units. */
export interface BatteryStatus {
  id: number; batteryFunction: number; type: number; temperatureCdegC: number; cellVoltagesMv: Uint16Array;
  currentCa: number; consumedMah: number; energyHj: number; remainingPercent: number; timeRemainingS: number;
  chargeState: number; mode: number; faultBitmask: number;
}
export function newBatteryStatus(): BatteryStatus {
  return { id: 0, batteryFunction: 0, type: 0, temperatureCdegC: 0, cellVoltagesMv: new Uint16Array(14), currentCa: 0, consumedMah: 0,
    energyHj: 0, remainingPercent: 0, timeRemainingS: 0, chargeState: 0, mode: 0, faultBitmask: 0 };
}
export function batteryStatusInto(frame: MavFrame, out: BatteryStatus): boolean {
  if (frame.id !== 147 || out.cellVoltagesMv.length !== 14) return false;
  const v = frame.view;
  out.id = v.getUint8(BAT.id); out.batteryFunction = v.getUint8(BAT.fn); out.type = v.getUint8(BAT.type);
  out.temperatureCdegC = v.getInt16(BAT.temperature, true);
  for (let i = 0; i < 10; i++) out.cellVoltagesMv[i] = v.getUint16(BAT.voltages + 2 * i, true);
  for (let i = 0; i < 4; i++) out.cellVoltagesMv[10 + i] = v.getUint16(BAT.voltagesExt + 2 * i, true);
  out.currentCa = v.getInt16(BAT.current, true); out.consumedMah = v.getInt32(BAT.consumed, true); out.energyHj = v.getInt32(BAT.energy, true);
  out.remainingPercent = v.getInt8(BAT.remaining); out.timeRemainingS = v.getInt32(BAT.timeRemaining, true);
  out.chargeState = v.getUint8(BAT.chargeState); out.mode = v.getUint8(BAT.mode); out.faultBitmask = v.getUint32(BAT.fault, true);
  return true;
}
