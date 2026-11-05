import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { WEATHER_DISCRETE_DOWN, WEATHER_DISCRETE_DURATION, WEATHER_DISCRETE_EAST, WEATHER_DISCRETE_KEEP, WEATHER_DISCRETE_NORTH, WEATHER_SLOTS } from '@mirage/physics/atmosphere';
import { BetFlightDynamics } from '@mirage/physics/bet-dynamics';
import { DiscreteGust, discreteGustPeakNedMps } from '../packages/physics/src/discrete-gust.ts';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { createSessionFaultPort } from '@mirage/ew/session-port';
import {
  StateReaderV2, createSharedMemoryV2, createSpscQueue, effectiveControl, newFlightStateV2, newHeaderSnapshotV2, parseEffectControl, tickToNumber,
  type CommandResultV2, type EffectControl, type EffectiveControl,
} from '@mirage/protocol';
import { flightConfiguration } from './bet-runtime-fixture.ts';

// TASK-167: the discrete gust against its declared definition (SPECS_SIMULATION_ENGINES, "Weather tab: TASK-167"), written out here
// independently of the model: on the k-th tick of a pulse, at time t = k / f, u = g/2 (1 - cos(2 pi t / T)) while t <= T, and 0 after.
// Tolerances declared before the implementation: 1e-12 m/s on every tick at 400, 800 and 1200 Hz and between rates at common times.

const oracle = (peak: readonly number[], durationS: number, timeS: number): number[] =>
  peak.map(value => (timeS <= durationS ? (value / 2) * (1 - Math.cos((2 * Math.PI * timeS) / durationS)) : 0));
const slots = (peak: readonly number[], durationS: number, keep = 0): Float64Array => {
  const w = new Float64Array(WEATHER_SLOTS);
  w[WEATHER_DISCRETE_NORTH] = peak[0] ?? 0; w[WEATHER_DISCRETE_EAST] = peak[1] ?? 0; w[WEATHER_DISCRETE_DOWN] = peak[2] ?? 0;
  w[WEATHER_DISCRETE_DURATION] = durationS; w[WEATHER_DISCRETE_KEEP] = keep;
  return w;
};
/** The wind a pulse adds on each of `ticks` ticks, starting from still air. */
function pulse(hz: number, weather: Float64Array, ticks: number): number[][] {
  const gust = new DiscreteGust(hz), out: number[][] = [], wind = new Float64Array(3);
  expect(gust.configure(weather)).toBe(true);
  for (let k = 0; k < ticks; k++) { wind.fill(0); gust.stepAddInto(wind); out.push(Array.from(wind)); }
  return out;
}

describe('the discrete gust model (TASK-167)', () => {
  const peak = discreteGustPeakNedMps(8, 30, 15), durationS = 2.5;
  it('blows from its bearing, with a positive angle upward', () => {
    expect(discreteGustPeakNedMps(10, 0, 0).map(v => v + 0)).toEqual([-10, -0, -0].map(v => v + 0));
    const east = discreteGustPeakNedMps(10, 90, 0);
    expect(Math.abs(east[0])).toBeLessThan(1e-14); expect(east[1]).toBeCloseTo(-10, 14);
    expect(discreteGustPeakNedMps(10, 0, 90)[2]).toBe(-10);
    expect(Math.hypot(...peak)).toBeCloseTo(8, 13);
  });
  it.each([400, 800, 1200])('equals its analytic definition on every tick at %i Hz, rising to the peak at T/2 and back to zero at T', hz => {
    const ticks = Math.round(hz * (durationS + 0.5)), values = pulse(hz, slots(peak, durationS), ticks);
    let worst = 0;
    values.forEach((value, k) => {
      const expected = oracle(peak, durationS, k / hz);
      for (let axis = 0; axis < 3; axis++) worst = Math.max(worst, Math.abs((value[axis] ?? NaN) - (expected[axis] ?? NaN)));
    });
    expect(worst).toBeLessThan(1e-12);
    expect(values[0]).toEqual([0, 0, 0]);
    const half = values[Math.round(hz * durationS / 2)] ?? [];
    for (let axis = 0; axis < 3; axis++) expect(Math.abs((half[axis] ?? NaN) - (peak[axis] ?? NaN))).toBeLessThan(1e-12);
    // After the pulse it adds nothing at all.
    for (const value of values.slice(Math.floor(hz * durationS) + 1)) expect(value).toEqual([0, 0, 0]);
  });
  it('is the same at a common simulated time at every rate', () => {
    const at = (hz: number) => pulse(hz, slots(peak, durationS), Math.round(hz * durationS) + 1);
    const a = at(400), b = at(800), c = at(1200);
    for (let j = 0; j * 0.05 <= durationS; j++) {
      const t = j * 0.05, x = a[Math.round(t * 400)] ?? [], y = b[Math.round(t * 800)] ?? [], z = c[Math.round(t * 1200)] ?? [];
      for (let axis = 0; axis < 3; axis++) {
        expect(Math.abs((x[axis] ?? NaN) - (y[axis] ?? NaN))).toBeLessThan(1e-12);
        expect(Math.abs((x[axis] ?? NaN) - (z[axis] ?? NaN))).toBeLessThan(1e-12);
      }
    }
  });
  it('starts again on a new control, runs on through another weather change, stops when off, and refuses what is outside its envelope', () => {
    const gust = new DiscreteGust(400), wind = new Float64Array(3);
    const step = () => { wind.fill(0); gust.stepAddInto(wind); return wind[0] ?? NaN; };
    expect(gust.configure(slots([10, 0, 0], 1))).toBe(true);
    for (let k = 0; k < 100; k++) step();
    // Keep: the pulse goes on from tick 100.
    expect(gust.configure(slots([10, 0, 0], 1, 1))).toBe(true);
    expect(step()).toBeCloseTo(oracle([10], 1, 100 / 400)[0] ?? NaN, 12);
    // A new control: k = 0 again.
    expect(gust.configure(slots([10, 0, 0], 1))).toBe(true);
    expect(step()).toBe(0);
    expect(step()).toBeCloseTo(oracle([10], 1, 1 / 400)[0] ?? NaN, 12);
    // Off: nothing more, at once.
    expect(gust.configure(slots([0, 0, 0], 0))).toBe(true);
    expect(gust.running).toBe(false);
    expect(step()).toBe(0);
    // Outside the envelope: refused, and the state is unchanged.
    expect(gust.configure(slots([10, 0, 0], 1))).toBe(true);
    step();
    for (const bad of [slots([10, 0, 0], 0.05), slots([10, 0, 0], 61), slots([40, 40, 0], 2), slots([Number.NaN, 0, 0], 2), slots([10, 0, 0], Number.NaN)]) {
      expect(DiscreteGust.admits(bad)).toBe(false);
      expect(gust.configure(bad)).toBe(false);
    }
    expect(gust.running).toBe(true);
    expect(step()).toBeCloseTo(oracle([10], 1, 1 / 400)[0] ?? NaN, 12);
  });
});

describe('the discrete gust control (TASK-167)', () => {
  const control = (parameters: Record<string, number>, intensity = 1, enabled = true): EffectControl =>
    parseEffectControl({ schemaVersion: 1, id: 'gust-1', effect: 'wind.discrete-gust', enabled, intensity, parameters });
  const envelope = { requestId: 1, expectedEpoch: 0, atTick: { lo: 0, hi: 0 }, recovery: 'hold-offset' as const };
  const activeOf = (effective: EffectiveControl): boolean => effective.family === 'environment' && effective.active;
  it('scales the amplitude with intensity and reduces off and zero to inactive', () => {
    const at = (intensity: number, amplitude = 6) => effectiveControl(control({ amplitudeMps: amplitude, durationS: 2, fromDeg: 30, upwardDeg: 15 }, intensity), envelope);
    const full = at(1), half = at(0.5);
    if (full.family !== 'environment' || full.effect !== 'wind.discrete-gust' || half.family !== 'environment' || half.effect !== 'wind.discrete-gust') throw new Error('Not a discrete gust');
    expect(full.peakNedMps).toEqual(discreteGustPeakNedMps(6, 30, 15));
    for (let axis = 0; axis < 3; axis++) expect(half.peakNedMps[axis]).toBe((full.peakNedMps[axis] ?? NaN) / 2);
    expect(full.active).toBe(true);
    expect(activeOf(at(0))).toBe(false);
    expect(activeOf(at(1, 0))).toBe(false);
    const off = effectiveControl(control({ amplitudeMps: 6, durationS: 2, fromDeg: 30, upwardDeg: 15 }, 1, false), envelope);
    expect(activeOf(off)).toBe(false);
  });
  it('refuses values outside the catalog and an intensity that carries the amplitude past 50 m/s', () => {
    for (const [parameters, message] of [
      [{ amplitudeMps: 51, durationS: 2, fromDeg: 0, upwardDeg: 0 }, 'amplitudeMps'], [{ amplitudeMps: 5, durationS: 0.05, fromDeg: 0, upwardDeg: 0 }, 'durationS'],
      [{ amplitudeMps: 5, durationS: 2, fromDeg: 360, upwardDeg: 0 }, 'fromDeg'], [{ amplitudeMps: 5, durationS: 2, fromDeg: 0, upwardDeg: 91 }, 'upwardDeg'],
    ] as const) expect(() => control(parameters), message).toThrow(message);
    expect(() => effectiveControl(control({ amplitudeMps: 30, durationS: 2, fromDeg: 0, upwardDeg: 0 }, 2), envelope)).toThrow('amplitudeMps');
  });
});

let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600000);

/** A real session on the synthetic BET quad, stepped one tick at a time. */
function session(hz: 400 | 800 | 1200) {
  const time = { mono: 0 }, stateBuffer = createSharedMemoryV2(), built: BetFlightDynamics[] = [];
  const s = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer: createSpscQueue('actuator') },
    { monotonicMs: () => time.mono, wallMs: () => 1_790_000_000_000 + time.mono },
    rate => { const d = new BetFlightDynamics(module, flightConfiguration(), rate); built.push(d); return d; }, createSessionFaultPort());
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  const raw = (message: Record<string, unknown>) => {
    reader.readHeader(header);
    s.handle({ requestId: ++requestId, expectedEpoch: header.sessionEpoch, ...message });
    s.drain(result => results.push(result));
  };
  raw({ protocolVersion: 2, type: 'sim.configure', hz, clockMode: 'interactive' });
  raw({ protocolVersion: 2, type: 'sim.start' });
  const tick = () => (reader.latest(state) ? tickToNumber(state.tickId) : -1);
  const wind = () => Array.from(built.at(-1)?.windNedMps ?? []);
  const step = () => { const before = tick(); while (tick() === before) { time.mono += 0.05; s.pump(); } return tick(); };
  const effect = (atTick: number, control: EffectControl) => raw({ protocolVersion: 3, type: 'effect.set', atTick: { lo: atTick, hi: 0 }, control, recovery: 'hold-offset' });
  return { tick, wind, step, effect, results, state };
}
const gustControl = (enabled = true, amplitudeMps = 8): EffectControl =>
  parseEffectControl({ schemaVersion: 1, id: 'discrete-gust', effect: 'wind.discrete-gust', enabled, intensity: 1, parameters: { amplitudeMps, durationS: 0.5, fromDeg: 0, upwardDeg: 20 } });

describe('the discrete gust in a flight session (TASK-167)', () => {
  it.each([400, 800, 1200] as const)('adds its pulse to the wind the rotors see, from the tick it takes effect, at %i Hz', hz => {
    const h = session(hz), peak = discreteGustPeakNedMps(8, 0, 20);
    while (h.tick() < 5) h.step();
    h.effect(10, gustControl());
    const seen: { tick: number; wind: number[] }[] = [];
    while (h.tick() < 10 + hz) { const tick = h.step(); seen.push({ tick, wind: h.wind() }); }
    // The wind of a tick is what its step used: k = tick - 10 on and after the tick it took effect, and nothing before.
    let worst = 0;
    for (const { tick, wind } of seen) {
      const expected = tick < 10 ? [0, 0, 0] : oracle(peak, 0.5, (tick - 10) / hz);
      for (let axis = 0; axis < 3; axis++) worst = Math.max(worst, Math.abs((wind[axis] ?? NaN) - (expected[axis] ?? NaN)));
    }
    expect(worst).toBeLessThan(1e-12);
    expect(seen.some(row => Math.abs(row.wind[0] ?? 0) > 7)).toBe(true);
  });
  it('is bitwise absent when off or never on, and a second control starts a new pulse', () => {
    const run = (send: (h: ReturnType<typeof session>) => void) => {
      const h = session(400);
      send(h);
      const rows: number[] = [];
      while (h.tick() < 400) { h.step(); rows.push(...h.wind(), h.state.northM, h.state.vnMps, h.state.qw, h.state.trueAirspeedMps); }
      return Float64Array.from(rows);
    };
    const absent = run(() => undefined), off = run(h => { h.effect(5, gustControl(false)); }), zero = run(h => { h.effect(5, gustControl(true, 0)); });
    const same = (a: Float64Array, b: Float64Array) => Buffer.from(a.buffer).equals(Buffer.from(b.buffer));
    expect(same(off, absent)).toBe(true);
    expect(same(zero, absent)).toBe(true);
    expect(same(run(h => { h.effect(5, gustControl()); }), absent)).toBe(false);
    // Again at tick 100: the wind at tick 100 is k = 0, zero, and at tick 101 it is the first tick of a pulse again.
    const h = session(400);
    h.effect(5, gustControl());
    h.effect(100, gustControl());
    const at = new Map<number, number[]>();
    while (h.tick() < 120) { const tick = h.step(); at.set(tick, h.wind()); }
    expect(at.get(100)).toEqual([0, 0, 0].map(v => v + 0));
    const first = oracle(discreteGustPeakNedMps(8, 0, 20), 0.5, 1 / 400);
    for (let axis = 0; axis < 3; axis++) expect(Math.abs((at.get(101)?.[axis] ?? NaN) - (first[axis] ?? NaN))).toBeLessThan(1e-12);
  });
});
