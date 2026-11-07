import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { BetFlightDynamics, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { validateModelManifest } from '@mirage/physics/model-manifest';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { BOUND_V2, BOUND_V2_OUTPUT_SLOTS } from '@mirage/wasm-bet/rotor-v2';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '@mirage/protocol';
import { readDataFlash } from '../packages/dataflash/src/reader.ts';
import { GROUND_EFFECT_METHOD, groundEffectReproduced, measureGroundEffect } from '../packages/analysis/src/ground-effect-log.ts';
import { syntheticLog, type SyntheticMessage, type SyntheticValue } from './support/synthetic-log.ts';

// TASK-100, logged ground effect (SPECS_SIMULATION_ENGINES "Logged ground effect"). Declared before the implementation:
//  - on a log built here whose thrust per squared speed is 1.05 below 0.15 m and 1 above, the measurement gives 1.05 and 1 per bin
//    within float32 storage (1e-6), its standard error 0 for a constant, and the rotor height the reading plus the offset;
//  - the model held at a fixed duty gives more thrust per squared speed nearer the ground and the same, within 0.2 %, far from it;
//  - with MIRAGE_FORUM_LOG_DIR set, the stakeholder's SpeedyBee 3.5 log is checked by SHA-256, measured at offsets 0.01, 0.03 and
//    0.05 m, and compared bin by bin with the model's range over offset and blade count; MIRAGE_GE_OUT writes the report. The
//    comparison is reported, whatever its outcome.
const MESSAGES: readonly SyntheticMessage[] = [
  { type: 80, name: 'ESC', format: 'QBf', columns: ['TimeUS', 'Instance', 'RPM'] },
  { type: 81, name: 'IMU', format: 'QBf', columns: ['TimeUS', 'I', 'AccZ'] },
  { type: 82, name: 'RFND', format: 'QBfB', columns: ['TimeUS', 'Instance', 'Dist', 'Stat'] },
  { type: 83, name: 'ATT', format: 'Qff', columns: ['TimeUS', 'Roll', 'Pitch'] },
];
/** 40 s: 10 s at 0.12 m, 10 s at 0.35 m, 20 s at 0.8 m; thrust per squared speed 1.05 below 0.15 m. */
function hoverLog(): Uint8Array {
  const rows: { message: string; values: SyntheticValue[] }[] = [];
  const height = (t: number) => (t < 10 ? 0.12 : t < 20 ? 0.35 : 0.8), gain = (h: number) => (h < 0.15 ? 1.05 : 1);
  const rpm = 12000, k = 9.80665 / rpm ** 2;
  for (let n = 0; n < 40 * 400; n++) {
    const t = n / 400, us = Math.round(t * 1e6) + 1;
    rows.push({ message: 'ESC', values: [us, n % 4, rpm] });
    if (n % 4 === 0) rows.push({ message: 'IMU', values: [us + 1, 0, -k * gain(height(t)) * rpm ** 2] });
    if (n % 20 === 0) rows.push({ message: 'RFND', values: [us + 2, 0, height(t), 4] });
    if (n % 40 === 0) rows.push({ message: 'ATT', values: [us + 3, 0, 0] });
  }
  return syntheticLog(MESSAGES, rows);
}

const MOTOR = 'a'.repeat(64), PROPELLER = 'b'.repeat(64), ESC = 'c'.repeat(64), BATTERY = 'd'.repeat(64);
const HZ = 800, ARM_M = 0.0765, PROPELLER_M = 3.5 * 0.0254, PITCH_M = 2.5 * 0.0254;
let module: WebAssembly.Module;
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
function card(type: string, values: Record<string, number> = {}): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) throw new Error('Invalid card');
  const merged = { ...base.values, ...values };
  return validateComponentCard({ ...base, values: merged, provenance: Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, value === null ? null : 'example'])) });
}
/** The SpeedyBee-like quad: 76.5 mm arms, 3.5-inch propellers of the assumed pitch and blade count, KV 1950. */
async function speedyBee(blades: number): Promise<BetFlightConfiguration> {
  const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
  const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, arms: fixture.arms.map(arm => ({ ...arm, lengthM: ARM_M })), battery: { card: BATTERY },
    motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }), [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
  const cards = new Map([[MOTOR, card('motor', { kvRpmPerV: 1950 })], [PROPELLER, card('propeller', { diameterM: PROPELLER_M, pitchM: PITCH_M, bladeCount: blades })],
    [ESC, card('esc')], [BATTERY, card('battery')]]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(resolved.missing.join('; '));
  return buildProfileDynamics((await deriveVehicleManifest(profile, resolved.components, { modelId: 100 })).manifest, { initialStateOfCharge: 1, syntheticPad: true }).configuration;
}
/** Thrust over the rotors' mean squared speed, the vehicle held at a height by a huge mass with gravity off, at one duty. */
function thrustPerSpeed2(configuration: BetFlightConfiguration, heightM: number): number {
  const scale = 1e5, manifest = validateModelManifest(configuration.manifest);
  const heavy: BetFlightConfiguration = { ...configuration, gravityMps2: 0, syntheticGroundDownM: undefined,
    manifest: { ...structuredClone(configuration.manifest as object), massKg: manifest.massKg * scale, inertiaBodyKgM2: manifest.inertiaBodyKgM2.map(v => v * scale) },
    initialBody: { ...configuration.initialBody, positionNedM: new Float64Array([0, 0, -heightM]) } };
  const d = new BetFlightDynamics(module, heavy, HZ);
  try {
    d.setGroundEffect?.(1);
    const frame = newActuatorFrameV2(), pilot = newInput();
    frame.motorMapId = heavy.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed;
    frame.actuatorCount = Math.max(...manifest.rotors.map(rotor => rotor.motorChannel)) + 1;
    for (const rotor of manifest.rotors) frame.normalizedActuators[rotor.motorChannel] = 0.6;
    const ticks = 2 * HZ;
    let start = 0;
    for (let tick = 0; tick < ticks; tick++) {
      d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / HZ; d.stepNow(pilot);
      if (d.fault !== '') throw new Error(d.fault);
      if (tick === ticks - HZ / 2 - 1) start = d.state.vd;
    }
    const thrust = (start - d.state.vd) / 0.5 * manifest.massKg * scale, out = d.escEngine?.output;
    if (!out) throw new Error('The ESC drive is required');
    let omega2 = 0;
    for (let r = 0; r < manifest.rotors.length; r++) omega2 += out[r * BOUND_V2_OUTPUT_SLOTS + BOUND_V2.output.omega / 8]! ** 2;
    return thrust / (omega2 / manifest.rotors.length);
  } finally { d.dispose(); }
}

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600_000);

describe('logged ground effect (TASK-100)', () => {
  it('measures thrust per squared speed by height against the high hover, needing no mass', () => {
    const measured = measureGroundEffect(readDataFlash(hoverLog()), 0.03);
    expect(measured.referenceSamples).toBeGreaterThan(190);
    const [low, , , mid] = measured.bins;
    expect(low!.ratio).toBeCloseTo(1.05, 6);
    expect(low!.standardError).toBeLessThan(1e-6);
    expect(low!.rotorHeightM).toBeCloseTo(0.15, 6);
    expect(mid!.ratio).toBeCloseTo(1, 6);
    expect(measured.bins[1]!.samples).toBe(0);
    expect(GROUND_EFFECT_METHOD.binsM[0]).toBe(0.1);
    expect(groundEffectReproduced(1.05, 0.01, 1.0, 1.01)).toBe(true);
    expect(groundEffectReproduced(1.0601, 0.01, 1.0, 1.02)).toBe(false);
  });

  it('gives the model more thrust per squared speed nearer the ground and none far from it', async () => {
    const quad = await speedyBee(2), far = thrustPerSpeed2(quad, 2);
    expect(Math.abs(thrustPerSpeed2(quad, 1) / far - 1)).toBeLessThan(0.002);
    expect(thrustPerSpeed2(quad, 0.12) / far).toBeGreaterThan(thrustPerSpeed2(quad, 0.3) / far);
  }, 300_000);

  const dir = process.env.MIRAGE_FORUM_LOG_DIR ?? '', file = 'stakeholder-speedybee35-19-10-2026-tune-120hz-frt-02.BIN';
  it.skipIf(dir === '' || !existsSync(join(dir, file)))('compares the stakeholder\'s SpeedyBee 3.5 log with the model, bin by bin', async () => {
    const inventory = json('../data/flight-logs/inventory.json') as { logs: { file: string; sha256: string }[] };
    const bytes = readFileSync(join(dir, file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(sha256).toBe(inventory.logs.find(item => item.file === file)?.sha256);
    const log = readDataFlash(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const quads = new Map([[2, await speedyBee(2)], [3, await speedyBee(3)]]), far = new Map([...quads].map(([b, q]) => [b, thrustPerSpeed2(q, 2)]));
    const offsets = [0.01, 0.03, 0.05], measured = offsets.map(o => measureGroundEffect(log, o));
    const bins = GROUND_EFFECT_METHOD.binsM.slice(0, -1).map((fromM, i) => {
      const per = measured.map(m => m.bins[i]!), first = per[0]!;
      const model: { offsetM: number; blades: number; rotorHeightM: number; ratio: number }[] = [];
      for (const m of per) {
        if (m.rotorHeightM === null) continue;
        for (const [blades, quad] of quads) model.push({ offsetM: measured[per.indexOf(m)]!.offsetM, blades, rotorHeightM: m.rotorHeightM, ratio: thrustPerSpeed2(quad, m.rotorHeightM) / far.get(blades)! });
      }
      const low = model.length ? Math.min(...model.map(x => x.ratio)) : null, high = model.length ? Math.max(...model.map(x => x.ratio)) : null;
      const reproduced = first.ratio === null || low === null || high === null ? null : groundEffectReproduced(first.ratio, first.standardError, low, high);
      return { fromM, toM: first.toM, measured: first.ratio, standardError: first.standardError, samples: first.samples, model, modelLow: low, modelHigh: high, reproduced };
    });
    for (const bin of bins) if (bin.samples > 0) { expect(bin.measured).not.toBeNull(); expect(bin.model.length).toBe(6); }
    const out = process.env.MIRAGE_GE_OUT;
    if (out) writeFileSync(out, `${JSON.stringify({ schemaVersion: 1, kind: 'logged-ground-effect', file, sha256, method: GROUND_EFFECT_METHOD,
      assumptions: { armM: ARM_M, propellerDiameterM: PROPELLER_M, pitchM: PITCH_M, blades: [2, 3], offsetsM: offsets, kvRpmPerV: 1950, duty: 0.6 },
      referenceSamples: measured[0]!.referenceSamples, bins,
      status: bins.every(b => b.reproduced !== false) ? 'REPRODUCED' : 'NOT_REPRODUCED' }, null, 2)}\n`);
  }, 900_000);
});
