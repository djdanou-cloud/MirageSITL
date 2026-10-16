import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BET_MEMORY_BUDGET_BYTES, EXPECTED_BET_ABI_VERSION, detectSimd128, loadBetModule, parseWasmManifest,
  type WasmManifest } from '@mirage/wasm-bet/loader';

// TASK-017: artifacts come from the real build script; the oracle for hashes is
// node:crypto over the files on disk, independent of the loader's Web Crypto path.
const root = fileURLToPath(new URL('..', import.meta.url));
let out = '';
let manifestJson: unknown;
let manifest: WasmManifest;
const files = new Map<string, Uint8Array>();
const fetchBytes = (file: string) => {
  const bytes = files.get(file);
  return bytes ? Promise.resolve(bytes.slice()) : Promise.reject(new Error(`missing ${file}`));
};
const clone = (): WasmManifest => parseWasmManifest(JSON.parse(JSON.stringify(manifestJson)));

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'mirage-wasm-'));
  execFileSync(process.execPath, [join(root, 'scripts/build-wasm.mjs'), '--out', out], { cwd: root, stdio: 'pipe' });
  manifestJson = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  manifest = parseWasmManifest(manifestJson);
  for (const artifact of manifest.artifacts) files.set(artifact.file, readFileSync(join(out, artifact.file)));
}, 300_000);
afterAll(() => { if (out) rmSync(out, { recursive: true, force: true }); });

describe('mirage-bet WASM build and loader', () => {
  it('writes a manifest whose hashes and sizes match the artifacts on disk', () => {
    expect(manifest.abiVersion).toBe(EXPECTED_BET_ABI_VERSION);
    expect(manifest.toolchain).toMatch(/^rustc 1\.97\.0 /);
    expect(manifest.artifacts.map(a => [a.variant, a.targetFeatures])).toEqual([['scalar', []], ['simd128', ['simd128']]]);
    for (const artifact of manifest.artifacts) {
      const bytes = files.get(artifact.file) ?? new Uint8Array();
      expect(artifact.bytes).toBe(bytes.byteLength);
      expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
  it('loads the SIMD artifact when supported and the scalar baseline otherwise', async () => {
    expect(detectSimd128()).toBe(true); // Node 24 / V8 supports SIMD128
    expect(detectSimd128(() => false)).toBe(false);
    expect(detectSimd128(() => { throw new Error('no wasm'); })).toBe(false);
    const simd = await loadBetModule({ manifest: manifestJson, fetchBytes, simd128: true, reserveBytes: 1 << 20 });
    const scalar = await loadBetModule({ manifest: manifestJson, fetchBytes, simd128: false, reserveBytes: 1 << 20 });
    if (!simd.ok || !scalar.ok) throw new Error('load failed');
    expect([simd.module.variant, simd.fallback]).toEqual(['simd128', false]);
    expect([scalar.module.variant, scalar.fallback]).toEqual(['scalar', true]);
    // Both variants compute the same element force (dF_z = q CL with d = -z, e_r = x, spin +1).
    for (const { module } of [simd, scalar]) {
      const q = 0.5 * 1.225 * 625 * 0.03 * 0.01;
      expect(module.exports.bet_bootstrap_element_force(1.225, 0.03, 0.01, 0, 0, -25, 1, 0, 0, 1, 1.1, 0.02, 0))
        .toBeCloseTo(0, 12);
      expect(module.exports.bet_bootstrap_element_force(1.225, 0.03, 0.01, 0, 0, -25, 1, 0, 0, 1, 1.1, 0.02, 1))
        .toBeCloseTo(-q * 1.1, 12);
    }
    const noSimd = clone(); noSimd.artifacts = noSimd.artifacts.filter(a => a.variant === 'scalar');
    const onlyScalar = await loadBetModule({ manifest: noSimd, fetchBytes, simd128: true, reserveBytes: 1 << 20 });
    expect(onlyScalar.ok && [onlyScalar.module.variant, onlyScalar.fallback]).toEqual(['scalar', true]);
  });
  it('reserves the memory budget before arming and reports later growth', async () => {
    const result = await loadBetModule({ manifest: manifestJson, fetchBytes, simd128: false });
    if (!result.ok) throw new Error(result.reason);
    expect(result.module.reservedBytes).toBe(BET_MEMORY_BUDGET_BYTES);
    expect(result.module.exports.memory.buffer.byteLength).toBe(BET_MEMORY_BUDGET_BYTES);
    expect(result.module.memoryStable()).toBe(true);
    result.module.exports.memory.grow(1);
    expect(result.module.memoryStable()).toBe(false);
    for (const reserveBytes of [0, -1, 1.5, BET_MEMORY_BUDGET_BYTES + 1]) {
      expect(await loadBetModule({ manifest: manifestJson, fetchBytes, reserveBytes }), String(reserveBytes))
        .toMatchObject({ ok: false, reason: expect.stringMatching(/Memory reservation/) as unknown });
    }
  });
  it('blocks arming on a corrupt artifact, a hash or size mismatch, or an ABI mismatch', async () => {
    const scalarFile = manifest.artifacts[0]?.file ?? '';
    const corrupt = (file: string) => {
      const bytes = (files.get(file) ?? new Uint8Array()).slice();
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      return Promise.resolve(bytes);
    };
    expect(await loadBetModule({ manifest: manifestJson, fetchBytes: corrupt, simd128: false }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/SHA-256 mismatch/) as unknown });
    const truncated = (file: string) => Promise.resolve((files.get(file) ?? new Uint8Array()).slice(1));
    expect(await loadBetModule({ manifest: manifestJson, fetchBytes: truncated, simd128: false }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/size/) as unknown });
    const abi = clone(); abi.abiVersion = EXPECTED_BET_ABI_VERSION + 1;
    expect(await loadBetModule({ manifest: abi, fetchBytes, simd128: false }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/ABI/) as unknown });
    // A valid module that is not mirage-bet: hash matches the manifest, but exports do not.
    const foreign = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const forged = clone();
    forged.artifacts = [{ variant: 'scalar', file: scalarFile, bytes: foreign.byteLength, targetFeatures: [],
      sha256: createHash('sha256').update(foreign).digest('hex') }];
    expect(await loadBetModule({ manifest: forged, fetchBytes: () => Promise.resolve(foreign.slice()), simd128: false }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/missing required exports/) as unknown });
    expect(await loadBetModule({ manifest: manifestJson, fetchBytes: () => Promise.reject(new Error('404')), simd128: false }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/Cannot fetch/) as unknown });
  });
  it('rejects malformed manifests from unknown input', () => {
    const base = JSON.parse(JSON.stringify(manifestJson)) as Record<string, unknown>;
    const bad: unknown[] = [null, [], 'manifest', { ...base, extra: 1 }, { ...base, schemaVersion: 2 },
      { ...base, crate: 'other' }, { ...base, abiVersion: 1.5 }, { ...base, artifacts: [] },
      { ...base, artifacts: manifest.artifacts.filter(a => a.variant === 'simd128') },
      { ...base, artifacts: [manifest.artifacts[0], manifest.artifacts[0]] },
      { ...base, artifacts: [{ ...manifest.artifacts[0], file: '../escape.wasm' }] },
      { ...base, artifacts: [{ ...manifest.artifacts[0], sha256: 'ABC' }] },
      { ...base, artifacts: [{ ...manifest.artifacts[0], bytes: 0 }] },
      { ...base, artifacts: [{ ...manifest.artifacts[0], variant: 'relaxed-simd' }] },
      { ...base, artifacts: [{ ...manifest.artifacts[0], targetFeatures: [1] }] }];
    for (const value of bad) expect(() => parseWasmManifest(value), JSON.stringify(value)).toThrow();
    expect(parseWasmManifest(base)).toEqual(manifest);
  });
});
