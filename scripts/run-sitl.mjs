import { spawn, execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, hash, report, exact, finite, provenance } from "./validation/evidence.mjs";
const pin = JSON.parse(readFileSync(new URL("./sitl.lock.json", import.meta.url)));
/** Own a single child only. Timeout/overflow wait for exit before releasing resources. */
export function runOwned(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000, maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid child limits");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const stdout = [], stderr = []; let size = 0, failed = null, killer;
    const terminate = signal => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const stop = message => {
      if (failed) return;
      failed = new Error(message); terminate("SIGTERM");
      killer = setTimeout(() => terminate("SIGKILL"), 250);
    };
    const timer = setTimeout(() => stop("Owned process deadline exceeded"), timeoutMs);
    child.once("error", error => { clearTimeout(timer); if (killer) clearTimeout(killer); reject(error); });
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on("data", bytes => {
      size += bytes.length;
      if (size > maxBytes) stop("Owned process output budget exceeded");
      else chunks.push(bytes);
    });
    child.once("close", code => {
      clearTimeout(timer); if (killer) clearTimeout(killer);
      if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`Owned process exited ${code}: ${Buffer.concat(stderr).toString().slice(0, 1024)}`));
      else resolve(Buffer.concat(stdout));
    });
  });
}
export function assessFlight(v) {
  exact(v, ["schemaVersion", "provenance", "samples"]);
  if (v.schemaVersion !== 1 || !Array.isArray(v.samples) || v.samples.length < 4 || v.samples.length > 1000000) throw new Error("Missing real flight trace");
  provenance(v.provenance, "native-sitl");
  let previous = -1, stage = 0, holdStart = -1, holdEnd = -1, frames = 0;
  const stages = ["arm", "takeoff", "hold", "land"];
  for (const s of v.samples) {
    exact(s, ["timeS", "stage", "armed", "altitudeM", "mode", "ekfHealthy", "servoFrame", "pwmUs"]);
    finite(s.timeS, 0); finite(s.altitudeM, -1, 100); finite(s.mode, 0, 0xffffffff);
    if (s.timeS <= previous || previous >= 0 && s.timeS - previous > .1 + 1e-9 || !Number.isInteger(s.servoFrame) || s.servoFrame !== frames++ ||
      !Array.isArray(s.pwmUs) || s.pwmUs.length !== 4 || !s.pwmUs.every(p => Number.isInteger(p) && p >= 1000 && p <= 2000) ||
      typeof s.armed !== "boolean" || s.ekfHealthy !== true) throw new Error("Invalid, stale or unhealthy closed-loop stream");
    previous = s.timeS;
    if (s.stage !== stages[stage]) { if (s.stage !== stages[stage + 1]) throw new Error("Flight stage skipped/reversed"); stage++; }
    if (s.mode !== pin.stageModes[s.stage]) throw new Error("Pinned flight mode mismatch");
    if (s.stage !== "land" && !s.armed) throw new Error("Unexpected disarm before landing");
    if (s.stage === "takeoff" && s.altitudeM < pin.takeoffMinAltitudeM) throw new Error("Takeoff altitude gate failed");
    if (s.stage === "hold") {
      if (holdStart < 0) holdStart = s.timeS;
      holdEnd = s.timeS;
      if (Math.abs(s.altitudeM - pin.holdAltitudeM) > pin.holdErrorM) throw new Error("Altitude hold envelope failed");
    }
  }
  const last = v.samples.at(-1);
  if (stage !== 3 || holdEnd - holdStart < pin.holdDurationS || last.armed || last.altitudeM > pin.landMaxAltitudeM) throw new Error("Incomplete arm/takeoff/hold/land flight");
  return report("sitl-report", "PASS", [], { frames, holdDurationS: holdEnd - holdStart });
}
export async function runSitl(env = process.env) {
  if (!env.MIRAGE_SITL_BINARY || !env.MIRAGE_SITL_SOURCE || !env.MIRAGE_SITL_DRIVER || !hash(env.MIRAGE_SITL_BINARY_SHA256) || !hash(env.MIRAGE_SITL_DRIVER_SHA256))
    return report("sitl-report", "BLOCKED_EXTERNAL", ["Provide pinned clean ArduPilot source, ELF binary+SHA-256, and closed-loop driver+SHA-256; production physics/RC driver is not supplied by the demo"]);
  const source = env.MIRAGE_SITL_SOURCE;
  if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim() !== pin.commit ||
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source, encoding: "utf8" }).trim()) throw new Error("ArduPilot source pin/cleanliness mismatch");
  const binary = readFileSync(env.MIRAGE_SITL_BINARY), driver = readFileSync(env.MIRAGE_SITL_DRIVER);
  if (binary.subarray(0, 4).toString("hex") !== "7f454c46" || sha256(binary) !== env.MIRAGE_SITL_BINARY_SHA256 || sha256(driver) !== env.MIRAGE_SITL_DRIVER_SHA256) throw new Error("Missing real pinned ELF or driver hash mismatch");
  const cwd = mkdtempSync(join(tmpdir(), "mirage-sitl-run-"));
  try {
    // Driver owns its firmware/bridge children and must return only after cleanup.
    // A driver is trusted local executable code, not a remotely downloaded plugin.
    const output = await runOwned(process.execPath, [env.MIRAGE_SITL_DRIVER, "--binary", env.MIRAGE_SITL_BINARY, "--parameters", fileURLToPath(new URL("../tests/fixtures/sitl/parameters.parm", import.meta.url))], { cwd });
    const trace = JSON.parse(output);
    if (trace.provenance?.firmwareSha256 !== env.MIRAGE_SITL_BINARY_SHA256) throw new Error("Driver firmware identity mismatch");
    const result = assessFlight(trace); result.inputSha256 = sha256(output); return result;
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let result;
  try { result = await runSitl(); } catch (error) { result = report("sitl-report", "FAIL", [error.message]); }
  mkdirSync("test-results/validation", { recursive: true });
  writeFileSync("test-results/validation/sitl-report.json", JSON.stringify(result, null, 2) + "\n");
  console.log(`SITL: ${result.status}`); process.exitCode = result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
}
