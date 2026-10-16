// mirage-bet WASM loader (TASK-017). Validates the build manifest from
// unknown, selects the SIMD128 artifact only after feature detection (scalar
// is the mandatory baseline), verifies the artifact's SHA-256 and ABI version,
// instantiates outside any physics step, and reserves the memory budget up
// front so growth after arming is detectable. Any failure returns a result
// that blocks arming; nothing is retried or silently downgraded except the
// documented SIMD-to-scalar fallback.

export const EXPECTED_BET_ABI_VERSION = 1;
/** BET baseline arena budget (SPECS_SIMULATION_ENGINES section 4). */
export const BET_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;
const WASM_PAGE_BYTES = 65536;
export type BetVariant = 'scalar' | 'simd128';

export interface WasmArtifact { variant: BetVariant; file: string; sha256: string; bytes: number; targetFeatures: string[] }
export interface WasmManifest { schemaVersion: 1; crate: 'mirage-bet'; abiVersion: number; toolchain: string; artifacts: WasmArtifact[] }

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** Throws unless `value` is a well-formed manifest with a scalar artifact. */
export function parseWasmManifest(value: unknown): WasmManifest {
  if (!plain(value) || !exactKeys(value, ['schemaVersion', 'crate', 'abiVersion', 'toolchain', 'artifacts']) ||
    value.schemaVersion !== 1 || value.crate !== 'mirage-bet' || typeof value.toolchain !== 'string' ||
    typeof value.abiVersion !== 'number' || !Number.isInteger(value.abiVersion) || !Array.isArray(value.artifacts)) {
    throw new Error('Invalid WASM manifest');
  }
  const artifacts = (value.artifacts as unknown[]).map((entry): WasmArtifact => {
    if (!plain(entry) || !exactKeys(entry, ['variant', 'file', 'sha256', 'bytes', 'targetFeatures']) ||
      (entry.variant !== 'scalar' && entry.variant !== 'simd128') || typeof entry.file !== 'string' ||
      !/^[A-Za-z0-9_.-]+\.wasm$/.test(entry.file) || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      typeof entry.bytes !== 'number' || !Number.isInteger(entry.bytes) || entry.bytes <= 0 ||
      !Array.isArray(entry.targetFeatures) || !(entry.targetFeatures as unknown[]).every(feature => typeof feature === 'string')) {
      throw new Error('Invalid WASM manifest artifact');
    }
    return { variant: entry.variant, file: entry.file, sha256: entry.sha256, bytes: entry.bytes,
      targetFeatures: (entry.targetFeatures as string[]).slice() }; // elements checked to be strings above
  });
  if (!artifacts.some(artifact => artifact.variant === 'scalar')) throw new Error('WASM manifest has no scalar artifact');
  if (new Set(artifacts.map(artifact => artifact.variant)).size !== artifacts.length) throw new Error('Duplicate WASM artifact variant');
  return { schemaVersion: 1, crate: 'mirage-bet', abiVersion: value.abiVersion, toolchain: value.toolchain, artifacts };
}

/** Minimal module using v128 (i8x16.splat, i8x16.popcnt); validates only where SIMD128 is supported. */
const SIMD128_PROBE: Uint8Array<ArrayBuffer> = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
export function detectSimd128(
  validate: (bytes: Uint8Array<ArrayBuffer>) => boolean = bytes => WebAssembly.validate(bytes)): boolean {
  try { return validate(SIMD128_PROBE); } catch { return false; }
}

export interface BetExports {
  memory: WebAssembly.Memory;
  bet_abi_version(): number;
  bet_bootstrap_element_force(density: number, chord: number, dr: number, vx: number, vy: number, vz: number,
    erx: number, ery: number, erz: number, spin: number, cl: number, cd: number, axis: number): number;
}
export interface BetModule {
  variant: BetVariant; sha256: string; exports: BetExports;
  /** Memory size reserved before arming; any later growth is a fault. */
  reservedBytes: number;
  /** True while linear memory has not grown since load. */
  memoryStable(): boolean;
}
export type BetLoadResult = { ok: true; module: BetModule; fallback: boolean } | { ok: false; reason: string };

export interface LoadOptions {
  manifest: unknown;
  fetchBytes: (file: string) => Promise<Uint8Array>;
  /** Defaults to detectSimd128(). */
  simd128?: boolean;
  /** Linear memory to reserve before arming; at most BET_MEMORY_BUDGET_BYTES. */
  reserveBytes?: number;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}
function isFunction(value: unknown): value is (...args: number[]) => number {
  return typeof value === 'function';
}
function readExports(instance: WebAssembly.Instance): BetExports | null {
  const { memory, bet_abi_version: abi, bet_bootstrap_element_force: force } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || !isFunction(abi) || !isFunction(force)) return null;
  return { memory, bet_abi_version: abi, bet_bootstrap_element_force: force };
}

/** Loads and verifies the best supported artifact. Call during initialization, never inside a step. */
export async function loadBetModule(options: LoadOptions): Promise<BetLoadResult> {
  let manifest: WasmManifest;
  try { manifest = parseWasmManifest(options.manifest); } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Invalid WASM manifest' };
  }
  if (manifest.abiVersion !== EXPECTED_BET_ABI_VERSION) {
    return { ok: false, reason: `Manifest ABI ${manifest.abiVersion} does not match loader ABI ${EXPECTED_BET_ABI_VERSION}` };
  }
  const reserveBytes = options.reserveBytes ?? BET_MEMORY_BUDGET_BYTES;
  if (!Number.isInteger(reserveBytes) || reserveBytes <= 0 || reserveBytes > BET_MEMORY_BUDGET_BYTES) {
    return { ok: false, reason: `Memory reservation must be 1..${BET_MEMORY_BUDGET_BYTES} bytes` };
  }
  const wantSimd = options.simd128 ?? detectSimd128();
  const simd = manifest.artifacts.find(artifact => artifact.variant === 'simd128');
  const artifact = (wantSimd && simd) || manifest.artifacts.find(entry => entry.variant === 'scalar');
  if (!artifact) return { ok: false, reason: 'No loadable artifact' };
  let bytes: Uint8Array;
  try { bytes = await options.fetchBytes(artifact.file); } catch (error) {
    return { ok: false, reason: `Cannot fetch ${artifact.file}: ${error instanceof Error ? error.message : 'unknown error'}` };
  }
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes); // hash and compile the same snapshot
  if (copy.byteLength !== artifact.bytes) return { ok: false, reason: `${artifact.file} size ${copy.byteLength} != manifest ${artifact.bytes}` };
  const digest = hex(await crypto.subtle.digest('SHA-256', copy));
  if (digest !== artifact.sha256) return { ok: false, reason: `${artifact.file} SHA-256 mismatch` };
  let module: WebAssembly.Module;
  try { module = await WebAssembly.compile(copy); } catch (error) {
    return { ok: false, reason: `Invalid WASM: ${error instanceof Error ? error.message : 'compile failed'}` };
  }
  if (WebAssembly.Module.imports(module).length !== 0) return { ok: false, reason: 'BET module must not import host functions' };
  const instance = await WebAssembly.instantiate(module, {});
  const exports = readExports(instance);
  if (!exports) return { ok: false, reason: 'BET module is missing required exports' };
  const abi = exports.bet_abi_version();
  if (abi !== EXPECTED_BET_ABI_VERSION) return { ok: false, reason: `Module ABI ${abi} does not match loader ABI ${EXPECTED_BET_ABI_VERSION}` };
  // Reserve the budget now: growth after arming would detach views mid-step.
  const missing = Math.ceil((reserveBytes - exports.memory.buffer.byteLength) / WASM_PAGE_BYTES);
  try { if (missing > 0) exports.memory.grow(missing); } catch {
    return { ok: false, reason: 'Cannot reserve the BET memory budget' };
  }
  const reservedBytes = exports.memory.buffer.byteLength;
  if (reservedBytes > BET_MEMORY_BUDGET_BYTES) return { ok: false, reason: 'BET module memory exceeds the budget' };
  // Fallback: the scalar baseline was loaded although SIMD was requested or a SIMD artifact exists.
  return { ok: true, fallback: artifact.variant === 'scalar' && (wantSimd || simd !== undefined),
    module: { variant: artifact.variant, sha256: artifact.sha256, exports, reservedBytes,
      memoryStable: () => exports.memory.buffer.byteLength === reservedBytes } };
}
