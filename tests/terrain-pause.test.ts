import { describe, expect, it } from 'vitest';
import { StateReaderV2, VehicleFlagV2, createSharedMemoryV2, createSpscQueue, newFlightStateV2, newHeaderSnapshotV2, tickToNumber, type CommandResultV2 } from '@mirage/protocol';
import {
  PhysicsSessionV2, TERRAIN_MISSING_COUNT, TERRAIN_MISSING_EAST, TERRAIN_MISSING_NORTH, TERRAIN_MISSING_SIM_S, TERRAIN_MISSING_TICK, TERRAIN_READY_RADIUS_M,
  type SessionClock, type SessionGround,
} from '../packages/physics/src/session-v2.ts';
import { CollisionChunks } from '../packages/terrain/src/collision-chunks.ts';
import { DemoDynamics } from '../packages/physics/src/demo-dynamics.ts';
import { VALIDITY_RING } from '../packages/physics/src/session-v2.ts';
import type { PilotInput } from '@mirage/protocol';
import { RUN_CHUNK_RESOLUTION, RUN_CHUNK_SPACING_M, RUN_TERRAIN_EPOCH } from '../packages/terrain/src/run-terrain.ts';

// TASK-186: a real-terrain run pauses on the tick whose step leaves the vehicle without published ground within
// TERRAIN_READY_RADIUS_M, through the path an accident pause takes (TASK-149, TASK-156); a session without terrain never checks.

function session(hz: 400 | 800 = 400) {
  let now = 0;
  const clock: SessionClock = { monotonicMs: () => now, wallMs: () => 1.79e12 + now };
  const stateBuffer = createSharedMemoryV2();
  const s = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer: createSpscQueue('actuator') }, clock);
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  const command = (type: string, extra: Record<string, unknown> = {}) => {
    reader.readHeader(header);
    s.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
    s.drain(result => results.push(result));
    return results.at(-1);
  };
  command('sim.configure', { hz, clockMode: 'interactive' });
  const latest = () => { reader.latest(state); return state; };
  return { s, command, latest, advance: (ms: number) => { now += ms; return s.pump(); } };
}
/** A ground that is there for the first `ready` checks, and then missing; it keeps what it was asked. */
function countedGround(ready: number) {
  const asked: number[][] = [];
  const ground: SessionGround = { readyFrom: q => { asked.push(Array.from(q)); return asked.length <= ready; }, planeInto: (_position, out) => { out.fill(Number.NaN); } };
  return { ground, asked };
}
function lattice(chunks: readonly (readonly [number, number])[]): CollisionChunks {
  const store = new CollisionChunks(RUN_TERRAIN_EPOCH, RUN_CHUNK_RESOLUTION, RUN_CHUNK_SPACING_M);
  for (const [northIndex, eastIndex] of chunks) {
    if (!store.stage({ version: 1, epoch: RUN_TERRAIN_EPOCH, revision: 0, resolution: RUN_CHUNK_RESOLUTION, spacingM: RUN_CHUNK_SPACING_M, northIndex, eastIndex,
      downM: new Float64Array(RUN_CHUNK_RESOLUTION ** 2) })) throw new Error('The chunk did not stage');
  }
  store.publishAtTick(RUN_TERRAIN_EPOCH, 0);
  return store;
}

describe('missing terrain in a physics session (TASK-186)', () => {
  it('pauses on the first tick without ground, says where, and pauses again on the next such tick after a resume', () => {
    const { s, command, latest, advance } = session(400), { ground, asked } = countedGround(57);
    s.attachGround(ground);
    expect(command('sim.start')).toMatchObject({ type: 'ack-v2', status: 'applied' });
    for (let i = 0; i < 100 && s.running; i++) advance(10);
    expect(s.running).toBe(false);
    // 57 ticks had ground; the 58th did not, and the session stepped no further.
    expect(asked.length).toBe(58);
    const paused = latest(), tick = tickToNumber(paused.tickId);
    expect(tick).toBe(58);
    expect(paused.vehicleFlags & VehicleFlagV2.Paused).toBe(VehicleFlagV2.Paused);
    // The query is the vehicle's position after that tick's step, with the readiness radius.
    expect(asked.at(-1)).toEqual([paused.northM, paused.eastM, TERRAIN_READY_RADIUS_M]);
    const missing = s.terrainMissing;
    expect([missing[TERRAIN_MISSING_COUNT], missing[TERRAIN_MISSING_TICK], missing[TERRAIN_MISSING_SIM_S], missing[TERRAIN_MISSING_NORTH], missing[TERRAIN_MISSING_EAST]])
      .toEqual([1, 58, 58 / 400, paused.northM, paused.eastM]);
    expect(advance(10)).toBe(-1);
    expect(tickToNumber(latest().tickId)).toBe(58);
    // Resumed while the ground is still missing, the run steps one tick and pauses on it.
    expect(command('sim.start')).toMatchObject({ type: 'ack-v2', status: 'applied' });
    for (let i = 0; i < 10 && s.running; i++) advance(10);
    expect(s.running).toBe(false);
    expect(tickToNumber(latest().tickId)).toBe(59);
    expect(missing[TERRAIN_MISSING_COUNT]).toBe(2);
    expect(missing[TERRAIN_MISSING_TICK]).toBe(59);
  });
  it('runs on while the published terrain holds the vehicle, and pauses on the first tick when it does not', () => {
    const around = session(), away = session();
    around.s.attachGround(lattice([[-1, -1], [-1, 0], [0, -1], [0, 0]]));
    away.s.attachGround(lattice([[3, 3]]));
    around.command('sim.start'); away.command('sim.start');
    for (let i = 0; i < 100; i++) { around.advance(10); away.advance(10); }
    expect(around.s.running).toBe(true);
    expect(tickToNumber(around.latest().tickId)).toBeGreaterThan(390);
    expect(around.s.terrainMissing[TERRAIN_MISSING_COUNT]).toBe(0);
    expect(away.s.running).toBe(false);
    expect(tickToNumber(away.latest().tickId)).toBe(1);
    expect(away.s.terrainMissing[TERRAIN_MISSING_TICK]).toBe(1);
  });
  it('checks nothing without terrain, and a detached terrain stops the checks', () => {
    const { s, command, advance } = session(), { ground, asked } = countedGround(0);
    command('sim.start');
    for (let i = 0; i < 20; i++) advance(10);
    expect(s.running).toBe(true);
    s.attachGround(ground);
    s.attachGround(null);
    for (let i = 0; i < 20; i++) advance(10);
    expect(s.running).toBe(true);
    expect(asked).toEqual([]);
    expect(s.terrainMissing[TERRAIN_MISSING_COUNT]).toBe(0);
  });
});

// TASK-145: each change of the model's validity bits is kept with its tick for the recording's events.validity, and a full ring counts what it drops.
/** The demo vehicle with validity bits set from a tick on and cleared at another. */
class FlaggedDemo extends DemoDynamics {
  validityFlags = 0;
  steps = 0;
  constructor(private readonly on: number, private readonly off: number, private readonly every = 0) { super(400); }
  override stepNow(input: PilotInput): void {
    super.stepNow(input);
    this.steps++;
    this.validityFlags = this.every > 0 ? (this.steps % this.every === 0 ? 1 << 18 : 0) : this.steps >= this.on && this.steps < this.off ? 1 << 18 : 0;
  }
}
describe('validity changes of the flight model (TASK-145)', () => {
  function flagged(dynamics: FlaggedDemo) {
    let now = 0;
    const clock: SessionClock = { monotonicMs: () => now, wallMs: () => 1.79e12 + now };
    const stateBuffer = createSharedMemoryV2();
    const s = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer: createSpscQueue('actuator') }, clock, () => dynamics);
    const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2();
    reader.readHeader(header);
    s.handle({ protocolVersion: 2, requestId: 1, expectedEpoch: header.sessionEpoch, type: 'sim.configure', hz: 400, clockMode: 'interactive' });
    reader.readHeader(header);
    s.handle({ protocolVersion: 2, requestId: 2, expectedEpoch: header.sessionEpoch, type: 'sim.start' });
    return { s, advance: (ms: number) => { now += ms; s.pump(); } };
  }
  it('keeps the tick of each change, on and off, and nothing while the bits stay', () => {
    const { s, advance } = flagged(new FlaggedDemo(10, 30));
    for (let i = 0; i < 20; i++) advance(10);
    const changes: number[][] = [];
    expect(s.drainValidityChanges((tick, simTimeS, flags) => changes.push([tick, simTimeS, flags]))).toBe(2);
    expect(changes).toEqual([[10, 10 / 400, 1 << 18], [30, 30 / 400, 0]]);
    expect(s.drainValidityChanges(() => undefined)).toBe(0);
    expect(s.validityChangesDropped).toBe(0);
  });
  it('drops the oldest changes beyond its ring and counts them', () => {
    const { s, advance } = flagged(new FlaggedDemo(0, 0, 2));
    for (let i = 0; i < 20; i++) advance(10);
    const ticks: number[] = [];
    expect(s.drainValidityChanges(tick => ticks.push(tick))).toBe(VALIDITY_RING);
    expect(s.validityChangesDropped).toBeGreaterThan(0);
    expect(ticks.every((tick, i) => i === 0 || tick > (ticks[i - 1] ?? Infinity))).toBe(true);
  });
});
