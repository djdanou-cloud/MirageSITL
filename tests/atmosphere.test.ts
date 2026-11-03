import { expect, it } from 'vitest';
import { AIR_DENSITY, AIR_HEIGHT, AIR_PRESSURE, AIR_REFERENCE_PRESSURE, AIR_REFERENCE_TEMPERATURE, AIR_SOUND, AIR_TEMPERATURE, AIR_VISCOSITY,
  WEATHER_GUST_RMS, WEATHER_PRESSURE, WEATHER_SEED, WEATHER_SLOTS, WEATHER_TEMPERATURE, WEATHER_WIND_DOWN, WEATHER_WIND_EAST, WEATHER_WIND_NORTH,
  airAtOrigin, atmosphereAtHeightInto, atmosphereFromState, isaTroposphere } from '../packages/physics/src/atmosphere';
import { Wind } from '../packages/physics/src/wind';

/**
 * TASK-093 oracle: the ICAO troposphere's defining equations above a reference point, written independently of
 * atmosphere.ts (exp and log1p for the power, Sutherland as beta T^1.5 / (T + S)), with the same ICAO constants.
 */
function troposphere(referenceTemperatureK: number, referencePressurePa: number, heightM: number) {
  const R = 287.05287, L = 0.0065, g = 9.80665, S = 110.4, beta = 1.716e-5 * (273.15 + S) / (273.15 * Math.sqrt(273.15));
  const temperatureK = referenceTemperatureK - L * heightM;
  const pressurePa = referencePressurePa * Math.exp(g / (R * L) * Math.log1p(-L * heightM / referenceTemperatureK));
  return { temperatureK, pressurePa, densityKgM3: pressurePa / (R * temperatureK),
    viscosityPaS: beta * temperatureK * Math.sqrt(temperatureK) / (temperatureK + S), soundMps: Math.sqrt(1.4 * R * temperatureK) };
}
const relative = (actual: number | undefined, expected: number) => Math.abs((actual ?? NaN) / expected - 1);

it('matches ISA sea level and 11 km with SI transport properties', () => {
  const sea = isaTroposphere(0), high = isaTroposphere(11000);
  expect(sea.temperatureK).toBe(288.15);
  expect(sea.densityKgM3).toBeCloseTo(1.225000018, 7);
  expect(sea.speedOfSoundMps).toBeCloseTo(340.293988, 5);
  expect(sea.dynamicViscosityPaS).toBeCloseTo(1.7893e-5, 9);
  expect(high.temperatureK).toBeCloseTo(216.65, 10);
  expect(high.pressurePa).toBeCloseTo(22632.04, 1);
  expect(high.densityKgM3).toBeCloseTo(0.363918, 5);
});
it('rejects nonphysical state and altitudes outside the declared troposphere', () => {
  for (const input of [null, { temperatureK: NaN, pressurePa: 101325 },
    { temperatureK: 300, pressurePa: 1 }, { temperatureK: 0, pressurePa: 101325 },
    { temperatureK: 300, pressurePa: 101325, densityKgM3: 0 }]) {
    expect(() => atmosphereFromState(input)).toThrow();
  }
  for (const altitude of [-1, 11001, Infinity]) expect(() => isaTroposphere(altitude)).toThrow();
});
it('keeps calm wind exact and seeded gust replay independent of render grouping', () => {
  const config = { meanNedMps: [1, 2, -3] as const, gustRmsMps: 0, bandwidthHz: 2, hz: 400 as const };
  const calm = new Wind(config, 123), out = new Float64Array(3);
  calm.stepInto(out); expect(Array.from(out)).toEqual([1, 2, -3]);
  const gust = new Wind({ ...config, gustRmsMps: 2 }, 123);
  const replay = new Wind({ ...config, gustRmsMps: 2 }, 123), other = new Float64Array(3);
  for (let frame = 0; frame < 100; frame++) {
    for (let step = 0; step < 4; step++) gust.stepInto(out);
  }
  for (let step = 0; step < 400; step++) replay.stepInto(other);
  expect(out).toEqual(other);
  const last = out.slice(); gust.reset(123);
  for (let step = 0; step < 400; step++) gust.stepInto(out);
  expect(out).toEqual(last);
  expect(Array.from(out).every(Number.isFinite)).toBe(true);
  for (const invalid of [{ ...config, bandwidthHz: 0 }, { ...config, bandwidthHz: Number.MIN_VALUE },
    { ...config, gustRmsMps: Number.MAX_VALUE }, { ...config, meanNedMps: [201, 0, 0] as const }]) {
    expect(() => new Wind(invalid, 1)).toThrow();
  }
});
it('matches the declared stationary gust variance and lag-one pole', () => {
  const wind = new Wind({ meanNedMps: [0, 0, 0], gustRmsMps: 2, bandwidthHz: 2, hz: 400 }, 123);
  const out = new Float64Array(3);
  for (let i = 0; i < 2000; i++) wind.stepInto(out);
  let sum = 0, squares = 0, lagProduct = 0, previous = out[0]!;
  // Longer than 30000 correlation times; retain the original variance bound.
  const samples = 2000000;
  for (let i = 0; i < samples; i++) {
    wind.stepInto(out); const value = out[0]!; // Output has three allocated entries.
    sum += value; squares += value * value; lagProduct += value * previous; previous = value;
  }
  const mean = sum / samples, variance = squares / samples - mean * mean;
  expect(Math.abs(mean)).toBeLessThan(0.1);
  expect(Math.abs(variance - 4)).toBeLessThan(0.15);
  expect(Math.abs((lagProduct / samples - mean * mean) / variance - Math.exp(-2 * Math.PI * 2 / 400))).toBeLessThan(0.005);
});
it('computes the ISA troposphere above any reference air within 1e-9 of its defining equations and refuses air outside the envelope', () => {
  // TASK-093: per-tick air for weather.set; the envelope is atmosphereFromState's (180..330 K, 1..120 kPa, 0.05..2 kg/m3).
  const input = new Float64Array(3), out = new Float64Array(5);
  let inside = 0, outside = 0;
  for (const referenceTemperatureK of [200, 223.15, 288.15, 313.15, 330])
    for (const referencePressurePa of [30000, 70000, 101325, 110000])
      for (const heightM of [-6000, -800, -50, 0, 0.5, 120, 1500, 6000, 11000, 16000]) {
        input[AIR_REFERENCE_TEMPERATURE] = referenceTemperatureK; input[AIR_REFERENCE_PRESSURE] = referencePressurePa; input[AIR_HEIGHT] = heightM;
        const expected = troposphere(referenceTemperatureK, referencePressurePa, heightM);
        const valid = expected.temperatureK >= 180 && expected.temperatureK <= 330 && expected.pressurePa >= 1000 && expected.pressurePa <= 120000 &&
          expected.densityKgM3 >= 0.05 && expected.densityKgM3 <= 2;
        out.fill(-1);
        expect(atmosphereAtHeightInto(input, out)).toBe(valid);
        if (!valid) { expect(Array.from(out)).toEqual([-1, -1, -1, -1, -1]); outside++; continue; }
        inside++;
        expect(relative(out[AIR_TEMPERATURE], expected.temperatureK)).toBeLessThan(1e-9);
        expect(relative(out[AIR_PRESSURE], expected.pressurePa)).toBeLessThan(1e-9);
        expect(relative(out[AIR_DENSITY], expected.densityKgM3)).toBeLessThan(1e-9);
        expect(relative(out[AIR_VISCOSITY], expected.viscosityPaS)).toBeLessThan(1e-9);
        expect(relative(out[AIR_SOUND], expected.soundMps)).toBeLessThan(1e-9);
      }
  expect(inside).toBeGreaterThan(100);
  expect(outside).toBeGreaterThan(20);
  input[AIR_REFERENCE_TEMPERATURE] = NaN;
  expect(atmosphereAtHeightInto(input, out)).toBe(false);
});
it('reproduces the standard atmosphere tables from the sea-level reference', () => {
  // ICAO Doc 7488/3 and U.S. Standard Atmosphere 1976 at geopotential height, to the tables' printed precision.
  const input = new Float64Array([288.15, 101325, 0]), out = new Float64Array(5);
  expect(atmosphereAtHeightInto(input, out)).toBe(true);
  expect(out[AIR_PRESSURE]).toBe(101325);
  expect(Math.abs(out[AIR_DENSITY]! - 1.2250)).toBeLessThan(5e-5);
  expect(Math.abs(out[AIR_SOUND]! - 340.294)).toBeLessThan(5e-4);
  // TASK-032's Sutherland constants (mu0 = 1.716e-5 Pa s at 273.15 K, S = 110.4 K) give 1.78930e-5 Pa s here, 5.4e-5 below the
  // ICAO table's 1.7894e-5 (beta = 1.458e-6): a stated constant choice, kept as it is, not an error of the formula.
  expect(relative(out[AIR_VISCOSITY], 1.7894e-5)).toBeLessThan(1e-4);
  input[AIR_HEIGHT] = 1000;
  expect(atmosphereAtHeightInto(input, out)).toBe(true);
  expect(Math.abs(out[AIR_PRESSURE]! - 89874.6)).toBeLessThan(0.05);
  input[AIR_HEIGHT] = 11000;
  expect(atmosphereAtHeightInto(input, out)).toBe(true);
  expect(Math.abs(out[AIR_TEMPERATURE]! - 216.65)).toBeLessThan(1e-9);
  expect(Math.abs(out[AIR_PRESSURE]! - 22632)).toBeLessThan(0.5);
  expect(Math.abs(out[AIR_DENSITY]! - 0.36392)).toBeLessThan(5e-6);
  // The configuration-time standard atmosphere is the same function of height.
  for (const heightM of [0, 250, 1000, 4000, 11000]) {
    input[AIR_HEIGHT] = heightM;
    expect(atmosphereAtHeightInto(input, out)).toBe(true);
    const isa = isaTroposphere(heightM);
    expect(relative(out[AIR_PRESSURE], isa.pressurePa)).toBeLessThan(1e-12);
    expect(relative(out[AIR_DENSITY], isa.densityKgM3)).toBeLessThan(1e-12);
  }
});
it('turns the contract sea-level pressure and temperature offset into origin air whose ISA is the contract formula at every height', () => {
  // TASK-093: T = T0 + dT - L h and p = p0 (1 - L h / T0')^(g / (R L)), h above mean sea level, reached through the origin's air.
  const input = new Float64Array(3), out = new Float64Array(5);
  for (const [seaLevelPressurePa, offsetK, elevationM] of [[101325, 0, 0], [99000, 12, 430], [102500, -20, 1650], [97000, 25, -40]] as const) {
    const origin = airAtOrigin(seaLevelPressurePa, offsetK, elevationM);
    input[AIR_REFERENCE_TEMPERATURE] = origin.temperatureK; input[AIR_REFERENCE_PRESSURE] = origin.pressurePa;
    for (const heightM of [-30, 0, 75, 2500]) {
      input[AIR_HEIGHT] = heightM;
      const expected = troposphere(288.15 + offsetK, seaLevelPressurePa, elevationM + heightM);
      expect(atmosphereAtHeightInto(input, out)).toBe(true);
      expect(relative(out[AIR_TEMPERATURE], expected.temperatureK)).toBeLessThan(1e-9);
      expect(relative(out[AIR_PRESSURE], expected.pressurePa)).toBeLessThan(1e-9);
      expect(relative(out[AIR_DENSITY], expected.densityKgM3)).toBeLessThan(1e-9);
    }
  }
  // Without an offset, the sea-level pressure is the QNH of the ICAO altimeter relation: the standard atmosphere at the elevation.
  expect(relative(airAtOrigin(101325, 0, 1000).pressurePa, isaTroposphere(1000).pressurePa)).toBeLessThan(1e-12);
  for (const [p0, dT, e] of [[NaN, 0, 0], [0, 0, 0], [101325, -300, 0], [101325, 0, Infinity]] as const) expect(() => airAtOrigin(p0, dT, e)).toThrow();
});
it('reconfigures a gust in place exactly as a newly built one with the same mean, RMS and seed', () => {
  // TASK-093: Wind.configure applies a weather.set at a tick boundary without allocating a new model.
  const weather = new Float64Array(WEATHER_SLOTS), a = new Float64Array(3), b = new Float64Array(3);
  weather[WEATHER_WIND_NORTH] = 4; weather[WEATHER_WIND_EAST] = -3; weather[WEATHER_WIND_DOWN] = 0.5; weather[WEATHER_GUST_RMS] = 2;
  weather[WEATHER_SEED] = 0xfffffffe; weather[WEATHER_TEMPERATURE] = 300; weather[WEATHER_PRESSURE] = 95000;
  for (const hz of [400, 800, 1200, 4800] as const) {
    const reconfigured = new Wind({ meanNedMps: [0, 0, 0], gustRmsMps: 0, bandwidthHz: 1, hz }, 0);
    for (let i = 0; i < 50; i++) reconfigured.stepInto(a);
    reconfigured.configure(weather);
    const fresh = new Wind({ meanNedMps: [4, -3, 0.5], gustRmsMps: 2, bandwidthHz: 1, hz }, 0xfffffffe);
    for (let i = 0; i < 1000; i++) { reconfigured.stepInto(a); fresh.stepInto(b); expect(a).toEqual(b); }
  }
});
