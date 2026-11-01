import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareContact } from './contact-support.ts';
import { standardGearHeights } from './support/standard-gear.ts';
import { GroundStation, MavCommand } from '@mirage/autopilot/ground-station';
import { BRIDGE_HEADER_BYTES, SitlJsonLink } from '@mirage/autopilot/sitl-link';
import { MavParser, type MavFrame } from '@mirage/mavlink/codec';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newFlightStateV2, newHeaderSnapshotV2, tickToNumber,
  type CommandResultV2 } from '@mirage/protocol';
import { decodeRecord, encodeRecord } from '../apps/bridge/src/framing.ts';
import { validateStateLine } from '../apps/bridge/src/ardupilot-json.ts';
import { quadProfile } from './support/quad-profile.ts';

// TASK-153 increment 1: SitlJsonLink between bridge records and a real
// PhysicsSessionV2 running the S19 quad X profile on the example cards in
// sitl-lockstep. Oracles: the bridge's own framing and state-line validator
// (apps/bridge), the session's published tick, the TASK-041 servo packet
// layout written here byte by byte, and pymavlink 2.4.50 for the ground
// station's frames.

const EPOCH = 7, HZ = 400, GRAVITY = 9.80665;
let module: WebAssembly.Module;
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  // The vehicle stands on its standard landing gear (TASK-095).
  await prepareContact();
}, 600000);

/** A session in sitl-lockstep with the quad profile loaded and started, and a link on its buffers. */
async function harness() {
  const { profile, derived } = await quadProfile();
  const registry = new VehicleRegistry();
  await registry.register(derived.bytes, derived.sha256);
  const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator');
  const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
    { monotonicMs: () => 0, wallMs: () => 1_790_000_000_000 }, undefined, null, profileModelPort(registry, () => module));
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2();
  const results: CommandResultV2[] = [];
  let requestId = 0;
  const command = async (type: string, extra: Record<string, unknown> = {}) => {
    reader.readHeader(header);
    session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
    await session.settled();
    session.drain(result => results.push(result));
    return results.at(-1);
  };
  expect(await command('sim.configure', { hz: HZ, clockMode: 'sitl-lockstep' })).toMatchObject({ status: 'applied' });
  expect(await command('model.load', { modelId: 153, manifestSha256: derived.sha256 })).toMatchObject({ status: 'applied' });
  expect(await command('sim.start')).toMatchObject({ status: 'applied' });
  const link = new SitlJsonLink(stateBuffer, actuatorBuffer, {
    bridgeEpoch: EPOCH, motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1), motorMapId: derived.manifest.modelId });
  const tick = () => { expect(reader.latest(state)).toBe(true); return tickToNumber(state.tickId); };
  /** What the physics Worker does per record: receive, pump on a step, then poll for the reply. */
  const deliver = (record: Uint8Array) => {
    const event = link.receive(record);
    let reply: Uint8Array | null = event === 'resend' ? link.outbound.slice(0, BRIDGE_HEADER_BYTES + replyLength(link.outbound)) : null;
    if (event === 'step') {
      session.pump();
      const n = link.poll();
      reply = n > 0 ? link.outbound.slice(0, n) : null;
    }
    return { event, reply };
  };
  return { profile, derived, session, link, reader, state, tick, deliver };
}
function replyLength(record: Uint8Array): number {
  return new DataView(record.buffer, record.byteOffset).getUint32(12, true);
}

/** A 16-channel SIM_JSON servo packet (magic 18458) in a channel 3 record. */
function servoRecord(frameCount: number, pwmUs: number | readonly number[], epoch = EPOCH, sequence = frameCount): Uint8Array {
  const packet = new Uint8Array(40), view = new DataView(packet.buffer);
  view.setUint16(0, 18458, true); view.setUint16(2, HZ, true); view.setUint32(4, frameCount, true);
  for (let i = 0; i < 16; i++) view.setUint16(8 + 2 * i, typeof pwmUs === 'number' ? (i < 4 ? pwmUs : 0) : (pwmUs[i] ?? 0), true);
  return encodeRecord({ channel: 3, epoch, sequence: sequence >>> 0, payload: packet });
}
interface StateLine { timestamp: number; gyro: readonly number[]; accel: readonly number[]; position: readonly number[]; voltage: number | null }
const numbers = (value: unknown): readonly number[] => Array.isArray(value) && value.every(v => typeof v === 'number') ? value.map(Number) : [];
/** The reply's JSON state line, after the bridge's own validator accepted it. */
function stateOf(reply: Uint8Array | null): StateLine {
  if (!reply) throw new Error('No reply');
  const record = decodeRecord(reply);
  if (!record) throw new Error('Reply is not a bridge record');
  expect([record.channel, record.epoch]).toEqual([2, EPOCH]);
  expect(validateStateLine(record.payload)).toBeNull();
  const parsed: unknown = JSON.parse(new TextDecoder().decode(record.payload));
  const get = (value: unknown, key: string): unknown => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  const timestamp = get(parsed, 'timestamp'), voltage = get(get(parsed, 'battery'), 'voltage');
  if (typeof timestamp !== 'number') throw new Error('No timestamp');
  return { timestamp, gyro: numbers(get(get(parsed, 'imu'), 'gyro')), accel: numbers(get(get(parsed, 'imu'), 'accel_body')),
    position: numbers(get(parsed, 'position')), voltage: typeof voltage === 'number' ? voltage : null };
}

describe('SitlJsonLink on a profile session in sitl-lockstep', () => {
  it('steps the session exactly once per new servo frame and never for lost, resent, stale or foreign records', async () => {
    const h = await harness();
    expect(h.tick()).toBe(0);
    const first = h.deliver(servoRecord(0, 1000));
    expect(first.event).toBe('step');
    expect(h.tick()).toBe(1);
    const line = stateOf(first.reply);
    expect(line.timestamp).toBeCloseTo(1 / HZ, 9);
    expect(decodeRecord(first.reply!)?.sequence).toBe(0);

    // SITL resends an answered frame after 1 s: the stored reply goes back unchanged and nothing steps.
    const resent = h.deliver(servoRecord(0, 1000, EPOCH, 1));
    expect(resent.event).toBe('resend');
    expect(decodeRecord(resent.reply!)?.payload).toEqual(decodeRecord(first.reply!)?.payload);
    expect(decodeRecord(resent.reply!)?.sequence).toBe(1);
    expect(h.tick()).toBe(1);

    // Frame 1 is lost: frame 2 steps once, frame 1 arriving late is stale.
    expect(h.deliver(servoRecord(2, 1000)).event).toBe('step');
    expect(h.tick()).toBe(2);
    expect(h.deliver(servoRecord(1, 1000, EPOCH, 3)).event).toBe('dropped');
    expect(h.tick()).toBe(2);
    expect(h.link.lockstepStats).toMatchObject({ steps: 2, duplicates: 1, gaps: 1, droppedFrames: 1, stale: 1 });

    // A record of another run's epoch, a damaged header and a short servo payload are dropped.
    expect(h.deliver(servoRecord(3, 1000, EPOCH + 1)).event).toBe('dropped');
    const damaged = servoRecord(3, 1000); damaged[2] = 1;
    expect(h.deliver(damaged).event).toBe('dropped');
    expect(h.deliver(encodeRecord({ channel: 3, epoch: EPOCH, sequence: 9, payload: new Uint8Array(39) })).event).toBe('dropped');
    expect(h.tick()).toBe(2);

    // A frame that arrives before the previous one is answered is held, not stepped.
    expect(h.link.receive(servoRecord(3, 1000))).toBe('step');
    expect(h.link.receive(servoRecord(4, 1000))).toBe('held');
    h.session.pump();
    expect(h.link.poll()).toBeGreaterThan(0);
    expect(h.tick()).toBe(3);
    expect(h.deliver(servoRecord(4, 1000)).event).toBe('step');
    expect(h.tick()).toBe(4);

    // A restarted SITL begins at frame 0 again.
    expect(h.deliver(servoRecord(0, 1000)).event).toBe('restart');
    expect(h.tick()).toBe(4);
  }, 300000);

  it('feeds the PWM of each rotor channel to the dynamics and answers with the published state', async () => {
    const h = await harness();
    let frame = 0, last = stateOf(h.deliver(servoRecord(frame++, 1000)).reply);
    // Motors stopped on the standard gear (TASK-095): after 1 s at rest, the accelerometer reading g, and the CG where the gear's
    // rules put it (tests/support/standard-gear.ts).
    for (let i = 0; i < 799; i++) last = stateOf(h.deliver(servoRecord(frame++, 1000)).reply);
    expect(last.timestamp).toBeCloseTo(800 / HZ, 9);
    const { restM, pitchRad } = standardGearHeights(h.derived.manifest);
    expect(Math.abs(last.position[2]! + restM)).toBeLessThan(1e-4);
    // The CG lies ahead of the supports' centre, so the front supports compress more and the body pitches nose down by the statics'
    // angle; the accelerometer then reads −g·sin(pitch) forward.
    expect(Math.abs(last.accel[0]! / (-GRAVITY * Math.sin(pitchRad)) - 1)).toBeLessThan(0.05);
    expect(Math.hypot(last.accel[0]!, last.accel[1]!, last.accel[2]!)).toBeCloseTo(GRAVITY, 2);
    expect(last.voltage).toBeGreaterThan(10);
    // Full PWM on the four rotor channels: the quad climbs off its feet. Without an autopilot, and with the CG ahead of the
    // rotors' centre, it also pitches over, so the peak height is what counts.
    let peak = 0;
    for (let i = 0; i < 800; i++) { last = stateOf(h.deliver(servoRecord(frame++, 2000)).reply); peak = Math.min(peak, last.position[2]!); }
    expect(peak).toBeLessThan(-1);
    expect(h.link.lockstepStats).toMatchObject({ steps: 1600, duplicates: 0, gaps: 0 });
    // MAVLink records pass through unchanged.
    const mavlink = Uint8Array.from([0xfd, 9, 0, 0, 1, 1, 1, 0, 0, 0]);
    expect(h.link.receive(encodeRecord({ channel: 1, epoch: EPOCH, sequence: 0, payload: mavlink }))).toBe('mavlink');
    expect(h.link.inbound.subarray(h.link.mavlinkOffset, h.link.mavlinkOffset + h.link.mavlinkLength)).toEqual(mavlink);
    const out = new Uint8Array(64), n = h.link.mavlinkRecordInto(mavlink, out);
    expect(decodeRecord(out.subarray(0, n))).toMatchObject({ channel: 1, epoch: EPOCH, sequence: 0, payload: mavlink });
    expect(decodeRecord(out.subarray(0, h.link.mavlinkRecordInto(mavlink, out)))?.sequence).toBe(1);
  }, 300000);
});

const PYTHON = join(process.cwd(), '.cache/task-127/venv/bin/python');
describe('GroundStation frames', () => {
  const gcs = new GroundStation(), out = new Uint8Array(64);
  const wire = (n: number) => out.slice(0, n);
  const heartbeat = wire(gcs.heartbeatInto(out)), arm = wire(gcs.armInto(true, out)), guided = wire(gcs.setModeInto(4, out)),
    takeoff = wire(gcs.takeoffInto(5, out)), land = wire(gcs.landInto(out)), interval = wire(gcs.messageIntervalInto(193, 100000, out));
  it('parse back with the TASK-150 codec', () => {
    const parsed: { id: number; sequence: number; command: number; p1: number; p2: number; p7: number }[] = [];
    const parser = new MavParser((frame: MavFrame) => parsed.push({ id: frame.id, sequence: frame.sequence,
      command: frame.id === 76 ? frame.view.getUint16(28, true) : -1, p1: frame.view.getFloat32(0, true), p2: frame.view.getFloat32(4, true),
      p7: frame.view.getFloat32(24, true) }));
    for (const bytes of [heartbeat, arm, guided, takeoff, land, interval]) parser.push(bytes);
    expect(parsed.map(f => [f.id, f.sequence, f.command])).toEqual([[0, 0, -1], [76, 1, MavCommand.ComponentArmDisarm], [76, 2, MavCommand.DoSetMode],
      [76, 3, MavCommand.NavTakeoff], [76, 4, MavCommand.NavLand], [76, 5, MavCommand.SetMessageInterval]]);
    expect([parsed[1]!.p1, parsed[2]!.p1, parsed[2]!.p2, parsed[3]!.p7, parsed[5]!.p1, parsed[5]!.p2]).toEqual([1, 1, 4, 5, 193, 100000]);
  });
  it.skipIf(!existsSync(PYTHON))('decode identically in pymavlink 2.4.50', () => {
    const hex = [heartbeat, arm, guided, takeoff, land, interval].map(bytes => Buffer.from(bytes).toString('hex'));
    const script = `
import json, sys
from pymavlink.dialects.v20 import ardupilotmega
parser = ardupilotmega.MAVLink(None)
out = []
for h in json.loads(sys.argv[1]):
    m = parser.parse_char(bytes.fromhex(h))
    d = m.to_dict()
    out.append([m.get_type(), m.get_srcSystem(), m.get_srcComponent(), m.get_seq()] + ([d["command"], d["target_system"], d["target_component"], d["param1"], d["param2"], d["param7"]] if m.get_type() == "COMMAND_LONG" else [d["type"], d["autopilot"], d["system_status"], d["mavlink_version"]]))
print(json.dumps(out))
`;
    const result = spawnSync(PYTHON, ['-I', '-c', script, JSON.stringify(hex)], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      ['HEARTBEAT', 255, 190, 0, 6, 8, 4, 3],
      ['COMMAND_LONG', 255, 190, 1, 400, 1, 1, 1, 0, 0],
      ['COMMAND_LONG', 255, 190, 2, 176, 1, 1, 1, 4, 0],
      ['COMMAND_LONG', 255, 190, 3, 22, 1, 1, 0, 0, 5],
      ['COMMAND_LONG', 255, 190, 4, 21, 1, 1, 0, 0, 0],
      ['COMMAND_LONG', 255, 190, 5, 511, 1, 1, 193, 100000, 0],
    ]);
  });
});
