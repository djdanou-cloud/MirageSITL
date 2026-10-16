import { expect, test } from "vitest";
import {
  bandRadiance,
  observedRadiance,
  paletteLevel,
  TRAINING_PROFILE,
  validateInstrument,
} from "../packages/thermal/src/thermal-camera";
test("Planck integral is monotone with independent 10 um spectral oracle", () => {
  // At 300 K, 10 um spectral radiance = 9.9240333300707 W/(m2 sr um).
  const at10 =
    1.1910429723971884e8 / (10 ** 5 * Math.expm1(14387.768775039337 / 3000));
  expect(at10).toBeCloseTo(9.9240333300707, 10);
  expect(bandRadiance(300)).toBeGreaterThan(54);
  expect(bandRadiance(300)).toBeLessThan(56);
  for (let t = 101; t <= 999; t++)
    expect(bandRadiance(t)).toBeGreaterThan(bandRadiance(t - 1));
});
test("emission/reflection and Beer-Lambert attenuation obey limiting cases", () => {
  const p = TRAINING_PROFILE;
  expect(observedRadiance(320, 1, 280, 0, p)).toBe(bandRadiance(320));
  expect(observedRadiance(320, 0, 280, 0, p)).toBe(bandRadiance(280));
  expect(observedRadiance(320, 0.5, 280, 0, p)).toBe(
    (bandRadiance(320) + bandRadiance(280)) / 2,
  );
  expect(observedRadiance(320, 1, 280, 1e6, p)).toBe(bandRadiance(290));
  const tau = Math.exp(-1);
  expect(observedRadiance(320, 1, 280, 1000, p)).toBeCloseTo(
    tau * bandRadiance(320) + (1 - tau) * bandRadiance(290),
    10,
  );
  expect(paletteLevel(bandRadiance(p.coldK), p)).toBe(0);
  expect(paletteLevel(bandRadiance(p.hotK), p)).toBe(1);
  expect(() => validateInstrument({ ...p, width: 1e9 })).toThrow();
  expect(() => observedRadiance(300, 2, 280, 0, p)).toThrow();
});
