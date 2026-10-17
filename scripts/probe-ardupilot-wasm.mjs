import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256, report } from "./validation/evidence.mjs";
export function probeWasm(env = process.env) {
  const lock = JSON.parse(readFileSync(new URL("../native/ardupilot/source.lock.json", import.meta.url)));
  const emcc = spawnSync(env.MIRAGE_EMCC ?? "emcc", ["--version"], { encoding: "utf8", timeout: 10000 });
  const checks = { wasmRuntime: typeof WebAssembly.instantiate === "function", sharedMemory: typeof SharedArrayBuffer === "function", emscripten: emcc.status === 0,
    browserHal: false, scheduler: false, storage: false, network: false, license: false, nativeParity: false };
  const sources = [];
  if (env.MIRAGE_ARDUPILOT_SOURCE) for (const f of lock.files) {
    try {
      const bytes = readFileSync(`${env.MIRAGE_ARDUPILOT_SOURCE}/${f.path}`);
      sources.push({ path: f.path, sha256: sha256(bytes), matches: sha256(bytes) === f.sha256 });
    } catch { sources.push({ path: f.path, matches: false }); }
  }
  return { ...report("ardupilot-wasm-feasibility", "BLOCKED_EXTERNAL", ["No browser HAL/scheduler/storage/network port or native parity exists; POSIX SITL is not a browser artifact", ...(checks.emscripten ? [] : ["Emscripten compiler unavailable"])]), checks, sources, commit: lock.commit };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = probeWasm(); mkdirSync("test-results/validation", { recursive: true });
  writeFileSync("test-results/validation/ardupilot-wasm-feasibility.json", JSON.stringify(result, null, 2) + "\n");
  console.log(`ArduPilot WASM: ${result.status}`); process.exitCode = 2;
}
