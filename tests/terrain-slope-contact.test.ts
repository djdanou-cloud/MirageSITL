import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BetFlightDynamics } from '@mirage/physics/bet-dynamics';
import { buildProfileDynamics, profileFlightDynamics } from '../packages/physics/src/profile-dynamics.ts';
import { standOnPlane, type GroundLattice } from '../packages/physics/src/terrain-contact.ts';
import { CollisionChunks } from '../packages/terrain/src/collision-chunks.ts';
import { RUN_CHUNK_RESOLUTION, RUN_CHUNK_SPACING_M, RUN_TERRAIN_EPOCH } from '../packages/terrain/src/run-terrain.ts';
import { newBodyTruth } from '@mirage/wasm-bet/backend';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '@mirage/protocol';
import { validateAircraftProfile, withPropellerPolars } from '../packages/aircraft/src/profile.ts';
import { validateComponentCard } from '../packages/aircraft/src/components.ts';
import { resolveComponents } from '../packages/aircraft/src/resolve-components.ts';
import { deriveVehicleManifest } from '../packages/aircraft/src/derive-manifest.ts';
import { prepareContact } from './contact-support.ts';
import { CONTACT_LIFTOFF, CONTACT_TOUCHDOWN, PhysicsSessionV2, type SessionClock } from '../packages/physics/src/session-v2.ts';
import { RecordingProducerV2, RecordingQueueReaderV2, createRecordingQueueV2, producerPlan } from '../packages/aar/src/recorder-v2.ts';
import { planRates, signalById, SignalId } from '../packages/aar/src/signal-catalog.ts';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newFlightStateV2, newHeaderSnapshotV2 } from '@mirage/protocol';

// TASK-187 (S18): a real profile's standard gear on sloped terrain through the published collision chunks, with the rotors at rest.
// Tolerances declared before the first run, from decision F-08 (μ_s = 0.6, μ_k = 0.5) and the closed forms of a body on an incline:
//  - the pose on a plane: body down along the slope's down within 1e-12, the CG's height along the normal kept within 1e-9 m;
//  - a level lattice equals level ground within 1e-9 m;
//  - below breakaway, tan θ < μ_s: after settling it creeps under 1 cm/s, tilts within 0.5° of the slope, and the supports carry
//    m g cos θ within 2 %;
//  - above it, the acceleration down the slope is g (sin θ - μ_k cos θ) within 5 %;
//  - a drop onto a slope has no rate-dependent peak: the peak support load at 400, 800 and 1200 Hz within 10 % of their mean.
// No landing-gear fidelity is claimed.

const G = 9.80665, RATES = [400, 800, 1200] as const;
let module: WebAssembly.Module;
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const ids = { motor: '11'.repeat(32), propeller: '22'.repeat(32), esc: '33'.repeat(32), battery: '44'.repeat(32) };
async function derive() {
  const cards = new Map(Object.entries(ids).map(([type, id]) => [id, validateComponentCard(json(`tests/fixtures/components/${type}-example.json`))]));
  const base = validateAircraftProfile(json('tests/fixtures/aircraft/quad-x.json'));
  const profile = withPropellerPolars(validateAircraftProfile({ ...base, battery: { card: ids.battery },
    motors: base.motors.map(motor => ({ ...motor, components: { motor: ids.motor, propeller: ids.propeller, esc: ids.esc } })) }),
  [{ card: ids.propeller, polar: 'naca6409-neuralfoil-v1' }]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(resolved.missing.join('; '));
  return deriveVehicleManifest(profile, resolved.components, { modelId: 187 });
}
let manifest: Awaited<ReturnType<typeof derive>>['manifest'];
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  await prepareContact();
  manifest = (await derive()).manifest;
}, 300000);

const SPAN = (RUN_CHUNK_RESOLUTION - 1) * RUN_CHUNK_SPACING_M;
/** Chunks of the run terrain's own size holding a plane whose ground rises to the north at `slopeDeg`. */
function slope(slopeDeg: number): CollisionChunks {
  const k = Math.tan(slopeDeg * Math.PI / 180), n = RUN_CHUNK_RESOLUTION;
  const store = new CollisionChunks(RUN_TERRAIN_EPOCH, n, RUN_CHUNK_SPACING_M, 32);
  for (const northIndex of [-2, -1, 0, 1]) for (const eastIndex of [-1, 0]) {
    const downM = new Float64Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) downM[r * n + c] = -k * (northIndex * SPAN + r * RUN_CHUNK_SPACING_M);
    expect(store.stage({ version: 1, epoch: RUN_TERRAIN_EPOCH, revision: 0, resolution: n, spacingM: RUN_CHUNK_SPACING_M, northIndex, eastIndex, downM })).toBe(true);
  }
  expect(store.publishAtTick(RUN_TERRAIN_EPOCH, 0)).toBe(true);
  return store;
}
/** The profile's dynamics on `ground`, with `droppedM` of air under its start; the rotors stay at rest. */
function vehicle(hz: 400 | 800 | 1200, ground: GroundLattice | null, droppedM = 0): { d: BetFlightDynamics; massKg: number; run: (seconds: number, each?: () => void) => void } {
  const build = buildProfileDynamics(manifest, {});
  build.configuration.initialBody.positionNedM[2] = (build.configuration.initialBody.positionNedM[2] ?? 0) - droppedM;
  const d = profileFlightDynamics(module, build, hz);
  if (ground) d.attachGround(ground);
  const frame = newActuatorFrameV2(), pilot = newInput();
  frame.motorMapId = build.configuration.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed; frame.actuatorCount = manifest.rotorCount;
  let tick = 0;
  return { d, massKg: manifest.massProperties.massKg, run: (seconds, each) => {
    for (let i = 0; i < seconds * hz; i++) {
      d.useActuators(frame); d.nowMs = ++tick * 1000 / hz; d.stepNow(pilot);
      expect(d.fault).toBe('');
      each?.();
    }
  } };
}
const tiltDeg = (d: BetFlightDynamics): number => Math.acos(Math.min(1, 1 - 2 * (d.state.qx * d.state.qx + d.state.qy * d.state.qy))) * 180 / Math.PI;
const loadN = (d: BetFlightDynamics): number => (d.contactLoads?.normalN ?? new Float64Array()).reduce((sum, x) => sum + x, 0);

describe('standing on a plane', () => {
  it('turns body down onto the slope, keeps the height along the normal and the heading', () => {
    const flat = newBodyTruth();
    flat.positionNedM.set([3, -4, -0.25]);
    const heading = 70 * Math.PI / 180;
    flat.quaternionBodyToNed.set([Math.cos(heading / 2), 0, 0, Math.sin(heading / 2)]);
    const length = Math.hypot(0.3, -0.2, 1), nN = 0.3 / length, nE = -0.2 / length, nD = -1 / length, offset = 1.5;
    const out = newBodyTruth();
    standOnPlane(flat, Float64Array.of(nN, nE, nD, offset), out);
    const [w = 0, x = 0, y = 0, z = 0] = out.quaternionBodyToNed;
    expect(Math.hypot(w, x, y, z)).toBeCloseTo(1, 12);
    // The third column of the body-to-NED matrix is body down in NED.
    const down = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
    expect(Math.abs((down[0] ?? 0) + nN)).toBeLessThan(1e-12);
    expect(Math.abs((down[1] ?? 0) + nE)).toBeLessThan(1e-12);
    expect(Math.abs((down[2] ?? 0) + nD)).toBeLessThan(1e-12);
    const [north = 0, east = 0, d = 0] = out.positionNedM;
    expect(north).toBe(3); expect(east).toBe(-4);
    expect(Math.abs(nN * north + nE * east + nD * d - offset - 0.25)).toBeLessThan(1e-9);
    // The heading stands: body forward, seen from above, still along 70° on a level plane.
    const level = newBodyTruth();
    standOnPlane(flat, Float64Array.of(0, 0, -1, 0), level);
    expect(Array.from(level.quaternionBodyToNed)).toEqual(Array.from(flat.quaternionBodyToNed));
    expect(Array.from(level.positionNedM)).toEqual(Array.from(flat.positionNedM));
  });
});

describe('on published terrain (TASK-187)', () => {
  it.each(RATES)('a level lattice is level ground at %i Hz', hz => {
    const a = vehicle(hz, null), b = vehicle(hz, slope(0));
    try {
      let worst = 0;
      a.run(0.25); b.run(0.25);
      worst = Math.max(Math.abs(a.d.state.down - b.d.state.down), Math.abs(a.d.state.north - b.d.state.north), Math.abs(a.d.state.east - b.d.state.east));
      expect(worst).toBeLessThan(1e-9);
      expect(loadN(a.d)).toBeGreaterThan(0);
    } finally { a.d.dispose(); b.d.dispose(); }
  }, 120000);
  it.each([5, 15, 25])('holds on a %i° slope, below breakaway', slopeDeg => {
    for (const hz of RATES) {
      const v = vehicle(hz, slope(slopeDeg));
      try {
        v.run(3);
        const north0 = v.d.state.north, east0 = v.d.state.east;
        v.run(1);
        const creep = Math.hypot(v.d.state.north - north0, v.d.state.east - east0);
        expect(creep, `creep at ${hz} Hz`).toBeLessThan(0.01);
        expect(Math.abs(tiltDeg(v.d) - slopeDeg), `tilt at ${hz} Hz`).toBeLessThan(0.5);
        const expected = v.massKg * G * Math.cos(slopeDeg * Math.PI / 180);
        expect(Math.abs(loadN(v.d) - expected) / expected, `load at ${hz} Hz`).toBeLessThan(0.02);
      } finally { v.d.dispose(); }
    }
  }, 120000);
  it.each([35, 45])('slides on a %i° slope, above breakaway, at the Coulomb acceleration', slopeDeg => {
    const theta = slopeDeg * Math.PI / 180, expected = G * (Math.sin(theta) - 0.5 * Math.cos(theta));
    for (const hz of RATES) {
      const v = vehicle(hz, slope(slopeDeg));
      try {
        v.run(0.5);
        const north0 = v.d.state.north, vn0 = v.d.state.vn;
        v.run(1);
        // Along the slope: the ground rises to the north, so it slides south and down.
        const along = (v.d.state.vn - vn0) / Math.cos(theta);
        expect(v.d.state.north, `slides south at ${hz} Hz`).toBeLessThan(north0);
        expect(Math.abs(-along - expected) / expected, `acceleration at ${hz} Hz`).toBeLessThan(0.05);
      } finally { v.d.dispose(); }
    }
  }, 120000);
  it('a drop onto a slope has no rate-dependent peak', () => {
    const peaks = RATES.map(hz => {
      const v = vehicle(hz, slope(10), 0.3);
      try {
        let peak = 0;
        v.run(1.5, () => { peak = Math.max(peak, loadN(v.d)); });
        return peak;
      } finally { v.d.dispose(); }
    });
    const mean = peaks.reduce((sum, x) => sum + x, 0) / peaks.length;
    for (const peak of peaks) expect(Math.abs(peak - mean) / mean).toBeLessThan(0.1);
  }, 120000);
});

describe('in a physics session (TASK-187)', () => {
  /** A session on the profile, dropped from `droppedM` on `ground`, at 400 Hz on a hand-driven clock. */
  function session(droppedM: number, ground: GroundLattice) {
    const build = buildProfileDynamics(manifest, {});
    build.configuration.initialBody.positionNedM[2] = (build.configuration.initialBody.positionNedM[2] ?? 0) - droppedM;
    let now = 0;
    const clock: SessionClock = { monotonicMs: () => now, wallMs: () => 1.7e12 + now };
    const stateBuffer = createSharedMemoryV2();
    const s = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer: createSpscQueue('actuator') },
      clock, hz => profileFlightDynamics(module, build, hz));
    s.attachGround(ground);
    const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2();
    reader.readHeader(header);
    s.handle({ protocolVersion: 2, requestId: 1, expectedEpoch: header.sessionEpoch, type: 'sim.start' });
    s.drain(() => undefined);
    return { s, reader, state, advance: (ms: number) => { now += ms; return s.pump(); } };
  }
  it('stands on the slope from the start, with no touchdown and no jolt, and publishes its height above the ground', () => {
    const { s, reader, state, advance } = session(0, slope(15));
    let peak = 0;
    const hook = (sample: { contact: { count: number; normalN: Float64Array } | null }) => {
      peak = Math.max(peak, (sample.contact?.normalN ?? new Float64Array()).reduce((sum, x) => sum + x, 0));
    };
    s.setRecorder(hook);
    for (let i = 0; i < 200; i++) advance(10);
    const events: number[][] = [];
    s.drainContactEvents((tick, simTimeS, code, value) => events.push([tick, simTimeS, code, value]));
    expect(events).toEqual([]);
    const weight = manifest.massProperties.massKg * G;
    expect(peak).toBeGreaterThan(0.5 * weight);
    expect(peak).toBeLessThan(1.5 * weight);
    reader.latest(state);
    // The ground rises to the north: n = (-k, 0, -1)/|.|, offset 0.
    const k = Math.tan(15 * Math.PI / 180), length = Math.hypot(k, 1), height = (-k * state.northM - state.downM) / length;
    expect(Math.abs(state.groundClearanceM - height)).toBeLessThan(1e-5);
    expect(state.groundClearanceM).toBeGreaterThan(0.01);
    expect(state.groundClearanceM).toBeLessThan(1);
  }, 120000);
  it('keeps a drop as a touchdown with its speed, and records each support\'s load', () => {
    const { s, advance } = session(0.3, slope(10));
    const plan = planRates({}, { physicsHz: 400, telemetryHz: 10 }), queue = createRecordingQueueV2();
    const producer = new RecordingProducerV2(queue, producerPlan(plan));
    let lastLoad = 0, speedAtTouch = 0;
    const seen: number[] = [];
    s.setRecorder(sample => {
      const total = (sample.contact?.normalN ?? new Float64Array()).reduce((sum, x) => sum + x, 0);
      if (lastLoad === 0 && total > 0 && speedAtTouch === 0) speedAtTouch = sample.state.vdMps;
      lastLoad = total;
      seen.push(sample.contact?.count ?? 0);
      producer.record(sample);
    });
    for (let i = 0; i < 150; i++) advance(10);
    const events: number[][] = [];
    s.drainContactEvents((tick, simTimeS, code, value) => events.push([tick, simTimeS, code, value]));
    const touchdown = events.find(event => event[2] === CONTACT_TOUCHDOWN);
    expect(touchdown).toBeDefined();
    // From 0.3 m under gravity: v = sqrt(2 g h) along the fall, about 2.4 m/s; the same tick's published vertical speed.
    expect(Math.abs((touchdown?.[3] ?? 0) - Math.sqrt(2 * G * 0.3))).toBeLessThan(0.1);
    expect(Math.abs((touchdown?.[3] ?? 0) - speedAtTouch)).toBeLessThan(1e-3);
    expect(events.filter(event => event[2] === CONTACT_LIFTOFF).every(event => (event[3] ?? 0) > 0)).toBe(true);
    expect(Math.max(...seen)).toBe(4);
    // The catalog names the signal and the rows carry one value per support.
    expect(signalById(SignalId.TruthContact)?.name).toBe('truth.contact');
    expect(signalById(SignalId.ContactEvent)?.name).toBe('events.contact');
    expect(plan.signals.find(signal => signal.name === 'truth.contact')?.effectiveHz).toBeGreaterThan(0);
    const counts = new RecordingQueueReaderV2(queue);
    expect(counts.kept(SignalId.TruthContact)).toBeGreaterThan(0);
    expect(counts.absent(SignalId.TruthContact)).toBe(0);
  }, 120000);
});
