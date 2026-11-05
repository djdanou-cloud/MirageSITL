import { describe, expect, test } from 'vitest';
import { airAtOrigin } from '../packages/physics/src/atmosphere.ts';
import { DEFAULT_LOCATION, type LocationChoice } from '../apps/web/src/weather/location';
import { MAX_WIND_SPEED_MPS, describeWeather, initialWeatherForm, newSeed, weatherControl, windNedOf, windOfNed, type WeatherForm } from '../apps/web/src/weather/weather-form';

// TASK-167: the Weather and location tab's weather form, against conventions written out here: a wind blows from its bearing (from the
// west it blows east), and the air at the ground is the ISA of the sea-level pressure and temperature offset at the location's elevation.
const HIGH: LocationChoice = { site: null, latitudeDeg: 31.5, longitudeDeg: 34.9, groundElevationMslM: 800, headingDeg: 0, measuredQnhPa: 101800, temperatureOffsetK: -3 };
type Draft = { -readonly [K in keyof WeatherForm]: { -readonly [P in keyof WeatherForm[K]]: WeatherForm[K][P] } };
const form = (change: (copy: Draft) => void = () => undefined): WeatherForm => {
  const copy = structuredClone(initialWeatherForm(DEFAULT_LOCATION));
  change(copy);
  return copy;
};

describe('the weather form (TASK-167)', () => {
  test('turns a speed and a bearing into the air velocity, and back', () => {
    expect(windNedOf(10, 270)).toEqual([expect.closeTo(0, 12), expect.closeTo(10, 12), 0]);
    expect(windNedOf(10, 0)).toEqual([-10, expect.closeTo(0, 12), 0]);
    expect(windNedOf(0, 123)).toEqual([0, 0, 0]);
    for (const [speed, from] of [[5, 0], [7, 45], [12, 270], [3, 359]] as const) {
      const back = windOfNed(windNedOf(speed, from));
      expect(back.speedMps).toBeCloseTo(speed, 12); expect(back.fromDeg).toBeCloseTo(from, 9);
    }
  });
  test('gives each weather effect\'s control, and names the problem of a bad field', () => {
    const wind = weatherControl(form(f => { f.wind.speedMps = '8'; f.wind.fromDeg = '180'; }), 'wind.mean', DEFAULT_LOCATION, 'w');
    expect(wind.control?.parameters.windNedMps).toEqual([8, expect.closeTo(0, 12), 0]);
    const gust = weatherControl(form(f => { f.gust.seed = '4294967295'; }), 'wind.gust', DEFAULT_LOCATION, 'g');
    expect(gust.control).toMatchObject({ effect: 'wind.gust', enabled: true, intensity: 1, parameters: { rmsMps: 1, bandwidthHz: 1, seed: 4294967295 } });
    const discrete = weatherControl(form(f => { f.discrete.fromDeg = '360'; f.discrete.upwardDeg = '-20'; }), 'wind.discrete-gust', DEFAULT_LOCATION, 'd');
    expect(discrete.control?.parameters).toEqual({ amplitudeMps: 5, durationS: 4, fromDeg: 0, upwardDeg: -20 });
    const turbulence = weatherControl(form(f => { f.turbulence.intensity = '2'; f.turbulence.w20Mps = '15.4'; }), 'wind.turbulence', DEFAULT_LOCATION, 't');
    expect(turbulence.control).toMatchObject({ intensity: 2, parameters: { w20Mps: 15.4, seed: 1 } });
    for (const [change, effect, message] of [
      [(f: Draft) => { f.wind.speedMps = String(MAX_WIND_SPEED_MPS + 1); }, 'wind.mean', 'Wind speed must be a number from 0 to 200'],
      [(f: Draft) => { f.gust.seed = '1.5'; }, 'wind.gust', 'Gust seed must be a whole number from 0 to 4294967295'],
      [(f: Draft) => { f.discrete.durationS = '0'; }, 'wind.discrete-gust', 'Gust duration must be a number from 0.1 to 60'],
      [(f: Draft) => { f.turbulence.w20Mps = ''; }, 'wind.turbulence', 'Mean wind at 6 m (W20) must be a number from 0 to 50'],
      [(f: Draft) => { f.air.pressure = 'measured'; f.air.qnhHpa = '700'; }, 'atmosphere', 'Measured QNH (hPa) must be a number from 870 to 1085'],
    ] as const) {
      const outcome = weatherControl(form(change), effect, DEFAULT_LOCATION, 'x');
      expect(outcome.control, message).toBeNull();
      expect(outcome.problem).toBe(message);
    }
    // A W20 the intensity carries past the turbulence model's 50 m/s is refused as the protocol refuses it.
    expect(weatherControl(form(f => { f.turbulence.w20Mps = '30'; f.turbulence.intensity = '2'; }), 'wind.turbulence', DEFAULT_LOCATION, 't').problem).toMatch(/w20Mps/);
  });
  test('takes the air at the ground from the location\'s elevation and its own sea-level pressure and offset', () => {
    const initial = initialWeatherForm(HIGH);
    expect(initial.air).toEqual({ pressure: 'measured', qnhHpa: '1018', temperatureOffsetK: '-3' });
    const air = weatherControl(initial, 'atmosphere', HIGH, 'a').control?.parameters;
    const expected = airAtOrigin(101800, -3, 800);
    expect(air).toEqual({ temperatureK: expected.temperatureK, pressurePa: expected.pressurePa });
    // About 9 kPa below the sea-level value at 800 m: consistent with the altitude.
    expect(101800 - expected.pressurePa).toBeGreaterThan(9000);
    const standard = weatherControl(form(), 'atmosphere', DEFAULT_LOCATION, 'a').control?.parameters;
    expect(standard).toEqual({ temperatureK: airAtOrigin(101325, 0, 584).temperatureK, pressurePa: airAtOrigin(101325, 0, 584).pressurePa });
  });
  test('describes what a control does in one line', () => {
    expect(describeWeather('wind.mean', { windNedMps: windNedOf(6, 270) })).toBe('Mean wind: 6.0 m/s from 270°');
    expect(describeWeather('wind.discrete-gust', { amplitudeMps: 7, durationS: 3, fromDeg: 90, upwardDeg: 5 })).toBe('Discrete gust: 7.0 m/s from 90°, 5° upward, over 3.0 s');
    expect(describeWeather('wind.gust', { rmsMps: 1.5, bandwidthHz: 1, seed: 1234 })).toBe('Synthetic gust: 1.5 m/s RMS, 1.00 Hz, seed 1234');
    expect(describeWeather('wind.turbulence', { w20Mps: 7.7, seed: 9 }, 2)).toBe('Turbulence (Dryden): W20 7.7 m/s, seed 9, intensity 2');
    expect(describeWeather('atmosphere', { temperatureK: 288.15, pressurePa: 101325 })).toBe('Temperature and pressure: 15.0 °C and 1013.25 hPa at the ground');
  });
  test('draws a new uint32 seed', () => {
    expect(newSeed(array => { array[0] = 0xdeadbeef; return array; })).toBe(0xdeadbeef);
    const seed = newSeed();
    expect(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff).toBe(true);
  });
});
