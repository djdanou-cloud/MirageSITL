// TASK-045: ArduPilot WASM artifact admission. Synthetic modules exercise every
// admission rule; the real artifact (GPL, not committed) is checked against the
// committed manifest when MIRAGE_ARDUPILOT_WASM_DIR points at a build output.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  admitArdupilotWasm, ARDUPILOT_MEMORY_BUDGET_BYTES, parseArdupilotWasmManifest, readMemoryImport,
  REQUIRED_ARDUPILOT_EXPORTS, type ArdupilotWasmManifest,
} from "../packages/autopilot/src/wasm-loader.ts";
import { nodeCheck } from "./support/node-evidence";

const committed: unknown = JSON.parse(readFileSync(new URL("../native/ardupilot/wasm-artifact.manifest.json", import.meta.url), "utf8"));
const lock: unknown = JSON.parse(readFileSync(new URL("../native/ardupilot/toolchain.lock.json", import.meta.url), "utf8"));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function pick(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) current = record(current) && Object.hasOwn(current, key) ? current[key] : undefined;
  return current;
}
const uleb = (n: number): number[] => { const out: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const str = (s: string): number[] => [...uleb(s.length), ...new TextEncoder().encode(s)];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

/** Minimal module importing a memory and exporting empty functions. */
function syntheticModule(o: { exports?: readonly string[]; shared?: boolean; maxPages?: number | null; importModule?: string } = {}): Uint8Array<ArrayBuffer> {
  const names = o.exports ?? REQUIRED_ARDUPILOT_EXPORTS, shared = o.shared ?? true, max = o.maxPages === undefined ? 4 : o.maxPages;
  const flags = (max === null ? 0 : 1) | (shared ? 2 : 0);
  const limits = [flags, ...uleb(2), ...(max === null ? [] : uleb(max))];
  const imports = [1, ...str(o.importModule ?? "env"), ...str("memory"), 2, ...limits];
  const bytes = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(2, imports),
    ...section(3, [...uleb(names.length), ...names.map(() => 0)]),
    ...section(7, [...uleb(names.length), ...names.flatMap((n, i) => [...str(n), 0, ...uleb(i)])]),
    ...section(10, [...uleb(names.length), ...names.flatMap(() => [2, 0, 0x0b])])];
  return new Uint8Array(bytes);
}
function manifestFor(wasm: Uint8Array, glue: Uint8Array, maxPages = 4): ArdupilotWasmManifest {
  return parseArdupilotWasmManifest({
    schemaVersion: 1, firmware: "ArduCopter", board: "wasm", sourceCommit: "8ab6afde107a91df1b5f60ade8f333cb8a61b190", emscriptenVersion: "4.0.15",
    module: { file: "arducopter.wasm", sha256: sha(wasm), bytes: wasm.length }, glue: { file: "arducopter.js", sha256: sha(glue), bytes: glue.length },
    requiredExports: [...REQUIRED_ARDUPILOT_EXPORTS], memory: { shared: true, initialPages: 2, maximumPages: maxPages },
    license: "GPL-3.0-or-later", distribution: "local-only-pending-gpl-review",
  });
}
const glue = new TextEncoder().encode("export default async () => ({});\n");

describe("ArduPilot WASM manifest", () => {
  it("records the pinned source, toolchain and a bounded shared memory", () => {
    const m = parseArdupilotWasmManifest(committed);
    expect(m.sourceCommit).toBe(pick(lock, "ardupilot", "commit"));
    expect(m.emscriptenVersion).toBe(pick(lock, "emsdk", "version"));
    expect(m.memory).toEqual({ shared: true, initialPages: 256, maximumPages: 32768 });
    expect(m.memory.maximumPages * 65536).toBeLessThanOrEqual(ARDUPILOT_MEMORY_BUDGET_BYTES);
    expect(m.distribution).toBe("local-only-pending-gpl-review");
  });
  it("rejects malformed manifests", () => {
    const base = record(committed) ? committed : {};
    for (const change of [{ board: "sitl" }, { sourceCommit: "abc" }, { requiredExports: ["ardupilot_serial_read"] },
      { memory: { shared: false, initialPages: 256, maximumPages: 32768 } }, { module: { file: "x.js", sha256: "0".repeat(64), bytes: 1 } }, { extra: 1 }])
      expect(() => parseArdupilotWasmManifest({ ...base, ...change })).toThrow();
  });
});

describe("ArduPilot WASM admission", () => {
  it("admits a module that matches hashes, exports and memory limits", async () => {
    const wasm = syntheticModule();
    expect(readMemoryImport(wasm)).toEqual({ module: "env", name: "memory", shared: true, initialPages: 2, maximumPages: 4 });
    const result = await admitArdupilotWasm(wasm, glue, manifestFor(wasm, glue));
    expect(result.ok).toBe(true);
  });
  it.each([
    ["a different module than the manifest names", () => ({ w: syntheticModule({ exports: [...REQUIRED_ARDUPILOT_EXPORTS, "extra"] }), m: manifestFor(syntheticModule(), glue) }), "module size differs"],
    ["a same-size module with different bytes", () => { const w = syntheticModule({ exports: ["ardupilot_serial_write", "ardupilot_serial_reaX", "ardupilot_serial_read_available", "ardupilot_malloc", "ardupilot_free"] }); return { w, m: manifestFor(syntheticModule(), glue) }; }, "module SHA-256 differs"],
    ["a missing export", () => { const w = syntheticModule({ exports: REQUIRED_ARDUPILOT_EXPORTS.slice(1) }); return { w, m: manifestFor(w, glue) }; }, "missing export ardupilot_serial_write"],
    ["unshared memory", () => { const w = syntheticModule({ shared: false }); return { w, m: manifestFor(w, glue) }; }, "not shared"],
    ["a foreign import module", () => { const w = syntheticModule({ importModule: "evil" }); return { w, m: manifestFor(w, glue) }; }, "unexpected import module evil"],
    ["limits that differ from the manifest", () => { const w = syntheticModule({ maxPages: 8 }); return { w, m: manifestFor(w, glue, 4) }; }, "memory limits differ"],
  ] as const)("rejects %s", async (_label, make, reason) => {
    const { w, m } = make();
    const result = await admitArdupilotWasm(w, glue, m);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
  it("rejects a memory maximum above the budget and a changed glue file", async () => {
    const wasm = syntheticModule(), m = manifestFor(wasm, glue);
    expect(await admitArdupilotWasm(wasm, glue, m, 3 * 65536)).toEqual({ ok: false, reason: "memory maximum exceeds the budget" });
    const other = new TextEncoder().encode("export default async () => ([]);\n"); // same length, different bytes
    expect(await admitArdupilotWasm(wasm, other, m)).toEqual({ ok: false, reason: "glue SHA-256 differs from manifest" });
  });
});

it("decodes MAVLink2 HEARTBEAT framing in the smoke scanner", () => nodeCheck(`
import {scanMavlink2} from './scripts/smoke-ardupilot-wasm.mjs';
const hb = (seq, sys) => [0xfd, 9, 0, 0, seq, sys, 1, 0, 0, 0, ...new Array(9).fill(0), 0xaa, 0xbb];
const signed = [0xfd, 9, 1, 0, 9, 1, 1, 111, 0, 0, ...new Array(9).fill(0), 1, 2, ...new Array(13).fill(7)];
const r = scanMavlink2([0x0a, 0x41, ...hb(0, 1), ...hb(1, 1), ...signed, ...hb(2, 1), 0xfd, 9]);
assert.deepEqual(r, {frames: 4, heartbeats: 3, systems: [1], messageIds: [0, 111]});
assert.equal(scanMavlink2([...hb(0, 1), ...hb(1, 2)]).systems.length, 2);
`));

const dir = process.env.MIRAGE_ARDUPILOT_WASM_DIR;
describe.skipIf(dir === undefined || !existsSync(join(dir ?? ".", "arducopter.wasm")))("real ArduCopter WASM artifact (MIRAGE_ARDUPILOT_WASM_DIR)", () => {
  it("matches the committed manifest and boots to MAVLink HEARTBEATs", async () => {
    const root = dir ?? ".", m = parseArdupilotWasmManifest(committed);
    const result = await admitArdupilotWasm(new Uint8Array(readFileSync(join(root, m.module.file))), new Uint8Array(readFileSync(join(root, m.glue.file))), m);
    expect(result.ok).toBe(true);
    const run = spawnSync(process.execPath, ["scripts/smoke-ardupilot-wasm.mjs", root], { encoding: "utf8", timeout: 120000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("ArduPilot WASM smoke: pass");
  }, 150000);
});
