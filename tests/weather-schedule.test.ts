import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BetFlightDynamics } from '@mirage/physics/bet-dynamics';
import { DRYDEN_STREAMS } from '@mirage/physics/turbulence';
import { GUST_STREAMS } from '@mirage/physics/wind';
import { createSessionFaultPort } from '@mirage/ew/session-port';
import {
  EFFECT_RANDOM_STREAMS, StateReaderV2, createSharedMemoryV2, createSpscQueue, newFlightStateV2, newHeaderSnapshotV2, parseEffectControl, tickToNumber,
  type EffectControl, type EffectId, type EffectParameterValue,
} from '@mirage/protocol';
import { faultTimeline, type ScheduledEffect } from '../packages/scenarios/src/fault-schedule.ts';
import { WEATHER_SCHEDULE_SCHEMA_VERSION, WEATHER_STREAMS, parseWeatherSchedule, weatherSchedule } from '../packages/scenarios/src/weather-schedule.ts';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { flightConfiguration } from './bet-runtime-fixture.ts';

// TASK-167: the weather schedule. Its entries are checked as the fault schedule's (TASK-169) are, for the environment family only;
// it records the random streams of this build, which the models must use; and its seeds repeat the same weather in a real session.

const control = (effect: EffectId, parameters: Record<string, EffectParameterValue>, id = effect.replaceAll('.', '-')): EffectControl =>
  parseEffectControl({ schemaVersion: 1, id, effect, enabled: true, intensity: 1, parameters });
const entry = (c: EffectControl, onsetS: number, durationS: number | null = null): ScheduledEffect => ({ control: c, onsetS, durationS, recovery: 'hold-offset' });
const WEATHER: readonly ScheduledEffect[] = [
  entry(control('wind.mean', { windNedMps: [-6, 2, 0] }), 0),
  entry(control('wind.gust', { rmsMps: 1.5, bandwidthHz: 1, seed: 1234 }), 0),
  entry(control('wind.turbulence', { w20Mps: 8, seed: 99 }), 0, 30),
  entry(control('wind.discrete-gust', { amplitudeMps: 7, durationS: 3, fromDeg: 270, upwardDeg: 5 }), 0.5, 4),
  entry(control('atmosphere', { temperatureK: 300, pressurePa: 96000 }), 0),
];

describe('the weather schedule (TASK-167)', () => {
  it('holds environment controls with this build\'s random streams, which the models use', () => {
    const parsed = weatherSchedule(WEATHER);
    expect(parsed).toEqual({ schemaVersion: WEATHER_SCHEDULE_SCHEMA_VERSION, entries: WEATHER, streams: WEATHER_STREAMS });
    expect(parseWeatherSchedule(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect([...GUST_STREAMS]).toEqual([...EFFECT_RANDOM_STREAMS['wind.gust']]);
    expect(Object.values(DRYDEN_STREAMS)).toEqual([...EFFECT_RANDOM_STREAMS['wind.turbulence']]);
    // Its changes in order, the discrete gust on at 0.5 s and off at 4.5 s, the turbulence off at 30 s.
    expect(faultTimeline(parsed).map(t => [t.atS, parsed.entries[t.entry]?.control.effect, t.on])).toEqual([
      [0, 'wind.mean', true], [0, 'wind.gust', true], [0, 'wind.turbulence', true], [0, 'atmosphere', true],
      [0.5, 'wind.discrete-gust', true], [4.5, 'wind.discrete-gust', false], [30, 'wind.turbulence', false]]);
  });
  it('refuses what does not belong, overlaps or would not repeat', () => {
    const base = JSON.parse(JSON.stringify(weatherSchedule(WEATHER))) as Record<string, unknown> & { entries: Record<string, unknown>[] };
    const edited = (change: (copy: typeof base) => void) => { const copy = structuredClone(base); change(copy); return copy; };
    const cases: [string, unknown, string][] = [
      ['a fault', edited(c => { c.entries.push({ ...entry(control('ew.position-step', { offsetNedM: [30, 0, 0] }), 5) }); }), 'ew.position-step does not belong on this schedule'],
      ['two mean winds at once', edited(c => { c.entries.push({ ...entry(control('wind.mean', { windNedMps: [1, 0, 0] }, 'wind-mean-2'), 10) }); }), 'overlaps entries[0] of wind.mean'],
      ['an entry that is off', edited(c => { const first = c.entries[0]; if (first) first.control = { ...(first.control as object), enabled: false }; }), 'must be enabled'],
      ['other streams', edited(c => { c.streams = { gust: [0, 1, 2], turbulence: [1, 2, 3, 4, 5] }; }), 'its random streams are not this build\'s'],
      ['no streams', edited(c => { Reflect.deleteProperty(c, 'streams'); }), 'its random streams are not this build\'s'],
      ['another schema', edited(c => { c.schemaVersion = 2; }), 'schemaVersion must be 1'],
      ['an extra field', edited(c => { c.seed = 1; }), 'unexpected field seed'],
      ['a discrete gust too short', edited(c => { c.entries.push({ ...entry({ ...control('wind.discrete-gust', { amplitudeMps: 7, durationS: 3, fromDeg: 0, upwardDeg: 0 }, 'g2') }, 10) });
        const last = c.entries.at(-1) as { control: { parameters: Record<string, number> } }; last.control.parameters.durationS = 0.01; }), 'durationS must be in [0.1, 60]'],
    ];
    for (const [name, value, message] of cases) expect(() => parseWeatherSchedule(value), name).toThrow(message);
  });
});

let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600000);

/** A real session flown from tick 0 for `ticks`, each schedule change applied on its tick (onset counted from tick 0 here). */
function flown(schedule: readonly ScheduledEffect[], ticks: number): Float64Array {
  const hz = 400, time = { mono: 0 }, stateBuffer = createSharedMemoryV2(), built: BetFlightDynamics[] = [];
  const s = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer: createSpscQueue('actuator') },
    { monotonicMs: () => time.mono, wallMs: () => 1_790_000_000_000 + time.mono },
    rate => { const d = new BetFlightDynamics(module, flightConfiguration(), rate); built.push(d); return d; }, createSessionFaultPort());
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2();
  let requestId = 0;
  const raw = (message: Record<string, unknown>) => { reader.readHeader(header); s.handle({ requestId: ++requestId, expectedEpoch: header.sessionEpoch, ...message }); s.drain(() => undefined); };
  raw({ protocolVersion: 2, type: 'sim.start' });
  const parsed = weatherSchedule(schedule), pending = faultTimeline(parsed).map(t => ({ ...t, sent: false }));
  const tick = () => (reader.latest(state) ? tickToNumber(state.tickId) : -1);
  const rows: number[] = [];
  while (tick() < ticks) {
    // Queued ahead, within the 10 s horizon, as the run controller queues a schedule's changes.
    for (const change of pending) {
      const at = Math.round(change.atS * hz) + 2;
      const scheduled = parsed.entries[change.entry];
      if (change.sent || !scheduled || at > tick() + hz) continue;
      change.sent = true;
      raw({ protocolVersion: 3, type: 'effect.set', atTick: { lo: at, hi: 0 }, control: { ...scheduled.control, enabled: change.on }, recovery: scheduled.recovery });
    }
    const before = tick();
    while (tick() === before) { time.mono += 0.05; s.pump(); }
    rows.push(...(built.at(-1)?.windNedMps ?? []), state.northM, state.eastM, state.downM, state.qw, state.qx, state.trueAirspeedMps, state.ambientPressurePa);
  }
  return Float64Array.from(rows);
}
const same = (a: Float64Array, b: Float64Array) => Buffer.from(a.buffer).equals(Buffer.from(b.buffer));

describe('a weather schedule in a flight session (TASK-167)', () => {
  it('repeats bit for bit from the same seeds, and changes with another seed', () => {
    const first = flown(WEATHER, 2400), again = flown(WEATHER, 2400);
    expect(same(first, again)).toBe(true);
    const reseeded = (effect: EffectId, seed: number) => WEATHER.map(item => item.control.effect === effect
      ? { ...item, control: { ...item.control, parameters: { ...item.control.parameters, seed } } } : item);
    expect(same(flown(reseeded('wind.gust', 1235), 2400), first)).toBe(false);
    expect(same(flown(reseeded('wind.turbulence', 100), 2400), first)).toBe(false);
  }, 120000);
});
