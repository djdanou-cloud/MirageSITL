import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { AIR_PRESSURE, WEATHER_GUST_BANDWIDTH, WEATHER_GUST_RMS, WEATHER_SEED, WEATHER_SLOTS } from '@mirage/physics/atmosphere';
import { BetFlightDynamics, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { MotorFaults } from '@mirage/physics/motor-fault';
import { Wind } from '@mirage/physics/wind';
import { EwEngine, type EwContext, type FaultCommand } from '@mirage/ew/engine';
import { GpsOffsetApplier } from '@mirage/ew/position-step';
import { createSessionFaultPort } from '@mirage/ew/session-port';
import { SensorPipeline } from '@mirage/sensors/pipeline';
import type { GpsSample, ImuSample } from '@mirage/mavlink/samples';
import {
  EFFECT_CATALOG, EFFECT_IDS, EwFlagV2, ISA_PRESSURE_PA, ISA_TEMPERATURE_K, StateReaderV2, createSharedMemoryV2, createSpscQueue, effectiveControl, migrateWeatherSet, newFlightStateV2,
  newHeaderSnapshotV2, parseEffectControl, tickToNumber, type CommandResultV2, type EffectControl, type EffectId, type EffectParameterValue, type EffectRecovery,
} from '@mirage/protocol';
import { ScenarioBinder } from '../packages/scenarios/src/bind.ts';
import { parseScenario } from '../packages/scenarios/src/schema.ts';
import { PhysicsSessionV2, isaPressurePa } from '../packages/physics/src/session-v2.ts';
import { flightConfiguration } from './bet-runtime-fixture.ts';

// TASK-166 through the real PhysicsSessionV2 on the synthetic BET quad with the production fault port. Oracles: the trace of a run with
// no control sent (compared bit by bit), the arithmetic of each intensity's definition and the ICAO troposphere written out here, the
// gust's stationary variance, and the tick stated in each command.

let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600000);

type Parameters = Record<string, EffectParameterValue>;
const record = (effect: EffectId, parameters: Parameters, intensity = 1, enabled = true, id = effect.replaceAll('.', '-')): EffectControl =>
  ({ schemaVersion: 1, id, effect, enabled, intensity, parameters });

/** A real session with a controllable clock; `dynamics()` is the instance of the current epoch. */
function harness(configure?: (configuration: BetFlightConfiguration) => void) {
  const time = { mono: 0, wall: 1_790_000_000_000 };
  const stateBuffer = createSharedMemoryV2(), built: BetFlightDynamics[] = [];
  const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer: createSpscQueue('actuator') },
    { monotonicMs: () => time.mono, wallMs: () => time.wall + time.mono }, hz => {
      const configuration = flightConfiguration();
      configure?.(configuration);
      const dynamics = new BetFlightDynamics(module, configuration, hz);
      built.push(dynamics);
      return dynamics;
    }, createSessionFaultPort());
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  const raw = (message: Record<string, unknown>) => {
    reader.readHeader(header);
    session.handle({ requestId: ++requestId, expectedEpoch: header.sessionEpoch, ...message });
    session.drain(result => results.push(result));
    return results.at(-1);
  };
  const lifecycle = (type: string, extra: Record<string, unknown> = {}) => raw({ protocolVersion: 2, type, ...extra });
  const control = (atTick: number, value: EffectControl, recovery: EffectRecovery = 'hold-offset') =>
    raw({ protocolVersion: 3, type: 'effect.set', atTick: { lo: atTick, hi: 0 }, control: value, recovery });
  const tick = () => { expect(reader.latest(state)).toBe(true); return tickToNumber(state.tickId); };
  const dynamics = (): BetFlightDynamics => {
    const last = built.at(-1);
    if (!last) throw new Error('No dynamics was built');
    return last;
  };
  /** Every number the run publishes, the air and the wind the rotors see, at tick `target`. */
  const snapshot = (): number[] => {
    const d = dynamics();
    return [state.northM, state.eastM, state.downM, state.vnMps, state.veMps, state.vdMps, state.qw, state.qx, state.qy, state.qz, state.pRadS, state.qRadS, state.rRadS,
      state.trueAirspeedMps, state.ambientPressurePa, state.ewFlags, state.vehicleFlags, state.referenceRotorRpm, ...d.atmosphere, ...d.windNedMps, session.wind.active ? 1 : 0];
  };
  const runTo = (target: number, onTick?: (tickNow: number) => void) => {
    for (let guard = 0; tick() < target; guard++) {
      if (guard > 1_000_000) throw new Error(`The session did not reach tick ${target}`);
      // One tick at a time, so `onTick` sees every one.
      const before = tick();
      while (tick() === before) { time.mono += 0.1; session.pump(); }
      onTick?.(tick());
    }
    session.drain(result => results.push(result));
  };
  const trace = (target: number) => {
    const rows: number[] = [];
    runTo(target, () => rows.push(...snapshot()));
    return Float64Array.from(rows);
  };
  return { session, reader, header, state, results, raw, lifecycle, control, tick, dynamics, snapshot, runTo, trace, time };
}
const bytes = (values: Float64Array) => Buffer.from(values.buffer, values.byteOffset, values.byteLength);
const appliedTick = (results: readonly CommandResultV2[], requestId: number) => {
  const ack = results.find(result => result.type === 'ack-v2' && result.requestId === requestId && result.status === 'applied');
  return ack?.type === 'ack-v2' ? tickToNumber(ack.appliedTick) : null;
};
const requestIdOf = (result: CommandResultV2 | undefined): number => (result && result.type !== 'ready-v2' ? result.requestId : -1);

/** Each effect a session can apply, with values large enough to change the run. */
const APPLICABLE: readonly (readonly [EffectId, Parameters])[] = [
  ['wind.mean', { windNedMps: [6, -3, 1] }],
  ['wind.gust', { rmsMps: 2, bandwidthHz: 2, seed: 77 }],
  ['wind.turbulence', { w20Mps: 8, seed: 78 }],
  ['wind.discrete-gust', { amplitudeMps: 6, durationS: 2, fromDeg: 90, upwardDeg: 10 }],
  ['atmosphere', { temperatureK: 300, pressurePa: 95000 }],
  ['ew.gnss-jamming', { severity: 1 }],
  ['ew.position-step', { offsetNedM: [100, 0, 0] }],
  ['ew.velocity-drift', { accelerationNedMps2: [0.2, 0, 0], maxSpeedMps: 2 }],
  ['ew.magnetic', { rotationRad: [0, 0, 0.5], biasBodyGauss: [0, 0, 0] }],
  ['motor.loss', { motorIndex: 1, mode: 'instant-thrust-loss', remainingThrustFraction: 0.5 }],
];
const TICKS = 300;

describe('an effect that is off or at zero intensity', () => {
  it('names every effect in the catalog that is not a sensor error', () => {
    // The rotor ground effect needs the ESC drive, which this harness does not have: tests/rotor-ground-effect.test.ts holds it to the same rule.
    expect(APPLICABLE.map(([id]) => id).sort()).toEqual(EFFECT_IDS.filter(id => id !== 'rotor.ground-effect').filter(id => EFFECT_CATALOG[id].family === 'environment' || EFFECT_CATALOG[id].family === 'fault').sort());
  });

  const runOf = (send: (h: ReturnType<typeof harness>) => void) => {
    const h = harness();
    h.lifecycle('sim.start');
    send(h);
    return { h, values: h.trace(TICKS) };
  };

  it.each(APPLICABLE)('%s: identical to absent, bit for bit, over a seeded run; on, it changes the run', (effect, parameters) => {
    const absent = runOf(() => undefined).values;
    for (const off of [record(effect, parameters, 1, false), record(effect, parameters, 0)]) {
      let id = -1;
      const run = runOf(h => { id = requestIdOf(h.control(5, off)); });
      expect(bytes(run.values).equals(bytes(absent)), JSON.stringify(off)).toBe(true);
      // Acknowledged like any other: on its tick, and it reached the session.
      expect(appliedTick(run.h.results, id)).toBe(5);
    }
    // The comparison is not vacuous: the same control, on, changes what the run publishes.
    const on = runOf(h => { h.control(5, record(effect, parameters)); }).values;
    expect(bytes(on).equals(bytes(absent))).toBe(false);
  });

  it('is identical to absent beside effects that are on, too', () => {
    const baseline = (h: ReturnType<typeof harness>) => {
      h.control(5, record('wind.gust', { rmsMps: 2, bandwidthHz: 2, seed: 9 }));
      h.control(5, record('ew.position-step', { offsetNedM: [50, 0, 0] }));
      h.control(8, record('motor.loss', { motorIndex: 2, mode: 'instant-thrust-loss', remainingThrustFraction: 0.8 }));
    };
    const absent = runOf(baseline).values;
    for (const [effect, parameters] of APPLICABLE) {
      if (effect === 'wind.gust') continue;
      // Sent before, on and after the baseline's tick: an instance of its own, never one the baseline owns.
      const id = `${effect.replaceAll('.', '-')}-off`;
      const run = runOf(h => {
        h.control(4, record(effect, parameters, 1, false, id));
        baseline(h);
        h.control(5, record(effect, parameters, 0, true, id));
        h.control(20, record(effect, parameters, 1, false, id));
      }).values;
      expect(bytes(run).equals(bytes(absent)), effect).toBe(true);
    }
  });

  it('returns the air and the wind to what they were when the last environment effect goes off', () => {
    const h = harness();
    h.lifecycle('sim.start');
    const configured = Array.from(h.dynamics().atmosphere);
    h.control(5, record('wind.mean', { windNedMps: [6, 0, 0] }));
    h.control(5, record('atmosphere', { temperatureK: 300, pressurePa: 95000 }));
    h.control(20, record('wind.mean', { windNedMps: [6, 0, 0] }, 1, false));
    h.runTo(19);
    expect(h.dynamics().weatherActive).toBe(true);
    expect(h.dynamics().atmosphere[0]).not.toBe(configured[0]);
    h.runTo(20);
    // The wind has gone and the air has stayed.
    expect(Array.from(h.dynamics().windNedMps)).toEqual([0, 0, 0]);
    expect(h.dynamics().atmosphere[0]).not.toBe(configured[0]);
    h.control(30, record('atmosphere', { temperatureK: 300, pressurePa: 95000 }, 0));
    h.runTo(29);
    expect(h.dynamics().weatherActive).toBe(true);
    h.runTo(30);
    expect(h.dynamics().weatherActive).toBe(false);
    expect(h.session.wind.active).toBe(false);
    expect(Array.from(h.dynamics().atmosphere)).toEqual(configured);
    h.runTo(40);
    expect(Array.from(h.dynamics().atmosphere)).toEqual(configured);
    // The state record holds the pressure in 32 bits.
    expect(h.state.ambientPressurePa).toBe(Math.fround(isaPressurePa(-h.dynamics().state.down)));
  });

  it('never brings back a gust from before it went off', () => {
    const h = harness();
    h.lifecycle('sim.start');
    h.control(5, record('wind.gust', { rmsMps: 5, bandwidthHz: 1, seed: 3 }));
    h.control(50, record('wind.gust', { rmsMps: 5, bandwidthHz: 1, seed: 3 }, 1, false));
    h.control(60, record('wind.mean', { windNedMps: [2, 1, 0] }));
    h.runTo(49);
    expect(Math.abs(h.dynamics().windNedMps[0] ?? 0)).toBeGreaterThan(0);
    h.runTo(60);
    expect(Array.from(h.dynamics().windNedMps)).toEqual([2, 1, 0]);
    h.runTo(70);
    expect(Array.from(h.dynamics().windNedMps)).toEqual([2, 1, 0]);
  });
});

describe('each effect keeps to itself', () => {
  it('wind alone leaves the configured air in place, and the published pressure as still air has it', () => {
    const h = harness(configuration => { configuration.densityKgM3 = 1.05; configuration.soundMps = 335; });
    h.lifecycle('sim.start');
    h.control(5, record('wind.mean', { windNedMps: [4, 0, 0] }));
    h.runTo(100);
    expect(Array.from(h.dynamics().atmosphere)).toEqual([1.05, 1.789e-5, 335]);
    expect(h.state.ambientPressurePa).toBe(Math.fround(isaPressurePa(-h.dynamics().state.down)));
    expect(h.dynamics().windNedMps[0]).toBe(4);
  });
  it('the air alone brings no wind', () => {
    const h = harness();
    h.lifecycle('sim.start');
    h.control(5, record('atmosphere', { temperatureK: 300, pressurePa: 95000 }));
    h.runTo(100);
    expect(Array.from(h.dynamics().windNedMps)).toEqual([0, 0, 0]);
    expect(h.state.ambientPressurePa).toBe(Math.fround(h.dynamics().air[AIR_PRESSURE] ?? NaN));
    expect(h.state.ambientPressurePa).not.toBe(Math.fround(isaPressurePa(-h.dynamics().state.down)));
  });
  it('a new mean wind or new air leaves a running gust alone; a change of the gust starts it again from its seed', () => {
    const gust = record('wind.gust', { rmsMps: 2, bandwidthHz: 1, seed: 21 }), steady = harness(), changed = harness(), restarted = harness();
    for (const h of [steady, changed, restarted]) { h.lifecycle('sim.start'); h.control(5, gust); }
    changed.control(40, record('wind.mean', { windNedMps: [3, 0, -1] }));
    changed.control(60, record('atmosphere', { temperatureK: 300, pressurePa: 95000 }));
    restarted.control(40, gust);
    const series = (h: ReturnType<typeof harness>) => {
      const rows: number[][] = [];
      h.runTo(80, tick => rows.push([tick, ...h.dynamics().windNedMps]));
      return rows;
    };
    const a = series(steady), b = series(changed), c = series(restarted);
    for (let i = 0; i < a.length; i++) {
      const tick = a[i]?.[0] ?? 0, mean = tick >= 40 ? [3, 0, -1] : [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) expect(Math.abs((b[i]?.[axis + 1] ?? NaN) - mean[axis]! - (a[i]?.[axis + 1] ?? NaN)), `tick ${tick}`).toBeLessThan(1e-12);
    }
    // Started again at 40, it is the gust of tick 5 thirty-five ticks later.
    expect(c.find(row => row[0] === 40 + 10)?.slice(1)).toEqual(a.find(row => row[0] === 5 + 10)?.slice(1));
    expect(c.find(row => row[0] === 50)?.slice(1)).not.toEqual(a.find(row => row[0] === 50)?.slice(1));
  });
  it('turbulence adds to the wind, keeps running through a new mean wind, starts again on its own control, and replays whatever the wall pacing', () => {
    const turbulence = record('wind.turbulence', { w20Mps: 8, seed: 31 });
    const calm = harness(), steady = harness();
    for (const h of [calm, steady]) { h.lifecycle('sim.start'); h.control(5, turbulence); }
    calm.control(40, record('wind.mean', { windNedMps: [6, 0, 0] }));
    const series = (h: ReturnType<typeof harness>, end: number) => {
      const rows: { tick: number; wind: number[]; rms: number }[] = [];
      h.runTo(end, tick => rows.push({ tick, wind: Array.from(h.dynamics().windNedMps), rms: 0 }));
      return rows;
    };
    const a = series(calm, 39), b = series(steady, 39);
    // Before the mean wind arrives the two runs are one run.
    expect(a).toEqual(b);
    expect(a.find(row => row.tick === 4)?.wind).toEqual([0, 0, 0]);
    expect(Math.hypot(...(a.find(row => row.tick === 5)?.wind ?? []))).toBeGreaterThan(0);
    // It keeps its state: the first tick of the new wind continues the turbulence rather than starting it again from the seed.
    const started = harness();
    started.lifecycle('sim.start'); started.control(40, turbulence);
    const restarted = series(started, 40).at(-1)?.wind, windy = series(calm, 40).at(-1)?.wind;
    if (!restarted || !windy) throw new Error('No rows');
    // Relative to the mean wind the channels differ from a turbulence that started on this tick.
    expect(windy[2]).not.toBe(restarted[2]);
    const paced = (wakeMs: () => number) => {
      const h = harness();
      h.lifecycle('sim.start');
      h.control(5, turbulence);
      h.control(5, record('wind.mean', { windNedMps: [3, 1, 0] }));
      for (let guard = 0; h.tick() < 300; guard++) {
        if (guard > 1_000_000) throw new Error('The session did not reach tick 300');
        h.time.mono += 300 - h.tick() > 8 ? wakeMs() : 0.1;
        h.session.pump();
      }
      return h.snapshot();
    };
    let lcg = 12345;
    const irregular = () => { lcg = (lcg * 1103515245 + 12345) % 2147483648; return 0.05 + 15 * lcg / 2147483648; };
    const fine = paced(() => 0.1);
    expect(paced(() => 10)).toEqual(fine);
    expect(paced(irregular)).toEqual(fine);
  });
  it('a weather.set leaves turbulence running, and turbulence does not start with one', () => {
    const weather = { atTick: { lo: 20, hi: 0 }, windNedMps: [2, 0, 0], temperatureK: 288.15, pressurePa: 101325, turbulenceRmsMps: 0, seed: 0 };
    const h = harness();
    h.lifecycle('sim.start');
    h.raw({ protocolVersion: 2, type: 'weather.set', ...weather });
    h.runTo(25);
    expect(Array.from(h.dynamics().windNedMps)).toEqual([2, 0, 0]);
    h.control(30, record('wind.turbulence', { w20Mps: 8, seed: 31 }));
    h.raw({ protocolVersion: 2, type: 'weather.set', ...weather, atTick: { lo: 40, hi: 0 }, windNedMps: [1, 0, 0] });
    h.runTo(41);
    expect(h.dynamics().windNedMps[2]).not.toBe(0);
    h.control(50, record('wind.turbulence', { w20Mps: 8, seed: 31 }, 1, false));
    h.runTo(50);
    expect(Array.from(h.dynamics().windNedMps)).toEqual([1, 0, 0]);
  });
  it('a new epoch forgets what a link holds back, too', () => {
    const h = harness();
    h.lifecycle('sim.start');
    h.session.attachDelivery(true);
    h.control(3, { schemaVersion: 1, id: 'gcs', effect: 'link.gcs', enabled: true, intensity: 1, parameters: {} });
    h.runTo(3);
    expect(h.session.delivery.mask).not.toBe(0);
    h.lifecycle('sim.pause');
    expect(h.lifecycle('sim.reset', { seed: 1 })).toMatchObject({ status: 'applied' });
    expect(h.session.delivery).toMatchObject({ mask: 0, attached: true });
  });
  it('a new epoch forgets every effect', () => {
    const h = harness();
    h.lifecycle('sim.start');
    h.control(5, record('wind.gust', { rmsMps: 5, bandwidthHz: 1, seed: 3 }));
    h.control(5, record('atmosphere', { temperatureK: 300, pressurePa: 95000 }));
    h.runTo(20);
    h.lifecycle('sim.pause');
    h.lifecycle('sim.reset', { seed: 1 });
    h.lifecycle('sim.start');
    expect(h.dynamics().weatherActive).toBe(false);
    h.control(5, record('wind.mean', { windNedMps: [2, 0, 0] }));
    h.runTo(10);
    expect(Array.from(h.dynamics().windNedMps)).toEqual([2, 0, 0]);
    expect(h.dynamics().atmosphere[2]).toBe(340);
  });
});

describe('version 2 commands', () => {
  const trace = (send: (h: ReturnType<typeof harness>) => void) => {
    const h = harness();
    h.lifecycle('sim.start');
    send(h);
    return h.trace(TICKS);
  };
  const weather = { atTick: { lo: 5, hi: 0 }, windNedMps: [3, -2, 0.5] as [number, number, number], temperatureK: 293.15, pressurePa: 98000, turbulenceRmsMps: 1.5, seed: 77 };
  it('fly bit for bit as they did: a weather.set equals its three migrated controls, in any order', () => {
    const reference = trace(h => { h.raw({ protocolVersion: 2, type: 'weather.set', ...weather }); });
    const [wind, gust, air] = migrateWeatherSet({ protocolVersion: 2, requestId: 1, expectedEpoch: 1, type: 'weather.set', ...weather });
    for (const order of [[wind, gust, air], [air, wind, gust], [gust, air, wind], [wind, air, gust]]) {
      const run = trace(h => { for (const control of order) h.control(5, control); });
      expect(bytes(run).equals(bytes(reference)), order.map(item => item.effect).join()).toBe(true);
    }
  });
  it('a fault.set equals its migrated control', () => {
    const fault = { protocolVersion: 2, type: 'fault.set', atTick: { lo: 5, hi: 0 }, faultId: 'motor', enabled: true, effect: { kind: 'motor-loss', motorIndex: 1, mode: 'instant-thrust-loss', remainingThrustFraction: 0.5 }, recovery: 'hold-offset' };
    const reference = trace(h => { h.raw(fault); });
    const run = trace(h => { h.control(5, record('motor.loss', { motorIndex: 1, mode: 'instant-thrust-loss', remainingThrustFraction: 0.5 }, 1, true, 'motor')); });
    expect(bytes(run).equals(bytes(reference))).toBe(true);
  });
  it('a weather.set can be switched off by its controls, and can follow them', () => {
    const h = harness();
    h.lifecycle('sim.start');
    h.raw({ protocolVersion: 2, type: 'weather.set', ...weather });
    const [wind, gust, air] = migrateWeatherSet({ protocolVersion: 2, requestId: 1, expectedEpoch: 1, type: 'weather.set', ...weather });
    h.control(20, { ...wind, enabled: false });
    h.control(20, { ...gust, enabled: false });
    h.control(20, { ...air, enabled: false });
    h.runTo(21);
    expect(h.dynamics().weatherActive).toBe(false);
    h.raw({ protocolVersion: 2, type: 'weather.set', ...weather, atTick: { lo: 30, hi: 0 }, windNedMps: [1, 0, 0], turbulenceRmsMps: 0 });
    h.runTo(31);
    expect(Array.from(h.dynamics().windNedMps)).toEqual([1, 0, 0]);
  });
});

describe('intensity against each model', () => {
  it('gust RMS is linear: the same seed gives the same gust, scaled, on every tick', () => {
    const series = (intensity: number) => {
      const h = harness(), rows: number[] = [];
      h.lifecycle('sim.start');
      h.control(5, record('wind.gust', { rmsMps: 1.5, bandwidthHz: 2, seed: 4242 }, intensity));
      h.runTo(200, () => rows.push(...h.dynamics().windNedMps));
      return rows;
    };
    const one = series(1), two = series(2), quarter = series(0.25), three = series(3);
    expect(Math.max(...one.map(Math.abs))).toBeGreaterThan(0.1);
    // Multiplying by a power of two only moves the exponent, so these are exact.
    one.forEach((value, i) => {
      expect(two[i]).toBe(2 * value);
      expect(quarter[i]).toBe(0.25 * value);
      expect(Math.abs((three[i] ?? NaN) - 3 * value)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(value)));
    });
  });
  it('the gust model reaches the RMS asked for, its stationary variance', () => {
    const weather = new Float64Array(WEATHER_SLOTS);
    for (const rms of [1.5, 3, 6]) {
      const wind = new Wind({ meanNedMps: [0, 0, 0], gustRmsMps: 0, bandwidthHz: 1, hz: 400 }, 0), out = new Float64Array(3);
      weather[WEATHER_GUST_RMS] = rms; weather[WEATHER_SEED] = 8; weather[WEATHER_GUST_BANDWIDTH] = 4;
      wind.configure(weather);
      const steps = 400000, sum = [0, 0, 0];
      for (let i = 0; i < steps; i++) {
        wind.stepInto(out);
        for (let axis = 0; axis < 3; axis++) sum[axis] = sum[axis]! + out[axis]! * out[axis]!;
      }
      // Bandwidth 4 Hz at 400 Hz leaves about 12,000 independent samples per axis, so about 0.7 % standard error.
      for (const total of sum) expect(Math.abs(Math.sqrt(total / steps) / rms - 1)).toBeLessThan(0.03);
    }
  });
  it('the bandwidth sets how fast the gust forgets: lag-one correlation exp(-2 pi f / rate)', () => {
    const weather = new Float64Array(WEATHER_SLOTS), lagOne = (bandwidth: number) => {
      const wind = new Wind({ meanNedMps: [0, 0, 0], gustRmsMps: 0, bandwidthHz: 1, hz: 400 }, 0), out = new Float64Array(3);
      weather[WEATHER_GUST_RMS] = 2; weather[WEATHER_SEED] = 8; weather[WEATHER_GUST_BANDWIDTH] = bandwidth;
      wind.configure(weather);
      let previous = 0, across = 0, along = 0;
      for (let i = 0; i < 300000; i++) { wind.stepInto(out); across += previous * out[0]!; along += out[0]! * out[0]!; previous = out[0]!; }
      return across / along;
    };
    for (const bandwidth of [1, 5, 20]) expect(Math.abs(lagOne(bandwidth) - Math.exp(-2 * Math.PI * bandwidth / 400))).toBeLessThan(0.005);
  });
  it('mean wind is the wind asked for, times the intensity, on every tick', () => {
    for (const intensity of [0.5, 1, 2.5]) {
      const h = harness();
      h.lifecycle('sim.start');
      h.control(5, record('wind.mean', { windNedMps: [4, -2, 1] }, intensity));
      h.runTo(50, tick => { if (tick >= 5) expect(Array.from(h.dynamics().windNedMps)).toEqual([4 * intensity, -2 * intensity, intensity]); });
    }
  });
  it('the air is the ICAO troposphere of the temperature and pressure the intensity gives', () => {
    const troposphere = (temperatureK: number, pressurePa: number, heightM: number) => {
      const R = 287.05287, L = 0.0065, g = 9.80665;
      return pressurePa * Math.exp(g / (R * L) * Math.log1p(-L * heightM / temperatureK));
    };
    for (const intensity of [0.25, 0.5, 1, 2]) {
      const h = harness();
      h.lifecycle('sim.start');
      h.control(5, record('atmosphere', { temperatureK: 295, pressurePa: 97000 }, intensity));
      h.runTo(60);
      const T = ISA_TEMPERATURE_K + intensity * (295 - ISA_TEMPERATURE_K), p = ISA_PRESSURE_PA + intensity * (97000 - ISA_PRESSURE_PA);
      const expected = troposphere(intensity === 1 ? 295 : T, intensity === 1 ? 97000 : p, -h.dynamics().state.down);
      expect(Math.abs((h.dynamics().air[AIR_PRESSURE] ?? NaN) / expected - 1)).toBeLessThan(1e-9);
    }
  });

  // The EW and motor kernels, reached through the record: what each kernel does with a magnitude is verified in its own task.
  const context = (): EwContext => ({ dtS: 1 / 400, simTimeS: 0, truthNorthM: 1, truthEastM: 2, truthDownM: -3 });
  const gps = (): GpsSample => ({ timeLoUs: 100, timeHiUs: 0, latitudeRad: 0.9, longitudeRad: -0.3, altitudeMslM: 150, vnMps: 2, veMps: 1, vdMps: -0.5, hdop: 0.8, vdop: 1.1,
    hdopValid: true, vdopValid: true, fixType: 3, satellites: 12, satellitesValid: true, velocityValid: true, courseRad: 0.46, courseValid: true });
  const imu = (): ImuSample => ({ timeLoUs: 100, timeHiUs: 0, specificForceBodyMps2: new Float64Array([0.1, 0.2, -9.8]), gyroBodyRadS: new Float64Array([0.01, -0.02, 0.03]),
    magBodyGauss: new Float64Array([0.21, 0.02, 0.43]), pressurePa: 100000, differentialPressurePa: 20, pressureAltitudeM: 110, temperatureK: 290, updatedMask: 0x1fff });
  const lowered = (control: EffectControl, recovery: EffectRecovery = 'hold-offset'): FaultCommand => {
    const out = effectiveControl(parseEffectControl(control), { requestId: 1, expectedEpoch: 1, atTick: { lo: 0, hi: 0 }, recovery });
    if (out.family !== 'fault') throw new Error('Not a fault');
    return out.fault;
  };
  const zero = { lo: 0, hi: 0 };
  const observed = (controls: readonly EffectControl[], steps = 4000, motors?: MotorFaults) => {
    const engine = new EwEngine(motors), pipeline = new SensorPipeline(engine);
    engine.reset(7);
    for (const control of controls) expect(engine.apply(lowered(control), zero)).toBe('applied');
    const ctx = context();
    for (let i = 0; i < steps; i++) engine.advanceInto(ctx);
    expect(pipeline.gpsInto(gps())).toBe(true);
    expect(pipeline.imuInto(imu())).toBe(true);
    return { engine, gps: { ...pipeline.gps }, mag: Array.from(pipeline.imu.magBodyGauss), flags: engine.flags };
  };
  it('a position step moves the fix by the offset times the intensity', () => {
    const base = gps(), expected = gps();
    new GpsOffsetApplier().applyInto(base, 300, -60, 15, expected);
    const seen = observed([record('ew.position-step', { offsetNedM: [100, -20, 5] }, 3)]).gps;
    expect(seen.latitudeRad).toBeCloseTo(expected.latitudeRad, 12);
    expect(seen.longitudeRad).toBeCloseTo(expected.longitudeRad, 12);
    expect(seen.altitudeMslM).toBeCloseTo(expected.altitudeMslM, 6);
  });
  it('a drift runs at the acceleration times the intensity, up to the top speed times the intensity', () => {
    // 10 s: b = a t^2 / 2 = 5 m at v = 1 m/s, under a limit of 5 m/s at this intensity.
    const base = gps(), expected = gps();
    new GpsOffsetApplier().applyInto(base, 5, 0, 0, expected);
    const seen = observed([record('ew.velocity-drift', { accelerationNedMps2: [0.2, 0, 0], maxSpeedMps: 10 }, 0.5)]).gps;
    expect(seen.latitudeRad).toBeCloseTo(expected.latitudeRad, 11);
    expect(seen.vnMps).toBeCloseTo(base.vnMps + 1, 9);
    // 40 s at 0.1 m/s² would reach 4 m/s; the limit of 1 m/s holds it.
    const limited = observed([record('ew.velocity-drift', { accelerationNedMps2: [0.2, 0, 0], maxSpeedMps: 2 }, 0.5)], 16000).gps;
    expect(limited.vnMps).toBeCloseTo(base.vnMps + 1, 9);
  });
  it('jamming and magnetic effects take the magnitude the intensity gives', () => {
    const direct = (faultEffect: FaultCommand['effect']) => {
      const engine = new EwEngine(), pipeline = new SensorPipeline(engine);
      engine.reset(7);
      engine.apply({ protocolVersion: 2, requestId: 1, expectedEpoch: 1, type: 'fault.set', atTick: zero, faultId: 'd', enabled: true, effect: faultEffect, recovery: 'hold-offset' }, zero);
      const ctx = context();
      for (let i = 0; i < 4000; i++) engine.advanceInto(ctx);
      expect(pipeline.gpsInto(gps())).toBe(true);
      expect(pipeline.imuInto(imu())).toBe(true);
      return { gps: { ...pipeline.gps }, mag: Array.from(pipeline.imu.magBodyGauss) };
    };
    expect(observed([record('ew.gnss-jamming', { severity: 0.8 }, 0.5)]).gps).toEqual(direct({ kind: 'gnss-jamming', severity: 0.4 }).gps);
    expect(observed([record('ew.magnetic', { rotationRad: [0, 0, 0.5], biasBodyGauss: [0.25, 0, 0] }, 2)]).mag)
      .toEqual(direct({ kind: 'magnetic', rotationRad: [0, 0, 1], biasBodyGauss: [0.5, 0, 0] }).mag);
    // A quarter turn about down carries a field along north into east, so the magnitude is what moved it.
    const turned = observed([record('ew.magnetic', { rotationRad: [0, 0, Math.PI / 4], biasBodyGauss: [0, 0, 0] }, 2)]).mag;
    expect(Math.hypot(...turned)).toBeCloseTo(Math.hypot(0.21, 0.02, 0.43), 12);
    expect(Math.abs(turned[0] ?? NaN)).toBeCloseTo(0.02, 12);
    expect(Math.abs(turned[1] ?? NaN)).toBeCloseTo(0.21, 12);
  });
  it('a motor keeps 1 minus the intensity times the thrust it loses', () => {
    const source = new Float64Array([0, 0, -10, 0, 0, 0.5]), target = new Float64Array(6), remaining = (r: number, intensity: number) => {
      const motors = new MotorFaults([0, 1, 2, 3]);
      observed([record('motor.loss', { motorIndex: 2, mode: 'instant-thrust-loss', remainingThrustFraction: r }, intensity)], 1, motors);
      expect(motors.wrenchInto(2, source, target)).toBe(true);
      return (target[2] ?? NaN) / -10;
    };
    expect(remaining(0.25, 1)).toBe(0.25);
    expect(remaining(0.25, 0.5)).toBe(0.625);
    expect(remaining(0, 0.5)).toBe(0.5);
    expect(remaining(0.5, 2)).toBe(0);
  });
  it('off and zero leave every observation bit as it was', () => {
    const clean = observed([]);
    for (const [effect, parameters] of APPLICABLE) {
      if (EFFECT_CATALOG[effect].family !== 'fault') continue;
      for (const off of [record(effect, parameters, 1, false), record(effect, parameters, 0)]) {
        const motors = effect === 'motor.loss' ? new MotorFaults([0, 1, 2, 3]) : undefined, seen = observed([off], 4000, motors);
        expect(seen.gps, effect).toEqual(clean.gps);
        expect(seen.mag, effect).toEqual(clean.mag);
        expect(seen.flags, effect).toBe(clean.flags);
      }
    }
  });
});

describe('a backend that cannot apply an effect', () => {
  it('rejects a sensor error visibly, and says where sensor errors are set, on or off', () => {
    const h = harness();
    h.lifecycle('sim.start');
    const sensor: readonly (readonly [EffectId, Parameters])[] = [['sensor.imu.accel-noise', { densityMps2PerSqrtHz: 0.001 }], ['sensor.imu.gyro-noise', { densityRadSPerSqrtHz: 0.0001 }],
      ['sensor.imu.accel-bias', { biasMps2: [0.1, 0, 0] }], ['sensor.imu.gyro-bias', { biasRadS: [0.01, 0, 0] }], ['sensor.imu.latency', { latencyUs: 1000 }],
      ['sensor.battery.voltage', { gainError: 0.01, offsetV: 0.1, noiseRmsV: 0.01 }], ['sensor.battery.current', { gainError: 0.01, offsetA: 0.1, noiseRmsA: 0.01 }]];
    expect(sensor.map(([id]) => id).sort()).toEqual(EFFECT_IDS.filter(id => EFFECT_CATALOG[id].family === 'sensor').sort());
    for (const [effect, parameters] of sensor) for (const value of [record(effect, parameters), record(effect, parameters, 1, false)]) {
      const result = h.control(10, value);
      expect(result, effect).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
      expect(result?.type === 'reject-v2' ? result.message : '').toContain('Sensors tab');
    }
    expect(h.session.fault).toBeFalsy();
  });
  it('the demo backend rejects what it has no model for, by name, and takes the EW effects it has', () => {
    const stateBuffer = createSharedMemoryV2(), results: CommandResultV2[] = [];
    const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer: createSpscQueue('actuator') },
      { monotonicMs: () => 0, wallMs: () => 1.79e12 }, undefined, createSessionFaultPort());
    const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2();
    let requestId = 0;
    const send = (effect: EffectId, parameters: Parameters) => {
      reader.readHeader(header);
      session.handle({ protocolVersion: 3, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type: 'effect.set', atTick: { lo: 10, hi: 0 }, control: record(effect, parameters), recovery: 'hold-offset' });
      session.drain(result => results.push(result));
      return results.at(-1);
    };
    for (const [effect, parameters] of APPLICABLE) {
      const result = send(effect, parameters), family = EFFECT_CATALOG[effect].family;
      if (family === 'environment') expect(result?.type === 'reject-v2' ? result.message : '', effect).toContain(`${effect} is not supported`);
      else if (effect === 'motor.loss') expect(result, effect).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE', message: expect.stringContaining('motor-loss is not supported') as string });
      else expect(result, effect).toMatchObject({ type: 'ack-v2', status: 'queued' });
    }
    session.dispose();
  });
  it('a motor the aircraft does not have is refused at admission', () => {
    const h = harness();
    h.lifecycle('sim.start');
    expect(h.control(10, record('motor.loss', { motorIndex: 4, mode: 'power-cut', remainingThrustFraction: 0 }))).toMatchObject({ type: 'reject-v2', code: 'OUT_OF_RANGE' });
  });
});

describe('scheduled in a scenario (schema 2)', () => {
  const header = { schemaVersion: 2, id: 'effects', hz: 400, seed: 1, modelSha256: 'a'.repeat(64), firmwareSha256: 'b'.repeat(64), durationTicks: 200,
    rubric: { holdStartTick: 0, holdEndTick: 200, targetAltitudeM: 5, maxAltitudeErrorM: 1, requireHealthyEkf: false } };
  const entry = (control: EffectControl, onsetTick: number, durationTicks: number | null, recovery: EffectRecovery = 'hold-offset') => ({ control, onsetTick, durationTicks, recovery });
  const wind = record('wind.mean', { windNedMps: [4, 0, 0] }), air = record('atmosphere', { temperatureK: 300, pressurePa: 95000 });
  // Magnetic rather than jamming: jamming's flag stays on while its filtered severity decays, on purpose.
  const mag = record('ew.magnetic', { rotationRad: [0, 0, 0.5], biasBodyGauss: [0, 0, 0] }), gust = record('wind.gust', { rmsMps: 1, bandwidthHz: 1, seed: 5 });
  const scenario = { ...header, events: [], effects: [entry(wind, 20, 30), entry(mag, 25, 10), entry(air, 60, 10), entry(gust, 90, null)] };

  it('becomes tick-ordered events, on at the onset and off at the end, and refuses what cannot run', () => {
    const parsed = parseScenario(scenario);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.events.map(event => event.tick)).toEqual([20, 25, 35, 50, 60, 70, 90]);
    expect(parsed.events.map(event => event.command.requestId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parsed.events.map(event => (event.command.type === 'effect.set' ? `${event.command.control.effect}:${event.command.control.enabled}` : ''))).toEqual([
      'wind.mean:true', 'ew.magnetic:true', 'ew.magnetic:false', 'wind.mean:false', 'atmosphere:true', 'atmosphere:false', 'wind.gust:true']);
    expect(Object.isFrozen(parsed.events[0]?.command)).toBe(true);
    const first = parsed.events[0]?.command;
    expect(first?.type === 'effect.set' && Object.isFrozen(first.control.parameters.windNedMps)).toBe(true);
    const refused = [
      { ...scenario, effects: [entry(wind, 190, 20)] },
      { ...scenario, effects: [entry(wind, 201, null)] },
      { ...scenario, effects: [entry(wind, 10, 0)] },
      { ...scenario, effects: [entry(record('wind.mean', { windNedMps: [150, 0, 0] }, 2), 10, null)] },
      { ...scenario, effects: [{ control: wind, onsetTick: 10, durationTicks: null }] },
      { ...scenario, effects: [{ ...entry(wind, 10, null), extra: 1 }] },
      { ...header },
      { ...scenario, schemaVersion: 1 },
      { ...scenario, schemaVersion: 3 },
      { ...scenario, effects: Array.from({ length: 65 }, (_, i) => entry(wind, i, 1)) },
    ];
    for (const value of refused) expect(() => parseScenario(value), JSON.stringify(value).slice(0, 160)).toThrow();
    expect(parseScenario({ ...scenario, effects: Array.from({ length: 64 }, (_, i) => entry(wind, i, 1)) }).events).toHaveLength(128);
  });

  it('merges explicit events in, on one tick in the order written, and still reads schema 1 unchanged', () => {
    const explicit = { tick: 25, command: { protocolVersion: 3, requestId: 1, expectedEpoch: 0, atTick: { lo: 25, hi: 0 }, type: 'effect.set', control: air, recovery: 'hold-offset' } };
    const parsed = parseScenario({ ...scenario, events: [explicit], effects: [entry(wind, 25, null), entry(mag, 10, null)] });
    expect(parsed.events.map(event => (event.command.type === 'effect.set' ? event.command.control.effect : ''))).toEqual(['ew.magnetic', 'atmosphere', 'wind.mean']);
    expect(parsed.events.map(event => event.command.requestId)).toEqual([1, 2, 3]);
    const v1 = { ...header, schemaVersion: 1, events: [{ tick: 5, command: { protocolVersion: 2, requestId: 1, expectedEpoch: 0, atTick: { lo: 5, hi: 0 }, type: 'fault.set', faultId: 'j', enabled: true, effect: { kind: 'gnss-jamming', severity: 1 }, recovery: 'hold-offset' } }] };
    expect(parseScenario(v1).events[0]?.command).toEqual(v1.events[0]?.command);
    expect(() => parseScenario({ ...v1, events: [explicit] })).toThrow();
  });

  it('applies each effect on its exact tick through the binder, with an applied acknowledgement bound to that tick', () => {
    const h = harness(), parsed = parseScenario(scenario);
    let next = 1;
    const binder = new ScenarioBinder(parsed, () => next++);
    const sent: { tick: number; requestId: number }[] = [];
    h.session.setBeforeTick(tick => {
      for (;;) {
        const command = binder.poll(tickToNumber(tick), false, h.session.currentEpoch);
        if (!command) return;
        // The Worker hands the bound command on as it arrived, so what the binder returns must parse again.
        sent.push({ tick: tickToNumber(tick), requestId: command.requestId });
        h.session.handle(structuredClone(command));
      }
    });
    h.reader.readHeader(h.header);
    h.lifecycle('sim.start');
    next = 1000;
    const windAt = new Map<number, number>(), flagsAt = new Map<number, number>(), airAt = new Map<number, number>();
    h.runTo(120, tick => {
      windAt.set(tick, h.dynamics().windNedMps[0] ?? NaN);
      flagsAt.set(tick, h.state.ewFlags);
      airAt.set(tick, h.dynamics().atmosphere[2] ?? NaN);
      h.session.drain(result => { h.results.push(result); binder.observe(result); });
    });
    expect(binder.halted).toBe(false);
    expect(sent.map(item => item.tick)).toEqual([20, 25, 35, 50, 60, 70, 90]);
    parsed.events.forEach((event, index) => {
      const request = sent[index]?.requestId ?? -1;
      expect(appliedTick(h.results, request), `event ${index}`).toBe(event.tick);
      expect(binder.claimsApplied(index), `event ${index}`).toBe(true);
    });
    // Before, on and after each exact tick.
    expect(windAt.get(19)).toBe(0); expect(windAt.get(20)).toBe(4); expect(windAt.get(49)).toBe(4); expect(windAt.get(50)).toBe(0);
    expect(flagsAt.get(24)).toBe(0); expect(flagsAt.get(25)).toBe(EwFlagV2.MagneticAnomaly); expect(flagsAt.get(34)).toBe(EwFlagV2.MagneticAnomaly); expect(flagsAt.get(35)).toBe(0);
    expect(airAt.get(59)).toBe(340); expect(airAt.get(60)).not.toBe(340); expect(airAt.get(69)).not.toBe(340); expect(airAt.get(70)).toBe(340);
    expect(windAt.get(89)).toBe(0); expect(windAt.get(90)).not.toBe(0);
  });
});
