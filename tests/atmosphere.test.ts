import { expect, it } from 'vitest';
import { atmosphereFromState, isaTroposphere } from '../packages/physics/src/atmosphere';
import { Wind } from '../packages/physics/src/wind';

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
