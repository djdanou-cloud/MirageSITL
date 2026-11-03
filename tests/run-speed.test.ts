// TASK-175: run speed. The meter's numbers are checked against hand-computed
// ratios (decision A-05: a real-time run averages at least 0.99, and every
// dropped interval is reported). The step-sequence claim is checked on a real
// PhysicsSessionV2 in sitl-lockstep with the quad profile: the same servo
// frames delivered at a real-time pace and at a much faster one give
// byte-identical state lines; that tolerance, identical bytes, was declared
// before the test was written. Without an autopilot the climb tips the quad
// until a propeller strikes: both paces stop on the same tick with the same
// accident report.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareContact } from './contact-support.ts';
import { BRIDGE_HEADER_BYTES, SitlJsonLink } from '@mirage/autopilot/sitl-link';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newHeaderSnapshotV2, type CommandResultV2 } from '@mirage/protocol';
import type { AccidentEvent } from '../packages/physics/src/accident.ts';
import { encodeRecord } from '../apps/bridge/src/framing.ts';
import { AS_FAST_AS_POSSIBLE, REAL_TIME_MIN_RATIO, RunSpeedMeter, speedModeOf } from '../apps/web/src/run/run-speed.ts';
import { quadProfile } from './support/quad-profile.ts';

/**
 * Feeds `meter` one sample every `stepMs` of wall time after `fromS` up to `toS` s, simulated time starting at `simS` and
 * advancing at `ratio`; the wall clock reads `offsetMs` more than the running time.
 */
function run(meter: RunSpeedMeter, fromS: number, toS: number, simS: number, ratio: number, offsetMs = 0, stepMs = 100): void {
  for (let i = 1; fromS * 1000 + i * stepMs <= toS * 1000; i++) {
    meter.sample(offsetMs + fromS * 1000 + i * stepMs, simS + i * stepMs / 1000 * ratio);
  }
}

describe('the run-speed meter', () => {
  it('names the mode from the requested speed-up', () => {
    expect([1, 2, 4, AS_FAST_AS_POSSIBLE, null].map(speedModeOf)).toEqual(['real-time', 'capped', 'capped', 'as-fast-as-possible', 'external']);
    expect(() => new RunSpeedMeter(0)).toThrow('positive');
    expect(new RunSpeedMeter(1).view).toMatchObject({ windowSpeed: null, averageSpeed: null, intervals: 0, dropped: [], realTime: null });
  });

  it('calls a steady real-time run real time, with no dropped interval', () => {
    const meter = new RunSpeedMeter(1);
    meter.begin(5000, 2);
    run(meter, 0, 3, 2, 1, 5000);
    const view = meter.view;
    expect(view.intervals).toBe(3);
    expect(view.dropped).toEqual([]);
    expect(view.averageSpeed).toBeCloseTo(1, 12);
    expect(view.windowSpeed).toBeCloseTo(1, 12);
    expect([view.realTime, view.runningWallS, view.simElapsedS].map(v => typeof v === 'number' ? Number(v.toFixed(9)) : v)).toEqual([true, 3, 3]);
  });

  it('reports a stalled second as a dropped interval and the run as behind real time', () => {
    const meter = new RunSpeedMeter(1);
    meter.begin(0, 0);
    run(meter, 0, 3, 0, 1);
    run(meter, 3, 4, 3, 0.5);
    run(meter, 4, 6, 3.5, 1);
    const view = meter.view;
    expect(view.intervals).toBe(6);
    expect(view.dropped).toHaveLength(1);
    expect(view.dropped[0]).toMatchObject({ index: 3 });
    expect(view.dropped[0]?.startWallS).toBeCloseTo(3, 9);
    expect(view.dropped[0]?.startSimS).toBeCloseTo(3, 9);
    expect(view.dropped[0]?.simAdvancedS).toBeCloseTo(0.5, 9);
    // 5.5 s simulated in 6 s.
    expect(view.averageSpeed).toBeCloseTo(5.5 / 6, 9);
    expect(view.realTime).toBe(false);
    expect(5.5 / 6).toBeLessThan(REAL_TIME_MIN_RATIO);
  });

  it('interpolates interval boundaries between irregular samples', () => {
    const meter = new RunSpeedMeter(1);
    meter.begin(0, 0);
    meter.sample(1500, 1.5);
    meter.sample(2500, 2.0);
    // Interval 0 advanced 1.0 s; interval 1 ends at 1.5 + (2.0 - 1.5) * 0.5 = 1.75 s, an advance of 0.75 s.
    expect(meter.view.intervals).toBe(2);
    expect(meter.view.dropped.map(d => [d.index, Number(d.simAdvancedS.toFixed(9))])).toEqual([[1, 0.75]]);
  });

  it('leaves paused wall time out, and ignores samples while paused', () => {
    const meter = new RunSpeedMeter(1);
    meter.begin(0, 0);
    run(meter, 0, 2, 0, 1);
    meter.pause(2000, 2);
    meter.sample(300_000, 2);
    meter.resume(600_000);
    run(meter, 2, 4, 2, 1, 598_000);
    const view = meter.view;
    expect(view.runningWallS).toBeCloseTo(4, 9);
    expect(view.averageSpeed).toBeCloseTo(1, 9);
    expect(view.dropped).toEqual([]);
    expect(view.realTime).toBe(true);
  });

  it('measures SITL start-up before the first heartbeat on its own, outside the run it judges', () => {
    const meter = new RunSpeedMeter(1);
    // 10 s of wall time for 2 s of simulated time while SITL boots, with a 30 s accident pause in it.
    meter.sample(0, 0);
    meter.sample(4000, 0.8);
    meter.pause(4000, 0.8);
    meter.resume(34_000);
    meter.sample(40_000, 2);
    meter.begin(40_000, 2);
    run(meter, 0, 3, 2, 1, 40_000);
    const view = meter.view;
    expect(view.startup?.simS).toBeCloseTo(2, 9);
    expect(view.startup?.wallS).toBeCloseTo(10, 9);
    expect([view.intervals, view.dropped.length, view.realTime]).toEqual([3, 0, true]);
    expect(view.averageSpeed).toBeCloseTo(1, 9);
    expect(new RunSpeedMeter(1).view.startup).toBeNull();
  });

  it('measures the window over the last 5 s and the average over the run', () => {
    const meter = new RunSpeedMeter(AS_FAST_AS_POSSIBLE);
    meter.begin(0, 0);
    run(meter, 0, 10, 0, 1);
    run(meter, 10, 15, 10, 3);
    const view = meter.view;
    expect(view.windowSpeed).toBeCloseTo(3, 9);
    expect(view.averageSpeed).toBeCloseTo(25 / 15, 9);
    // An accelerated run promises no factor: no real-time verdict, no dropped intervals.
    expect([view.mode, view.realTime, view.dropped]).toEqual(['as-fast-as-possible', null, []]);
  });
});

const EPOCH = 7, HZ = 400;
let module: WebAssembly.Module;
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  await prepareContact();
}, 600000);

/** A sitl-lockstep session of the quad profile whose clocks advance `msPerFrame` per delivered frame. */
async function session(msPerFrame: number) {
  const { derived } = await quadProfile();
  const registry = new VehicleRegistry();
  await registry.register(derived.bytes, derived.sha256);
  let nowMs = 0;
  const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator');
  const physics = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
    { monotonicMs: () => nowMs, wallMs: () => 1_790_000_000_000 + nowMs }, undefined, null, profileModelPort(registry, () => module));
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  const command = async (type: string, extra: Record<string, unknown> = {}) => {
    reader.readHeader(header);
    physics.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
    await physics.settled();
    physics.drain(result => results.push(result));
    return results.at(-1);
  };
  expect(await command('sim.configure', { hz: HZ, clockMode: 'sitl-lockstep' })).toMatchObject({ status: 'applied' });
  expect(await command('model.load', { modelId: 153, manifestSha256: derived.sha256 })).toMatchObject({ status: 'applied' });
  expect(await command('sim.start')).toMatchObject({ status: 'applied' });
  const link = new SitlJsonLink(stateBuffer, actuatorBuffer, {
    bridgeEpoch: EPOCH, motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1), motorMapId: derived.manifest.modelId });
  /**
   * One servo frame, delivered as the physics Worker does, after `msPerFrame` of the session's clocks: the reply's bytes, or
   * null when the session paused on an accident (TASK-149) with the accidents it reported.
   */
  const deliver = (frame: number, pwmUs: number): { reply: Uint8Array | null; accidents: AccidentEvent[] } => {
    nowMs += msPerFrame;
    const packet = new Uint8Array(40), view = new DataView(packet.buffer);
    view.setUint16(0, 18458, true); view.setUint16(2, HZ, true); view.setUint32(4, frame, true);
    for (let i = 0; i < 4; i++) view.setUint16(8 + 2 * i, pwmUs, true);
    expect(link.receive(encodeRecord({ channel: 3, epoch: EPOCH, sequence: frame, payload: packet }))).toBe('step');
    physics.pump();
    const n = link.poll(), accidents: AccidentEvent[] = [];
    physics.drainAccidents(event => accidents.push(event));
    return { reply: n > BRIDGE_HEADER_BYTES ? link.outbound.slice(0, n) : null, accidents };
  };
  return { deliver };
}

describe('the same step sequence at any pace', () => {
  it('gives byte-identical state lines and the same accident on the same tick for the same servo frames at real time and at 25 times its pace', async () => {
    const realTime = await session(1000 / HZ), fast = await session(1000 / HZ / 25);
    // 1 s settling on the gear at idle, then a climb at 1800 us without an autopilot, which tips the quad until a propeller strikes.
    const pwmAt = (frame: number) => frame < HZ ? 1000 : 1800;
    // Accidents are drained as the session reports them; the frame after the strike gets no reply.
    const struckA: AccidentEvent[] = [], struckB: AccidentEvent[] = [];
    let differing = 0, answered = 0, stop: { frame: number; a: AccidentEvent[]; b: AccidentEvent[] } | null = null;
    for (let frame = 0; frame < 4 * HZ && !stop; frame++) {
      const a = realTime.deliver(frame, pwmAt(frame)), b = fast.deliver(frame, pwmAt(frame));
      struckA.push(...a.accidents);
      struckB.push(...b.accidents);
      if (!a.reply || !b.reply) { stop = { frame, a: struckA, b: struckB }; break; }
      answered++;
      if (a.reply.length !== b.reply.length || a.reply.some((byte, i) => byte !== b.reply?.[i])) differing++;
    }
    expect(differing).toBe(0);
    expect(answered).toBeGreaterThan(2 * HZ);
    expect(stop).not.toBeNull();
    expect(stop?.a.length).toBeGreaterThan(0);
    expect(stop?.b).toEqual(stop?.a);
    console.log(`EVID ${answered} identical replies, then accidents at tick ${stop?.a[0]?.tick}: ${stop?.a.map(e => JSON.stringify(e.part)).join(' ')}`);
  }, 120000);
});
