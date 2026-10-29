import type { ErrorSourceId } from '@mirage/autopilot/error-ownership';

// Sensor configuration schema 1 (TASK-143, S08): the S08 quantities of each
// sensor in SI units and Gauss, and the static field registry that names each
// field's unit, range, Ideal value and owner on the Phase 1 path (ArduPilot
// SITL as an external process, ownership path native-json, stock firmware
// under decision D-10). Pure data and types; configuration-time only.
//
// null means "not specified": the owner's default applies, which is stock
// ArduPilot SITL for ArduPilot-owned fields and "inject nothing" for
// MirageSITL-owned and unassigned fields.

export const SENSOR_CONFIGURATION_SCHEMA_VERSION = 1;
/** Field-to-owner mapping on native-json; 2 since TASK-147 added the schema 3 sources of the TASK-089 taxonomy. */
export const SENSOR_OWNERSHIP_MAPPING_VERSION = 2;
export type SensorPath = 'native-json';
export type SensorMode = 'ideal' | 'specified';
export const SENSOR_KINDS = ['imu', 'gnss', 'barometer', 'magnetometer', 'battery'] as const;
export type SensorKind = typeof SENSOR_KINDS[number];
export type Vector3 = readonly [number, number, number];
/** Sensor-to-body rotation R = Rz(yaw)·Ry(pitch)·Rx(roll), radians; v_sensor = Rᵀ·v_body. */
export type EulerZyxRad = readonly [roll: number, pitch: number, yaw: number];
export interface PresetReference { readonly catalogVersion: number; readonly id: string }

export interface ImuSettings {
  readonly preset: PresetReference | null;
  /** One-sided white-noise density per sensor axis. */
  readonly accelNoiseDensityMps2PerSqrtHz: number | null;
  readonly gyroNoiseDensityRadSPerSqrtHz: number | null;
  /** Constant bias in sensor axes. */
  readonly accelBiasMps2: Vector3 | null;
  readonly gyroBiasRadS: Vector3 | null;
  readonly latencyUs: number | null;
  /** Body FRD metres from the body reference point; null is at the CG (no lever arm). */
  readonly positionBodyM: Vector3 | null;
  readonly orientationRad: EulerZyxRad | null;
}
export interface GnssSettings {
  readonly preset: PresetReference | null;
  readonly updateRateHz: number | null;
  /** 1σ position error per horizontal axis. */
  readonly horizontalSigmaM: number | null;
  readonly verticalSigmaM: number | null;
  /** 1σ velocity error per NED axis. */
  readonly velocitySigmaMps: number | null;
  readonly latencyUs: number | null;
}
export interface BarometerSettings {
  readonly preset: PresetReference | null;
  /** 1σ pressure noise per sample. */
  readonly noiseRmsPa: number | null;
  /** Constant pressure offset; positive reads a higher pressure. */
  readonly biasPa: number | null;
  readonly latencyUs: number | null;
}
export interface MagnetometerSettings {
  readonly preset: PresetReference | null;
  /** 1σ field noise per axis. */
  readonly noiseRmsGauss: number | null;
  /** Net hard-iron error that the autopilot sees after its own COMPASS_OFS, in sensor axes. */
  readonly biasGauss: Vector3 | null;
  readonly positionBodyM: Vector3 | null;
  readonly orientationRad: EulerZyxRad | null;
}
/** measured = (1 + gain error)·true + offset + noise */
export interface BatterySensingSettings {
  readonly preset: PresetReference | null;
  readonly voltageGainError: number | null;
  readonly voltageOffsetV: number | null;
  readonly voltageNoiseRmsV: number | null;
  readonly currentGainError: number | null;
  readonly currentOffsetA: number | null;
  readonly currentNoiseRmsA: number | null;
}
export interface SensorConfiguration {
  readonly schemaVersion: 1;
  readonly mode: SensorMode;
  readonly imu: ImuSettings;
  readonly gnss: GnssSettings;
  readonly barometer: BarometerSettings;
  readonly magnetometer: MagnetometerSettings;
  readonly battery: BatterySensingSettings;
}

export type SensorFieldPath =
  | 'imu.accelNoiseDensityMps2PerSqrtHz' | 'imu.gyroNoiseDensityRadSPerSqrtHz' | 'imu.accelBiasMps2'
  | 'imu.gyroBiasRadS' | 'imu.latencyUs' | 'imu.positionBodyM' | 'imu.orientationRad'
  | 'gnss.updateRateHz' | 'gnss.horizontalSigmaM' | 'gnss.verticalSigmaM' | 'gnss.velocitySigmaMps' | 'gnss.latencyUs'
  | 'barometer.noiseRmsPa' | 'barometer.biasPa' | 'barometer.latencyUs'
  | 'magnetometer.noiseRmsGauss' | 'magnetometer.biasGauss' | 'magnetometer.positionBodyM' | 'magnetometer.orientationRad'
  | 'battery.voltageGainError' | 'battery.voltageOffsetV' | 'battery.voltageNoiseRmsV'
  | 'battery.currentGainError' | 'battery.currentOffsetA' | 'battery.currentNoiseRmsA';
export type FieldOwner = 'ardupilot' | 'mirage' | 'unassigned';
export type FieldValue = number | readonly number[];
export type FieldShape = 'scalar' | 'integer' | 'vector3' | 'euler';
export type ExclusionBasis = 'validator' | 'semantics' | 'policy';
export interface ExcludedOwner {
  readonly owner: 'ardupilot' | 'mirage';
  /** validator: validateOwnershipMatrix rejects it; semantics: admitted, but the owner's model is another quantity; policy: not chosen for Phase 1. */
  readonly basis: ExclusionBasis;
  readonly reason: string;
}
/** A display unit: si = (display·siNumerator)/siDenominator, so degrees convert as (deg·π)/180. */
export interface DisplayUnit { readonly unit: string; readonly siNumerator: number; readonly siDenominator: number }
export interface SensorFieldSpec {
  readonly path: SensorFieldPath;
  readonly sensor: SensorKind;
  readonly key: string;
  readonly label: string;
  readonly siUnit: string;
  readonly display: DisplayUnit;
  readonly shape: FieldShape;
  /** Per component; euler bounds are fixed by the shape. */
  readonly minimum: number;
  readonly maximum: number;
  readonly exclusiveMinimum: boolean;
  /** Where the range comes from. */
  readonly rangeBasis: string;
  /** False only for the GNSS update rate, which is a setting, not an error. */
  readonly isError: boolean;
  /** The Ideal value of an error: zero, a zero vector, or no lever arm. */
  readonly neutral: number | readonly number[] | 'at-cg' | null;
  readonly source: ErrorSourceId | null;
  readonly owner: FieldOwner;
  readonly excludedOwners: readonly ExcludedOwner[];
  /** Pinned-catalog parameters the ArduPilot owner writes or TASK-089 neutralizes; n stands for each instance. */
  readonly ardupilotParameters: readonly string[];
  readonly applicable: boolean;
  /** Required exactly when the field is not applicable; names the task that will deliver it. */
  readonly disabledReason: string | null;
  /** The owner applies the value in steps of this many microseconds, or null. */
  readonly stepUs: number | null;
  /** A preset may fill this field. */
  readonly presettable: boolean;
}

const SI: DisplayUnit = { unit: '', siNumerator: 1, siDenominator: 1 };
const unit = (name: string, siNumerator = 1, siDenominator = 1): DisplayUnit => ({ unit: name, siNumerator, siDenominator });
const STANDARD_GRAVITY = 9.80665;
const DEGREES = unit('°', Math.PI, 180);
const MILLISECONDS = unit('ms', 1000, 1);
const MILLIGAUSS = unit('mG', 1, 1000);

const NO_DELIVERY = 'No repository-evidenced path carries this error on the native-json path.';
const NO_BATTERY_ERROR: ExcludedOwner = { owner: 'ardupilot', basis: 'validator',
  reason: 'The SITL analog battery chain divides and multiplies by the same scale, so ArduPilot applies no measurement error to the battery values it receives.' };
const GNSS_POLICY: ExcludedOwner = { owner: 'mirage', basis: 'policy', reason: 'Phase 1 keeps ArduPilot\'s own GNSS receiver; GPS_INPUT arrives at wall-clock times, not in lockstep, and TASK-117 (the GNSS error model) is deferred.' };
const vectorParameters = (prefix: string, suffix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${i + 1}_${suffix}`);

type Base = Omit<SensorFieldSpec, 'path' | 'sensor' | 'key'>;
function field(path: SensorFieldPath, base: Base): SensorFieldSpec {
  const [sensor = '', key = ''] = path.split('.');
  const kind = SENSOR_KINDS.find(item => item === sensor);
  if (!kind) throw new Error(`Unknown sensor in ${path}`);
  return { path, sensor: kind, key, ...base };
}
const locked = (reason: string) => ({ applicable: false, disabledReason: reason, presettable: false });
const open = { applicable: true, disabledReason: null };

/** The 25 fields of sensor configuration schema 1, in schema order. */
export const SENSOR_FIELDS: readonly SensorFieldSpec[] = deepFreeze([
  field('imu.accelNoiseDensityMps2PerSqrtHz', {
    label: 'Accelerometer noise density', siUnit: 'm/s²/√Hz', display: unit('µg/√Hz', STANDARD_GRAVITY, 1e6), shape: 'scalar',
    minimum: 0, maximum: 0.01, exclusiveMinimum: false, rangeBasis: 'At most 0.01 m/s²/√Hz (about 1 mg/√Hz), four times the noisiest IMU of the sensor catalog (ICM-20649, 250 µg/√Hz).',
    isError: true, neutral: 0, source: 'imu.accel.noise', owner: 'mirage',
    excludedOwners: [{ owner: 'ardupilot', basis: 'semantics', reason: 'SIM_ACCn_RND scales only the SIM_VIB_* vibration terms, so ArduPilot has no white accelerometer noise of a given density.' }],
    ardupilotParameters: vectorParameters('SIM_ACC', 'RND', 5), stepUs: null, presettable: true, ...open,
  }),
  field('imu.gyroNoiseDensityRadSPerSqrtHz', {
    label: 'Gyroscope noise density', siUnit: 'rad/s/√Hz', display: unit('mdps/√Hz', Math.PI, 180000), shape: 'scalar',
    minimum: 0, maximum: 0.001, exclusiveMinimum: false, rangeBasis: 'At most 1e-3 rad/s/√Hz (about 57 mdps/√Hz), three times the noisiest gyroscope of the sensor catalog (ICM-20649, 17.5 mdps/√Hz).',
    isError: true, neutral: 0, source: 'imu.gyro.noise', owner: 'mirage',
    excludedOwners: [{ owner: 'ardupilot', basis: 'semantics', reason: 'SIM_GYRn_RND is throttle-scaled uniform noise drawn from an unseeded generator, not a seeded white noise of a given density.' }],
    ardupilotParameters: vectorParameters('SIM_GYR', 'RND', 5), stepUs: null, presettable: true, ...open,
  }),
  field('imu.accelBiasMps2', {
    label: 'Accelerometer bias', siUnit: 'm/s²', display: unit('mg', STANDARD_GRAVITY, 1000), shape: 'vector3',
    minimum: -2, maximum: 2, exclusiveMinimum: false, rangeBasis: 'At most ±2 m/s² (about ±204 mg) per axis, four times the largest turn-on bias of the sensor catalog (ICM-20649, ±50 mg).',
    isError: true, neutral: [0, 0, 0], source: 'imu.accel.bias', owner: 'mirage',
    excludedOwners: [{ owner: 'ardupilot', basis: 'policy', reason: 'MirageSITL applies every IMU error in one model on the JSON IMU vectors, so bias, noise and lever arm compose in one place.' }],
    ardupilotParameters: vectorParameters('SIM_ACC', 'BIAS', 5), stepUs: null, presettable: false, ...open,
  }),
  field('imu.gyroBiasRadS', {
    label: 'Gyroscope bias', siUnit: 'rad/s', display: unit('°/s', Math.PI, 180), shape: 'vector3',
    minimum: -0.2, maximum: 0.2, exclusiveMinimum: false, rangeBasis: 'At most ±0.2 rad/s (about ±11.5 °/s) per axis, twice the largest turn-on bias of the sensor catalog (ICM-20649, ±5 °/s).',
    isError: true, neutral: [0, 0, 0], source: 'imu.gyro.bias', owner: 'mirage',
    excludedOwners: [{ owner: 'ardupilot', basis: 'policy', reason: 'MirageSITL applies every IMU error in one model on the JSON IMU vectors, so bias, noise and lever arm compose in one place.' }],
    ardupilotParameters: vectorParameters('SIM_GYR', 'BIAS', 5), stepUs: null, presettable: false, ...open,
  }),
  field('imu.latencyUs', {
    label: 'IMU latency', siUnit: 'µs', display: MILLISECONDS, shape: 'integer',
    minimum: 0, maximum: 100000, exclusiveMinimum: false, rangeBasis: 'At most 100 ms, far beyond any IMU delivery delay.',
    isError: true, neutral: 0, source: 'imu.latency', owner: 'mirage',
    excludedOwners: [{ owner: 'ardupilot', basis: 'validator', reason: 'ArduPilot SITL has no IMU delay.' }],
    ardupilotParameters: [], stepUs: null, presettable: false, ...open,
  }),
  field('imu.positionBodyM', {
    label: 'IMU position', siUnit: 'm', display: SI, shape: 'vector3',
    minimum: -2, maximum: 2, exclusiveMinimum: false, rangeBasis: 'At most ±2 m from the body reference point per axis, beyond the size of a Phase 1 multirotor.',
    isError: true, neutral: 'at-cg', source: 'imu.lever-arm', owner: 'mirage',
    excludedOwners: [{ owner: 'ardupilot', basis: 'semantics', reason: 'SIM_IMU_POS lacks the angular-acceleration term ω̇×r on the JSON backend, which never sets the angular acceleration.' }],
    ardupilotParameters: ['SIM_IMU_POS'], stepUs: null, presettable: false, ...open,
  }),
  field('imu.orientationRad', {
    label: 'IMU orientation', siUnit: 'rad', display: DEGREES, shape: 'euler',
    minimum: -Math.PI, maximum: Math.PI, exclusiveMinimum: true, rangeBasis: 'Roll and yaw in (-180°, 180°], pitch in [-90°, 90°].',
    isError: true, neutral: [0, 0, 0], source: 'imu.misalignment', owner: 'mirage',
    excludedOwners: [{ owner: 'ardupilot', basis: 'semantics', reason: 'SIM_IMU_ORIENT takes only ArduPilot\'s discrete 45° rotations, so it cannot apply a small misalignment.' }],
    ardupilotParameters: ['SIM_IMU_ORIENT'], stepUs: null, presettable: false, ...open,
  }),
  field('gnss.updateRateHz', {
    label: 'GNSS update rate', siUnit: 'Hz', display: SI, shape: 'integer',
    minimum: 1, maximum: 20, exclusiveMinimum: false, rangeBasis: '1 to 20 Hz, the navigation rates of the receivers in the sensor catalog.',
    isError: false, neutral: null, source: 'gnss.receiver', owner: 'ardupilot', excludedOwners: [GNSS_POLICY],
    ardupilotParameters: ['SIM_GPS1_HZ', 'SIM_GPS2_HZ'], stepUs: null, presettable: false, ...open,
  }),
  field('gnss.horizontalSigmaM', {
    label: 'GNSS horizontal position error (1σ per axis)', siUnit: 'm', display: SI, shape: 'scalar',
    minimum: 0, maximum: 100, exclusiveMinimum: false, rangeBasis: 'At most 100 m.',
    isError: true, neutral: 0, source: 'gnss.position-noise', owner: 'ardupilot', excludedOwners: [GNSS_POLICY],
    ardupilotParameters: ['SIM_GPS1_HNSE', 'SIM_GPS2_HNSE'], stepUs: null, presettable: true, ...open,
  }),
  field('gnss.verticalSigmaM', {
    label: 'GNSS vertical position error (1σ)', siUnit: 'm', display: SI, shape: 'scalar',
    minimum: 0, maximum: 100, exclusiveMinimum: false, rangeBasis: 'At most 100 m.',
    isError: true, neutral: 0, source: 'gnss.position-noise', owner: 'ardupilot', excludedOwners: [GNSS_POLICY],
    ardupilotParameters: ['SIM_GPS1_NOISE', 'SIM_GPS2_NOISE'], stepUs: null, presettable: true, ...open,
  }),
  field('gnss.velocitySigmaMps', {
    label: 'GNSS velocity error (1σ per axis)', siUnit: 'm/s', display: SI, shape: 'scalar',
    minimum: 0, maximum: 10, exclusiveMinimum: false, rangeBasis: 'At most 10 m/s.',
    isError: true, neutral: 0, source: 'gnss.velocity-noise', owner: 'ardupilot', excludedOwners: [GNSS_POLICY],
    ardupilotParameters: ['SIM_GPS1_VERR', 'SIM_GPS2_VERR'], stepUs: null, presettable: true, ...open,
  }),
  field('gnss.latencyUs', {
    label: 'GNSS latency', siUnit: 'µs', display: MILLISECONDS, shape: 'integer',
    minimum: 0, maximum: 1000000, exclusiveMinimum: false, rangeBasis: 'At most 1 s.',
    isError: true, neutral: 0, source: 'gnss.delay', owner: 'ardupilot', excludedOwners: [GNSS_POLICY],
    ardupilotParameters: ['SIM_GPS1_LAG_MS', 'SIM_GPS2_LAG_MS'], stepUs: 1000, presettable: false, ...open,
  }),
  field('barometer.noiseRmsPa', {
    label: 'Barometer noise (1σ)', siUnit: 'Pa', display: SI, shape: 'scalar',
    minimum: 0, maximum: 50, exclusiveMinimum: false, rangeBasis: 'At most 50 Pa, about seven times the noisiest barometer setting of the sensor catalog (BMP388 at ×1 oversampling, 6.6 Pa).',
    isError: true, neutral: 0, source: 'baro.noise', owner: 'ardupilot',
    excludedOwners: [{ owner: 'mirage', basis: 'validator', reason: NO_DELIVERY }],
    ardupilotParameters: ['SIM_BARO_RND', 'SIM_BAR2_RND', 'SIM_BAR3_RND'], stepUs: null, presettable: true, ...open,
  }),
  field('barometer.biasPa', {
    label: 'Barometer bias', siUnit: 'Pa', display: SI, shape: 'scalar',
    minimum: -500, maximum: 500, exclusiveMinimum: false, rangeBasis: 'At most ±500 Pa, beyond the largest absolute accuracy of the sensor catalog (MS5611, ±150 Pa).',
    isError: true, neutral: 0, source: 'baro.glitch', owner: 'ardupilot',
    excludedOwners: [{ owner: 'mirage', basis: 'validator', reason: NO_DELIVERY }],
    ardupilotParameters: ['SIM_BARO_GLITCH', 'SIM_BAR2_GLITCH', 'SIM_BAR3_GLITCH'], stepUs: null, presettable: false, ...open,
  }),
  field('barometer.latencyUs', {
    label: 'Barometer latency', siUnit: 'µs', display: MILLISECONDS, shape: 'integer',
    minimum: 0, maximum: 490000, exclusiveMinimum: false, rangeBasis: 'At most 490 ms: SITL keeps 50 barometer samples 10 ms apart, so a longer SIM_BARO_DELAY is not applied as set.',
    isError: true, neutral: 0, source: 'baro.delay', owner: 'ardupilot',
    excludedOwners: [{ owner: 'mirage', basis: 'validator', reason: NO_DELIVERY }],
    ardupilotParameters: ['SIM_BARO_DELAY', 'SIM_BAR2_DELAY', 'SIM_BAR3_DELAY'], stepUs: 1000, presettable: false, ...open,
  }),
  field('magnetometer.noiseRmsGauss', {
    label: 'Magnetometer noise (1σ per axis)', siUnit: 'G', display: MILLIGAUSS, shape: 'scalar',
    minimum: 0, maximum: 0.1, exclusiveMinimum: false, rangeBasis: 'At most 0.1 G (100 mG), about twenty times the noisiest magnetometer of the sensor catalog.',
    isError: true, neutral: 0, source: 'mag.noise', owner: 'ardupilot',
    excludedOwners: [{ owner: 'mirage', basis: 'validator', reason: NO_DELIVERY }],
    ardupilotParameters: ['SIM_MAG_RND'], stepUs: null, presettable: true, ...open,
  }),
  field('magnetometer.biasGauss', {
    label: 'Magnetometer bias (hard iron)', siUnit: 'G', display: MILLIGAUSS, shape: 'vector3',
    minimum: -0.4, maximum: 0.4, exclusiveMinimum: false, rangeBasis: 'At most ±0.4 G (±400 mG) per axis, the documented range of ArduPilot\'s COMPASS_OFS.',
    isError: true, neutral: [0, 0, 0], source: 'mag.hard-iron', owner: 'ardupilot',
    excludedOwners: [{ owner: 'mirage', basis: 'policy', reason: 'Its native path is a run-time PARAM_SET of ArduPilot\'s own SIM_MAGn_OFS, reserved for S09 magnetic interference (TASK-169).' }],
    ardupilotParameters: vectorParameters('SIM_MAG', 'OFS', 3), stepUs: null, presettable: false, ...open,
  }),
  field('magnetometer.positionBodyM', {
    label: 'Magnetometer position', siUnit: 'm', display: SI, shape: 'vector3',
    minimum: -2, maximum: 2, exclusiveMinimum: false, rangeBasis: 'At most ±2 m from the body reference point per axis.',
    isError: true, neutral: 'at-cg', source: null, owner: 'unassigned', excludedOwners: [], ardupilotParameters: [], stepUs: null,
    ...locked('A uniform Earth field reads the same anywhere on the airframe; only motor and wiring fields depend on the position, and neither owner models them by position (SIM_MAG_MOT is per ampere). No source carries it.'),
  }),
  field('magnetometer.orientationRad', {
    label: 'Magnetometer orientation', siUnit: 'rad', display: DEGREES, shape: 'euler',
    minimum: -Math.PI, maximum: Math.PI, exclusiveMinimum: true, rangeBasis: 'Roll and yaw in (-180°, 180°], pitch in [-90°, 90°].',
    isError: true, neutral: [0, 0, 0], source: 'mag.misalignment', owner: 'ardupilot',
    excludedOwners: [{ owner: 'mirage', basis: 'validator', reason: NO_DELIVERY }],
    ardupilotParameters: ['SIM_MAG1_ORIENT', 'SIM_MAG2_ORIENT', 'SIM_MAG3_ORIENT'], stepUs: null,
    ...locked('SIM_MAGn_ORIENT takes only ArduPilot\'s discrete 45° rotations, and MirageSITL delivers no magnetometer data on native-json; a small misalignment needs a firmware change (decision D-10).'),
  }),
  ...([
    ['battery.voltageGainError', 'Voltage gain error', '1', -0.1, 0.1, 'At most ±10 %.', 'battery.voltage', false],
    ['battery.voltageOffsetV', 'Voltage offset', 'V', -2, 2, 'At most ±2 V.', 'battery.voltage', false],
    ['battery.voltageNoiseRmsV', 'Voltage noise (1σ)', 'V', 0, 1, 'At most 1 V.', 'battery.voltage', true],
    ['battery.currentGainError', 'Current gain error', '1', -0.2, 0.2, 'At most ±20 %.', 'battery.current', false],
    ['battery.currentOffsetA', 'Current offset', 'A', -20, 20, 'At most ±20 A.', 'battery.current', false],
    ['battery.currentNoiseRmsA', 'Current noise (1σ)', 'A', 0, 10, 'At most 10 A.', 'battery.current', true],
  ] as const).map(([path, label, siUnit, minimum, maximum, rangeBasis, source, presettable]) => field(path, {
    label, siUnit, display: SI, shape: 'scalar', minimum, maximum, exclusiveMinimum: false, rangeBasis,
    isError: true, neutral: 0, source, owner: 'mirage', excludedOwners: [NO_BATTERY_ERROR], ardupilotParameters: [], stepUs: null,
    presettable, ...open,
  })),
]);

/** ArduPilot defaults: specified mode with nothing specified. Stored in a profile as null. */
export const DEFAULT_SENSOR_CONFIGURATION: SensorConfiguration = deepFreeze({
  schemaVersion: 1, mode: 'specified',
  imu: { preset: null, accelNoiseDensityMps2PerSqrtHz: null, gyroNoiseDensityRadSPerSqrtHz: null, accelBiasMps2: null, gyroBiasRadS: null,
    latencyUs: null, positionBodyM: null, orientationRad: null },
  gnss: { preset: null, updateRateHz: null, horizontalSigmaM: null, verticalSigmaM: null, velocitySigmaMps: null, latencyUs: null },
  barometer: { preset: null, noiseRmsPa: null, biasPa: null, latencyUs: null },
  magnetometer: { preset: null, noiseRmsGauss: null, biasGauss: null, positionBodyM: null, orientationRad: null },
  battery: { preset: null, voltageGainError: null, voltageOffsetV: null, voltageNoiseRmsV: null, currentGainError: null,
    currentOffsetA: null, currentNoiseRmsA: null },
});

/** ArduPilot terms of the IMU that no setting changes on stock firmware; shown read-only. */
export interface FixedArduPilotRow { readonly id: 'imu-accel-noise-floor' | 'imu-gyro-noise-floor' | 'imu-sample-rates'; readonly label: string; readonly text: string }
export const FIXED_ARDUPILOT_ROWS: readonly FixedArduPilotRow[] = deepFreeze([
  { id: 'imu-accel-noise-floor', label: 'Accelerometer noise floor', text: 'Uniform noise of up to ±0.01 m/s² per axis on every sample (σ = 5.77×10⁻³ m/s²).' },
  { id: 'imu-gyro-noise-floor', label: 'Gyroscope noise floor', text: 'Uniform noise of up to ±0.04 °/s per axis on every sample (σ = 4.03×10⁻⁴ rad/s), added twice while the motors are stopped.' },
  { id: 'imu-sample-rates', label: 'IMU sample rates', text: 'IMU 1 at 1000 Hz and IMU 2 at 760 Hz (gyro) and 800 Hz (accelerometer), compiled into ArduPilot SITL.' },
]);

/** TASK-089 sources without an S08 field: ArduPilot stock in specified mode, switched off in Ideal. */
export const OTHER_ARDUPILOT_TERMS: readonly { readonly source: ErrorSourceId; readonly label: string; readonly stock: string }[] = deepFreeze([
  { source: 'imu.accel.scale', label: 'Accelerometer scale factor (SIM_ACCn_SCAL)', stock: 'none' },
  { source: 'imu.gyro.scale', label: 'Gyroscope scale factor (SIM_GYRn_SCALE)', stock: 'none' },
  { source: 'imu.gyro.drift', label: 'Gyroscope drift (SIM_DRIFT_SPEED)', stock: '0.05 °/s per minute, a triangle wave peaking at 0.25 °/s' },
  { source: 'imu.vibration', label: 'Vibration (SIM_VIB_FREQ, SIM_VIB_MOT_MAX)', stock: 'none' },
  { source: 'imu.board-trim', label: 'Board trim (SIM_BRD_TRIM)', stock: 'none' },
  { source: 'baro.drift', label: 'Barometer drift (SIM_BAROn_DRIFT)', stock: 'none' },
  { source: 'baro.wind', label: 'Barometer wind error (SIM_BAROn_WCF_*)', stock: 'none' },
  { source: 'baro.ground-effect', label: 'Barometer ground effect (SIM_BAROn_GEFF_M)', stock: 'none' },
  { source: 'mag.soft-iron', label: 'Magnetometer soft iron and scaling (SIM_MAGn_DIA, _ODI, _SCALING)', stock: 'none' },
  { source: 'mag.delay', label: 'Magnetometer delay (SIM_MAG_DELAY)', stock: 'none' },
  { source: 'mag.anomaly', label: 'Magnetic anomaly (SIM_MAG_ALY)', stock: 'none' },
  { source: 'mag.motor', label: 'Motor-current interference (SIM_MAG_MOT)', stock: 'none' },
]);

export function sensorField(path: SensorFieldPath): SensorFieldSpec {
  const spec = SENSOR_FIELDS.find(item => item.path === path);
  if (!spec) throw new Error(`Unknown sensor field ${path}`);
  return spec;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
