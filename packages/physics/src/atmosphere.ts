/** Dry-air constants: ICAO ISA troposphere; Sutherland viscosity at 273.15 K. */
export interface Atmosphere {
  readonly temperatureK: number; readonly pressurePa: number; readonly densityKgM3: number;
  readonly dynamicViscosityPaS: number; readonly speedOfSoundMps: number;
}
const GAS_CONSTANT = 287.05287;
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
