import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { imuNoiseFloorMatrix, ownershipParameterProfile, parseArduPilotCatalog } from '@mirage/autopilot/error-ownership';
import catalogJson from './fixtures/sitl/ardupilot-catalog.json';
import { nodeCheck } from './support/node-evidence';
import ownership from './fixtures/sitl/error-ownership.json';

const node = (script: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, timeout: 60000 });
const directory = mkdtempSync(join(tmpdir(), 'mirage-imu-floor-'));
afterAll(() => {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('mirage-imu-floor-')) throw new Error('Unexpected temporary cleanup target');
  rmSync(directory, { recursive: true });
});

/** Uniform values in [-1, 1) from a fixed 32-bit LCG, so the synthetic captures are reproducible. */
function uniform(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 31 - 1; };
}
const ACCEL_FLOOR_MPS2 = 0.01, GYRO_FLOOR_RADS = 0.04 * Math.PI / 180, DRIFT_RADS_PER_S = 0.05 * Math.PI / 180 / 60;

/**
 * A driver-shaped capture: disarmed until 40 s, HIGHRES_IMU at 333 Hz holding
 * gravity, a linear gyro drift and optionally the raw upstream floor amplitude.
 */
function capture(name: string, floor: boolean, armS = 40): string {
  const path = join(directory, name), next = uniform(42);
  spawnSync('mkdir', ['-p', path]);
  const lines: string[] = [];
  for (let i = 0; i * 0.003 <= armS + 2; i++) {
    const t = i * 0.003, n = () => (floor ? next() : 0), drift = DRIFT_RADS_PER_S * t;
    lines.push(JSON.stringify({ receivedSimS: t, wallTimeMs: t * 500, message: { mavpackettype: 'HIGHRES_IMU', time_usec: Math.round(t * 1e6),
      xacc: ACCEL_FLOOR_MPS2 * n(), yacc: ACCEL_FLOOR_MPS2 * n(), zacc: -9.80665 + ACCEL_FLOOR_MPS2 * n(),
      xgyro: drift + GYRO_FLOOR_RADS * n(), ygyro: drift + GYRO_FLOOR_RADS * n(), zgyro: drift + GYRO_FLOOR_RADS * n() } }));
  }
  writeFileSync(join(path, 'telemetry.ndjson'), lines.join('\n') + '\n');
  writeFileSync(join(path, 'run.json'), JSON.stringify({ status: 'captured', commands: [{ timeS: 30, kind: 'mode', mode: 4 }, { timeS: armS, kind: 'arm' }] }));
  writeFileSync(join(path, 'flight.json'), JSON.stringify({ schemaVersion: 2, provenance: { source: 'native-sitl', firmwareSha256: 'f'.repeat(64) } }));
  writeFileSync(join(path, 'quad.parm'), 'FRAME_CLASS 1\n');
  writeFileSync(join(path, 'firmware.log'), 'synthetic\n');
  return path;
}
function report(path: string): { status: string; window: { samples: number }; axes: Record<string, { std: number; slopePerS: number }> } {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || !('axes' in value) || !('window' in value) || !('status' in value)) throw new Error('Invalid report');
  const { status, window, axes } = value;
  if (typeof status !== 'string' || typeof window !== 'object' || window === null || !('samples' in window) || typeof window.samples !== 'number' ||
      typeof axes !== 'object' || axes === null) throw new Error('Invalid report');
  const parsed: Record<string, { std: number; slopePerS: number }> = {};
  const entries: [string, unknown][] = Object.entries(axes);
  for (const [field, axis] of entries) {
    if (typeof axis !== 'object' || axis === null || !('std' in axis) || !('slopePerS' in axis) || typeof axis.std !== 'number' ||
        typeof axis.slopePerS !== 'number') throw new Error('Invalid axis');
    parsed[field] = { std: axis.std, slopePerS: axis.slopePerS };
  }
  return { status, window: { samples: window.samples }, axes: parsed };
}

describe('IMU noise-floor capture analysis', () => {
  it('reports a missing capture as BLOCKED_EXTERNAL', () => {
    const result = node('scripts/check-imu-noise-floor.mjs', []);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('BLOCKED_EXTERNAL');
  });

  it('measures the uniform floor amplitude and passes only the matching expectation', () => {
    const on = capture('floor-on', true), output = join(directory, 'on.json');
    expect(node('scripts/check-imu-noise-floor.mjs', ['--input', on, '--expect', 'ardupilot', '--output', output]).status).toBe(0);
    const measured = report(output);
    expect(measured.status).toBe('PASS');
    // 10..39 s at 333 Hz.
    expect(measured.window.samples).toBe(9667);
    // Uniform noise of amplitude a has standard deviation a/√3; 9667 samples bound the estimate to well within 3 %.
    for (const field of ['xacc', 'yacc', 'zacc']) expect(Math.abs((measured.axes[field]?.std ?? 0) / (ACCEL_FLOOR_MPS2 / Math.sqrt(3)) - 1)).toBeLessThan(0.03);
    // Least-squares slope standard error σ/√(N·T²/12) over the 29 s window.
    const slopeError = GYRO_FLOOR_RADS / Math.sqrt(3) / Math.sqrt(measured.window.samples * 29 ** 2 / 12);
    for (const field of ['xgyro', 'ygyro', 'zgyro']) {
      expect(Math.abs((measured.axes[field]?.std ?? 0) / (GYRO_FLOOR_RADS / Math.sqrt(3)) - 1)).toBeLessThan(0.03);
      // The drift is a straight line that the analysis removes, not noise.
      expect(Math.abs((measured.axes[field]?.slopePerS ?? 0) - DRIFT_RADS_PER_S)).toBeLessThan(5 * slopeError);
    }
    const wrong = node('scripts/check-imu-noise-floor.mjs', ['--input', on, '--expect', 'off', '--output', join(directory, 'on-as-off.json')]);
    expect(wrong.status).toBe(1);
    expect(report(join(directory, 'on-as-off.json')).status).toBe('FAIL');
  });

  it('passes a floor-free capture as off even with gyro drift, and fails it as ardupilot', () => {
    const off = capture('floor-off', false), output = join(directory, 'off.json');
    expect(node('scripts/check-imu-noise-floor.mjs', ['--input', off, '--expect', 'off', '--output', output]).status).toBe(0);
    const measured = report(output);
    for (const field of ['xacc', 'yacc', 'zacc', 'xgyro', 'ygyro', 'zgyro']) expect(measured.axes[field]?.std ?? 1).toBeLessThan(1e-9);
    expect(node('scripts/check-imu-noise-floor.mjs', ['--input', off, '--expect', 'ardupilot', '--output', join(directory, 'off-as-on.json')]).status).toBe(1);
  });

  it('compares every sample with a reference capture and fails on any differing value', () => {
    const a = capture('reference-a', true), b = capture('reference-b', true), output = join(directory, 'reference.json');
    expect(node('scripts/check-imu-noise-floor.mjs', ['--input', a, '--expect', 'ardupilot', '--reference', b, '--output', output]).status).toBe(0);
    const value: unknown = JSON.parse(readFileSync(output, 'utf8'));
    // Samples before the first driver command (mode at 30 s): 0..29.997 s at 3 ms.
    expect(value).toMatchObject({ status: 'PASS', reference: { beforeS: 30, compared: 10000, identical: 10000 } });
    // A changed value after the first command is outside the comparison; one before it fails.
    const lines = readFileSync(join(b, 'telemetry.ndjson'), 'utf8').split('\n');
    lines[12000] = (lines[12000] ?? '').replace(/"xacc":(-?[0-9.e-]+)/, '"xacc":1');
    writeFileSync(join(b, 'telemetry.ndjson'), lines.join('\n'));
    expect(node('scripts/check-imu-noise-floor.mjs', ['--input', a, '--expect', 'ardupilot', '--reference', b, '--output', output]).status).toBe(0);
    lines[5000] = (lines[5000] ?? '').replace(/"xacc":(-?[0-9.e-]+)/, '"xacc":1');
    writeFileSync(join(b, 'telemetry.ndjson'), lines.join('\n'));
    const changed = node('scripts/check-imu-noise-floor.mjs', ['--input', a, '--expect', 'ardupilot', '--reference', b, '--output', output]);
    expect(changed.status).toBe(1);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ status: 'FAIL', reasons: ['1 of 10000 HIGHRES_IMU samples differ from the reference'] });
    expect(node('scripts/check-imu-noise-floor.mjs', ['--input', a, '--expect', 'ardupilot', '--output', output, '--output', output]).status).toBe(1);
  });

  it('rejects short windows, unknown expectations and incomplete captures', () => {
    const short = capture('short', true, 15);
    const result = node('scripts/check-imu-noise-floor.mjs', ['--input', short, '--expect', 'ardupilot', '--output', join(directory, 'short.json')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('shorter than 10 s');
    const on = capture('floor-on-2', true);
    expect(node('scripts/check-imu-noise-floor.mjs', ['--input', on, '--expect', 'maybe', '--output', join(directory, 'maybe.json')]).stderr)
      .toContain('--expect must be ardupilot or off');
    writeFileSync(join(on, 'run.json'), JSON.stringify({ status: 'FAIL', commands: [] }));
    expect(node('scripts/check-imu-noise-floor.mjs', ['--input', on, '--expect', 'ardupilot', '--output', join(directory, 'failed.json')]).stderr)
      .toContain('Not a completed native SITL capture');
  });
});

describe('IMU noise-floor setting tools', () => {
  const catalog = parseArduPilotCatalog(catalogJson);

  it('prints the same validated profile as the library for each setting', () => {
    const off = node('scripts/ownership-profile.mjs', ['--imu-noise-floor', 'off']);
    expect(off.status).toBe(0);
    expect(off.stdout).toBe(ownershipParameterProfile(imuNoiseFloorMatrix('off', 'native-json'), catalog));
    expect(off.stdout.split('\n').filter(line => line && !line.startsWith('#'))).toEqual(['SIM_ACC_FLOOR 0', 'SIM_GYR_FLOOR 0']);
    const defaults = node('scripts/ownership-profile.mjs', ['--imu-noise-floor', 'ardupilot']);
    expect(defaults.stdout.split('\n').filter(line => line && !line.startsWith('#'))).toEqual([]);
    const browser = node('scripts/ownership-profile.mjs', ['--imu-noise-floor', 'off', '--path', 'browser-hal']);
    expect(browser.status).toBe(1);
    expect(browser.stderr).toContain('No browser-hal build applies the imu-noise-floor firmware patch');
    const matrixPath = join(directory, 'matrix.json');
    writeFileSync(matrixPath, JSON.stringify(ownership.matrices[2]));
    expect(node('scripts/ownership-profile.mjs', ['--matrix', matrixPath]).stdout).toBe(ownershipParameterProfile(ownership.matrices[2], catalog));
    expect(node('scripts/ownership-profile.mjs', ['--imu-noise-floor']).status).toBe(1);
  });

  it('rejects an unknown harness setting before it reads any firmware or source', () => nodeCheck(`
import {runSitl} from './scripts/run-sitl.mjs';
const env={MIRAGE_SITL_BINARY:'/nonexistent',MIRAGE_SITL_SOURCE:'/nonexistent',MIRAGE_SITL_DRIVER:'/nonexistent',
  MIRAGE_SITL_BINARY_SHA256:'a'.repeat(64),MIRAGE_SITL_DRIVER_SHA256:'a'.repeat(64)};
await assert.rejects(runSitl({...env,MIRAGE_SITL_IMU_NOISE_FLOOR:'maybe'}),/MIRAGE_SITL_IMU_NOISE_FLOOR must be ardupilot or off/);
// Missing prerequisites still report BLOCKED_EXTERNAL whatever the setting.
assert.equal((await runSitl({MIRAGE_SITL_IMU_NOISE_FLOOR:'off'})).status,'BLOCKED_EXTERNAL');
`));

  it('blocks the patched SITL build without a pinned ArduPilot checkout', () => {
    const env = { ...process.env };
    delete env.MIRAGE_SITL_SOURCE;
    const missing = node('scripts/build-ardupilot-sitl.mjs', ['--out', join(directory, 'build')], env);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('MIRAGE_SITL_SOURCE and --out are required');
    const notCheckout = node('scripts/build-ardupilot-sitl.mjs', ['--out', join(directory, 'build')], { ...env, MIRAGE_SITL_SOURCE: directory });
    expect(notCheckout.status).toBe(2);
    expect(notCheckout.stderr).toContain('not an ArduPilot checkout');
  });
});
