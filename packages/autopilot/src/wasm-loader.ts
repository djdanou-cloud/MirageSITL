// ArduPilot WebAssembly artifact admission (TASK-045).
//
// The firmware is ArduPilot's upstream `wasm` board (AP_HAL_SITL with
// HAL_SITL_WASM_ENABLED) built by scripts/build-ardupilot-wasm.mjs. It is an
// Emscripten ES module plus its .wasm, using pthreads (shared memory, a
// Worker pool) and exporting a byte bridge for SITL serial ports. This module
// validates the build manifest from unknown, then checks an artifact pair
// against it before anything is instantiated: SHA-256 and size of both files,
// required exports, the allowed import modules, and the shared memory limits
// against a memory budget. It never instantiates, retries or downgrades;
// running the firmware (TASK-046) needs the Emscripten glue in a Worker.
//
// SHA-256 uses Web Crypto, so the same code runs in a Worker and in Node.

const WASM_PAGE_BYTES = 65536;
/** Exports the MirageSITL host needs from the firmware (serial bridge and allocator). */
export const REQUIRED_ARDUPILOT_EXPORTS = [
  "ardupilot_serial_write",
  "ardupilot_serial_read",
  "ardupilot_serial_read_available",
  "ardupilot_malloc",
  "ardupilot_free",
] as const;
/** Import modules an Emscripten pthread build may use; anything else is rejected. */
export const ALLOWED_ARDUPILOT_IMPORT_MODULES = ["env", "wasi_snapshot_preview1"] as const;
/** Default ceiling for the firmware's shared memory: the upstream 2 GiB growth limit. */
export const ARDUPILOT_MEMORY_BUDGET_BYTES = 2048 * 1024 * 1024;

export interface ArtifactFile { file: string; sha256: string; bytes: number }
export interface ArdupilotWasmManifest {
  schemaVersion: 1;
  firmware: "ArduCopter";
  board: "wasm";
  sourceCommit: string;
  emscriptenVersion: string;
  module: ArtifactFile;
  glue: ArtifactFile;
  requiredExports: readonly string[];
  memory: { shared: true; initialPages: number; maximumPages: number };
  license: string;
  distribution: "local-only-pending-gpl-review" | "redistributable";
}

export interface MemoryLimits { module: string; name: string; shared: boolean; initialPages: number; maximumPages: number | null }
export type AdmissionResult =
  | { ok: true; module: WebAssembly.Module; memory: MemoryLimits; exports: readonly string[] }
  | { ok: false; reason: string };

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function artifact(value: unknown, extension: string, what: string): ArtifactFile {
  if (!plain(value) || !exactKeys(value, ["file", "sha256", "bytes"]) || typeof value.file !== "string" ||
    !new RegExp(`^[A-Za-z0-9_.-]+\\.${extension}$`).test(value.file) || typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256) || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    throw new Error(`Invalid ArduPilot WASM manifest ${what}`);
  }
  return { file: value.file, sha256: value.sha256, bytes: value.bytes };
}

/** Throws unless `value` is a well-formed ArduPilot WASM build manifest. */
export function parseArdupilotWasmManifest(value: unknown): ArdupilotWasmManifest {
  const keys = ["schemaVersion", "firmware", "board", "sourceCommit", "emscriptenVersion", "module", "glue", "requiredExports", "memory", "license", "distribution"];
  if (!plain(value) || !exactKeys(value, keys) || value.schemaVersion !== 1 || value.firmware !== "ArduCopter" || value.board !== "wasm" ||
    typeof value.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.sourceCommit) ||
    typeof value.emscriptenVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.emscriptenVersion) ||
    typeof value.license !== "string" || !value.license ||
    (value.distribution !== "local-only-pending-gpl-review" && value.distribution !== "redistributable")) {
    throw new Error("Invalid ArduPilot WASM manifest");
  }
  const exportsValue = value.requiredExports;
  if (!Array.isArray(exportsValue) || exportsValue.length === 0 || exportsValue.length > 64) throw new Error("Invalid ArduPilot WASM manifest exports");
  const requiredExports = exportsValue.map((name: unknown) => {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error("Invalid ArduPilot WASM manifest exports");
    return name;
  });
  for (const name of REQUIRED_ARDUPILOT_EXPORTS) if (!requiredExports.includes(name)) throw new Error(`ArduPilot WASM manifest omits ${name}`);
  const memory = value.memory;
  if (!plain(memory) || !exactKeys(memory, ["shared", "initialPages", "maximumPages"]) || memory.shared !== true ||
    typeof memory.initialPages !== "number" || typeof memory.maximumPages !== "number" ||
    !Number.isInteger(memory.initialPages) || !Number.isInteger(memory.maximumPages) ||
    memory.initialPages < 1 || memory.maximumPages < memory.initialPages || memory.maximumPages > 65536) {
    throw new Error("Invalid ArduPilot WASM manifest memory");
  }
  return {
    schemaVersion: 1, firmware: "ArduCopter", board: "wasm", sourceCommit: value.sourceCommit, emscriptenVersion: value.emscriptenVersion,
    module: artifact(value.module, "wasm", "module"), glue: artifact(value.glue, "js", "glue"), requiredExports,
    memory: { shared: true, initialPages: memory.initialPages, maximumPages: memory.maximumPages },
    license: value.license, distribution: value.distribution,
  };
}

/** Reads the limits of the imported memory from the import section (the JS API does not expose them). */
export function readMemoryImport(bytes: Uint8Array): MemoryLimits | null {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error("Not a WebAssembly binary");
  let p = 8;
  const byte = (): number => {
    const b = bytes[p++];
    if (b === undefined) throw new Error("Truncated WebAssembly binary");
    return b;
  };
  const leb = (): number => {
    let result = 0, shift = 0, b: number;
    do {
      b = byte();
      if (shift > 28) throw new Error("Oversized LEB128");
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return result;
  };
  const name = (): string => {
    const n = leb(), s = new TextDecoder().decode(bytes.subarray(p, p + n));
    p += n;
    return s;
  };
  while (p < bytes.length) {
    const id = byte(), size = leb(), end = p + size;
    if (end > bytes.length) throw new Error("Truncated WebAssembly section");
    if (id === 2) {
      const count = leb();
      for (let i = 0; i < count; i++) {
        const module = name(), field = name(), kind = byte();
        if (kind === 0) leb();
        else if (kind === 1) { byte(); const flags = byte(); leb(); if (flags & 1) leb(); }
        else if (kind === 2) {
          const flags = byte(), initialPages = leb(), maximumPages = flags & 1 ? leb() : null;
          return { module, name: field, shared: (flags & 2) !== 0, initialPages, maximumPages };
        } else if (kind === 3) { byte(); byte(); }
        else if (kind === 4) { byte(); leb(); }
        else throw new Error(`Unknown import kind ${kind}`);
      }
      return null;
    }
    p = end;
  }
  return null;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Checks an artifact pair against its manifest without instantiating it.
 * Every failure is a reason string that keeps the WASM autopilot mode disabled.
 */
export async function admitArdupilotWasm(
  wasm: Uint8Array<ArrayBuffer>, glue: Uint8Array<ArrayBuffer>, manifest: ArdupilotWasmManifest,
  memoryBudgetBytes = ARDUPILOT_MEMORY_BUDGET_BYTES,
): Promise<AdmissionResult> {
  if (wasm.length !== manifest.module.bytes) return { ok: false, reason: "module size differs from manifest" };
  if (glue.length !== manifest.glue.bytes) return { ok: false, reason: "glue size differs from manifest" };
  if (await sha256Hex(wasm) !== manifest.module.sha256) return { ok: false, reason: "module SHA-256 differs from manifest" };
  if (await sha256Hex(glue) !== manifest.glue.sha256) return { ok: false, reason: "glue SHA-256 differs from manifest" };
  let module: WebAssembly.Module;
  try { module = await WebAssembly.compile(wasm); } catch (error) {
    return { ok: false, reason: `module does not compile: ${error instanceof Error ? error.message : String(error)}` };
  }
  const exports = WebAssembly.Module.exports(module).map(e => e.name);
  for (const name of manifest.requiredExports) if (!exports.includes(name)) return { ok: false, reason: `missing export ${name}` };
  const allowed: readonly string[] = ALLOWED_ARDUPILOT_IMPORT_MODULES;
  for (const entry of WebAssembly.Module.imports(module)) if (!allowed.includes(entry.module)) return { ok: false, reason: `unexpected import module ${entry.module}` };
  const memory = readMemoryImport(wasm);
  if (!memory || memory.module !== "env" || memory.name !== "memory") return { ok: false, reason: "module does not import env.memory" };
  if (!memory.shared) return { ok: false, reason: "imported memory is not shared (pthread build expected)" };
  if (memory.maximumPages === null) return { ok: false, reason: "imported memory has no maximum" };
  if (memory.initialPages !== manifest.memory.initialPages || memory.maximumPages !== manifest.memory.maximumPages)
    return { ok: false, reason: "memory limits differ from manifest" };
  if (memory.maximumPages * WASM_PAGE_BYTES > memoryBudgetBytes) return { ok: false, reason: "memory maximum exceeds the budget" };
  return { ok: true, module, memory, exports };
}
