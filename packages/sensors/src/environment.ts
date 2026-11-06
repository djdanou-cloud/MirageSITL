// Effective geographic conditions of a location (TASK-148): what the calculation uses there.
// Cold configuration code: it validates its inputs and allocates freely; sessions copy the
// numbers into their own preallocated state.
//
// Heights: the user gives the ground elevation above mean sea level H; the geoid gives the
// undulation N, and the ellipsoidal height is h = H + N. Gravity and the magnetic field are
// evaluated at h. Without an authoritative geoid N = 0, the MSL gate stays blocked and the
// record says so. The air at the ground comes from TASK-093's `airAtOrigin`: the ISA lapse
// from a sea-level pressure (standard 101325 Pa, or a measured QNH) and a temperature offset,
// with the elevation taken as geopotential height, as the ISA formula defines it.
import { airAtOrigin, atmosphereFromState } from '@mirage/physics/atmosphere';
import { FIELD, type WorldMagneticModel } from './geomagnetic.ts';
import { mslAccuracyGate, type GeoidModel } from './geoid.ts';
import { normalGravityMps2 } from './gravity.ts';

const DEG = Math.PI / 180;
/** Standard sea-level pressure, Pa (ISA). */
export const STANDARD_SEA_LEVEL_PRESSURE_PA = 101325;
/** Declared input envelope: ArduPilot's home altitude range, recorded sea-level pressure extremes and ±50 K. */
export const LOCATION_ENVELOPE = Object.freeze({
  minElevationM: -500, maxElevationM: 9000, minSeaLevelPressurePa: 87000, maxSeaLevelPressurePa: 108500, maxTemperatureOffsetK: 50,
});
/** WMM technical report: H below 2000 nT is the blackout zone, below 6000 nT the caution zone. */
export const WMM_BLACKOUT_NT = 2000, WMM_CAUTION_NT = 6000;

export interface LocationInput {
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  /** Ground elevation above mean sea level at the origin, m. */
  readonly groundElevationMslM: number;
  /** Decimal year of the flight, inside the WMM2025 validity. */
  readonly decimalYear: number;
  /** Measured sea-level pressure (QNH), Pa; omitted for the ISA standard. */
  readonly measuredQnhPa?: number;
  /** ISA temperature offset, K; 0 for the standard atmosphere. */
  readonly temperatureOffsetK?: number;
}

/** The conditions a location gives the calculation, as shown and recorded. Angles in degrees, field in nT. */
export interface EffectiveConditions {
  readonly schemaVersion: 1;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly groundElevationMslM: number;
  readonly geoid:
    | { readonly status: 'AVAILABLE'; readonly model: string; readonly sha256: string; readonly undulationM: number }
    | { readonly status: 'BLOCKED_EXTERNAL'; readonly reason: string; readonly undulationM: 0 };
  readonly ellipsoidalHeightM: number;
  readonly gravityMps2: number;
  readonly magnetic: {
    readonly model: string; readonly decimalYear: number;
    readonly northNt: number; readonly eastNt: number; readonly downNt: number;
    readonly horizontalNt: number; readonly totalNt: number; readonly declinationDeg: number; readonly inclinationDeg: number;
    /** WMM zone of unreliable declination: 'blackout' below 2000 nT of H, 'caution' below 6000 nT. */
    readonly zone: 'normal' | 'caution' | 'blackout';
  };
  readonly air: {
    readonly seaLevelPressurePa: number; readonly seaLevelPressureSource: 'standard' | 'measured';
    readonly temperatureOffsetK: number; readonly temperatureK: number; readonly pressurePa: number; readonly densityKgM3: number;
  };
}

function finite(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be within ${min} to ${max}`);
  return value;
}

/** Decimal year of a UTC instant: year + elapsed fraction of that year (the WMM convention). */
export function decimalYearOf(date: Date): number {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new Error('Invalid date');
  const year = date.getUTCFullYear(), start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
  return year + (ms - start) / (end - start);
}

/** The effective conditions at a location, from the geoid and magnetic models given. */
export function effectiveConditions(input: LocationInput, models: { readonly geoid: GeoidModel; readonly magnetic: WorldMagneticModel }): EffectiveConditions {
  const env = LOCATION_ENVELOPE;
  // Off the poles, where the WMM's east component is singular.
  const latitudeDeg = finite(input.latitudeDeg, 'Latitude', -89.9, 89.9), longitudeDeg = finite(input.longitudeDeg, 'Longitude', -180, 180);
  const elevation = finite(input.groundElevationMslM, 'Ground elevation', env.minElevationM, env.maxElevationM);
  const measured = input.measuredQnhPa;
  const seaLevelPressurePa = measured === undefined ? STANDARD_SEA_LEVEL_PRESSURE_PA
    : finite(measured, 'Measured QNH', env.minSeaLevelPressurePa, env.maxSeaLevelPressurePa);
  const temperatureOffsetK = finite(input.temperatureOffsetK ?? 0, 'Temperature offset', -env.maxTemperatureOffsetK, env.maxTemperatureOffsetK);
  const lat = latitudeDeg * DEG, lon = longitudeDeg * DEG;
  const gate = mslAccuracyGate(models.geoid);
  const undulationM = gate.status === 'AVAILABLE' ? models.geoid.undulationM(lat, lon) : 0;
  const h = elevation + undulationM;
  const field = new Float64Array(FIELD.count);
  models.magnetic.fieldInto(lat, lon, h, input.decimalYear, field);
  const air = airAtOrigin(seaLevelPressurePa, temperatureOffsetK, elevation);
  const state = atmosphereFromState({ temperatureK: air.temperatureK, pressurePa: air.pressurePa });
  const horizontal = field[FIELD.horizontalNt] ?? Number.NaN;
  return Object.freeze({
    schemaVersion: 1, latitudeDeg, longitudeDeg, groundElevationMslM: elevation,
    geoid: gate.status === 'AVAILABLE'
      ? Object.freeze({ status: 'AVAILABLE', model: gate.model, sha256: gate.sha256, undulationM })
      : Object.freeze({ status: 'BLOCKED_EXTERNAL', reason: gate.reason, undulationM: 0 }),
    ellipsoidalHeightM: h,
    gravityMps2: normalGravityMps2(lat, h),
    magnetic: Object.freeze({
      model: models.magnetic.coefficients.name, decimalYear: input.decimalYear,
      northNt: field[FIELD.northNt] ?? Number.NaN, eastNt: field[FIELD.eastNt] ?? Number.NaN, downNt: field[FIELD.downNt] ?? Number.NaN,
      horizontalNt: horizontal, totalNt: field[FIELD.totalNt] ?? Number.NaN,
      declinationDeg: (field[FIELD.declinationRad] ?? Number.NaN) / DEG, inclinationDeg: (field[FIELD.inclinationRad] ?? Number.NaN) / DEG,
      zone: horizontal < WMM_BLACKOUT_NT ? 'blackout' : horizontal < WMM_CAUTION_NT ? 'caution' : 'normal',
    }),
    air: Object.freeze({
      seaLevelPressurePa, seaLevelPressureSource: measured === undefined ? 'standard' : 'measured', temperatureOffsetK,
      temperatureK: state.temperatureK, pressurePa: state.pressurePa, densityKgM3: state.densityKgM3,
    }),
  });
}

/** The magnetic field of the conditions in NED gauss, as `IdealSensors` takes it (1 gauss = 1e5 nT). */
export function magneticNedGauss(conditions: EffectiveConditions): [number, number, number] {
  const m = conditions.magnetic;
  return [m.northNt / 1e5, m.eastNt / 1e5, m.downNt / 1e5];
}
