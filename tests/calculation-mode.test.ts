// TASK-140 (S04, S15): bench CSV v2, measurement sets bound to one motor,
// propeller, ESC and power-supply combination, the calculation mode of an
// aircraft profile and the TASK-133 confidence labels. Oracles: a bench file
// generated with 50-digit decimal arithmetic from known coefficients and the
// ideal-gas density with the ICAO specific gas constant of dry air, SHA-256
// of the canonical combination computed with node:crypto, and hand-built
// profiles whose bound and unbound motors are known in advance.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { formatBenchCsv, importBenchCsv, importBenchMeasurements, MAX_BENCH_POINTS } from '../packages/physics/src/bench-import.ts';
import { canonicalBytes } from '../packages/project/src/schema.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';
import { validateComponentCard, type ComponentCard } from '../packages/aircraft/src/components.ts';
import {
  calculationSettings, profileDraft, readAircraftProfile, validateAircraftProfile, type AircraftProfile,
} from '../packages/aircraft/src/profile.ts';
import {
  checkMeasurementCards, combinationKey, measurementSetBench, measurementSetDraft, measurementSetFromBenchCsv,
  measurementSetFromColumns, readMeasurementSet, validateMeasurementSet, type Combination, type MeasurementSet,
} from '../packages/aircraft/src/measurements.ts';
import {
  bindMeasurements, checkProfileMeasurements, evaluateCalculation, motorCombination, weakestLabel,
} from '../packages/aircraft/src/calculation-mode.ts';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const BENCH = read('./fixtures/components/bench-combination.csv');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const relative = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected);

// The fixture: CT = 0.11, CP = 0.045, D = 0.254 m, 293.15 K and 101325 Pa,
// 16 V and a motor and ESC efficiency of 0.8, printed with 12 significant digits,
// so 1e-10 relative bounds every recovered value. The density follows the ideal
// gas law with R = 287.05287 J/(kg·K) of ICAO Doc 7488, the standard of the
// repository's atmosphere. (The US Standard Atmosphere 1976 value R*/M0 =
// 287.0531 differs by 7.0e-7; a first fixture built on it failed this test.)
const ORACLE_TOLERANCE = 1e-10;
const ORACLE_DENSITY = 101325 / (287.05287 * 293.15);

function card(name: string, change?: (card: Mutable<ComponentCard>) => void): ComponentCard {
  const parsed: unknown = JSON.parse(read(`./fixtures/components/${name}.json`));
  const copy = structuredClone(validateComponentCard(parsed)) as Mutable<ComponentCard>;
  change?.(copy);
  return validateComponentCard(copy);
}
/** Cards addressed by fake but well-formed SHA-256 values, as profiles and sets reference them. */
const ADDRESS = { motor: 'a1'.repeat(32), propA: 'b1'.repeat(32), propB: 'b2'.repeat(32), esc: 'c1'.repeat(32), battery: 'd1'.repeat(32),
  motor2: 'a2'.repeat(32), esc2: 'c2'.repeat(32), battery2: 'd2'.repeat(32) };
const PROP_B = card('propeller-example', c => { Reflect.set(c.values, 'diameterM', 0.2286); });
const CARDS = new Map<string, ComponentCard>([
  [ADDRESS.motor, card('motor-example')], [ADDRESS.propA, card('propeller-example')], [ADDRESS.propB, PROP_B],
  [ADDRESS.esc, card('esc-example')], [ADDRESS.battery, card('battery-example')],
  [ADDRESS.motor2, card('motor-example', c => { Reflect.set(c.values, 'massKg', 0.11); })],
  [ADDRESS.esc2, card('esc-example', c => { Reflect.set(c.values, 'massKg', 0.009); })],
  [ADDRESS.battery2, card('battery-example', c => { Reflect.set(c.values, 'massKg', 0.53); })],
]);
const COMBINATION_A: Combination = { motor: ADDRESS.motor, propeller: ADDRESS.propA, esc: ADDRESS.esc, supply: { kind: 'battery', card: ADDRESS.battery } };
const LABORATORY_B: Combination = { motor: ADDRESS.motor, propeller: ADDRESS.propB, esc: ADDRESS.esc, supply: { kind: 'laboratory' } };

/** Quad X: motors 1 and 2 turn propeller A, motors 3 and 4 propeller B; one motor, ESC and battery card. */
function quad(change?: (profile: Mutable<AircraftProfile>) => void, fixture = 'quad-x'): AircraftProfile {
  const parsed: unknown = JSON.parse(read(`./fixtures/aircraft/${fixture}.json`));
  const profile = structuredClone(validateAircraftProfile(parsed)) as Mutable<AircraftProfile>;
  for (const motor of profile.motors) {
    motor.components = { motor: ADDRESS.motor, propeller: motor.id <= profile.motors.length / 2 ? ADDRESS.propA : ADDRESS.propB, esc: ADDRESS.esc };
  }
  profile.battery.card = ADDRESS.battery;
  change?.(profile);
  return validateAircraftProfile(profile);
}
async function benchSet(combination = COMBINATION_A): Promise<MeasurementSet> {
  return measurementSetFromBenchCsv(BENCH, {
    combination, fileName: 'bench-combination.csv', date: '2026-10-29', description: 'Synthetic thrust stand run', applicability: null,
  });
}
function thrustOnly(combination: Combination, diameterM: number): MeasurementSet {
  return measurementSetFromColumns({
    combination, diameterM, date: '2026-10-29', description: null, applicability: 'Static hover range only.',
    conditions: { airDensityKgM3: 1.2, airTemperatureK: null, airPressurePa: null, supplyVoltageV: null },
    columns: { rpm: [3000, 6000], thrustN: [1.3, 5.2], torqueNm: null, voltageV: null, currentA: null },
  });
}
const v2Text = (conditions: readonly string[], header: string, rows: readonly string[]) =>
  ['mirage-bench-csv,2', 'diameterM,0.254', ...conditions, header, ...rows].join('\n') + '\n';

describe('bench CSV v2', () => {
  test('recovers the coefficients of the synthetic combination, with density from temperature and pressure', () => {
    const bench = importBenchMeasurements(BENCH), D = 0.254;
    expect(bench.diameterM).toBe(D);
    expect(bench.conditions).toEqual({ airDensityKgM3: null, airTemperatureK: 293.15, airPressurePa: 101325, supplyVoltageV: 16.8 });
    expect(relative(bench.airDensityKgM3, ORACLE_DENSITY)).toBeLessThan(ORACLE_TOLERANCE);
    expect(bench.missing).toEqual([]);
    expect(bench.points.map(point => point.rpm)).toEqual([2000, 3000, 4000, 5000, 6000, 7000, 8000]);
    for (const point of bench.points) {
      const n = point.rpm / 60, shaftPower = 0.045 * ORACLE_DENSITY * n ** 3 * D ** 5;
      expect(relative(point.ct, 0.11)).toBeLessThan(ORACLE_TOLERANCE);
      expect(relative(point.cp!, 0.045)).toBeLessThan(ORACLE_TOLERANCE);
      expect(relative(point.cq!, 0.045 / (2 * Math.PI))).toBeLessThan(ORACLE_TOLERANCE);
      expect(relative(point.shaftPowerW!, shaftPower)).toBeLessThan(ORACLE_TOLERANCE);
      expect(relative(point.electricalPowerW!, shaftPower / 0.8)).toBeLessThan(ORACLE_TOLERANCE);
      expect(relative(point.figureOfMerit!, Math.sqrt(2 / Math.PI) * 0.11 ** 1.5 / 0.045)).toBeLessThan(ORACLE_TOLERANCE);
      expect(point.flags).toEqual([]);
    }
    expect(Object.isFrozen(bench.points[0])).toBe(true);
  });

  test('a quantity that was not measured is an absent column and stays missing', () => {
    const bench = importBenchMeasurements(v2Text(['airDensityKgM3,1.2'], 'rpm,thrustN', ['3000,1.3', '6000,5.2']));
    expect(bench.missing).toEqual(['torqueNm', 'voltageV', 'currentA', 'supplyVoltageV']);
    for (const point of bench.points) {
      expect([point.torqueNm, point.cq, point.cp, point.torqueIsaNm, point.shaftPowerW, point.figureOfMerit]).toEqual([null, null, null, null, null, null]);
      expect([point.voltageV, point.currentA, point.electricalPowerW]).toEqual([null, null, null]);
    }
    expect(relative(bench.points[0]!.ct, 1.3 / (1.2 * 50 ** 2 * 0.254 ** 4))).toBeLessThan(1e-12);
    const current = importBenchMeasurements(v2Text(['airDensityKgM3,1.2', 'supplyVoltageV,12'], 'rpm,thrustN,currentA', ['3000,1.3,2.5']));
    expect(current.missing).toEqual(['torqueNm', 'voltageV']);
    expect(current.points[0]!.currentA).toBe(2.5);
    expect(current.points[0]!.electricalPowerW).toBeNull();
  });

  test('flags a row whose shaft power exceeds its electrical power', () => {
    // Q·ω = 0.05·2π·100 = 31.4 W against V·I = 10 W.
    const bench = importBenchMeasurements(v2Text(['airDensityKgM3,1.2'], 'rpm,thrustN,torqueNm,voltageV,currentA', ['6000,2,0.05,10,1']));
    expect(bench.points[0]!.flags).toEqual(['electrical-power-below-shaft-power']);
  });

  test('formatBenchCsv writes the canonical text, which imports to the same data', () => {
    const bench = importBenchMeasurements(BENCH);
    const columns = {
      rpm: bench.points.map(p => p.rpm), thrustN: bench.points.map(p => p.thrustN), torqueNm: bench.points.map(p => p.torqueNm!),
      voltageV: bench.points.map(p => p.voltageV!), currentA: bench.points.map(p => p.currentA!),
    };
    const text = formatBenchCsv(bench.diameterM, bench.conditions, columns);
    expect(text).toBe(BENCH);
    expect(importBenchMeasurements(text)).toEqual(bench);
  });

  test('version 1 stays readable and converts to measurements when its rows share one density', () => {
    const v1 = read('./fixtures/validation/bench-synthetic.csv');
    expect(importBenchCsv(v1).points).toHaveLength(7);
    // The v1 fixture measures one row at 1.1 kg/m^3 and the others at 1.2, so it cannot form one set.
    expect(() => importBenchMeasurements(v1)).toThrow('different air densities');
    const uniform = importBenchMeasurements(v1.replace(/,1\.1\n/, ',1.2\n').replace(/^(\d+,[^,]+,[^,]+),1\.1$/m, '$1,1.2'));
    expect(uniform.conditions).toEqual({ airDensityKgM3: 1.2, airTemperatureK: null, airPressurePa: null, supplyVoltageV: null });
    expect(uniform.missing).toEqual(['voltageV', 'currentA', 'supplyVoltageV']);
    expect(() => importBenchCsv(BENCH)).toThrow();
  });

  test('files with wrong units, wrong layout or values out of range are rejected', () => {
    const header = 'rpm,thrustN,torqueNm,voltageV,currentA', row = '5000,3.83,0.0633,16,2.59', density = 'airDensityKgM3,1.2';
    const invalid: [string, string, string][] = [
      ['thrust in grams', v2Text([density], 'rpm,thrustG', ['5000,390']), 'column header'],
      ['thrust in kilogram-force', v2Text([density], 'rpm,thrustKgf', ['5000,0.39']), 'column header'],
      ['torque in N·mm', v2Text([density], 'rpm,thrustN,torqueNmm', ['5000,3.83,63.3']), 'column header'],
      ['columns out of order', v2Text([density], 'rpm,thrustN,voltageV,torqueNm', ['5000,3.83,16,0.0633']), 'column header'],
      ['a repeated column', v2Text([density], 'rpm,thrustN,torqueNm,torqueNm', ['5000,3.83,0.0633,0.0633']), 'column header'],
      ['no thrust column', v2Text([density], 'rpm,torqueNm', ['5000,0.0633']), 'column header'],
      ['temperature in °C', v2Text(['airTemperatureK,20', 'airPressurePa,101325'], header, [row]), 'airTemperatureK 20 is outside'],
      ['a Celsius temperature line', v2Text(['airTemperatureC,20', 'airPressurePa,101325'], header, [row]), 'conditions'],
      ['pressure in hPa', v2Text(['airTemperatureK,293.15', 'airPressurePa,1013.25'], header, [row]), 'airPressurePa 1013.25 is outside'],
      ['pressure in kPa', v2Text(['airTemperatureK,293.15', 'airPressurePa,101.325'], header, [row]), 'airPressurePa 101.325 is outside'],
      ['density in lb/ft³', v2Text(['airDensityKgM3,0.0765'], header, [row]), 'airDensityKgM3 0.0765 is outside'],
      ['density and temperature together', v2Text([density, 'airTemperatureK,293.15', 'airPressurePa,101325'], header, [row]), 'conditions'],
      ['temperature without pressure', v2Text(['airTemperatureK,293.15'], header, [row]), 'conditions'],
      ['no conditions', v2Text([], header, [row]), 'conditions'],
      ['supply voltage before density', v2Text(['supplyVoltageV,16.8', density], header, [row]), 'conditions'],
      ['an unknown line', v2Text([density, 'operator,bench'], header, [row]), 'conditions'],
      ['zero supply voltage', v2Text([density, 'supplyVoltageV,0'], header, [row]), 'supplyVoltageV 0 is outside'],
      ['zero rpm', v2Text([density], header, ['0,3.83,0.0633,16,2.59']), 'rpm 0 is outside'],
      ['rpm above 100000', v2Text([density], header, ['120000,3.83,0.0633,16,2.59']), 'rpm 120000 is outside'],
      ['a negative current', v2Text([density], header, ['5000,3.83,0.0633,16,-1']), 'currentA -1 is outside'],
      ['zero voltage', v2Text([density], header, ['5000,3.83,0.0633,0,2.59']), 'voltageV 0 is outside'],
      // A thrust in grams under a newton header gives C_T near 11, a torque in N·mm C_P near 45.
      ['grams in the newton column', v2Text([density], header, ['5000,390,0.0633,16,2.59']), 'thrust coefficient'],
      ['N·mm in the torque column', v2Text([density], header, ['5000,3.83,63.3,16,2.59']), 'power coefficient'],
      ['an empty field', v2Text([density], header, ['5000,3.83,,16,2.59']), 'not a decimal number'],
      ['a short row', v2Text([density], header, ['5000,3.83,0.0633,16']), 'expected 5 fields'],
      ['a long row', v2Text([density], header, ['5000,3.83,0.0633,16,2.59,1']), 'expected 5 fields'],
      ['a zero diameter', v2Text([density], header, [row]).replace('diameterM,0.254', 'diameterM,0'), 'diameter'],
      ['version 3', v2Text([density], header, [row]).replace('mirage-bench-csv,2', 'mirage-bench-csv,3'), 'mirage-bench-csv,1 or mirage-bench-csv,2'],
      ['no rows', v2Text([density], header, []), 'data rows'],
      ['too many rows', v2Text([density], header, Array.from({ length: 4097 }, () => row)), 'data rows'],
    ];
    expect(MAX_BENCH_POINTS).toBe(4096);
    expect(importBenchMeasurements(v2Text([density], header, Array.from({ length: 4096 }, () => row))).points).toHaveLength(4096);
    for (const [label, text, message] of invalid) expect(() => importBenchMeasurements(text), label).toThrow(message);
  });
});

describe('measurement sets', () => {
  test('a set from a bench file keeps the file hash and binds to cards of the right type and diameter', async () => {
    const set = await benchSet();
    expect(set.source).toEqual({ kind: 'file', fileName: 'bench-combination.csv', fileSha256: sha256(BENCH), date: '2026-10-29', description: 'Synthetic thrust stand run' });
    expect(set.diameterM).toBe(0.254);
    expect(set.points.voltageV).toHaveLength(7);
    expect(measurementSetBench(set)).toEqual(importBenchMeasurements(BENCH));
    expect(() => checkMeasurementCards(set, CARDS)).not.toThrow();
    const wrong: [string, Combination, string][] = [
      ['a propeller of another diameter', { ...COMBINATION_A, propeller: ADDRESS.propB }, 'differs from the propeller card'],
      ['a propeller card as the motor', { ...COMBINATION_A, motor: ADDRESS.propA }, 'The motor card of the combination is a propeller card'],
      ['an ESC card as the battery', { ...COMBINATION_A, supply: { kind: 'battery', card: ADDRESS.esc } }, 'The battery card of the combination is an ESC card'],
      ['a missing card', { ...COMBINATION_A, esc: 'e9'.repeat(32) }, 'is not available'],
    ];
    for (const [label, combination, message] of wrong) {
      expect(() => checkMeasurementCards(validateMeasurementSet({ ...set, combination }), CARDS), label).toThrow(message);
    }
  });

  test('payload checks repeat the bench rules and the source rules', async () => {
    const set = structuredClone(await benchSet()) as Mutable<MeasurementSet>;
    const invalid: [string, (s: Mutable<MeasurementSet>) => void, string][] = [
      ['other units', s => { Reflect.set(s, 'units', 'imperial'); }, 'Invalid measurement set'],
      ['an unknown field', s => { Reflect.set(s, 'operator', 'me'); }, 'Invalid measurement set'],
      ['a zero rpm', s => { s.points.rpm[2] = 0; }, 'rpm 0 is outside'],
      ['a temperature in °C', s => { s.conditions.airTemperatureK = 20; }, 'airTemperatureK 20 is outside'],
      ['density with temperature and pressure', s => { s.conditions.airDensityKgM3 = 1.2; }, 'but not both'],
      ['temperature without pressure', s => { s.conditions.airPressurePa = null; }, 'but not both'],
      ['unequal columns', s => { s.points.thrustN.pop(); }, 'one value per rpm'],
      ['a file without its hash', s => { s.source.fileSha256 = null; }, 'file source needs its name and SHA-256'],
      ['a manual entry with a file hash', s => { s.source.kind = 'manual'; }, 'manual entry has no file'],
      ['31 April', s => { s.source.date = '2026-04-31'; }, 'not a calendar date'],
      ['no date', s => { Reflect.set(s.source, 'date', null); }, 'Invalid measurement set'],
      ['too many points', s => {
        for (const key of ['rpm', 'thrustN', 'torqueNm', 'voltageV', 'currentA'] as const) {
          const column = s.points[key]!;
          Reflect.set(s.points, key, Array.from({ length: 4097 }, (_, i) => column[i % column.length]!));
        }
      }, 'Invalid measurement set'],
    ];
    for (const [label, change, message] of invalid) {
      const copy = structuredClone(set);
      change(copy);
      expect(() => validateMeasurementSet(copy), label).toThrow(message);
    }
    expect(Object.isFrozen(validateMeasurementSet(set).points.rpm)).toBe(true);
  });

  test('the combination key is the SHA-256 of the canonical combination and changes with every element', async () => {
    const key = await combinationKey(COMBINATION_A);
    expect(key).toBe(sha256(canonicalBytes(COMBINATION_A)));
    const variants: Combination[] = [
      { ...COMBINATION_A, motor: ADDRESS.motor2 }, { ...COMBINATION_A, propeller: ADDRESS.propB }, { ...COMBINATION_A, esc: ADDRESS.esc2 },
      { ...COMBINATION_A, supply: { kind: 'battery', card: ADDRESS.battery2 } }, { ...COMBINATION_A, supply: { kind: 'laboratory' } },
    ];
    const keys = await Promise.all(variants.map(combinationKey));
    expect(new Set([key, ...keys]).size).toBe(6);
  });

  test('sets are store records that depend on their cards and travel in project archives', async () => {
    let ids = 0;
    const options = {
      now: () => new Date(Date.UTC(2026, 9, 29, 12)), storage: null,
      uuid: () => `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, '0')}`,
      validators: { 'component-card': validateComponentCard, 'aircraft-profile': validateAircraftProfile, 'measurement-set': validateMeasurementSet },
    };
    const store = new ProjectStore(new MemoryBackend(), options);
    const project = await store.createProject('Bench');
    const stored = new Map<string, string>();
    for (const [name, address] of [['motor', ADDRESS.motor], ['propeller', ADDRESS.propA], ['esc', ADDRESS.esc], ['battery', ADDRESS.battery]] as const) {
      stored.set(address, (await store.createItem(project.record.id, 'component-card', { name, payload: CARDS.get(address) })).sha256);
    }
    const combination: Combination = {
      motor: stored.get(ADDRESS.motor)!, propeller: stored.get(ADDRESS.propA)!, esc: stored.get(ADDRESS.esc)!,
      supply: { kind: 'battery', card: stored.get(ADDRESS.battery)! },
    };
    const set = await benchSet(combination);
    const draft = measurementSetDraft('Bench run 1', set);
    expect(draft.dependencies).toEqual([...stored.values()].sort());
    const record = await store.createItem(project.record.id, 'measurement-set', draft);
    expect(readMeasurementSet(record)).toEqual(set);
    expect(record.record.dependencies.every(dependency => dependency.kind === 'component-card')).toBe(true);
    // A profile in measured mode depends on its cards and its bound set.
    const profile = await bindMeasurements(quad(p => {
      for (const motor of p.motors) motor.components = { motor: combination.motor, propeller: combination.propeller, esc: combination.esc };
      p.battery.card = combination.supply.kind === 'battery' ? combination.supply.card : null;
    }), 'measured', [{ sha256: record.sha256, createdAt: record.record.createdAt, set }]);
    const profileRecord = await store.createItem(project.record.id, 'aircraft-profile', profileDraft('Quad', profile));
    expect(profileRecord.record.dependencies.map(d => d.kind).sort()).toEqual(['component-card', 'component-card', 'component-card', 'component-card', 'measurement-set']);
    expect(readAircraftProfile(profileRecord)).toEqual(profile);
    // Kinds keep their dependency order: a set cannot depend on a profile, nor a card on a set.
    await expect(store.createItem(project.record.id, 'measurement-set', { ...draft, dependencies: [profileRecord.sha256] }))
      .rejects.toThrow('A measurement-set cannot depend on a aircraft-profile');
    await expect(store.createItem(project.record.id, 'component-card', { name: 'card', payload: CARDS.get(ADDRESS.esc), dependencies: [record.sha256] }))
      .rejects.toThrow('A component-card cannot depend on a measurement-set');
    await expect(store.createItem(project.record.id, 'measurement-set', { name: 'broken', payload: { ...set, units: 'imperial' } }))
      .rejects.toThrow('The measurement-set payload is invalid');
    expect(() => readMeasurementSet(profileRecord)).toThrow('not a measurement set');
    // The archive carries the set; a fresh store imports it with its dependencies.
    const exported = await store.exportProject(project.record.id);
    expect(exported.missing).toEqual([]);
    const copy = new ProjectStore(new MemoryBackend(), options);
    const report = await copy.importArchive(exported.archive);
    expect(report.missing).toEqual([]);
    expect((await copy.listItems(project.record.id, 'measurement-set')).map(item => item.sha256)).toEqual([record.sha256]);
  });
});

describe('calculation modes and labels', () => {
  test('schema 1 profiles read as preliminary; schema 2 states its calculation', async () => {
    const v1 = quad();
    expect(v1.schemaVersion).toBe(1);
    expect(calculationSettings(v1)).toEqual({ mode: 'preliminary', measurementSets: [] });
    const set = await benchSet();
    const measured = await bindMeasurements(v1, 'measured', [{ sha256: 'f1'.repeat(32), createdAt: '2026-10-29T12:00:00.000Z', set }]);
    expect(measured.schemaVersion).toBe(2);
    expect(calculationSettings(measured)).toEqual({ mode: 'measured', measurementSets: ['f1'.repeat(32)] });
    const preliminary = await bindMeasurements(measured, 'preliminary', [{ sha256: 'f1'.repeat(32), createdAt: '2026-10-29T12:00:00.000Z', set }]);
    expect(calculationSettings(preliminary)).toEqual({ mode: 'preliminary', measurementSets: [] });
    const base = structuredClone(measured) as Mutable<AircraftProfile>;
    const invalid: [string, unknown, string][] = [
      ['schema 1 with a calculation', { ...base, schemaVersion: 1 }, 'Schema 1 profiles have no calculation'],
      ['schema 2 without a calculation', { ...v1, schemaVersion: 2 }, 'Schema 2 profiles need a calculation'],
      ['preliminary with a bound set', { ...base, calculation: { mode: 'preliminary', measurementSets: ['f1'.repeat(32)] } }, 'binds no measurement set'],
      ['sets out of order', { ...base, calculation: { mode: 'measured', measurementSets: ['f2'.repeat(32), 'f1'.repeat(32)] } }, 'ascending'],
      ['a repeated set', { ...base, calculation: { mode: 'measured', measurementSets: ['f1'.repeat(32), 'f1'.repeat(32)] } }, 'ascending'],
      ['another mode', { ...base, calculation: { mode: 'calibrated', measurementSets: [] } }, 'Invalid aircraft profile'],
      ['schema 3 without a sensor configuration', { ...base, schemaVersion: 3 }, 'Schema 3 profiles need a sensor configuration'],
      ['schema 4', { ...base, schemaVersion: 4 }, '/schemaVersion must be equal to one of the allowed values'],
    ];
    for (const [label, input, message] of invalid) expect(() => validateAircraftProfile(input), label).toThrow(message);
  });

  test('only the exact bound combination becomes measured-input', async () => {
    const setA = await benchSet(), labB = thrustOnly(LABORATORY_B, 0.2286);
    const candidates = [
      { sha256: 'f1'.repeat(32), createdAt: '2026-10-29T12:00:00.000Z', set: setA },
      { sha256: 'f2'.repeat(32), createdAt: '2026-10-29T12:05:00.000Z', set: labB },
    ];
    const profile = await bindMeasurements(quad(), 'measured', candidates);
    // The laboratory-supply set matches no motor of a battery-powered profile, so only set A binds.
    expect(calculationSettings(profile).measurementSets).toEqual(['f1'.repeat(32)]);
    const sets = new Map(candidates.map(c => [c.sha256, c.set]));
    const result = await evaluateCalculation(profile, CARDS, sets);
    expect(result.mode).toBe('measured');
    expect(result.motors.map(m => [m.motorId, m.label, m.measurementSet])).toEqual([
      [1, 'measured-input', 'f1'.repeat(32)], [2, 'measured-input', 'f1'.repeat(32)], [3, 'preliminary', null], [4, 'preliminary', null],
    ]);
    expect(result.label).toBe('preliminary');
    expect(result.motors[2]!.reason).toContain('No measurement set of this combination is bound');
    // A profile that differs from set A in any one card version binds nothing and inherits nothing.
    const changes: [string, (p: Mutable<AircraftProfile>) => void][] = [
      ['another motor version', p => { for (const m of p.motors) m.components.motor = ADDRESS.motor2; }],
      ['another ESC version', p => { for (const m of p.motors) m.components.esc = ADDRESS.esc2; }],
      ['another battery version', p => { p.battery.card = ADDRESS.battery2; }],
      ['another propeller', p => { for (const m of p.motors) m.components.propeller = ADDRESS.propB; }],
    ];
    for (const [label, change] of changes) {
      const other = await bindMeasurements(quad(change), 'measured', candidates);
      expect(calculationSettings(other).measurementSets, label).toEqual([]);
      const labels = (await evaluateCalculation(other, CARDS, sets)).motors.map(m => m.label);
      expect(labels, label).toEqual(['preliminary', 'preliminary', 'preliminary', 'preliminary']);
      // Keeping the old binding after such an edit is refused rather than applied to the new combination.
      const stale = validateAircraftProfile({ ...structuredClone(other), calculation: { mode: 'measured', measurementSets: ['f1'.repeat(32)] } });
      await expect(checkProfileMeasurements(stale, sets), label).rejects.toThrow('matches no motor');
    }
    // Preliminary mode labels every motor preliminary even with matching data available.
    const preliminary = await evaluateCalculation(await bindMeasurements(profile, 'preliminary', candidates), CARDS, sets);
    expect(preliminary.motors.map(m => [m.label, m.measurementSet, m.limits.length, m.reason])).toEqual(
      Array(4).fill(['preliminary', null, 0, 'Preliminary calculation: specifications and geometry only.']));
    expect(preliminary.limits).toEqual(['No label certifies exported settings for real flight.']);
    // With every combination measured, the aircraft label rises to measured-input.
    const setB = await measurementSetFromBenchCsv(BENCH.replace('diameterM,0.254', 'diameterM,0.2286'), {
      combination: { ...COMBINATION_A, propeller: ADDRESS.propB }, fileName: 'b.csv', date: '2026-10-29', description: null, applicability: null,
    });
    const all = [...candidates, { sha256: 'f3'.repeat(32), createdAt: '2026-10-29T12:10:00.000Z', set: setB }];
    const both = await bindMeasurements(quad(), 'measured', all);
    const evaluated = await evaluateCalculation(both, CARDS, new Map(all.map(c => [c.sha256, c.set])));
    expect([evaluated.label, ...evaluated.motors.map(m => m.label)]).toEqual(Array(5).fill('measured-input'));
  });

  test('missing quantities are listed and never filled in', async () => {
    const thrustA = thrustOnly(COMBINATION_A, 0.254);
    const sets = new Map([['f1'.repeat(32), thrustA]]);
    const profile = await bindMeasurements(quad(), 'measured', [{ sha256: 'f1'.repeat(32), createdAt: '2026-10-29T12:00:00.000Z', set: thrustA }]);
    const result = await evaluateCalculation(profile, CARDS, sets);
    const bound = result.motors[0]!, unbound = result.motors[3]!;
    expect(bound.label).toBe('measured-input');
    expect(bound.missing).toEqual([
      'propeller: hubDiameterM', 'propeller: chord', 'propeller: twist', 'propeller: airfoil',
      'measurements: torqueNm', 'measurements: voltageV', 'measurements: currentA', 'measurements: supplyVoltageV',
    ]);
    expect(unbound.missing).toEqual(['propeller: hubDiameterM', 'propeller: chord', 'propeller: twist', 'propeller: airfoil']);
    expect(measurementSetBench(thrustA).points.map(p => p.cp)).toEqual([null, null]);
    // A motor without a selected propeller lists the card as missing and cannot bind.
    const partial = quad(p => { p.motors[3]!.components.propeller = null; });
    const partialResult = await evaluateCalculation(await bindMeasurements(partial, 'measured', []), CARDS, new Map());
    expect(partialResult.motors[3]!.missing).toEqual(['propeller card']);
    expect(partialResult.motors[3]!.reason).toContain('not selected');
    expect(motorCombination(partial, partial.motors[3]!)).toBeNull();
    // Without a battery card no motor has a complete combination: the supply is part of it.
    const noBattery = quad(p => { p.battery.card = null; });
    expect(noBattery.motors.map(m => motorCombination(noBattery, m))).toEqual([null, null, null, null]);
    const noBatteryResult = await evaluateCalculation(await bindMeasurements(noBattery, 'measured', [
      { sha256: 'f1'.repeat(32), createdAt: '2026-10-29T12:00:00.000Z', set: thrustA },
    ]), CARDS, sets);
    expect(noBatteryResult.motors.map(m => [m.label, m.missing.at(-1)])).toEqual(Array(4).fill(['preliminary', 'battery card']));
  });

  test('limits of use: the measured rpm range, static data and coaxial pairs', async () => {
    const set = await benchSet();
    const coaxial = quad(undefined, 'coaxial-x8');
    // Motors 1 to 4 (upper) turn propeller A and sit in coaxial pairs with motors 5 to 8.
    const profile = await bindMeasurements(coaxial, 'measured', [{ sha256: 'f1'.repeat(32), createdAt: '2026-10-29T12:00:00.000Z', set }]);
    const result = await evaluateCalculation(profile, CARDS, new Map([['f1'.repeat(32), set]]));
    const limits = result.motors[0]!.limits.join(' ');
    expect(limits).toContain('2000 to 8000 rpm');
    expect(limits).toContain('1800 to 8800 rpm');
    expect(limits).toContain('forward flight or descent');
    expect(limits).toContain('coaxial pair');
    expect(result.limits.join(' ')).toContain('does not certify the aircraft');
    expect(weakestLabel(['flight-checked', 'measured-input'])).toBe('measured-input');
    expect(weakestLabel(['flight-checked', 'preliminary', 'measured-input'])).toBe('preliminary');
    expect(() => weakestLabel([])).toThrow();
  });

  test('a measured profile is checked against its bound sets', async () => {
    const setA = await benchSet();
    const profile = await bindMeasurements(quad(), 'measured', [{ sha256: 'f1'.repeat(32), createdAt: '2026-10-29T12:00:00.000Z', set: setA }]);
    await expect(checkProfileMeasurements(profile, new Map())).rejects.toThrow('is not available');
    const twice = validateAircraftProfile({ ...structuredClone(profile), calculation: { mode: 'measured', measurementSets: ['f1'.repeat(32), 'f2'.repeat(32)] } });
    await expect(checkProfileMeasurements(twice, new Map([['f1'.repeat(32), setA], ['f2'.repeat(32), setA]]))).rejects.toThrow('bind the same combination');
    // With two sets of one combination available, the newest binds and is named in the result.
    const older = { sha256: 'f2'.repeat(32), createdAt: '2026-10-28T09:00:00.000Z', set: setA };
    const newer = { sha256: 'f1'.repeat(32), createdAt: '2026-10-29T12:00:00.000Z', set: setA };
    expect(calculationSettings(await bindMeasurements(quad(), 'measured', [older, newer])).measurementSets).toEqual(['f1'.repeat(32)]);
  });
});
