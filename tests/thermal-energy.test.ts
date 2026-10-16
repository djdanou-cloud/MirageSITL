import { expect, test } from "vitest";
import { HeatSurface } from "../packages/thermal/src/heat-balance";
import { solarIncidence } from "../packages/thermal/src/solar";
const material = {
  heatCapacityJm2K: 10000,
  absorptivity: 0.7,
  emissivity: 0.9,
  convectionWm2K: 10,
  conductionWm2K: 2,
};
const night = { airK: 290, skyK: 290, substrateK: 290, solarWm2: 0 };
test("night equilibrium and explicit power-to-energy units", () => {
  const s = new HeatSurface(material, 290);
  for (let i = 0; i < 3600; i++) s.advance(1, night);
  expect(s.temperatureK).toBe(290);
  const noLoss = new HeatSurface(
    { ...material, emissivity: 0, convectionWm2K: 0, conductionWm2K: 0 },
    290,
  );
  noLoss.advance(10, { ...night, solarWm2: 1000 });
  expect(noLoss.temperatureK).toBeCloseTo(290.7, 10);
});
test("sunrise and shadows obey energy balance with timestep convergence", () => {
  const integrate = (dt: number) => {
    const s = new HeatSurface(material, 290);
    for (let t = 0; t < 600 - 1e-8; t += dt)
      s.advance(dt, { ...night, solarWm2: 800 });
    return s.temperatureK;
  };
  const ref = integrate(0.125);
  expect(Math.abs(integrate(1) - ref)).toBeLessThan(0.002);
  expect(Math.abs(integrate(0.5) - ref)).toBeLessThan(
    Math.abs(integrate(1) - ref),
  );
  const s = new HeatSurface(material, 310);
  s.advance(10, night);
  expect(s.temperatureK).toBeLessThan(310);
  expect(ref).toBeGreaterThan(290);
});
test("solar geometry in local ENU: equatorial noon, horizon, backface and shadow", () => {
  expect(solarIncidence(0, 0, 0, [0, 0, 1], 1000, 1)).toBeCloseTo(1000, 10);
  expect(solarIncidence(0, 0, Math.PI, [0, 0, 1], 1000, 1)).toBe(0);
  expect(solarIncidence(0, 0, 0, [0, 0, 1], 1000, 0)).toBe(0);
  expect(solarIncidence(0, 0, 0, [0, 0, -1], 1000, 1)).toBe(0);
  expect(
    () => new HeatSurface({ ...material, heatCapacityJm2K: 0 }, 290),
  ).toThrow();
  expect(() => solarIncidence(0, 0, 0, [0, 0, 2], 1000, 1)).toThrow();
});
