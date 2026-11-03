/** Dry-air constants: ICAO ISA troposphere; Sutherland viscosity at 273.15 K. */
export interface Atmosphere {
  readonly temperatureK: number; readonly pressurePa: number; readonly densityKgM3: number;
  readonly dynamicViscosityPaS: number; readonly speedOfSoundMps: number;
}
const GAS_CONSTANT = 287.05287;
/** ICAO ISA troposphere: temperature lapse rate, K/m, standard gravity, m/s², and the ratio of specific heats of dry air. */
export const ISA_LAPSE_KPM = 0.0065;
const GRAVITY_MPS2 = 9.80665, GAMMA = 1.4;
/** ISA mean-sea-level temperature, K. */
export const ISA_SEA_LEVEL_K = 288.15;
/** Slots of atmosphereAtHeightInto's input: the air at a reference point and the height above it, m. */
export const AIR_REFERENCE_TEMPERATURE = 0, AIR_REFERENCE_PRESSURE = 1, AIR_HEIGHT = 2;
/** Slots of atmosphereAtHeightInto's output. */
export const AIR_DENSITY = 0, AIR_VISCOSITY = 1, AIR_SOUND = 2, AIR_TEMPERATURE = 3, AIR_PRESSURE = 4;
/**
 * Slots of a weather.set as SessionDynamics.setWeather reads it (TASK-093): the mean wind, NED m/s (the velocity of the
 * air mass), the gust RMS, m/s, and its uint32 seed, which Wind.configure reads in this order, then the air at the origin.
 */
export const WEATHER_WIND_NORTH = 0, WEATHER_WIND_EAST = 1, WEATHER_WIND_DOWN = 2, WEATHER_GUST_RMS = 3, WEATHER_SEED = 4,
  WEATHER_TEMPERATURE = 5, WEATHER_PRESSURE = 6, WEATHER_SLOTS = 7;
/**
 * The ISA troposphere `input[AIR_HEIGHT]` m above a reference point whose air temperature is
 * `input[AIR_REFERENCE_TEMPERATURE]` K and pressure `input[AIR_REFERENCE_PRESSURE]` Pa (TASK-093): T = T0 - L h,
 * p = p0 (1 - L h / T0)^(g / (R L)), rho = p / (R T), Sutherland viscosity and a = sqrt(gamma R T). Writes [density,
 * viscosity, speed of sound, temperature, pressure] into `out` (length >= 5) and returns false, writing nothing, outside
 * the envelope of atmosphereFromState. Allocation-free, for the physics step; the inputs come in an array (length >= 3)
 * because V8 can box a double call argument.
 */
export function atmosphereAtHeightInto(input: Float64Array, out: Float64Array): boolean {
  const referenceTemperatureK = input[AIR_REFERENCE_TEMPERATURE]!, temperatureK = referenceTemperatureK - ISA_LAPSE_KPM * input[AIR_HEIGHT]!;
  if (!(temperatureK >= 180 && temperatureK <= 330) || !(referenceTemperatureK > 0)) return false;
  const pressurePa = input[AIR_REFERENCE_PRESSURE]! * (temperatureK / referenceTemperatureK) ** (GRAVITY_MPS2 / (GAS_CONSTANT * ISA_LAPSE_KPM));
  const densityKgM3 = pressurePa / (GAS_CONSTANT * temperatureK);
  if (!(densityKgM3 >= 0.05 && densityKgM3 <= 2) || !(pressurePa >= 1000 && pressurePa <= 120000)) return false;
  out[AIR_DENSITY] = densityKgM3;
  out[AIR_VISCOSITY] = 1.716e-5 * (temperatureK / 273.15) ** 1.5 * (273.15 + 110.4) / (temperatureK + 110.4);
  out[AIR_SOUND] = Math.sqrt(GAMMA * GAS_CONSTANT * temperatureK);
  out[AIR_TEMPERATURE] = temperatureK;
  out[AIR_PRESSURE] = pressurePa;
  return true;
}
/**
 * The air at a session origin `elevationM` above mean sea level (TASK-093), from the sea-level pressure p0 and the ISA
 * temperature offset dT of the TASK-093 contract: T = 288.15 + dT - L e and p = p0 (T / (288.15 + dT))^(g / (R L)). A
 * weather.set that carries this air gives every tick T = 288.15 + dT - L (e + h) and p = p0 (1 - L (e + h) / T0')^(g / (R L)),
 * T0' = 288.15 + dT, h above the origin. With dT = 0, p0 is the QNH of the ICAO altimeter relation. Configuration time.
 */
export function airAtOrigin(seaLevelPressurePa: number, temperatureOffsetK: number, elevationM: number): { temperatureK: number; pressurePa: number } {
  const seaLevelK = ISA_SEA_LEVEL_K + temperatureOffsetK, temperatureK = seaLevelK - ISA_LAPSE_KPM * elevationM;
  if (!Number.isFinite(seaLevelPressurePa) || !(seaLevelPressurePa > 0) || !Number.isFinite(temperatureK) || !(temperatureK > 0) || !(seaLevelK > 0)) {
    throw new Error('Invalid sea-level pressure, temperature offset or elevation');
  }
  return { temperatureK, pressurePa: seaLevelPressurePa * (temperatureK / seaLevelK) ** (GRAVITY_MPS2 / (GAS_CONSTANT * ISA_LAPSE_KPM)) };
}
/** Strict external-state schema. Derived properties cannot be overridden. */
export function atmosphereFromState(input: unknown): Atmosphere {
  if (typeof input !== 'object' || input === null || Array.isArray(input) ||
    Object.keys(input).length !== 2 || !('temperatureK' in input) || !('pressurePa' in input)) throw new Error('Invalid atmospheric state schema');
  const { temperatureK, pressurePa } = input;
  if (typeof temperatureK !== 'number' || !Number.isFinite(temperatureK) || temperatureK < 180 || temperatureK > 330 ||
    typeof pressurePa !== 'number' || !Number.isFinite(pressurePa) || pressurePa < 1000 || pressurePa > 120000) throw new Error('Atmosphere outside temperature/pressure envelope');
  const densityKgM3 = pressurePa / (GAS_CONSTANT * temperatureK);
  if (densityKgM3 < 0.05 || densityKgM3 > 2) throw new Error('Atmosphere outside density envelope');
  return Object.freeze({ temperatureK, pressurePa, densityKgM3,
    dynamicViscosityPaS: 1.716e-5 * (temperatureK / 273.15) ** 1.5 * (273.15 + 110.4) / (temperatureK + 110.4),
    speedOfSoundMps: Math.sqrt(1.4 * GAS_CONSTANT * temperatureK) });
}
/** Geopotential altitude, 0..11000 m. Configuration time; not a step allocator. */
export function isaTroposphere(altitudeM: number): Atmosphere {
  if (!Number.isFinite(altitudeM) || altitudeM < 0 || altitudeM > 11000) throw new Error('ISA altitude outside troposphere');
  const temperatureK = 288.15 - 0.0065 * altitudeM;
  return atmosphereFromState({ temperatureK, pressurePa: 101325 * (temperatureK / 288.15) ** (9.80665 / (GAS_CONSTANT * 0.0065)) });
}
