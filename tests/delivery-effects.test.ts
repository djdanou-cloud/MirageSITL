import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareContact } from './contact-support.ts';
import { createSessionFaultPort } from '@mirage/ew/session-port';
import { MagneticAnomaly } from '@mirage/ew/magnetic';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import {
  EFFECT_CATALOG, EFFECT_IDS, EwFlagV2, StateReaderV2, createSharedMemoryV2, createSpscQueue, newFlightStateV2, newHeaderSnapshotV2, tickToNumber, type CommandResultV2, type EffectControl,
  type EffectId, type FlightStateV2,
} from '@mirage/protocol';
import { ARDUPILOT_FAULT_PARAMETERS, faultParameters } from '../packages/autopilot/src/fault-effects.ts';
import { SIM_PARAMETERS_WITHOUT_A_SOURCE, parseArduPilotCatalog, errorSourceOfParameter } from '../packages/autopilot/src/error-ownership.ts';
import { SitlBridgeClient, type SitlNotice } from '../apps/web/src/sitl/bridge-client.ts';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { decodeRecord, encodeRecord } from '../apps/bridge/src/framing.ts';
import { validateStateLine } from '../apps/bridge/src/ardupilot-json.ts';
import { quadProfile } from './support/quad-profile.ts';
import catalogJson from './fixtures/sitl/ardupilot-catalog.json';

// TASK-168 through a real session on the quad profile in sitl-lockstep, the link and the bridge client, as the physics Worker wires
// them. Oracles: a run with no effect, compared bit by bit; the bridge's own framing and state-line validator; and for a motor, the
// direction r × F of the thrust it lost.

const EPOCH = 7, HZ = 400;
let module: WebAssembly.Module;
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  await prepareContact();
}, 600000);

const record = (effect: EffectId, enabled = true, intensity = 1): EffectControl => ({ schemaVersion: 1, id: effect.replaceAll('.', '-'), effect, enabled, intensity, parameters: {} });
function servoRecord(frameCount: number, pwmUs: number): Uint8Array {
  const packet = new Uint8Array(40), view = new DataView(packet.buffer);
  view.setUint16(0, 18458, true); view.setUint16(2, HZ, true); view.setUint32(4, frameCount, true);
  for (let i = 0; i < 16; i++) view.setUint16(8 + 2 * i, i < 4 ? pwmUs : 0, true);
  return encodeRecord({ channel: 3, epoch: EPOCH, sequence: frameCount >>> 0, payload: packet });
}
function mavlinkRecord(sequence: number, payload: Uint8Array): Uint8Array {
  return encodeRecord({ channel: 1, epoch: EPOCH, sequence, payload });
}
const truthOf = (s: FlightStateV2): number[] => [s.northM, s.eastM, s.downM, s.vnMps, s.veMps, s.vdMps, s.qw, s.qx, s.qy, s.qz, s.pRadS, s.qRadS, s.rRadS, s.specificForceXBodyMps2, s.specificForceYBodyMps2,
  s.specificForceZBodyMps2, s.trueAirspeedMps, s.ambientPressurePa, s.batteryVoltage, s.batteryCurrentA, s.vehicleFlags];
interface Line { imu: { gyro: number[]; accel_body: number[] }; position: number[]; velocity: number[]; quaternion: number[]; timestamp: number }
function lineOf(reply: Uint8Array | null): Line {
  if (!reply) throw new Error('No reply');
  const decoded = decodeRecord(reply);
  if (!decoded) throw new Error('Reply is not a bridge record');
  expect(validateStateLine(decoded.payload)).toBeNull();
  return JSON.parse(new TextDecoder().decode(decoded.payload)) as Line;
}

async function harness(faults = true) {
  const { derived } = await quadProfile();
  const registry = new VehicleRegistry();
  await registry.register(derived.bytes, derived.sha256);
  const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator');
  const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
    { monotonicMs: () => 0, wallMs: () => 1_790_000_000_000 }, undefined, faults ? createSessionFaultPort() : null, profileModelPort(registry, () => module));
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  const raw = (message: Record<string, unknown>) => {
    reader.readHeader(header);
    session.handle({ requestId: ++requestId, expectedEpoch: header.sessionEpoch, ...message });
    session.drain(result => results.push(result));
    return results.at(-1);
  };
  const lifecycle = async (type: string, extra: Record<string, unknown> = {}) => {
    const result = raw({ protocolVersion: 2, type, ...extra });
    await session.settled();
    session.drain(item => results.push(item));
    return results.at(-1) ?? result;
  };
  expect(await lifecycle('sim.configure', { hz: HZ, clockMode: 'sitl-lockstep' })).toMatchObject({ status: 'applied' });
  expect(await lifecycle('model.load', { modelId: 153, manifestSha256: derived.sha256 })).toMatchObject({ status: 'applied' });
  expect(await lifecycle('sim.start')).toMatchObject({ status: 'applied' });
  session.attachDelivery(true);
  const notices: SitlNotice[] = [], sent: Uint8Array[] = [];
  const host = { pump: () => { session.pump(); }, flush: () => undefined, post: (message: SitlNotice) => notices.push(message), send: (bytes: Uint8Array) => sent.push(bytes.slice()),
    close: () => undefined, nowMs: () => 0, inputStale: () => { throw new Error('The input watchdog fired'); } };
  const client = new SitlBridgeClient(stateBuffer, actuatorBuffer, { bridgeEpoch: EPOCH, motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1), motorMapId: derived.manifest.modelId,
    sessionEpoch: session.currentEpoch, speedup: 1, wind: session.wind, delivery: session.delivery }, host);
  client.opened();
  /** One servo frame: the session steps and the reply comes back. */
  const step = (frame: number, pwmUs: number) => {
    sent.length = 0;
    expect(client.receive(servoRecord(frame, pwmUs))).toBe('step');
    const reply = sent.find(bytes => decodeRecord(bytes)?.channel === 2) ?? null;
    expect(reader.latest(state)).toBe(true);
    return { line: lineOf(reply), truth: truthOf(state), tick: tickToNumber(state.tickId) };
  };
  const control = (atTick: number, value: EffectControl) => raw({ protocolVersion: 3, type: 'effect.set', atTick: { lo: atTick, hi: 0 }, control: value, recovery: 'hold-offset' });
  return { derived, session, client, state, results, notices, sent, step, control, lifecycle, raw };
}
const CLIMB_PWM = 1800, TICKS = 200, ON = 80, OFF = 140;

describe('frozen readings on the state line', () => {
  const run = async (effect: EffectId | null) => {
    const h = await harness();
    if (effect) { expect(h.control(ON, record(effect))).toMatchObject({ status: 'queued' }); expect(h.control(OFF, record(effect, false))).toMatchObject({ status: 'queued' }); }
    const rows: ReturnType<typeof h.step>[] = [];
    for (let frame = 0; frame < TICKS; frame++) rows.push(h.step(frame, CLIMB_PWM));
    h.session.drain(item => h.results.push(item));
    return { rows, h };
  };
  const heldOf: readonly { effect: EffectId; held: (line: Line) => number[]; rest: (line: Line) => number[] }[] = [
    { effect: 'sensor.imu.frozen', held: line => [...line.imu.gyro, ...line.imu.accel_body], rest: line => [...line.position, ...line.velocity, ...line.quaternion, line.timestamp] },
    { effect: 'sensor.gnss.frozen', held: line => [line.position[0]!, line.position[1]!, line.velocity[0]!, line.velocity[1]!], rest: line => [line.position[2]!, line.velocity[2]!, ...line.imu.gyro, ...line.imu.accel_body, ...line.quaternion, line.timestamp] },
    { effect: 'sensor.mag.frozen', held: line => line.quaternion, rest: line => [...line.position, ...line.velocity, ...line.imu.gyro, ...line.imu.accel_body, line.timestamp] },
  ];
  it.each(heldOf)('$effect holds exactly its keys from its tick to its end, and truth stays bit for bit', async ({ effect, held, rest }) => {
    const baseline = await run(null), frozen = await run(effect);
    frozen.rows.forEach((row, index) => {
      const reference = baseline.rows[index];
      if (!reference) throw new Error('No reference row');
      // Truth: the same numbers, bit for bit, with the effect on as without.
      expect(Float64Array.from(row.truth), `truth at tick ${row.tick}`).toEqual(Float64Array.from(reference.truth));
      expect(row.tick).toBe(reference.tick);
      // Everything else on the line: as without.
      expect(rest(row.line), `rest at tick ${row.tick}`).toEqual(rest(reference.line));
      // What is held: the line before its tick, until it goes off.
      const frozenFrom = baseline.rows.find(item => item.tick === ON - 1);
      if (!frozenFrom) throw new Error('No row before the effect');
      expect(held(row.line), `held at tick ${row.tick}`).toEqual(row.tick >= ON && row.tick < OFF ? held(frozenFrom.line) : held(reference.line));
    });
    // The comparison is not vacuous: what was held did change in the run without it.
    const first = baseline.rows.find(item => item.tick === ON), last = baseline.rows.find(item => item.tick === OFF - 1);
    if (!first || !last) throw new Error('No rows');
    expect(held(last.line)).not.toEqual(held(first.line));
    const acks = frozen.h.results.filter(result => result.type === 'ack-v2' && result.status === 'applied').map(result => (result.type === 'ack-v2' ? tickToNumber(result.appliedTick) : -1));
    expect(acks).toContain(ON);
    expect(acks).toContain(OFF);
  }, 300000);
  it('off and zero intensity change nothing that is delivered', async () => {
    const baseline = await run(null), lines = baseline.rows.map(row => JSON.stringify(row.line));
    for (const effect of ['sensor.imu.frozen', 'sensor.gnss.frozen', 'sensor.mag.frozen', 'link.pilot', 'link.gcs'] as const) {
      for (const off of [record(effect, false), record(effect, true, 0)]) {
        const h = await harness();
        expect(h.control(ON, off)).toMatchObject({ status: 'queued' });
        for (let frame = 0; frame < TICKS; frame++) expect(JSON.stringify(h.step(frame, CLIMB_PWM).line)).toBe(lines[frame]);
      }
    }
  }, 300000);
  it('a closed link clears them, and without one they are refused', async () => {
    const h = await harness();
    h.control(2, record('sensor.imu.frozen'));
    h.step(0, CLIMB_PWM); h.step(1, CLIMB_PWM);
    expect(h.session.delivery.mask).not.toBe(0);
    h.session.attachDelivery(false);
    expect(h.session.delivery).toMatchObject({ mask: 0, attached: false });
    expect(h.control(5, record('sensor.imu.frozen'))).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE', message: expect.stringContaining('no') as string });
  }, 120000);
});

describe('interference on the state line (TASK-169)', () => {
  const run = async (controls: readonly (readonly [number, EffectControl])[]) => {
    const h = await harness();
    for (const [tick, control] of controls) expect(h.control(tick, control)).toMatchObject({ status: 'queued' });
    const rows: ReturnType<typeof h.step>[] = [];
    for (let frame = 0; frame < TICKS; frame++) rows.push(h.step(frame, CLIMB_PWM));
    h.session.drain(item => h.results.push(item));
    return { rows, h };
  };
  const withParameters = (effect: EffectId, parameters: Record<string, unknown>, enabled = true, intensity = 1) => ({ ...record(effect, enabled, intensity), parameters: { ...record(effect).parameters, ...parameters } }) as EffectControl;
  const truthAndRest = (baseline: Awaited<ReturnType<typeof run>>, row: Awaited<ReturnType<typeof run>>['rows'][number], index: number) => {
    const reference = baseline.rows[index];
    if (!reference) throw new Error('No reference row');
    expect(Float64Array.from(row.truth), `truth at tick ${row.tick}`).toEqual(Float64Array.from(reference.truth));
    expect(row.line.imu, `IMU at tick ${row.tick}`).toEqual(reference.line.imu);
    expect(row.line.position[2], `height at tick ${row.tick}`).toBe(reference.line.position[2]);
    return reference;
  };
  it('a position step moves north and east by its offset, from its tick to its end, and nothing else', async () => {
    const baseline = await run([]), offset = [30, -12.5, 0], stepped = await run([[ON, withParameters('ew.position-step', { offsetNedM: offset })], [OFF, withParameters('ew.position-step', { offsetNedM: offset }, false)]]);
    stepped.rows.forEach((row, index) => {
      const reference = truthAndRest(baseline, row, index), on = row.tick >= ON && row.tick < OFF;
      // The line carries nine decimals, so a sum of its numbers can miss by a unit there; off, it is the same number.
      expect(Math.abs((row.line.position[0] ?? NaN) - (reference.line.position[0] ?? 0) - (on ? 30 : 0)), `north at ${row.tick}`).toBeLessThanOrEqual(on ? 1.5e-9 : 0);
      expect(Math.abs((row.line.position[1] ?? NaN) - (reference.line.position[1] ?? 0) - (on ? -12.5 : 0)), `east at ${row.tick}`).toBeLessThanOrEqual(on ? 1.5e-9 : 0);
      expect(row.line.velocity).toEqual(reference.line.velocity);
      expect(row.line.quaternion).toEqual(reference.line.quaternion);
    });
  }, 300000);
  it('a drift moves position and velocity together, at its acceleration, and truth stays bit for bit', async () => {
    const baseline = await run([]), drifted = await run([[ON, withParameters('ew.velocity-drift', { accelerationNedMps2: [0.2, -0.1, 0], maxSpeedMps: 2 })]]);
    let last = 0;
    drifted.rows.forEach((row, index) => {
      const reference = truthAndRest(baseline, row, index), elapsed = (row.tick - ON + 1) / HZ;
      if (row.tick < ON) { expect(row.line.position).toEqual(reference.line.position); expect(row.line.velocity).toEqual(reference.line.velocity); return; }
      // The drift's own form, v = a t and b = a t² / 2, up to its one-step integration.
      expect((row.line.velocity[0] ?? 0) - (reference.line.velocity[0] ?? 0)).toBeCloseTo(0.2 * elapsed, 6);
      expect((row.line.velocity[1] ?? 0) - (reference.line.velocity[1] ?? 0)).toBeCloseTo(-0.1 * elapsed, 6);
      const north = (row.line.position[0] ?? 0) - (reference.line.position[0] ?? 0);
      expect(north).toBeCloseTo(0.5 * 0.2 * elapsed * elapsed, 5);
      expect(north).toBeGreaterThanOrEqual(last);
      last = north;
      expect(row.line.velocity[2]).toBe(reference.line.velocity[2]);
    });
    expect(last).toBeGreaterThan(0);
  }, 300000);
  it('a magnetic rotation turns SITL\'s body field as the magnetic model turns it, and only that', async () => {
    const rotationRad = [0.2, -0.3, 0.5], baseline = await run([]), turned = await run([[ON, withParameters('ew.magnetic', { rotationRad, biasBodyGauss: [0, 0, 0] })], [OFF, withParameters('ew.magnetic', { rotationRad, biasBodyGauss: [0, 0, 0] }, false)]]);
    const anomaly = new MagneticAnomaly(rotationRad as [number, number, number], [0, 0, 0]);
    // SITL's reading: dcmᵀ·B for the attitude on the line (SIM_Aircraft.cpp), with dcm built here from the quaternion, independently of the code under test.
    const bodyField = (q: readonly number[], earth: readonly number[]) => {
      const [w = 0, x = 0, y = 0, z = 0] = q, [n = 0, e = 0, d = 0] = earth;
      const m = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
      return [0, 1, 2].map(i => (m[0]?.[i] ?? 0) * n + (m[1]?.[i] ?? 0) * e + (m[2]?.[i] ?? 0) * d);
    };
    const earth = [0.22, 0.05, 0.42];
    turned.rows.forEach((row, index) => {
      const reference = truthAndRest(baseline, row, index);
      expect(row.line.position).toEqual(reference.line.position);
      expect(row.line.velocity).toEqual(reference.line.velocity);
      if (row.tick < ON || row.tick >= OFF) { expect(row.line.quaternion, `tick ${row.tick}`).toEqual(reference.line.quaternion); return; }
      const source = Float64Array.from(bodyField(reference.line.quaternion, earth)), target = new Float64Array(3);
      expect(anomaly.distortInto(source, target)).toBe(true);
      const delivered = bodyField(row.line.quaternion, earth);
      // The state line prints its quaternion to a fixed number of digits, which sets the tolerance.
      delivered.forEach((value, axis) => expect(value, `axis ${axis} at tick ${row.tick}`).toBeCloseTo(target[axis] ?? Number.NaN, 7));
      expect(Math.hypot(...row.line.quaternion)).toBeCloseTo(1, 7);
    });
  }, 300000);
  it('a frozen GNSS holds through a step, and off leaves what is delivered exactly as without', async () => {
    const baseline = await run([]);
    const never = await run([[ON, withParameters('ew.position-step', { offsetNedM: [30, 0, 0] }, false)], [ON + 1, withParameters('ew.magnetic', { rotationRad: [0.2, 0, 0], biasBodyGauss: [0, 0, 0] }, true, 0)]]);
    never.rows.forEach((row, index) => expect(row.line, `tick ${row.tick}`).toEqual(baseline.rows[index]?.line));
    const frozen = await run([[ON, record('sensor.gnss.frozen')], [ON + 5, withParameters('ew.position-step', { offsetNedM: [30, 0, 0] })]]);
    const held = frozen.rows.find(row => row.tick === ON)?.line.position[0];
    for (const row of frozen.rows.filter(item => item.tick >= ON)) expect(row.line.position[0]).toBe(held);
  }, 300000);
  it('a closed link clears the offsets', async () => {
    const { h } = await run([[ON, withParameters('ew.position-step', { offsetNedM: [30, 0, 0] })]]);
    expect(h.session.delivery.gnssActive).toBe(true);
    h.session.attachDelivery(false);
    expect(h.session.delivery.gnssActive).toBe(false);
  }, 300000);
});

describe('lost links at the bridge', () => {
  const rcOverride = (): Uint8Array => { const frame = new Uint8Array(20); frame[0] = 0xfd; frame[7] = 70; return frame; };
  const other = (): Uint8Array => { const frame = new Uint8Array(20); frame[0] = 0xfd; frame[7] = 76; return frame; };
  it('pilot control lost drops stick commands alone, and only while it is on; the physics goes on bit for bit', async () => {
    const h = await harness(), baseline = await harness();
    h.client.setManual(true);
    h.control(5, record('link.pilot'));
    h.control(10, record('link.pilot', false));
    const toSitl = () => h.sent.filter(bytes => decodeRecord(bytes)?.channel === 1).length;
    for (let frame = 0; frame < 15; frame++) {
      const row = h.step(frame, CLIMB_PWM), reference = baseline.step(frame, CLIMB_PWM);
      expect(Float64Array.from(row.truth)).toEqual(Float64Array.from(reference.truth));
      expect(JSON.stringify(row.line)).toBe(JSON.stringify(reference.line));
      h.sent.length = 0;
      expect(h.client.sendMavlink(rcOverride())).toBe(true);
      expect(toSitl(), `stick at tick ${row.tick}`).toBe(row.tick >= 5 && row.tick < 10 ? 0 : 1);
      h.sent.length = 0;
      expect(h.client.sendMavlink(other())).toBe(true);
      expect(toSitl(), `other at tick ${row.tick}`).toBe(1);
    }
    expect(h.client.droppedToAutopilot).toBe(5);
  }, 120000);
  it('ground-station link lost drops every frame both ways, only while it is on; the physics goes on bit for bit', async () => {
    const h = await harness(), baseline = await harness();
    h.control(5, record('link.gcs'));
    h.control(10, record('link.gcs', false));
    for (let frame = 0; frame < 15; frame++) {
      const row = h.step(frame, CLIMB_PWM), reference = baseline.step(frame, CLIMB_PWM);
      expect(Float64Array.from(row.truth)).toEqual(Float64Array.from(reference.truth));
      expect(JSON.stringify(row.line)).toBe(JSON.stringify(reference.line));
      const lost = row.tick >= 5 && row.tick < 10;
      h.sent.length = 0; h.notices.length = 0;
      expect(h.client.sendMavlink(other())).toBe(true);
      expect(h.sent.filter(bytes => decodeRecord(bytes)?.channel === 1).length, `out at tick ${row.tick}`).toBe(lost ? 0 : 1);
      expect(h.client.receive(mavlinkRecord(frame, other()))).toBe('mavlink');
      expect(h.notices.filter(notice => notice.type === 'sitl.mavlink').length, `in at tick ${row.tick}`).toBe(lost ? 0 : 1);
    }
    expect(h.client.droppedToAutopilot).toBe(5);
    expect(h.client.droppedFromAutopilot).toBe(5);
  }, 120000);
});

describe('reduced power and motor failure on the profile dynamics', () => {
  const FAILS_AT = 120, ENDS_AT = 180;
  const motorLoss = (mode: 'power-cut' | 'instant-thrust-loss', remaining: number, enabled = true): EffectControl =>
    ({ schemaVersion: 1, id: 'motor', effect: 'motor.loss', enabled, intensity: 1, parameters: { motorIndex: 0, mode, remainingThrustFraction: remaining } });
  it.each(['power-cut', 'instant-thrust-loss'] as const)('%s on one motor rolls and pitches the aircraft toward it, against the same flight without the fault', async mode => {
    const h = await harness(), baseline = await harness(), rotor = h.derived.manifest.rotors[0];
    if (!rotor) throw new Error('No rotor');
    expect(h.control(FAILS_AT, motorLoss(mode, 0.3))).toMatchObject({ status: 'queued' });
    let row = h.step(0, CLIMB_PWM), reference = baseline.step(0, CLIMB_PWM);
    for (let frame = 1; frame < ENDS_AT; frame++) {
      row = h.step(frame, CLIMB_PWM); reference = baseline.step(frame, CLIMB_PWM);
      if (row.tick < FAILS_AT) expect(Float64Array.from(row.truth), `truth before the fault, tick ${row.tick}`).toEqual(Float64Array.from(reference.truth));
    }
    expect(h.state.ewFlags & EwFlagV2.MotorFault).toBe(EwFlagV2.MotorFault);
    // The thrust lost at r = (x, y), in body FRD with thrust along −z: the moment it took away is (−y·T, x·T), so the body turns by (y·ΔT, −x·ΔT).
    const x = rotor.hubPositionBodyM[0] ?? NaN, y = rotor.hubPositionBodyM[1] ?? NaN;
    // Against the flight without the fault, whose centre of gravity gives it a pitch of its own.
    const p = (row.truth[10] ?? NaN) - (reference.truth[10] ?? NaN), q = (row.truth[11] ?? NaN) - (reference.truth[11] ?? NaN);
    expect(Math.sign(p), `roll rate ${p}`).toBe(Math.sign(y));
    expect(Math.sign(q), `pitch rate ${q}`).toBe(-Math.sign(x));
    expect(Math.abs(p)).toBeGreaterThan(0.05);
    expect(Math.abs(reference.truth[10] ?? NaN), 'no roll without it').toBeLessThan(1e-3);
  }, 180000);
});

describe('ArduPilot\'s own fault parameters', () => {
  const catalog = parseArduPilotCatalog(catalogJson);
  it('stand behind exactly the `ardupilot` effects, and each is in the pinned catalog', () => {
    expect(Object.keys(ARDUPILOT_FAULT_PARAMETERS).sort()).toEqual(EFFECT_IDS.filter(id => EFFECT_CATALOG[id].family === 'ardupilot').sort());
    for (const id of EFFECT_IDS) expect(faultParameters(id) !== null, id).toBe(EFFECT_CATALOG[id].family === 'ardupilot');
    for (const plan of Object.values(ARDUPILOT_FAULT_PARAMETERS)) for (const { name, on } of plan) {
      expect(catalog.parameters.has(name), name).toBe(true);
      expect(Number.isInteger(on)).toBe(true);
    }
  });
  it('are no standing error, so the TASK-089 ownership guard lets them through', () => {
    const faultClass = SIM_PARAMETERS_WITHOUT_A_SOURCE.find(item => item.id === 'fault'), settings = SIM_PARAMETERS_WITHOUT_A_SOURCE.find(item => item.id === 'sensor-settings');
    if (!faultClass || !settings) throw new Error('No declared class');
    for (const plan of Object.values(ARDUPILOT_FAULT_PARAMETERS)) for (const { name } of plan) {
      expect(errorSourceOfParameter(name), name).toBeNull();
      expect(faultClass.names.test(name) || settings.names.test(name), name).toBe(true);
    }
  });
  it('and a session rejects them visibly, on or off, since only the run controller writes parameters', async () => {
    const h = await harness();
    for (const value of [record('sensor.baro.frozen'), record('sensor.baro.frozen', false), record('sensor.gnss.missing')]) {
      expect(h.control(10, value)).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE', message: expect.stringContaining('fault parameter') as string });
    }
  }, 120000);
});
