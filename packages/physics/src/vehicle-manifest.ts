import { Ajv } from 'ajv';
import schema from './vehicle.schema.json';
import { validateModelManifest, type ModelDescriptor, type RotorGeometry } from './model-manifest.ts';
import type { GasSuspension, LinearSuspension } from './ground-contact.ts';
import type { SessionDynamics, SessionModelPort } from './session-v2.ts';
import type { PhysicsHz } from '@mirage/protocol';

// Vehicle manifest v2 (TASK-087). Configuration-time validation only; never
// call from a physics step. Body-frame positions (`*BodyM`) are FRD metres
// from the body reference point; derived `*CgM` values are relative to the CG.

/** Sections that carry data and therefore a dataset reference in `provenance`. */
export const VEHICLE_SECTIONS = ['massProperties', 'rotors', 'motors', 'escs', 'battery', 'airframeDrag',
  'controlSurfaces', 'landingGear', 'sensorMounts', 'rotorWakePairs'] as const;
export type VehicleSection = typeof VEHICLE_SECTIONS[number];

export type VehicleDataset =
  | { readonly id: string; readonly kind: 'synthetic'; readonly sourceSha256: string | null; readonly derivation: string }
  | { readonly id: string; readonly kind: 'measured'; readonly sourceSha256: string; readonly license: string;
    readonly acquiredAt: string; readonly reference: string };
export interface MassProperties {
  readonly massKg: number;
  /** CG position from the body reference point, body FRD metres. */
  readonly cgOffsetBodyM: readonly number[];
  /** Row-major inertia about the CG in body FRD axes. */
  readonly inertiaCgKgM2: readonly number[];
}
export interface MotorSpec {
  readonly id: number; readonly rotorId: number; readonly kvRpmPerV: number;
  readonly resistanceOhm: number; readonly currentLimitA: number;
}
export interface EscSpec {
  readonly id: number; readonly motorId: number; readonly pwmMinUs: number; readonly pwmMaxUs: number;
  readonly commandTauS: number;
}
export interface BatterySpec {
  readonly openCircuitFullV: number; readonly openCircuitEmptyV: number; readonly internalResistanceOhm: number;
  readonly capacityAh: number; readonly currentLimitA: number;
}
export interface AirframeDrag {
  /** Row-major symmetric drag-area tensor (C_D·A), body FRD, m^2. */
  readonly dragAreaBodyM2: readonly number[];
  readonly centerOfPressureBodyM: readonly number[];
}
export interface ControlSurfaceSpec {
  readonly id: number; readonly function: 'aileron' | 'elevator' | 'rudder' | 'flap' | 'elevon' | 'ruddervator';
  readonly actuatorChannel: number; readonly deflectionMinRad: number; readonly deflectionMaxRad: number;
  readonly rateLimitRadS: number;
}
/** Same fields as `ContactWheel`, except that the anchor is relative to the body reference point. */
export interface LandingGearSpec {
  readonly id: number; readonly anchorBodyM: readonly number[]; readonly unsprungMassKg: number;
  readonly tireRadiusM: number; readonly rimRadiusM: number; readonly strutTravelM: number;
  readonly suspension: LinearSuspension | GasSuspension; readonly tireLoadCurve: readonly (readonly number[])[];
  readonly tireDampingNsPm: number; readonly rollingCoefficient: number; readonly lateralCoefficient: number;
  readonly brakingCoefficient: number;
}
export interface SensorMount {
  readonly sensor: 'imu' | 'baro' | 'mag' | 'gnss' | 'airspeed' | 'rangefinder'; readonly instance: number;
  readonly positionBodyM: readonly number[]; readonly sensorToBody: readonly number[];
}
export interface RotorWakePair { readonly upstreamRotorId: number; readonly downstreamRotorId: number }
export interface ArduPilotFrame { readonly vehicle: 'copter'; readonly frameClass: number; readonly frameType: number }
export interface VehicleManifest {
  readonly schemaVersion: 2; readonly modelId: number; readonly kind: 'demo' | 'bet' | 'jsbsim';
  readonly units: 'SI'; readonly worldFrame: 'NED'; readonly bodyFrame: 'FRD'; readonly quaternionOrder: 'wxyz';
  readonly datasets: readonly VehicleDataset[];
  readonly provenance: { readonly [section in VehicleSection]: string | null };
  readonly massProperties: MassProperties;
  readonly rotorCount: number; readonly rotorCapacity: 32; readonly rotors: readonly RotorGeometry[];
  readonly motors: readonly MotorSpec[]; readonly escs: readonly EscSpec[]; readonly battery: BatterySpec | null;
  readonly airframe: { readonly drag: AirframeDrag | null };
  readonly controlSurfaces: readonly ControlSurfaceSpec[]; readonly landingGear: readonly LandingGearSpec[];
  readonly sensorMounts: readonly SensorMount[]; readonly rotorWakePairs: readonly RotorWakePair[];
  readonly ardupilot: ArduPilotFrame | null;
}
export interface DerivedVehicle {
  /** Ascending principal moments about the CG. */
  readonly principalMomentsKgM2: readonly number[];
  /** Row-major 3x3 whose columns are unit principal axes in body FRD; determinant +1. */
  readonly principalAxesBody: readonly number[];
  /** SI k_t = k_e = 60/(2π·KV) per motor, in `motors` order. */
  readonly motorTorqueConstantNmPerA: readonly number[];
  /** Hub positions relative to the CG, three per rotor in `rotors` order. */
  readonly rotorHubPositionCgM: readonly number[];
  readonly landingGearAnchorCgM: readonly number[];
  readonly sensorPositionCgM: readonly number[];
}
export type VerifiedVehicle =
  | { readonly sha256: string; readonly schemaVersion: 1; readonly manifest: ModelDescriptor }
  | { readonly sha256: string; readonly schemaVersion: 2; readonly manifest: VehicleManifest };

// Union types express nullable sections; the `kind` discriminator reports the selected branch's errors.
const validateSchema = new Ajv({ strict: true, strictNumbers: true, allowUnionTypes: true, discriminator: true })
  .compile<VehicleManifest>(schema);
/** Quaternion norm tolerance shared with the v1 rotor check. */
const QUATERNION_NORM_TOLERANCE = 1e-6;
/**
 * Inertia realizability: every principal moment is at most the sum of the
 * other two (equality for a planar body). The slack admits only eigen-solver
 * round-off, which is O(1e-16·trace) for this cyclic Jacobi solver.
 */
const TRIANGLE_SLACK_RELATIVE = 1e-12;
/** A quad-X thrust axis may be at most 45° from body up (|z| >= cos 45°). */
const MATRIX_FRAME_AXIS_MIN_UP = Math.SQRT1_2;
/** Sections without a runtime consumer yet, and the task that owns the consumer. */
const SECTION_OWNERS: { readonly [section in VehicleSection]: string } = {
  massProperties: 'TASK-033', rotors: 'TASK-033', motors: 'TASK-092', escs: 'TASK-092', battery: 'TASK-092',
  airframeDrag: 'TASK-096', controlSurfaces: 'TASK-109', landingGear: 'TASK-095', sensorMounts: 'TASK-114',
  rotorWakePairs: 'TASK-101',
};

function freeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function unique(values: readonly (number | string)[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}
function quaternionNormalized(q: readonly number[]): boolean {
  // Schema validation fixes the length at four.
  return Math.abs(Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) - 1) <= QUATERNION_NORM_TOLERANCE;
}
/** Third column of the rotation matrix of a unit wxyz quaternion: the frame's +z axis in the parent. */
function zAxis(q: readonly number[]): readonly [number, number, number] {
  const norm = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
  const w = q[0]! / norm, x = q[1]! / norm, y = q[2]! / norm, z = q[3]! / norm;
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}
function sectionPresent(manifest: VehicleManifest, section: VehicleSection): boolean {
  switch (section) {
    case 'massProperties': return true;
    case 'rotors': return manifest.rotors.length > 0;
    case 'motors': return manifest.motors.length > 0;
    case 'escs': return manifest.escs.length > 0;
    case 'battery': return manifest.battery !== null;
    case 'airframeDrag': return manifest.airframe.drag !== null;
    case 'controlSurfaces': return manifest.controlSurfaces.length > 0;
    case 'landingGear': return manifest.landingGear.length > 0;
    case 'sensorMounts': return manifest.sensorMounts.length > 0;
    case 'rotorWakePairs': return manifest.rotorWakePairs.length > 0;
    default: {
      const unreachable: never = section;
      throw new Error(`Unknown vehicle section ${String(unreachable)}`);
    }
  }
}

/**
 * Cyclic Jacobi eigen decomposition of a finite symmetric 3x3 matrix
 * (Golub and Van Loan, Matrix Computations, 4th ed., algorithm 8.5.3).
 * Returns ascending eigenvalues and a right-handed matrix of unit column
 * eigenvectors. Degenerate eigenvalues have no unique eigenvectors.
 */
export function symmetricEigen3(matrix: readonly number[]): { values: number[]; vectors: number[] } {
  if (matrix.length !== 9 || !matrix.every(Number.isFinite)) throw new Error('Eigen input must be nine finite values');
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < row; col++) {
      if (matrix[row * 3 + col] !== matrix[col * 3 + row]) throw new Error('Eigen input must be symmetric');
    }
  }
  const a = Float64Array.from(matrix), v = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const pairs = [0, 1, 0, 2, 1, 2];
  let converged = false;
  for (let sweep = 0; sweep < 50 && !converged; sweep++) {
    converged = true;
    for (let k = 0; k < pairs.length; k += 2) {
      const p = pairs[k]!, q = pairs[k + 1]!, apq = a[p * 3 + q]!;
      if (apq === 0) continue;
      const app = a[p * 3 + p]!, aqq = a[q * 3 + q]!;
      // After four sweeps an entry below the diagonal precision is exactly zeroed (Numerical Recipes, jacobi).
      if (sweep > 3 && Math.abs(app) + 100 * Math.abs(apq) === Math.abs(app) &&
        Math.abs(aqq) + 100 * Math.abs(apq) === Math.abs(aqq)) {
        a[p * 3 + q] = 0; a[q * 3 + p] = 0;
        continue;
      }
      converged = false;
      const theta = (aqq - app) / (2 * apq);
      const sign = theta >= 0 ? 1 : -1;
      const t = Math.abs(theta) > 1e150 ? 1 / (2 * theta) : sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      a[p * 3 + p] = app - t * apq; a[q * 3 + q] = aqq + t * apq;
      a[p * 3 + q] = 0; a[q * 3 + p] = 0;
      const r = 3 - p - q; // the remaining index of {0,1,2}
      const arp = a[r * 3 + p]!, arq = a[r * 3 + q]!;
      a[r * 3 + p] = c * arp - s * arq; a[p * 3 + r] = a[r * 3 + p]!;
      a[r * 3 + q] = s * arp + c * arq; a[q * 3 + r] = a[r * 3 + q]!;
      for (let row = 0; row < 3; row++) {
        const vp = v[row * 3 + p]!, vq = v[row * 3 + q]!;
        v[row * 3 + p] = c * vp - s * vq; v[row * 3 + q] = s * vp + c * vq;
      }
    }
  }
  if (!converged) throw new Error('Eigen decomposition did not converge');
  const order = [0, 1, 2].sort((i, j) => a[i * 3 + i]! - a[j * 3 + j]!);
  const values = order.map(i => a[i * 3 + i]!), vectors = new Array<number>(9).fill(0);
  for (let col = 0; col < 3; col++) {
    const source = order[col]!;
    let largest = 0;
    for (let row = 0; row < 3; row++) if (Math.abs(v[row * 3 + source]!) > Math.abs(v[largest * 3 + source]!)) largest = row;
    const sign = v[largest * 3 + source]! < 0 ? -1 : 1;
    for (let row = 0; row < 3; row++) vectors[row * 3 + col] = sign * v[row * 3 + source]!;
  }
  const det = vectors[0]! * (vectors[4]! * vectors[8]! - vectors[5]! * vectors[7]!) -
    vectors[1]! * (vectors[3]! * vectors[8]! - vectors[5]! * vectors[6]!) +
    vectors[2]! * (vectors[3]! * vectors[7]! - vectors[4]! * vectors[6]!);
  if (det < 0) for (let row = 0; row < 3; row++) vectors[row * 3 + 2] = -vectors[row * 3 + 2]!;
  return { values, vectors };
}
/** Exactly symmetric and positive definite by Cholesky factorization (no symmetrization or regularization). */
function assertSymmetricPositiveDefinite(matrix: readonly number[], label: string): void {
  const lower = new Float64Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col <= row; col++) {
      if (matrix[row * 3 + col] !== matrix[col * 3 + row]) throw new Error(`${label} must be symmetric`);
      let pivot = matrix[row * 3 + col]!;
      for (let k = 0; k < col; k++) pivot -= lower[row * 3 + k]! * lower[col * 3 + k]!;
      if (!Number.isFinite(pivot) || (row === col && pivot <= 0)) throw new Error(`${label} must be positive definite`);
      lower[row * 3 + col] = row === col ? Math.sqrt(pivot) : pivot / lower[col * 3 + col]!;
    }
  }
}
function shifted(position: readonly number[], origin: readonly number[]): number[] {
  return [position[0]! - origin[0]!, position[1]! - origin[1]!, position[2]! - origin[2]!];
}
/** ArduCopter FRAME_CLASS 1 / FRAME_TYPE 1 (quad X), checked against the TASK-047 parity aircraft. */
function assertQuadX(manifest: VehicleManifest): void {
  if (manifest.rotorCount !== 4) throw new Error('ArduCopter quad X requires four rotors');
  // Pinned AP_MotorsMatrix quad-X order by actuator channel: FR, RL, FL, RR.
  // FR and RL spin about body up (CCW seen from above); FL and RR about body down.
  const xs = [1, -1, 1, -1], ys = [1, -1, -1, 1], spinUp = [true, true, false, false];
  const cg = manifest.massProperties.cgOffsetBodyM;
  for (let channel = 0; channel < 4; channel++) {
    const rotor = manifest.rotors.find(item => item.motorChannel === channel);
    if (!rotor) throw new Error(`ArduCopter quad X requires actuator channels 0..3; channel ${channel} is missing`);
    const hub = shifted(rotor.hubPositionBodyM, cg), axis = zAxis(rotor.hubToBody);
    if (Math.sign(hub[0]!) !== xs[channel] || Math.sign(hub[1]!) !== ys[channel]) {
      throw new Error(`Rotor on channel ${channel} is not in the ArduCopter quad X position`);
    }
    // Hub +z is the positive thrust axis; it must point within 45° of body up (-z).
    if (-axis[2] < MATRIX_FRAME_AXIS_MIN_UP) throw new Error(`Rotor on channel ${channel} does not thrust upward as ArduCopter quad X requires`);
    if ((rotor.spinSign * axis[2] < 0) !== spinUp[channel]) {
      throw new Error(`Rotor on channel ${channel} spins against the ArduCopter quad X direction`);
    }
  }
}
function assertAcyclic(pairs: readonly RotorWakePair[]): void {
  const edges = new Map<number, number[]>();
  for (const pair of pairs) edges.set(pair.upstreamRotorId, [...(edges.get(pair.upstreamRotorId) ?? []), pair.downstreamRotorId]);
  const state = new Map<number, 'active' | 'done'>();
  const visit = (node: number): void => {
    const seen = state.get(node);
    if (seen === 'done') return;
    if (seen === 'active') throw new Error('Rotor wake pairs must be acyclic');
    state.set(node, 'active');
    for (const next of edges.get(node) ?? []) visit(next);
    state.set(node, 'done');
  };
  for (const node of edges.keys()) visit(node);
}

/** Schema plus physical and cross-reference checks; returns a deep-frozen snapshot. */
export function validateVehicleManifest(input: unknown): VehicleManifest {
  const manifest: unknown = structuredClone(input);
  if (!validateSchema(manifest)) {
    const error = validateSchema.errors?.[0];
    throw new Error(`Invalid vehicle schema: ${error?.instancePath || '/'} ${error?.message ?? 'unknown error'}`);
  }
  // Rotor geometry and the inertia tensor reuse the v1 checks unchanged.
  validateModelManifest(projectRotorBody(manifest));
  const principal = symmetricEigen3(manifest.massProperties.inertiaCgKgM2).values;
  const trace = principal[0]! + principal[1]! + principal[2]!;
  if (principal[2]! - principal[0]! - principal[1]! > TRIANGLE_SLACK_RELATIVE * trace) {
    throw new Error('Inertia violates the rigid-body triangle inequality');
  }

  unique(manifest.datasets.map(item => item.id), 'Duplicate dataset ID');
  for (const dataset of manifest.datasets) {
    if (dataset.kind === 'measured' && !Number.isFinite(Date.parse(dataset.acquiredAt))) throw new Error('Invalid dataset acquisition time');
  }
  const referenced = new Set<string>();
  for (const section of VEHICLE_SECTIONS) {
    const id = manifest.provenance[section];
    if (sectionPresent(manifest, section) !== (id !== null)) throw new Error(`Provenance for ${section} must name a dataset exactly when the section has data`);
    if (id === null) continue;
    if (!manifest.datasets.some(item => item.id === id)) throw new Error(`Provenance for ${section} names an unknown dataset`);
    referenced.add(id);
  }
  if (referenced.size !== manifest.datasets.length) throw new Error('Every dataset must be referenced by a section');

  const rotorIds = manifest.rotors.map(rotor => rotor.id);
  unique(manifest.motors.map(motor => motor.id), 'Duplicate motor ID');
  unique(manifest.motors.map(motor => motor.rotorId), 'Two motors drive one rotor');
  for (const motor of manifest.motors) if (!rotorIds.includes(motor.rotorId)) throw new Error('Motor names an unknown rotor');
  unique(manifest.escs.map(esc => esc.id), 'Duplicate ESC ID');
  unique(manifest.escs.map(esc => esc.motorId), 'Two ESCs drive one motor');
  for (const esc of manifest.escs) {
    if (!manifest.motors.some(motor => motor.id === esc.motorId)) throw new Error('ESC names an unknown motor');
    // The ExternalSitl boundary accepts integer PWM in [800, 2200] µs with at least 100 µs span.
    if (esc.pwmMaxUs - esc.pwmMinUs < 100) throw new Error('ESC PWM span must be at least 100 us');
  }
  const battery = manifest.battery;
  if (battery && battery.openCircuitFullV < battery.openCircuitEmptyV) throw new Error('Battery full voltage is below empty voltage');
  const drag = manifest.airframe.drag;
  if (drag) assertSymmetricPositiveDefinite(drag.dragAreaBodyM2, 'Drag area tensor');

  const rotorChannels = manifest.rotors.map(rotor => rotor.motorChannel);
  unique(manifest.controlSurfaces.map(surface => surface.id), 'Duplicate control surface ID');
  unique(manifest.controlSurfaces.map(surface => surface.actuatorChannel), 'Duplicate control surface channel');
  for (const surface of manifest.controlSurfaces) {
    if (rotorChannels.includes(surface.actuatorChannel)) throw new Error('Control surface channel is used by a rotor');
    if (surface.deflectionMinRad >= surface.deflectionMaxRad) throw new Error('Control surface deflection range is empty');
  }
  unique(manifest.landingGear.map(gear => gear.id), 'Duplicate landing gear ID');
  for (const gear of manifest.landingGear) {
    // Mirrors the native contact configuration checks; strut and tire laws stay authoritative natively.
    if (gear.rimRadiusM >= gear.tireRadiusM) throw new Error('Rim radius must be below tire radius');
    const last = gear.tireLoadCurve[gear.tireLoadCurve.length - 1]!; // schema: at least two knots
    if (last[0]! + 1e-12 < gear.tireRadiusM - gear.rimRadiusM) throw new Error('Tire curve must reach rim contact');
  }
  unique(manifest.sensorMounts.map(mount => `${mount.sensor}:${mount.instance}`), 'Duplicate sensor mount');
  for (const mount of manifest.sensorMounts) {
    if (!quaternionNormalized(mount.sensorToBody)) throw new Error('Sensor quaternion must be normalized');
  }
  unique(manifest.rotorWakePairs.map(pair => `${pair.upstreamRotorId}>${pair.downstreamRotorId}`), 'Duplicate rotor wake pair');
  for (const pair of manifest.rotorWakePairs) {
    if (!rotorIds.includes(pair.upstreamRotorId) || !rotorIds.includes(pair.downstreamRotorId)) throw new Error('Rotor wake pair names an unknown rotor');
    if (pair.upstreamRotorId === pair.downstreamRotorId) throw new Error('A rotor cannot be in its own wake pair');
  }
  assertAcyclic(manifest.rotorWakePairs);

  const frame = manifest.ardupilot;
  if (frame) {
    if (frame.frameClass !== 1 || frame.frameType !== 1) {
      throw new Error('Only ArduCopter FRAME_CLASS 1 / FRAME_TYPE 1 (quad X) has repository evidence');
    }
    assertQuadX(manifest);
  }
  return freeze(manifest);
}

/** The rotor/body part as a CG-referenced v1 descriptor; checked by `validateModelManifest`. */
function projectRotorBody(manifest: VehicleManifest): ModelDescriptor {
  const cg = manifest.massProperties.cgOffsetBodyM;
  return {
    schemaVersion: 1, modelId: manifest.modelId, kind: manifest.kind, units: 'SI', worldFrame: 'NED', bodyFrame: 'FRD',
    quaternionOrder: 'wxyz', massKg: manifest.massProperties.massKg, inertiaBodyKgM2: manifest.massProperties.inertiaCgKgM2,
    rotorCount: manifest.rotorCount, rotorCapacity: 32,
    rotors: manifest.rotors.map(rotor => ({ ...rotor, hubPositionBodyM: shifted(rotor.hubPositionBodyM, cg) })),
  };
}

/**
 * The v1 runtime descriptor (`FrameLayout`, `BetFlightDynamics`) for a v2
 * vehicle: hub positions become CG-relative. Fails closed for any data the
 * current runtime cannot consume rather than silently ignoring it.
 */
export function projectVehicleToModelV1(input: VehicleManifest): ModelDescriptor {
  const manifest = validateVehicleManifest(input);
  const unsupported = VEHICLE_SECTIONS.filter(section => section !== 'massProperties' && section !== 'rotors' &&
    sectionPresent(manifest, section));
  if (unsupported.length > 0) {
    throw new Error(`The v1 runtime cannot consume ${unsupported.map(section => `${section} (${SECTION_OWNERS[section]})`).join(', ')}`);
  }
  if (manifest.ardupilot) throw new Error('The v1 runtime does not consume ArduPilot frame declarations');
  return validateModelManifest(projectRotorBody(manifest));
}

/** Lossless v1 to v2 migration; the caller states the provenance of the v1 data. */
export function migrateModelManifestV1(input: unknown, dataset: VehicleDataset): VehicleManifest {
  const model = validateModelManifest(input);
  return validateVehicleManifest({
    schemaVersion: 2, modelId: model.modelId, kind: model.kind, units: 'SI', worldFrame: 'NED', bodyFrame: 'FRD',
    quaternionOrder: 'wxyz', datasets: [dataset],
    provenance: { massProperties: dataset.id, rotors: model.rotorCount > 0 ? dataset.id : null, motors: null, escs: null,
      battery: null, airframeDrag: null, controlSurfaces: null, landingGear: null, sensorMounts: null, rotorWakePairs: null },
    // v1 bodies are CG-referenced, so the reference point is the CG.
    massProperties: { massKg: model.massKg, cgOffsetBodyM: [0, 0, 0], inertiaCgKgM2: model.inertiaBodyKgM2 },
    rotorCount: model.rotorCount, rotorCapacity: 32, rotors: model.rotors, motors: [], escs: [], battery: null,
    airframe: { drag: null }, controlSurfaces: [], landingGear: [], sensorMounts: [], rotorWakePairs: [], ardupilot: null,
  });
}

/** SI torque/back-EMF constant from the speed constant: k_t = 60/(2π·KV) N·m/A. */
export function motorTorqueConstantNmPerA(kvRpmPerV: number): number {
  if (!Number.isFinite(kvRpmPerV) || kvRpmPerV <= 0) throw new Error('KV must be positive and finite');
  return 60 / (2 * Math.PI * kvRpmPerV);
}

/** Cold derived values for a validated vehicle. */
export function deriveVehicle(input: VehicleManifest): DerivedVehicle {
  const manifest = validateVehicleManifest(input), cg = manifest.massProperties.cgOffsetBodyM;
  const eigen = symmetricEigen3(manifest.massProperties.inertiaCgKgM2);
  return freeze({
    principalMomentsKgM2: eigen.values, principalAxesBody: eigen.vectors,
    motorTorqueConstantNmPerA: manifest.motors.map(motor => motorTorqueConstantNmPerA(motor.kvRpmPerV)),
    rotorHubPositionCgM: manifest.rotors.flatMap(rotor => shifted(rotor.hubPositionBodyM, cg)),
    landingGearAnchorCgM: manifest.landingGear.flatMap(gear => shifted(gear.anchorBodyM, cg)),
    sensorPositionCgM: manifest.sensorMounts.flatMap(mount => shifted(mount.positionBodyM, cg)),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Hash-verified v1 and v2 manifests; a model ID is immutable for a registry session. */
export class VehicleRegistry {
  private readonly models = new Map<number, VerifiedVehicle>();
  get(modelId: number): VerifiedVehicle | undefined { return this.models.get(modelId); }
  async register(payload: Uint8Array, expectedSha256: string): Promise<VerifiedVehicle> {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Invalid model hash');
    if (payload.byteLength > 1024 * 1024) throw new Error('Model exceeds 1 MiB');
    const bytes = new Uint8Array(payload);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== expectedSha256) throw new Error('Model source hash mismatch');
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const version = record(input) ? input.schemaVersion : undefined;
    let verified: VerifiedVehicle;
    if (version === 1) verified = { sha256: actual, schemaVersion: 1, manifest: validateModelManifest(input) };
    else if (version === 2) verified = { sha256: actual, schemaVersion: 2, manifest: validateVehicleManifest(input) };
    else throw new Error('Unsupported model schema version');
    const existing = this.models.get(verified.manifest.modelId);
    if (existing) {
      if (existing.sha256 !== actual) throw new Error('Model ID collision');
      return existing;
    }
    const frozen = Object.freeze(verified);
    this.models.set(verified.manifest.modelId, frozen);
    return frozen;
  }
}

/**
 * `model.load` admission from a hash-verified registry: the requested hash
 * must equal the registered payload hash and a v2 vehicle must project to
 * the v1 runtime descriptor (fail closed). `build` creates the dynamics.
 */
export function registryModelPort(registry: VehicleRegistry,
  build: (model: ModelDescriptor, hz: PhysicsHz) => SessionDynamics): SessionModelPort {
  return {
    prepare: (modelId, manifestSha256) => new Promise(resolve => {
      const record = registry.get(modelId);
      if (!record) throw new Error(`Model ${modelId} is not registered`);
      // Control Protocol v2 admits either hex case.
      if (record.sha256 !== manifestSha256.toLowerCase()) throw new Error(`Model ${modelId} hash does not match the registered manifest`);
      const model = record.schemaVersion === 1 ? record.manifest : projectVehicleToModelV1(record.manifest);
      resolve(hz => build(model, hz));
    }),
  };
}
