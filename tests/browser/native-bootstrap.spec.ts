import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// TASK-016: the bootstrap kernel artifact is reproducible and runs in Chromium.
const nativeDir = fileURLToPath(new URL('../../native/', import.meta.url));

/** Builds the release wasm32 artifact into its own target directory, inside native/ so the pinned toolchain applies. */
function buildArtifact(targetDir: string): Uint8Array {
  execFileSync('cargo', ['build', '--release', '-p', 'mirage-bet', '--target', 'wasm32-unknown-unknown', '--locked'],
    { cwd: nativeDir, env: { ...process.env, CARGO_TARGET_DIR: targetDir }, stdio: 'pipe' });
  return readFileSync(join(targetDir, 'wasm32-unknown-unknown', 'release', 'mirage_bet.wasm'));
}
/** Independent evaluation of dF = 1/2 rho U^2 c dr (CL l + CD d), d = v/U, l = s (d x e_r). */
function expectedForce(rho: number, chord: number, dr: number, v: number[], er: number[], spin: number, cl: number, cd: number): number[] {
  const [vx = 0, vy = 0, vz = 0] = v, [ex = 0, ey = 0, ez = 0] = er;
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!(speed >= 1e-6)) return [0, 0, 0];
  const d = [vx / speed, vy / speed, vz / speed];
  const [dx = 0, dy = 0, dz = 0] = d;
  const l = [spin * (dy * ez - dz * ey), spin * (dz * ex - dx * ez), spin * (dx * ey - dy * ex)];
  const q = 0.5 * rho * speed * speed * chord * dr;
  return [0, 1, 2].map(i => q * cl * (l[i] ?? 0) + q * cd * (d[i] ?? 0));
}

test('bootstrap BET kernel builds reproducibly and runs in Chromium', async ({ page }) => {
  test.setTimeout(300_000);
  const first = mkdtempSync(join(tmpdir(), 'mirage-bet-a-')), second = mkdtempSync(join(tmpdir(), 'mirage-bet-b-'));
  try {
    const a = buildArtifact(first), b = buildArtifact(second);
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    expect(sha(a)).toBe(sha(b)); // reproducible across clean target directories
    await page.goto('/');
    const cases = [
      [1.225, 0.03, 0.01, 0, -25, 3, 1, 0, 0, 1, 1.1, 0.02],
      [1.225, 0.03, 0.01, 0, -25, 3, 1, 0, 0, -1, 1.1, 0.02],
      [0.9, 0.05, 0.02, 0.2, -60, -5, 0, 1, 0, 1, -0.3, 1.2],
      [1.225, 0.03, 0.01, 0, 0, 0, 1, 0, 0, 1, 1.1, 0.02],
    ];
    const result = await page.evaluate(async ({ bytes, cases }) => {
      const module = await WebAssembly.compile(new Uint8Array(bytes));
      const instance = await WebAssembly.instantiate(module, {});
      const exports = instance.exports as unknown as {
        bet_abi_version(): number;
        bet_body_abi_version(): number;
        bet_bootstrap_element_force(...args: number[]): number;
      }; // shape checked below against the module's export list
      const names = WebAssembly.Module.exports(module).map(e => e.name).sort();
      return {
        imports: WebAssembly.Module.imports(module).length, names, abi: exports.bet_abi_version(), bodyAbi: exports.bet_body_abi_version(),
        forces: cases.map(c => [0, 1, 2].map(axis => exports.bet_bootstrap_element_force(...c, axis))),
      };
    }, { bytes: Array.from(a), cases });
    expect(result.imports).toBe(0); // no host imports: nothing to allocate or log through
    expect(result.names).toEqual(['__heap_base', 'bet_abi_version', 'bet_body_abi_version', 'bet_body_step', 'bet_bootstrap_element_force', 'bet_dispose', 'bet_init',
      'bet_last_error', 'bet_required_bytes', 'bet_reset', 'bet_step', 'memory',
      'bet_bound_version','bet_bound_init','bet_bound_step','bet_bound_reset','bet_bound_dispose', // additive bound interface
      // Additive step interfaces v2: docs/SPECS_SIMULATION_ENGINES.md, section "Step interfaces v2 (TASK-088)".
      'bet_bound_v2_version', 'bet_bound_step_v2', 'bet_body_v2_version', 'bet_body_step_v2',
      // Shared battery bus: docs/SPECS_SIMULATION_ENGINES.md, section "Electromechanical drive (TASK-092)".
      'bet_bus_version', 'bet_bus_step'].sort());
    expect(result.abi).toBe(1);
    expect(result.bodyAbi).toBe(1);
    cases.forEach((c, i) => {
      const [rho = 0, chord = 0, dr = 0, vx = 0, vy = 0, vz = 0, ex = 0, ey = 0, ez = 0, spin = 0, cl = 0, cd = 0] = c;
      const expected = expectedForce(rho, chord, dr, [vx, vy, vz], [ex, ey, ez], spin, cl, cd);
      result.forces[i]!.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis]!, 12));
    });
  } finally {
    rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true });
  }
});
