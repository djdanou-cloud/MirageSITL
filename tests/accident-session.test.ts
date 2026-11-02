import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareContact } from './contact-support.ts';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars, type AircraftProfile } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { ACCIDENT_RULES, accidentRows, type AccidentEvent } from '@mirage/physics/accident';
import { buildProfileDynamics, profileFlightDynamics, type ProfileDynamicsBuild } from '@mirage/physics/profile-dynamics';
import { PhysicsSessionV2, type SessionClock } from '../packages/physics/src/session-v2.ts';
import {
  ActuatorFlagV2, ActuatorFrameCodecV2, SpscProducer, StateReaderV2, VehicleFlagV2, createSharedMemoryV2, createSpscQueue, newActuatorFrameV2,
  newFlightStateV2, newHeaderSnapshotV2, newInput, type CommandResultV2,
} from '@mirage/protocol';
import { headerFromPlan, recordKey } from '../packages/aar/src/format-v2.ts';
import { RecordingConsumerV2, valueRow } from '../packages/aar/src/recorder-v2.ts';
import { planRates, SignalId } from '../packages/aar/src/signal-catalog.ts';
import { MemoryRecordingBackend, openRecording, StreamWriter } from '../packages/aar/src/stream-storage.ts';

// TASK-149: accidents in a physics session on the quad X profile (example
// cards) standing on its decision D-07 supports (TASK-095). The accident tick
// is found independently: the same dynamics stepped without the session, with
// the F-09 rule applied to its raw shape reports in this file.

const MOTOR = '11'.repeat(32), PROPELLER = '22'.repeat(32), ESC = '33'.repeat(32), BATTERY = '44'.repeat(32);
let module: WebAssembly.Module;
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  await prepareContact();
}, 600000);

function json(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}
function card(type: string): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) throw new Error(`Invalid ${type} card`);
  const provenance = Object.fromEntries(Object.entries(base.values).map(([key, value]) => [key, value === null ? null : 'example']));
  return validateComponentCard({ ...base, provenance });
}
async function quad(): Promise<ProfileDynamicsBuild & { massKg: number }> {
  const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
  const profile: AircraftProfile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY },
    motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }),
  [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
  const cards = new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: 149 });
  return { ...buildProfileDynamics(derived.manifest), massKg: derived.manifest.massProperties.massKg };
}
/**
 * The quad rolled and pitched (by default 60 degrees right side down and 10 degrees nose down), its
 * lowest shape 5 mm above the ground.
 */
function tipped(built: ProfileDynamicsBuild, roll = Math.PI / 3, pitch = -Math.PI / 18): ProfileDynamicsBuild {
  const gear = built.gear;
  if (!gear) throw new Error('No gear');
  const down = [-Math.sin(pitch), Math.cos(pitch) * Math.sin(roll), Math.cos(pitch) * Math.cos(roll)];
  const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const lowest = Math.max(...gear.shapes.map(shape => {
    if (shape.kind === 'capsule') return Math.max(dot(shape.startBodyM, down), dot(shape.endBodyM, down)) + shape.radiusM;
    const along = dot(shape.axisBody, down);
    return dot(shape.centerBodyM, down) + shape.halfHeightM * Math.abs(along) + shape.radiusM * Math.sqrt(Math.max(0, 1 - along * along));
  }));
  const [cr, sr, cp, sp] = [Math.cos(roll / 2), Math.sin(roll / 2), Math.cos(pitch / 2), Math.sin(pitch / 2)];
  const initialBody = { ...built.configuration.initialBody, positionNedM: Float64Array.from([0, 0, -(lowest + 0.005)]),
    quaternionBodyToNed: Float64Array.from([cp * cr, cp * sr, sp * cr, -sp * sr]) };
  return { ...built, configuration: { ...built.configuration, initialBody } };
}

/**
 * The oracle: every tick (1-based) on which a shape starts to meet F-09 in a plain run of the
 * dynamics with every rotor at `duty`, and which shape, from the raw reports, in tick and shape order.
 */
function strikes(build: ProfileDynamicsBuild, massKg: number, duty: number, ticks: number): { tick: number; shape: number }[] {
  const d = profileFlightDynamics(module, build, 400), frame = armed(build, duty), pilot = newInput(), report = new Float64Array(8);
  // The hull, then one propeller disc per rotor in rotor order (TASK-095). A shape that struck counts again after 0.25 s clear.
  const parts = build.gear?.parts ?? [], hullCount = parts.filter(part => part.part === 'hull').length;
  const struck = new Set<number>(), lastContact = new Map<number, number>();
  const found: { tick: number; shape: number }[] = [];
  try {
    for (let k = 1; k <= ticks; k++) {
      d.useActuators(frame); d.nowMs = k * 2.5; d.stepNow(pilot);
      for (let i = 0; i < d.contactShapeCount; i++) {
        d.contactShapeStateInto(i, report);
        if (report[6] !== 1) {
          if (struck.has(i) && k / 400 - (lastContact.get(i) ?? 0) >= 0.25 - 1e-6) struck.delete(i);
          continue;
        }
        lastContact.set(i, k / 400);
        const turning = parts[i]?.part === 'propeller' && Math.abs(d.rotorSpeedRadS(i - hullCount)) >= 1;
        const meets = turning || report[0]! >= 0.001 || report[2]! >= 0.05 * massKg * 9.80665;
        if (meets && !struck.has(i)) { found.push({ tick: k, shape: i }); struck.add(i); }
      }
    }
    return found;
  } finally { d.dispose(); }
}
function firstStrike(build: ProfileDynamicsBuild, massKg: number, duty: number, ticks: number): { tick: number; shape: number } | null {
  return strikes(build, massKg, duty, ticks)[0] ?? null;
}
function armed(build: ProfileDynamicsBuild, duty: number) {
  const frame = newActuatorFrameV2();
  frame.motorMapId = build.configuration.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed; frame.actuatorCount = 4;
  frame.normalizedActuators.fill(duty, 0, 4);
  return frame;
}

/** A session on `build` at 400 Hz with a hand-driven clock. */
function session(build: ProfileDynamicsBuild) {
  let now = 0;
  const clock: SessionClock = { monotonicMs: () => now, wallMs: () => 1.7e12 + now };
  const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator');
  const s = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
    clock, hz => profileFlightDynamics(module, build, hz));
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  const command = (type: string, extra: Record<string, unknown> = {}): CommandResultV2 | undefined => {
    reader.readHeader(header);
    s.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
    s.drain(result => results.push(result));
    return results.at(-1);
  };
  const latest = () => { reader.latest(state); return state; };
  const accidents = (): AccidentEvent[] => { const out: AccidentEvent[] = []; s.drainAccidents(e => out.push(e)); return out; };
  return { s, command, latest, accidents, advance: (ms: number) => { now += ms; return s.pump(); }, actuatorBuffer };
}
const tickOf = (state: { tickId: { lo: number; hi: number } }) => state.tickId.hi * 2 ** 32 + state.tickId.lo;

describe('accident pause in a physics session', () => {
  it('a stopped propeller striking pauses the session on its accident tick; each later strike pauses it again, as the plain run predicts', async () => {
    const built = await quad(), strike = tipped(built);
    // One second: the first disc strikes, the quad rolls on, and other shapes start to touch.
    const oracle = strikes(strike, built.massKg, 0, 400), first = oracle[0];
    if (!first) throw new Error('The tipped quad did not strike');
    const { s, command, latest, accidents, advance } = session(strike);
    expect(command('sim.start')).toMatchObject({ type: 'ack-v2', status: 'applied' });
    // 10 ms per wakeup: four due ticks each, so a strike falls inside a catch-up batch.
    for (let i = 0; i < 200 && s.running; i++) advance(10);
    expect(s.running).toBe(false);
    const [event, ...more] = accidents();
    expect(more).toEqual([]);
    expect(event?.tick).toBe(first.tick);
    expect(event?.part).toEqual(strike.gear?.parts[first.shape]);
    expect(event?.rotorSpeedRadS).toBe(0);
    // The published state is that tick's, marked paused, and the session steps no further.
    const paused = latest();
    expect(tickOf(paused)).toBe(first.tick);
    expect(paused.vehicleFlags & VehicleFlagV2.Paused).toBe(VehicleFlagV2.Paused);
    expect(advance(10)).toBe(-1);
    expect(tickOf(latest())).toBe(first.tick);
    expect(s.accidentTotal).toBe(1);
    // Continuing, as after a user pause: every later strike pauses on its own tick, a contact that goes on is never raised
    // again, and the pauses leave the dynamics as in the plain run, so the events are the oracle's.
    const seen = [{ tick: event?.tick, part: event?.part }];
    for (let i = 0; i < 1000 && tickOf(latest()) < 400; i++) {
      if (!s.running) {
        for (const next of accidents()) {
          expect(tickOf(latest())).toBe(next.tick);
          seen.push({ tick: next.tick, part: next.part });
        }
        expect(command('sim.start')).toMatchObject({ type: 'ack-v2', status: 'applied' });
      }
      advance(10);
    }
    const tail = accidents();
    for (const next of tail) seen.push({ tick: next.tick, part: next.part });
    const expected = oracle.filter(hit => hit.tick <= tickOf(latest())).map(hit => ({ tick: hit.tick, part: strike.gear?.parts[hit.shape] }));
    expect(seen).toEqual(expected);
    expect(expected.length).toBeGreaterThan(1);
    expect(s.accidentTotal).toBe(expected.length);
    expect(s.fault).toBe('');
    // A new epoch forgets the accidents.
    if (s.running) expect(command('sim.pause')).toMatchObject({ status: 'applied' });
    expect(command('sim.reset', { seed: 1 })).toMatchObject({ status: 'applied' });
    expect(s.accidentTotal).toBe(0);
    s.dispose();
  }, 300000);

  it('an upside-down quad strikes with its body: a hull accident on its tick', async () => {
    const built = await quad(), inverted = tipped(built, Math.PI, 0);
    const oracle = firstStrike(inverted, built.massKg, 0, 400);
    if (!oracle) throw new Error('The inverted quad did not strike');
    // Inverted, the body cylinder's top (0.4 of a quarter of the 0.225 m arms above the reference point) is the lowest shape.
    expect(inverted.gear?.parts[oracle.shape]).toEqual({ part: 'hull', hullId: 0 });
    const { s, command, latest, accidents, advance } = session(inverted);
    command('sim.start');
    for (let i = 0; i < 200 && s.running; i++) advance(10);
    const [event] = accidents();
    expect(event?.tick).toBe(oracle.tick);
    expect(event?.part).toEqual({ part: 'hull', hullId: 0 });
    expect(event?.rotorSpeedRadS).toBeNull();
    expect(tickOf(latest())).toBe(oracle.tick);
    s.dispose();
  }, 300000);

  it('in lockstep a turning propeller strikes on the tick its disc first touches, and the next autopilot frame waits', async () => {
    const built = await quad(), strike = tipped(built);
    const duty = 0.15, oracle = firstStrike(strike, built.massKg, duty, 400);
    if (!oracle) throw new Error('The tipped quad did not strike');
    const { s, command, latest, accidents, advance, actuatorBuffer } = session(strike);
    expect(command('sim.configure', { hz: 400, clockMode: 'sitl-lockstep' })).toMatchObject({ status: 'applied' });
    expect(command('sim.start')).toMatchObject({ status: 'applied' });
    const producer = new SpscProducer(actuatorBuffer, 'actuator', 'sitl-would-block'), codec = new ActuatorFrameCodecV2(), frame = armed(strike, duty);
    reader: for (let tick = 1; tick <= 400; tick++) {
      frame.tickId.lo = tick; frame.tickId.hi = 0; frame.epoch = latest().epoch;
      expect(codec.encode(frame) && producer.tryPush(codec.words)).toBe('ok');
      advance(0);
      if (!s.running) break reader;
    }
    const [event] = accidents();
    expect(event?.tick).toBe(oracle.tick);
    expect(event?.part.part).toBe('propeller');
    expect(Math.abs(event?.rotorSpeedRadS ?? 0)).toBeGreaterThanOrEqual(ACCIDENT_RULES.turningRadS);
    // The frame for the next tick goes in, and the paused session leaves it there.
    frame.tickId.lo = oracle.tick + 1;
    expect(codec.encode(frame) && producer.tryPush(codec.words)).toBe('ok');
    for (let i = 0; i < 5; i++) advance(1);
    expect(tickOf(latest())).toBe(oracle.tick);
    expect(command('sim.start')).toMatchObject({ status: 'applied' });
    advance(0);
    expect(tickOf(latest())).toBe(oracle.tick + 1);
    s.dispose();
  }, 300000);

  it('a hard landing on the support points raises no accident', async () => {
    const built = await quad(), gear = built.gear;
    if (!gear) throw new Error('No gear');
    // Level, motors off, the extended feet 0.2 m above the ground: a touchdown at about 2 m/s, which bottoms out the struts.
    const touch = -built.configuration.initialBody.positionNedM[2]!;
    const drop = { ...built, configuration: { ...built.configuration, initialBody: { ...built.configuration.initialBody,
      positionNedM: Float64Array.from([0, 0, -(touch + 0.2)]) } } };
    const d = profileFlightDynamics(module, drop, 400), frame = armed(drop, 0), pilot = newInput();
    try {
      let sink = 0, peak = 0;
      for (let k = 1; k <= 800; k++) {
        d.useActuators(frame); d.nowMs = k * 2.5; d.stepNow(pilot);
        d.accidents!.at[0] = k; d.accidents!.at[1] = k / 400;
        expect(d.accidents?.check(), `tick ${k}`).toBe(0);
        sink = Math.max(sink, d.state.vd); peak = Math.max(peak, -d.state.ad);
      }
      expect(sink).toBeGreaterThan(1.9);
      // The supports stop it at more than three times g.
      expect(peak).toBeGreaterThan(3 * 9.80665);
      expect(d.accidents?.total).toBe(0);
    } finally { d.dispose(); }
  }, 300000);
});

describe('accident records', () => {
  it('the accident events and the pause land in the recording with their contact loads', async () => {
    const built = await quad(), strike = tipped(built);
    const { s, command, accidents, advance } = session(strike);
    command('sim.start');
    for (let i = 0; i < 200 && s.running; i++) advance(10);
    const [event] = accidents();
    if (!event) throw new Error('No accident');
    const plan = planRates({}, { physicsHz: 400, telemetryHz: 10 }), backend = new MemoryRecordingBackend(), recordId = 'f'.repeat(32);
    const writer = await StreamWriter.start(backend, headerFromPlan(plan, { recordId, experimentId: 'task-149', startedAt: '2026-11-02T00:00:00.000Z',
      modelSha256: null, firmware: null }));
    const consumer = new RecordingConsumerV2(null, recordKey(recordId), writer);
    // As Main writes them on the Worker's accident message: the event's rows, then the pause on the same tick.
    for (const values of accidentRows(event)) expect(consumer.appendRow(valueRow(SignalId.Accident, values, event.tick, event.simTimeS, 1))).toBe(true);
    expect(consumer.appendRow(valueRow(SignalId.Pause, [1], event.tick, event.simTimeS, 1))).toBe(true);
    consumer.finish();
    const entry = await writer.close();
    expect(entry.rows['events.accident']).toBe(3);
    const opened = await openRecording(backend, recordId);
    const rows = opened.rows.get('events.accident') ?? [];
    expect(rows.map(row => row.tick)).toEqual([event.tick, event.tick, event.tick]);
    expect(rows[0]?.values).toEqual([2, event.part.part === 'propeller' ? event.part.rotorId : -1, event.forceN, event.penetrationM]);
    expect(rows[1]?.values).toEqual([3, ...event.pointBodyM]);
    expect(rows[2]?.values?.slice(0, 3)).toEqual([4, event.impulseNs, 0]);
    expect(opened.rows.get('events.pause')?.map(row => [row.tick, row.values?.[0]])).toEqual([[event.tick, 1]]);
    // The contact load is a real reaction: a positive normal force on a stopped propeller of at least 1 mm or 5 % of the weight.
    expect(event.forceN > 0.05 * built.massKg * 9.80665 || event.penetrationM >= 0.001).toBe(true);
    s.dispose();
  }, 300000);
});
