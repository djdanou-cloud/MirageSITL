// Boot smoke for the ArduPilot WASM artifact (TASK-045). Admits the artifact
// pair against its manifest (hashes, exports, shared-memory limits), boots it
// in Node with the firmware's built-in quad model and serial0 on the wasm byte
// bridge (serial1/2 off: their TCP sockets do not exist here), and requires at
// least MIN_HEARTBEATS well-formed MAVLink2 HEARTBEAT frames from one system.
// This proves the firmware runs; it is not browser Worker, HAL, physics-
// coupling or flight evidence (TASK-046/047).
//
//   node scripts/smoke-ardupilot-wasm.mjs DIR   (DIR holds manifest.json, arducopter.js, arducopter.wasm)
// Exit: 0 pass, 1 failed, 2 artifact missing (BLOCKED_EXTERNAL).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { admitArdupilotWasm, parseArdupilotWasmManifest } from "../packages/autopilot/src/wasm-loader.ts";

export const MIN_HEARTBEATS = 3;
export const WINDOW_MS = 20000;
const BOOT_ARGUMENTS = ["--model", "quad", "--serial0", "wasm", "--serial1", "none", "--serial2", "none"];

/** Counts MAVLink2 frames by message id in a byte stream (no CRC check: lengths and framing only). */
export function scanMavlink2(bytes) {
  const counts = new Map(), systems = new Set();
  let frames = 0;
  for (let i = 0; i + 12 <= bytes.length; ) {
    if (bytes[i] !== 0xfd) { i++; continue; }
    const len = bytes[i + 1], total = 12 + len + (bytes[i + 2] & 1 ? 13 : 0);
    if (i + total > bytes.length) break;
    const msgid = bytes[i + 7] | (bytes[i + 8] << 8) | (bytes[i + 9] << 16);
    if (msgid === 0 && len >= 1 && len <= 9) systems.add(bytes[i + 5]);
    counts.set(msgid, (counts.get(msgid) ?? 0) + 1);
    frames++;
    i += total;
  }
  return { frames, heartbeats: counts.get(0) ?? 0, systems: [...systems], messageIds: [...counts.keys()].sort((a, b) => a - b) };
}

export async function smoke(dir, windowMs = WINDOW_MS) {
  const manifest = parseArdupilotWasmManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const wasm = new Uint8Array(readFileSync(join(dir, manifest.module.file)));
  const glue = new Uint8Array(readFileSync(join(dir, manifest.glue.file)));
  const admission = await admitArdupilotWasm(wasm, glue, manifest);
  if (!admission.ok) return { status: "failed", reason: admission.reason, manifest };
  const output = [];
  const factory = (await import(pathToFileURL(join(dir, manifest.glue.file)).href)).default;
  const module = await factory({ arguments: BOOT_ARGUMENTS, print: (t) => output.push(t), printErr: (t) => output.push(t) });
  const buffer = module._ardupilot_malloc(4096), bytes = [];
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    await new Promise((r) => setTimeout(r, 25));
    const n = module._ardupilot_serial_read(0, buffer, 4096);
    for (let i = 0; i < n; i++) bytes.push(module.HEAPU8[buffer + i]);
  }
  const scan = scanMavlink2(bytes);
  const banner = Buffer.from(bytes.slice(0, 200)).toString("latin1").match(/Init ArduCopter [^\n]+/)?.[0] ?? null;
  const passed = scan.heartbeats >= MIN_HEARTBEATS && scan.systems.length === 1;
  return {
    status: passed ? "pass" : "failed",
    reason: passed ? null : `expected >= ${MIN_HEARTBEATS} HEARTBEATs from one system, saw ${scan.heartbeats} from ${scan.systems.length}`,
    manifest, windowMs, serialBytes: bytes.length, banner, ...scan,
    memory: admission.memory, firmwareOutput: output.slice(0, 40),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir || !existsSync(join(dir, "manifest.json"))) {
    console.error("BLOCKED_EXTERNAL: pass a directory with manifest.json, arducopter.js and arducopter.wasm (scripts/build-ardupilot-wasm.mjs)");
    process.exit(2);
  }
  const report = await smoke(resolve(dir));
  mkdirSync("test-results/validation", { recursive: true });
  writeFileSync("test-results/validation/ardupilot-wasm-smoke.json", JSON.stringify(report, null, 2) + "\n");
  console.log(`ArduPilot WASM smoke: ${report.status}; heartbeats=${report.heartbeats ?? 0}; frames=${report.frames ?? 0}; ${report.banner ?? report.reason}`);
  // Emscripten pthread workers keep the event loop alive; exit explicitly.
  process.exit(report.status === "pass" ? 0 : 1);
}
