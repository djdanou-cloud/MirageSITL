// TASK-070: solar forcing and surface heat balance. Oracles: the NREL SPA
// reference case (Reda & Andreas 2004), solstice declination, an equilibrium
// root of the written balance equation computed independently here, and
// timestep refinement. No measured surface data exists yet: validation of
// absolute temperatures stays pending.
import { describe, expect, it } from "vitest";
import { STEFAN_BOLTZMANN, airMass, clearSkyIrradiance, dayOfYearUtc, skyEmissivity, solarIncidence, solarPosition } from "../packages/thermal/src/solar.ts";
import { HeatSurface, TYPICAL_SURFACE_PROPS, ThermalField, type SurfaceThermalProps, type ThermalForcing, type ThermalWeather } from "../packages/thermal/src/heat-balance.ts";
import { isaTroposphere } from "../packages/physics/src/atmosphere.ts";

const DEG = Math.PI / 180;
const asphalt = TYPICAL_SURFACE_PROPS["asphalt"]!;
const night: ThermalForcing = { sunEast: 0, sunNorth: 0, sunUp: -1, directNormalWm2: 0, diffuseHorizontalWm2: 0, dtS: 60 };
const weather: ThermalWeather = { airTemperatureK: 288.15, windSpeedMps: 2, cloudFraction: 0, deepTemperatureK: 290 };

/** The balance equation written out independently of the implementation. */
function netFlux(t: number, p: SurfaceThermalProps, w: ThermalWeather, f: ThermalForcing, shadow = 0, sky = 1, normal: readonly number[] = [0, 0, 1]): number {
  const cosI = Math.max(0, normal[0]! * f.sunEast + normal[1]! * f.sunNorth + normal[2]! * f.sunUp);
  const epsSky = Math.min(1, 9.2e-6 * w.airTemperatureK ** 2 * (1 + 0.22 * w.cloudFraction ** 2));
  return p.solarAbsorptance * (f.directNormalWm2 * cosI * (1 - shadow) + f.diffuseHorizontalWm2 * sky)
    + p.emissivity * (sky * epsSky + 1 - sky) * STEFAN_BOLTZMANN * w.airTemperatureK ** 4
    - p.emissivity * STEFAN_BOLTZMANN * t ** 4 - (5.7 + 3.8 * w.windSpeedMps) * (t - w.airTemperatureK) - p.deepConductanceWM2K * (t - w.deepTemperatureK);
}
function root(fn: (t: number) => number): number {
  let lo = 150, hi = 400;
  for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (fn(m) > 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

describe("solar forcing", () => {
  it("matches the NREL SPA reference position within 0.05 deg", () => {
    // Reda & Andreas (2004): 2003-10-17 12:30:30 MST (UTC-7), 39.742476 N, 105.1786 W:
    // topocentric zenith 50.11162 deg, azimuth 194.34024 deg (SPA includes refraction ~0.02 deg).
    const p = solarPosition(Date.UTC(2003, 9, 17, 19, 30, 30), 39.742476, -105.1786);
    expect(Math.abs(p.zenithRad / DEG - 50.11162)).toBeLessThan(0.05);
    expect(Math.abs(p.azimuthRad / DEG - 194.34024)).toBeLessThan(0.05);
    const [e, n, u] = p.directionEnu;
    expect(Math.hypot(e, n, u)).toBeCloseTo(1, 12);
    expect(Math.atan2(e, n) + 2 * Math.PI).toBeCloseTo(p.azimuthRad, 12);
  });

  it("gives solstice declinations and night below the horizon", () => {
    expect(solarPosition(Date.UTC(2026, 5, 21, 12), 0, 0).declinationRad / DEG).toBeCloseTo(23.44, 1);
    expect(solarPosition(Date.UTC(2026, 11, 21, 12), 0, 0).declinationRad / DEG).toBeCloseTo(-23.44, 1);
    const midnight = solarPosition(Date.UTC(2026, 5, 21, 22, 30), 47.38, 8.54); // 00:30 local summer time, Zurich
    expect(midnight.zenithRad).toBeGreaterThan(Math.PI / 2);
    expect(clearSkyIrradiance(midnight.zenithRad, 172, 0)).toEqual({ directNormalWm2: 0, diffuseHorizontalWm2: 0 });
  });

  it("keeps irradiance in physical units and monotonic in zenith and cloud", () => {
    expect(airMass(0)).toBeCloseTo(1, 3);
    expect(airMass(60 * DEG)).toBeCloseTo(1.99, 1);
    let previous = Infinity;
    for (let z = 0; z < 90; z += 5) {
      const { directNormalWm2: dni } = clearSkyIrradiance(z * DEG, 172, 0);
      expect(dni).toBeLessThanOrEqual(previous);
      expect(dni).toBeLessThan(1361 * 1.035);
      previous = dni;
    }
    // Meinel at AM 1: 1361 * e * 0.7 = ~935-985 W/m^2 depending on the season.
    expect(clearSkyIrradiance(0, 172, 0).directNormalWm2).toBeGreaterThan(900);
    // Meinel's air-mass exponent: at 60 deg (AM ~1.99) the ratio to AM 1 is 0.7^(AM^0.678 - 1).
    const am60 = airMass(60 * DEG);
    expect(clearSkyIrradiance(60 * DEG, 172, 0).directNormalWm2 / clearSkyIrradiance(0, 172, 0).directNormalWm2)
      .toBeCloseTo(0.7 ** (am60 ** 0.678) / 0.7 ** (airMass(0) ** 0.678), 9);
    expect(clearSkyIrradiance(60 * DEG, 172, 0).directNormalWm2 / clearSkyIrradiance(0, 172, 0).directNormalWm2).toBeCloseTo(0.8, 1);
    expect(clearSkyIrradiance(0, 172, 1).directNormalWm2).toBeCloseTo(clearSkyIrradiance(0, 172, 0).directNormalWm2 * 0.25, 9);
    expect(skyEmissivity(288.15, 0)).toBeCloseTo(0.764, 3);
    expect(dayOfYearUtc(Date.UTC(2026, 0, 1, 12))).toBe(1);
    expect(dayOfYearUtc(Date.UTC(2026, 11, 31))).toBe(365);
  });
});

describe("surface heat balance", () => {
  it("relaxes to the night radiative equilibrium below air temperature", () => {
    const field = new ThermalField([{ props: asphalt }, { props: asphalt }], weather, 300);
    field.setWeather(weather);
    const clear = root(t => netFlux(t, asphalt, weather, night));
    expect(clear).toBeLessThan(weather.airTemperatureK); // clear-sky radiative cooling
    for (let i = 0; i < 48 * 60; i++) field.stepFrom(night);
    expect(field.temperatureK[0]).toBeCloseTo(clear, 2);
    expect(field.equilibriumK(0, night)).toBeCloseTo(clear, 6);
    // Overcast sky emits more longwave: equilibrium is warmer.
    const cloudy = { ...weather, cloudFraction: 1 };
    expect(root(t => netFlux(t, asphalt, cloudy, night))).toBeGreaterThan(clear + 1);
  });

  it("closes the energy budget in J/m^2 and reports flux components in W/m^2", () => {
    const field = new ThermalField([{ props: asphalt }], weather, 295);
    const sun: ThermalForcing = { sunEast: 0, sunNorth: -0.5, sunUp: Math.sqrt(0.75), directNormalWm2: 800, diffuseHorizontalWm2: 80, dtS: 30 };
    const out = { absorbedSolar: 0, longwaveIn: 0, longwaveOut: 0, convection: 0, conduction: 0, net: 0 };
    field.fluxAt(0, 295, sun, out);
    expect(out.absorbedSolar).toBeCloseTo(0.9 * (800 * Math.sqrt(0.75) + 80), 9);
    expect(out.longwaveOut).toBeCloseTo(-0.95 * STEFAN_BOLTZMANN * 295 ** 4, 9);
    expect(out.absorbedSolar + out.longwaveIn + out.longwaveOut + out.convection + out.conduction).toBeCloseTo(out.net, 9);
    expect(out.net).toBeCloseTo(netFlux(295, asphalt, weather, sun), 9);
    const t0 = field.temperatureK[0]!;
    for (let i = 0; i < 600; i++) field.stepFrom(sun);
    expect(asphalt.arealHeatCapacityJM2K * (field.temperatureK[0]! - t0)).toBeCloseTo(field.energyJM2[0]!, 3);
  });

  it("converges with the timestep (second order)", () => {
    const sun: ThermalForcing = { sunEast: 0.3, sunNorth: -0.4, sunUp: Math.sqrt(0.75), directNormalWm2: 850, diffuseHorizontalWm2: 85, dtS: 1 };
    const run = (dt: number) => {
      const f = new ThermalField([{ props: TYPICAL_SURFACE_PROPS["roof-metal"]! }, { props: asphalt }], weather, 285);
      const forcing = { ...sun, dtS: dt };
      for (let s = 0; s < 7200 / dt; s++) f.stepFrom(forcing);
      return [f.temperatureK[0]!, f.temperatureK[1]!];
    };
    const reference = run(1);
    const errors = [600, 300, 150].map(dt => Math.abs(run(dt)[1]! - reference[1]!));
    expect(errors[0]!).toBeGreaterThan(errors[1]! * 3);
    expect(errors[1]!).toBeGreaterThan(errors[2]! * 3);
    expect(errors[2]!).toBeLessThan(0.01);
    // A thin metal roof is stiff (C/k ~ 160 s): automatic substeps keep 600 s steps stable and close.
    expect(Math.abs(run(600)[0]! - reference[0]!)).toBeLessThan(0.05);
  });

  it("warms after sunrise, keeps shaded surfaces cooler and orients by normal", () => {
    const lat = 47.38, lon = 8.54, start = Date.UTC(2026, 5, 20, 18); // 20:00 local summer time
    const field = new ThermalField([
      { props: asphalt }, { props: asphalt, shadowFraction: 1 }, { props: asphalt, shadowFraction: 0.5 },
      { props: asphalt, normalEnu: [0, -1, 0] }, // south-facing wall
    ], { ...weather, airTemperatureK: 293.15 }, 293);
    const forcing: ThermalForcing = { ...night, dtS: 60 };
    let sunriseMs = NaN, minTemp = Infinity, minAt = 0, wasDown = false;
    for (let k = 0; k <= 22 * 60; k++) {
      const t = start + k * 60_000;
      const p = solarPosition(t, lat, lon);
      const irr = clearSkyIrradiance(p.zenithRad, dayOfYearUtc(t), 0);
      [forcing.sunEast, forcing.sunNorth, forcing.sunUp] = p.directionEnu;
      forcing.directNormalWm2 = irr.directNormalWm2; forcing.diffuseHorizontalWm2 = irr.diffuseHorizontalWm2;
      const up = p.zenithRad < Math.PI / 2;
      if (Number.isNaN(sunriseMs) && up && wasDown) sunriseMs = t;
      wasDown = !up;
      field.stepFrom(forcing);
      if (!Number.isNaN(sunriseMs) || !up) if (field.temperatureK[0]! < minTemp) { minTemp = field.temperatureK[0]!; minAt = t; }
    }
    // Zurich solstice sunrise is about 03:30 UTC; the minimum falls within 90 min after it.
    expect(new Date(sunriseMs).getUTCHours()).toBe(3);
    expect(minAt).toBeGreaterThanOrEqual(sunriseMs - 10 * 60_000);
    expect(minAt).toBeLessThanOrEqual(sunriseMs + 90 * 60_000);
    // At 16:00 local the sunlit, half-shaded and shaded surfaces are ordered, and well apart.
    const [sunlit, shaded, half, wall] = field.temperatureK;
    expect(sunlit! - shaded!).toBeGreaterThan(5);
    expect(half!).toBeGreaterThan(shaded!); expect(half!).toBeLessThan(sunlit!);
    expect(wall!).toBeLessThan(sunlit!); // high summer sun favours horizontal surfaces
  });

  it("uses ambient occlusion only as the sky-view factor of explicit radiation", () => {
    const inert: SurfaceThermalProps = { solarAbsorptance: 0, emissivity: 0, arealHeatCapacityJM2K: 1e5, deepConductanceWM2K: 5 };
    const field = new ThermalField([{ props: inert, skyViewFactor: 1 }, { props: inert, skyViewFactor: 0.2 },
      { props: asphalt, skyViewFactor: 1 }, { props: asphalt, skyViewFactor: 0.2 }], weather, 280);
    for (let i = 0; i < 6 * 60; i++) field.stepFrom(night);
    expect(field.temperatureK[0]).toBe(field.temperatureK[1]); // no radiative coupling: occlusion changes nothing
    expect(field.temperatureK[3]!).toBeGreaterThan(field.temperatureK[2]! + 0.5); // occluded surface sees warm surroundings, not cold sky
  });

  it("takes air temperature from an atmosphere state and rejects invalid configuration", () => {
    const w = ThermalField.weatherFrom(isaTroposphere(500), 3, 0.2, 285);
    expect(w.airTemperatureK).toBeCloseTo(288.15 - 3.25, 9);
    expect(() => new ThermalField([], weather, 290)).toThrow();
    expect(() => new ThermalField([{ props: { ...asphalt, emissivity: 1.2 } }], weather, 290)).toThrow();
    expect(() => new ThermalField([{ props: asphalt, normalEnu: [0, 0, 2] }], weather, 290)).toThrow();
    expect(() => new ThermalField([{ props: asphalt, shadowFraction: -0.1 }], weather, 290)).toThrow();
    const field = new ThermalField([{ props: asphalt }], weather, 290);
    expect(field.stepFrom({ ...night, dtS: 0 })).toBe(false);
    expect(field.temperatureK[0]).toBe(290);
  });

  it("steps 1000 elements for 3000 steps without triggering GC", async () => {
    const field = new ThermalField(Array.from({ length: 1000 }, (_, i) => ({ props: i % 2 ? asphalt : TYPICAL_SURFACE_PROPS["vegetation-grass"]!, shadowFraction: (i % 10) / 10 })), weather, 290);
    const sun: ThermalForcing = { sunEast: 0.2, sunNorth: -0.3, sunUp: 0.93, directNormalWm2: 700.5, diffuseHorizontalWm2: 70.5, dtS: 10 };
    for (let i = 0; i < 300; i++) field.stepFrom(sun);
    const gcStarts: number[] = [];
    const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gcStarts.push(e.startTime); });
    observer.observe({ entryTypes: ["gc"] });
    const windows: number[][] = [];
    for (let w = 0; w < 3; w++) {
      const t0 = performance.now();
      for (let i = 0; i < 1000; i++) field.stepFrom(sun); // 1e6 element updates, 2e6 flux evaluations
      const t1 = performance.now();
      windows.push([t0, t1]);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (gcStarts.every(t => t < t0 || t > t1)) break;
    }
    observer.disconnect();
    const perWindow = windows.map(([t0, t1]) => gcStarts.filter(t => t >= t0! && t <= t1!).length);
    expect(perWindow, JSON.stringify(perWindow)).toContain(0);
  }, 60_000);
});

// Reference single-surface solver from the parallel implementation (implicit trapezoid).
describe("single-surface reference solver", () => {
  const lumped = {
    heatCapacityJm2K: 10000,
    absorptivity: 0.7,
    emissivity: 0.9,
    convectionWm2K: 10,
    conductionWm2K: 2,
  };
  const lumpedNight = { airK: 290, skyK: 290, substrateK: 290, solarWm2: 0 };
  it("night equilibrium and explicit power-to-energy units", () => {
    const s = new HeatSurface(lumped, 290);
    for (let i = 0; i < 3600; i++) s.advance(1, lumpedNight);
    expect(s.temperatureK).toBe(290);
    const noLoss = new HeatSurface(
      { ...lumped, emissivity: 0, convectionWm2K: 0, conductionWm2K: 0 },
      290,
    );
    noLoss.advance(10, { ...lumpedNight, solarWm2: 1000 });
    expect(noLoss.temperatureK).toBeCloseTo(290.7, 10);
  });
  it("sunrise and shadows obey energy balance with timestep convergence", () => {
    const integrate = (dt: number) => {
      const s = new HeatSurface(lumped, 290);
      for (let t = 0; t < 600 - 1e-8; t += dt)
        s.advance(dt, { ...lumpedNight, solarWm2: 800 });
      return s.temperatureK;
    };
    const ref = integrate(0.125);
    expect(Math.abs(integrate(1) - ref)).toBeLessThan(0.002);
    expect(Math.abs(integrate(0.5) - ref)).toBeLessThan(
      Math.abs(integrate(1) - ref),
    );
    const s = new HeatSurface(lumped, 310);
    s.advance(10, lumpedNight);
    expect(s.temperatureK).toBeLessThan(310);
    expect(ref).toBeGreaterThan(290);
  });
  it("solar geometry in local ENU: equatorial noon, horizon, backface and shadow", () => {
    expect(solarIncidence(0, 0, 0, [0, 0, 1], 1000, 1)).toBeCloseTo(1000, 10);
    expect(solarIncidence(0, 0, Math.PI, [0, 0, 1], 1000, 1)).toBe(0);
    expect(solarIncidence(0, 0, 0, [0, 0, 1], 1000, 0)).toBe(0);
    expect(solarIncidence(0, 0, 0, [0, 0, -1], 1000, 1)).toBe(0);
    expect(
      () => new HeatSurface({ ...lumped, heatCapacityJm2K: 0 }, 290),
    ).toThrow();
    expect(() => solarIncidence(0, 0, 0, [0, 0, 2], 1000, 1)).toThrow();
  });
});

describe("cross-checks between the two solvers and the two solar models", () => {
  it("ThermalField (Heun) and HeatSurface (implicit trapezoid) agree on equivalent forcing", () => {
    const props = TYPICAL_SURFACE_PROPS["asphalt"]!;
    const w: ThermalWeather = { airTemperatureK: 288, windSpeedMps: 3, cloudFraction: 0.3, deepTemperatureK: 291 };
    // HeatSurface takes the sky as a temperature: eps_sky sigma T_air^4 = sigma T_sky^4.
    const skyK = skyEmissivity(w.airTemperatureK, w.cloudFraction) ** 0.25 * w.airTemperatureK;
    const surface = new HeatSurface({ heatCapacityJm2K: props.arealHeatCapacityJM2K, absorptivity: props.solarAbsorptance, emissivity: props.emissivity,
      convectionWm2K: 5.7 + 3.8 * w.windSpeedMps, conductionWm2K: props.deepConductanceWM2K }, 300);
    const field = new ThermalField([{ props }], w, 300);
    const sun: ThermalForcing = { sunEast: 0, sunNorth: -0.6, sunUp: 0.8, directNormalWm2: 750, diffuseHorizontalWm2: 75, dtS: 60 };
    for (let k = 0; k < 6 * 60; k++) {
      const day = k < 3 * 60;
      const f = day ? sun : { ...sun, directNormalWm2: 0, diffuseHorizontalWm2: 0 };
      field.stepFrom(f);
      surface.advance(60, { airK: w.airTemperatureK, skyK, substrateK: w.deepTemperatureK, solarWm2: f.directNormalWm2 * f.sunUp + f.diffuseHorizontalWm2 });
      expect(Math.abs(field.temperatureK[0]! - surface.temperatureK), `minute ${k}`).toBeLessThan(0.02);
    }
  });

  it("solarIncidence (declination/hour-angle geometry) matches the ephemeris direction", () => {
    for (const [utc, lat, lon] of [[Date.UTC(2026, 5, 21, 11), 47.38, 8.54], [Date.UTC(2026, 11, 21, 15), -33.9, 18.4], [Date.UTC(2026, 2, 20, 6), 0, 0]] as const) {
      const p = solarPosition(utc, lat, lon);
      for (const n of [[0, 0, 1], [0, -1, 0], [Math.SQRT1_2, 0, Math.SQRT1_2]] as const) {
        const [e, nn, u] = p.directionEnu;
        const expected = u <= 0 ? 0 : 900 * Math.max(0, e * n[0] + nn * n[1] + u * n[2]);
        expect(solarIncidence(lat * Math.PI / 180, p.declinationRad, p.hourAngleRad, n, 900, 1)).toBeCloseTo(expected, 9);
      }
    }
  });
});
