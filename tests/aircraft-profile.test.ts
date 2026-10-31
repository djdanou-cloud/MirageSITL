// TASK-138 (S03): aircraft profile schema 1, its layout and its derivation to
// vehicle manifest v2. The oracle below recomputes every rotor from the
// profile's defining relations with independent code: the engine's Math
// functions instead of packages/aircraft/src/trig.ts, inverse relations
// (atan2) for the tilts, and a separate quaternion-to-matrix formula.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MAX_ACTUATORS } from '../packages/protocol/src/index.ts';
import { projectVehicleToModelV1, validateVehicleManifest, VehicleRegistry, type VehicleManifest } from '../packages/physics/src/vehicle-manifest.ts';
import { canonicalBytes, ProjectStoreError } from '../packages/project/src/schema.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';
import schema from '../packages/aircraft/src/profile.schema.json';
import {
  profileComponentCards, profileDraft, readAircraftProfile, validateAircraftProfile, type AircraftProfile,
} from '../packages/aircraft/src/profile.ts';
import { deriveLayout, type RotorLayout } from '../packages/aircraft/src/layout.ts';
import { PIO2_PARTS, sinCos, tan } from '../packages/aircraft/src/trig.ts';
import {
  combineMassProperties, deriveVehicleManifest, DERIVED_DATASET_ID, type ResolvedComponents,
} from '../packages/aircraft/src/derive-manifest.ts';
import {
  engineSensitiveVariant, FIXTURE_MODEL_ID, FIXTURE_NAMES, RECORDED_ENGINE_SENSITIVE_SHA256, RECORDED_MANIFEST_SHA256,
  RECORDED_V1_ENGINE_SENSITIVE_SHA256, RECORDED_V1_MANIFEST_SHA256,
  syntheticComponents, type FixtureName,
} from './support/aircraft-derivation.ts';

/** Absolute tolerance (m, rad, unit vectors), set before implementation: a few roundings of O(1) values give ~1e-15. */
const GEOMETRY_TOLERANCE = 1e-12;
/** Relative tolerance for mass properties against the oracle, as a fraction of the inertia trace. */
const INERTIA_TOLERANCE_RELATIVE = 1e-12;

type Vector = [number, number, number];
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type ProfileData = Mutable<AircraftProfile>;

/**
 * SHA-256 of a derivation 2 manifest with its dataset put back to derivation 1:
 * the version in the input hash and in the description. Without IMU mounts
 * nothing else changed, so it must equal the TASK-138 recording.
 */
function asDerivation1(manifest: VehicleManifest, profile: unknown, components: ResolvedComponents): string {
  const hash = (value: unknown) => createHash('sha256').update(canonicalBytes(value)).digest('hex');
  const [dataset] = manifest.datasets;
  if (!dataset || dataset.kind !== 'synthetic' || manifest.sensorMounts.length > 0) throw new Error('Expected one synthetic dataset and no sensor mounts');
  return hash({ ...manifest, datasets: [{ ...dataset, sourceSha256: hash({ derivationVersion: 1, profile: validateAircraftProfile(profile), components }),
    derivation: dataset.derivation.replace('derivation 2 ', 'derivation 1 ') }] });
}

function fixture(name: FixtureName): ProfileData {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`./fixtures/aircraft/${name}.json`, import.meta.url), 'utf8'));
  return structuredClone(validateAircraftProfile(parsed)) as ProfileData;
}
/** A copy of a fixture with one change, as rejection input. */
function edit(name: FixtureName, change: (copy: ProfileData) => void): unknown {
  const copy = fixture(name);
  change(copy);
  return copy;
}
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const norm = (a: readonly number[]) => Math.sqrt(dot(a, a));
/** Rotation matrix third column of a wxyz quaternion, written out from R = I + 2w[v]x + 2[v]x^2. */
function rotateZ(q: readonly number[]): Vector {
  const [w = 0, x = 0, y = 0, z = 0] = q;
  return [2 * x * z + 2 * w * y, 2 * y * z - 2 * w * x, 1 - 2 * x * x - 2 * y * y];
}
function expectVector(actual: readonly number[], expected: readonly number[], label: string): void {
  expect(actual, label).toHaveLength(3);
  for (let i = 0; i < 3; i++) expect(Math.abs(actual[i]! - expected[i]!), `${label}[${i}]`).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
}

/** The oracle: each rotor's expected position, thrust axis and spin from the profile's defining relations. */
function checkAgainstOracle(profile: ProfileData, rotors: readonly RotorLayout[]): void {
  expect(rotors.map(rotor => rotor.motorId)).toEqual(profile.motors.map(motor => motor.id));
  const up: Vector = [0, 0, -1];
  for (const rotor of rotors) {
    const motor = profile.motors.find(item => item.id === rotor.motorId)!;
    const arm = profile.arms.find(item => item.id === motor.armId)!;
    const label = `motor ${motor.id}`;
    expect([rotor.armId, rotor.level, rotor.output]).toEqual([arm.id, motor.level, motor.output]);
    expect(rotor.spinSign, label).toBe(motor.spin === 'ccw' ? 1 : -1);
    const radial: Vector = [Math.cos(arm.azimuthRad), Math.sin(arm.azimuthRad), 0];
    const across: Vector = [-Math.sin(arm.azimuthRad), Math.cos(arm.azimuthRad), 0];
    const axis = rotor.thrustAxisBody;
    expect(Math.abs(norm(axis) - 1), `${label} axis norm`).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
    // The tilts are the angles of the axis's projections onto the arm's vertical plane and the plane across it.
    expect(Math.abs(Math.atan2(dot(axis, radial), dot(axis, up)) - arm.outwardTiltRad), `${label} outward`).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
    expect(Math.abs(Math.atan2(dot(axis, across), dot(axis, up)) - arm.sideTiltRad), `${label} side`).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
    // Hub +z is the thrust axis; the quaternion is a unit wxyz quaternion with a positive x component.
    expect(Math.abs(Math.hypot(...rotor.hubToBody) - 1), `${label} quaternion norm`).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
    expect(rotor.hubToBody[1], label).toBeGreaterThan(0);
    expectVector(rotateZ(rotor.hubToBody), axis, `${label} hub z`);
    const mount: Vector = [arm.lengthM * Math.cos(arm.azimuthRad), arm.lengthM * Math.sin(arm.azimuthRad), -arm.heightM];
    if (motor.level === 'single') {
      expectVector(rotor.hubPositionBodyM, mount, `${label} position`);
    } else {
      const partner = rotors.find(other => other.armId === arm.id && other.motorId !== rotor.motorId)!;
      const upper = motor.level === 'upper' ? rotor : partner, lower = motor.level === 'upper' ? partner : rotor;
      const middle = [0, 1, 2].map(i => (upper.hubPositionBodyM[i]! + lower.hubPositionBodyM[i]!) / 2);
      const span = [0, 1, 2].map(i => upper.hubPositionBodyM[i]! - lower.hubPositionBodyM[i]!);
      expectVector(middle, mount, `${label} pair centre`);
      // The upper rotor lies on the thrust side of the lower one, one separation along the shared axis.
      expectVector(span, axis.map(component => component * arm.pairSeparationM!), `${label} pair span`);
      expectVector(partner.thrustAxisBody, axis, `${label} pair axis`);
    }
  }
}

describe('profile fixtures', () => {
  test('the five S19 configurations validate and keep their arm and motor counts', () => {
    const counts = FIXTURE_NAMES.map(name => {
      const profile = fixture(name);
      return [name, profile.arms.length, profile.motors.length, profile.motors.filter(m => m.level !== 'single').length];
    });
    expect(counts).toEqual([
      ['quad-x', 4, 4, 0], ['hexa-x', 6, 6, 0], ['octa-x', 8, 8, 0], ['coaxial-x8', 4, 8, 8], ['octa-coaxial-16', 8, 16, 16],
    ]);
    const validated = validateAircraftProfile(fixture('quad-x'));
    expect(Object.isFrozen(validated) && Object.isFrozen(validated.arms[0]) && Object.isFrozen(validated.motors[0]!.components)).toBe(true);
  });

  test('the schema limits are the ABI v2 actuator limit and eight arms', () => {
    const properties = schema.properties;
    expect(properties.motors.maxItems).toBe(MAX_ACTUATORS);
    expect(properties.motors.items.properties.id.maximum).toBe(MAX_ACTUATORS);
    expect(properties.motors.items.properties.output.maximum).toBe(MAX_ACTUATORS);
    expect([properties.arms.maxItems, properties.arms.items.properties.id.maximum]).toEqual([8, 8]);
  });
});

describe('layout oracle', () => {
  test.each(FIXTURE_NAMES)('%s: positions, thrust axes, quaternions and spins match the oracle', name => {
    const profile = fixture(name);
    const layout = deriveLayout(validateAircraftProfile(profile));
    checkAgainstOracle(profile, layout.rotors);
    const pairs = profile.arms.filter(arm => arm.pairSeparationM !== null).map(arm => ({
      upstreamMotorId: profile.motors.find(m => m.armId === arm.id && m.level === 'upper')!.id,
      downstreamMotorId: profile.motors.find(m => m.armId === arm.id && m.level === 'lower')!.id,
    }));
    expect(layout.wakePairs).toEqual(pairs.sort((a, b) => a.upstreamMotorId - b.upstreamMotorId));
  });

  test('hand-derived values: quad X and the coaxial X8 pairs', () => {
    const quad = deriveLayout(validateAircraftProfile(fixture('quad-x')));
    const d = 0.225 * Math.SQRT1_2; // arm length times cos 45 degrees
    expectVector(quad.rotors[0]!.hubPositionBodyM, [d, d, 0], 'quad motor 1 (front right)');
    expectVector(quad.rotors[1]!.hubPositionBodyM, [-d, -d, 0], 'quad motor 2 (rear left)');
    expectVector(quad.rotors[2]!.hubPositionBodyM, [d, -d, 0], 'quad motor 3 (front left)');
    expectVector(quad.rotors[3]!.hubPositionBodyM, [-d, d, 0], 'quad motor 4 (rear right)');
    for (const rotor of quad.rotors) {
      expect(rotor.thrustAxisBody).toEqual([0, 0, -1]);
      // The untilted hub orientation of the repository's fixtures: half a turn about body x.
      expect(rotor.hubToBody).toEqual([0, 1, 0, 0]);
    }
    const x8 = deriveLayout(validateAircraftProfile(fixture('coaxial-x8')));
    const e = 0.3 * Math.SQRT1_2;
    expectVector(x8.rotors[0]!.hubPositionBodyM, [e, e, -0.045], 'X8 motor 1, upper');
    expectVector(x8.rotors[4]!.hubPositionBodyM, [e, e, 0.045], 'X8 motor 5, lower');
    expect(x8.rotors.map(rotor => rotor.spinSign)).toEqual([1, -1, 1, -1, -1, 1, -1, 1]);
  });

  test('the quad X layout is the ArduCopter quad X that TASK-047 evidences', async () => {
    const derived = await deriveVehicleManifest(fixture('quad-x'), syntheticComponents(validateAircraftProfile(fixture('quad-x'))), { modelId: FIXTURE_MODEL_ID });
    const declared = structuredClone(derived.manifest) as Mutable<VehicleManifest>;
    declared.ardupilot = { vehicle: 'copter', frameClass: 1, frameType: 1 };
    expect(() => validateVehicleManifest(declared)).not.toThrow();
    // Swapping two spins breaks the evidenced quad X.
    const swapped = edit('quad-x', copy => { copy.motors[0]!.spin = 'cw'; copy.motors[2]!.spin = 'ccw'; });
    const wrong = structuredClone((await deriveVehicleManifest(swapped, syntheticComponents(validateAircraftProfile(swapped)), { modelId: FIXTURE_MODEL_ID })).manifest) as Mutable<VehicleManifest>;
    wrong.ardupilot = { vehicle: 'copter', frameClass: 1, frameType: 1 };
    expect(() => validateVehicleManifest(wrong)).toThrow('spins against');
  });
});

describe('rejections', () => {
  const octa = 'octa-x', sixteen = 'octa-coaxial-16';
  test.each([
    ['17 motors', edit(sixteen, c => { c.motors.push({ ...c.motors[15]!, id: 16, output: 16 }); }), 'more than 16'],
    ['9 arms', edit(octa, c => { c.arms.push({ ...c.arms[7]!, id: 8, lengthM: 0.5 }); }), 'more than 8'],
    ['duplicate outputs', edit('hexa-x', c => { c.motors[4]!.output = 2; }), 'Output 2 is assigned to motors 2 and 5'],
    ['a pair without a separation', edit('coaxial-x8', c => { c.arms[1]!.pairSeparationM = null; }), 'Arm 2 holds a motor pair but has no pair separation'],
    ['a single motor with a separation', edit('quad-x', c => { c.arms[0]!.pairSeparationM = 0.05; }), 'Arm 1 holds one motor but has a pair separation'],
    ['a pair of two upper motors', edit('coaxial-x8', c => { c.motors[5]!.level = 'upper'; }), 'Arm 2 must hold one single motor, or one upper and one lower motor'],
    ['a single and a lower motor', edit('coaxial-x8', c => { c.motors[0]!.level = 'single'; }), 'Arm 1 must hold one single motor, or one upper and one lower motor'],
    ['indefinite inertia', edit('quad-x', c => { c.massProperties.inertiaCgKgM2 = [0.016, 0, 0, 0, -0.017, 0, 0, 0, 0.03]; }), 'positive definite'],
    ['asymmetric inertia', edit('quad-x', c => { c.massProperties.inertiaCgKgM2 = [0.016, 0.001, 0, 0, 0.017, 0, 0, 0, 0.03]; }), 'symmetric'],
    ['inertia beyond the triangle inequality', edit('quad-x', c => { c.massProperties.inertiaCgKgM2 = [0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.03]; }), 'triangle'],
    ['a payload with negative inertia', edit('hexa-x', c => { c.payload!.inertiaCgKgM2 = [0.0004, 0, 0, 0, -0.0001, 0, 0, 0, 0.0004]; }), 'Payload inertia must be positive semi-definite'],
    ['a payload beyond the triangle inequality', edit('hexa-x', c => { c.payload!.inertiaCgKgM2 = [0.0001, 0, 0, 0, 0.0001, 0, 0, 0, 0.0005]; }), 'Payload inertia violates'],
  ])('%s', (_label, input, message) => {
    expect(() => validateAircraftProfile(input)).toThrow(message);
  });

  test('unknown keys, units, frames, references and envelopes are rejected', () => {
    const invalid: [string, unknown][] = [
      ['unknown key', edit('quad-x', c => { Object.assign(c, { name: 'Quad' }); })],
      ['unknown arm key', edit('quad-x', c => { Object.assign(c.arms[0]!, { tilt: 0 }); })],
      ['other units', edit('quad-x', c => { Object.assign(c, { units: 'imperial' }); })],
      ['other body frame', edit('quad-x', c => { Object.assign(c, { bodyFrame: 'FLU' }); })],
      ['schema version 2', edit('quad-x', c => { Object.assign(c, { schemaVersion: 2 }); })],
      ['zero arm length', edit('quad-x', c => { c.arms[0]!.lengthM = 0; })],
      ['azimuth of minus pi', edit('quad-x', c => { c.arms[0]!.azimuthRad = -Math.PI; })],
      ['tilt of 90 degrees', edit('quad-x', c => { c.arms[0]!.outwardTiltRad = Math.PI / 2; })],
      ['zero pair separation', edit('coaxial-x8', c => { c.arms[0]!.pairSeparationM = 0; })],
      ['output 0', edit('quad-x', c => { c.motors[0]!.output = 0; })],
      ['output 17', edit('quad-x', c => { c.motors[0]!.output = 17; })],
      ['upper-case card hash', edit('quad-x', c => { c.motors[0]!.components.motor = 'A'.repeat(64); })],
      ['short card hash', edit('quad-x', c => { c.battery.card = 'a'.repeat(63); })],
      ['zero payload mass', edit('hexa-x', c => { c.payload!.massKg = 0; })],
      ['NaN mass', edit('quad-x', c => { c.massProperties.massKg = NaN; })],
      ['zero ground clearance', edit('quad-x', c => { c.groundClearanceM = 0; })],
      ['a sensor configuration in schema 1', edit('quad-x', c => { Object.assign(c, { sensorConfiguration: {} }); })],
      ['no arms', edit('quad-x', c => { c.arms = []; c.motors = []; })],
    ];
    for (const [label, input] of invalid) expect(() => validateAircraftProfile(input), label).toThrow('Invalid aircraft profile');
  });

  test('cross-reference checks name the arm or motor at fault', () => {
    const invalid: [string, unknown, string][] = [
      ['unsorted arms', edit('quad-x', c => { c.arms.reverse(); }), 'Arm IDs must be unique and ascending'],
      ['duplicate arm IDs', edit('quad-x', c => { c.arms[1]!.id = 1; }), 'Arm IDs must be unique and ascending'],
      ['unsorted motors', edit('quad-x', c => { c.motors.reverse(); }), 'Motor IDs must be unique and ascending'],
      ['duplicate motor IDs', edit('quad-x', c => { c.motors[1]!.id = 1; }), 'Motor IDs must be unique and ascending'],
      ['motor on an unknown arm', edit('quad-x', c => { c.motors[0]!.armId = 7; }), 'Motor 1 names unknown arm 7'],
      ['arm without a motor', edit('quad-x', c => { c.arms.push({ ...c.arms[0]!, id: 5, lengthM: 0.3 }); }), 'Arm 5 has no motor'],
      ['shared mount point', edit('quad-x', c => { c.arms[1] = { ...c.arms[0]!, id: 2 }; }), 'Arms 1 and 2 share one mount point'],
    ];
    for (const [label, input, message] of invalid) expect(() => validateAircraftProfile(input), label).toThrow(message);
  });
});

describe('mass properties', () => {
  /** Independent oracle: sum each part's inertia about the reference point, then move the total to the combined CG. */
  function oracle(parts: readonly { massKg: number; cgOffsetBodyM: readonly number[]; inertiaCgKgM2: readonly number[] }[]) {
    const mass = parts.reduce((sum, part) => sum + part.massKg, 0);
    const cg = [0, 1, 2].map(i => parts.reduce((sum, part) => sum + part.massKg * part.cgOffsetBodyM[i]!, 0) / mass);
    const shift = (m: number, r: readonly number[]) =>
      [0, 1, 2].flatMap(i => [0, 1, 2].map(j => m * ((i === j ? dot(r, r) : 0) - r[i]! * r[j]!)));
    const aboutReference = parts.reduce((sum, part) => {
      const steiner = shift(part.massKg, part.cgOffsetBodyM);
      return sum.map((value, k) => value + part.inertiaCgKgM2[k]! + steiner[k]!);
    }, new Array<number>(9).fill(0));
    const back = shift(mass, cg);
    return { mass, cg, inertia: aboutReference.map((value, k) => value - back[k]!) };
  }

  test('a payload combines by the parallel-axis theorem; without one the aircraft values pass through', () => {
    for (const name of ['hexa-x', 'octa-coaxial-16'] as const) {
      const profile = fixture(name);
      const combined = combineMassProperties(profile.massProperties, profile.payload);
      const expected = oracle([profile.massProperties, profile.payload!]);
      expect(combined.massKg).toBe(expected.mass);
      expectVector(combined.cgOffsetBodyM, expected.cg, `${name} CG`);
      const trace = expected.inertia[0]! + expected.inertia[4]! + expected.inertia[8]!;
      for (let k = 0; k < 9; k++) {
        expect(Math.abs(combined.inertiaCgKgM2[k]! - expected.inertia[k]!), `${name} inertia ${k}`).toBeLessThanOrEqual(INERTIA_TOLERANCE_RELATIVE * trace);
      }
      for (const [i, j] of [[1, 3], [2, 6], [5, 7]] as const) expect(combined.inertiaCgKgM2[i]).toBe(combined.inertiaCgKgM2[j]);
    }
    // Hexa by hand: m = 2.4 + 0.35; x_cg = (2.4·0.01 + 0.35·0.08)/2.75; z_cg = (2.4·0.03 + 0.35·0.07)/2.75.
    const hexa = combineMassProperties(fixture('hexa-x').massProperties, fixture('hexa-x').payload);
    expect(hexa.massKg).toBeCloseTo(2.75, 14);
    expectVector(hexa.cgOffsetBodyM, [0.052 / 2.75, 0, 0.0965 / 2.75], 'hexa CG by hand');
    const quad = fixture('quad-x');
    expect(combineMassProperties(quad.massProperties, null)).toEqual(quad.massProperties);
  });
});

describe('manifest derivation', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test.each(FIXTURE_NAMES)('%s: a valid manifest v2 whose rotors match the oracle', async name => {
    const profile = fixture(name);
    const derived = await deriveVehicleManifest(profile, syntheticComponents(validateAircraftProfile(profile)), { modelId: FIXTURE_MODEL_ID });
    const manifest = derived.manifest;
    expect(validateVehicleManifest(manifest)).toEqual(manifest);
    expect([manifest.kind, manifest.modelId, manifest.rotorCount, manifest.ardupilot]).toEqual(['bet', FIXTURE_MODEL_ID, profile.motors.length, null]);
    // The manifest's rotors are the layout's, with channel = output - 1.
    const rotors: RotorLayout[] = manifest.rotors.map(rotor => {
      const motor = profile.motors.find(m => m.id === rotor.id)!;
      expect(rotor.motorChannel).toBe(motor.output - 1);
      const axis = rotateZ(rotor.hubToBody);
      return { motorId: rotor.id, armId: motor.armId, level: motor.level, output: motor.output, spinSign: rotor.spinSign,
        hubPositionBodyM: rotor.hubPositionBodyM, thrustAxisBody: axis, hubToBody: rotor.hubToBody };
    });
    checkAgainstOracle(profile, rotors);
    expect(manifest.motors.map(m => [m.id, m.rotorId])).toEqual(profile.motors.map(m => [m.id, m.id]));
    expect(manifest.escs.map(e => [e.id, e.motorId])).toEqual(profile.motors.map(m => [m.id, m.id]));
    expect(manifest.rotorWakePairs).toEqual(deriveLayout(validateAircraftProfile(profile)).wakePairs.map(pair =>
      ({ upstreamRotorId: pair.upstreamMotorId, downstreamRotorId: pair.downstreamMotorId })));
    expect(manifest.massProperties).toEqual(combineMassProperties(profile.massProperties, profile.payload));
    // One synthetic dataset names the exact inputs; every section with data points to it.
    expect(manifest.datasets).toEqual([{ id: DERIVED_DATASET_ID, kind: 'synthetic', sourceSha256: derived.inputSha256,
      derivation: expect.stringContaining(derived.profileSha256) as unknown }]);
    expect(manifest.provenance).toEqual({ massProperties: DERIVED_DATASET_ID, rotors: DERIVED_DATASET_ID, motors: DERIVED_DATASET_ID,
      escs: DERIVED_DATASET_ID, battery: DERIVED_DATASET_ID, airframeDrag: null, controlSurfaces: null, landingGear: null,
      sensorMounts: null, rotorWakePairs: manifest.rotorWakePairs.length > 0 ? DERIVED_DATASET_ID : null });
    // The dataset hashes are those of the canonical profile and of the canonical derivation input.
    const hash = (value: unknown) => createHash('sha256').update(canonicalBytes(value)).digest('hex');
    const validated = validateAircraftProfile(profile), components = syntheticComponents(validated);
    expect(derived.profileSha256).toBe(hash(validated));
    expect(derived.inputSha256).toBe(hash({ derivationVersion: 2, profile: validated, components }));
    // The bytes are the canonical form of the manifest, and the session registry admits them.
    const parsed: unknown = JSON.parse(new TextDecoder().decode(derived.bytes));
    expect(parsed).toEqual(manifest);
    const verified = await new VehicleRegistry().register(derived.bytes, derived.sha256);
    expect(verified.schemaVersion).toBe(2);
  });

  test('derivation is byte-reproducible and independent of the engine trigonometry', async () => {
    for (const name of FIXTURE_NAMES) {
      const profile = fixture(name), components = syntheticComponents(validateAircraftProfile(profile));
      const first = await deriveVehicleManifest(profile, components, { modelId: FIXTURE_MODEL_ID });
      // Reversed key order in every object of the input gives the same bytes.
      const reversed: unknown = JSON.parse(JSON.stringify(profile, (_key, value: unknown) =>
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse()) : value));
      // With the engine's sine, cosine and tangent unavailable, the derivation still succeeds.
      for (const fn of ['sin', 'cos', 'tan', 'atan2', 'atan', 'asin', 'acos'] as const) {
        vi.spyOn(Math, fn).mockImplementation(() => { throw new Error(`Math.${fn} was called`); });
      }
      const second = await deriveVehicleManifest(reversed, components, { modelId: FIXTURE_MODEL_ID });
      vi.restoreAllMocks();
      expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes)), name).toBe(true);
      expect(second.sha256).toBe(first.sha256);
      expect(first.sha256, `${name} recorded bytes`).toBe(RECORDED_MANIFEST_SHA256[name]);
      expect(asDerivation1(first.manifest, profile, components), `${name} derivation 1 bytes`).toBe(RECORDED_V1_MANIFEST_SHA256[name]);
    }
    // Arm angles at which Node's and Chromium's Math functions disagree; the browser test derives the same bytes.
    const variant = engineSensitiveVariant(validateAircraftProfile(fixture('octa-coaxial-16')));
    const sensitive = await deriveVehicleManifest(variant, syntheticComponents(validateAircraftProfile(variant)), { modelId: FIXTURE_MODEL_ID });
    checkAgainstOracle(structuredClone(validateAircraftProfile(variant)) as ProfileData, deriveLayout(validateAircraftProfile(variant)).rotors);
    expect(sensitive.sha256).toBe(RECORDED_ENGINE_SENSITIVE_SHA256);
    expect(asDerivation1(sensitive.manifest, variant, syntheticComponents(validateAircraftProfile(variant)))).toBe(RECORDED_V1_ENGINE_SENSITIVE_SHA256);
  });

  test('a change to geometry or components changes the manifest; the model ID is the only other input', async () => {
    const base = fixture('octa-x'), components = syntheticComponents(validateAircraftProfile(base));
    const reference = await deriveVehicleManifest(base, components, { modelId: FIXTURE_MODEL_ID });
    const longer = edit('octa-x', c => { c.arms[0]!.lengthM = 0.351; });
    const heavier = edit('octa-x', c => { c.massProperties.massKg = 4.3; });
    const remapped = edit('octa-x', c => { c.motors[0]!.output = 8; c.motors[7]!.output = 1; });
    const otherPropeller = structuredClone(components) as Mutable<ResolvedComponents>;
    otherPropeller.motors[0]!.rotor.radiusM = 0.15;
    otherPropeller.motors[0]!.rotor.quadratureWidthM = [0.04, 0.04, 0.05];
    const variants = await Promise.all([
      deriveVehicleManifest(longer, components, { modelId: FIXTURE_MODEL_ID }),
      deriveVehicleManifest(heavier, components, { modelId: FIXTURE_MODEL_ID }),
      deriveVehicleManifest(remapped, syntheticComponents(validateAircraftProfile(remapped)), { modelId: FIXTURE_MODEL_ID }),
      deriveVehicleManifest(base, otherPropeller, { modelId: FIXTURE_MODEL_ID }),
      deriveVehicleManifest(base, components, { modelId: FIXTURE_MODEL_ID + 1 }),
    ]);
    const hashes = new Set([reference.sha256, ...variants.map(v => v.sha256)]);
    expect(hashes.size).toBe(6);
  });

  test('negative zeros in the inputs become zeros, so the manifest equals its bytes', async () => {
    const signed = edit('quad-x', c => { c.arms[0]!.heightM = -0; c.massProperties.cgOffsetBodyM = [0.005, -0, 0.02]; });
    const components = syntheticComponents(validateAircraftProfile(signed)) as Mutable<ResolvedComponents>;
    components.motors[0]!.rotor.twistRad = [-0, 0.2, 0.2];
    const derived = await deriveVehicleManifest(signed, components, { modelId: FIXTURE_MODEL_ID });
    expect(Object.is(derived.manifest.rotors[0]!.hubPositionBodyM[2], 0)).toBe(true);
    expect(Object.is(derived.manifest.massProperties.cgOffsetBodyM[1], 0)).toBe(true);
    expect(Object.is(derived.manifest.rotors[0]!.twistRad[0], 0)).toBe(true);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(derived.bytes));
    expect(parsed).toStrictEqual(structuredClone(derived.manifest));
  });

  test('without motor, ESC and battery values the manifest holds rotors only and projects to the v1 runtime', async () => {
    const quad = fixture('quad-x');
    const derived = await deriveVehicleManifest(quad, syntheticComponents(validateAircraftProfile(quad), false), { modelId: FIXTURE_MODEL_ID });
    expect([derived.manifest.motors, derived.manifest.escs, derived.manifest.battery]).toEqual([[], [], null]);
    expect([derived.manifest.provenance.motors, derived.manifest.provenance.escs, derived.manifest.provenance.battery]).toEqual([null, null, null]);
    const v1 = projectVehicleToModelV1(derived.manifest);
    const cg = quad.massProperties.cgOffsetBodyM;
    // The v1 descriptor is CG-referenced: hub minus CG.
    expectVector(v1.rotors[0]!.hubPositionBodyM, derived.manifest.rotors[0]!.hubPositionBodyM.map((value, i) => value - cg[i]!), 'v1 hub');
    // Wake pairs have no v1 consumer yet (TASK-101), so a coaxial manifest fails closed there.
    const x8 = fixture('coaxial-x8');
    const coaxial = await deriveVehicleManifest(x8, syntheticComponents(validateAircraftProfile(x8), false), { modelId: FIXTURE_MODEL_ID });
    expect(() => projectVehicleToModelV1(coaxial.manifest)).toThrow('rotorWakePairs (TASK-101)');
  });

  test('resolved components must cover exactly the profile motors and their referenced cards', async () => {
    const card = (digit: string) => digit.repeat(64);
    const profile = edit('quad-x', c => {
      c.motors.forEach(m => { m.components = { motor: card('1'), propeller: card('2'), esc: card('3') }; });
      c.battery.card = card('4');
    });
    const good = syntheticComponents(validateAircraftProfile(profile));
    await expect(deriveVehicleManifest(profile, good, { modelId: 1 })).resolves.toBeDefined();
    const variants: [string, (c: Mutable<ResolvedComponents>) => void, string][] = [
      ['a missing motor', c => { c.motors.pop(); }, 'lack motor 4'],
      ['an unknown motor', c => { c.motors[3]!.motorId = 9; }, 'unknown motor 9'],
      ['a motor listed twice', c => { c.motors[3]!.motorId = 1; }, 'motor 1 twice'],
      ['another propeller card', c => { c.motors[0]!.cards.propeller = card('5'); }, 'Motor 1 was resolved from other component cards'],
      ['another battery card', c => { c.battery!.card = card('5'); }, 'battery was resolved from another card'],
      ['motor values for some motors only', c => { c.motors[2]!.motor = null; }, 'every motor has motor values or none'],
      ['ESC values for some motors only', c => { c.motors[2]!.esc = null; }, 'every motor has ESC values or none'],
      ['no description', c => { c.description = ''; }, 'description'],
      ['a blade field the manifest does not know', c => { Object.assign(c.motors[0]!.rotor, { pitchM: 0.1 }); }, 'Invalid vehicle schema'],
    ];
    for (const [label, change, message] of variants) {
      const components = structuredClone(good) as Mutable<ResolvedComponents>;
      change(components);
      await expect(deriveVehicleManifest(profile, components, { modelId: 1 }), label).rejects.toThrow(message);
    }
  });
});

describe('deterministic trigonometry', () => {
  /** Distance in units in the last place, by the integer order of the two doubles' bit patterns. */
  function ulps(a: number, b: number): number {
    const view = new DataView(new ArrayBuffer(16));
    view.setFloat64(0, a); view.setFloat64(8, b);
    const order = (bits: bigint) => (bits >> 63n ? -(bits & 0x7fffffffffffffffn) : bits);
    const difference = order(view.getBigUint64(0)) - order(view.getBigUint64(8));
    return Number(difference < 0n ? -difference : difference);
  }

  test('sine and cosine are within 2 ulp of the engine, and tangent within 4 ulp', () => {
    let worstSinCos = 0, worstTan = 0;
    for (let i = 0; i <= 40000; i++) {
      const x = -Math.PI + (2 * Math.PI * i) / 40000;
      const { sin, cos } = sinCos(x);
      worstSinCos = Math.max(worstSinCos, ulps(sin, Math.sin(x)), ulps(cos, Math.cos(x)));
    }
    for (const x of [Math.PI, -Math.PI / 2, Math.PI / 2, Math.PI / 4, 3 * Math.PI / 4, 1e-300, 4, -4]) {
      const { sin, cos } = sinCos(x);
      worstSinCos = Math.max(worstSinCos, ulps(sin, Math.sin(x)), ulps(cos, Math.cos(x)));
    }
    for (let i = 0; i <= 20000; i++) {
      const x = -1.55 + (3.1 * i) / 20000;
      worstTan = Math.max(worstTan, ulps(tan(x), Math.tan(x)));
    }
    expect(worstSinCos).toBeLessThanOrEqual(2);
    expect(worstTan).toBeLessThanOrEqual(4);
  });

  test('exact values, symmetry and domain', () => {
    expect(sinCos(0)).toEqual({ sin: 0, cos: 1 });
    for (const x of [0.1, 0.7853981633974483, 1.5, 2.5, 3.141592653589793]) {
      expect(sinCos(-x).sin).toBe(-sinCos(x).sin);
      expect(sinCos(-x).cos).toBe(sinCos(x).cos);
      expect(tan(-x)).toBe(-tan(x));
    }
    expect(sinCos(Math.PI / 2).sin).toBe(1);
    for (const x of [4.000001, -5, Infinity, NaN]) expect(() => sinCos(x)).toThrow(RangeError);
  });

  test('the three parts of pi/2 come from an independently computed pi', () => {
    // pi·2^BITS by Machin's formula, pi = 16·atan(1/5) - 4·atan(1/239), in integer arithmetic.
    const BITS = 220n, one = 1n << BITS;
    const atanInverse = (x: bigint): bigint => {
      let term = one / x, total = term, sign = -1n;
      for (let k = 1n; term !== 0n; k++, sign = -sign) {
        term /= x * x;
        total += sign * (term / (2n * k + 1n));
      }
      return total;
    };
    const halfPi = (16n * atanInverse(5n) - 4n * atanInverse(239n)) / 2n;
    /** The 53-bit integer mantissa and binary exponent of a positive normal double: value = mantissa·2^exponent. */
    const split = (value: number): [bigint, bigint] => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, value);
      const bits = view.getBigUint64(0);
      return [(bits & ((1n << 52n) - 1n)) | (1n << 52n), ((bits >> 52n) & 0x7ffn) - 1075n];
    };
    /** A double as an exact BigInt fixed-point value at 2^BITS. */
    const fixed = (value: number): bigint => {
      const [mantissa, exponent] = split(value);
      return mantissa << (exponent + BITS);
    };
    const [p1 = 0, p2 = 0, p3 = 0] = PIO2_PARTS;
    const residual = halfPi - fixed(p1) - fixed(p2) - fixed(p3);
    expect(residual < 0n ? -residual : residual).toBeLessThan(1n << (BITS - 120n));
    // The first two parts have at most 33 significant bits, so their products with small integers are exact.
    for (const part of [p1, p2]) expect(split(part)[0] % (1n << 20n)).toBe(0n);
  });
});

describe('project store', () => {
  function newStore(): ProjectStore {
    let ids = 0;
    return new ProjectStore(new MemoryBackend(), {
      now: () => new Date(Date.UTC(2026, 9, 29, 12)),
      uuid: () => `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, '0')}`,
      storage: null,
      validators: { 'aircraft-profile': validateAircraftProfile },
    });
  }

  test('profiles are versioned records whose dependencies are exactly their component cards', async () => {
    const store = newStore();
    const project = await store.createProject('Hexa trials');
    const motorCard = await store.createItem(project.record.id, 'component-card', { name: 'Motor 920 KV', payload: {} });
    const batteryCard = await store.createItem(project.record.id, 'component-card', { name: 'Battery 4S', payload: {} });
    const profile = edit('hexa-x', c => {
      c.motors.forEach(m => { m.components.motor = motorCard.sha256; });
      c.battery.card = batteryCard.sha256;
    });
    const draft = profileDraft('Hexa', profile);
    expect(draft.dependencies).toEqual([motorCard.sha256, batteryCard.sha256].sort());
    expect(profileComponentCards(validateAircraftProfile(profile))).toEqual(draft.dependencies);
    const stored = await store.createItem(project.record.id, 'aircraft-profile', draft);
    expect(readAircraftProfile(stored)).toEqual(validateAircraftProfile(profile));
    // The store refuses an invalid profile through the registered validator.
    const refused = store.createItem(project.record.id, 'aircraft-profile', { name: 'Broken', payload: edit('hexa-x', c => { c.motors[1]!.output = 1; }) });
    await expect(refused).rejects.toBeInstanceOf(ProjectStoreError);
    await expect(refused).rejects.toThrow('Output 1 is assigned to motors 1 and 2');
    // A record whose dependencies do not list the referenced cards is refused when read.
    const unlisted = await store.createItem(project.record.id, 'aircraft-profile', { name: 'Unlisted', payload: profile });
    expect(() => readAircraftProfile(unlisted)).toThrow('dependencies must list exactly its component cards');
    expect(() => readAircraftProfile(motorCard)).toThrow('not an aircraft profile');
  });

  test('an edit is a new version with a new manifest; a rename keeps the manifest', async () => {
    const store = newStore();
    const project = await store.createProject('Octo trials');
    const first = await store.createItem(project.record.id, 'aircraft-profile', profileDraft('Octo', fixture('octa-x')));
    const derive = async (stored: typeof first) => {
      const profile = readAircraftProfile(stored);
      return (await deriveVehicleManifest(profile, syntheticComponents(profile), { modelId: FIXTURE_MODEL_ID })).sha256;
    };
    const renamed = await store.saveVersion(first.record.id, first.sha256, profileDraft('Octo X', fixture('octa-x')));
    const edited = await store.saveVersion(first.record.id, renamed.sha256,
      profileDraft('Octo X', edit('octa-x', c => { c.arms[2]!.heightM = 0.01; })));
    expect([renamed.record.version, edited.record.version]).toEqual([2, 3]);
    expect(await derive(renamed)).toBe(await derive(first));
    expect(await derive(edited)).not.toBe(await derive(first));
    expect(await derive(await store.get(first.sha256))).toBe(await derive(first));
  });
});
