import { Ajv } from 'ajv';
import schema from './profile.schema.json';
import { symmetricEigen3, type MassProperties } from '@mirage/physics/vehicle-manifest';
import type { StoredVersion } from '@mirage/project/schema';
import type { Draft } from '@mirage/project/versions';

// Aircraft profile schema 1 (TASK-138, S03): the product-level description of
// a multirotor with one to eight arms and up to 16 motors. Configuration-time
// code only; never call it from a physics step. Units are SI; positions are
// body FRD metres from the body reference point.

export const PROFILE_SCHEMA_VERSION = 1;
export type MotorLevel = 'single' | 'upper' | 'lower';
export type SpinDirection = 'ccw' | 'cw';
export interface ArmSpec {
  readonly id: number;
  /** Horizontal distance from the body z axis through the reference point to the motor axis at the mount. */
  readonly lengthM: number;
  /** In the body x-y plane from forward towards right (clockwise seen from above), in (-π, π]. */
  readonly azimuthRad: number;
  /** Height of the mount above the reference point; body FRD z = -heightM. */
  readonly heightM: number;
  /** Lean of the thrust axis away from the body z axis, in the arm's vertical plane, in (-π/2, π/2). */
  readonly outwardTiltRad: number;
  /** Lean of the thrust axis towards increasing azimuth, in the vertical plane across the arm, in (-π/2, π/2). */
  readonly sideTiltRad: number;
  /** Hub-to-hub distance of a coaxial pair along the thrust axis; null for a single motor. */
  readonly pairSeparationM: number | null;
}
/** SHA-256 addresses of component-card versions (TASK-139), or null while none is selected. */
export interface ComponentReferences {
  readonly motor: string | null;
  readonly propeller: string | null;
  readonly esc: string | null;
}
export interface ProfileMotor {
  readonly id: number;
  readonly armId: number;
  readonly level: MotorLevel;
  /** Seen from the thrust side, which is from above for an untilted rotor. */
  readonly spin: SpinDirection;
  /** ArduPilot servo output number (SERVOn), 1..16; the actuator channel is output - 1. */
  readonly output: number;
  readonly components: ComponentReferences;
}
export interface AircraftProfile {
  readonly schemaVersion: 1;
  readonly units: 'SI';
  readonly bodyFrame: 'FRD';
  /** One to eight arms in ascending ID order. */
  readonly arms: readonly ArmSpec[];
  /** One to 16 motors in ascending ID order. */
  readonly motors: readonly ProfileMotor[];
  /** The aircraft as flown without payload: airframe, propulsion and battery. */
  readonly massProperties: MassProperties;
  /** A rigid payload with its inertia about its own CG (zero for a point mass), or null. */
  readonly payload: MassProperties | null;
  readonly battery: { readonly card: string | null };
  /** Height of the reference point above level ground when resting on the supports (decision F-07), or null. */
  readonly groundClearanceM: number | null;
  /** Reserved for TASK-143. */
  readonly sensorConfiguration: null;
}

// Union types express nullable fields, as in the vehicle manifest schema.
const validateSchema = new Ajv({ strict: true, strictNumbers: true, allowUnionTypes: true }).compile<AircraftProfile>(schema);
/**
 * Slack of the inertia checks, relative to the trace: the eigen-solver
 * round-off bound of the vehicle manifest's triangle check (TASK-087).
 */
const INERTIA_SLACK_RELATIVE = 1e-12;

function fail(message: string): never {
  throw new Error(`Invalid aircraft profile: ${message}`);
}
function freeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/**
 * Exact symmetry, then positive definiteness by Cholesky factorization for an
 * aircraft or non-negative principal moments for a payload, then the rigid-body
 * triangle inequality (each principal moment at most the sum of the others).
 */
function checkInertia(matrix: readonly number[], label: string, definite: boolean): void {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < row; col++) if (matrix[row * 3 + col] !== matrix[col * 3 + row]) fail(`${label} must be symmetric`);
  }
  if (definite) {
    const lower = new Float64Array(9);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col <= row; col++) {
        // The schema fixes nine entries.
        let pivot = matrix[row * 3 + col]!;
        for (let k = 0; k < col; k++) pivot -= lower[row * 3 + k]! * lower[col * 3 + k]!;
        if (!Number.isFinite(pivot) || (row === col && pivot <= 0)) fail(`${label} must be positive definite`);
        lower[row * 3 + col] = row === col ? Math.sqrt(pivot) : pivot / lower[col * 3 + col]!;
      }
    }
  }
  const [smallest = 0, middle = 0, largest = 0] = symmetricEigen3(matrix).values;
  const slack = INERTIA_SLACK_RELATIVE * (smallest + middle + largest);
  if (!definite && smallest < -slack) fail(`${label} must be positive semi-definite`);
  if (largest - smallest - middle > slack) fail(`${label} violates the rigid-body triangle inequality`);
}
function ascending(ids: readonly number[]): boolean {
  return ids.every((id, index) => index === 0 || id > ids[index - 1]!);
}

/** Schema and cross-reference checks; returns a deep-frozen copy. */
export function validateAircraftProfile(input: unknown): AircraftProfile {
  const profile: unknown = structuredClone(input);
  if (!validateSchema(profile)) {
    const error = validateSchema.errors?.[0];
    return fail(`${error?.instancePath || '/'} ${error?.message ?? 'does not match the schema'}`);
  }
  if (!ascending(profile.arms.map(arm => arm.id))) fail('Arm IDs must be unique and ascending');
  if (!ascending(profile.motors.map(motor => motor.id))) fail('Motor IDs must be unique and ascending');
  const outputs = new Map<number, number>();
  for (const motor of profile.motors) {
    const other = outputs.get(motor.output);
    if (other !== undefined) fail(`Output ${motor.output} is assigned to motors ${other} and ${motor.id}`);
    outputs.set(motor.output, motor.id);
    if (!profile.arms.some(arm => arm.id === motor.armId)) fail(`Motor ${motor.id} names unknown arm ${motor.armId}`);
  }
  for (const arm of profile.arms) {
    const levels = profile.motors.filter(motor => motor.armId === arm.id).map(motor => motor.level).sort().join(',');
    if (levels === '') fail(`Arm ${arm.id} has no motor`);
    if (levels === 'single') {
      if (arm.pairSeparationM !== null) fail(`Arm ${arm.id} holds one motor but has a pair separation`);
    } else if (levels === 'lower,upper') {
      if (arm.pairSeparationM === null) fail(`Arm ${arm.id} holds a motor pair but has no pair separation`);
    } else {
      fail(`Arm ${arm.id} must hold one single motor, or one upper and one lower motor`);
    }
  }
  profile.arms.forEach((arm, index) => {
    for (const other of profile.arms.slice(index + 1)) {
      if (arm.lengthM === other.lengthM && arm.azimuthRad === other.azimuthRad && arm.heightM === other.heightM) {
        fail(`Arms ${arm.id} and ${other.id} share one mount point`);
      }
    }
  });
  checkInertia(profile.massProperties.inertiaCgKgM2, 'Aircraft inertia', true);
  if (profile.payload) checkInertia(profile.payload.inertiaCgKgM2, 'Payload inertia', false);
  return freeze(profile);
}

/** The component cards a profile references, sorted and without duplicates: its project-store dependencies. */
export function profileComponentCards(profile: AircraftProfile): string[] {
  const cards = new Set<string>();
  for (const motor of profile.motors) {
    for (const card of [motor.components.motor, motor.components.propeller, motor.components.esc]) if (card) cards.add(card);
  }
  if (profile.battery.card) cards.add(profile.battery.card);
  return [...cards].sort();
}

/** A project-store draft (TASK-136) for a profile version, with its component cards as dependencies. */
export function profileDraft(name: string, input: unknown): Draft {
  const profile = validateAircraftProfile(input);
  return { name, payload: profile, dependencies: profileComponentCards(profile) };
}

/** The profile of a stored aircraft-profile version; its dependencies must be exactly its component cards. */
export function readAircraftProfile(stored: StoredVersion): AircraftProfile {
  const record = stored.record;
  if (record.kind !== 'aircraft-profile') throw new Error(`Record ${stored.sha256} is a ${record.kind}, not an aircraft profile`);
  const profile = validateAircraftProfile(record.payload);
  const expected = profileComponentCards(profile);
  const listed = record.dependencies.map(dependency => dependency.sha256);
  if (record.dependencies.some(dependency => dependency.kind !== 'component-card') || listed.join(',') !== expected.join(',')) {
    throw new Error(`Profile record ${stored.sha256}: its dependencies must list exactly its component cards`);
  }
  return profile;
}
