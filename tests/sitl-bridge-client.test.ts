import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeInto } from '@mirage/mavlink/codec';
import { packInto } from '@mirage/mavlink/messages';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newHeaderSnapshotV2, type CommandResultV2 } from '@mirage/protocol';
import { encodeRecord } from '../apps/bridge/src/framing.ts';
import { SitlBridgeClient, bridgeSocketArguments, type SitlNotice, type SitlStatus } from '../apps/web/src/sitl/bridge-client.ts';
import { quadProfile } from './support/quad-profile.ts';

// TASK-153: the physics Worker's SITL client on a real session with the quad X
// profile, fed servo records and the autopilot's own MAVLink (HEARTBEAT,
// EKF_STATUS_REPORT, GPS_RAW_INT packed here with the TASK-150 codec as
// ArduCopter sends them). READY needs 30 simulated seconds of coherent
// acknowledged IMU samples and fresh healthy diagnostics; when the diagnostics
// stop, the next status revokes it.

const HZ = 800, EPOCH = 3;
let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600000);

function servoRecord(frameCount: number): Uint8Array {
  const packet = new Uint8Array(40), view = new DataView(packet.buffer);
  view.setUint16(0, 18458, true); view.setUint16(2, HZ, true); view.setUint32(4, frameCount, true);
  for (let i = 0; i < 4; i++) view.setUint16(8 + 2 * i, 1000, true);
  return encodeRecord({ channel: 3, epoch: EPOCH, sequence: frameCount, payload: packet });
}
let mavSequence = 0;
function autopilotFrame(id: number, values: Record<string, number | readonly number[]>, length: number): Uint8Array {
  const payload = new Uint8Array(length), out = new Uint8Array(300);
  if (!packInto(id, values, payload)) throw new Error(`Cannot pack message ${id}`);
  const n = encodeInto(id, payload, mavSequence, 1, 1, out);
  mavSequence = (mavSequence + 1) & 255;
  return out.slice(0, n);
}
/** What ArduCopter sends at 10 Hz once its EKF has converged, as one channel 1 record. */
function diagnostics(simTimeS: number, sequence: number, gpsOnly = false, leadS = 0, position = false): Uint8Array {
  // An autopilot clock leading the session by leadS stamps its GPS and its time_boot_ms with that lead.
  const usec = Math.round((simTimeS + leadS) * 1e6);
  const all = [
    autopilotFrame(0, { custom_mode: 0, type: 2, autopilot: 3, base_mode: 81, system_status: 3, mavlink_version: 3 }, 9),
    autopilotFrame(193, { flags: 1 | 2 | 4 | 16 | 32, velocity_variance: 0.1, pos_horiz_variance: 0.1, pos_vert_variance: 0.1,
      compass_variance: 0.1, terrain_alt_variance: 0 }, 26),
    autopilotFrame(24, { time_usec: usec, fix_type: 3, lat: -353632610, lon: 1491652300, alt: 584000, eph: 100, epv: 100, vel: 0, cog: 0,
      satellites_visible: 10 }, 52),
  ];
  if (position) all.push(autopilotFrame(33, { time_boot_ms: Math.round((simTimeS + leadS) * 1000), lat: -353632610, lon: 1491652300, alt: 584000,
    relative_alt: 0, vx: 0, vy: 0, vz: 0, hdg: 0 }, 28));
  const frames = gpsOnly ? all.slice(2) : all;
  const bytes = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let at = 0;
  for (const frame of frames) { bytes.set(frame, at); at += frame.length; }
  return encodeRecord({ channel: 1, epoch: EPOCH, sequence, payload: bytes });
}

async function client() {
  const { derived } = await quadProfile();
  const registry = new VehicleRegistry();
  await registry.register(derived.bytes, derived.sha256);
  const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator');
  const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
    { monotonicMs: () => 0, wallMs: () => 1_790_000_000_000 }, undefined, null, profileModelPort(registry, () => module));
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  for (const [type, extra] of [['sim.configure', { hz: HZ, clockMode: 'sitl-lockstep' }],
    ['model.load', { modelId: derived.manifest.modelId, manifestSha256: derived.sha256 }], ['sim.start', {}]] as const) {
    reader.readHeader(header);
    session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
    await session.settled();
    session.drain(result => results.push(result));
    expect(results.at(-1)).toMatchObject({ status: 'applied' });
  }
  reader.readHeader(header);
  const posted: SitlNotice[] = [], sent: Uint8Array[] = [];
  let wallMs = 0, closedWith = '';
  const sitl = new SitlBridgeClient(stateBuffer, actuatorBuffer, {
    bridgeEpoch: EPOCH, motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1), motorMapId: derived.manifest.modelId,
    sessionEpoch: header.sessionEpoch, speedup: 1,
  }, { pump: () => { session.pump(); }, flush: () => undefined, post: message => posted.push(message), send: record => sent.push(record.slice()),
    close: reason => { closedWith = reason; }, nowMs: () => (wallMs += 0.1) });
  const statuses = () => posted.filter((m): m is SitlStatus => m.type === 'sitl.status');
  return { sitl, posted, sent, statuses, closed: () => closedWith };
}

describe('SitlBridgeClient in the physics Worker', () => {
  it('admits READY only after 30 s of live diagnostics and revokes it when they stop', async () => {
    const h = await client();
    h.sitl.opened();
    let frame = 0, mavlink = 0, firstReadyS = -1;
    const run = (seconds: number, sent: 'all' | 'gps' | 'none') => {
      for (let i = 0; i < seconds * HZ; i++) {
        expect(h.sitl.receive(servoRecord(frame))).toBe('step');
        frame++;
        if (sent !== 'none' && frame % 80 === 0) expect(h.sitl.receive(diagnostics(frame / HZ, mavlink++, sent === 'gps'))).toBe('mavlink');
        if (firstReadyS < 0 && h.sitl.ready) firstReadyS = frame / HZ;
      }
    };
    run(29, 'all');
    expect(h.statuses().some(s => s.ready)).toBe(false);
    run(3, 'all');
    expect(firstReadyS).toBeGreaterThanOrEqual(30);
    expect(h.statuses().at(-1)).toMatchObject({ state: 'open', ready: true, reason: 'EKF health and warmup gate passed', steps: 32 * HZ, gaps: 0 });
    // Every step was answered, and MAVLink chunks reached Main unchanged.
    expect(h.sent.length).toBe(32 * HZ);
    expect(h.posted.filter(m => m.type === 'sitl.mavlink')).toHaveLength(mavlink);
    // Heartbeat and EKF reports stop while GPS continues: READY is revoked within the 1 s staleness window plus one status interval.
    run(1.2, 'gps');
    expect(h.statuses().at(-1)).toMatchObject({ ready: false, reason: 'Autopilot EKF diagnostics are unhealthy or stale' });
    expect(h.sitl.ready).toBe(false);
    // Fresh diagnostics admit it again; then everything stops and the stale GPS revokes it first (0.3 s).
    run(1, 'all');
    expect(h.sitl.ready).toBe(true);
    run(0.5, 'none');
    expect(h.statuses().at(-1)).toMatchObject({ ready: false, reason: 'Sensor timestamps are incoherent' });
  }, 300000);

  it('compares GPS in the session clock when the autopilot clock leads it, as after a reconnect (TASK-155)', async () => {
    // A SITL connected again keeps its clock: its GPS is 120 s ahead of the new session's physics clock.
    for (const [position, expected] of [[false, false], [true, true]] as const) {
      const h = await client();
      h.sitl.opened();
      let mavlink = 0;
      for (let frame = 0; frame < 32 * HZ; frame++) {
        expect(h.sitl.receive(servoRecord(frame))).toBe('step');
        if ((frame + 1) % 80 === 0) h.sitl.receive(diagnostics((frame + 1) / HZ, mavlink++, false, 120, position));
      }
      // Without GLOBAL_POSITION_INT the lead is unknown, so the GPS stays in the future and READY is withheld.
      expect(h.sitl.ready, `with GLOBAL_POSITION_INT ${String(position)}`).toBe(expected);
      if (!expected) expect(h.statuses().at(-1)).toMatchObject({ ready: false, reason: 'Sensor timestamps are incoherent' });
    }
  }, 300000);

  it('ends READY on a SITL restart and closes the socket', async () => {
    const h = await client();
    h.sitl.opened();
    for (let frame = 0; frame < 10; frame++) h.sitl.receive(servoRecord(frame));
    expect(h.sitl.receive(servoRecord(0))).toBe('restart');
    expect(h.closed()).toBe('SITL restarted; start a new run');
    expect(h.statuses().at(-1)).toMatchObject({ state: 'fault', ready: false, message: 'SITL restarted; start a new run' });
    h.sitl.closed(1000, 'SITL restarted; start a new run');
    expect(h.statuses().at(-1)?.state).toBe('fault');
  }, 300000);

  it('keeps the token out of the URL', () => {
    const token = 'ab'.repeat(32);
    expect(bridgeSocketArguments(41234, token)).toEqual(['ws://127.0.0.1:41234/', ['mirage-v1', `session.${token}`]]);
    expect(() => bridgeSocketArguments(41234, 'AB'.repeat(32))).toThrow('token');
    expect(() => bridgeSocketArguments(0, token)).toThrow('port');
  });
});
