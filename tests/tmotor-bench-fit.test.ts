import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '../packages/aircraft/src/components.ts';
import { deriveVehicleManifest } from '../packages/aircraft/src/derive-manifest.ts';
import { validateAircraftProfile, withPropellerPolars } from '../packages/aircraft/src/profile.ts';
import { resolveComponents } from '../packages/aircraft/src/resolve-components.ts';
import { validateModelManifest } from '../packages/physics/src/model-manifest.ts';
import { importBenchMeasurements } from '../packages/physics/src/bench-import.ts';
import { atmosphereFromState } from '../packages/physics/src/atmosphere.ts';
import { buildProfileDynamics, profileRotorDefinition } from '../packages/physics/src/profile-dynamics.ts';
import { fitPropulsion, POLAR_SCALE_RANGE, scaledPolar, staticLoads } from '../packages/physics/src/propulsion-calibration.ts';

// TASK-145 with real manufacturer data: T-Motor's datasheet table for MN7005 KV230 with the P24*7.2" CF propeller
// (tests/fixtures/components/tmotor-mn7005-kv230-p24x72.csv, transcribed from the image of data/flight-logs/inventory.json), fitted on
// the rotor the profile builds from the propeller card (derived BET geometry, NACA6409 polar) of the forum aircraft's quad
// (tests/fixtures/aircraft/tmotor-mn7005-quad.json; arm length and inertia assumed). The data are T-Motor's, not a measurement of ours;
// the air density 1.225 kg/m³ is assumed, and each row's voltage is the table's power over its current. Declared before the run:
//  - the four cards validate, each value with its source or null, and the CSV imports with 11 points and no consistency flag;
//  - the fit keeps one residual per bench point, its scales lie in the allowed range, and the residuals equal the static loads of the
//    rotor on the fitted polar within 1e-9 relative (an independent call of the solver);
//  - the motor fit at KV 230 gives positive R and I₀; nothing is judged: the residuals are kept and shown, never compared with a limit.
// MIRAGE_TMOTOR_FIT_OUT=path writes the fit for the specification's record.
let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600_000);

const json = (path: string): unknown => JSON.parse(readFileSync(`tests/fixtures/${path}`, 'utf8'));
const MOTOR = '11'.repeat(32), PROPELLER = '22'.repeat(32), ESC = '33'.repeat(32), BATTERY = '44'.repeat(32);

describe('T-Motor MN7005 KV230 + P24*7.2 datasheet fit (TASK-145)', () => {
  it('imports the datasheet, builds the forum quad\'s rotor and fits it, keeping every residual', async () => {
    const cards = new Map<string, ComponentCard>([
      [MOTOR, validateComponentCard(json('components/tmotor-mn7005-kv230.json'))],
      [PROPELLER, validateComponentCard(json('components/tmotor-p24x72.json'))],
      [ESC, validateComponentCard(json('components/tmotor-alpha-40a.json'))],
      [BATTERY, validateComponentCard(json('components/battery-6s-42ah-forum-144558.json'))],
    ]);
    const bench = importBenchMeasurements(readFileSync('tests/fixtures/components/tmotor-mn7005-kv230-p24x72.csv', 'utf8'));
    expect(bench.points).toHaveLength(11);
    expect(bench.airDensityKgM3).toBe(1.225);
    expect(bench.points.flatMap(point => point.flags)).toEqual([]);
    const fixture = validateAircraftProfile(json('aircraft/tmotor-mn7005-quad.json'));
    const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY },
      motors: fixture.motors.map(item => ({ ...item, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }),
    [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
    const resolved = resolveComponents(profile, cards);
    if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
    const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: 145 });
    const build = buildProfileDynamics(derived.manifest, { syntheticPad: true });
    const model = validateModelManifest(build.configuration.manifest);
    const rotor = profileRotorDefinition(build.configuration, 0);
    expect(2 * rotor.geometry.radiusM).toBeCloseTo(0.6096, 12);
    const kv = derived.manifest.motors.find(item => item.rotorId === model.rotors[0]?.id)?.kvRpmPerV ?? null;
    expect(kv).toBe(230);
    const fit = fitPropulsion({ module, rotor, bench, kvRpmPerV: kv });
    expect(fit.residuals.map(row => row.rpm)).toEqual(bench.points.map(point => point.rpm));
    expect(fit.scales.lift).toBeGreaterThanOrEqual(POLAR_SCALE_RANGE[0]);
    expect(fit.scales.lift).toBeLessThanOrEqual(POLAR_SCALE_RANGE[1]);
    expect(fit.scales.drag).toBeGreaterThanOrEqual(POLAR_SCALE_RANGE[0]);
    expect(fit.scales.drag).toBeLessThanOrEqual(POLAR_SCALE_RANGE[1]);
    // The fit's own air for a density without temperature: ISA sea-level viscosity and sound speed.
    const isa = atmosphereFromState({ temperatureK: 288.15, pressurePa: 101325 });
    const air = { densityKgM3: bench.airDensityKgM3, viscosityPaS: isa.dynamicViscosityPaS, soundMps: isa.speedOfSoundMps };
    const check = staticLoads(module, { ...rotor, polar: scaledPolar(rotor.polar, fit.scales) }, air, bench.points.map(point => point.rpm));
    fit.residuals.forEach((row, i) => {
      expect(Math.abs(row.modelThrustN - check.thrustN[i]!)).toBeLessThanOrEqual(1e-9 * Math.abs(row.modelThrustN));
      expect(Math.abs(row.modelTorqueNm - check.torqueNm[i]!)).toBeLessThanOrEqual(1e-9 * Math.abs(row.modelTorqueNm));
    });
    expect(fit.motor?.kvRpmPerV).toBe(230);
    expect(fit.motor!.resistanceOhm).toBeGreaterThan(0);
    expect(fit.motor!.noLoadCurrentA).toBeGreaterThan(0);
    const out = process.env.MIRAGE_TMOTOR_FIT_OUT;
    if (out) writeFileSync(out, `${JSON.stringify({ bladeGeometry: derived.manifest.rotors?.[0] ?? null, fit }, null, 2)}\n`);
  }, 300_000);
});
