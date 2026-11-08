import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { HullShape } from '../packages/physics/src/vehicle-manifest.ts';
import {
  CLEARANCE_RULES, clearanceFix, clearanceShapes, describeClash, propellerClearance, shapeDistanceM, type ClearanceClash,
} from '../packages/aircraft/src/clearance.ts';
import { validateComponentCard } from '../packages/aircraft/src/components.ts';
import { deriveVehicleManifest } from '../packages/aircraft/src/derive-manifest.ts';
import { deriveLayout } from '../packages/aircraft/src/layout.ts';
import { profileDraft, validateAircraftProfile, withLandingGear, withPropellerPolars, type AircraftProfile, type ProfileGear } from '../packages/aircraft/src/profile.ts';
import { STANDARD_GEAR, standardLandingGear } from '../packages/aircraft/src/standard-gear.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';
import { prepareVehicle } from '../apps/web/src/sitl/sitl-run.ts';
import { FIXTURE_MODEL_ID, FIXTURE_NAMES, syntheticComponents } from './support/aircraft-derivation.ts';

// TASK-195: the propeller clearance check and its fix. Distances are checked
// against closed forms and against an independent sampled distance; the
// overlaps and fixed arm lengths against plane geometry worked by hand.

function json(path: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8'));
}
const fixture = (name: string): AircraftProfile => validateAircraftProfile(json(`aircraft/${name}.json`));
const withArms = (profile: AircraftProfile, edit: (arm: AircraftProfile['arms'][number]) => Partial<AircraftProfile['arms'][number]>): AircraftProfile =>
  validateAircraftProfile({ ...profile, arms: profile.arms.map(arm => ({ ...arm, ...edit(arm) })) });
const radius = (value: number) => (): number => value;
/** The synthetic rotor radius of tests/support/aircraft-derivation.ts and the example propeller card's (0.254 m across). */
const SYNTHETIC_R = 0.14, EXAMPLE_R = 0.127;
const SIN_PI_8 = Math.sin(Math.PI / 8);

const cylinder = (center: number[], axis: number[], radiusM: number, halfHeightM: number): HullShape =>
  ({ id: 0, kind: 'cylinder', centerBodyM: center, axisBody: axis, radiusM, halfHeightM });
const capsule = (start: number[], end: number[], radiusM: number): HullShape => ({ id: 0, kind: 'capsule', startBodyM: start, endBodyM: end, radiusM });

/** Exact distance from a point to a solid capped cylinder: 0 inside. */
function pointToCylinder(point: readonly number[], shape: Extract<HullShape, { kind: 'cylinder' }>): number {
  const n = Math.hypot(...shape.axisBody), a = shape.axisBody.map(v => v / n), d = point.map((v, i) => v - shape.centerBodyM[i]!);
  const along = d[0]! * a[0]! + d[1]! * a[1]! + d[2]! * a[2]!;
  const radial = Math.hypot(...d.map((v, i) => v - along * a[i]!));
  return Math.hypot(Math.max(0, radial - shape.radiusM), Math.max(0, Math.abs(along) - shape.halfHeightM));
}
/**
 * An independent upper bound of the distance between two cylinders: the least exact distance to
 * the second from samples of the first's surface. A sample lies within `spacing` of every surface
 * point, so the bound exceeds the distance by at most that.
 */
function sampledDistance(first: Extract<HullShape, { kind: 'cylinder' }>, second: Extract<HullShape, { kind: 'cylinder' }>):
{ distance: number; spacing: number } {
  const n = Math.hypot(...first.axisBody), a = first.axisBody.map(v => v / n);
  const seed = Math.abs(a[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const dotSeed = seed[0]! * a[0]! + seed[1]! * a[1]! + seed[2]! * a[2]!;
  const u0 = seed.map((v, i) => v - dotSeed * a[i]!), un = Math.hypot(...u0), u = u0.map(v => v / un);
  const v = [a[1]! * u[2]! - a[2]! * u[1]!, a[2]! * u[0]! - a[0]! * u[2]!, a[0]! * u[1]! - a[1]! * u[0]!];
  const angles = 1440, radii = 120, heights = 9;
  let best = Infinity;
  const at = (r: number, theta: number, h: number) => first.centerBodyM.map((c, i) => c + r * (Math.cos(theta) * u[i]! + Math.sin(theta) * v[i]!) + h * a[i]!);
  for (let k = 0; k < angles; k++) {
    const theta = (2 * Math.PI * k) / angles;
    for (let j = 0; j <= radii; j++) {
      for (const h of [-first.halfHeightM, first.halfHeightM]) best = Math.min(best, pointToCylinder(at((first.radiusM * j) / radii, theta, h), second));
    }
    for (let j = 0; j < heights; j++) {
      best = Math.min(best, pointToCylinder(at(first.radiusM, theta, -first.halfHeightM + (2 * first.halfHeightM * j) / (heights - 1)), second));
    }
  }
  const spacing = Math.hypot(Math.PI * first.radiusM / angles, first.radiusM / (2 * radii), first.halfHeightM / (heights - 1));
  return { distance: best, spacing };
}

describe('shape distance', () => {
  test('two level discs side by side are their centre distance less both radii apart, 0 when they overlap', () => {
    for (const [d, r1, r2] of [[0.3, 0.1, 0.12], [0.2681, 0.14, 0.12], [1.5, 0.56, 0.56], [0.25, 0.14, 0.14]] as const) {
      const a = cylinder([0, 0, 0], [0, 0, -1], r1, 0.025 * r1), b = cylinder([d * 0.6, d * 0.8, 0], [0, 0, 1], r2, 0.025 * r2);
      expect(shapeDistanceM(a, b)).toBeCloseTo(Math.max(0, d - r1 - r2), 9);
    }
  });
  test('stacked level discs that overlap seen from above are their vertical gap less both half-thicknesses apart', () => {
    const a = cylinder([0, 0, 0], [0, 0, 1], 0.1, 0.0025);
    expect(shapeDistanceM(a, cylinder([0.15, 0, 0.01], [0, 0, 1], 0.1, 0.0025))).toBeCloseTo(0.005, 9);
    expect(shapeDistanceM(a, cylinder([0.15, 0, -0.04], [0, 0, 1], 0.1, 0.005))).toBeCloseTo(0.0325, 9);
    expect(shapeDistanceM(a, cylinder([0.15, 0, 0.004], [0, 0, 1], 0.1, 0.0025))).toBe(0);
  });
  test('capsules: parallel ones are their offset less both radii apart, crossing ones their height difference less both radii', () => {
    expect(shapeDistanceM(capsule([0, 0, 0], [1, 0, 0], 0.01), capsule([0, 0.1, 0], [1, 0.1, 0], 0.02))).toBeCloseTo(0.07, 9);
    expect(shapeDistanceM(capsule([-1, 0, 0], [1, 0, 0], 0.01), capsule([0, -1, 0.05], [0, 1, 0.05], 0.015))).toBeCloseTo(0.025, 9);
    expect(shapeDistanceM(capsule([0, 0, 0], [1, 0, 0], 0.01), capsule([2, 0, 0], [3, 0, 0], 0.01))).toBeCloseTo(0.98, 9);
    // A capsule end above a disc face.
    expect(shapeDistanceM(capsule([0, 0, -0.2], [0, 0, -0.5], 0.02), cylinder([0.03, 0, 0], [0, 0, 1], 0.1, 0.01))).toBeCloseTo(0.17, 9);
  });
  test('tilted discs agree with an independent sampled distance', () => {
    const cases = [
      [cylinder([0, 0, 0], [0.1, 0, -1], 0.14, 0.0035), cylinder([0.2679, 0.02, 0.01], [-0.05, 0.08, -1], 0.14, 0.0035)],
      [cylinder([0, 0, 0], [0.3, 0.2, -1], 0.14, 0.0035), cylinder([0.32, 0, 0.03], [-0.4, 0, -1], 0.12, 0.003)],
      [cylinder([0, 0, 0], [0, 0.6, -1], 0.2, 0.005), cylinder([0.1, 0.25, 0.12], [0.5, -0.2, 1], 0.15, 0.004)],
      [cylinder([0, 0, 0], [1, 0, 0], 0.1, 0.05), cylinder([0.2, 0.1, 0], [0, 1, 1], 0.08, 0.02)],
    ] as const;
    for (const [a, b] of cases) {
      if (a.kind !== 'cylinder' || b.kind !== 'cylinder') throw new Error('Expected cylinders');
      const gjk = shapeDistanceM(a, b), sampled = sampledDistance(a, b);
      // GJK bounds the distance from above to its convergence bound, and the sample bound lies above the distance by at most its spacing.
      expect(gjk).toBeLessThanOrEqual(sampled.distance + 1e-9);
      expect(sampled.distance - gjk).toBeLessThanOrEqual(sampled.spacing + 1e-9);
    }
  });
});

/** Motor IDs of the propellers on neighbouring arms of an evenly spaced single-rotor layout, ascending. */
function neighbourPairs(profile: AircraftProfile): string[] {
  const rotors = [...deriveLayout(profile).rotors].sort((a, b) => Math.atan2(a.hubPositionBodyM[1]!, a.hubPositionBodyM[0]!) -
    Math.atan2(b.hubPositionBodyM[1]!, b.hubPositionBodyM[0]!));
  return rotors.map((rotor, i) => {
    const next = rotors[(i + 1) % rotors.length]!;
    return [rotor.motorId, next.motorId].sort((a, b) => a - b).join('+');
  }).sort();
}
const pairsOf = (clashes: readonly ClearanceClash[]): string[] =>
  clashes.flatMap(clash => (clash.kind === 'propellers' ? [clash.motorIds.join('+')] : [])).sort();

describe('propeller clearance', () => {
  test('the five S19 configurations clear with the synthetic and the example propellers', () => {
    for (const name of FIXTURE_NAMES) {
      for (const r of [SYNTHETIC_R, EXAMPLE_R]) expect(propellerClearance(fixture(name), radius(r)).clashes, `${name} R ${r}`).toEqual([]);
    }
  });

  test('octa X on its former 0.35 m arms: each neighbouring pair overlaps by 2R - 2L sin(π/8), and the fix gives the corrected fixture', () => {
    const former = withArms(fixture('octa-x'), () => ({ lengthM: 0.35 }));
    const report = propellerClearance(former, radius(SYNTHETIC_R));
    expect(pairsOf(report.clashes)).toEqual(neighbourPairs(former));
    for (const clash of report.clashes) {
      expect(clash.kind).toBe('propellers');
      if (clash.kind === 'propellers') expect(clash.overlapM).toBeCloseTo(2 * SYNTHETIC_R - 2 * 0.35 * SIN_PI_8, 9);
    }
    expect(describeClash(report.clashes[0]!)).toBe('The propellers of motors 1 and 2 overlap by 12.1 mm');
    const fix = clearanceFix(former, radius(SYNTHETIC_R));
    if (!fix) throw new Error('Expected a fix');
    // Seen from above, a 5 % tip gap needs 2L sin(π/8) ≥ 2R·1.05: L ≥ 0.38414 m, which rounds up to 0.385 m.
    expect(fix.changes).toEqual(former.arms.map(arm => ({ label: `Arm ${arm.id} length`, beforeM: 0.35, afterM: 0.385 })));
    expect(fix.profile).toEqual(fixture('octa-x'));
    expect(fix.after.clashes).toEqual([]);
    expect(fix.armScale).toBeGreaterThan(0.384 / 0.35);
    expect(fix.armScale).toBeLessThanOrEqual(0.385 / 0.35);
    // The fix is the shortest whole millimetre: at 0.384 m a neighbouring pair is nearer than the 5 % gap, at 0.385 m none is.
    const gap = CLEARANCE_RULES.fixTipGapOfDiameter * 2 * SYNTHETIC_R;
    const nearest = (profile: AircraftProfile) => {
      const { discs } = clearanceShapes(profile, radius(SYNTHETIC_R));
      return Math.min(...discs.flatMap((disc, i) => discs.slice(i + 1).map(other => shapeDistanceM(disc, other))));
    };
    expect(nearest(withArms(former, () => ({ lengthM: 0.384 })))).toBeLessThan(gap);
    expect(nearest(fix.profile)).toBeGreaterThanOrEqual(gap);
  });

  test('an octocopter with 1.12 m (44 in) propellers on 0.25 m arms is blocked with every pair named, and the fix lengthens its arms', () => {
    const big = withArms(fixture('octa-x'), () => ({ lengthM: 0.25 }));
    const report = propellerClearance(big, radius(0.56));
    // Every two of the eight discs overlap, and each disc reaches the body.
    const all = big.motors.flatMap((a, i) => big.motors.slice(i + 1).map(b => `${a.id}+${b.id}`)).sort();
    expect(pairsOf(report.clashes)).toEqual(all);
    expect(report.clashes.filter(clash => clash.kind === 'propeller-body').map(clash => clash.kind === 'propeller-body' && clash.motorId))
      .toEqual(big.motors.map(motor => motor.id));
    for (const clash of report.clashes) {
      // Neighbours: 2R - 2L sin(π/8); the body: R + L/4 - L.
      if (clash.kind === 'propellers' && neighbourPairs(big).includes(clash.motorIds.join('+'))) expect(clash.overlapM).toBeCloseTo(1.12 - 0.5 * SIN_PI_8, 9);
      if (clash.kind === 'propeller-body') expect(clash.overlapM).toBeCloseTo(0.56 + 0.0625 - 0.25, 9);
    }
    expect(report.clashes.map(describeClash)).toContain('The propeller of motor 3 reaches 372.5 mm into the body');
    const fix = clearanceFix(big, radius(0.56));
    if (!fix) throw new Error('Expected a fix');
    // 2L sin(π/8) ≥ 1.12·1.05 gives L ≥ 1.5365 m.
    expect(fix.changes).toEqual(big.arms.map(arm => ({ label: `Arm ${arm.id} length`, beforeM: 0.25, afterM: 1.537 })));
    expect(fix.after.clashes).toEqual([]);
    // Only the arm lengths change; the mass properties stay as entered.
    expect({ ...fix.profile, arms: big.arms }).toEqual(big);
  });

  test('a coaxial pair shares its axis without clashing, while stacked propellers of different arms clash unless far enough apart', () => {
    const tight = withArms(fixture('coaxial-x8'), () => ({ pairSeparationM: 0.005 }));
    const { layout, discs } = clearanceShapes(tight, radius(SYNTHETIC_R));
    const onArm1 = layout.rotors.flatMap((rotor, i) => (rotor.armId === 1 ? [discs[i]!] : []));
    expect(onArm1).toHaveLength(2);
    expect(shapeDistanceM(onArm1[0]!, onArm1[1]!)).toBe(0);
    expect(propellerClearance(tight, radius(SYNTHETIC_R)).clashes.filter(clash => clash.kind === 'propellers')).toEqual([]);
    // Hexa X on 0.2 m arms: neighbours overlap by 2R - L seen from above (0.08 m). Alternate arms 6 cm higher clear them; 5 mm does not.
    const hexa = (step: number) => withArms(fixture('hexa-x'), arm => ({ lengthM: 0.2, heightM: arm.id % 2 === 0 ? step : 0, sideTiltRad: 0 }));
    expect(propellerClearance(hexa(0.06), radius(SYNTHETIC_R)).clashes.filter(clash => clash.kind === 'propellers')).toEqual([]);
    const close = propellerClearance(hexa(0.005), radius(SYNTHETIC_R)).clashes.filter(clash => clash.kind === 'propellers');
    expect(pairsOf(close)).toEqual(neighbourPairs(hexa(0.005)));
    for (const clash of close) if (clash.kind === 'propellers') expect(clash.overlapM).toBeCloseTo(0.28 - 0.2, 9);
  });

  test('with a stated clearance, parts at or below the ground at rest clash and the fix raises the clearance', () => {
    const low = validateAircraftProfile({ ...fixture('coaxial-x8'), groundClearanceM: 0.03 });
    const report = propellerClearance(low, radius(SYNTHETIC_R));
    // The body's lowest point is 0.4·0.075 m down; each lower disc's 0.045 m + 0.025·0.14 m.
    expect(report.clashes.map(describeClash)).toEqual([
      'The body touches the ground at rest',
      ...[5, 6, 7, 8].map(id => `The propeller of motor ${id} reaches 18.5 mm below the ground at rest`),
    ]);
    const fix = clearanceFix(low, radius(SYNTHETIC_R));
    expect(fix?.changes).toEqual([{ label: 'Ground clearance', beforeM: 0.03, afterM: 0.054 }]);
    expect(fix?.after.clashes).toEqual([]);
    expect(clearanceFix(fixture('coaxial-x8'), radius(SYNTHETIC_R))).toBeNull();
  });

  test('derivation 5 rests a profile without a clearance with its lowest propeller one static deflection above the ground', async () => {
    const profile = validateAircraftProfile({ ...fixture('coaxial-x8'), groundClearanceM: null });
    const report = propellerClearance(profile, radius(SYNTHETIC_R));
    expect(report.clashes).toEqual([]);
    expect(report.clearanceStated).toBe(false);
    expect(report.groundClearanceM).toBeCloseTo(0.0485 + STANDARD_GEAR.staticDeflectionM, 12);
    const derived = await deriveVehicleManifest(profile, syntheticComponents(profile), { modelId: FIXTURE_MODEL_ID });
    expect(derived.manifest.landingGear).toEqual(standardLandingGear(profile, derived.manifest.massProperties.massKg, report.groundClearanceM));
  });

  test('propellers whose hubs coincide seen from above stay in the fixed report, since no arm length parts them', () => {
    const base = fixture('quad-x');
    const stacked = validateAircraftProfile({ ...base, arms: base.arms.map(arm => (arm.id === 2 ? { ...arm, azimuthRad: base.arms[0]!.azimuthRad, heightM: 0.001 } : arm)) });
    const fix = clearanceFix(stacked, radius(EXAMPLE_R));
    if (!fix) throw new Error('Expected a fix');
    const ids = (motorId: number) => stacked.motors.find(motor => motor.id === motorId)?.armId;
    expect(fix.after.clashes.length).toBeGreaterThan(0);
    for (const clash of fix.after.clashes) {
      expect(clash.kind).toBe('propellers');
      if (clash.kind === 'propellers') expect(clash.motorIds.map(ids).sort()).toEqual([1, 2]);
    }
  });

  test('a profile without a propeller radius is refused', () => {
    expect(() => propellerClearance(fixture('quad-x'), () => Number.NaN)).toThrow('has no propeller radius');
  });
});

describe('run admission', () => {
  async function stored(edit: (profile: AircraftProfile) => AircraftProfile) {
    const store = new ProjectStore(new MemoryBackend(), { storage: null,
      validators: { 'aircraft-profile': validateAircraftProfile, 'component-card': validateComponentCard } });
    const project = await store.createProject('Clearance');
    const card = async (type: string): Promise<string> => {
      const base = json(`components/${type}-example.json`);
      if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) {
        throw new Error(`Invalid ${type} card fixture`);
      }
      const provenance = Object.fromEntries(Object.entries(base.values).map(([key, value]) => [key, value === null ? null : 'example']));
      return (await store.createItem(project.record.id, 'component-card', { name: type, payload: validateComponentCard({ ...base, provenance }) })).sha256;
    };
    const motor = await card('motor'), propeller = await card('propeller'), esc = await card('esc'), battery = await card('battery');
    const quad = fixture('quad-x');
    const profile = edit(withPropellerPolars(validateAircraftProfile({ ...quad, battery: { card: battery },
      motors: quad.motors.map(item => ({ ...item, components: { motor, propeller, esc } })) }), [{ card: propeller, polar: 'naca6409-neuralfoil-v1' }]));
    return { store, version: await store.createItem(project.record.id, 'aircraft-profile', profileDraft('Quad', profile)) };
  }

  test('no run starts from a profile whose propellers clash, and its fixed version is admitted', async () => {
    const short = (profile: AircraftProfile) => withArms(profile, () => ({ lengthM: 0.17 }));
    const clashing = await stored(short);
    // Neighbours on 0.17 m arms: 0.254 m - 0.17·√2 m = 13.6 mm.
    await expect(prepareVehicle(clashing.store, clashing.version)).rejects.toThrow(
      'the propellers clash. The propellers of motors 1 and 3 overlap by 13.6 mm. The propellers of motors 1 and 4 overlap by 13.6 mm. ' +
      'The propellers of motors 2 and 3 overlap by 13.6 mm. The propellers of motors 2 and 4 overlap by 13.6 mm. The Aircraft tab proposes a fix');
    const fixed = await stored(profile => {
      const fix = clearanceFix(short(profile), radius(EXAMPLE_R));
      if (!fix) throw new Error('Expected a fix');
      return fix.profile;
    });
    const vehicle = await prepareVehicle(fixed.store, fixed.version);
    expect(vehicle.derived.manifest.rotors).toHaveLength(4);
  });
});

// TASK-194: on a described gear the aircraft rests level with each support carrying its share, the mean foot depth less the strut
// under the share minus its foot and the foot under the whole share; parts below that height are on the ground.
describe('propeller clearance on a described landing gear (TASK-194)', () => {
  const nothing = { strutTravelM: null, strutStiffnessNpm: null, strutDampingNspm: null, footRadiusM: null, rimRadiusM: null, footStiffnessNpm: null,
    unsprungMassKg: null, staticFriction: null, kineticFriction: null, rollingCoefficient: null };
  const legs = (depthM: number, values: Partial<ProfileGear['values']> = {}): ProfileGear => ({
    kind: 'legs', feetBodyM: [[0.15, 0.15, depthM], [0.15, -0.15, depthM], [-0.15, -0.15, depthM], [-0.15, 0.15, depthM]], positionSource: 'Drawing',
    values: { ...nothing, ...values },
    provenance: { ...nothing, ...Object.fromEntries(Object.entries(values).map(([key]) => [key, 'Drawing'])) },
  });
  test('rests at the closed-form height, and a gear too short to hold the body off the ground puts it on the ground', () => {
    const tall = withLandingGear(fixture('quad-x'), legs(0.1, { strutStiffnessNpm: 2000, footStiffnessNpm: 30000, unsprungMassKg: 0.004 }));
    const share = 1.5 / 4, g = 9.80665, compression = ((share - 0.004) * g) / 2000 + (share * g) / 30000;
    const report = propellerClearance(tall, radius(SYNTHETIC_R));
    expect(report.groundClearanceM).toBeCloseTo(0.1 - compression, 15);
    expect(report.clashes).toEqual([]);
    // The standard body is 0.4·0.25·0.225 = 0.0225 m half-height: feet 15 mm down cannot hold it up.
    const short = propellerClearance(withLandingGear(fixture('quad-x'), legs(0.015)), radius(SYNTHETIC_R));
    expect(short.clashes.map(clash => clash.kind === 'ground' ? clash.part.kind : clash.kind)).toContain('body');
  });
});
