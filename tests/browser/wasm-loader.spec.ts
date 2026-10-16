import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// TASK-017: the real loader selects, verifies, and instantiates the built artifacts in Chromium.
const root = fileURLToPath(new URL('../..', import.meta.url));
const loaderUrl = '/@fs' + fileURLToPath(new URL('../../packages/wasm-bet/src/loader.ts', import.meta.url));

test('WASM loader detects SIMD128, falls back to scalar, verifies hashes, and reserves memory in Chromium', async ({ page }) => {
  test.setTimeout(300_000);
  const out = mkdtempSync(join(tmpdir(), 'mirage-wasm-browser-'));
  try {
    execFileSync(process.execPath, [join(root, 'scripts/build-wasm.mjs'), '--out', out], { cwd: root, stdio: 'pipe' });
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as unknown;
    const files = Object.fromEntries(['scalar', 'simd128'].map(variant => {
      const file = `mirage_bet.${variant}.wasm`;
      return [file, Array.from(readFileSync(join(out, file)))];
    }));
    await page.goto('/');
    const result = await page.evaluate(async ({ loaderUrl, manifest, files }) => {
      // Statically known checkout module, transformed by the application's Vite server.
      const l = await import(loaderUrl) as typeof import('../../packages/wasm-bet/src/loader');
      const fetchBytes = (file: string) => {
        const bytes = files[file];
        return bytes ? Promise.resolve(new Uint8Array(bytes)) : Promise.reject(new Error(`missing ${file}`));
      };
      const detected = l.detectSimd128();
      const auto = await l.loadBetModule({ manifest, fetchBytes });
      const scalar = await l.loadBetModule({ manifest, fetchBytes, simd128: false, reserveBytes: 1 << 20 });
      const corrupt = await l.loadBetModule({ manifest, simd128: false, fetchBytes: async file => {
        const bytes = await fetchBytes(file); bytes[0] = 1; return bytes;
      } });
      const force = (r: typeof auto) => r.ok ? r.module.exports.bet_bootstrap_element_force(
        1.225, 0.03, 0.01, 0, 0, -25, 1, 0, 0, 1, 1.1, 0.02, 1) : NaN;
      return {
        isolated: crossOriginIsolated, detected,
        auto: auto.ok ? { variant: auto.module.variant, fallback: auto.fallback, reserved: auto.module.reservedBytes,
          stable: auto.module.memoryStable() } : auto.reason,
        scalar: scalar.ok ? { variant: scalar.module.variant, fallback: scalar.fallback } : scalar.reason,
        forces: [force(auto), force(scalar)], corrupt: corrupt.ok ? 'loaded' : corrupt.reason,
        budget: l.BET_MEMORY_BUDGET_BYTES,
      };
    }, { loaderUrl, manifest, files });
    expect(result.isolated).toBe(true);
    expect(result.detected).toBe(true); // Chromium supports SIMD128
    expect(result.auto).toEqual({ variant: 'simd128', fallback: false, reserved: result.budget, stable: true });
    expect(result.scalar).toEqual({ variant: 'scalar', fallback: true });
    const q = 0.5 * 1.225 * 625 * 0.03 * 0.01; // independent: dF_y = -q CL for d = -z, e_r = x, spin +1
    for (const value of result.forces) expect(value).toBeCloseTo(-q * 1.1, 12);
    expect(result.corrupt).toMatch(/SHA-256 mismatch/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
