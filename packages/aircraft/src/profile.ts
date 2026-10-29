import { Ajv } from 'ajv';
import schema from './profile.schema.json';
import { symmetricEigen3, type MassProperties } from '@mirage/physics/vehicle-manifest';
import type { StoredVersion } from '@mirage/project/schema';
import type { Draft } from '@mirage/project/versions';
import { addSensorSchemaKeywords, isDefaultSensorConfiguration, sensorConfigurationSchema, validateSensorConfiguration } from './sensor-config.ts';
import type { SensorConfiguration } from './sensor-fields.ts';

// Aircraft profile schema 1 (TASK-138, S03): the product-level description of
// a multirotor with one to eight arms and up to 16 motors. Schema 2 (TASK-140,
// S04) adds the calculation mode of the profile version, and schema 3 (TASK-143,
// S08) its sensor configuration. Configuration-time code only; never call it from a physics step. Units are SI; positions are
// body FRD metres from the body reference point.

/** The schema a new profile version is written in; schema 1 profiles stay valid. */
export const PROFILE_SCHEMA_VERSION = 3;
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
export type CalculationMode = 'preliminary' | 'measured';
/** The S04 input mode of a profile version and the measurement sets it binds. */
export interface CalculationSettings {
  readonly mode: CalculationMode;
  /** SHA-256 addresses of measurement-set versions (TASK-140), ascending; empty in preliminary mode. */
  readonly measurementSets: readonly string[];
}
interface ProfileFields {
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
}
/**
 * Schema 1 has no calculation and reads as preliminary; schema 2 states it.
 * Schemas 1 and 2 hold the ArduPilot sensor defaults as null; schema 3 holds a
 * sensor configuration (TASK-143) and always a calculation.
 */
export type AircraftProfile =
  | (ProfileFields & { readonly schemaVersion: 1; readonly sensorConfiguration: null })
  | (ProfileFields & { readonly schemaVersion: 2; readonly calculation: CalculationSettings; readonly sensorConfiguration: null })
  | (ProfileFields & { readonly schemaVersion: 3; readonly calculation: CalculationSettings; readonly sensorConfiguration: SensorConfiguration });

// Union types express nullable fields, as in the vehicle manifest schema.
const ajv = addSensorSchemaKeywords(new Ajv({ strict: true, strictNumbers: true, allowUnionTypes: true }));
ajv.addSchema(sensorConfigurationSchema);
const validateSchema = ajv.compile<AircraftProfile>(schema);
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
    // The anyOf of null and a configuration reports the null branch first; the configuration's own validator names the real fault.
    const sensors: unknown = typeof profile === 'object' && profile !== null ? Reflect.get(profile, 'sensorConfiguration') : null;
    if (error?.instancePath.startsWith('/sensorConfiguration') && sensors !== null && sensors !== undefined) {
      try {
        validateSensorConfiguration(sensors);
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : String(cause));
      }
    }
    return fail(`${error?.instancePath || '/'} ${error?.message ?? 'does not match the schema'}`);
  }
  if (profile.schemaVersion === 1 && 'calculation' in profile) fail('Schema 1 profiles have no calculation');
  if (profile.schemaVersion !== 3 && profile.sensorConfiguration !== null) fail(`Schema ${profile.schemaVersion} profiles hold no sensor configuration`);
  if (profile.schemaVersion === 3) {
    if (profile.sensorConfiguration === null) fail('Schema 3 profiles need a sensor configuration');
    try {
      validateSensorConfiguration(profile.sensorConfiguration);
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause));
    }
    if (isDefaultSensorConfiguration(profile.sensorConfiguration)) fail('ArduPilot sensor defaults are stored as null, in schema 1 or 2');
  }
  if (profile.schemaVersion !== 1) {
    if (!('calculation' in profile)) fail(`Schema ${String(Reflect.get(profile, 'schemaVersion'))} profiles need a calculation`);
    const { mode, measurementSets } = profile.calculation;
    if (mode === 'preliminary' && measurementSets.length > 0) fail('A preliminary calculation binds no measurement set');
    if (!measurementSets.every((sha, index) => index === 0 || sha > measurementSets[index - 1]!)) {
      fail('Measurement sets must be unique and in ascending order');
    }
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

/** The calculation of a profile version; schema 1 is preliminary. */
export function calculationSettings(profile: AircraftProfile): CalculationSettings {
  return profile.schemaVersion === 1 ? { mode: 'preliminary', measurementSets: [] } : profile.calculation;
}

/** The stored sensor configuration, or null for the ArduPilot defaults (schemas 1 and 2). */
export function sensorConfigurationOf(profile: AircraftProfile): SensorConfiguration | null {
  return profile.sensorConfiguration;
}

/**
 * The profile with a sensor configuration. The ArduPilot defaults are stored
 * as null: schema 1 stays 1 and schemas 2 and 3 become 2. Any other
 * configuration makes schema 3, which keeps the profile's calculation (a
 * schema 1 profile is preliminary). Dependencies do not change.
 */
export function withSensorConfiguration(profile: AircraftProfile, config: SensorConfiguration | null): AircraftProfile {
  const sensors = config && isDefaultSensorConfiguration(config) ? null : config;
  const calculation = calculationSettings(profile);
  if (sensors) return validateAircraftProfile({ ...profile, schemaVersion: 3, calculation, sensorConfiguration: sensors });
  if (profile.schemaVersion === 1) return validateAircraftProfile({ ...profile, sensorConfiguration: null });
  return validateAircraftProfile({ ...profile, schemaVersion: 2, calculation, sensorConfiguration: null });
}

/** The project-store dependencies of a profile: its component cards and bound measurement sets, sorted. */
export function profileDependencies(profile: AircraftProfile): { kind: 'component-card' | 'measurement-set'; sha256: string }[] {
  return [
    ...profileComponentCards(profile).map(sha256 => ({ kind: 'component-card' as const, sha256 })),
    ...calculationSettings(profile).measurementSets.map(sha256 => ({ kind: 'measurement-set' as const, sha256 })),
  ].sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
}

/** A project-store draft (TASK-136) for a profile version, with its cards and measurement sets as dependencies. */
export function profileDraft(name: string, input: unknown): Draft {
  const profile = validateAircraftProfile(input);
  return { name, payload: profile, dependencies: profileDependencies(profile).map(dependency => dependency.sha256) };
}

/** The profile of a stored aircraft-profile version; its dependencies must be exactly its cards and measurement sets. */
export function readAircraftProfile(stored: StoredVersion): AircraftProfile {
  const record = stored.record;
  if (record.kind !== 'aircraft-profile') throw new Error(`Record ${stored.sha256} is a ${record.kind}, not an aircraft profile`);
  const profile = validateAircraftProfile(record.payload);
  const expected = profileDependencies(profile).map(dependency => `${dependency.kind}:${dependency.sha256}`);
  const listed = record.dependencies.map(dependency => `${dependency.kind}:${dependency.sha256}`);
  if (listed.join(',') !== expected.join(',')) {
    throw new Error(`Profile record ${stored.sha256}: its dependencies must list exactly its component cards and measurement sets`);
  }
  return profile;
}
