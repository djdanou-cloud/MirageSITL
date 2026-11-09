import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { DEFAULT_STRIPS } from '@mirage/aircraft/propeller-geometry';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { BetFlightDynamics, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { validateModelManifest } from '@mirage/physics/model-manifest';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { boundCatalogPolar, catalogPolar } from '@mirage/physics/polar-catalog';
import { validateVehicleManifest, withoutAirframeDrag, withoutHull, withoutLandingGear, type VehicleManifest } from '@mirage/physics/vehicle-manifest';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '@mirage/protocol';
import { BOUND_V2, BOUND_V2_OUTPUT_SLOTS } from '../packages/wasm-bet/src/rotor-v2.ts';
import {
  HARRINGTON_DRAG_VARIANT, HARRINGTON_METHOD, dragScaledPolar, evaluateTorque, fitDragScale, fitTorque, measuredKappa, pointsOf, reproduced, torqueAt,
  validateHarringtonFixture, type DragFitStep, type HarringtonFixture, type HarringtonRotor, type SweepPoint, type TorqueFit,
} from '../packages/analysis/src/harrington-coaxial.ts';

// TASK-101, measured coaxial rotors (SPECS_SIMULATION_ENGINES "Measured coaxial rotors: NACA TN 2318"). Declared before the
// model's prediction was computed:
//  - the measurement's arithmetic against values written out by hand: the torque fit returns the coefficients of points on
//    its own curve, kappa and its induced share are the ratios defined, the model's sweep is read linearly in C_T;
//  - the fixture is the declared one (SHA-256), and the digitized points reproduce what the report's text states: the
//    coaxial rotor 1's profile torque coefficient 0.0000777 at C_T = 0 and the maximum figures of merit 0.635 and 0.615;
//  - with MIRAGE_HARRINGTON=1, each configuration runs through BetFlightDynamics as declared, and MIRAGE_HARRINGTON_OUT
//    writes the report. The comparison is shown, whatever its outcome.
// The second variant (declared 2026-11-09 before its prediction): each rotor's section drag scaled by one factor fitted on
// its single rotors only, then every sweep again against the same measured values and bands.

const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const fixtureBytes = readFileSync(new URL('./fixtures/rotors/harrington-coaxial.json', import.meta.url));
const fixture: HarringtonFixture = validateHarringtonFixture(JSON.parse(fixtureBytes.toString('utf8')));
/** The figure of merit as the report defines it, M = 0.707 C_T^1.5 / C_Q. */
const figureOfMerit = (ct: number, cq: number) => 0.707 * Math.max(ct, 0) ** 1.5 / cq;

describe('the Harrington measurement (TASK-101)', () => {
  it('fits, divides and interpolates as declared', () => {
    // Points on C_Q = 1e-4 + 0.6 C_T^1.5 + 2 C_T^2 give back those coefficients, with no residual.
    const truth = [1e-4, 0.6, 2], cts = [0.001, 0.002, 0.003, 0.004, 0.005];
    const on = cts.map(ct => ({ ct, cq: truth[0]! + truth[1]! * ct ** 1.5 + truth[2]! * ct * ct }));
    const fit = fitTorque(on);
    fit.coefficients.forEach((c, i) => expect(c).toBeCloseTo(truth[i]!, 9));
    expect(fit.rmsRelative).toBeLessThan(1e-9);
    expect(evaluateTorque(fit, 0.0025)).toBeCloseTo(1e-4 + 0.6 * 0.0025 ** 1.5 + 2 * 0.0025 ** 2, 12);
    expect(() => fitTorque(on.slice(0, 3))).toThrow(/more than 3/);
    // kappa: a coaxial point at C_T 0.004, C_Q 5e-4 over two single rotors at 0.002.
    const coaxialFit = { ...fit, coefficients: [2e-4, 0, 0] };
    const single = fitTorque(on);
    const [k] = measuredKappa([{ ct: 0.004, cq: 5e-4, uCt: 0, uCq: 0 }], coaxialFit, single, 0.002);
    const singleCq = 1e-4 + 0.6 * 0.002 ** 1.5 + 2 * 0.002 ** 2;
    expect(k?.kappa).toBeCloseTo(5e-4 / (2 * singleCq), 12);
    expect(k?.kappaInduced).toBeCloseTo((5e-4 - 2e-4) / (2 * (singleCq - 1e-4)), 12);
    // Below minCt, or at a half thrust outside the single fit's range, a point gives none.
    expect(measuredKappa([{ ct: 0.0019, cq: 5e-4, uCt: 0, uCq: 0 }], coaxialFit, single, 0.002)).toEqual([]);
    expect(measuredKappa([{ ct: 0.0101, cq: 5e-4, uCt: 0, uCq: 0 }], coaxialFit, single, 0.002)).toEqual([]);
    // The sweep is read linearly in C_T, and not outside it.
    const sweep: SweepPoint[] = [{ collectiveDeg: 0, ct: 0, cq: 1e-4 }, { collectiveDeg: 1, ct: 0.001, cq: 1.5e-4 }, { collectiveDeg: 2, ct: 0.003, cq: 3.5e-4 }];
    expect(torqueAt(sweep, 0.002)).toBeCloseTo(2.5e-4, 15);
    expect(torqueAt(sweep, 0.0031)).toBeNull();
    expect(torqueAt(sweep, -0.0001)).toBeNull();
    // The summary rule: within the standard errors and the tolerance, and not beyond.
    expect(reproduced(1.0999, 1.07, 0.005, 0.02, 2)).toBe(true);
    expect(reproduced(1.1001, 1.07, 0.005, 0.02, 2)).toBe(false);
  });

  it('scales the section drag and fits its level as the second variant declares', () => {
    // Every drag coefficient times the scale; lift, axes, confidence and the rotational augmentation as they were.
    const polar = boundCatalogPolar(catalogPolar(HARRINGTON_METHOD.polar)?.numericId ?? NaN);
    expect(polar.rotational).toBeDefined();
    const scaled = dragScaledPolar(polar, 2.5);
    expect(scaled.cd.length).toBe(polar.cd.length);
    polar.cd.forEach((cd, i) => expect(scaled.cd[i]).toBe(cd * 2.5));
    expect(scaled.cl).toBe(polar.cl); expect(scaled.alphaRad).toBe(polar.alphaRad); expect(scaled.reynolds).toBe(polar.reynolds);
    expect(scaled.mach).toBe(polar.mach); expect(scaled.confidence).toBe(polar.confidence); expect(scaled.rotational).toEqual(polar.rotational);
    expect(() => dragScaledPolar(polar, 4.01)).toThrow(/0.25 to 4/);
    expect(() => dragScaledPolar(polar, 0.2)).toThrow(/0.25 to 4/);
    // The secant method from 1 and 2: a residual linear in the scale is solved in one step.
    const linear = fitDragScale(scale => 0.4 * scale - 0.86);
    expect(linear.scale).toBeCloseTo(2.15, 12);
    expect(linear.steps.map(s => s.scale)).toEqual([1, 2, linear.scale]);
    // A residual already inside the tolerance at the first start stops there; one that leaves the range or never moves throws.
    expect(fitDragScale(scale => 0.001 * scale).steps).toHaveLength(1);
    expect(() => fitDragScale(scale => 0.01 * scale + 0.1)).toThrow(/left 0.25 to 4/);
    expect(() => fitDragScale(() => 0.5)).toThrow(/No drag-scale fit/);
    // The fits name single rotors of the performance comparison only, and no coaxial series.
    for (const f of HARRINGTON_DRAG_VARIANT.fits) {
      for (const id of f.performance) expect(HARRINGTON_METHOD.performanceConfigurations.find(c => c.id === id)).toMatchObject({ kind: 'single', rotor: f.rotor });
    }
  });

  it('reads the declared fixture, whose points give what the report states', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(HARRINGTON_METHOD.fixture.sha256);
    expect(fixture.series.reduce((n, s) => n + s.points.length, 0)).toBe(95);
    // Report text: "the profile torque coefficient C_Q0 at C_T = 0 of the coaxial arrangement (0.0000777)", rotor 1 at 500 ft/s.
    const coaxial = pointsOf(fixture, ['r1-coaxial-500']), lowest = coaxial.reduce((a, b) => (Math.abs(b.ct) < Math.abs(a.ct) ? b : a));
    expect(Math.abs(lowest.ct)).toBeLessThan(5e-5);
    expect(Math.abs(lowest.cq - 0.0000777)).toBeLessThan(2 * lowest.uCq + 1e-6);
    // "The maximum figures of merit were about 0.635 and 0.615 for the coaxial and single rotors" (rotor 1); points scatter about the curve.
    const best = (ids: string[]) => Math.max(...pointsOf(fixture, ids).map(p => figureOfMerit(p.ct, p.cq)));
    expect(Math.abs(best(['r1-coaxial-500']) - 0.635)).toBeLessThan(0.02);
    expect(Math.abs(best(['r1-single-lower-500', 'r1-single-upper-500', 'r1-single-unidentified-500']) - 0.615)).toBeLessThan(0.02);
    // The text's solidities follow from the digitized chord: sigma = b c_e / (pi R), c_e the thrust-weighted chord from 0 to R.
    const r1 = fixture.rotors.find(r => r.rotor === 1);
    if (!r1) throw new Error('No rotor 1');
    const ce = r1.chordC0In + r1.chordSlopeInPerIn * 0.75 * r1.radiusIn;
    expect(Math.abs(2 * ce / (Math.PI * r1.radiusIn) - 0.027)).toBeLessThan(0.0005);
    // Rotor 2: constant 18-in chord, sigma = 2 c / (pi R) = 0.076 single.
    const r2 = fixture.rotors.find(r => r.rotor === 2);
    expect(Math.abs(2 * (r2?.chordC0In ?? NaN) / (Math.PI * 150) - 0.076)).toBeLessThan(0.0005);
  });
});

// The model: each configuration on BetFlightDynamics with the report's blades, held at the tip speed by a governor.
const IN = HARRINGTON_METHOD.metrePerInch, FT = HARRINGTON_METHOD.metrePerFoot, HEAVY = 1e8, HEIGHT_M = 2000;
const MOTOR = 'a'.repeat(64), PROPELLER = 'b'.repeat(64), ESC = 'c'.repeat(64), BATTERY = 'd'.repeat(64);
/**
 * A stand-in drive that holds a 25-ft rotor's speed: k_t = 60 / (2 pi KV) = 9.55 N m/A, a 1000 V bus, limits far above the
 * load. At a held speed the rotor's loads do not depend on it.
 */
const DRIVE = Object.freeze({ kvRpmPerV: 1, resistanceOhm: 0.02, currentLimitA: 5000, escUpdateRateHz: 800, brakeCurrentLimitA: 5000,
  battery: { openCircuitFullV: 1000, openCircuitEmptyV: 950, internalResistanceOhm: 0.001, capacityAh: 1e5, currentLimitA: 1e6 } });
let module: WebAssembly.Module;
function card(type: string): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) throw new Error('Invalid card');
  return validateComponentCard({ ...base, provenance: Object.fromEntries(Object.entries(base.values).map(([key, value]) => [key, value === null ? null : 'example'])) });
}
/** The quad-X fixture's manifest on the example cards with the catalog polar: it supplies the rotor records, motors and ESCs that are then replaced. */
async function baseManifest(): Promise<VehicleManifest> {
  const fixtureProfile = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
  const profile = withPropellerPolars(validateAircraftProfile({ ...fixtureProfile, battery: { card: BATTERY },
    motors: fixtureProfile.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }), [{ card: PROPELLER, polar: HARRINGTON_METHOD.polar }]);
  const cards = new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(resolved.missing.join('; '));
  return withoutAirframeDrag(withoutHull(withoutLandingGear((await deriveVehicleManifest(profile, resolved.components, { modelId: 102 })).manifest)));
}
/** The report's blade at a uniform pitch (untwisted): 16 equal strips from the root cutout to the tip. */
function blade(rotor: HarringtonRotor, pitchDeg: number) {
  const R = rotor.radiusIn * IN, root = rotor.rootCutoutIn * IN, width = (R - root) / DEFAULT_STRIPS;
  const stations = Array.from({ length: DEFAULT_STRIPS }, (_, i) => root + (i + 0.5) * width);
  return {
    bladeCount: rotor.blades, radiusM: R, rootCutoutM: root, radialStationM: stations,
    chordM: stations.map(r => (rotor.chordC0In + rotor.chordSlopeInPerIn * r / IN) * IN),
    twistRad: stations.map(() => pitchDeg * Math.PI / 180), quadratureWidthM: stations.map(() => width),
    shaftInertiaKgM2: rotor.blades * HARRINGTON_METHOD.bladeMassKg * (R ** 3 - root ** 3) / (3 * (R - root)),
  };
}
/** Rotor 1's upper rotor turns clockwise from above (the report); rotor 2's sense is not stated and is taken the same. */
function rigManifest(base: VehicleManifest, rotor: HarringtonRotor, kind: 'coaxial' | 'single', upperDeg: number, lowerDeg: number): VehicleManifest {
  const ccw = base.rotors.find(r => r.spinSign === 1), cw = base.rotors.find(r => r.spinSign === -1);
  if (!ccw || !cw) throw new Error('The base manifest needs both spins');
  const half = rotor.hubSpacingFt * FT / 2;
  const lower = { ...ccw, ...blade(rotor, lowerDeg), hubPositionBodyM: [0, 0, half] };
  const upper = { ...cw, ...blade(rotor, upperDeg), hubPositionBodyM: [0, 0, -half] };
  const rotors = kind === 'coaxial' ? [upper, lower] : [lower];
  const motors = base.motors.filter(m => rotors.some(r => r.id === m.rotorId))
    .map(m => ({ id: m.id, rotorId: m.rotorId, kvRpmPerV: DRIVE.kvRpmPerV, resistanceOhm: DRIVE.resistanceOhm, currentLimitA: DRIVE.currentLimitA, noLoadCurrentA: 0 }));
  const escs = base.escs.filter(e => motors.some(m => m.id === e.motorId))
    .map(e => ({ id: e.id, motorId: e.motorId, pwmMinUs: e.pwmMinUs, pwmMaxUs: e.pwmMaxUs, commandTauS: e.commandTauS, updateRateHz: DRIVE.escUpdateRateHz, brakeCurrentLimitA: DRIVE.brakeCurrentLimitA }));
  return validateVehicleManifest({ ...base, rotorCount: rotors.length, rotors, motors, escs, battery: DRIVE.battery, rotorWakePairs: [], ardupilot: null });
}
interface Held { readonly thrustN: number[]; readonly torqueNm: number[]; readonly omegaRadS: number[]; readonly speedError: number; readonly unsteady: number; readonly flags: number }
/** Each rotor's mean thrust and aerodynamic shaft torque with its speed held at `omega`, hovering in still air, ground effect off. */
function held(manifest: VehicleManifest, wakes: 'all' | 'off', omega: number, dragScale: number): Held {
  const { densityKgM3, temperatureK: t } = HARRINGTON_METHOD.air, run = HARRINGTON_METHOD.run;
  const viscosity = 1.458e-6 * t ** 1.5 / (t + 110.4), sound = Math.sqrt(1.4 * 287.05 * t);
  const built = buildProfileDynamics(manifest, { syntheticPad: true, rotorWake: wakes, densityKgM3, viscosityPaS: viscosity, soundMps: sound }).configuration;
  const model = validateModelManifest(built.manifest), n = model.rotors.length;
  // The second variant flies its drag-scaled copy of the polar under the same ID; the first (scale 1) the catalog's as built.
  const polars = dragScale === 1 ? built.polars : new Map([...built.polars].map(([id, polar]) => [id, dragScaledPolar(polar, dragScale)]));
  const configuration: BetFlightConfiguration = { ...built, polars, gravityMps2: 0, syntheticGroundDownM: undefined, initialOmegaRadS: model.rotors.map(() => omega),
    manifest: { ...structuredClone(built.manifest as object), massKg: model.massKg * HEAVY, inertiaBodyKgM2: model.inertiaBodyKgM2.map(v => v * HEAVY) },
    initialBody: { ...built.initialBody, positionNedM: new Float64Array([0, 0, -HEIGHT_M]) } };
  const d = new BetFlightDynamics(module, configuration, run.hz);
  try {
    d.setGroundEffect?.(0);
    const engine = d.escEngine;
    if (!engine) throw new Error('The rig needs the ESC drive');
    const frame = newActuatorFrameV2(), pilot = newInput(), dt = 1 / run.hz;
    frame.motorMapId = configuration.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed;
    frame.actuatorCount = Math.max(...model.rotors.map(rotor => rotor.motorChannel)) + 1;
    const ke = 60 / (2 * Math.PI * DRIVE.kvRpmPerV), half = Math.round(run.hz * run.averageS / 2);
    const integral = new Array<number>(n).fill(omega * ke / DRIVE.battery.openCircuitFullV);
    const sums = [0, 1].map(() => ({ thrust: new Array<number>(n).fill(0), torque: new Array<number>(n).fill(0), speed: new Array<number>(n).fill(0) }));
    const ticks = Math.round(run.seconds * run.hz), from = ticks - 2 * half;
    let flags = 0;
    for (let tick = 0; tick < ticks; tick++) {
      for (let i = 0; i < n; i++) {
        const e = (omega - d.rotorSpeedRadS(i)) / omega;
        integral[i] = Math.min(1, Math.max(0, integral[i]! + 8 * e * dt));
        frame.normalizedActuators[model.rotors[i]!.motorChannel] = Math.min(1, Math.max(0, integral[i]! + 1.5 * e));
      }
      d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / run.hz; d.stepNow(pilot);
      if (d.fault !== '') throw new Error(d.fault);
      if (tick >= from) {
        flags |= d.validityFlags;
        const s = sums[tick < from + half ? 0 : 1]!;
        for (let i = 0; i < n; i++) {
          s.thrust[i]! += d.rotorThrustN(i); s.speed[i]! += d.rotorSpeedRadS(i);
          s.torque[i]! += Math.abs(engine.output[i * BOUND_V2_OUTPUT_SLOTS + BOUND_V2.output.aerodynamicShaftTorque / 8]!);
        }
      }
    }
    const mean = (k: 'thrust' | 'torque' | 'speed', i: number) => (sums[0]![k][i]! + sums[1]![k][i]!) / (2 * half);
    // Steadiness (corrected 2026-11-09 before any result, see the specification): the change between the two halves of the
    // averaged tail of the configuration's summed thrust, against the larger of that thrust and the thrust of C_T 0.001, and of
    // its summed torque. A near-unloaded rotor's own relative change is not a measure of the coefficients compared.
    const total = (k: 'thrust' | 'torque', h: number) => sums[h]![k].reduce((a, b) => a + b, 0) / half;
    const R = model.rotors[0]!.radiusM, thrustAtCt = 0.001 * densityKgM3 * Math.PI * R * R * (omega * R) ** 2;
    return {
      thrustN: model.rotors.map((_, i) => mean('thrust', i)), torqueNm: model.rotors.map((_, i) => mean('torque', i)), omegaRadS: model.rotors.map((_, i) => mean('speed', i)),
      speedError: Math.max(...model.rotors.map((_, i) => Math.abs(mean('speed', i) / omega - 1))),
      unsteady: Math.max(Math.abs(total('thrust', 1) - total('thrust', 0)) / Math.max(Math.abs(total('thrust', 0)), thrustAtCt),
        Math.abs(total('torque', 1) / total('torque', 0) - 1)),
      flags,
    };
  } finally { d.dispose(); }
}
const coefficients = (rotor: HarringtonRotor, h: Held) => {
  const { densityKgM3: rho } = HARRINGTON_METHOD.air, R = rotor.radiusIn * IN, A = Math.PI * R * R;
  return {
    ct: h.thrustN.reduce((s, t, i) => s + t / (rho * A * (h.omegaRadS[i]! * R) ** 2), 0),
    cq: h.torqueNm.reduce((s, q, i) => s + q / (rho * A * (h.omegaRadS[i]! * R) ** 2 * R), 0),
  };
};
interface ModelPoint extends SweepPoint { readonly differentialDeg: number; readonly thrustN: number[]; readonly torqueNm: number[]; readonly unsteady: number; readonly flags: number; readonly trimIterations: number }
/** One collective: a single rotor as it is; a coaxial pair trimmed in yaw by differential collective (secant on the torque ratio). */
function point(base: VehicleManifest, rotor: HarringtonRotor, kind: 'coaxial' | 'single', wakes: 'all' | 'off', omega: number, collectiveDeg: number, dragScale: number): ModelPoint {
  const { run, trim } = HARRINGTON_METHOD;
  const at = (delta: number) => {
    const h = held(rigManifest(base, rotor, kind, collectiveDeg - delta, collectiveDeg + delta), wakes, omega, dragScale);
    if (h.speedError > run.speedTolerance) throw new Error(`Speed not held: ${h.speedError} at ${collectiveDeg} deg`);
    if (h.unsteady > run.steadyTolerance) throw new Error(`Not steady: ${h.unsteady} at ${collectiveDeg} deg`);
    return { delta, h, ratio: kind === 'coaxial' ? h.torqueNm[0]! / h.torqueNm[1]! - 1 : 0 };
  };
  let a = at(0), iterations = 0;
  if (Math.abs(a.ratio) > trim.torqueTolerance) {
    let b = at(trim.firstStepDeg);
    for (iterations = 1; Math.abs(b.ratio) > trim.torqueTolerance; iterations++) {
      if (iterations >= trim.maxIterations || b.ratio === a.ratio) throw new Error(`No yaw trim at ${collectiveDeg} deg: torque ratio ${b.ratio + 1}`);
      const next = b.delta - b.ratio * (b.delta - a.delta) / (b.ratio - a.ratio);
      a = b; b = at(next);
    }
    a = b;
  }
  const c = coefficients(rotor, a.h);
  return { collectiveDeg, differentialDeg: a.delta, ct: c.ct, cq: c.cq, thrustN: a.h.thrustN, torqueNm: a.h.torqueNm, unsteady: a.h.unsteady, flags: a.h.flags, trimIterations: iterations };
}
/** The declared sweep: from the first collective up, until C_T passes `sweepBeyond` times the largest C_T needed or the last collective. */
function sweep(base: VehicleManifest, rotor: HarringtonRotor, kind: 'coaxial' | 'single', wakes: 'all' | 'off', tipSpeedFps: number, ctNeeded: number, dragScale: number): ModelPoint[] {
  const { from, to, step } = HARRINGTON_METHOD.collectiveDeg, omega = tipSpeedFps * FT / (rotor.radiusIn * IN), out: ModelPoint[] = [];
  for (let deg = from; deg <= to + 1e-9; deg += step) {
    const p = point(base, rotor, kind, wakes, omega, deg, dragScale);
    out.push(p);
    if (p.ct > HARRINGTON_METHOD.sweepBeyond * ctNeeded) break;
  }
  return out;
}

const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
describe.skipIf(process.env.MIRAGE_HARRINGTON !== '1')('NACA TN 2318 against the BET rotors and their wakes (TASK-101)', () => {
  let base: VehicleManifest;
  beforeAll(async () => {
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
    module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
    base = await baseManifest();
  }, 600_000);

  it('compares every configuration with the model in both declared variants, and shows them', () => {
    const rotorOf = (n: 1 | 2) => { const r = fixture.rotors.find(x => x.rotor === n); if (!r) throw new Error(`No rotor ${n}`); return r; };
    const fitOf = (ids: readonly string[]) => fitTorque(pointsOf(fixture, ids));
    // C_T each model sweep must reach: a configuration's largest measured C_T, and for a single rotor also half the largest
    // coaxial C_T it is compared with at the same tip speed.
    const needed = new Map<string, number>();
    const need = (key: string, ct: number) => needed.set(key, Math.max(needed.get(key) ?? 0, ct));
    for (const c of HARRINGTON_METHOD.performanceConfigurations) need(`${c.rotor}|${c.kind}|${c.tipSpeedFps}`, Math.max(...pointsOf(fixture, c.series).map(p => p.ct)));
    for (const c of HARRINGTON_METHOD.interferenceConfigurations) {
      const top = Math.max(...pointsOf(fixture, [c.coaxial]).map(p => p.ct));
      need(`${c.rotor}|coaxial|${c.tipSpeedFps}`, top); need(`${c.rotor}|single|${c.tipSpeedFps}`, top / 2);
    }
    // Every sweep, by key, wakes and drag scale, run once: the second variant's fit runs the single-rotor sweeps it then keeps.
    const cache = new Map<string, ModelPoint[]>();
    const sweepFor = (key: string, wakes: 'all' | 'off', dragScale: number): ModelPoint[] => {
      const id = `${key}|${wakes}|${dragScale}`, known = cache.get(id);
      if (known) return known;
      const [rotor, kind, tip] = key.split('|'), ct = needed.get(key);
      if (ct === undefined) throw new Error(`No sweep ${key} is needed`);
      const s = sweep(base, rotorOf(rotor === '1' ? 1 : 2), kind === 'coaxial' ? 'coaxial' : 'single', wakes, Number(tip), ct, dragScale);
      cache.set(id, s);
      return s;
    };
    const sweepsWith = (scaleOf: (rotor: number) => number) => {
      const sweeps = new Map<string, ModelPoint[]>(), sweepsOff = new Map<string, ModelPoint[]>();
      for (const key of needed.keys()) {
        const [rotor, kind] = key.split('|'), scale = scaleOf(Number(rotor));
        sweeps.set(key, sweepFor(key, kind === 'coaxial' ? 'all' : 'off', scale));
        if (kind === 'coaxial') sweepsOff.set(key, sweepFor(key, 'off', scale));
      }
      return { sweeps, sweepsOff };
    };
    const sweepOf = (map: Map<string, ModelPoint[]>, key: string) => { const s = map.get(key); if (!s) throw new Error(`No sweep ${key}`); return s; };
    const singleFitR2 = fitOf(['r2-single-lower-262', 'r2-single-lower-392']);

    // Performance: the model's C_Q at each measured C_T over the measured C_Q.
    const performanceRows = (c: typeof HARRINGTON_METHOD.performanceConfigurations[number], s: readonly ModelPoint[]) =>
      pointsOf(fixture, c.series).map(p => { const model = torqueAt(s, p.ct); return { ...p, modelCq: model, ratio: model === null ? null : model / p.cq }; });
    const usedRatios = (rows: ReturnType<typeof performanceRows>) => rows.filter(r => r.ct >= HARRINGTON_METHOD.performance.minCt && r.ratio !== null).map(r => r.ratio ?? NaN);
    const compare = (sweeps: Map<string, ModelPoint[]>, sweepsOff: Map<string, ModelPoint[]>) => {
      const performance = HARRINGTON_METHOD.performanceConfigurations.map(c => {
        const points = pointsOf(fixture, c.series), rows = performanceRows(c, sweepOf(sweeps, `${c.rotor}|${c.kind}|${c.tipSpeedFps}`));
        const used = usedRatios(rows);
        const fit: TorqueFit = points.length >= HARRINGTON_METHOD.performance.minFitPoints ? fitTorque(points) : singleFitR2;
        const standardError = fit.rmsRelative / Math.sqrt(used.length), meanRatio = mean(used);
        return { id: c.id, rotor: c.rotor, kind: c.kind, tipSpeedFps: c.tipSpeedFps, points: rows.length, used: used.length,
          outsideModelRange: rows.filter(r => r.ratio === null).length, meanRatio, minRatio: Math.min(...used), maxRatio: Math.max(...used),
          scatterRelative: fit.rmsRelative, scatterFrom: fit === singleFitR2 && points.length < HARRINGTON_METHOD.performance.minFitPoints ? 'r2-single-lower-262 and -392 together' : c.id,
          standardError, reproduced: reproduced(meanRatio, 1, standardError, HARRINGTON_METHOD.performance.tolerance, HARRINGTON_METHOD.performance.standardErrors), rows };
      });

      // Interference: kappa measured from the points and the single rotor's fit, and the model's from its own sweeps.
      const interference = HARRINGTON_METHOD.interferenceConfigurations.map(c => {
        const coaxialPoints = pointsOf(fixture, [c.coaxial]), coaxialFit = fitTorque(coaxialPoints), singleFit = fitOf(c.single);
        const coaxial = sweepOf(sweeps, `${c.rotor}|coaxial|${c.tipSpeedFps}`), off = sweepOf(sweepsOff, `${c.rotor}|coaxial|${c.tipSpeedFps}`);
        const single = sweepOf(sweeps, `${c.rotor}|single|${c.tipSpeedFps}`);
        const rows = measuredKappa(coaxialPoints, coaxialFit, singleFit, HARRINGTON_METHOD.interference.minCt).map(m => {
          const on = torqueAt(coaxial, m.ct), alone = torqueAt(single, m.ct / 2), without = torqueAt(off, m.ct);
          const modelKappa = on === null || alone === null ? null : on / (2 * alone);
          return { ...m, modelCoaxialCq: on, modelSingleCq: alone, modelKappa, modelKappaWakesOff: without === null || alone === null ? null : without / (2 * alone) };
        });
        const used = rows.filter(r => r.modelKappa !== null);
        const measured = mean(used.map(r => r.kappa)), model = mean(used.map(r => r.modelKappa ?? NaN));
        const standardError = measured * Math.sqrt(coaxialFit.rmsRelative ** 2 / coaxialPoints.length + singleFit.rmsRelative ** 2 / singleFit.points);
        // The model's induced share, each curve less its C_Q at zero thrust (the sweep's first point, collective 0).
        const q0 = (s: readonly ModelPoint[]) => s[0]?.cq ?? NaN;
        const modelInduced = mean(used.map(r => ((r.modelCoaxialCq ?? NaN) - q0(coaxial)) / (2 * ((r.modelSingleCq ?? NaN) - q0(single)))));
        return { id: c.id, rotor: c.rotor, tipSpeedFps: c.tipSpeedFps, coaxial: c.coaxial, single: c.single, points: rows.length, used: used.length,
          coaxialFit, singleFit, measuredMean: measured, modelMean: model, modelWakesOffMean: mean(used.map(r => r.modelKappaWakesOff ?? NaN)),
          measuredInducedMean: mean(used.map(r => r.kappaInduced)), modelInducedMean: modelInduced, standardError,
          reproduced: reproduced(model, measured, standardError, HARRINGTON_METHOD.interference.tolerance, HARRINGTON_METHOD.interference.standardErrors), rows };
      });
      for (const c of interference) expect(c.used, c.id).toBeGreaterThan(3);
      return { status: interference.every(c => c.reproduced) ? 'REPRODUCED' : 'NOT_REPRODUCED', performanceStatus: performance.every(c => c.reproduced) ? 'REPRODUCED' : 'NOT_REPRODUCED',
        interference: interference.map(({ coaxialFit, singleFit, ...rest }) => ({ ...rest, coaxialFit, singleFit })), performance };
    };

    // The first variant: the catalog polar as it is.
    const first = sweepsWith(() => 1), firstResult = compare(first.sweeps, first.sweepsOff);

    // The second variant: each rotor's drag scale, fitted on its single-rotor points used in the performance comparison only.
    const dragFits = HARRINGTON_DRAG_VARIANT.fits.map(f => {
      const configurations = f.performance.map(id => {
        const c = HARRINGTON_METHOD.performanceConfigurations.find(x => x.id === id);
        if (!c || c.kind !== 'single' || c.rotor !== f.rotor) throw new Error(`The drag fit names ${id}, not a single rotor ${f.rotor}`);
        return c;
      });
      const fitted = fitDragScale(scale => mean(configurations.flatMap(c => usedRatios(performanceRows(c, sweepFor(`${c.rotor}|single|${c.tipSpeedFps}`, 'off', scale))))) - 1);
      const steps: DragFitStep[] = fitted.steps;
      return { rotor: f.rotor, fittedOn: f.performance, dragScale: fitted.scale, steps, iterations: steps.length,
        points: configurations.reduce((n, c) => n + usedRatios(performanceRows(c, sweepFor(`${c.rotor}|single|${c.tipSpeedFps}`, 'off', fitted.scale))).length, 0) };
    });
    const scaleOf = (rotor: number) => { const f = dragFits.find(x => x.rotor === rotor); if (!f) throw new Error(`No drag fit for rotor ${rotor}`); return f.dragScale; };
    const second = sweepsWith(scaleOf), secondResult = compare(second.sweeps, second.sweepsOff);
    const zeroCollective = (sweeps: Map<string, ModelPoint[]>) => Object.fromEntries([...sweeps].filter(([k]) => k.includes('|coaxial|')).map(([k, s]) => [k, s[0]?.cq ?? null]));

    const out = process.env.MIRAGE_HARRINGTON_OUT;
    if (out) {
      writeFileSync(out, `${JSON.stringify({
        schemaVersion: 1, kind: 'harrington-coaxial', task: 'TASK-101', status: firstResult.status, performanceStatus: firstResult.performanceStatus,
        source: 'Harrington, Full-Scale-Tunnel Investigation of the Static-Thrust Performance of a Coaxial Helicopter Rotor, NACA TN 2318, 1951 (public domain), figures 4 and 8 digitized',
        fixture: HARRINGTON_METHOD.fixture, method: HARRINGTON_METHOD,
        model: { dynamics: 'BetFlightDynamics, ESC drive (stand-in), dynamic inflow, rotor wakes all (coaxial) and off', strips: DEFAULT_STRIPS, polarSha256: catalogPolar(HARRINGTON_METHOD.polar)?.sha256 ?? null,
          drive: DRIVE, heightM: HEIGHT_M, heavy: HEAVY },
        interference: firstResult.interference,
        performance: firstResult.performance,
        sweeps: Object.fromEntries(first.sweeps), sweepsWakesOff: Object.fromEntries(first.sweepsOff),
        variants: {
          [HARRINGTON_DRAG_VARIANT.id]: {
            description: 'Each rotor\'s section drag coefficients scaled by one factor fitted on its single-rotor measurements only (TASK-145\'s form, lift, axes and rotational augmentation unchanged); wake model, method and bands as in the first variant',
            method: HARRINGTON_DRAG_VARIANT, status: secondResult.status, performanceStatus: secondResult.performanceStatus, dragFits,
            zeroCollectiveCoaxialCq: { model: zeroCollective(second.sweeps), measuredRotor1At500: 0.0000777 },
            interference: secondResult.interference, performance: secondResult.performance,
            sweeps: Object.fromEntries(second.sweeps), sweepsWakesOff: Object.fromEntries(second.sweepsOff),
          },
        },
      }, null, 2)}\n`);
    }
  }, 3_600_000);
});
