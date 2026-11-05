import {
  DELIVERY_PATHS, ERROR_SOURCE_IDS, FIRMWARE_PATCHES, matrixSources, OWNERSHIP_MATRIX_SCHEMA_VERSION, type DeliveryPath, type ErrorOwner,
  type ErrorSourceId, type FirmwarePatchId, type OwnershipEntry, type OwnershipMatrix,
} from '@mirage/autopilot/error-ownership';
import {
  MAX_NAME_CODE_POINTS, MAX_VERSION, SHA256_HEX, UUID_V4, canonicalBytes, equalBytes, normalizeName, type StoredVersion,
} from '@mirage/project/schema';
import type { ProjectStore } from '@mirage/project/store';
import { parseFlightTask, type FlightTaskDefinition } from '@mirage/scenarios/flight-tasks';
import { parseFaultSchedule, type FaultSchedule } from '@mirage/scenarios/fault-schedule';
import { readComponentCard, type ComponentCard } from './components.ts';
import { deriveVehicleManifest } from './derive-manifest.ts';
import { FRAME_PARAMETER_NAMES, frameConfiguration } from './frame-parameters.ts';
import { profileDependencies, readAircraftProfile } from './profile.ts';
import { resolveComponents } from './resolve-components.ts';
import { SITE_PARAMETER_NAMES, siteParameters } from './site-parameters.ts';
import { validateSensorConfiguration } from './sensor-config.ts';
import {
  SENSOR_FIELDS, SENSOR_KINDS, SENSOR_OWNERSHIP_MAPPING_VERSION, type FieldOwner, type FieldValue, type PresetReference,
  type SensorConfiguration, type SensorFieldPath, type SensorKind,
} from './sensor-fields.ts';
import {
  RESIDUALS, SENSOR_SNAPSHOT_VERSION, sensorSnapshot, type Effective, type ResidualId, type Residual, type ResolvedField,
  type ResolvedSensorConfiguration, type SensorSnapshot, type SensorState,
} from './sensor-ownership.ts';
import type { PresetCitation } from './sensor-presets.ts';
import { LOCATION_ENVELOPE, STANDARD_SEA_LEVEL_PRESSURE_PA, WMM_BLACKOUT_NT, WMM_CAUTION_NT, type EffectiveConditions } from '@mirage/sensors/environment';

// Experiment payload schema 2 (TASK-155): what one integrated run used, kept
// as an `experiment` record in the unchanged record envelope v1 (TASK-136).
// It names the exact aircraft profile version (its only dependency), the SITL
// the run used as data (user decision of 2026-11-01: no dependency-model
// change), the session settings, every generated initial parameter, the frame
// script, and the TASK-143 sensor snapshot of the profile version verbatim.
// The SITL is one of two kinds. A launcher-owned SITL names the ArduPilot
// build the launcher started and the launcher experiment whose folder holds
// the logs. An external SITL, one the user started and MirageSITL connected
// to (user decision of 2026-11-01), names the connection, the verified source
// commit its reported git hash matched, the version it reported and the
// endpoints; it has no binary hash (MirageSITL never read the binary), no
// speedup (SITL's own command line set it), no frame script (MirageSITL can
// install one only in a SITL it starts), and its parameters are the generated
// ones the autopilot was confirmed to hold, written by nobody. Schema 3
// (TASK-163) adds the run's recording: the ID of its recorder v2 record and
// the Logging tab's settings it was made with, the storage warning reserve
// included, or null for a run that records nothing. Schemas 1 (TASK-154,
// launcher-owned only) and 2 stay readable: readExperiment presents them as
// schema 3 without a recording. Schema 4 (TASK-165) adds the lineage: an
// original run, a repeat of a parent experiment with the same inputs, or a
// variant of one with the changed inputs listed; the parent is named by its
// record's SHA-256 as data, and createExperimentRecord checks the claim
// against the parent's inputs; older schemas read as originals. Schema 5 (TASK-172) adds the flight task
// the run was started with: the definition verbatim, with the record of the
// project's `flight-task` item it came from named as data, or null for a run
// without one; a repeat flies it again and a variant may change it. Schema 6
// (TASK-169) adds the fault schedule: the effects the run applies by itself, or
// null for a run with none on a schedule. Schema 7 (TASK-148) adds the
// environment: the location the run flew at (the site or coordinates, the
// ground elevation, the heading, a measured QNH and an ISA temperature offset)
// and the effective conditions the calculation used there, which must be
// consistent with the session's home. A record without one (null, and every
// older schema) flew at standard gravity 9.80665 m/s² with a sea-level ISA
// origin. Older schemas read as schema 7 runs without what they lack, and new
// records are always schema 7. An experiment's inputs are fixed at version 1;
// the store allows only renaming afterwards.
// Configuration-time code only; never call it from a physics step.

export const EXPERIMENT_SCHEMA_VERSION = 7;
/** The TASK-169 schema, still accepted by validateExperiment and readExperiment. */
export const EXPERIMENT_SCHEMA_VERSION_6 = 6;
/** The TASK-172 schema, still accepted by validateExperiment and readExperiment. */
export const EXPERIMENT_SCHEMA_VERSION_5 = 5;
/** The TASK-165 schema, still accepted by validateExperiment and readExperiment. */
export const EXPERIMENT_SCHEMA_VERSION_4 = 4;
/** The TASK-163 schema, still accepted by validateExperiment and readExperiment. */
export const EXPERIMENT_SCHEMA_VERSION_3 = 3;
/** The TASK-154 schema, still accepted by validateExperiment and readExperiment. */
export const EXPERIMENT_SCHEMA_VERSION_1 = 1;
/** The TASK-155 schema, still accepted by validateExperiment and readExperiment. */
export const EXPERIMENT_SCHEMA_VERSION_2 = 2;
/** Recorder v2 record IDs: 32 lowercase hexadecimal digits. */
const RECORD_ID = /^[0-9a-f]{32}$/;
/** Recording rates are 0 or whole hertz up to 2000 (the TASK-162 signal catalog). */
const MAX_RECORDING_HZ = 2000;
/** Recording group and signal names of the TASK-162 catalog, such as motors or truth.position. */
const RECORDING_NAME = /^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)?$/;
/** Launcher API v1 limits (apps/launcher/src/server.ts parseExperimentSpec). */
export const MAX_EXPERIMENT_PARAMETERS = 4096;
export const MAX_FRAME_SCRIPT_BYTES = 64 * 1024;
/** ArduPilot parameter names: at most 16 characters (AP_MAX_NAME_SIZE). */
export const PARAMETER_NAME = /^[A-Z][A-Z0-9_]{0,15}$/;
/** Parameter values travel as float32 in PARAM_SET; the launcher refuses larger magnitudes. */
export const MAX_PARAMETER_MAGNITUDE = 3.4e38;
/** The physics rates an integrated session runs: ArduCopter's pre-arm gyro check needs at least 1.8 times its 400 Hz loop. */
export const EXPERIMENT_PHYSICS_HZ = [800, 1200] as const;
export type ExperimentPhysicsHz = typeof EXPERIMENT_PHYSICS_HZ[number];
/** Where each generated parameter came from. */
export const PARAMETER_SOURCES = ['frame', 'output', 'pwm', 'sensor', 'set', 'site'] as const;
export type ParameterSource = typeof PARAMETER_SOURCES[number];
/** The autopilot's PWM range, which the SITL link pins to its 1000-2000 us span. */
export const PWM_PARAMETER_NAMES: ReadonlySet<string> = new Set(['MOT_PWM_MIN', 'MOT_PWM_MAX']);
/** The TASK-128 scripting-enable parameter, which a frame script needs at 1. */
const SCRIPTING_ENABLE = 'SCR_ENABLE';
if (!FRAME_PARAMETER_NAMES.has(SCRIPTING_ENABLE)) throw new Error(`${SCRIPTING_ENABLE} is not a TASK-128 frame parameter`);
const OUTPUT_FUNCTION = /^SERVO[1-9][0-9]?_FUNCTION$/;
/** Launcher experiment and connection IDs: the UTC start time as 17 digits, '-' and 8 random hexadecimal digits. */
const LAUNCHER_EXPERIMENT_ID = /^[0-9]{17}-[0-9a-f]{8}$/;
/** The first 8 characters of a git commit, as ArduPilot reports them in AUTOPILOT_VERSION. */
const GIT_HASH = /^[0-9a-f]{8}$/;
/** Launcher catalog entry IDs (apps/launcher/src/catalog.ts). */
const CATALOG_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MATRIX_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MODEL_ID = 4294967295;
const MAX_TEXT = 4096;

export interface ExperimentProfile {
  /** Address of the exact aircraft-profile version, which is also the record's only dependency. */
  readonly sha256: string;
  readonly id: string;
  readonly version: number;
  readonly name: string;
}
/** The installed build the launcher started, as its catalog entry reports it (machine-local paths left out). */
export interface ExperimentFirmware {
  readonly catalogId: string;
  readonly firmwareVersion: string;
  readonly commit: string;
  readonly binarySha256: string;
  /** ArduPilot's copter.parm of the same source: the first initial-parameter layer. */
  readonly defaultParametersSha256: string;
}
/** A SITL the launcher started and owns, with the launcher experiment whose folder holds its logs. */
export interface LauncherSitl {
  readonly ownership: 'launcher';
  readonly experimentId: string;
  readonly ardupilot: ExperimentFirmware;
}
/** A SITL the user started; MirageSITL connected to it and owned only the connection. */
export interface ExternalSitl {
  readonly ownership: 'external';
  /** The launcher connection, in the format of launcher experiment IDs. */
  readonly connectionId: string;
  readonly ardupilot: {
    /** The verified source commit whose first 8 characters equal `gitHash`. */
    readonly commit: string;
    /** flight_custom_version of the autopilot's AUTOPILOT_VERSION. */
    readonly gitHash: string;
    /** flight_sw_version as text, for example 4.7.0-dev. */
    readonly firmwareVersion: string;
  };
  readonly endpoints: { readonly jsonPhysicsPort: number; readonly mavlink: { readonly transport: 'tcp' | 'udp'; readonly port: number } };
}
export type ExperimentSitl = LauncherSitl | ExternalSitl;
export interface ExperimentSession {
  readonly physicsHz: ExperimentPhysicsHz;
  readonly clockMode: 'sitl-lockstep';
  /** Simulated seconds per wall second as the launcher received it; null for an external SITL, whose own command line set it. */
  readonly speedup: number | null;
  /** Latitude and longitude in degrees (WGS-84), altitude above mean sea level in metres, heading in degrees. */
  readonly home: readonly [latitudeDeg: number, longitudeDeg: number, altitudeM: number, headingDeg: number];
  readonly modelId: number;
  /** SHA-256 of the derived vehicle manifest v2 the Worker loaded. */
  readonly manifestSha256: string;
  /** SHA-256 of the BET WASM module the Worker ran. */
  readonly betModuleSha256: string;
}
export interface ExperimentParameter {
  readonly name: string;
  readonly value: number;
  readonly source: ParameterSource;
}
export interface ExperimentPayload {
  readonly schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
  readonly profile: ExperimentProfile;
  readonly sitl: ExperimentSitl;
  readonly session: ExperimentSession;
  /**
   * Launcher-owned: exactly the list POSTed to the launcher, in that order,
   * which is also experiment.parm order. External: the same generated list,
   * which the autopilot was confirmed to hold.
   */
  readonly parameters: readonly ExperimentParameter[];
  /** The exact Lua text of a scripting-matrix frame, or null for a stock frame. */
  readonly frameScript: string | null;
  /** sensorSnapshot() of the profile version, verbatim. */
  readonly sensors: SensorSnapshot;
  /** The run's recording (TASK-163), or null for a run that records nothing. */
  readonly recording: ExperimentRecording | null;
  /** Where the run comes from (TASK-165). */
  readonly lineage: ExperimentLineage;
  /** The flight task the run was started with (TASK-172), or null. */
  readonly flightTask: ExperimentFlightTask | null;
  /** The effects the run applies by itself (TASK-169), or null for a run with none on a schedule. */
  readonly faults: FaultSchedule | null;
  /** The location and the effective conditions of the run (TASK-148); null for a run at standard gravity with a sea-level ISA origin. */
  readonly environment: ExperimentEnvironment | null;
}
/** A flight task as a run used it: the definition itself, and the stored version it came from. */
export interface ExperimentFlightTask {
  /** The SHA-256 of the `flight-task` record, as data. */
  readonly recordSha256: string;
  readonly name: string;
  readonly definition: FlightTaskDefinition;
}
/** The location of a run (TASK-148): the home ArduPilot started at, and what the air was derived from there. */
export interface ExperimentLocation {
  /** The built-in site the location was chosen from, or null for coordinates. */
  readonly site: string | null;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  /** Ground elevation above mean sea level at the origin, m: the home altitude. */
  readonly groundElevationMslM: number;
  readonly headingDeg: number;
  /** Measured sea-level pressure (QNH), Pa; null for the ISA standard 101325 Pa. */
  readonly measuredQnhPa: number | null;
  /** ISA temperature offset, K. */
  readonly temperatureOffsetK: number;
}
/** The environment of a run (TASK-148): its location and the conditions `effectiveConditions` gave the calculation there. */
export interface ExperimentEnvironment {
  readonly location: ExperimentLocation;
  readonly conditions: EffectiveConditions;
}
/** One input a variant changed (TASK-165), as experimentChanges names it. */
export const EXPERIMENT_INPUTS = ['aircraft profile', 'ArduPilot build', 'speed', 'physics rate', 'home', 'conditions', 'initial parameters', 'frame script',
  'sensors', 'recording setup', 'SITL', 'flight task', 'fault schedule'] as const;
export type ExperimentInput = typeof EXPERIMENT_INPUTS[number];
/**
 * An original run; a repeat of the experiment record `of` with the same inputs; or a variant of it with `changes`,
 * the inputs that differ, in EXPERIMENT_INPUTS order and never empty.
 */
export type ExperimentLineage =
  | { readonly kind: 'original' }
  | { readonly kind: 'repeat'; readonly of: string }
  | { readonly kind: 'variant'; readonly of: string; readonly changes: readonly ExperimentInput[] };
/** Experiment payload schema 6 (TASK-169): schema 7 without the environment. */
export type ExperimentPayloadV6 = Omit<ExperimentPayload, 'schemaVersion' | 'environment'> & { readonly schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION_6 };
/** Experiment payload schema 5 (TASK-172): schema 6 without the fault schedule. */
export type ExperimentPayloadV5 = Omit<ExperimentPayload, 'schemaVersion' | 'faults' | 'environment'> & { readonly schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION_5 };
/** Experiment payload schema 4 (TASK-165): schema 5 without the flight task. */
export type ExperimentPayloadV4 = Omit<ExperimentPayload, 'schemaVersion' | 'flightTask' | 'faults' | 'environment'> & { readonly schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION_4 };
/** Experiment payload schema 3 (TASK-163): schema 4 without the lineage. */
export type ExperimentPayloadV3 = Omit<ExperimentPayload, 'schemaVersion' | 'lineage' | 'flightTask' | 'faults' | 'environment'> & { readonly schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION_3 };
/**
 * The recording of a run (TASK-163): its recorder v2 record and the Logging tab settings it was made
 * with. Rates are 0 or whole hertz; a group or a signal absent here records at the common rate.
 */
export interface ExperimentRecording {
  readonly recordId: string;
  readonly commonHz: number;
  readonly groups: Readonly<Record<string, number>>;
  readonly signals: Readonly<Record<string, number>>;
  /** The run length the size estimate was made for, simulated minutes. */
  readonly durationMin: number;
  /** The storage warning reserve, MB (10⁶ bytes). */
  readonly reserveMb: number;
}
/** Experiment payload schema 2 (TASK-155): schema 3 without the recording. */
export type ExperimentPayloadV2 = Omit<ExperimentPayload, 'schemaVersion' | 'recording' | 'lineage' | 'flightTask' | 'faults' | 'environment'> & { readonly schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION_2 };
/** Experiment payload schema 1 (TASK-154): a launcher-owned SITL only. */
export interface ExperimentPayloadV1 {
  readonly schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION_1;
  readonly profile: ExperimentProfile;
  readonly ardupilot: ExperimentFirmware;
  readonly launcher: { readonly experimentId: string };
  readonly session: ExperimentSession & { readonly speedup: number };
  readonly parameters: readonly ExperimentParameter[];
  readonly frameScript: string | null;
  readonly sensors: SensorSnapshot;
}
/** What createExperimentRecord stores: the record name and the payload. */
export interface ExperimentInputs {
  readonly name: string;
  readonly payload: unknown;
}

function fail(message: string): never {
  throw new Error(`Invalid experiment: ${message}`);
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** A plain object with exactly `keys`; names the first missing or unexpected field. */
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) return fail(`${label} must be an object`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} lacks ${key}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} has an unexpected field ${key}`);
  return value;
}
function list(value: unknown, label: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) return fail(`${label} must be a list`);
  if (value.length > max) fail(`${label} may have at most ${max} entries`);
  const items: readonly unknown[] = value;
  return items;
}
function text(value: unknown, label: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return fail(`${label} must be text of 1 to ${max} characters`);
  return value;
}
function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}
function matching(value: unknown, pattern: RegExp, label: string, format: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) return fail(`${label} must be ${format}`);
  return value;
}
function sha256(value: unknown, label: string): string {
  return matching(value, SHA256_HEX, label, 'a lowercase SHA-256');
}
function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return fail(`${label} must be a number from ${min} to ${max}`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return fail(`${label} must be an integer from ${min} to ${max}`);
  return value;
}
function oneOf<T extends string | number>(value: unknown, options: readonly T[], label: string): T {
  const found = options.find(option => option === value);
  if (found === undefined) return fail(`${label} must be one of ${options.join(', ')}`);
  return found;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return fail(`${label} must be true or false`);
  return value;
}

function profileOf(value: unknown): ExperimentProfile {
  const p = exact(value, ['sha256', 'id', 'version', 'name'], 'profile');
  const name = typeof p.name === 'string' ? p.name : fail('profile.name must be text');
  let normalized: string;
  try {
    normalized = normalizeName(name);
  } catch (cause) {
    return fail(`profile.name: ${cause instanceof Error ? cause.message : 'rejected'}`);
  }
  if (normalized !== name) fail('profile.name must be a stored record name (NFC, without leading or trailing white space)');
  return {
    sha256: sha256(p.sha256, 'profile.sha256'), id: matching(p.id, UUID_V4, 'profile.id', 'a UUID v4'),
    version: integer(p.version, 'profile.version', 1, MAX_VERSION), name,
  };
}

function firmwareOf(value: unknown): ExperimentFirmware {
  const a = exact(value, ['catalogId', 'firmwareVersion', 'commit', 'binarySha256', 'defaultParametersSha256'], 'ardupilot');
  // Exactly the launcher catalog's rule (apps/launcher/src/catalog.ts parseCatalog): the record is
  // written after the launcher started SITL, so any version it admits must be recordable.
  const firmwareVersion = typeof a.firmwareVersion === 'string' && a.firmwareVersion !== '' ? a.firmwareVersion
    : fail('ardupilot.firmwareVersion must be non-empty text, as the launcher catalog requires');
  return {
    catalogId: matching(a.catalogId, CATALOG_ID, 'ardupilot.catalogId', 'a launcher catalog ID'), firmwareVersion,
    commit: matching(a.commit, COMMIT, 'ardupilot.commit', 'a 40-digit lowercase commit'),
    binarySha256: sha256(a.binarySha256, 'ardupilot.binarySha256'),
    defaultParametersSha256: sha256(a.defaultParametersSha256, 'ardupilot.defaultParametersSha256'),
  };
}

function sessionOf(value: unknown, ownership: ExperimentSitl['ownership']): ExperimentSession {
  const s = exact(value, ['physicsHz', 'clockMode', 'speedup', 'home', 'modelId', 'manifestSha256', 'betModuleSha256'], 'session');
  if (ownership === 'external' && s.speedup !== null) fail('session.speedup must be null for an external SITL, whose own command line set it');
  if (s.clockMode !== 'sitl-lockstep') fail('session.clockMode must be sitl-lockstep');
  const home = list(s.home, 'session.home', 4);
  if (home.length !== 4) fail('session.home must be [latitudeDeg, longitudeDeg, altitudeM, headingDeg]');
  return {
    physicsHz: oneOf(s.physicsHz, EXPERIMENT_PHYSICS_HZ, 'session.physicsHz'), clockMode: 'sitl-lockstep',
    speedup: ownership === 'external' ? null : finite(s.speedup, 'session.speedup', 0.1, 100),
    home: [finite(home[0], 'home latitude', -90, 90), finite(home[1], 'home longitude', -180, 180),
      finite(home[2], 'home altitude', -500, 9000), finite(home[3], 'home heading', 0, 360)],
    modelId: integer(s.modelId, 'session.modelId', 1, MAX_MODEL_ID),
    manifestSha256: sha256(s.manifestSha256, 'session.manifestSha256'),
    betModuleSha256: sha256(s.betModuleSha256, 'session.betModuleSha256'),
  };
}

/** Whether a name may carry a source tag: SITL sensor parameters, the TASK-128 frame and output names, the PWM range, or what follows from the run's home. */
/** Whether a parameter may be one of a run's own initial settings: anything but what the aircraft profile and the run set. */
export function isSetParameter(name: string): boolean { return admits('set', name); }
function admits(source: ParameterSource, name: string): boolean {
  switch (source) {
    case 'sensor': return name.startsWith('SIM_');
    case 'frame': return FRAME_PARAMETER_NAMES.has(name) && !OUTPUT_FUNCTION.test(name);
    case 'output': return FRAME_PARAMETER_NAMES.has(name) && OUTPUT_FUNCTION.test(name);
    case 'pwm': return PWM_PARAMETER_NAMES.has(name);
    // A batch's parameter set (TASK-176): anything but what the aircraft profile and the run themselves set.
    case 'set': return !FRAME_PARAMETER_NAMES.has(name) && !PWM_PARAMETER_NAMES.has(name) && !SITE_PARAMETER_NAMES.has(name);
    case 'site': return SITE_PARAMETER_NAMES.has(name);
    default: {
      const unexpected: never = source;
      return unexpected;
    }
  }
}
/**
 * The generated list in POST order: the frame parameters, the output functions,
 * the PWM pair MOT_PWM_MIN then MOT_PWM_MAX, the SIM_* sensor parameters, then
 * what follows from the run's home (TASK-172).
 */
function parametersOf(value: unknown): ExperimentParameter[] {
  const names = new Set<string>();
  let previous: ParameterSource = 'frame';
  const parameters = list(value, 'parameters', MAX_EXPERIMENT_PARAMETERS).map((item, index) => {
    const p = exact(item, ['name', 'value', 'source'], `parameter ${index + 1}`);
    const name = matching(p.name, PARAMETER_NAME, `parameter ${index + 1} name`, 'an ArduPilot parameter name of at most 16 characters');
    if (names.has(name)) fail(`parameter ${name} is listed twice`);
    names.add(name);
    const source = oneOf(p.source, PARAMETER_SOURCES, `parameter ${name} source`);
    if (!admits(source, name)) {
      fail(source === 'sensor' ? `sensor parameter ${name} is not a SIM_ parameter`
        : source === 'pwm' ? `pwm parameter ${name} is not MOT_PWM_MIN or MOT_PWM_MAX`
          : source === 'site' ? `site parameter ${name} is not ${[...SITE_PARAMETER_NAMES].join(' or ')}`
            : source === 'set' ? `set parameter ${name} is set by the aircraft profile or the run`
              : `${source} parameter ${name} is not a TASK-128 ${source} parameter`);
    }
    if (PARAMETER_SOURCES.indexOf(source) < PARAMETER_SOURCES.indexOf(previous)) {
      fail(`${source} parameter ${name} follows the ${previous} parameters; the order is ${PARAMETER_SOURCES.join(', ')}`);
    }
    previous = source;
    return { name, value: finite(p.value, `parameter ${name}`, -MAX_PARAMETER_MAGNITUDE, MAX_PARAMETER_MAGNITUDE), source };
  });
  const pwm = parameters.filter(p => p.source === 'pwm');
  const [minimum, maximum] = pwm;
  if (pwm.length !== 2 || minimum?.name !== 'MOT_PWM_MIN' || maximum?.name !== 'MOT_PWM_MAX') fail('parameters must give MOT_PWM_MIN then MOT_PWM_MAX');
  if (minimum.value >= maximum.value) fail('MOT_PWM_MIN must be below MOT_PWM_MAX');
  return parameters;
}

function frameScriptOf(value: unknown, parameters: readonly ExperimentParameter[]): string | null {
  if (value !== null && (typeof value !== 'string' || value.length === 0 || value.length > MAX_FRAME_SCRIPT_BYTES || /[^\t\n\x20-\x7e]/.test(value))) {
    fail(`frameScript must be null or printable ASCII Lua of 1 to ${MAX_FRAME_SCRIPT_BYTES} bytes`);
  }
  const scripting = parameters.some(p => p.source === 'frame' && p.name === SCRIPTING_ENABLE && p.value === 1);
  if (value === null && scripting) fail(`frame parameter ${SCRIPTING_ENABLE} 1 needs a frame script`);
  if (value !== null && !scripting) fail(`a frame script needs frame parameter ${SCRIPTING_ENABLE} 1`);
  return value;
}

// Sensor snapshot schema 2 (TASK-143, TASK-147). The shapes are checked here;
// createExperimentRecord compares the bytes with a snapshot recomputed from
// the stored profile. Reading never recomputes, so a stored snapshot stays
// readable after later code moves to another snapshot version.

function fieldValue(value: unknown, label: string): FieldValue {
  if (typeof value === 'number') return finite(value, label, -Number.MAX_VALUE, Number.MAX_VALUE);
  const items = list(value, label, 3);
  if (items.length !== 3) fail(`${label} must be a number or three numbers`);
  return items.map((item, index) => finite(item, `${label}[${index}]`, -Number.MAX_VALUE, Number.MAX_VALUE));
}
function effectiveOf(value: unknown, label: string): Effective {
  const kind = isRecord(value) ? value.kind : undefined;
  switch (kind) {
    case 'specified':
      return { kind, value: fieldValue(exact(value, ['kind', 'value'], label).value, `${label}.value`) };
    case 'neutral': {
      const neutral = exact(value, ['kind', 'value'], label).value;
      return { kind, value: neutral === 'at-cg' ? neutral : fieldValue(neutral, `${label}.value`) };
    }
    case 'neutralized':
    case 'ardupilot-stock':
    case 'not-applied':
      exact(value, ['kind'], label);
      return { kind };
    default:
      return fail(`${label}.kind must be specified, neutral, neutralized, ardupilot-stock or not-applied`);
  }
}
function isSource(value: unknown): value is ErrorSourceId {
  return ERROR_SOURCE_IDS.some(id => id === value);
}
function isResidual(value: unknown): value is ResidualId {
  return typeof value === 'string' && Object.hasOwn(RESIDUALS, value);
}
function isDelivery(value: unknown): value is DeliveryPath {
  return typeof value === 'string' && Object.hasOwn(DELIVERY_PATHS, value);
}
function isPatch(value: unknown): value is FirmwarePatchId {
  return typeof value === 'string' && Object.hasOwn(FIRMWARE_PATCHES, value);
}
function stateOf(configuration: SensorConfiguration | null): SensorState {
  return configuration === null ? 'ardupilot-defaults' : configuration.mode === 'ideal' ? 'ideal' : 'specified';
}

function resolutionOf(value: unknown, configuration: SensorConfiguration | null): ResolvedSensorConfiguration {
  const r = exact(value, ['mappingVersion', 'path', 'state', 'fields', 'residuals'], 'sensors.resolution');
  if (r.mappingVersion !== SENSOR_OWNERSHIP_MAPPING_VERSION) fail(`sensors.resolution.mappingVersion must be ${SENSOR_OWNERSHIP_MAPPING_VERSION}`);
  if (r.path !== 'native-json') fail('sensors.resolution.path must be native-json');
  const state = oneOf<SensorState>(r.state, ['ardupilot-defaults', 'specified', 'ideal'], 'sensors.resolution.state');
  if (state !== stateOf(configuration)) fail(`sensors.resolution.state ${state} does not match the configuration`);
  const items = list(r.fields, 'sensors.resolution.fields', SENSOR_FIELDS.length);
  if (items.length !== SENSOR_FIELDS.length) fail(`sensors.resolution.fields must list all ${SENSOR_FIELDS.length} sensor fields`);
  const fields = items.map((item, index): ResolvedField => {
    const label = `sensors.resolution.fields[${index}]`;
    const f = exact(item, ['path', 'owner', 'source', 'applicable', 'reason', 'stored', 'effective'], label);
    const path: SensorFieldPath | undefined = SENSOR_FIELDS[index]?.path;
    if (path === undefined || f.path !== path) return fail(`${label}.path must be ${String(path)}, in sensor field order`);
    if (f.source !== null && !isSource(f.source)) fail(`${label}.source must be null or a TASK-089 error source`);
    return {
      path, owner: oneOf<FieldOwner>(f.owner, ['ardupilot', 'mirage', 'unassigned'], `${label}.owner`), source: f.source,
      applicable: boolean(f.applicable, `${label}.applicable`), reason: nullableText(f.reason, `${label}.reason`),
      stored: f.stored === null ? null : fieldValue(f.stored, `${label}.stored`), effective: effectiveOf(f.effective, `${label}.effective`),
    };
  });
  const residuals = list(r.residuals, 'sensors.resolution.residuals', Object.keys(RESIDUALS).length).map(item => {
    if (!isResidual(item)) return fail(`sensors.resolution.residuals: ${String(item)} is not a known residual`);
    return item;
  });
  if (new Set(residuals).size !== residuals.length) fail('sensors.resolution.residuals lists a residual twice');
  return { mappingVersion: SENSOR_OWNERSHIP_MAPPING_VERSION, path: 'native-json', state, fields, residuals };
}

function matrixOf(value: unknown): OwnershipMatrix {
  const m = exact(value, ['schemaVersion', 'id', 'path', 'firmwarePatches', 'entries'], 'sensors.ownershipMatrix');
  if (m.schemaVersion !== OWNERSHIP_MATRIX_SCHEMA_VERSION) fail(`sensors.ownershipMatrix.schemaVersion must be ${OWNERSHIP_MATRIX_SCHEMA_VERSION}`);
  if (m.path !== 'native-json') fail('sensors.ownershipMatrix.path must be native-json');
  const firmwarePatches = list(m.firmwarePatches, 'sensors.ownershipMatrix.firmwarePatches', Object.keys(FIRMWARE_PATCHES).length).map(item => {
    if (!isPatch(item)) return fail(`sensors.ownershipMatrix.firmwarePatches: ${String(item)} is not a known firmware patch`);
    return item;
  });
  if (new Set(firmwarePatches).size !== firmwarePatches.length) fail('sensors.ownershipMatrix.firmwarePatches lists a patch twice');
  const sources = matrixSources(OWNERSHIP_MATRIX_SCHEMA_VERSION);
  const items = list(m.entries, 'sensors.ownershipMatrix.entries', sources.length);
  if (items.length !== sources.length) fail(`sensors.ownershipMatrix.entries must list all ${sources.length} error sources`);
  const entries = items.map((item, index): OwnershipEntry => {
    const label = `sensors.ownershipMatrix.entries[${index}]`;
    const e = exact(item, ['source', 'owner', 'delivery'], label);
    const source = sources[index];
    if (source === undefined || e.source !== source) return fail(`${label}.source must be ${String(source)}, in error source order`);
    const owner = oneOf<ErrorOwner>(e.owner, ['ardupilot', 'mirage', 'none'], `${label}.owner`);
    const delivery = list(e.delivery, `${label}.delivery`, Object.keys(DELIVERY_PATHS).length).map(path => {
      if (!isDelivery(path) || DELIVERY_PATHS[path].path !== 'native-json') return fail(`${label}.delivery: ${String(path)} is not a native-json delivery path`);
      return path;
    });
    if (owner !== 'mirage' && delivery.length > 0) fail(`${label}: only a MirageSITL-owned source has a delivery path`);
    return { source, owner, delivery };
  });
  return {
    schemaVersion: OWNERSHIP_MATRIX_SCHEMA_VERSION, id: matching(m.id, MATRIX_ID, 'sensors.ownershipMatrix.id', 'a matrix ID'), path: 'native-json',
    firmwarePatches, entries,
  };
}

function residualsOf(value: unknown, ids: readonly ResidualId[]): Residual[] {
  const items = list(value, 'sensors.residuals', ids.length);
  if (items.length !== ids.length) fail('sensors.residuals must state every residual of the resolution');
  return items.map((item, index) => {
    const r = exact(item, ['id', 'text', 'verified'], `sensors.residuals[${index}]`);
    const id = ids[index];
    if (id === undefined || r.id !== id) return fail(`sensors.residuals[${index}].id must be ${String(id)}, in resolution order`);
    return { id, text: text(r.text, `sensors.residuals[${index}].text`), verified: boolean(r.verified, `sensors.residuals[${index}].verified`) };
  });
}

function citationOf(value: unknown, label: string): PresetCitation {
  const c = exact(value, ['id', 'kind', 'title', 'publisher', 'documentNumber', 'revision', 'url'], label);
  return {
    id: text(c.id, `${label}.id`, 64), kind: oneOf<PresetCitation['kind']>(c.kind, ['specification', 'ardupilot-source'], `${label}.kind`),
    title: text(c.title, `${label}.title`), publisher: text(c.publisher, `${label}.publisher`),
    documentNumber: nullableText(c.documentNumber, `${label}.documentNumber`), revision: nullableText(c.revision, `${label}.revision`),
    url: nullableText(c.url, `${label}.url`),
  };
}
function presetsOf(value: unknown, configuration: SensorConfiguration | null): SensorSnapshot['presets'] {
  // The snapshot cites every preset the configuration references, in sensor order.
  const referenced: SensorKind[] = configuration === null ? [] : SENSOR_KINDS.filter(kind => configuration[kind].preset !== null);
  const items = list(value, 'sensors.presets', SENSOR_KINDS.length);
  if (items.length !== referenced.length) fail('sensors.presets must cite exactly the presets the configuration references');
  return items.map((item, index) => {
    const label = `sensors.presets[${index}]`;
    const p = exact(item, ['sensor', 'reference', 'citations'], label);
    const sensor = referenced[index];
    if (sensor === undefined || p.sensor !== sensor) return fail(`${label}.sensor must be ${String(sensor)}, in sensor order`);
    const r = exact(p.reference, ['catalogVersion', 'id'], `${label}.reference`);
    const reference: PresetReference = { catalogVersion: integer(r.catalogVersion, `${label}.reference.catalogVersion`, 1, MAX_VERSION),
      id: text(r.id, `${label}.reference.id`, 128) };
    const stored = configuration?.[sensor].preset;
    if (stored?.catalogVersion !== reference.catalogVersion || stored.id !== reference.id) fail(`${label}.reference must be the configuration's ${sensor} preset`);
    const citations = list(p.citations, `${label}.citations`, 64).map((citation, at) => citationOf(citation, `${label}.citations[${at}]`));
    return { sensor, reference, citations };
  });
}

function snapshotOf(value: unknown, profileSha256: string): SensorSnapshot {
  const version = isRecord(value) ? value.schemaVersion : undefined;
  if (version !== SENSOR_SNAPSHOT_VERSION) {
    fail(`sensors must be a sensor snapshot of schema ${SENSOR_SNAPSHOT_VERSION}, not ${typeof version === 'number' ? `schema ${version}` : 'an unversioned value'}`);
  }
  const s = exact(value, ['schemaVersion', 'profileSha256', 'mappingVersion', 'configuration', 'resolution', 'ownershipMatrix', 'residuals', 'presets'], 'sensors');
  if (sha256(s.profileSha256, 'sensors.profileSha256') !== profileSha256) fail('sensors.profileSha256 must equal profile.sha256');
  if (s.mappingVersion !== SENSOR_OWNERSHIP_MAPPING_VERSION) fail(`sensors.mappingVersion must be ${SENSOR_OWNERSHIP_MAPPING_VERSION}`);
  let configuration: SensorConfiguration | null = null;
  if (s.configuration !== null) {
    try {
      configuration = validateSensorConfiguration(s.configuration);
    } catch (cause) {
      fail(`sensors.configuration: ${cause instanceof Error ? cause.message : 'rejected'}`);
    }
  }
  const resolution = resolutionOf(s.resolution, configuration);
  return {
    schemaVersion: SENSOR_SNAPSHOT_VERSION, profileSha256, mappingVersion: SENSOR_OWNERSHIP_MAPPING_VERSION, configuration, resolution,
    ownershipMatrix: matrixOf(s.ownershipMatrix), residuals: residualsOf(s.residuals, resolution.residuals),
    presets: presetsOf(s.presets, configuration),
  };
}

function sitlOf(value: unknown): ExperimentSitl {
  const ownership = isRecord(value) ? value.ownership : undefined;
  if (ownership === 'launcher') {
    const l = exact(value, ['ownership', 'experimentId', 'ardupilot'], 'sitl');
    return { ownership, experimentId: matching(l.experimentId, LAUNCHER_EXPERIMENT_ID, 'sitl.experimentId', 'a launcher experiment ID'), ardupilot: firmwareOf(l.ardupilot) };
  }
  if (ownership !== 'external') return fail('sitl.ownership must be launcher or external');
  const e = exact(value, ['ownership', 'connectionId', 'ardupilot', 'endpoints'], 'sitl');
  const a = exact(e.ardupilot, ['commit', 'gitHash', 'firmwareVersion'], 'sitl.ardupilot');
  const commit = matching(a.commit, COMMIT, 'sitl.ardupilot.commit', 'a 40-digit lowercase commit');
  const gitHash = matching(a.gitHash, GIT_HASH, 'sitl.ardupilot.gitHash', '8 lowercase hexadecimal digits');
  if (!commit.startsWith(gitHash)) fail('sitl.ardupilot.gitHash must be the first 8 characters of sitl.ardupilot.commit');
  const ends = exact(e.endpoints, ['jsonPhysicsPort', 'mavlink'], 'sitl.endpoints');
  const mavlink = exact(ends.mavlink, ['transport', 'port'], 'sitl.endpoints.mavlink');
  const transport = oneOf<'tcp' | 'udp'>(mavlink.transport, ['tcp', 'udp'], 'sitl.endpoints.mavlink.transport');
  const jsonPhysicsPort = integer(ends.jsonPhysicsPort, 'sitl.endpoints.jsonPhysicsPort', 1, 65535);
  const port = integer(mavlink.port, 'sitl.endpoints.mavlink.port', 1, 65535);
  if (transport === 'udp' && port === jsonPhysicsPort) fail('sitl.endpoints must use two different UDP ports');
  return {
    ownership, connectionId: matching(e.connectionId, LAUNCHER_EXPERIMENT_ID, 'sitl.connectionId', 'a launcher connection ID'),
    ardupilot: { commit, gitHash, firmwareVersion: text(a.firmwareVersion, 'sitl.ardupilot.firmwareVersion', 64) },
    endpoints: { jsonPhysicsPort, mavlink: { transport, port } },
  };
}

function payloadV1Of(payload: unknown): ExperimentPayloadV1 {
  const p = exact(payload, ['schemaVersion', 'profile', 'ardupilot', 'launcher', 'session', 'parameters', 'frameScript', 'sensors'], 'the payload');
  const profile = profileOf(p.profile);
  const launcher = exact(p.launcher, ['experimentId'], 'launcher');
  const parameters = parametersOf(p.parameters);
  const session = sessionOf(p.session, 'launcher');
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION_1, profile, ardupilot: firmwareOf(p.ardupilot),
    launcher: { experimentId: matching(launcher.experimentId, LAUNCHER_EXPERIMENT_ID, 'launcher.experimentId', 'a launcher experiment ID') },
    session: { ...session, speedup: session.speedup ?? fail('session.speedup is required') }, parameters,
    frameScript: frameScriptOf(p.frameScript, parameters), sensors: snapshotOf(p.sensors, profile.sha256),
  };
}
function ratesOf(value: unknown, label: string): Record<string, number> {
  if (!isRecord(value)) return fail(`${label} must be an object`);
  const rates: Record<string, number> = {};
  for (const [name, rate] of Object.entries(value)) {
    rates[matching(name, RECORDING_NAME, `${label} names`, 'catalog names')] = integer(rate, `${label}.${name}`, 0, MAX_RECORDING_HZ);
  }
  return rates;
}
function recordingOf(value: unknown): ExperimentRecording | null {
  if (value === null) return null;
  const r = exact(value, ['recordId', 'commonHz', 'groups', 'signals', 'durationMin', 'reserveMb'], 'recording');
  return {
    recordId: matching(r.recordId, RECORD_ID, 'recording.recordId', '32 lowercase hexadecimal digits'),
    commonHz: integer(r.commonHz, 'recording.commonHz', 0, MAX_RECORDING_HZ), groups: ratesOf(r.groups, 'recording.groups'),
    signals: ratesOf(r.signals, 'recording.signals'), durationMin: integer(r.durationMin, 'recording.durationMin', 1, 24 * 60),
    reserveMb: finite(r.reserveMb, 'recording.reserveMb', 0, 1e9),
  };
}
function lineageOf(value: unknown): ExperimentLineage {
  const kind = isRecord(value) ? value.kind : undefined;
  if (kind === 'original') { exact(value, ['kind'], 'lineage'); return { kind }; }
  if (kind === 'repeat') { const l = exact(value, ['kind', 'of'], 'lineage'); return { kind, of: sha256(l.of, 'lineage.of') }; }
  if (kind !== 'variant') return fail('lineage.kind must be original, repeat or variant');
  const l = exact(value, ['kind', 'of', 'changes'], 'lineage');
  const changes = list(l.changes, 'lineage.changes', EXPERIMENT_INPUTS.length).map((change, index) => oneOf(change, EXPERIMENT_INPUTS, `lineage.changes[${index}]`));
  if (changes.length === 0) fail('a variant changes at least one input; one that changes none is a repeat');
  if (changes.some((change, index) => index > 0 && EXPERIMENT_INPUTS.indexOf(change) <= EXPERIMENT_INPUTS.indexOf(changes[index - 1] ?? change))) {
    fail('lineage.changes must follow the order of EXPERIMENT_INPUTS without repeats');
  }
  return { kind, of: sha256(l.of, 'lineage.of'), changes };
}
function flightTaskOf(value: unknown): ExperimentFlightTask | null {
  if (value === null) return null;
  const t = exact(value, ['recordSha256', 'name', 'definition'], 'flightTask');
  try {
    return { recordSha256: sha256(t.recordSha256, 'flightTask.recordSha256'), name: text(t.name, 'flightTask.name'), definition: parseFlightTask(t.definition) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
/** A stored schedule: never an empty one, so that a run with no schedule has one spelling. */
function faultsOf(value: unknown): FaultSchedule | null {
  if (value === null) return null;
  try {
    const schedule = parseFaultSchedule(value);
    return schedule.entries.length === 0 ? fail('faults must be null when nothing is scheduled') : schedule;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
const MAGNETIC_ZONES = ['normal', 'caution', 'blackout'] as const;
const PRESSURE_SOURCES = ['standard', 'measured'] as const;
function locationOf(value: unknown): ExperimentLocation {
  const env = LOCATION_ENVELOPE;
  const l = exact(value, ['site', 'latitudeDeg', 'longitudeDeg', 'groundElevationMslM', 'headingDeg', 'measuredQnhPa', 'temperatureOffsetK'], 'environment.location');
  return {
    site: l.site === null ? null : text(l.site, 'environment.location.site', 64),
    // Off the poles, as effectiveConditions requires.
    latitudeDeg: finite(l.latitudeDeg, 'environment.location.latitudeDeg', -89.9, 89.9), longitudeDeg: finite(l.longitudeDeg, 'environment.location.longitudeDeg', -180, 180),
    groundElevationMslM: finite(l.groundElevationMslM, 'environment.location.groundElevationMslM', env.minElevationM, env.maxElevationM),
    headingDeg: finite(l.headingDeg, 'environment.location.headingDeg', 0, 360),
    measuredQnhPa: l.measuredQnhPa === null ? null : finite(l.measuredQnhPa, 'environment.location.measuredQnhPa', env.minSeaLevelPressurePa, env.maxSeaLevelPressurePa),
    temperatureOffsetK: finite(l.temperatureOffsetK, 'environment.location.temperatureOffsetK', -env.maxTemperatureOffsetK, env.maxTemperatureOffsetK),
  };
}
function geoidOf(value: unknown): EffectiveConditions['geoid'] {
  const status = isRecord(value) ? value.status : undefined;
  if (status === 'AVAILABLE') {
    const g = exact(value, ['status', 'model', 'sha256', 'undulationM'], 'environment.conditions.geoid');
    return { status, model: text(g.model, 'environment.conditions.geoid.model', 64), sha256: sha256(g.sha256, 'environment.conditions.geoid.sha256'),
      undulationM: finite(g.undulationM, 'environment.conditions.geoid.undulationM', -200, 200) };
  }
  if (status !== 'BLOCKED_EXTERNAL') return fail('environment.conditions.geoid.status must be AVAILABLE or BLOCKED_EXTERNAL');
  const g = exact(value, ['status', 'reason', 'undulationM'], 'environment.conditions.geoid');
  if (g.undulationM !== 0) fail('environment.conditions.geoid.undulationM must be 0 without a geoid grid');
  return { status, reason: text(g.reason, 'environment.conditions.geoid.reason'), undulationM: 0 };
}
/**
 * The effective conditions as `effectiveConditions` of @mirage/sensors/environment records them, checked by form and
 * for consistency with the location: evaluated at its coordinates and elevation, h = H + N, the WMM zone of the
 * horizontal field, and the air from its sea-level pressure and temperature offset. The gravity, field and air
 * values themselves depend on the data files of the computer that ran, and are recorded, not recomputed.
 */
function conditionsOf(value: unknown, location: ExperimentLocation): EffectiveConditions {
  const env = LOCATION_ENVELOPE, at = 'environment.conditions';
  const c = exact(value, ['schemaVersion', 'latitudeDeg', 'longitudeDeg', 'groundElevationMslM', 'geoid', 'ellipsoidalHeightM', 'gravityMps2', 'magnetic', 'air'], at);
  if (c.schemaVersion !== 1) fail(`${at}.schemaVersion must be 1`);
  if (c.latitudeDeg !== location.latitudeDeg || c.longitudeDeg !== location.longitudeDeg || c.groundElevationMslM !== location.groundElevationMslM) {
    fail(`${at} must be evaluated at environment.location`);
  }
  const geoid = geoidOf(c.geoid);
  const ellipsoidalHeightM = finite(c.ellipsoidalHeightM, `${at}.ellipsoidalHeightM`, env.minElevationM - 200, env.maxElevationM + 200);
  if (ellipsoidalHeightM !== location.groundElevationMslM + geoid.undulationM) fail(`${at}.ellipsoidalHeightM must be the ground elevation plus the geoid undulation`);
  const m = exact(c.magnetic, ['model', 'decimalYear', 'northNt', 'eastNt', 'downNt', 'horizontalNt', 'totalNt', 'declinationDeg', 'inclinationDeg', 'zone'], `${at}.magnetic`);
  const horizontalNt = finite(m.horizontalNt, `${at}.magnetic.horizontalNt`, 0, 1e5);
  const zone = oneOf(m.zone, MAGNETIC_ZONES, `${at}.magnetic.zone`);
  if (zone !== (horizontalNt < WMM_BLACKOUT_NT ? 'blackout' : horizontalNt < WMM_CAUTION_NT ? 'caution' : 'normal')) fail(`${at}.magnetic.zone does not match the horizontal field`);
  const a = exact(c.air, ['seaLevelPressurePa', 'seaLevelPressureSource', 'temperatureOffsetK', 'temperatureK', 'pressurePa', 'densityKgM3'], `${at}.air`);
  const seaLevelPressurePa = finite(a.seaLevelPressurePa, `${at}.air.seaLevelPressurePa`, env.minSeaLevelPressurePa, env.maxSeaLevelPressurePa);
  const seaLevelPressureSource = oneOf(a.seaLevelPressureSource, PRESSURE_SOURCES, `${at}.air.seaLevelPressureSource`);
  if (seaLevelPressureSource !== (location.measuredQnhPa === null ? 'standard' : 'measured') || seaLevelPressurePa !== (location.measuredQnhPa ?? STANDARD_SEA_LEVEL_PRESSURE_PA) ||
    a.temperatureOffsetK !== location.temperatureOffsetK) {
    fail(`${at}.air must come from the location's sea-level pressure and temperature offset`);
  }
  return {
    schemaVersion: 1, latitudeDeg: location.latitudeDeg, longitudeDeg: location.longitudeDeg, groundElevationMslM: location.groundElevationMslM, geoid, ellipsoidalHeightM,
    gravityMps2: finite(c.gravityMps2, `${at}.gravityMps2`, 9.7, 9.9),
    magnetic: {
      model: text(m.model, `${at}.magnetic.model`, 64), decimalYear: finite(m.decimalYear, `${at}.magnetic.decimalYear`, 2000, 2100),
      northNt: finite(m.northNt, `${at}.magnetic.northNt`, -1e5, 1e5), eastNt: finite(m.eastNt, `${at}.magnetic.eastNt`, -1e5, 1e5),
      downNt: finite(m.downNt, `${at}.magnetic.downNt`, -1e5, 1e5), horizontalNt, totalNt: finite(m.totalNt, `${at}.magnetic.totalNt`, 0, 1e5),
      declinationDeg: finite(m.declinationDeg, `${at}.magnetic.declinationDeg`, -180, 180), inclinationDeg: finite(m.inclinationDeg, `${at}.magnetic.inclinationDeg`, -90, 90), zone,
    },
    air: {
      seaLevelPressurePa, seaLevelPressureSource, temperatureOffsetK: location.temperatureOffsetK,
      temperatureK: finite(a.temperatureK, `${at}.air.temperatureK`, 180, 330), pressurePa: finite(a.pressurePa, `${at}.air.pressurePa`, 1000, 120000),
      densityKgM3: finite(a.densityKgM3, `${at}.air.densityKgM3`, 0.05, 2),
    },
  };
}
/** The environment of a run, or null; the session's home must be its location (TASK-148: home and origin consistency). */
function environmentOf(value: unknown, home: ExperimentSession['home']): ExperimentEnvironment | null {
  if (value === null) return null;
  const e = exact(value, ['location', 'conditions'], 'environment');
  const location = locationOf(e.location);
  if (home[0] !== location.latitudeDeg || home[1] !== location.longitudeDeg || home[2] !== location.groundElevationMslM || home[3] !== location.headingDeg) {
    fail("session.home must be the environment's location: its latitude, longitude, ground elevation and heading");
  }
  return { location, conditions: conditionsOf(e.conditions, location) };
}
type ReadableVersion = typeof EXPERIMENT_SCHEMA_VERSION | typeof EXPERIMENT_SCHEMA_VERSION_6 | typeof EXPERIMENT_SCHEMA_VERSION_5 | typeof EXPERIMENT_SCHEMA_VERSION_4 |
  typeof EXPERIMENT_SCHEMA_VERSION_3 | typeof EXPERIMENT_SCHEMA_VERSION_2;
/** The fields each readable schema adds to schema 2's, in the order they were added. */
const ADDED_FIELDS: Readonly<Record<ReadableVersion, readonly string[]>> = {
  [EXPERIMENT_SCHEMA_VERSION]: ['recording', 'lineage', 'flightTask', 'faults', 'environment'],
  [EXPERIMENT_SCHEMA_VERSION_6]: ['recording', 'lineage', 'flightTask', 'faults'],
  [EXPERIMENT_SCHEMA_VERSION_5]: ['recording', 'lineage', 'flightTask'],
  [EXPERIMENT_SCHEMA_VERSION_4]: ['recording', 'lineage'],
  [EXPERIMENT_SCHEMA_VERSION_3]: ['recording'],
  [EXPERIMENT_SCHEMA_VERSION_2]: [],
};
/**
 * Schema 7, 6 (no `environment`), 5 (no `faults` either), 4 (no `flightTask` either), 3 (no `lineage` either) or 2 (no
 * `recording` either): absent fields are absent from both the keys and the result.
 */
function payloadOf(payload: unknown, version: ReadableVersion):
  ExperimentPayload | ExperimentPayloadV6 | ExperimentPayloadV5 | ExperimentPayloadV4 | ExperimentPayloadV3 | ExperimentPayloadV2 {
  const keys = ['schemaVersion', 'profile', 'sitl', 'session', 'parameters', 'frameScript', 'sensors'];
  const p = exact(payload, [...keys, ...ADDED_FIELDS[version]], 'the payload');
  const profile = profileOf(p.profile);
  const sitl = sitlOf(p.sitl);
  const parameters = parametersOf(p.parameters);
  const frameScript = frameScriptOf(p.frameScript, parameters);
  if (sitl.ownership === 'external' && frameScript !== null) fail('an external SITL has no frame script: MirageSITL installs one only in a SITL it starts');
  const session = sessionOf(p.session, sitl.ownership);
  const common = { profile, sitl, session, parameters, frameScript, sensors: snapshotOf(p.sensors, profile.sha256) };
  switch (version) {
    case EXPERIMENT_SCHEMA_VERSION:
      return { schemaVersion: version, ...common, recording: recordingOf(p.recording), lineage: lineageOf(p.lineage), flightTask: flightTaskOf(p.flightTask),
        faults: faultsOf(p.faults), environment: environmentOf(p.environment, session.home) };
    case EXPERIMENT_SCHEMA_VERSION_6:
      return { schemaVersion: version, ...common, recording: recordingOf(p.recording), lineage: lineageOf(p.lineage), flightTask: flightTaskOf(p.flightTask),
        faults: faultsOf(p.faults) };
    case EXPERIMENT_SCHEMA_VERSION_5:
      return { schemaVersion: version, ...common, recording: recordingOf(p.recording), lineage: lineageOf(p.lineage), flightTask: flightTaskOf(p.flightTask) };
    case EXPERIMENT_SCHEMA_VERSION_4: return { schemaVersion: version, ...common, recording: recordingOf(p.recording), lineage: lineageOf(p.lineage) };
    case EXPERIMENT_SCHEMA_VERSION_3: return { schemaVersion: version, ...common, recording: recordingOf(p.recording) };
    case EXPERIMENT_SCHEMA_VERSION_2: return { schemaVersion: version, ...common };
    default: {
      const unexpected: never = version;
      return unexpected;
    }
  }
}

/**
 * Validates an experiment payload of schema 7, or of schema 6 (TASK-169), 5 (TASK-172), 4 (TASK-165), 3 (TASK-163),
 * 2 (TASK-155) or 1 (TASK-154) as stored then, from `unknown`; returns a deep-frozen copy of what was given.
 * Registered for the `experiment` kind, so imports of older records keep working.
 */
export function validateExperiment(payload: unknown):
  ExperimentPayload | ExperimentPayloadV6 | ExperimentPayloadV5 | ExperimentPayloadV4 | ExperimentPayloadV3 | ExperimentPayloadV2 | ExperimentPayloadV1 {
  const version = isRecord(payload) ? payload.schemaVersion : undefined;
  if (version === EXPERIMENT_SCHEMA_VERSION || version === EXPERIMENT_SCHEMA_VERSION_6 || version === EXPERIMENT_SCHEMA_VERSION_5 || version === EXPERIMENT_SCHEMA_VERSION_4 ||
    version === EXPERIMENT_SCHEMA_VERSION_3 || version === EXPERIMENT_SCHEMA_VERSION_2) {
    return freeze(payloadOf(payload, version));
  }
  if (version === EXPERIMENT_SCHEMA_VERSION_1) return freeze(payloadV1Of(payload));
  return fail(`unsupported experiment schema ${String(version)}; this reader knows schemas ${EXPERIMENT_SCHEMA_VERSION_1} to ${EXPERIMENT_SCHEMA_VERSION}`);
}

/**
 * An older payload as schema 7: without an environment before schema 7 (standard gravity and a sea-level ISA origin),
 * without a fault schedule before schema 6 and a flight task before schema 5; an original run before schema 4,
 * without a recording before schema 3; a schema 1 payload's launcher and ardupilot fields become a launcher-owned SITL.
 */
export function migrateExperiment(
  payload: ExperimentPayload | ExperimentPayloadV6 | ExperimentPayloadV5 | ExperimentPayloadV4 | ExperimentPayloadV3 | ExperimentPayloadV2 | ExperimentPayloadV1,
): ExperimentPayload {
  const original = { kind: 'original' } as const;
  const absent = { flightTask: null, faults: null, environment: null } as const;
  switch (payload.schemaVersion) {
    case EXPERIMENT_SCHEMA_VERSION: return payload;
    case EXPERIMENT_SCHEMA_VERSION_6: return freeze({ ...payload, schemaVersion: EXPERIMENT_SCHEMA_VERSION, environment: null });
    case EXPERIMENT_SCHEMA_VERSION_5: return freeze({ ...payload, schemaVersion: EXPERIMENT_SCHEMA_VERSION, faults: null, environment: null });
    case EXPERIMENT_SCHEMA_VERSION_4: return freeze({ ...payload, schemaVersion: EXPERIMENT_SCHEMA_VERSION, ...absent });
    case EXPERIMENT_SCHEMA_VERSION_3: return freeze({ ...payload, schemaVersion: EXPERIMENT_SCHEMA_VERSION, lineage: original, ...absent });
    case EXPERIMENT_SCHEMA_VERSION_2: {
      const { profile, sitl, session, parameters, frameScript, sensors } = payload;
      return freeze({ schemaVersion: EXPERIMENT_SCHEMA_VERSION, profile, sitl, session, parameters, frameScript, sensors, recording: null, lineage: original, ...absent });
    }
    case EXPERIMENT_SCHEMA_VERSION_1: {
      const { profile, ardupilot, launcher, session, parameters, frameScript, sensors } = payload;
      return freeze({ schemaVersion: EXPERIMENT_SCHEMA_VERSION, profile, sitl: { ownership: 'launcher', experimentId: launcher.experimentId, ardupilot },
        session, parameters, frameScript, sensors, recording: null, lineage: original, ...absent });
    }
    default: {
      const unexpected: never = payload;
      return unexpected;
    }
  }
}

/** Canonical JSON text of a value, for comparing inputs. */
const same = (a: unknown, b: unknown): boolean => equalBytes(canonicalBytes(a), canonicalBytes(b));
/** The recording setup of a run: its rates and limits without the record that was made. */
function recordingSetup(recording: ExperimentRecording | null): unknown {
  if (!recording) return null;
  return { commonHz: recording.commonHz, groups: recording.groups, signals: recording.signals, durationMin: recording.durationMin, reserveMb: recording.reserveMb };
}
/** The build a SITL ran: a launcher-owned SITL's binary, or the commit an external SITL reported. */
function buildOf(sitl: ExperimentSitl): unknown {
  return sitl.ownership === 'launcher' ? { catalogId: sitl.ardupilot.catalogId, commit: sitl.ardupilot.commit, binarySha256: sitl.ardupilot.binarySha256 }
    : { commit: sitl.ardupilot.commit };
}
/** What the user chose of the environment beyond the home (TASK-148): the sea-level pressure and the temperature offset, or no environment. */
function conditionsInput(environment: ExperimentEnvironment | null): unknown {
  return environment ? { measuredQnhPa: environment.location.measuredQnhPa, temperatureOffsetK: environment.location.temperatureOffsetK } : null;
}
/**
 * The inputs in which `child` differs from `parent` (TASK-165), in EXPERIMENT_INPUTS order. The run's own identity
 * (launcher experiment or connection ID, the recording it made, its lineage, the BET module build and the
 * date-dependent magnetic field of its conditions) is not an input.
 */
export function experimentChanges(parent: ExperimentPayload, child: ExperimentPayload): ExperimentInput[] {
  const changes: ExperimentInput[] = [];
  const check = (input: ExperimentInput, differs: boolean) => { if (differs) changes.push(input); };
  check('aircraft profile', parent.profile.sha256 !== child.profile.sha256);
  check('ArduPilot build', !same(buildOf(parent.sitl), buildOf(child.sitl)));
  check('speed', parent.session.speedup !== child.session.speedup);
  check('physics rate', parent.session.physicsHz !== child.session.physicsHz);
  check('home', !same(parent.session.home, child.session.home));
  check('conditions', !same(conditionsInput(parent.environment), conditionsInput(child.environment)));
  // What follows from the home is compared as the home: a record from before TASK-172 has no such parameter and still has a repeat.
  const chosen = (parameters: readonly ExperimentParameter[]) => parameters.filter(p => p.source !== 'site');
  check('initial parameters', !same(chosen(parent.parameters), chosen(child.parameters)));
  check('frame script', parent.frameScript !== child.frameScript);
  check('sensors', !same(parent.sensors, child.sensors));
  check('recording setup', !same(recordingSetup(parent.recording), recordingSetup(child.recording)));
  check('SITL', parent.sitl.ownership !== child.sitl.ownership);
  check('flight task', !same(parent.flightTask?.definition ?? null, child.flightTask?.definition ?? null));
  check('fault schedule', !same(parent.faults, child.faults));
  return changes;
}

/**
 * The record name '<profile name> run <launcher experiment ID>', or
 * '<profile name> connection <connection ID>' for an external SITL. The
 * profile name is shortened by code points so that the whole name stays
 * within the store's MAX_NAME_CODE_POINTS.
 */
export function experimentRecordName(profileName: string, experimentId: string, ownership: ExperimentSitl['ownership'] = 'launcher'): string {
  const suffix = ownership === 'external' ? ` connection ${experimentId}` : ` run ${experimentId}`;
  const room = MAX_NAME_CODE_POINTS - [...suffix].length;
  if (room < 1) throw new Error('The launcher experiment ID is too long for a record name');
  return `${[...profileName].slice(0, room).join('').trimEnd()}${suffix}`;
}

/**
 * Stores an experiment as a new item of `projectId`. The payload must name the
 * stored profile version exactly (address, item, version and name), and what
 * MirageSITL generates from that version is recomputed and compared: the
 * sensor snapshot byte for byte, the frame and output parameters (values and
 * order) and the frame script of frameConfiguration, and the SHA-256 of the
 * vehicle manifest derived from it and its component cards with the
 * session's model ID. The PWM pair and the SIM_* sensor parameters are checked
 * by form only; they also depend on the session context (home altitude,
 * compass offsets) and the ArduPilot catalog. A site parameter must be the
 * value the session's home gives. The profile version becomes the record's
 * only dependency.
 */
export async function createExperimentRecord(store: ProjectStore, projectId: string, inputs: ExperimentInputs): Promise<StoredVersion> {
  const validated = validateExperiment(inputs.payload);
  if (validated.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) fail(`new experiments are schema ${EXPERIMENT_SCHEMA_VERSION}; schema ${validated.schemaVersion} is only read`);
  const payload = validated;
  const stored = await store.get(payload.profile.sha256);
  const record = stored.record;
  if (record.kind !== 'aircraft-profile' || record.projectId !== projectId) fail(`profile ${stored.sha256} is not an aircraft profile of this project`);
  if (record.id !== payload.profile.id || record.version !== payload.profile.version || record.name !== payload.profile.name) {
    fail(`profile must give the id, version and name of stored version ${stored.sha256}`);
  }
  if (!equalBytes(canonicalBytes(payload.sensors), canonicalBytes(sensorSnapshot(stored)))) {
    fail('sensors must be the sensor snapshot of the stored profile version');
  }
  const profile = readAircraftProfile(stored);
  const frame = frameConfiguration(profile, stored.sha256);
  if (!frame.ok) return fail(`ArduPilot has no frame for profile ${stored.sha256}`);
  // parametersOf fixed the order, so the frame and output entries are the head of the list.
  const generated = payload.parameters.filter(p => p.source === 'frame' || p.source === 'output');
  if (generated.length !== frame.parameters.length ||
    generated.some((p, index) => p.name !== frame.parameters[index]?.name || p.value !== frame.parameters[index]?.value)) {
    fail('the frame and output parameters must be the ones frameConfiguration generates for the stored profile version, in its order');
  }
  if (payload.frameScript !== frame.script) fail('frameScript must be the script frameConfiguration generates for the stored profile version');
  // A connection has none (its SITL was already running); a run the launcher starts says what its home gave ArduPilot.
  for (const parameter of payload.parameters.filter(p => p.source === 'site')) {
    const expected = siteParameters(payload.session.home).find(item => item.name === parameter.name);
    if (parameter.value !== expected?.value) fail(`${parameter.name} must be the value session.home gives, ${String(expected?.value)}`);
  }
  const cards = new Map<string, ComponentCard>();
  for (const dependency of profileDependencies(profile)) {
    if (dependency.kind === 'component-card') cards.set(dependency.sha256, readComponentCard(await store.get(dependency.sha256)));
  }
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) return fail(`profile ${stored.sha256} cannot be derived: ${resolved.missing.join('; ')}`);
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: payload.session.modelId });
  if (derived.sha256 !== payload.session.manifestSha256) {
    fail('session.manifestSha256 must be the manifest derived from the stored profile version with session.modelId');
  }
  // TASK-172: the flight task is the stored version it names, byte for byte.
  if (payload.flightTask) {
    const task = await store.get(payload.flightTask.recordSha256);
    if (task.record.kind !== 'flight-task' || task.record.projectId !== projectId) fail(`flightTask.recordSha256 ${task.sha256} is not a flight task of this project`);
    if (task.record.name !== payload.flightTask.name) fail(`flightTask.name must be the name of stored version ${task.sha256}`);
    if (!same(task.record.payload, payload.flightTask.definition)) fail(`flightTask.definition must be the definition of stored version ${task.sha256}`);
  }
  // TASK-165: a repeat keeps every input of its parent, and a variant lists exactly the ones it changed.
  const lineage = payload.lineage;
  if (lineage.kind !== 'original') {
    const parentStored = await store.get(lineage.of);
    if (parentStored.record.kind !== 'experiment' || parentStored.record.projectId !== projectId) fail(`lineage.of ${lineage.of} is not an experiment of this project`);
    const changes = experimentChanges(readExperiment(parentStored), payload);
    if (lineage.kind === 'repeat' && changes.length > 0) fail(`a repeat keeps its parent's inputs, but these differ: ${changes.join(', ')}`);
    if (lineage.kind === 'variant' && !same(changes, lineage.changes)) {
      fail(`a variant must list the inputs it changed: ${changes.length > 0 ? changes.join(', ') : 'none, which is a repeat'}`);
    }
  }
  return store.createItem(projectId, 'experiment', { name: inputs.name, payload, dependencies: [stored.sha256] });
}

/**
 * The payload of a stored experiment version, schema 1 presented as schema 2.
 * The store applies validators only on writes and imports, so this validates
 * again, and checks that the record depends on exactly the profile version
 * the payload names.
 */
export function readExperiment(stored: StoredVersion): ExperimentPayload {
  const record = stored.record;
  if (record.kind !== 'experiment') throw new Error(`Record ${stored.sha256} is of kind ${record.kind}, not an experiment`);
  const payload = migrateExperiment(validateExperiment(record.payload));
  const [dependency, ...others] = record.dependencies;
  if (others.length > 0 || dependency?.kind !== 'aircraft-profile' || dependency.sha256 !== payload.profile.sha256) {
    fail(`experiment record ${stored.sha256} must depend on exactly the aircraft profile version ${payload.profile.sha256}`);
  }
  return payload;
}
