import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256, report } from "./validation/evidence.mjs";
/** Runs `<compiler> --version`; Windows .bat/.cmd wrappers (emsdk's emcc.bat) need cmd.exe. */
function compilerVersion(path) {
  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(path))
    return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${path}" --version`], { encoding: "utf8", timeout: 30000, windowsVerbatimArguments: true });
  return spawnSync(path, ["--version"], { encoding: "utf8", timeout: 30000 });
}
export function probeWasm(env = process.env) {
  const lock = JSON.parse(readFileSync(new URL("../native/ardupilot/source.lock.json", import.meta.url)));
  const emcc = compilerVersion(env.MIRAGE_EMCC ?? "emcc");
  const checks = { wasmRuntime: typeof WebAssembly.instantiate === "function", sharedMemory: typeof SharedArrayBuffer === "function", emscripten: emcc.status === 0,
    browserHal: false, scheduler: false, storage: false, network: false, license: false, nativeParity: false };
  const sources = [];
  if (env.MIRAGE_ARDUPILOT_SOURCE) for (const f of lock.files) {
    try {
      const bytes = readFileSync(`${env.MIRAGE_ARDUPILOT_SOURCE}/${f.path}`);
      sources.push({ path: f.path, sha256: sha256(bytes), matches: sha256(bytes) === f.sha256 });
    } catch { sources.push({ path: f.path, matches: false }); }
  }
  const emscriptenVersion = checks.emscripten ? (/\b(\d+\.\d+\.\d+)\b/.exec(emcc.stdout ?? "")?.[1] ?? null) : null;
  return { ...report("ardupilot-wasm-feasibility", "BLOCKED_EXTERNAL", ["Upstream wasm board builds and boots (TASK-045), but MirageSITL browser Worker integration, persistent storage, physics/time coupling (TASK-046), GPL review and native parity (TASK-047) are absent", ...(checks.emscripten ? [] : ["Emscripten compiler unavailable"])]), checks, emscriptenVersion, sources, commit: lock.commit };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = probeWasm(); mkdirSync("test-results/validation", { recursive: true });
  writeFileSync("test-results/validation/ardupilot-wasm-feasibility.json", JSON.stringify(result, null, 2) + "\n");
  console.log(`ArduPilot WASM: ${result.status}`); process.exitCode = 2;
}
