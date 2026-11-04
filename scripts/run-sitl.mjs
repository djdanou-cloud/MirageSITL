import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readNativeExecutable } from "./sitl/native-binary.ts";
import { fileURLToPath } from "node:url";
import { sha256, hash, report, exact, finite, provenance, outputDirectory } from "./validation/evidence.mjs";
const pin = JSON.parse(readFileSync(new URL("./sitl.lock.json", import.meta.url)));
/** Own a single child only. Timeout/overflow wait for exit before releasing resources. */
export function runOwned(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000, maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid child limits");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const stdout = [], stderr = []; let size = 0, failed = null, killer;
    const terminate = signal => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        // ESRCH: the group is gone. EPERM: on macOS the group still exists with nothing alive in it, its members exited and not yet reaped.
        if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
      }
    };
    const stop = message => {
      if (failed) return;
      failed = new Error(message); terminate("SIGTERM");
      killer = setTimeout(() => terminate("SIGKILL"), 250);
    };
    const timer = setTimeout(() => stop("Owned process deadline exceeded"), timeoutMs);
    child.once("exit", () => {
      // An unexpectedly exited driver may leave descendants holding its pipes.
      // Reap only its dedicated POSIX group, including TERM-resistant children.
      if (process.platform !== "win32") {
        terminate("SIGTERM");
        killer ??= setTimeout(() => terminate("SIGKILL"), 250);
      }
    });
    child.once("error", error => { clearTimeout(timer); if (killer) clearTimeout(killer); reject(error); });
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on("data", bytes => {
      size += bytes.length;
      if (size > maxBytes) stop("Owned process output budget exceeded");
      else chunks.push(bytes);
    });
    child.once("close", code => {
      clearTimeout(timer); if (killer) clearTimeout(killer);
      // Closing pipes does not prove that a TERM-resistant descendant exited.
      // The child created its own POSIX group; finish reaping only that group.
      if (process.platform !== "win32") terminate("SIGKILL");
      if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`Owned process exited ${code}: ${Buffer.concat(stderr).toString().slice(0, 1024)}`));
      else resolve(Buffer.concat(stdout));
    });
  });
}
export function assessFlight(v) {
  exact(v, v?.schemaVersion === 2 ? ["schemaVersion", "physicsHz", "captureStride", "provenance", "samples"] : ["schemaVersion", "provenance", "samples"]);
  if (![1, 2].includes(v.schemaVersion) || !Array.isArray(v.samples) || v.samples.length < 4 || v.samples.length > 1000000) throw new Error("Missing real flight trace");
  provenance(v.provenance, "native-sitl");
  if (v.schemaVersion === 2 && (v.physicsHz !== 800 || v.captureStride !== 8)) throw new Error("Unsupported flight capture cadence");
  let previous = -1, stage = 0, holdStart = -1, holdEnd = -1, frames = 0;
  const firstFrame = v.schemaVersion === 2 ? v.samples[0].servoFrame : 0;
  const stages = ["arm", "takeoff", "hold", "land"];
  for (const s of v.samples) {
    const fields = ["timeS", "stage", "armed", "altitudeM", "mode", "ekfHealthy", "servoFrame", "pwmUs"];
    if (v.schemaVersion === 2) fields.push("heartbeatAgeS", "ekfAgeS", "ekfFlags", "innovationRatios", "autopilotAltitudeM", "altitudeAgeS");
    exact(s, fields);
    finite(s.timeS, 0); finite(s.altitudeM, -1, 100); finite(s.mode, 0, 0xffffffff);
    if (s.timeS <= previous || previous >= 0 && s.timeS - previous > .1 + 1e-9 || !Number.isSafeInteger(s.servoFrame) || s.servoFrame < 0 || s.servoFrame !== firstFrame + frames++ * (v.schemaVersion === 2 ? 8 : 1) ||
      !Array.isArray(s.pwmUs) || s.pwmUs.length !== 4 || !s.pwmUs.every(p => Number.isInteger(p) && p >= 1000 && p <= 2000) ||
      typeof s.armed !== "boolean" || s.ekfHealthy !== true) throw new Error("Invalid, stale or unhealthy closed-loop stream");
    if (v.schemaVersion === 2) {
      if (previous >= 0 && Math.abs(s.timeS - previous - v.captureStride / v.physicsHz) > 1e-9) throw new Error("Flight capture timing mismatch");
      for (const age of [s.heartbeatAgeS, s.ekfAgeS, s.altitudeAgeS]) finite(age, 0, 1);
      finite(s.autopilotAltitudeM, -1, 100);
      if (!Number.isInteger(s.ekfFlags) || s.ekfFlags < 0 || s.ekfFlags > 65535 || (s.ekfFlags & 55) !== 55 || (s.ekfFlags & 1024) ||
        !Array.isArray(s.innovationRatios) || s.innovationRatios.length !== 5 || !s.innovationRatios.every(r => Number.isFinite(r) && r >= 0 && r < 1)) throw new Error("Unhealthy autopilot EKF evidence");
    }
    previous = s.timeS;
    if (s.stage !== stages[stage]) { if (s.stage !== stages[stage + 1]) throw new Error("Flight stage skipped/reversed"); stage++; }
    if (s.mode !== pin.stageModes[s.stage]) throw new Error("Pinned flight mode mismatch");
    if (s.stage !== "land" && !s.armed) throw new Error("Unexpected disarm before landing");
    if (s.stage === "takeoff" && s.altitudeM < pin.takeoffMinAltitudeM) throw new Error("Takeoff altitude gate failed");
    if (s.stage === "hold") {
      if (holdStart < 0) holdStart = s.timeS;
      holdEnd = s.timeS;
      if (Math.abs(s.altitudeM - pin.holdAltitudeM) > pin.holdErrorM) throw new Error("Altitude hold envelope failed");
      if (v.schemaVersion === 2 && Math.abs(s.autopilotAltitudeM - pin.holdAltitudeM) > pin.holdErrorM) throw new Error("Autopilot altitude hold envelope failed");
    }
  }
  const last = v.samples.at(-1);
  if (stage !== 3 || holdEnd - holdStart < pin.holdDurationS || last.armed || last.altitudeM > pin.landMaxAltitudeM) throw new Error("Incomplete arm/takeoff/hold/land flight");
  return report("sitl-report", "PASS", [], { frames, holdDurationS: holdEnd - holdStart });
}
export async function runSitl(env = process.env) {
  if (!env.MIRAGE_SITL_BINARY || !env.MIRAGE_SITL_SOURCE || !env.MIRAGE_SITL_DRIVER || !hash(env.MIRAGE_SITL_BINARY_SHA256) || !hash(env.MIRAGE_SITL_DRIVER_SHA256))
    return report("sitl-report", "BLOCKED_EXTERNAL", ["Provide pinned clean ArduPilot source, host-native executable+SHA-256, and closed-loop driver+SHA-256"]);
  if (process.platform !== "linux" && process.platform !== "darwin") return report("sitl-report", "BLOCKED_EXTERNAL", ["Native SITL requires macOS or Linux"]);
  // TASK-089 setting, read by the driver: 'ardupilot' (default) or 'off', which needs the imu-noise-floor patch.
  const imuNoiseFloor = env.MIRAGE_SITL_IMU_NOISE_FLOOR ?? "ardupilot";
  if (imuNoiseFloor !== "ardupilot" && imuNoiseFloor !== "off") throw new Error("MIRAGE_SITL_IMU_NOISE_FLOOR must be ardupilot or off");
  const source = resolve(env.MIRAGE_SITL_SOURCE);
  const binaryPath = resolve(env.MIRAGE_SITL_BINARY), driverPath = resolve(env.MIRAGE_SITL_DRIVER);
  if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim() !== pin.commit ||
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source, encoding: "utf8" }).trim()) throw new Error("ArduPilot source pin/cleanliness mismatch");
  const { bytes: binary } = readNativeExecutable(binaryPath);
  const driver = readFileSync(driverPath);
  if (sha256(binary) !== env.MIRAGE_SITL_BINARY_SHA256 || sha256(driver) !== env.MIRAGE_SITL_DRIVER_SHA256) throw new Error("Native executable or driver hash mismatch");
  const cwd = mkdtempSync(join(tmpdir(), "mirage-sitl-run-"));
  try {
    // Driver owns its firmware/bridge children and must return only after cleanup.
    // A driver is trusted local executable code, not a remotely downloaded plugin.
    const output = await runOwned(process.execPath, [driverPath, "--binary", binaryPath, "--parameters", fileURLToPath(new URL("../tests/fixtures/sitl/parameters.parm", import.meta.url))],
      { cwd, env: { ...env, MIRAGE_SITL_SOURCE: source, MIRAGE_SITL_IMU_NOISE_FLOOR: imuNoiseFloor } });
    const trace = JSON.parse(output);
    if (trace.schemaVersion !== 2) throw new Error("Native flight driver must provide trace v2 telemetry evidence");
    if (trace.provenance?.firmwareSha256 !== env.MIRAGE_SITL_BINARY_SHA256) throw new Error("Driver firmware identity mismatch");
    // A passing 'off' flight implies the driver confirmed both floor parameters before arming.
    const result = assessFlight(trace); result.inputSha256 = sha256(output); result.imuNoiseFloor = imuNoiseFloor; return result;
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // --out DIR writes sitl-report.json there; without it the run replaces the committed report.
  const directory = outputDirectory("test-results/validation");
  let result;
  try { result = await runSitl(); } catch (error) { result = report("sitl-report", "FAIL", [error.message]); }
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "sitl-report.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`SITL: ${result.status}`); process.exitCode = result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
}
