import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { ASSUMED_ROOT_RATIO, DEFAULT_STRIPS } from '@mirage/aircraft/propeller-geometry';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { BetFlightDynamics, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { validateModelManifest } from '@mirage/physics/model-manifest';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { catalogPolar } from '@mirage/physics/polar-catalog';
import { validateVehicleManifest, withoutAirframeDrag, withoutHull, withoutLandingGear, type VehicleManifest } from '@mirage/physics/vehicle-manifest';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '@mirage/protocol';
import {
  MTB2_METHOD, averagesOf, conditionKey, isolatedScatter, measureTandem, parseMtb2Positions, parseMtb2Table, withinMeasured,
  type Mtb2Average, type Mtb2Basis, type Mtb2Measured, type Mtb2Point, type Mtb2RotorPosition,
} from '../packages/analysis/src/mtb2-interference.ts';
import { readFirstSheet } from './support/xlsx.ts';

// TASK-101, measured rotor wakes on NASA's MTB2 (SPECS_SIMULATION_ENGINES "Measured rotor wakes: NASA MTB2"). Declared before the
// model's prediction was computed:
//  - on a table built here the measurement gives r, r_c, r_front and the phase −90° ratio written out by hand, takes a point's
//    speed from the largest RPM column, keeps wind-off points only at the housekeeping condition, and the scatter is the RMS of
//    each run over the mean of the runs sharing a condition;
//  - with MIRAGE_MTB2_DIR set, every downloaded file is checked by SHA-256, the rotor positions rotate with the model pitch as
//    the workbook gives them except in the six rows the specification names, the model's front rotor is unchanged by the wakes,
//    and each tandem condition is compared with the model; MIRAGE_MTB2_OUT writes the report. The comparison is shown (SA-01),
//    whatever its outcome.

const HEADER = ['Run', 'Point', ...[1, 2, 3, 4].flatMap(n => [`Fx${n}_H`, `Fy${n}_H`, `Fz${n}_H`, `Mx${n}_H`, `My${n}_H`, `Mz${n}_H`, `RPM_${n}`, `Phase_${n}`]),
  'VFPS', 'Q', 'RHO', 'Pitch', 'Tilt', 'T. Temp'];
/** A table row: thrust and RPM per rotor, phase per rotor ('-' for none). */
function row(run: number, point: number, fz: readonly number[], rpm: readonly number[], phase: readonly string[], q: number, pitch = 0, tilt = 0, rho = 0.00236): string[] {
  const cells = new Map<string, string>([['Run', `${run}`], ['Point', `${point}`], ['VFPS', q === 0 ? '3' : '40'], ['Q', `${q}`], ['RHO', `${rho}`],
    ['Pitch', `${pitch}`], ['Tilt', `${tilt}`], ['T. Temp', '80']]);
  for (let n = 1; n <= 4; n++) {
    for (const name of ['Fx', 'Fy', 'Mx', 'My']) cells.set(`${name}${n}_H`, '0');
    cells.set(`Fz${n}_H`, `${fz[n - 1]}`); cells.set(`Mz${n}_H`, '1'); cells.set(`RPM_${n}`, `${rpm[n - 1]}`); cells.set(`Phase_${n}`, phase[n - 1] ?? '-');
  }
  return HEADER.map(name => cells.get(name) ?? '');
}
const NONE = ['-', '-', '-', '-'], ZERO = ['0', '0', '0', '0'];
function syntheticTable(): string[][] {
  return [['MTB2 Data Tables'], HEADER,
    // Rotor 1 alone (102) and rotor 3 alone (103, 141, 147): every RPM column reads the speed, the stacks without blades read below zero.
    row(102, 1, [2.0, -0.5, -0.4, -0.6], [2000, 2000, 2000, 2000], NONE, 0.02),
    row(102, 2, [6.0, -0.5, -0.4, -0.6], [3000, 3000, 3000, 3000], NONE, 1.9, -5),
    row(102, 3, [6.2, -0.5, -0.4, -0.6], [3001, 3001, 3001, 3001], NONE, 1.92, -5),
    row(103, 1, [-0.5, -0.8, 1.6, -1.1], [2000, 2000, 2000, 2000], NONE, 0.02),
    row(103, 2, [-0.5, -0.8, 5.0, -1.1], [3000, 3000, 3000, 3000], NONE, 1.9, -5, 0, 0.00224),
    row(141, 1, [-0.5, -0.8, 5.5, -1.1], [3000, 3000, 3000, 3000], NONE, 1.9, -5),
    row(147, 1, [-0.5, -0.8, 1.8, -1.1], [2000, 2000, 2000, 2000], NONE, 0.02),
    // Tandem (113): the speed is in the wrong columns, as in the real two-rotor runs; one wind-off point off the housekeeping RPM.
    row(113, 1, [2.3, -0.3, 1.9, -0.5], [2000, 2000, 0, 0], ZERO, 0.01),
    row(113, 2, [6.5, -0.3, 4.0, -0.5], [3000, 3000, 0, 0], ZERO, 1.9, -5),
    row(113, 3, [9.9, -0.3, 9.9, -0.5], [3000, 3000, 0, 0], ZERO, 0.01),
    // Phase −90° (116), one rotor's phase column at −90.
    row(116, 1, [6.5, -0.3, 3.5, -0.5], [3000, 3000, 0, 0], ['0', '-90', '0', '0'], 1.9, -5),
    // A static point: no RPM, no condition.
    row(113, 4, [0, 0, 0, 0], [0, 0, 0, 0], ZERO, 0),
  ];
}

describe('the MTB2 tandem measurement (TASK-101)', () => {
  it('gives r, r_c and r_front per condition, from the largest RPM column, wind-off only at housekeeping', () => {
    const points = parseMtb2Table(syntheticTable());
    expect(points.length).toBe(12);
    const measured = measureTandem(points, 'concept', 'thrust'), byKey = new Map(measured.map(m => [m.key, m]));
    expect(measured.length).toBe(2);
    const forward = byKey.get(conditionKey({ qLevelPsf: 1.9, pitchDeg: -5, tiltDeg: 0, rpm: 3000 }));
    // Rotor 1 alone: the mean of 6.0 and 6.2 lb; rotor 3 alone 5.0 lb; tandem 6.5 and 4.0 lb.
    expect(forward?.frontAlone).toBeCloseTo(6.1, 12);
    expect(forward?.frontAloneCount).toBe(2);
    expect(forward?.r).toBeCloseTo(4.0 / 5.0, 12);
    expect(forward?.rc).toBeCloseTo((4.0 - (6.5 - 6.1)) / 5.0, 12);
    expect(forward?.rFront).toBeCloseTo(6.5 / 6.1, 12);
    expect(forward?.rPhase90).toBeCloseTo(3.5 / 5.0, 12);
    const hover = byKey.get(conditionKey({ qLevelPsf: 0, pitchDeg: 0, tiltDeg: 0, rpm: 2000 }));
    expect(hover?.tandem.count).toBe(1);
    expect(hover?.r).toBeCloseTo(1.9 / 1.6, 12);
    expect(hover?.rc).toBeCloseTo((1.9 - 0.3) / 1.6, 12);
    expect(hover?.rPhase90).toBeNull();
    // The corrected basis divides each point's thrust by its density and squared speed (the largest RPM column) before the ratio.
    const coefficient = measureTandem(points, 'concept', 'coefficient').find(m => m.key === forward?.key);
    const c = (t: number, rho: number, rpm: number) => t / (rho * rpm * rpm);
    expect(coefficient?.r).toBeCloseTo(c(4.0, 0.00236, 3000) / c(5.0, 0.00224, 3000), 12);
    expect(coefficient?.rFront).toBeCloseTo(c(6.5, 0.00236, 3000) / ((c(6.0, 0.00236, 3000) + c(6.2, 0.00236, 3001)) / 2), 12);
    // The scatter: 103 and 141 share the forward condition (5.0, 5.5 lb), 103 and 147 the housekeeping one (1.6, 1.8 lb).
    const s = isolatedScatter(points, 'thrust'), d1 = 5.0 / 5.25 - 1, d2 = 1.6 / 1.7 - 1;
    expect(s.conditions).toBe(2);
    expect(s.deviations).toBe(4);
    expect(s.rms).toBeCloseTo(Math.sqrt((2 * d1 * d1 + 2 * d2 * d2) / 4), 12);
    expect(s.max).toBeCloseTo(Math.abs(d2), 12);
    // Within: inside [min(r, r_c), max(r, r_c)] widened by two scatters, a description, not a verdict.
    expect(withinMeasured(0.75, 0.8, 0.72, 0.01)).toBe(true);
    expect(withinMeasured(0.70, 0.8, 0.72, 0.01)).toBe(true);
    expect(withinMeasured(0.6999, 0.8, 0.72, 0.01)).toBe(false);
    expect(withinMeasured(0.8201, 0.8, 0.72, 0.01)).toBe(false);
  });

  it('refuses a table that lacks a value it reads', () => {
    const table = syntheticTable();
    table[3]![HEADER.indexOf('Fz3_H')] = '';
    expect(() => parseMtb2Table(table)).toThrow(/Fz3_H/);
    expect(() => parseMtb2Table([['no header']])).toThrow(/header/);
  });
});

// The model: the tandem pair on BetFlightDynamics with the MTB2 rotor, held at the measured RPM by a governor.
const HZ = 800, SECONDS = 3, AVERAGE_S = 0.5, SPEED_TOLERANCE = 1e-3, HEAVY = 1e8;
/** NASA/TM-20250004795 table 7.2.2 and table 7.2.1 (blade mass). */
const ROTOR = Object.freeze({ radiusIn: 12.245, chordIn: 1.54, blades: 2, collective75Deg: 6.7, twistDeg: -16, bladeMassSlug: 0.0024 });
const KG_PER_SLUG = 14.5939029372, POLAR = 'naca6409-extended-v1';
const MOTOR = 'a'.repeat(64), PROPELLER = 'b'.repeat(64), ESC = 'c'.repeat(64), BATTERY = 'd'.repeat(64);
let module: WebAssembly.Module;
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
function card(type: string, values: Record<string, number> = {}): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) throw new Error('Invalid card');
  const merged = { ...base.values, ...values };
  return validateComponentCard({ ...base, values: merged, provenance: Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, value === null ? null : 'example'])) });
}
/** The quad-X fixture on stand-in cards that reach 3000 RPM; its manifest supplies the motors, ESCs, battery and datasets. */
async function baseManifest(): Promise<VehicleManifest> {
  const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
  const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY },
    motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }), [{ card: PROPELLER, polar: POLAR }]);
  const cards = new Map([[MOTOR, card('motor', { kvRpmPerV: 300, maxCurrentA: 60 })], [PROPELLER, card('propeller')], [ESC, card('esc', { maxCurrentA: 60 })],
    [BATTERY, card('battery', { maxDischargeCurrentA: 250 })]]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(resolved.missing.join('; '));
  return withoutAirframeDrag(withoutHull(withoutLandingGear((await deriveVehicleManifest(profile, resolved.components, { modelId: 101 })).manifest)));
}
/** The report's blade with the fitted collective offset: absolute pitch at 16 midpoint strips from the assumed root cutout. */
function blades(deltaDeg: number) {
  const R = ROTOR.radiusIn * MTB2_METHOD.metrePerInch, root = ASSUMED_ROOT_RATIO * R, width = (R - root) / DEFAULT_STRIPS;
  const stations = Array.from({ length: DEFAULT_STRIPS }, (_, i) => root + (i + 0.5) * width);
  const mass = ROTOR.bladeMassSlug * KG_PER_SLUG;
  return {
    bladeCount: ROTOR.blades, radiusM: R, rootCutoutM: root, radialStationM: stations,
    chordM: stations.map(() => ROTOR.chordIn * MTB2_METHOD.metrePerInch),
    twistRad: stations.map(r => (ROTOR.collective75Deg + ROTOR.twistDeg * (r / R - 0.75) + deltaDeg) * Math.PI / 180),
    quadratureWidthM: stations.map(() => width),
    // Each blade a uniform bar from root to tip; the hub's inertia is left out (it shapes only the governor's transient).
    shaftInertiaKgM2: ROTOR.blades * mass * (R ** 3 - root ** 3) / (3 * (R - root)),
  };
}
/** wxyz product a ⊗ b. */
const multiply = (a: readonly number[], b: readonly number[]): number[] => {
  const [aw = 1, ax = 0, ay = 0, az = 0] = a, [bw = 1, bx = 0, by = 0, bz = 0] = b;
  return [aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw];
};
const aboutY = (deg: number): number[] => [Math.cos(deg * Math.PI / 360), 0, Math.sin(deg * Math.PI / 360), 0];
/** The two-rotor tandem: rotor 1 in front (counter-clockwise from above), rotor 3 behind (clockwise), at the workbook's pitch-0 hubs. */
function tandemManifest(base: VehicleManifest, positions: readonly Mtb2RotorPosition[], configuration: string, tiltDeg: number, deltaDeg: number): VehicleManifest {
  const hub = (rotor: number): readonly number[] => {
    const found = positions.find(p => p.configuration === configuration && p.pitchDeg === 0 && p.tiltDeg === tiltDeg && p.rotor === rotor);
    if (!found) throw new Error(`No position of rotor ${rotor} in ${configuration} at tilt ${tiltDeg}`);
    return found.xyzIn;
  };
  const p1 = hub(1), p3 = hub(3), mid = [0, 1, 2].map(i => ((p1[i] ?? NaN) + (p3[i] ?? NaN)) / 2);
  // Tunnel (x downstream, y starboard, z up) to body FRD (x forward, y right, z down), metres from the midpoint.
  const body = (p: readonly number[]) => [-((p[0] ?? NaN) - mid[0]!), (p[1] ?? NaN) - mid[1]!, -((p[2] ?? NaN) - mid[2]!)].map(v => v * MTB2_METHOD.metrePerInch);
  const ccw = base.rotors.find(r => r.spinSign === 1), cw = base.rotors.find(r => r.spinSign === -1);
  if (!ccw || !cw) throw new Error('The base manifest needs both spins');
  const geometry = blades(deltaDeg);
  // A negative tilt is nose down: about body y, after the upright hub's own rotation.
  const rotors = [{ ...ccw, ...geometry, hubPositionBodyM: body(p1), hubToBody: multiply(aboutY(tiltDeg), ccw.hubToBody) },
    { ...cw, ...geometry, hubPositionBodyM: body(p3), hubToBody: multiply(aboutY(tiltDeg), cw.hubToBody) }];
  const motors = base.motors.filter(m => m.rotorId === ccw.id || m.rotorId === cw.id);
  return validateVehicleManifest({ ...base, rotorCount: 2, rotors, motors, escs: base.escs.filter(e => motors.some(m => m.id === e.motorId)),
    rotorWakePairs: [], ardupilot: null });
}
interface Air { readonly speedMps: number; readonly densityKgM3: number; readonly temperatureK: number }
const airOf = (a: Mtb2Average): Air => ({ speedMps: a.speedFps * MTB2_METHOD.metrePerFoot, densityKgM3: a.densitySlugFt3 * MTB2_METHOD.kgM3PerSlugFt3,
  temperatureK: (a.totalTemperatureF - 32) * 5 / 9 + 273.15 });
/** Each rotor's thrust (N) with its speed held at `rpm`, the body pitched and flying forward through still air. */
function heldThrust(manifest: VehicleManifest, wakes: 'all' | 'off', air: Air, pitchDeg: number, rpm: number): { thrustN: number[]; speedError: number; flags: number } {
  const t = air.temperatureK, viscosity = 1.458e-6 * t ** 1.5 / (t + 110.4), sound = Math.sqrt(1.4 * 287.05 * t);
  const built = buildProfileDynamics(manifest, { syntheticPad: true, rotorWake: wakes, densityKgM3: air.densityKgM3, viscosityPaS: viscosity, soundMps: sound }).configuration;
  const model = validateModelManifest(built.manifest), target = rpm * Math.PI / 30;
  const q = aboutY(pitchDeg);
  const configuration: BetFlightConfiguration = { ...built, gravityMps2: 0, syntheticGroundDownM: undefined, initialOmegaRadS: model.rotors.map(() => target),
    manifest: { ...structuredClone(built.manifest as object), massKg: model.massKg * HEAVY, inertiaBodyKgM2: model.inertiaBodyKgM2.map(v => v * HEAVY) },
    initialBody: { ...built.initialBody, positionNedM: new Float64Array([0, 0, -100]), velocityNedMps: new Float64Array([air.speedMps, 0, 0]),
      quaternionBodyToNed: new Float64Array(q) } };
  const d = new BetFlightDynamics(module, configuration, HZ);
  try {
    const frame = newActuatorFrameV2(), pilot = newInput(), n = model.rotors.length, dt = 1 / HZ;
    frame.motorMapId = configuration.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed;
    frame.actuatorCount = Math.max(...model.rotors.map(rotor => rotor.motorChannel)) + 1;
    const integral = new Array<number>(n).fill(rpm / 5040), thrust = new Array<number>(n).fill(0), speed = new Array<number>(n).fill(0);
    const ticks = Math.round(SECONDS * HZ), from = ticks - Math.round(AVERAGE_S * HZ);
    let flags = 0;
    for (let tick = 0; tick < ticks; tick++) {
      for (let i = 0; i < n; i++) {
        const e = (target - d.rotorSpeedRadS(i)) / target;
        integral[i] = Math.min(1, Math.max(0, integral[i]! + 8 * e * dt));
        frame.normalizedActuators[model.rotors[i]!.motorChannel] = Math.min(1, Math.max(0, integral[i]! + 1.5 * e));
      }
      d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / HZ; d.stepNow(pilot);
      if (d.fault !== '') throw new Error(d.fault);
      if (tick >= from) {
        flags |= d.validityFlags;
        for (let i = 0; i < n; i++) { thrust[i] = thrust[i]! + d.rotorThrustN(i); speed[i] = speed[i]! + d.rotorSpeedRadS(i); }
      }
    }
    const count = ticks - from;
    return { thrustN: thrust.map(v => v / count), speedError: Math.max(...speed.map(v => Math.abs(v / count / target - 1))), flags };
  } finally { d.dispose(); }
}

const dir = process.env.MIRAGE_MTB2_DIR ?? '';
const present = dir !== '' && MTB2_METHOD.sources.every(source => existsSync(join(dir, source.file)));
describe.skipIf(!present)('NASA MTB2 against the rotor wakes (TASK-101)', () => {
  let points: Mtb2Point[] = [], positions: Mtb2RotorPosition[] = [], base: VehicleManifest;
  beforeAll(async () => {
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
    module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
    const bytes = (file: string): Uint8Array => { const b = readFileSync(join(dir, file)); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
    for (const source of MTB2_METHOD.sources) expect(createHash('sha256').update(bytes(source.file)).digest('hex'), source.file).toBe(source.sha256);
    points = parseMtb2Table(readFirstSheet(bytes('mtbii_data_tables_v2.xlsx')));
    positions = parseMtb2Positions(readFirstSheet(bytes('MTB2_Rotor_Positions_public_v1.xlsx')));
    base = await baseManifest();
  }, 600_000);

  it('reads every table row, and the positions rotate with the model pitch except in the six rows named', () => {
    expect(points.length).toBe(2235);
    expect(positions.length).toBe(120);
    // Each pair's offset (rear minus front, same side) at pitch p is the pitch-0 offset turned nose-down by p about the lateral axis.
    const slips: string[] = [];
    for (const p of positions) {
      if (p.rotor > 2 || p.pitchDeg === 0) continue;
      const at = (pitch: number, rotor: number) => positions.find(q => q.configuration === p.configuration && q.pitchDeg === pitch && q.tiltDeg === p.tiltDeg && q.rotor === rotor)?.xyzIn ?? [NaN, NaN, NaN];
      const zero = [0, 2].map(i => (at(0, p.rotor + 2)[i] ?? NaN) - (at(0, p.rotor)[i] ?? NaN)), now = [0, 2].map(i => (at(p.pitchDeg, p.rotor + 2)[i] ?? NaN) - (p.xyzIn[i] ?? NaN));
      const a = -p.pitchDeg * Math.PI / 180, x = zero[0]! * Math.cos(a) - zero[1]! * Math.sin(a), z = zero[1]! * Math.cos(a) + zero[0]! * Math.sin(a);
      if (Math.hypot(x - now[0]!, z - now[1]!) > 0.01) slips.push(`${p.configuration} pitch ${p.pitchDeg} tilt ${p.tiltDeg} rotor ${p.rotor}`);
    }
    expect(slips.sort()).toEqual(['dz/R = 0 pitch -10 tilt -3 rotor 1', 'dz/R = 0 pitch -10 tilt -3 rotor 2', 'dz/R = 0 pitch -10 tilt 0 rotor 1',
      'dz/R = 0 pitch -10 tilt 0 rotor 2', 'dz/R = 0 pitch -5 tilt -3 rotor 1', 'dz/R = 0 pitch -5 tilt -3 rotor 2']);
  });

  it('compares every tandem condition with the model, and shows it', () => {
    const configurations = MTB2_METHOD.configurations, bases: readonly Mtb2Basis[] = ['thrust', 'coefficient'];
    const scatter: Record<Mtb2Basis, ReturnType<typeof isolatedScatter>> = { thrust: isolatedScatter(points, 'thrust'), coefficient: isolatedScatter(points, 'coefficient') };
    const manifests = new Map<string, VehicleManifest>();
    const manifestFor = (configuration: string, tiltDeg: number, deltaDeg: number): VehicleManifest => {
      const key = `${configuration}|${tiltDeg}|${deltaDeg}`;
      let m = manifests.get(key);
      if (!m) { m = tandemManifest(base, positions, configuration, tiltDeg, deltaDeg); manifests.set(key, m); }
      return m;
    };
    // The collective offset: the model's summed isolated thrust equals the measured sum over 102 (rotor 1) and 103 (rotor 3).
    const concept = configurations[0].positions;
    const fitSet = MTB2_METHOD.fitRuns.flatMap(({ run, rotor }) => [...averagesOf(points, run).values()].filter(a => a.condition.qLevelPsf > 0).map(a => ({ run, rotor, a })));
    const isolated = (deltaDeg: number) => fitSet.map(({ run, rotor, a }) => {
      const held = heldThrust(manifestFor(concept, a.condition.tiltDeg, deltaDeg), 'off', airOf(a), a.condition.pitchDeg, a.condition.rpm);
      expect(held.speedError, `run ${run} ${conditionKey(a.condition)}`).toBeLessThan(SPEED_TOLERANCE);
      return { run, rotor, key: conditionKey(a.condition), measuredLb: a.thrustLb[rotor - 1]!, modelLb: held.thrustN[rotor === 1 ? 0 : 1]! / MTB2_METHOD.newtonPerLb };
    });
    const measuredSum = fitSet.reduce((sum, { rotor, a }) => sum + a.thrustLb[rotor - 1]!, 0);
    const mismatch = (deltaDeg: number) => { const rows = isolated(deltaDeg); return { rows, f: rows.reduce((s, r) => s + r.modelLb, 0) / measuredSum - 1 }; };
    let lo = { delta: 0, ...mismatch(0) }, hi = { delta: -1, ...mismatch(-1) };
    for (let i = 0; i < 8 && Math.abs(hi.f) > 1e-5; i++) {
      const delta = hi.delta - hi.f * (hi.delta - lo.delta) / (hi.f - lo.f);
      lo = hi; hi = { delta, ...mismatch(delta) };
    }
    expect(Math.abs(hi.f)).toBeLessThan(1e-4);
    const deltaDeg = hi.delta, fitted = hi.rows.map(r => ({ ...r, modelOverMeasured: r.modelLb / r.measuredLb }));

    type Shown = Mtb2Measured & { within: boolean };
    const conditions: { measured: Record<Mtb2Basis, Shown>; m: Mtb2Measured; model: { r: number; rFront: number; rearOnLb: number; rearOffLb: number; frontOnLb: number; flags: number } }[] = [];
    for (const configuration of configurations) {
      const corrected = new Map(measureTandem(points, configuration.id, 'coefficient').map(x => [x.key, x]));
      for (const m of measureTandem(points, configuration.id, 'thrust')) {
        const manifest = manifestFor(configuration.positions, m.condition.tiltDeg, deltaDeg), air = airOf(m.tandem);
        const on = heldThrust(manifest, 'all', air, m.condition.pitchDeg, m.condition.rpm), off = heldThrust(manifest, 'off', air, m.condition.pitchDeg, m.condition.rpm);
        expect(Math.max(on.speedError, off.speedError), `${configuration.id} ${m.key}`).toBeLessThan(SPEED_TOLERANCE);
        // Nothing flows upstream: the model's front rotor gives the same thrust with the wakes on, to the governor's hold of its speed
        // (the rotors share one battery bus, so the rear rotor's load moves the front one's duty).
        expect(Math.abs(on.thrustN[0]! / off.thrustN[0]! - 1), `${configuration.id} ${m.key}`).toBeLessThan(1e-5);
        const r = on.thrustN[1]! / off.thrustN[1]!, c = corrected.get(m.key);
        if (!c) throw new Error(`No corrected value at ${m.key}`);
        const shown = (x: Mtb2Measured): Shown => ({ ...x, within: withinMeasured(r, x.r, x.rc, scatter[x.basis].rms) });
        conditions.push({ m, measured: { thrust: shown(m), coefficient: shown(c) },
          model: { r, rFront: on.thrustN[0]! / off.thrustN[0]!, rearOnLb: on.thrustN[1]! / MTB2_METHOD.newtonPerLb,
            rearOffLb: off.thrustN[1]! / MTB2_METHOD.newtonPerLb, frontOnLb: on.thrustN[0]! / MTB2_METHOD.newtonPerLb, flags: on.flags | off.flags } });
      }
    }
    expect(conditions.length).toBeGreaterThan(100);
    const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const summary = bases.flatMap(basis => configurations.flatMap(c => MTB2_METHOD.qLevelsPsf.map(q => {
      const at = conditions.filter(x => x.m.configuration === c.id && x.m.condition.qLevelPsf === q), of = at.map(x => x.measured[basis]);
      return { basis, configuration: c.id, qLevelPsf: q, conditions: at.length, within: of.filter(x => x.within).length,
        meanR: mean(of.map(x => x.r)), meanRc: mean(of.map(x => x.rc)), meanRFront: mean(of.map(x => x.rFront)), meanModelR: mean(at.map(x => x.model.r)),
        minR: Math.min(...of.map(x => x.r)), minModelR: Math.min(...at.map(x => x.model.r)) };
    })));
    const ratios = (x: Shown) => ({ frontTandem: x.frontTandem, rearTandem: x.rearTandem, frontAlone: x.frontAlone, rearAlone: x.rearAlone,
      r: x.r, rc: x.rc, rFront: x.rFront, rPhase90: x.rPhase90, within: x.within });
    const out = process.env.MIRAGE_MTB2_OUT;
    if (out) {
      writeFileSync(out, `${JSON.stringify({
        schemaVersion: 1, kind: 'mtb2-rotor-wake', task: 'TASK-101', status: 'SHOWN',
        source: 'Conley et al., Multirotor Test Bed Second Wind Tunnel Entry Data Report, NASA/TM-20250004795, May 2025 (US Government work, public domain)',
        files: MTB2_METHOD.sources, method: MTB2_METHOD,
        model: { dynamics: 'BetFlightDynamics, ESC drive, dynamic inflow', hz: HZ, seconds: SECONDS, averageS: AVERAGE_S, speedTolerance: SPEED_TOLERANCE, heavy: HEAVY,
          rotor: ROTOR, rootCutoutOfRadius: ASSUMED_ROOT_RATIO, strips: DEFAULT_STRIPS, polar: POLAR, polarSha256: catalogPolar(POLAR)?.sha256 ?? null,
          collectiveOffsetDeg: deltaDeg, cards: { kvRpmPerV: 300, motorAndEscCurrentA: 60, battery: 'example 4S' } },
        scatter, isolatedFit: { measuredSumLb: measuredSum, points: fitted.length,
          rmsModelOverMeasured: Math.sqrt(mean(fitted.map(r => (r.modelOverMeasured - 1) ** 2))),
          minModelOverMeasured: Math.min(...fitted.map(r => r.modelOverMeasured)), maxModelOverMeasured: Math.max(...fitted.map(r => r.modelOverMeasured)), rows: fitted },
        summary,
        conditions: conditions.map(x => ({ configuration: x.m.configuration, ...x.m.condition, tandemPoints: x.m.tandem.count, frontAlonePoints: x.m.frontAloneCount,
          rearAlonePoints: x.m.rearAloneCount, speedFps: x.m.tandem.speedFps, densitySlugFt3: x.m.tandem.densitySlugFt3,
          declared: ratios(x.measured.thrust), corrected: ratios(x.measured.coefficient), model: x.model })),
      }, null, 2)}\n`);
    }
  }, 3_600_000);
});
