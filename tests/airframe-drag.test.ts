import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { AIR_DENSITY, WEATHER_GUST_RMS, WEATHER_PRESSURE, WEATHER_SEED, WEATHER_SLOTS, WEATHER_TEMPERATURE, WEATHER_WIND_DOWN, WEATHER_WIND_EAST,
  WEATHER_WIND_NORTH } from '@mirage/physics/atmosphere';
import { BetFlightDynamics, VALIDITY_FLAG_DRAG_OUTSIDE_RANGE, type AirframeDragConfiguration, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { ControlFlag, newInput } from '@mirage/protocol';
import { flightConfiguration } from './bet-runtime-fixture.ts';

// TASK-096: airframe drag F = −½·ρ·|v_a|·(C_D·A)·v_a in body FRD with the moment r_cp × F about the CG. Oracles: the
// formula evaluated here on the first step of a vehicle at rest and level in a constant wind (so v_a = −wind and body =
// NED), Newton's law for the change of acceleration it causes, and Galilean invariance in a moving air mass.

let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600000);

/** A full symmetric positive-definite tensor with cross terms, m², and a center of pressure off the CG, m. */
const DRAG: AirframeDragConfiguration = {
  dragAreaBodyM2: [0.02, 0.003, -0.001, 0.003, 0.025, 0.002, -0.001, 0.002, 0.04], centerOfPressureCgM: [0.01, -0.02, -0.03], maxAirspeedMps: 30,
};
const weatherOf = (wind: readonly [number, number, number], temperatureK = 288.15, pressurePa = 101325) => {
  const w = new Float64Array(WEATHER_SLOTS);
  w[WEATHER_WIND_NORTH] = wind[0]; w[WEATHER_WIND_EAST] = wind[1]; w[WEATHER_WIND_DOWN] = wind[2];
  w[WEATHER_GUST_RMS] = 0; w[WEATHER_SEED] = 0; w[WEATHER_TEMPERATURE] = temperatureK; w[WEATHER_PRESSURE] = pressurePa;
  return w;
};
/** The fixture quad at rest and level, without gravity and with its rotors stopped, so the first step starts from v = a = ω = 0. */
function atRest(drag?: AirframeDragConfiguration, edit: (c: BetFlightConfiguration) => void = () => undefined): BetFlightDynamics {
  const configuration = flightConfiguration();
  configuration.gravityMps2 = 0; configuration.initialOmegaRadS = [0, 0, 0, 0];
  if (drag) configuration.airframeDrag = drag;
  edit(configuration);
  return new BetFlightDynamics(module, configuration, 400);
}
const idle = () => { const pilot = newInput(); pilot.wallTimeMs = 100; return pilot; };
const relative = (actual: number, expected: number) => Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);

describe('airframe drag', () => {
  it('applies −½·ρ·|v_a|·(C_D·A)·v_a and r_cp × F on the first step in a constant wind', () => {
    for (const wind of [[5, 0, 0], [0, -4, 1], [3, 2, -2], [-7, 6, 0.5]] as const) {
      const d = atRest(DRAG), pilot = idle();
      expect(d.setWeather(weatherOf(wind, 293.15, 98000))).toBeNull();
      const rho = d.air[AIR_DENSITY]!;
      d.nowMs = 100; d.stepNow(pilot);
      expect(d.fault).toBe('');
      // At rest and level, v_a = −wind in body axes, so F = ½·ρ·|wind|·C·wind.
      const c = DRAG.dragAreaBodyM2, r = DRAG.centerOfPressureCgM, k = 0.5 * rho * Math.hypot(...wind);
      const f = [0, 1, 2].map(i => k * (c[3 * i]! * wind[0] + c[3 * i + 1]! * wind[1] + c[3 * i + 2]! * wind[2]));
      const m = [r[1]! * f[2]! - r[2]! * f[1]!, r[2]! * f[0]! - r[0]! * f[2]!, r[0]! * f[1]! - r[1]! * f[0]!];
      const scale = Math.hypot(...f);
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(d.dragWrenchBody[i]! - f[i]!) / scale).toBeLessThan(1e-12);
        expect(Math.abs(d.dragWrenchBody[3 + i]! - m[i]!) / (scale * Math.hypot(...r))).toBeLessThan(1e-12);
      }
      // Along the wind the drag pushes downwind: F·wind > 0 for a positive-definite tensor.
      expect(f[0]! * wind[0] + f[1]! * wind[1] + f[2]! * wind[2]).toBeGreaterThan(0);
      expect(d.validityFlags & VALIDITY_FLAG_DRAG_OUTSIDE_RANGE).toBe(0);
      d.dispose();
    }
  });

  it('reaches the body: the first step accelerates by F/m more than without drag, and turns by the moment', () => {
    const wind = [4, -3, 1] as const, pilot = idle();
    const run = (drag?: AirframeDragConfiguration) => {
      const d = atRest(drag);
      expect(d.setWeather(weatherOf(wind))).toBeNull();
      d.nowMs = 100; d.stepNow(pilot);
      return d;
    };
    // With the center of pressure at the CG the drag has no moment, so both runs keep one attitude through the step and the
    // rotors meet the same air: the difference is the drag alone. The fixture's mass is 2 kg.
    const centered = run({ ...DRAG, centerOfPressureCgM: [0, 0, 0] }), without = run(), f = centered.dragWrenchBody;
    const delta = [centered.state.an - without.state.an, centered.state.ae - without.state.ae, centered.state.ad - without.state.ad];
    for (let i = 0; i < 3; i++) expect(relative(delta[i]!, f[i]! / 2)).toBeLessThan(1e-10);
    // From rest the rate after one step is I⁻¹·M·dt up to the attitude change within the step, about (M/I)·dt²/2 ≈ 1e-6 rad;
    // the fixture's inertia is diag(0.05, 0.05, 0.1).
    const offset = run(DRAG), m = offset.dragWrenchBody, inertia = [0.05, 0.05, 0.1];
    const rates = [offset.state.p - without.state.p, offset.state.q - without.state.q, offset.state.r - without.state.r];
    for (let i = 0; i < 3; i++) expect(relative(rates[i]!, m[3 + i]! / inertia[i]! / 400)).toBeLessThan(1e-5);
    for (const d of [centered, without, offset]) d.dispose();
  });

  it('flags a step whose airspeed exceeds the data range, and only then', () => {
    const pilot = idle();
    for (const [speed, flagged] of [[3.9, false], [4.1, true]] as const) {
      const d = atRest({ ...DRAG, maxAirspeedMps: 4 });
      expect(d.setWeather(weatherOf([speed, 0, 0]))).toBeNull();
      d.nowMs = 100; d.stepNow(pilot);
      expect((d.validityFlags & VALIDITY_FLAG_DRAG_OUTSIDE_RANGE) !== 0).toBe(flagged);
      d.dispose();
    }
    // Without drag nothing is flagged and the drag wrench stays zero.
    const plain = atRest();
    expect(plain.setWeather(weatherOf([50, 0, 0]))).toBeNull();
    plain.nowMs = 100; plain.stepNow(pilot);
    expect(plain.validityFlags & VALIDITY_FLAG_DRAG_OUTSIDE_RANGE).toBe(0);
    expect(Array.from(plain.dragWrenchBody)).toEqual([0, 0, 0, 0, 0, 0]);
    plain.dispose();
  });

  it('refuses a tensor that is not symmetric positive definite, a bad center or range, and bit 17 as a configuration flag', () => {
    const bad: AirframeDragConfiguration[] = [
      { ...DRAG, dragAreaBodyM2: [0.02, 0.003, 0, 0.004, 0.025, 0, 0, 0, 0.04] },
      { ...DRAG, dragAreaBodyM2: [0.02, 0, 0, 0, 0, 0, 0, 0, 0.04] },
      { ...DRAG, dragAreaBodyM2: [0.02, 0.03, 0, 0.03, 0.02, 0, 0, 0, 0.04] },
      { ...DRAG, dragAreaBodyM2: [0.02, 0, 0, 0, 0.02, 0, 0, 0, NaN] },
      { ...DRAG, dragAreaBodyM2: [0.02, 0, 0, 0, 0.02, 0, 0, 0] },
      { ...DRAG, centerOfPressureCgM: [0, 0] },
      { ...DRAG, maxAirspeedMps: 0 },
      { ...DRAG, maxAirspeedMps: NaN },
    ];
    for (const drag of bad) expect(() => atRest(drag)).toThrow('Invalid airframe drag');
    expect(() => atRest(DRAG, c => { c.configurationFlags = VALIDITY_FLAG_DRAG_OUTSIDE_RANGE; })).toThrow('Bit 17');
    // An infinite range states none.
    atRest({ ...DRAG, maxAirspeedMps: Infinity }).dispose();
  });

  it('keeps Galilean invariance: a constant wind flies the calm flight offset by the wind, drag included', () => {
    // With drag the forces still depend on the velocity relative to the air only (TASK-093's oracle, now with the airframe).
    const W = [6, -4, 0] as const, steps = 400, dt = 1 / 400;
    const calmConfiguration = flightConfiguration(), windConfiguration = flightConfiguration();
    calmConfiguration.airframeDrag = DRAG; windConfiguration.airframeDrag = DRAG;
    windConfiguration.initialBody.velocityNedMps.set(W);
    const calm = new BetFlightDynamics(module, calmConfiguration, 400), windy = new BetFlightDynamics(module, windConfiguration, 400);
    expect(calm.setWeather(weatherOf([0, 0, 0]))).toBeNull();
    expect(windy.setWeather(weatherOf(W))).toBeNull();
    const pilot = newInput();
    pilot.flags = ControlFlag.Connected | ControlFlag.Armed; pilot.throttle = 0.45; pilot.wallTimeMs = 100;
    let largest = 0, dragged = 0;
    for (let i = 1; i <= steps; i++) {
      calm.nowMs = 100; windy.nowMs = 100; calm.stepNow(pilot); windy.stepNow(pilot);
      const c = calm.state, w = windy.state, t = i * dt;
      for (const offset of [w.vn - c.vn - W[0], w.ve - c.ve - W[1], w.vd - c.vd - W[2], w.north - c.north - W[0] * t, w.east - c.east - W[1] * t,
        w.down - c.down - W[2] * t, w.qw - c.qw, w.qx - c.qx, w.qy - c.qy, w.qz - c.qz, w.p - c.p, w.q - c.q, w.r - c.r]) {
        largest = Math.max(largest, Math.abs(offset));
      }
      for (let k = 0; k < 6; k++) largest = Math.max(largest, Math.abs(windy.dragWrenchBody[k]! - calm.dragWrenchBody[k]!));
      dragged = Math.max(dragged, Math.hypot(calm.dragWrenchBody[0]!, calm.dragWrenchBody[1]!, calm.dragWrenchBody[2]!));
    }
    expect(dragged).toBeGreaterThan(1e-3);
    expect(largest).toBeLessThan(1e-9);
    calm.dispose(); windy.dispose();
  });
});
