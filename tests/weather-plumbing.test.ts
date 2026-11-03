import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { AIR_DENSITY, AIR_PRESSURE, AIR_SOUND, AIR_VISCOSITY, WEATHER_GUST_RMS, WEATHER_PRESSURE, WEATHER_SEED, WEATHER_SLOTS,
  WEATHER_TEMPERATURE, WEATHER_WIND_DOWN, WEATHER_WIND_EAST, WEATHER_WIND_NORTH } from '@mirage/physics/atmosphere';
import { BetFlightDynamics, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { PhysicsSessionV2, isaPressurePa } from '../packages/physics/src/session-v2.ts';
import { ControlFlag, RuntimeFlagV2, StateReaderV2, createSharedMemoryV2, createSpscQueue, newFlightStateV2, newHeaderSnapshotV2, newInput,
  tickToNumber, type CommandResultV2, type FlightStateV2 } from '@mirage/protocol';
import { flightConfiguration } from './bet-runtime-fixture.ts';

// TASK-093: weather.set through the real PhysicsSessionV2 on the synthetic BET quad of tests/bet-runtime-fixture.ts.
// Oracles: the ICAO troposphere's defining equations written here independently of atmosphere.ts, the scheduled tick
// of each command, Galilean invariance (aerodynamics see only the velocity relative to the air), and the seeded gust.

let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600000);

/** The ICAO troposphere above the origin, p = p0 exp(g / (R L) ln(1 - L h / T0)), and its density. */
function troposphere(temperatureK: number, pressurePa: number, heightM: number) {
  const R = 287.05287, L = 0.0065, g = 9.80665;
  const p = pressurePa * Math.exp(g / (R * L) * Math.log1p(-L * heightM / temperatureK));
  return { pressurePa: p, densityKgM3: p / (R * (temperatureK - L * heightM)) };
}
const relative = (actual: number | undefined, expected: number) => Math.abs((actual ?? NaN) / expected - 1);
const weatherOf = (windNedMps: readonly [number, number, number], temperatureK: number, pressurePa: number, gustRmsMps = 0, seed = 0) => {
  const w = new Float64Array(WEATHER_SLOTS);
  w[WEATHER_WIND_NORTH] = windNedMps[0]; w[WEATHER_WIND_EAST] = windNedMps[1]; w[WEATHER_WIND_DOWN] = windNedMps[2];
  w[WEATHER_GUST_RMS] = gustRmsMps; w[WEATHER_SEED] = seed; w[WEATHER_TEMPERATURE] = temperatureK; w[WEATHER_PRESSURE] = pressurePa;
  return w;
};
const weatherSet = (atTick: number, windNedMps: readonly [number, number, number], temperatureK: number, pressurePa: number,
  turbulenceRmsMps = 0, seed = 0) => ({ atTick: { lo: atTick, hi: 0 }, windNedMps, temperatureK, pressurePa, turbulenceRmsMps, seed });

/** A real session on the BET quad with a controllable clock; `dynamics()` is the instance of the current epoch. */
function harness(configure?: (configuration: BetFlightConfiguration) => void) {
  const time = { mono: 0, wall: 1_790_000_000_000 };
  const stateBuffer = createSharedMemoryV2(), sensorBuffer = createSpscQueue('sensor'), actuatorBuffer = createSpscQueue('actuator');
  const built: BetFlightDynamics[] = [];
  const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer, actuatorBuffer },
    { monotonicMs: () => time.mono, wallMs: () => time.wall + time.mono }, hz => {
      const configuration = flightConfiguration();
      configure?.(configuration);
      const dynamics = new BetFlightDynamics(module, configuration, hz);
      built.push(dynamics);
      return dynamics;
    });
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  const command = (type: string, extra: Record<string, unknown> = {}) => {
    reader.readHeader(header);
    session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
    session.drain(result => results.push(result));
    return results.at(-1);
  };
  const tick = () => { expect(reader.latest(state)).toBe(true); return tickToNumber(state.tickId); };
  /** Pumps wakeups of `wakeMs()` until tick `target` is published, never past it; returns the published state. */
  const runTo = (target: number, wakeMs: () => number = () => 0.1): FlightStateV2 => {
    for (let guard = 0; tick() < target; guard++) {
      if (guard > 1_000_000) throw new Error(`The session did not reach tick ${target}`);
      // Finish with small wakeups so that a wakeup never runs past the target (the catch-up cap is 8 ticks).
      time.mono += target - tick() > 8 ? wakeMs() : 0.1;
      session.pump();
    }
    expect(tickToNumber(state.tickId)).toBe(target);
    session.drain(result => results.push(result));
    return state;
  };
  const dynamics = (): BetFlightDynamics => {
    const last = built.at(-1);
    if (!last) throw new Error('No dynamics was built');
    return last;
  };
  return { time, session, reader, header, state, results, command, tick, runTo, dynamics };
}
const requestIdOf = (result: CommandResultV2 | undefined) => result && result.type !== 'ready-v2' ? result.requestId : -1;
const applied = (results: readonly CommandResultV2[], requestId: number) =>
  results.find(result => result.type === 'ack-v2' && result.requestId === requestId && result.status === 'applied');

describe('weather.set on the BET session', () => {
  it('applies on its exact tick in every epoch, sets the air the rotors see and the published airspeed and pressure, and a new epoch clears it', () => {
    const h = harness();
    expect(h.command('sim.start')).toMatchObject({ status: 'applied' });
    const configured = Array.from(h.dynamics().atmosphere);
    let epochs = 0;
    for (const begin of [() => undefined, () => h.command('sim.reset', { seed: 3 }), () => h.command('sim.configure', { hz: 800, clockMode: 'interactive' }),
      () => h.command('sim.configure', { hz: 1200, clockMode: 'interactive' })]) {
      if (epochs > 0) {
        expect(h.command('sim.pause')).toMatchObject({ status: 'applied' });
        expect(begin()).toMatchObject({ status: 'applied' });
        expect(h.command('sim.start')).toMatchObject({ status: 'applied' });
      }
      epochs++;
      const d = h.dynamics(), at = 7 + epochs * 4, wind = [3, -2, 0.5] as const;
      // A new epoch starts without weather: the configured air, no wind, still-air airspeed and the standard atmosphere's pressure.
      expect(d.weatherActive).toBe(false);
      expect(Array.from(d.atmosphere)).toEqual(configured);
      const queued = h.command('weather.set', weatherSet(at, wind, 293.15, 98000));
      expect(queued).toMatchObject({ type: 'ack-v2', status: 'queued' });
      const requestId = requestIdOf(queued);
      let s = h.runTo(at - 1);
      expect(h.session.wind.active).toBe(false);
      expect(Array.from(d.windNedMps)).toEqual([0, 0, 0]);
      expect(Array.from(d.atmosphere)).toEqual(configured);
      expect(s.trueAirspeedMps).toBe(Math.fround(Math.hypot(d.state.vn, d.state.ve, d.state.vd)));
      expect(s.ambientPressurePa).toBe(Math.fround(isaPressurePa(-d.state.down)));
      expect(applied(h.results, requestId)).toBeUndefined();

      s = h.runTo(at);
      expect(applied(h.results, requestId)).toMatchObject({ appliedTick: { lo: at, hi: 0 }, epoch: h.session.currentEpoch });
      expect(h.session.wind.active).toBe(true);
      // No gust: the wind is the mean exactly, at the CG and every rotor hub.
      expect(Array.from(h.session.wind.nedMps)).toEqual([3, -2, 0.5]);
      // The air after the step at the CG's height above the origin, which the next step's rotors read.
      const air = troposphere(293.15, 98000, -d.state.down);
      expect(relative(d.air[AIR_PRESSURE], air.pressurePa)).toBeLessThan(1e-9);
      expect(relative(d.air[AIR_DENSITY], air.densityKgM3)).toBeLessThan(1e-9);
      expect([d.atmosphere[0], d.atmosphere[1], d.atmosphere[2]]).toEqual([d.air[AIR_DENSITY], d.air[AIR_VISCOSITY], d.air[AIR_SOUND]]);
      expect(relative(s.ambientPressurePa, air.pressurePa)).toBeLessThan(1e-7);
      expect(s.trueAirspeedMps).toBe(Math.fround(Math.hypot(d.state.vn - 3, d.state.ve + 2, d.state.vd - 0.5)));
      // Every later tick reads the air at its own height.
      s = h.runTo(at + 40);
      expect(relative(d.air[AIR_PRESSURE], troposphere(293.15, 98000, -d.state.down).pressurePa)).toBeLessThan(1e-9);
      expect(relative(s.ambientPressurePa, troposphere(293.15, 98000, -d.state.down).pressurePa)).toBeLessThan(1e-7);
    }
    expect(epochs).toBe(4);
    expect(h.dynamics().hz).toBe(1200);
  });

  it('rejects air outside the model envelope at its tick with OUT_OF_RANGE and faults the session until a new epoch', () => {
    const h = harness();
    h.command('sim.start');
    // Admission accepts up to 340 K (TASK-166 aligns the ranges); the atmosphere envelope ends at 330 K.
    const queued = h.command('weather.set', weatherSet(5, [1, 0, 0], 335, 101325));
    expect(queued).toMatchObject({ status: 'queued' });
    h.runTo(5);
    const reject = h.results.find(result => result.type === 'reject-v2' && result.requestId === requestIdOf(queued));
    expect(reject).toMatchObject({ code: 'OUT_OF_RANGE' });
    expect(reject?.type === 'reject-v2' ? reject.message : '').toContain('atmosphere envelope');
    h.reader.readHeader(h.header);
    expect(h.header.runtimeFlags & RuntimeFlagV2.Fault).toBeTruthy();
    expect(h.dynamics().weatherActive).toBe(false);
    expect(h.command('sim.start')).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    expect(h.command('sim.reset', { seed: 1 })).toMatchObject({ status: 'applied' });
    expect(h.command('sim.start')).toMatchObject({ status: 'applied' });
    h.runTo(3);
    h.reader.readHeader(h.header);
    expect(h.header.runtimeFlags & RuntimeFlagV2.Fault).toBe(0);
  });

  it('replays the same seeded gust and trajectory whatever the wall pacing, and another seed gives another gust', () => {
    const run = (wakeMs: () => number, seed: number) => {
      const h = harness();
      h.command('sim.start');
      h.command('weather.set', weatherSet(10, [2, 1, 0], 288.15, 101325, 1.5, seed));
      const s = h.runTo(400, wakeMs);
      return { position: [s.northM, s.eastM, s.downM], velocity: [s.vnMps, s.veMps, s.vdMps], attitude: [s.qw, s.qx, s.qy, s.qz],
        rates: [s.pRadS, s.qRadS, s.rRadS], air: [s.trueAirspeedMps, s.ambientPressurePa], wind: Array.from(h.session.wind.nedMps) };
    };
    // Fine wakeups (one tick per 25), 10 ms wakeups (four ticks each) and irregular ones (up to six ticks each).
    let lcg = 12345;
    const irregular = () => { lcg = (lcg * 1103515245 + 12345) % 2147483648; return 0.05 + 15 * lcg / 2147483648; };
    const fine = run(() => 0.1, 0xfffffffe), coarse = run(() => 10, 0xfffffffe), uneven = run(irregular, 0xfffffffe);
    expect(coarse).toEqual(fine);
    expect(uneven).toEqual(fine);
    const other = run(() => 0.1, 12345);
    expect(other.wind).not.toEqual(fine.wind);
    expect(other.position).not.toEqual(fine.position);
  });
});

describe('BetFlightDynamics weather', () => {
  /** A step at a fixed input time with the given pilot. */
  const pilotOf = (throttle: number) => {
    const pilot = newInput();
    pilot.flags = throttle > 0 ? ControlFlag.Connected | ControlFlag.Armed : 0; pilot.throttle = throttle; pilot.wallTimeMs = 100;
    return pilot;
  };

  it('flies a constant wind as the same flight in calm air seen from a frame that moves with the wind', () => {
    // Galilean invariance: the rotors see only the velocity relative to the air, so a vehicle launched at the wind's velocity
    // flies the calm-air flight offset by the wind: ground velocity + W, position + W t, the same airspeed and attitude.
    const W = [4, -3, 0] as const, steps = 400, dt = 1 / 400;
    const calmConfiguration = flightConfiguration(), windConfiguration = flightConfiguration();
    windConfiguration.initialBody.velocityNedMps.set(W);
    const calm = new BetFlightDynamics(module, calmConfiguration, 400), windy = new BetFlightDynamics(module, windConfiguration, 400);
    expect(calm.setWeather(weatherOf([0, 0, 0], 288.15, 101325))).toBeNull();
    expect(windy.setWeather(weatherOf(W, 288.15, 101325))).toBeNull();
    const pilot = pilotOf(0.45);
    let largest = 0;
    for (let i = 1; i <= steps; i++) {
      calm.nowMs = 100; windy.nowMs = 100; calm.stepNow(pilot); windy.stepNow(pilot);
      expect(windy.fault).toBe('');
      const c = calm.state, w = windy.state, t = i * dt;
      const offsets = [w.vn - c.vn - W[0], w.ve - c.ve - W[1], w.vd - c.vd - W[2], w.north - c.north - W[0] * t, w.east - c.east - W[1] * t,
        w.down - c.down - W[2] * t, w.qw - c.qw, w.qx - c.qx, w.qy - c.qy, w.qz - c.qz, w.p - c.p, w.q - c.q, w.r - c.r,
        Math.hypot(w.vn - W[0], w.ve - W[1], w.vd - W[2]) - Math.hypot(c.vn, c.ve, c.vd)];
      for (const offset of offsets) largest = Math.max(largest, Math.abs(offset));
    }
    // The flight is not trivial: it climbs and turns the rotors, so the comparison covers aerodynamics in motion.
    expect(Math.abs(calm.state.vd)).toBeGreaterThan(0.1);
    // Floating-point rounding of (W - v) only: about 1e-15 m/s per step.
    expect(largest).toBeLessThan(1e-9);
    calm.dispose(); windy.dispose();
  });

  it('pushes an idle vehicle downwind: the ground speed grows toward the wind and the airspeed falls', () => {
    // Zero gravity and rotors at rest without torque: the rotors' aerodynamic force in the relative wind is the only force,
    // so the sign of its along-wind part is the coupling's sign. (The cambered blades at rest also lift in the cross flow.)
    const configuration = flightConfiguration();
    configuration.gravityMps2 = 0; configuration.initialOmegaRadS = [0, 0, 0, 0];
    const d = new BetFlightDynamics(module, configuration, 400), pilot = pilotOf(0);
    expect(d.setWeather(weatherOf([5, 0, 0], 288.15, 101325))).toBeNull();
    const horizontalAirspeed = () => Math.hypot(d.state.vn - 5, d.state.ve);
    d.nowMs = 100; d.stepNow(pilot);
    const first = horizontalAirspeed();
    expect(first).toBeCloseTo(5, 3);
    const northAt = [0, 0];
    for (let second = 0; second < 2; second++) {
      for (let i = 0; i < 400; i++) { d.nowMs = 100; d.stepNow(pilot); }
      northAt[second] = d.state.vn;
    }
    expect(d.fault).toBe('');
    // Downwind and still gaining: a steady push along the wind, none across it, and the vehicle stays level.
    expect(northAt[0]).toBeGreaterThan(0);
    expect(northAt[1]).toBeGreaterThan(1.5 * (northAt[0] ?? 0));
    expect(Math.abs(d.state.ve)).toBeLessThan(1e-9);
    expect(d.state.qw).toBeCloseTo(1, 9);
    expect(horizontalAirspeed()).toBeLessThan(first);
    d.dispose();
  });

  it('refuses wind or air outside the envelopes without changing anything, and faults when the vehicle leaves the envelope', () => {
    const configuration = flightConfiguration();
    configuration.initialBody.positionNedM[2] = -3500;
    const d = new BetFlightDynamics(module, configuration, 400), before = Array.from(d.atmosphere);
    for (const weather of [weatherOf([201, 0, 0], 288.15, 101325), weatherOf([0, NaN, 0], 288.15, 101325), weatherOf([0, 0, 0], 288.15, 101325, 51),
      weatherOf([0, 0, 0], 288.15, 101325, 1, 2 ** 32), weatherOf([0, 0, 0], 288.15, 101325, 1, 1.5), weatherOf([0, 0, 0], 288.15, 101325, -1)]) {
      expect(d.setWeather(weather)).toContain('gust model envelope');
    }
    // 335 K at the origin, and 200 K at the origin but 177 K where the vehicle flies, 3500 m above it.
    for (const weather of [weatherOf([0, 0, 0], 335, 101325), weatherOf([0, 0, 0], 200, 101325), weatherOf([0, 0, 0], 288.15, NaN)]) {
      expect(d.setWeather(weather)).toContain('atmosphere envelope');
    }
    expect(d.weatherActive).toBe(false);
    expect(Array.from(d.atmosphere)).toEqual(before);
    d.dispose();
    // At 330 K the vehicle falls below the origin, where the air is hotter than the envelope: the step faults.
    const hot = flightConfiguration();
    hot.initialBody.positionNedM[2] = -0.001;
    const falling = new BetFlightDynamics(module, hot, 400), pilot = pilotOf(0);
    expect(falling.setWeather(weatherOf([0, 0, 0], 330, 101325))).toBeNull();
    for (let i = 0; i < 400 && falling.fault === ''; i++) { falling.nowMs = 100; falling.stepNow(pilot); }
    expect(falling.fault).toBe('BET atmosphere outside its envelope');
    expect(falling.state.down).toBeGreaterThan(0);
    falling.dispose();
  });

  it('returns after reset to the configured air and no wind, bit for bit', () => {
    const fresh = new BetFlightDynamics(module, flightConfiguration(), 400), reset = new BetFlightDynamics(module, flightConfiguration(), 400);
    const pilot = pilotOf(0.4);
    expect(reset.setWeather(weatherOf([6, 2, -1], 300, 95000, 3, 99))).toBeNull();
    for (let i = 0; i < 100; i++) { reset.nowMs = 100; reset.stepNow(pilot); }
    reset.reset();
    expect(reset.weatherActive).toBe(false);
    for (let i = 0; i < 200; i++) { fresh.nowMs = 100; reset.nowMs = 100; fresh.stepNow(pilot); reset.stepNow(pilot); }
    expect(reset.state).toEqual(fresh.state);
    expect(reset.atmosphere).toEqual(fresh.atmosphere);
    expect(Array.from(reset.windNedMps)).toEqual([0, 0, 0]);
    fresh.dispose(); reset.dispose();
  });
});
