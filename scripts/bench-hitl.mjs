import { cli, exact, finite, provenance, percentile, report, text } from "./validation/evidence.mjs";
/**
 * Version 2 proposal TASK-051. ArduPilot only, firmware 4.6.3 or newer.
 * Simulation-on-Hardware: https://ardupilot.org/dev/docs/sim-on-hardware.html
 *   env SIM_ENABLED 1; AHRS_EKF_TYPE 10; GPS1_TYPE 100; SIM_MAG1_DEVID 97539;
 *   SIM_OH_MASK selects real servo channels (default 0).
 * Hybrid SITL: ArduPilot JSON physics backend
 *   https://ardupilot.org/dev/docs/sitl-with-JSON.html
 *   UDP 9002, magic 18458 (16 PWM) or 29569 (32 PWM).
 *   placement "pc" is sim_vehicle.py --model JSON:host.
 *   placement "board" is Simulation-on-Hardware with AP_SIM_JSON_ENABLED 1
 *   and --simclass JSON.
 * PX4 and HIL_SENSOR / HIL_ACTUATOR_CONTROLS are outside this bench.
 * A PASS does not call AutopilotSession.connect("hitl") or enable browser READY.
 */
export const MIN_ARDUPILOT = Object.freeze({ major: 4, minor: 6, patch: 3 });
export const SOH_EKF_TYPE = 10;
export const SOH_GPS_TYPE = 100;
export const SOH_MAG_DEVID = 97539;
export const JSON_MAGIC_16 = 18458;
export const JSON_MAGIC_32 = 29569;
export const JSON_UDP_PORT = 9002;
/** Pinned JSON protocol commit exercised by the no-drone virtual stage. */
export const VIRTUAL_PROTOCOL_COMMIT_SHORT = "8ab6afde";
/** Native SITL ELF and browser WASM are not Simulation-on-Hardware board images. */
export const UNSUPPORTED_SOH_FIRMWARE = new Set([
  "fa37bf619bce116d410931f1b7d24ea72ed444ba529379df0db9738742ecb186",
  "556d97fa6dbf7c0a2cf713f6106a6891de0b9bc9c5a7dd945f1789b63e58df38",
]);
const HEARTBEAT_GAP_US = 2_500_000;
const UNPLUG_WINDOW_US = 5_000_000;
function integer(value, min, max, label) {
  finite(value, min, max);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}
export function ardupilotVersionAtLeast(major, minor, patch) {
  integer(major, 0, 255, "major");
  integer(minor, 0, 255, "minor");
  integer(patch, 0, 255, "patch");
  if (major !== MIN_ARDUPILOT.major) return major > MIN_ARDUPILOT.major;
  if (minor !== MIN_ARDUPILOT.minor) return minor > MIN_ARDUPILOT.minor;
  return patch >= MIN_ARDUPILOT.patch;
}
function gitShort(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}$/.test(value)) throw new Error("Firmware git short hash must be 8 lowercase hex characters");
}
function firmwareOf(v) {
  exact(v, ["stack", "major", "minor", "patch", "gitShort"]);
  if (v.stack !== "ardupilot") throw new Error("Only ArduPilot is in scope");
  gitShort(v.gitShort);
  return ardupilotVersionAtLeast(v.major, v.minor, v.patch);
}
function unplugOf(v, afterUs) {
  exact(v, ["tUs", "linkLost", "actuatorsDisabled"]);
  integer(v.tUs, afterUs + 1, afterUs + UNPLUG_WINDOW_US, "unplug time");
  if (v.linkLost !== true || v.actuatorsDisabled !== true) return false;
  return true;
}
function heartbeatsOf(samples, durationS) {
  if (!Array.isArray(samples) || samples.length < durationS + 1 || samples.length > durationS * 2 + 2) throw new Error("Heartbeat count does not cover the bench");
  let previous = -1;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    exact(s, ["tUs", "autopilot", "baseMode"]);
    integer(s.tUs, 0, durationS * 1e6 + 1_500_000, "heartbeat time");
    if (i === 0 && s.tUs !== 0) throw new Error("Heartbeat clock must start at 0");
    if (s.tUs <= previous || s.tUs - previous > HEARTBEAT_GAP_US) throw new Error("Heartbeat gap");
    previous = s.tUs;
    if (s.autopilot !== 3) throw new Error("HEARTBEAT autopilot must be ArduPilot");
    integer(s.baseMode, 0, 255, "base mode");
  }
  const last = samples[samples.length - 1].tUs;
  if (last < durationS * 1e6 || last > durationS * 1e6 + 1_500_000) throw new Error("Heartbeat window does not match duration");
  return last;
}
function jsonFramesOf(observation, durationS) {
  const vehicle = observation.vehicle;
  if (vehicle !== "copter" && vehicle !== "plane" && vehicle !== "rover" && vehicle !== "blimp") throw new Error("Unsupported ArduPilot vehicle");
  integer(observation.jsonMagic, JSON_MAGIC_16, JSON_MAGIC_32, "JSON magic");
  const channels = observation.jsonMagic === JSON_MAGIC_16 ? 16 : observation.jsonMagic === JSON_MAGIC_32 ? 32 : 0;
  if (channels === 0 || observation.pwmChannels !== channels) throw new Error("JSON magic does not match the PWM channel count");
  integer(observation.simRateHz, 50, 2000, "SIM_RATE_HZ");
  if (1000000 % observation.simRateHz !== 0) throw new Error("SIM_RATE_HZ must divide 1000000");
  const minimum = vehicle === "copter" ? 400 : 50;
  if (observation.simRateHz < minimum) return { ok: false, p99LatenessMs: null, count: 0 };
  if (observation.udpPort !== JSON_UDP_PORT) throw new Error("Hybrid SITL listens on UDP 9002");
  const frames = observation.frames;
  const expected = durationS * observation.simRateHz;
  if (!Array.isArray(frames) || frames.length !== expected) throw new Error("Incomplete Hybrid SITL frame stream");
  const step = 1000000 / observation.simRateHz;
  const late = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    exact(frame, ["sequence", "scheduledUs", "sentUs"]);
    if (frame.sequence !== i || frame.scheduledUs !== i * step) throw new Error("Hybrid SITL sequence gap");
    finite(frame.sentUs, frame.scheduledUs);
    late.push((frame.sentUs - frame.scheduledUs) / 1000);
  }
  const p99LatenessMs = percentile(late, 0.99);
  const limit = observation.simRateHz >= 400 ? 2.5 : 5;
  return { ok: p99LatenessMs <= limit, p99LatenessMs, count: frames.length, lastUs: frames[frames.length - 1].sentUs };
}
/** Offline analysis of an operator-recorded ArduPilot bench. Does not open a serial port or enable actuators. */
export function assessHitl(v) {
  exact(v, ["schemaVersion", "provenance", "board", "mode", "execution", "firmware", "durationS", "observation", "unplug"]);
  if (v.schemaVersion !== 2) throw new Error("ArduPilot bench requires schemaVersion 2");
  if (v.execution !== "virtual" && v.execution !== "recorded") throw new Error("Execution must be virtual or recorded");
  if (v.mode !== "simulation-on-hardware" && v.mode !== "hybrid-sitl") throw new Error("Only Simulation-on-Hardware and Hybrid SITL are in scope");
  if (v.execution === "virtual" && v.mode !== "hybrid-sitl") throw new Error("The virtual stage is Hybrid SITL and does not connect a drone");
  text(v.board);
  const versionOk = firmwareOf(v.firmware);
  finite(v.durationS, 60, 3600);
  integer(v.durationS, 60, 3600, "duration");
  const reasons = [];
  if (v.execution === "virtual" && v.firmware.gitShort !== VIRTUAL_PROTOCOL_COMMIT_SHORT) reasons.push("Virtual Hybrid SITL must run the pinned JSON protocol commit 8ab6afde");
  if (v.execution === "recorded" && !versionOk) reasons.push("Firmware is older than ArduPilot 4.6.3");
  let metrics;
  if (v.mode === "simulation-on-hardware") {
    provenance(v.provenance, "hardware");
    exact(v.observation, ["heartbeats", "parameters", "propsRemoved"]);
    exact(v.observation.parameters, ["ahrsEkfType", "gps1Type", "simMag1Devid", "simOhMask"]);
    const parameters = v.observation.parameters;
    if (parameters.ahrsEkfType !== SOH_EKF_TYPE || parameters.gps1Type !== SOH_GPS_TYPE || parameters.simMag1Devid !== SOH_MAG_DEVID) {
      reasons.push("Simulation-on-Hardware requires AHRS_EKF_TYPE 10, GPS1_TYPE 100 and SIM_MAG1_DEVID 97539");
    }
    integer(parameters.simOhMask, 0, 65535, "SIM_OH_MASK");
    if (v.observation.propsRemoved !== true) reasons.push("Props were not recorded as removed");
    if (UNSUPPORTED_SOH_FIRMWARE.has(v.provenance.firmwareSha256)) reasons.push("Firmware image is the native SITL ELF or browser WASM, not a Simulation-on-Hardware board build");
    const lastUs = heartbeatsOf(v.observation.heartbeats, v.durationS);
    if (!unplugOf(v.unplug, lastUs)) reasons.push("Unplug did not show the link lost and actuators disabled");
    metrics = { mode: v.mode, execution: v.execution, droneConnected: true, firmwareObserved: true, version: `${v.firmware.major}.${v.firmware.minor}.${v.firmware.patch}`, gitShort: v.firmware.gitShort, heartbeats: v.observation.heartbeats.length, simOhMask: parameters.simOhMask };
  } else {
    exact(v.observation, ["placement", "vehicle", "jsonMagic", "pwmChannels", "simRateHz", "udpPort", "frames", "propsRemoved"]);
    if (v.execution === "virtual") {
      if (v.observation.placement !== "pc") throw new Error("Virtual Hybrid SITL stays on this computer");
      provenance(v.provenance, "virtual-sitl");
    } else if (v.observation.placement === "pc") provenance(v.provenance, "native-sitl");
    else if (v.observation.placement === "board") provenance(v.provenance, "hardware");
    else throw new Error("Hybrid SITL placement must be pc or board");
    if (v.observation.propsRemoved !== true) reasons.push("Props were not recorded as removed");
    if (v.observation.placement === "board" && UNSUPPORTED_SOH_FIRMWARE.has(v.provenance.firmwareSha256)) {
      reasons.push("Firmware image is the native SITL ELF or browser WASM, not a Simulation-on-Hardware board build");
    }
    const frames = jsonFramesOf(v.observation, v.durationS);
    if (!frames.ok) reasons.push(v.observation.vehicle === "copter" && v.observation.simRateHz < 400
      ? "Copter Hybrid SITL requires SIM_RATE_HZ of at least 400"
      : "Hybrid SITL frame timing failed");
    if (frames.ok && !unplugOf(v.unplug, frames.lastUs)) reasons.push("Unplug did not show the link lost and actuators disabled");
    const droneConnected = v.execution === "recorded" && v.observation.placement === "board";
    metrics = { mode: v.mode, execution: v.execution, placement: v.observation.placement, droneConnected, firmwareObserved: v.execution === "recorded", version: v.execution === "virtual" ? "unobserved" : `${v.firmware.major}.${v.firmware.minor}.${v.firmware.patch}`, gitShort: v.firmware.gitShort, p99LatenessMs: frames.p99LatenessMs, count: frames.count, simRateHz: v.observation.simRateHz };
  }
  return report("hitl-report", reasons.length === 0 ? "PASS" : "FAIL", reasons, metrics);
}
cli(import.meta.url, "hitl-report", assessHitl);
