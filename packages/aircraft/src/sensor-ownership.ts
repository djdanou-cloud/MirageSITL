import {
  DELIVERY_PATHS, ERROR_SOURCE_IDS, ERROR_SOURCES, type ErrorOwner, type ErrorSourceId, type OwnershipMatrix,
} from '@mirage/autopilot/error-ownership';
import type { StoredVersion } from '@mirage/project/schema';
import { readAircraftProfile } from './profile.ts';
import { readField } from './sensor-config.ts';
import {
  OTHER_ARDUPILOT_TERMS, SENSOR_FIELDS, SENSOR_KINDS, SENSOR_OWNERSHIP_MAPPING_VERSION, type FieldOwner, type FieldValue,
  type PresetReference, type SensorConfiguration, type SensorFieldPath, type SensorKind, type SensorPath,
} from './sensor-fields.ts';
import { findSensorPreset, presetCatalog, type PresetCitation } from './sensor-presets.ts';

// Sensor ownership mapping 1 (TASK-143): what each field of a sensor
// configuration means on the Phase 1 path, the TASK-089 ownership matrix it
// implies, the ArduPilot terms that Ideal cannot remove, and the frozen
// snapshot an experiment record embeds. TASK-147 applies the configuration at
// run time and validates the matrix against the pinned catalog before arming.

export type Effective =
  /** Specified mode, an applicable field with a value. */
  | { readonly kind: 'specified'; readonly value: FieldValue }
  /** A MirageSITL-owned field in Ideal: nothing is injected. */
  | { readonly kind: 'neutral'; readonly value: number | readonly number[] | 'at-cg' }
  /** An ArduPilot-owned field in Ideal: TASK-089 sets the neutral parameters. */
  | { readonly kind: 'neutralized' }
  /** ArduPilot's stock behaviour: no value given, a locked GNSS field, or the stock hard-iron pairing in Ideal. */
  | { readonly kind: 'ardupilot-stock' }
  /** Nothing applies it: a MirageSITL-owned field without a value, or a field without an owner. */
  | { readonly kind: 'not-applied' };
export interface ResolvedField {
  readonly path: SensorFieldPath;
  readonly owner: FieldOwner;
  readonly source: ErrorSourceId | null;
  readonly applicable: boolean;
  readonly reason: string | null;
  readonly stored: FieldValue | null;
  readonly effective: Effective;
}
export type ResidualId = 'imu-accel-noise-floor' | 'imu-gyro-noise-floor' | 'gnss-sitl-receiver' | 'mag-hard-iron-pairing'
  | 'ins-accel-calibration' | 'imu-sample-rates' | 'ekf-assumed-delays' | 'ardupilot-unseeded-noise' | 'ardupilot-stock-terms';
export interface Residual { readonly id: ResidualId; readonly text: string; readonly verified: boolean }
export type SensorState = 'ardupilot-defaults' | 'specified' | 'ideal';
export interface ResolvedSensorConfiguration {
  readonly mappingVersion: typeof SENSOR_OWNERSHIP_MAPPING_VERSION;
  readonly path: SensorPath;
  readonly state: SensorState;
  /** SENSOR_FIELDS order. */
  readonly fields: readonly ResolvedField[];
  /** What ArduPilot still adds that this configuration cannot remove. */
  readonly residuals: readonly ResidualId[];
}

/** The ArduPilot terms Ideal cannot remove on stock firmware (decision D-10), in the order the tab lists them. */
export const RESIDUALS: { readonly [id in ResidualId]: Residual } = Object.freeze({
  'imu-accel-noise-floor': { id: 'imu-accel-noise-floor', verified: true, text: 'ArduPilot adds uniform noise of up to ±0.01 m/s² to each accelerometer axis on every sample (σ = 5.77×10⁻³ m/s²). No ArduPilot parameter switches it off. MirageSITL runs stock ArduPilot (decision D-10: no imu-noise-floor patch), so Ideal sensors keep it.' },
  'imu-gyro-noise-floor': { id: 'imu-gyro-noise-floor', verified: true, text: 'ArduPilot adds uniform noise of up to ±0.04 °/s (±6.98×10⁻⁴ rad/s, σ = 4.03×10⁻⁴ rad/s) to each gyroscope axis on every sample, and adds it a second time while the motors are stopped and no vibration is configured. No ArduPilot parameter switches it off on stock ArduPilot (D-10), so Ideal sensors keep it.' },
  'gnss-sitl-receiver': { id: 'gnss-sitl-receiver', verified: true, text: 'ArduPilot\'s simulated GNSS receiver runs at 5 Hz with a 100 ms lag; the GNSS settings cannot be applied until TASK-147.' },
  'mag-hard-iron-pairing': { id: 'mag-hard-iron-pairing', verified: false, text: 'Ideal keeps ArduPilot\'s stock pairing of SIM_MAGn_OFS with COMPASS_OFSn, (5, 13, −18) mG on both sides, which cancels according to the SITL field equation; TASK-147 confirms it with a capture.' },
  'ins-accel-calibration': { id: 'ins-accel-calibration', verified: false, text: 'ArduPilot\'s copter and JSON defaults set INS_ACCOFFS 0.001 m/s² and INS_ACCSCAL 1.001, a calibration that the simulated accelerometer does not have.' },
  'imu-sample-rates': { id: 'imu-sample-rates', verified: true, text: 'IMU sample rates are compiled into ArduPilot SITL: IMU 1 at 1000 Hz, IMU 2 at 760 Hz (gyro) and 800 Hz (accelerometer).' },
  'ekf-assumed-delays': { id: 'ekf-assumed-delays', verified: true, text: 'The EKF assumes 60 ms barometer and magnetometer delays and a 120 ms GNSS delay, while SITL simulates 0 ms, 0 ms and 100 ms.' },
  'ardupilot-unseeded-noise': { id: 'ardupilot-unseeded-noise', verified: true, text: 'ArduPilot draws its noise from an unseeded generator, so ArduPilot-owned noise does not repeat between runs.' },
  'ardupilot-stock-terms': { id: 'ardupilot-stock-terms', verified: true, text: 'ArduPilot error terms without a value stay at their stock values, among them gyro drift SIM_DRIFT_SPEED 0.05 °/s per minute and second and third barometer noise SIM_BAR2_RND and SIM_BAR3_RND 0.2 m.' },
});
/** What ArduPilot still adds in Ideal mode, which the Sensors tab lists in every mode. */
export const IDEAL_RESIDUALS: readonly ResidualId[] = ['imu-accel-noise-floor', 'imu-gyro-noise-floor', 'gnss-sitl-receiver', 'mag-hard-iron-pairing',
  'ins-accel-calibration', 'imu-sample-rates', 'ekf-assumed-delays', 'ardupilot-unseeded-noise'];
const SPECIFIED_RESIDUALS: readonly ResidualId[] = ['imu-accel-noise-floor', 'imu-gyro-noise-floor', 'gnss-sitl-receiver', 'mag-hard-iron-pairing',
  'ins-accel-calibration', 'imu-sample-rates', 'ekf-assumed-delays', 'ardupilot-unseeded-noise', 'ardupilot-stock-terms'];

function stateOf(config: SensorConfiguration | null): SensorState {
  return config === null ? 'ardupilot-defaults' : config.mode === 'ideal' ? 'ideal' : 'specified';
}

/** Each field's owner and effective value. Ideal ignores the stored values and keeps them. */
export function resolveSensorConfiguration(config: SensorConfiguration | null): ResolvedSensorConfiguration {
  const state = stateOf(config);
  const fields = SENSOR_FIELDS.map((spec): ResolvedField => {
    const stored = config ? readField(config, spec.path) : null;
    let effective: Effective;
    if (spec.owner === 'unassigned') effective = { kind: 'not-applied' };
    else if (!spec.applicable) effective = { kind: 'ardupilot-stock' };
    else if (state === 'ideal') {
      if (spec.owner === 'mirage') effective = { kind: 'neutral', value: spec.neutral ?? 0 };
      // ArduPilot's stock hard-iron pairing is the net-neutral setting; TASK-089's neutral would leave COMPASS_OFS as an offset.
      else if (spec.source === 'mag.hard-iron') effective = { kind: 'ardupilot-stock' };
      else effective = { kind: 'neutralized' };
    } else if (stored !== null) effective = { kind: 'specified', value: stored };
    else effective = spec.owner === 'mirage' ? { kind: 'not-applied' } : { kind: 'ardupilot-stock' };
    return { path: spec.path, owner: spec.owner, source: spec.source, applicable: spec.applicable, reason: spec.disabledReason, stored, effective };
  });
  const residuals = state === 'ideal' ? IDEAL_RESIDUALS : SPECIFIED_RESIDUALS;
  return deepFreeze({ mappingVersion: SENSOR_OWNERSHIP_MAPPING_VERSION, path: 'native-json', state, fields, residuals });
}

/**
 * The TASK-089 ownership matrix of a configuration on native-json, for stock
 * firmware. The ArduPilot defaults equal imuNoiseFloorMatrix('ardupilot',
 * 'native-json'). A MirageSITL-owned source is 'mirage' only while its field
 * holds a value in specified mode. Ideal switches off every ArduPilot error a
 * parameter can switch off, except the stock hard-iron pairing; the IMU
 * floors and the GNSS receiver cannot be switched off.
 */
export function sensorOwnershipMatrix(config: SensorConfiguration | null): OwnershipMatrix {
  const resolved = resolveSensorConfiguration(config);
  const ownerOf = (source: ErrorSourceId): ErrorOwner => {
    if (resolved.state === 'ardupilot-defaults') return 'ardupilot';
    const fields = resolved.fields.filter(item => item.source === source);
    if (fields.some(item => item.effective.kind === 'specified' && item.owner === 'mirage')) return 'mirage';
    if (resolved.state === 'specified') return 'ardupilot';
    const definition = ERROR_SOURCES[source];
    if (definition.fixed || definition.neutralize.length === 0 || source === 'mag.hard-iron') return 'ardupilot';
    return 'none';
  };
  return deepFreeze({
    schemaVersion: 2, id: `sensors-${resolved.state}-native-json`, path: 'native-json', firmwarePatches: [],
    entries: ERROR_SOURCE_IDS.map(source => {
      const owner = ownerOf(source);
      const delivery = owner === 'mirage' ? ERROR_SOURCES[source].deliveries.filter(d => DELIVERY_PATHS[d].path === 'native-json') : [];
      return { source, owner, delivery };
    }),
  });
}

/** How each TASK-089 source without an S08 field behaves in a configuration. */
export function otherArduPilotTerms(config: SensorConfiguration | null): readonly { readonly source: ErrorSourceId; readonly label: string; readonly state: string }[] {
  const ideal = stateOf(config) === 'ideal';
  return OTHER_ARDUPILOT_TERMS.map(term => ({ source: term.source, label: term.label,
    state: ideal ? 'switched off in Ideal' : term.stock === 'none' ? 'ArduPilot default: none' : `ArduPilot default: ${term.stock}` }));
}

export const SENSOR_SNAPSHOT_VERSION = 1;
export interface SensorSnapshot {
  readonly schemaVersion: typeof SENSOR_SNAPSHOT_VERSION;
  readonly profileSha256: string;
  readonly mappingVersion: typeof SENSOR_OWNERSHIP_MAPPING_VERSION;
  /** The stored configuration; null is the ArduPilot defaults. */
  readonly configuration: SensorConfiguration | null;
  readonly resolution: ResolvedSensorConfiguration;
  readonly ownershipMatrix: OwnershipMatrix;
  readonly presets: readonly { readonly sensor: SensorKind; readonly reference: PresetReference; readonly citations: readonly PresetCitation[] }[];
}
/**
 * The sensor section an experiment record copies from its exact aircraft
 * profile version (TASK-154, TASK-165): the stored configuration, its
 * resolution, the ownership matrix and the sources of every referenced preset.
 */
export function sensorSnapshot(stored: StoredVersion): SensorSnapshot {
  const profile = readAircraftProfile(stored), configuration = profile.sensorConfiguration;
  const presets = configuration === null ? [] : SENSOR_KINDS.flatMap(sensor => {
    const reference = configuration[sensor].preset;
    if (reference === null) return [];
    const preset = findSensorPreset(reference), catalog = presetCatalog(reference.catalogVersion);
    const cited = new Set([...(preset?.values ?? []), ...(preset?.references ?? [])].map(item => item.citation));
    return [{ sensor, reference, citations: (catalog?.citations ?? []).filter(citation => cited.has(citation.id)) }];
  });
  return deepFreeze({
    schemaVersion: SENSOR_SNAPSHOT_VERSION, profileSha256: stored.sha256, mappingVersion: SENSOR_OWNERSHIP_MAPPING_VERSION,
    configuration, resolution: resolveSensorConfiguration(configuration), ownershipMatrix: sensorOwnershipMatrix(configuration), presets,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
