import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { frameConfiguration } from '@mirage/aircraft/frame-parameters';
import type { AircraftProfile } from '@mirage/aircraft/profile';
import type { DerivedVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { GroundStation } from '@mirage/autopilot/ground-station';
import { expectedMotors, MotorCheck, physicsRotors, type MotorCheckResult } from '@mirage/autopilot/motor-test';
import { SitlJsonLink } from '@mirage/autopilot/sitl-link';
import { MavParser, type MavFrame } from '@mirage/mavlink/codec';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import {
  createPowerChannelV1, createSharedMemoryV2, createSpscQueue, newHeaderSnapshotV2, newPowerSnapshotV1, PowerReaderV1, StateReaderV2, type CommandResultV2,
} from '@mirage/protocol';
import { ensureToken, startLauncher } from '../apps/launcher/src/server.ts';
import { readCatalog } from '../apps/launcher/src/catalog.ts';
import { quadProfile } from './support/quad-profile.ts';

// TASK-157 DoD with the installed native ArduCopter (TASK-152 home) and the
// real physics session: ArduCopter's own motor test (MAV_CMD_DO_MOTOR_TEST)
// spins each motor of each of the five S19 configurations in its frame test
// order, and the physics rotor that turns, its output and its spin match the
// TASK-142 frame configuration. Faults are injected on the physics side only,
// as a wiring or propeller mistake would be: two motors on each other's
// outputs, and one rotor's spin reversed, in the model the physics runs, while
// ArduPilot keeps the profile's frame. (Swapping channels inside the JSON link
// would cancel out: it reads a channel and writes the same actuator slot.) Oracles: the frame catalog's test order and yaw
// factors through frameConfiguration, and the motor that was deliberately
// swapped or reversed. Runs in a temporary copy of the launcher home.

const ROOT = process.cwd();
const HOME = join(ROOT, '.cache/task-152/home');
const ORIGIN = 'http://127.0.0.1:5173';
const HZ = 800, SPEEDUP = 4;
const installed = existsSync(join(HOME, 'install-manifest.json'));
const CONFIGURATIONS = ['quad-x', 'hexa-x', 'octa-x', 'coaxial-x8', 'octa-coaxial-16'] as const;

let module: WebAssembly.Module;
let home = '';
beforeAll(() => {
  if (!installed) return;
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  home = mkdtempSync(join(tmpdir(), 'mirage-motor-check-'));
  copyFileSync(join(HOME, 'catalog.json'), join(home, 'catalog.json'));
}, 600000);
afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

interface Run { readonly results: readonly MotorCheckResult[]; readonly stopped: string | null; readonly text: readonly string[]; readonly simTimeS: number }

/**
 * Starts SITL with `profile`'s frame and flies nothing: after boot, the motor
 * check spins every motor once. The physics runs `physics`, the profile's own
 * manifest unless a fault replaces it.
 */
async function motorCheck(profile: AircraftProfile, physics: DerivedVehicleManifest): Promise<Run> {
  const frame = frameConfiguration(profile);
  if (!frame.ok) throw new Error('The profile has no ArduPilot frame');
  const baseline = readFileSync(join(ROOT, 'tests/fixtures/sitl/parameters.parm'), 'utf8').split('\n').filter(line => /^[A-Z]/.test(line))
    .map(line => { const [name, value] = line.trim().split(/\s+/); return { name: name ?? '', value: Number(value) }; });
  const parameters = [...baseline.filter(p => !frame.parameters.some(f => f.name === p.name)), ...frame.parameters,
    { name: 'MOT_PWM_MIN', value: 1000 }, { name: 'MOT_PWM_MAX', value: 2000 }];

  const registry = new VehicleRegistry();
  await registry.register(physics.bytes, physics.sha256);
  const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator'), powerBuffer = createPowerChannelV1();
  const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
    { monotonicMs: () => performance.now(), wallMs: () => performance.timeOrigin + performance.now() }, undefined, null,
    profileModelPort(registry, () => module));
  session.attachPowerChannel(powerBuffer);
  const power = new PowerReaderV1(powerBuffer), snapshot = newPowerSnapshotV1();
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  for (const [type, extra] of [['sim.configure', { hz: HZ, clockMode: 'sitl-lockstep' }],
    ['model.load', { modelId: physics.manifest.modelId, manifestSha256: physics.sha256 }], ['sim.start', {}]] as const) {
    reader.readHeader(header);
    session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
    await session.settled();
    session.drain(result => results.push(result));
    expect(results.at(-1), type).toMatchObject({ status: 'applied' });
  }

  const token = ensureToken(home);
  const [firmware] = readCatalog(home);
  if (!firmware) throw new Error('The installation has no firmware');
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, 'venv/bin/python') });
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${launcher.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.json();
  };
  const get = (value: unknown, ...keys: (string | number)[]): unknown =>
    keys.reduce<unknown>((at, key) => (typeof at === 'object' && at !== null ? Reflect.get(at, key) : undefined), value);
  let socket: WebSocket | null = null, experimentId = '';
  try {
    const started = await api('POST', '/v1/experiments', { firmwareId: firmware.id, parameters, frameScript: frame.script, speedup: SPEEDUP, rateHz: HZ,
      home: [-35.363261, 149.16523, 584, 0] });
    experimentId = String(get(started, 'id'));
    const bridgePort = Number(get(started, 'ports', 'bridge'));
    const channels = physics.manifest.rotors.map(rotor => rotor.motorChannel + 1);
    const link = new SitlJsonLink(stateBuffer, actuatorBuffer, { bridgeEpoch: 1, motorChannels: channels, motorMapId: physics.manifest.modelId });
    const check = new MotorCheck(expectedMotors(frame.motors), physicsRotors(physics.manifest.rotors));
    const gcs = new GroundStation(), packet = new Uint8Array(64), record = new Uint8Array(128);
    const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}`, ['mirage-v1', `session.${token}`], { origin: ORIGIN });
    socket = ws;
    const send = (n: number) => { if (n > 0) ws.send(record.subarray(0, link.mavlinkRecordInto(packet.subarray(0, n), record))); };
    const text: string[] = [];
    let heartbeatAtS = -1, simTimeS = 0, lastBeatS = -10, steps = 0;
    const parser = new MavParser((m: MavFrame) => {
      if (m.systemId !== 1 || m.componentId !== 1) return;
      if (m.id === 0 && m.view.getUint8(5) === 3 && heartbeatAtS < 0) heartbeatAtS = simTimeS;
      if (m.id === 77 && m.view.getUint16(0, true) === 209) check.ack(m.view.getUint8(2), simTimeS, text.at(-1) ?? '');
      if (m.id === 253) text.push(new TextDecoder().decode(m.payload.subarray(1, 51)).replace(/\0.*$/s, ''));
    });
    const rpm = new Float64Array(physics.manifest.rotors.length);
    const frameReady = () => frame.script === null || text.some(line => line.startsWith('MirageSITL frame ready'));
    await new Promise<void>((resolve, reject) => {
      const wall = setTimeout(() => reject(new Error(`Timed out at ${simTimeS.toFixed(1)} s: ${text.slice(-6).join(' | ')}`)), 400000);
      ws.on('close', (code, reason) => { if (!check.done) reject(new Error(`Bridge closed ${code} ${reason.toString()}`)); });
      ws.on('message', (data: Buffer) => {
        const event = link.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        if (event === 'mavlink') { parser.push(link.inbound.subarray(link.mavlinkOffset, link.mavlinkOffset + link.mavlinkLength)); return; }
        if (event === 'resend') { ws.send(link.outbound.slice(0, 16 + new DataView(link.outbound.buffer).getUint32(12, true))); return; }
        if (event !== 'step') return;
        session.pump();
        const n = link.poll();
        if (n === 0) { clearTimeout(wall); reject(new Error(`No state for the stepped tick: ${session.fault}`)); return; }
        ws.send(link.outbound.slice(0, n));
        simTimeS = link.state.simTimeS;
        if (simTimeS - lastBeatS >= 1) { send(gcs.heartbeatInto(packet)); lastBeatS = simTimeS; }
        // ArduPilot must have booted (10 s after its first heartbeat) and a scripting frame must be loaded.
        if (heartbeatAtS < 0 || simTimeS - heartbeatAtS < 10 || !frameReady() || ++steps % 80 !== 0) return;
        if (power.latest(snapshot)) for (let i = 0; i < rpm.length; i++) rpm[i] = snapshot.motors[i * 5] ?? 0;
        const action = check.observe(simTimeS, rpm);
        if (action.kind === 'command') send(gcs.motorTestInto(action.testOrder, action.pwmUs, action.timeoutS, packet));
        if (action.kind === 'done') { clearTimeout(wall); resolve(); }
      });
    });
    return { results: check.results, stopped: check.stoppedReason, text, simTimeS };
  } finally {
    socket?.close();
    if (experimentId) await api('POST', `/v1/experiments/${experimentId}/stop`);
    await launcher.close();
    session.dispose();
  }
}

describe.skipIf(!installed)('the motor check with native ArduCopter (TASK-157)', () => {
  const evidence: Record<string, unknown> = {};
  afterAll(() => {
    mkdirSync(join(ROOT, 'test-results/validation'), { recursive: true });
    writeFileSync(join(ROOT, 'test-results/validation/task-157-motor-check.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  });

  test.each(CONFIGURATIONS)('every motor of %s turns alone, on its output, in its spin', async name => {
    const { profile, derived } = await quadProfile(undefined, name);
    const run = await motorCheck(profile, derived);
    evidence[name] = run.results;
    expect(run.stopped, run.text.slice(-6).join(' | ')).toBeNull();
    const frame = frameConfiguration(profile);
    if (!frame.ok) throw new Error('No frame');
    expect(run.results.map(r => r.testOrder)).toEqual(frame.motors.map(m => m.testOrder).sort((a, b) => a - b));
    for (const result of run.results) expect(result.pass, `${name}: ${result.reason}`).toBe(true);
    expect(new Set(run.results.map(r => r.observed?.motorId)).size).toBe(frame.motors.length);
  }, 600000);

  test('two motors wired to each other\'s outputs in the model are detected on exactly those two motors', async () => {
    const { profile } = await quadProfile(undefined, 'quad-x');
    const crossed = await quadProfile(undefined, 'quad-x', fixture => ({
      ...fixture, motors: fixture.motors.map(motor => (motor.id === 1 ? { ...motor, output: 2 } : motor.id === 2 ? { ...motor, output: 1 } : motor)) }));
    const run = await motorCheck(profile, crossed.derived);
    evidence.swapped = run.results;
    const swapped = new Set([1, 2]);
    for (const result of run.results) {
      expect(result.pass, result.reason).toBe(!swapped.has(result.expected.motorId));
      if (swapped.has(result.expected.motorId)) expect(result.reason).toContain('the motor mapping is swapped');
    }
  }, 600000);

  test('a reversed spin in the model is detected on exactly that motor', async () => {
    const { profile } = await quadProfile(undefined, 'quad-x');
    const reversed = await quadProfile(undefined, 'quad-x', fixture => ({
      ...fixture, motors: fixture.motors.map(motor => (motor.id === 3 ? { ...motor, spin: motor.spin === 'ccw' ? 'cw' : 'ccw' } : motor)) }));
    const run = await motorCheck(profile, reversed.derived);
    evidence.reversed = run.results;
    for (const result of run.results) {
      expect(result.pass, result.reason).toBe(result.expected.motorId !== 3);
      if (result.expected.motorId === 3) expect(result.reason).toContain('the spin is reversed');
    }
  }, 600000);
});
