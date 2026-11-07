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

// The stakeholder's decision of 2026-11-07: a set of the motor's cards on a laboratory supply binds to a battery-powered profile. The
// T-Motor set, stored on a laboratory supply, is calibrated through the application's own path (calibrateMotor), stored, bound as a new
// profile version, and derived for all four motors, while the profile's own battery card stays the combination it belongs to.
describe('the T-Motor set on a laboratory supply binds to the forum quad (TASK-145)', () => {
  it('calibrates, stores and binds it as a calculation from measurements labeled measured-input on a laboratory supply', async () => {
    const { createHash } = await import('node:crypto');
    const { MemoryBackend, ProjectStore } = await import('../packages/project/src/store.ts');
    const { measurementSetFromBenchCsv, measurementSetDraft, validateMeasurementSet } = await import('../packages/aircraft/src/measurements.ts');
    const { profileDraft } = await import('../packages/aircraft/src/profile.ts');
    const { bindMeasurements, evaluateCalculation, motorSetKeys } = await import('../packages/aircraft/src/calculation-mode.ts');
    const { bindCalibration, calibrateMotor, savePropulsionCalibration, validatePropulsionCalibration } = await import('../packages/aircraft/src/propulsion-calibration.ts');
    const store = new ProjectStore(new MemoryBackend(), { storage: null, validators: { 'component-card': validateComponentCard, 'measurement-set': validateMeasurementSet,
      'aircraft-profile': validateAircraftProfile, 'propulsion-calibration': validatePropulsionCalibration } });
    const projectId = (await store.createProject('Forum quad')).record.id;
    const cards = new Map<string, ComponentCard>();
    const add = async (path: string) => {
      const card = validateComponentCard(json(`components/${path}`));
      const stored = await store.createItem(projectId, 'component-card', { name: path, payload: card });
      cards.set(stored.sha256, card);
      return stored.sha256;
    };
    const motor = await add('tmotor-mn7005-kv230.json'), propeller = await add('tmotor-p24x72.json');
    const esc = await add('tmotor-alpha-40a.json'), battery = await add('battery-6s-42ah-forum-144558.json');
    const set = await measurementSetFromBenchCsv(readFileSync('tests/fixtures/components/tmotor-mn7005-kv230-p24x72.csv', 'utf8'), {
      combination: { motor, propeller, esc, supply: { kind: 'laboratory' } }, fileName: 'tmotor-mn7005-kv230-p24x72.csv', date: '2026-07-28',
      description: 'T-Motor datasheet table, MN7005 KV230 with P24*7.2 CF at 24 V (manufacturer data)', applicability: 'Manufacturer data: stand and air not stated; air density assumed 1.225 kg/m³.' });
    const storedSet = await store.createItem(projectId, 'measurement-set', measurementSetDraft('T-Motor datasheet', set));
    const fixture = validateAircraftProfile(json('aircraft/tmotor-mn7005-quad.json'));
    const base = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: battery },
      motors: fixture.motors.map(item => ({ ...item, components: { motor, propeller, esc } })) }), [{ card: propeller, polar: 'naca6409-neuralfoil-v1' }]);
    const measured = await bindMeasurements(base, 'measured', [{ sha256: storedSet.sha256, createdAt: storedSet.record.createdAt, set }]);
    const sets = new Map([[storedSet.sha256, set]]);
    const evaluated = await evaluateCalculation(measured, cards, sets);
    expect(evaluated.label).toBe('measured-input');
    expect(evaluated.motors.every(m => m.measurementSet === storedSet.sha256 && m.reason === 'Bench data of this motor, propeller and ESC on a laboratory supply.')).toBe(true);
    const resolved = resolveComponents(measured, cards);
    if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
    const betModuleSha256 = createHash('sha256').update(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm')).digest('hex');
    const calibration = await calibrateMotor({ module, betModuleSha256, profile: measured, components: resolved.components, motorId: 1, set: { sha256: storedSet.sha256, set } });
    // The calibration belongs to the motor's own combination (the profile's battery), not to the set's laboratory key.
    const keys = await motorSetKeys(measured, measured.motors[0]!);
    expect(calibration.combinationKey).toBe(keys?.exact);
    expect(calibration.fit.residuals).toHaveLength(11);
    expect(calibration.measuredOn).toBe('2026-07-28');
    const stored = await savePropulsionCalibration(store, projectId, 'T-Motor MN7005 + P24x7.2', calibration);
    const bound = bindCalibration(measured, stored);
    expect(bound.schemaVersion).toBe(6);
    await store.createItem(projectId, 'aircraft-profile', profileDraft('Forum quad', bound));
    const derived = await deriveVehicleManifest(bound, resolved.components, { modelId: 145 });
    expect((derived.manifest.propulsionCalibrations ?? []).map(item => item.rotorId)).toEqual([1, 2, 3, 4]);
    expect(derived.manifest.datasets.find(dataset => dataset.kind === 'measured')).toMatchObject({ sourceSha256: storedSet.sha256, acquiredAt: '2026-07-28T00:00:00Z' });
  }, 300_000);
});
