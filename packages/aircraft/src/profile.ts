import { Ajv } from 'ajv';
import schema from './profile.schema.json';
import { symmetricEigen3, type MassProperties } from '@mirage/physics/vehicle-manifest';
import { catalogPolar } from '@mirage/physics/polar-catalog';
import type { StoredVersion } from '@mirage/project/schema';
import type { Draft } from '@mirage/project/versions';
import { addSensorSchemaKeywords, isDefaultSensorConfiguration, sensorConfigurationSchema, validateSensorConfiguration } from './sensor-config.ts';
import type { SensorConfiguration } from './sensor-fields.ts';

// Aircraft profile schema 1 (TASK-138, S03): the product-level description of
// a multirotor with one to eight arms and up to 16 motors. Schema 2 (TASK-140,
// S04) adds the calculation mode of the profile version, schema 3 (TASK-143,
// S08) its sensor configuration, schema 4 (TASK-144, S05) the airfoil polar
// of each propeller, schema 5 (TASK-096, S05) drag areas the user states
// for the airframe, and schema 6 (TASK-145, S04) the propulsion calibrations it
// binds, with or without stated drag, and schema 7 (TASK-196, S03) the body the user describes in place of
// the standard hull, with any of the above. Each profile has one canonical schema: the lowest
// that holds its content. Configuration-time code only; never call it from a
// physics step. Units are SI; positions are body FRD metres from the body
// reference point.

/** The newest schema; a profile is written in the lowest schema that holds its content, and every schema stays valid. */
export const PROFILE_SCHEMA_VERSION = 7;
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
/** The polar-catalog entry (TASK-144) that a propeller card's BET rotors use. */
export interface PropellerPolar {
  /** SHA-256 address of a propeller-card version that a motor of the profile references. */
  readonly card: string;
  /** A `POLAR_CATALOG` ID of `@mirage/physics/polar-catalog`. */
  readonly polar: string;
}
/**
 * TASK-096: drag areas the user states for the airframe without its rotors (whose drag the BET rotors produce), with their
 * source; without them a profile flies the standard hull's preliminary estimate.
 */
export interface StatedAirframeDrag {
  /** C_D·A along body x, y and z, m²: a diagonal drag-area tensor. */
  readonly dragAreasM2: readonly number[];
  /** The center of pressure, body FRD metres from the reference point. */
  readonly centerOfPressureBodyM: readonly number[];
  /** The top of the airspeed range the values hold for, m/s. */
  readonly maxAirspeedMps: number;
  /** Where the values came from, 1..1024 characters. */
  readonly source: string;
}
/** TASK-196: a part fixed to the body, such as a camera or a cargo box: a vertical cylinder. Depths are body FRD z. */
export interface BodyPart {
  /** 1..64 characters, unique in the body; the accident and clearance reports name the part by it. */
  readonly name: string;
  /** Body x (forward) and y (right) of the part's axis, m. */
  readonly xM: number;
  readonly yM: number;
  /** How far the part's bottom lies below the reference point, m. */
  readonly bottomDepthM: number;
  readonly diameterM: number;
  readonly heightM: number;
}
/**
 * TASK-196: the airframe's contact shapes as the user describes them, in place of the standard hull (TASK-095): a body
 * cylinder about the body z axis, every arm a capsule of one thickness from that axis to its motor mount, and up to seven
 * parts. Mass properties are stated separately and do not follow from it.
 */
export interface BodySpec {
  readonly diameterM: number;
  readonly heightM: number;
  /** How far the body's bottom lies below the reference point, m; negative when it lies above. */
  readonly bottomDepthM: number;
  readonly armDiameterM: number;
  readonly parts: readonly BodyPart[];
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
 * sensor configuration (TASK-143) and always a calculation. Schema 4 adds
 * chosen propeller polars (TASK-144) to either sensor case, and schema 5
 * stated airframe drag (TASK-096), with any polars.
 */
/**
 * A propulsion calibration a profile version binds (TASK-145): the values of one `propulsion-calibration` record, named by its SHA-256,
 * for the motors whose combination key it carries. The measurement set must be bound too.
 */
export interface BoundCalibration {
  readonly record: string; readonly combinationKey: string; readonly measurementSet: string; readonly measuredOn: string;
  readonly liftScale: number; readonly dragScale: number; readonly resistanceOhm: number | null; readonly noLoadCurrentA: number | null;
  readonly rpmMin: number; readonly rpmMax: number; readonly densityKgM3: number;
}
export type AircraftProfile =
  | (ProfileFields & { readonly schemaVersion: 1; readonly sensorConfiguration: null })
  | (ProfileFields & { readonly schemaVersion: 2; readonly calculation: CalculationSettings; readonly sensorConfiguration: null })
  | (ProfileFields & { readonly schemaVersion: 3; readonly calculation: CalculationSettings; readonly sensorConfiguration: SensorConfiguration })
  | (ProfileFields & {
    readonly schemaVersion: 4; readonly calculation: CalculationSettings; readonly sensorConfiguration: SensorConfiguration | null;
    /** One or more entries in ascending card order; a profile without a chosen polar is written in schema 3 or lower. */
    readonly propellerPolars: readonly PropellerPolar[];
  })
  | (ProfileFields & {
    readonly schemaVersion: 5; readonly calculation: CalculationSettings; readonly sensorConfiguration: SensorConfiguration | null;
    /** Zero or more entries in ascending card order. */
    readonly propellerPolars: readonly PropellerPolar[];
    readonly airframeDrag: StatedAirframeDrag;
  })
  | (ProfileFields & {
    readonly schemaVersion: 6; readonly calculation: CalculationSettings; readonly sensorConfiguration: SensorConfiguration | null;
    readonly propellerPolars: readonly PropellerPolar[];
    /** Stated drag, as in schema 5, or absent for the standard hull's estimate. */
    readonly airframeDrag?: StatedAirframeDrag;
    /** One or more, in ascending combination-key order. */
    readonly propulsionCalibrations: readonly BoundCalibration[];
  })
  | (ProfileFields & {
    readonly schemaVersion: 7; readonly calculation: CalculationSettings; readonly sensorConfiguration: SensorConfiguration | null;
    readonly propellerPolars: readonly PropellerPolar[];
    readonly airframeDrag?: StatedAirframeDrag;
    /** Zero or more, in ascending combination-key order. */
    readonly propulsionCalibrations: readonly BoundCalibration[];
    readonly body: BodySpec;
  });
/** TASK-196: at most this many hull shapes, the vehicle manifest's limit: the body, the arms and the parts. */
export const MAX_HULL_SHAPES = 16;

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
/** TASK-196: part names unique, every arm reaching out of the body cylinder, and at most 16 hull shapes in all. */
function checkBody(body: BodySpec, arms: readonly ArmSpec[]): void {
  const names = new Set<string>();
  for (const part of body.parts) {
    const name = part.name.trim();
    if (name !== part.name) fail(`Body part name "${part.name}" has leading or trailing spaces`);
    if (names.has(name)) fail(`Two body parts are named ${name}`);
    names.add(name);
  }
  const radius = body.diameterM / 2;
  for (const arm of arms) if (!(arm.lengthM > radius)) fail(`Arm ${arm.id} ends inside the body: its length must exceed the body radius ${radius} m`);
  if (1 + arms.length + body.parts.length > MAX_HULL_SHAPES) {
    fail(`The body, ${arms.length} arms and ${body.parts.length} parts make more than ${MAX_HULL_SHAPES} hull shapes`);
  }
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
  if (profile.schemaVersion < 3 && profile.sensorConfiguration !== null) {
    fail(`Schema ${profile.schemaVersion} profiles hold no sensor configuration`);
  }
  if ((profile.schemaVersion >= 4) !== ('propellerPolars' in profile)) fail('Propeller polars appear exactly in schemas 4 to 7');
  if (profile.schemaVersion === 5 ? !('airframeDrag' in profile) : profile.schemaVersion < 5 && 'airframeDrag' in profile) fail('Stated airframe drag appears exactly in schema 5, and optionally in schemas 6 and 7');
  if ((profile.schemaVersion >= 6) !== ('propulsionCalibrations' in profile)) fail('Propulsion calibrations appear exactly in schemas 6 and 7');
  if ((profile.schemaVersion === 7) !== ('body' in profile)) fail('A body appears exactly in schema 7');
  if (profile.schemaVersion === 3 && profile.sensorConfiguration === null) fail('Schema 3 profiles need a sensor configuration');
  if (profile.sensorConfiguration !== null) {
    try {
      validateSensorConfiguration(profile.sensorConfiguration);
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause));
    }
    if (isDefaultSensorConfiguration(profile.sensorConfiguration)) fail('ArduPilot sensor defaults are stored as null');
  }
  const stated = airframeDragOf(profile);
  if (stated && stated.source.trim() === '') fail('Stated airframe drag needs its source');
  if (profile.schemaVersion >= 4 && 'propellerPolars' in profile) {
    const propellers = new Set(profile.motors.map(motor => motor.components.propeller));
    if (profile.schemaVersion === 4 && profile.propellerPolars.length === 0) fail('Schema 4 profiles choose at least one propeller polar');
    profile.propellerPolars.forEach((entry, index) => {
      if (index > 0 && entry.card <= profile.propellerPolars[index - 1]!.card) fail('Propeller polars must be unique and in ascending card order');
      if (!propellers.has(entry.card)) fail(`Propeller polar for card ${entry.card.slice(0, 12)}, which no motor uses`);
      if (!catalogPolar(entry.polar)) fail(`Unknown catalog polar ${entry.polar}`);
    });
  }
  if (profile.schemaVersion !== 1) {
    if (!('calculation' in profile)) fail(`Schema ${String(Reflect.get(profile, 'schemaVersion'))} profiles need a calculation`);
    const { mode, measurementSets } = profile.calculation;
    if (mode === 'preliminary' && measurementSets.length > 0) fail('A preliminary calculation binds no measurement set');
    if (!measurementSets.every((sha, index) => index === 0 || sha > measurementSets[index - 1]!)) {
      fail('Measurement sets must be unique and in ascending order');
    }
  }
  if (profile.schemaVersion >= 6 && 'propulsionCalibrations' in profile) {
    const bound = profile.propulsionCalibrations;
    if (profile.schemaVersion === 6 && bound.length === 0) fail('Schema 6 profiles bind at least one propulsion calibration');
    if (bound.length > 0 && profile.calculation.mode !== 'measured') fail('Only a calculation from measurements binds propulsion calibrations');
    bound.forEach((entry, index) => {
      if (index > 0 && entry.combinationKey <= bound[index - 1]!.combinationKey) fail('Propulsion calibrations must be one per combination, in ascending key order');
      if (!profile.calculation.measurementSets.includes(entry.measurementSet)) fail('A propulsion calibration needs its measurement set bound');
      if (!(entry.rpmMin < entry.rpmMax)) fail('A propulsion calibration RPM range must be increasing');
    });
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
  if (profile.schemaVersion === 7 && 'body' in profile) checkBody(profile.body, profile.arms);
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

/** The chosen propeller polars of a profile; none below schema 4. */
export function propellerPolarsOf(profile: AircraftProfile): readonly PropellerPolar[] {
  return profile.schemaVersion >= 4 && 'propellerPolars' in profile ? profile.propellerPolars : [];
}

/** The airframe drag a profile states (TASK-096), or null: the standard hull's preliminary estimate. */
export function airframeDragOf(profile: AircraftProfile): StatedAirframeDrag | null {
  return profile.schemaVersion === 5 ? profile.airframeDrag : profile.schemaVersion >= 6 && 'propulsionCalibrations' in profile ? profile.airframeDrag ?? null : null;
}
/** The propulsion calibrations a profile version binds (TASK-145); none below schema 6. */
export function propulsionCalibrationsOf(profile: AircraftProfile): readonly BoundCalibration[] {
  return profile.schemaVersion >= 6 && 'propulsionCalibrations' in profile ? profile.propulsionCalibrations : [];
}
/** The body a profile describes (TASK-196), or null: the standard hull. */
export function bodyOf(profile: AircraftProfile): BodySpec | null {
  return profile.schemaVersion === 7 ? profile.body : null;
}

/**
 * The profile in its canonical schema for the given content: schema 7 with a
 * body, else schema 6 with a propulsion calibration, else schema 5 with
 * stated airframe drag, else schema 4 with any propeller polar, else schema 3
 * with a sensor configuration, else schema 2, except that a schema 1 profile
 * whose calculation stays the implicit preliminary one stays schema 1.
 * Dependencies do not change.
 */
export function withProfileContent(profile: AircraftProfile, content: {
  readonly calculation?: CalculationSettings; readonly sensorConfiguration?: SensorConfiguration | null;
  readonly propellerPolars?: readonly PropellerPolar[]; readonly airframeDrag?: StatedAirframeDrag | null;
  readonly propulsionCalibrations?: readonly BoundCalibration[]; readonly body?: BodySpec | null;
}): AircraftProfile {
  const config = content.sensorConfiguration === undefined ? profile.sensorConfiguration : content.sensorConfiguration;
  const sensors = config && isDefaultSensorConfiguration(config) ? null : config;
  const calculation = content.calculation ?? calculationSettings(profile);
  const polars = [...(content.propellerPolars ?? propellerPolarsOf(profile))].sort((a, b) => (a.card < b.card ? -1 : a.card > b.card ? 1 : 0));
  // Only the schema-independent fields carry over, so no field of the old schema survives a schema change.
  const fields: ProfileFields = {
    units: profile.units, bodyFrame: profile.bodyFrame, arms: profile.arms, motors: profile.motors,
    massProperties: profile.massProperties, payload: profile.payload, battery: profile.battery, groundClearanceM: profile.groundClearanceM,
  };
  const drag = content.airframeDrag === undefined ? airframeDragOf(profile) : content.airframeDrag;
  // TASK-145: a calibration stays bound only while its measurement set is, in a calculation from measurements.
  const calibrations = [...(content.propulsionCalibrations ?? propulsionCalibrationsOf(profile))]
    .filter(entry => calculation.mode === 'measured' && calculation.measurementSets.includes(entry.measurementSet))
    .sort((a, b) => (a.combinationKey < b.combinationKey ? -1 : a.combinationKey > b.combinationKey ? 1 : 0));
  const body = content.body === undefined ? bodyOf(profile) : content.body;
  if (body) {
    return validateAircraftProfile({ ...fields, schemaVersion: 7, calculation, sensorConfiguration: sensors, propellerPolars: polars,
      ...(drag ? { airframeDrag: drag } : {}), propulsionCalibrations: calibrations, body });
  }
  if (calibrations.length > 0) {
    return validateAircraftProfile({ ...fields, schemaVersion: 6, calculation, sensorConfiguration: sensors, propellerPolars: polars,
      ...(drag ? { airframeDrag: drag } : {}), propulsionCalibrations: calibrations });
  }
  if (drag) {
    return validateAircraftProfile({ ...fields, schemaVersion: 5, calculation, sensorConfiguration: sensors, propellerPolars: polars, airframeDrag: drag });
  }
  if (polars.length > 0) {
    return validateAircraftProfile({ ...fields, schemaVersion: 4, calculation, sensorConfiguration: sensors, propellerPolars: polars });
  }
  if (sensors) return validateAircraftProfile({ ...fields, schemaVersion: 3, calculation, sensorConfiguration: sensors });
  if (profile.schemaVersion === 1 && content.calculation === undefined) return validateAircraftProfile({ ...fields, schemaVersion: 1, sensorConfiguration: null });
  return validateAircraftProfile({ ...fields, schemaVersion: 2, calculation, sensorConfiguration: null });
}

/**
 * The profile with a sensor configuration. The ArduPilot defaults are stored
 * as null: schema 1 stays 1, schemas 2 and 3 become 2, and schema 4 keeps its
 * propeller polars. Any other configuration makes schema 3 (or 4), which keeps
 * the profile's calculation (a schema 1 profile is preliminary).
 */
export function withSensorConfiguration(profile: AircraftProfile, config: SensorConfiguration | null): AircraftProfile {
  return withProfileContent(profile, { sensorConfiguration: config });
}

/** The profile with the body the user describes (TASK-196), or with null the standard hull again (schema 6 or lower). */
export function withBody(profile: AircraftProfile, body: BodySpec | null): AircraftProfile {
  return withProfileContent(profile, { body });
}

/** The profile binding these propulsion calibrations (TASK-145); an empty list returns it to schema 5 or lower. */
export function withPropulsionCalibrations(profile: AircraftProfile, calibrations: readonly BoundCalibration[]): AircraftProfile {
  return withProfileContent(profile, { propulsionCalibrations: calibrations });
}

/** The profile with stated airframe drag (TASK-096), or with null the standard hull's estimate again (schema 4 or lower). */
export function withAirframeDrag(profile: AircraftProfile, drag: StatedAirframeDrag | null): AircraftProfile {
  return withProfileContent(profile, { airframeDrag: drag });
}

/** The profile with these propeller polars (TASK-144); an empty list returns it to schema 3 or lower. */
export function withPropellerPolars(profile: AircraftProfile, polars: readonly PropellerPolar[]): AircraftProfile {
  return withProfileContent(profile, { propellerPolars: polars });
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
