import {
  ERROR_SOURCE_IDS, ownershipParameterProfile, validateOwnershipMatrix, type ArduPilotCatalog, type OwnershipMatrix,
} from '@mirage/autopilot/error-ownership';
import { NEUTRAL_BATTERY_PLAN, NEUTRAL_IMU_PLAN, type BatteryErrorPlan, type ImuErrorPlan, type Vector3Tuple } from '@mirage/sensors/configured';
import { readField } from './sensor-config.ts';
import type { SensorConfiguration, SensorFieldPath, Vector3 } from './sensor-fields.ts';
import { RESIDUALS, resolveSensorConfiguration, sensorOwnershipMatrix, type Residual } from './sensor-ownership.ts';

// What an external-SITL session applies for a sensor configuration (TASK-147):
// the SITL parameters, generated from the validated TASK-089 matrix and the
// ArduPilot-owned values and read back before arming, and the plans of the
// MirageSITL-owned errors on the JSON state line. Configuration-time only.

export const SENSOR_PARAMETER_PROFILE_VERSION = 1;
/** COMPASS_OFS, COMPASS_OFS2 and COMPASS_OFS3 of the pinned copter.parm, mG; SITL's constructor sets SIM_MAGn_OFS to the same. */
const STOCK_OFFSET: Vector3 = Object.freeze([5, 13, -18] as const);
export const STOCK_COMPASS_OFFSETS_MILLIGAUSS: readonly Vector3[] = Object.freeze([STOCK_OFFSET, STOCK_OFFSET, STOCK_OFFSET]);
const BAROMETERS = ['SIM_BARO', 'SIM_BAR2', 'SIM_BAR3'] as const;
const RECEIVERS = ['SIM_GPS1', 'SIM_GPS2'] as const;
const AXES = ['X', 'Y', 'Z'] as const;

export interface SitlSensorContext {
  /** Home altitude above mean sea level, metres; sets the barometer's pressure-to-altitude gradient. */
  readonly homeAltitudeM: number;
  /** The vehicle's COMPASS_OFS, COMPASS_OFS2 and COMPASS_OFS3, mG. */
  readonly compassOffsetsMilliGauss: readonly Vector3[];
  /** The CG in body FRD from the body reference point, metres; an IMU position is a lever arm from it. */
  readonly cgBodyM: Vector3;
}
export interface SitlParameter { readonly name: string; readonly value: number }
export interface SensorRuntime {
  readonly matrix: OwnershipMatrix;
  /** Every SITL parameter the session writes, sorted by name; each is read back before arming. */
  readonly parameters: readonly SitlParameter[];
  /** The `.parm` text of the parameters. */
  readonly parameterProfile: string;
  readonly imu: ImuErrorPlan;
  readonly battery: BatteryErrorPlan;
  readonly residuals: readonly Residual[];
}

/** 1976 standard atmosphere constants of the pinned AP_Baro_atmosphere.cpp (troposphere). */
const ATMOSPHERE = Object.freeze({ radiusM: 6356766, rSpecific: 287.053072, gravity: 9.80665, t0K: 288.15, p0Pa: 101325, lapseKPerM: -6.5e-3 });
/**
 * dh/dp of ArduPilot's SITL barometer at a geometric altitude, m/Pa: the
 * pressure of geopotential height H = R·h/(R + h) falls as dp/dH = −p·g/(R_air·T),
 * and dH/dh = R²/(R + h)². Troposphere only (−5 km to 11 km).
 */
export function barometerAltitudePerPascal(altitudeM: number): number {
  if (!Number.isFinite(altitudeM) || altitudeM < -5000 || altitudeM > 11000) throw new Error('Home altitude must be within −5 km to 11 km');
  const { radiusM, rSpecific, gravity, t0K, p0Pa, lapseKPerM } = ATMOSPHERE;
  const geopotential = (radiusM * altitudeM) / (radiusM + altitudeM);
  const temperature = t0K + lapseKPerM * geopotential;
  const pressure = p0Pa * Math.pow(temperature / t0K, -gravity / (lapseKPerM * rSpecific));
  const dGeopotentialDAltitude = (radiusM * radiusM) / ((radiusM + altitudeM) * (radiusM + altitudeM));
  return -(rSpecific * temperature) / (pressure * gravity * dGeopotentialDAltitude);
}

function scalar(config: SensorConfiguration, path: SensorFieldPath): number | null {
  const value = readField(config, path);
  return typeof value === 'number' ? value : null;
}
function vector(config: SensorConfiguration, path: SensorFieldPath): Vector3Tuple | null {
  const value = readField(config, path);
  if (value === null) return null;
  if (typeof value === 'number' || value.length !== 3) throw new Error(`Sensor field ${path} is not a vector`);
  return [value[0]!, value[1]!, value[2]!];
}

/** ArduPilot-owned values of a configuration as SITL parameters (vector names expanded). */
function ardupilotValues(config: SensorConfiguration | null, context: SitlSensorContext): Map<string, number> {
  const values = new Map<string, number>();
  const offsets = context.compassOffsetsMilliGauss;
  if (offsets.length !== 3 || !offsets.every(v => v.length === 3 && v.every(Number.isFinite))) throw new Error('Three finite compass offsets are required');
  const compass = (bias: Vector3Tuple): void => offsets.forEach((offset, n) => AXES.forEach((axis, i) => {
    // The autopilot reads (field − SIM_MAGn_OFS) + COMPASS_OFSn, so this leaves a net error of b.
    values.set(`SIM_MAG${n + 1}_OFS_${axis}`, offset[i]! - 1000 * bias[i]!);
  }));
  if (config === null) return values;
  if (config.mode === 'ideal') {
    compass([0, 0, 0]);
    return values;
  }
  const gradient = barometerAltitudePerPascal(context.homeAltitudeM);
  const noise = scalar(config, 'barometer.noiseRmsPa'), bias = scalar(config, 'barometer.biasPa'), delay = scalar(config, 'barometer.latencyUs');
  for (const baro of BAROMETERS) {
    // SITL adds noise·rand_float() metres, uniform on [−1, 1): a half-width of √3·σ has standard deviation σ.
    if (noise !== null) values.set(`${baro}_RND`, Math.sqrt(3) * noise * Math.abs(gradient));
    // A pressure reading higher by b is an altitude lower by b·|dh/dp|.
    if (bias !== null) values.set(`${baro}_GLITCH`, bias * gradient);
    if (delay !== null) values.set(`${baro}_DELAY`, delay / 1000);
  }
  const magNoise = scalar(config, 'magnetometer.noiseRmsGauss'), magBias = vector(config, 'magnetometer.biasGauss');
  if (magNoise !== null) values.set('SIM_MAG_RND', Math.sqrt(3) * 1000 * magNoise);
  if (magBias !== null) compass(magBias);
  const rate = scalar(config, 'gnss.updateRateHz'), horizontal = scalar(config, 'gnss.horizontalSigmaM');
  const vertical = scalar(config, 'gnss.verticalSigmaM'), velocity = scalar(config, 'gnss.velocitySigmaMps'), lag = scalar(config, 'gnss.latencyUs');
  for (const receiver of RECEIVERS) {
    if (rate !== null) values.set(`${receiver}_HZ`, rate);
    // A circle of radius r gives r/√2 per horizontal axis; a sine of amplitude A gives A/√2.
    if (horizontal !== null) values.set(`${receiver}_HNSE`, Math.SQRT2 * horizontal);
    if (vertical !== null) values.set(`${receiver}_NOISE`, Math.SQRT2 * vertical);
    if (velocity !== null) for (const axis of AXES) values.set(`${receiver}_VERR_${axis}`, Math.sqrt(3) * velocity);
    if (lag !== null) values.set(`${receiver}_LAG_MS`, lag / 1000);
  }
  return values;
}

function imuPlan(config: SensorConfiguration | null, cg: Vector3): ImuErrorPlan {
  if (config === null || config.mode === 'ideal') return NEUTRAL_IMU_PLAN;
  const position = vector(config, 'imu.positionBodyM');
  const leverArm: Vector3Tuple | null = position ? [position[0] - cg[0], position[1] - cg[1], position[2] - cg[2]] : null;
  return Object.freeze({
    accelNoiseDensityMps2PerSqrtHz: scalar(config, 'imu.accelNoiseDensityMps2PerSqrtHz') ?? 0,
    gyroNoiseDensityRadSPerSqrtHz: scalar(config, 'imu.gyroNoiseDensityRadSPerSqrtHz') ?? 0,
    accelBiasMps2: vector(config, 'imu.accelBiasMps2') ?? NEUTRAL_IMU_PLAN.accelBiasMps2,
    gyroBiasRadS: vector(config, 'imu.gyroBiasRadS') ?? NEUTRAL_IMU_PLAN.gyroBiasRadS,
    latencyUs: scalar(config, 'imu.latencyUs') ?? 0,
    leverArmCgM: leverArm ?? NEUTRAL_IMU_PLAN.leverArmCgM,
    sensorToBodyRad: vector(config, 'imu.orientationRad') ?? NEUTRAL_IMU_PLAN.sensorToBodyRad,
  });
}
function batteryPlan(config: SensorConfiguration | null): BatteryErrorPlan {
  if (config === null || config.mode === 'ideal') return NEUTRAL_BATTERY_PLAN;
  return Object.freeze({
    voltageGainError: scalar(config, 'battery.voltageGainError') ?? 0, voltageOffsetV: scalar(config, 'battery.voltageOffsetV') ?? 0,
    voltageNoiseRmsV: scalar(config, 'battery.voltageNoiseRmsV') ?? 0, currentGainError: scalar(config, 'battery.currentGainError') ?? 0,
    currentOffsetA: scalar(config, 'battery.currentOffsetA') ?? 0, currentNoiseRmsA: scalar(config, 'battery.currentNoiseRmsA') ?? 0,
  });
}

/**
 * The parameters and error plans of a validated configuration (null is the
 * ArduPilot defaults). The matrix is validated against the pinned catalog; a
 * parameter the matrix neutralizes and a value written for the same name must
 * agree, or the call fails.
 */
export function sensorRuntime(config: SensorConfiguration | null, catalog: ArduPilotCatalog, context: SitlSensorContext): SensorRuntime {
  if (context.cgBodyM.length !== 3 || !context.cgBodyM.every(Number.isFinite)) throw new Error('A finite CG is required');
  const matrix = validateOwnershipMatrix(sensorOwnershipMatrix(config), catalog);
  if (matrix.entries.length !== ERROR_SOURCE_IDS.length) throw new Error('The sensor matrix must list every source');
  const values = new Map<string, number>();
  for (const line of ownershipParameterProfile(matrix, catalog).split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const [name = '', text = ''] = line.split(' ');
    values.set(name, Number(text));
  }
  for (const [name, value] of ardupilotValues(config, context)) {
    const prior = values.get(name);
    if (prior !== undefined && prior !== value) throw new Error(`Conflicting values for ${name}`);
    if (!Number.isFinite(value)) throw new Error(`Non-finite value for ${name}`);
    values.set(name, value);
  }
  const parameters = [...values.keys()].sort().map(name => Object.freeze({ name, value: values.get(name) ?? 0 }));
  const lines = [`# MirageSITL sensor parameters v${SENSOR_PARAMETER_PROFILE_VERSION}`,
    `# matrix ${matrix.id}; path ${matrix.path}; ArduPilot ${catalog.commit}; home ${String(context.homeAltitudeM)} m`,
    ...parameters.map(p => `${p.name} ${String(p.value)}`)];
  const resolved = resolveSensorConfiguration(config);
  return Object.freeze({
    matrix, parameters: Object.freeze(parameters), parameterProfile: lines.join('\n') + '\n',
    imu: imuPlan(config, context.cgBodyM), battery: batteryPlan(config),
    residuals: Object.freeze(resolved.residuals.map(id => RESIDUALS[id])),
  });
}
