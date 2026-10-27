// Measures ArduPilot's IMU noise floor in a native SITL capture (TASK-089).
//
//   node scripts/check-imu-noise-floor.mjs --input CAPTURE_DIRECTORY --expect ardupilot|off
//     [--reference CAPTURE_DIRECTORY] [--output REPORT]
//
// The capture comes from scripts/sitl/driver.mjs. Before arming the synthetic
// quad rests on its floor, so the truth the driver sends is constant apart from
// ArduPilot's linear gyro drift, and the firmware's own error terms are all that
// HIGHRES_IMU shows once a straight line is removed per axis. With the motors
// off ArduPilot adds no throttle noise, so the residual is the noise floor.
// --reference compares HIGHRES_IMU samples by firmware time with another capture,
// e.g. patched firmware on defaults against upstream, up to the first driver
// command of either run: MAVLink commands reach the firmware at wall-clock
// times, so the flights may diverge after them. Any differing value fails.
// Exit 0 PASS, 1 FAIL or invalid capture, 2 BLOCKED_EXTERNAL (no capture).
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Disarmed window: the first 10 s hold boot transients; the last second before arming is excluded. */
export const WINDOW_START_S = 10, ARM_MARGIN_S = 1, MIN_WINDOW_S = 10, MIN_SAMPLES = 2000;
/**
 * Set before measurement from the pinned upstream floor (uniform ±0.01 m/s/s
 * accelerometer, ±radians(0.04) gyro, before ArduPilot's 20 Hz filters):
 * "off" must sit 100x below the expected filtered floor, "ardupilot" above a tenth of it.
 */
export const LIMITS = {
  off: { accelMaxStdMps2: 1e-5, gyroMaxStdRadS: 1e-6 },
  ardupilot: { accelMinStdMps2: 1e-4, gyroMinStdRadS: 1e-5 },
};
const AXES = [["xacc", "accel"], ["yacc", "accel"], ["zacc", "accel"], ["xgyro", "gyro"], ["ygyro", "gyro"], ["zgyro", "gyro"]];

/** Least-squares line through (t, v); returns the residual standard deviation and largest absolute residual. */
export function detrendedSpread(times, values) {
  const n = times.length;
  let meanT = 0, meanV = 0;
  for (let i = 0; i < n; i++) { meanT += times[i]; meanV += values[i]; }
  meanT /= n; meanV /= n;
  let stt = 0, stv = 0;
  for (let i = 0; i < n; i++) { const dt = times[i] - meanT; stt += dt * dt; stv += dt * (values[i] - meanV); }
  const slope = stv / stt;
  let squares = 0, largest = 0;
  for (let i = 0; i < n; i++) {
    const r = values[i] - meanV - slope * (times[i] - meanT);
    squares += r * r; largest = Math.max(largest, Math.abs(r));
  }
  return { mean: meanV, slopePerS: slope, std: Math.sqrt(squares / n), maxAbsResidual: largest };
}

/** HIGHRES_IMU samples of a whole capture keyed by firmware time. */
function imuSamples(telemetry) {
  const samples = new Map();
  for (const line of telemetry.toString("utf8").split("\n")) {
    if (!line) continue;
    const m = JSON.parse(line).message;
    if (m.mavpackettype === "HIGHRES_IMU") samples.set(m.time_usec, AXES.map(([field]) => m[field]));
  }
  return samples;
}

/**
 * Counts samples present in both captures before `beforeS` and how many carry
 * identical values on every axis.
 */
export function compareSamples(telemetry, reference, beforeS) {
  const a = imuSamples(telemetry), b = imuSamples(reference);
  let compared = 0, identical = 0;
  for (const [time, values] of a) {
    const other = b.get(time);
    if (!other || time * 1e-6 >= beforeS) continue;
    compared++;
    if (values.every((value, i) => Object.is(value, other[i]))) identical++;
  }
  return { beforeS, compared, identical, inputSamples: a.size, referenceSamples: b.size };
}
/** Simulated time of a run's first driver command. */
function firstCommandS(run) {
  if (!Array.isArray(run.commands) || run.commands.length === 0 || !Number.isFinite(run.commands[0].timeS)) throw new Error("The capture has no driver command");
  return Math.min(...run.commands.map((command) => command.timeS));
}

export function assessCapture(directory, expect, referenceDirectory = null) {
  if (expect !== "ardupilot" && expect !== "off") throw new Error("--expect must be ardupilot or off");
  const read = (name) => {
    const file = join(directory, name);
    if (statSync(file).size > 64 * 1024 * 1024) throw new Error(`Capture exceeds file budget: ${name}`);
    return readFileSync(file);
  };
  const runBytes = read("run.json"), run = JSON.parse(runBytes.toString("utf8"));
  const trace = JSON.parse(read("flight.json").toString("utf8")), telemetry = read("telemetry.ndjson");
  if (run.status !== "captured" || trace.schemaVersion !== 2 || trace.provenance?.source !== "native-sitl") throw new Error("Not a completed native SITL capture");
  const arm = run.commands.find((command) => command.kind === "arm");
  if (!arm || !Number.isFinite(arm.timeS)) throw new Error("The capture has no arm command");
  const end = arm.timeS - ARM_MARGIN_S;
  if (end - WINDOW_START_S < MIN_WINDOW_S) throw new Error("The disarmed window is shorter than 10 s");
  const times = [], series = AXES.map(() => []);
  for (const line of telemetry.toString("utf8").split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line), m = event.message;
    if (m.mavpackettype !== "HIGHRES_IMU" || event.receivedSimS < WINDOW_START_S || event.receivedSimS > end) continue;
    // Firmware sample time, not the driver's receive time, orders the samples.
    times.push(m.time_usec * 1e-6);
    AXES.forEach(([field], i) => { if (!Number.isFinite(m[field])) throw new Error(`Non-finite ${field}`); series[i].push(m[field]); });
  }
  if (times.length < MIN_SAMPLES) throw new Error(`Only ${times.length} HIGHRES_IMU samples in the disarmed window`);
  const axes = {}, failures = [];
  AXES.forEach(([field, kind], i) => {
    const spread = detrendedSpread(times, series[i]);
    axes[field] = spread;
    const unit = kind === "accel" ? "m/s/s" : "rad/s";
    if (expect === "off") {
      const limit = kind === "accel" ? LIMITS.off.accelMaxStdMps2 : LIMITS.off.gyroMaxStdRadS;
      if (!(spread.std <= limit)) failures.push(`${field} residual ${spread.std} ${unit} exceeds ${limit}`);
    } else {
      const limit = kind === "accel" ? LIMITS.ardupilot.accelMinStdMps2 : LIMITS.ardupilot.gyroMinStdRadS;
      if (!(spread.std >= limit)) failures.push(`${field} residual ${spread.std} ${unit} is below ${limit}`);
    }
  });
  let reference = null;
  if (referenceDirectory !== null) {
    const other = readFileSync(join(referenceDirectory, "telemetry.ndjson"));
    const otherRun = JSON.parse(readFileSync(join(referenceDirectory, "run.json"), "utf8"));
    const beforeS = Math.min(firstCommandS(run), firstCommandS(otherRun));
    reference = { telemetrySha256: sha(other), ...compareSamples(telemetry, other, beforeS) };
    if (reference.compared < MIN_SAMPLES || reference.identical !== reference.compared) {
      failures.push(`${reference.compared - reference.identical} of ${reference.compared} HIGHRES_IMU samples differ from the reference`);
    }
  }
  return {
    schemaVersion: 1, kind: "imu-noise-floor", status: failures.length === 0 ? "PASS" : "FAIL", expect, reasons: failures, reference,
    scope: "Native ArduCopter SITL HIGHRES_IMU while disarmed on the synthetic quad; ArduPilot-added error only, not sensor fidelity",
    limits: LIMITS[expect], window: { startS: WINDOW_START_S, endS: end, samples: times.length }, axes,
    firmwareSha256: trace.provenance.firmwareSha256,
    validatorSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    artifacts: ["run.json", "flight.json", "telemetry.ndjson", "quad.parm", "firmware.log"].map((file) => ({ file, sha256: sha(read(file)) })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(JSON.stringify({ schemaVersion: 1, kind: "imu-noise-floor", status: "BLOCKED_EXTERNAL",
      reasons: ["Provide a native SITL capture: --input CAPTURE_DIRECTORY --expect ardupilot|off"] }));
    process.exitCode = 2;
  } else {
    try {
      const options = new Map();
      for (let i = 4; i + 1 < args.length; i += 2) options.set(args[i], args[i + 1]);
      if (args.length % 2 !== 0 || args[0] !== "--input" || args[2] !== "--expect" || options.size !== (args.length - 4) / 2 ||
          [...options.keys()].some((key) => key !== "--reference" && key !== "--output")) {
        throw new Error("Expected --input CAPTURE_DIRECTORY --expect ardupilot|off [--reference CAPTURE_DIRECTORY] [--output REPORT]");
      }
      const reference = options.get("--reference");
      const result = assessCapture(resolve(args[1]), args[3], reference === undefined ? null : resolve(reference));
      const outputPath = options.get("--output");
      const output = outputPath === undefined ? join(root, `test-results/validation/imu-noise-floor-${args[3]}.json`) : resolve(outputPath);
      writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
      console.log(`${result.status}: ${result.window.samples} samples; residual std ` +
        AXES.map(([field]) => `${field} ${result.axes[field].std.toExponential(3)}`).join(", ") +
        (result.reference ? `; ${result.reference.identical}/${result.reference.compared} samples identical to the reference` : ""));
      process.exitCode = result.status === "PASS" ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
