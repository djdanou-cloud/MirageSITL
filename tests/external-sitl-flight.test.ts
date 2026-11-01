import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { prepareContact } from './contact-support.ts';
import { standardGearHeights } from './support/standard-gear.ts';
import { WebSocket } from 'ws';
import { frameConfiguration } from '@mirage/aircraft/frame-parameters';
import { GroundStation, CopterMode } from '@mirage/autopilot/ground-station';
import { LiveEkfWarmup } from '@mirage/autopilot/live-warmup';
import { SitlJsonLink } from '@mirage/autopilot/sitl-link';
import { MavParser, type MavFrame } from '@mirage/mavlink/codec';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newHeaderSnapshotV2, type CommandResultV2 } from '@mirage/protocol';
import { ensureToken, startLauncher } from '../apps/launcher/src/server.ts';
import { readCatalog } from '../apps/launcher/src/catalog.ts';
import { quadProfile } from './support/quad-profile.ts';

// TASK-153 increment 1 (G4 on the reference Mac): the installed native
// ArduCopter (TASK-152 home) flies the S19 quad X profile through the
// launcher's bridge. The physics is PhysicsSessionV2 with the profile's BET
// dynamics in sitl-lockstep, driven by SitlJsonLink as the physics Worker
// will drive it; the ground station is this process, speaking MAVLink2 with
// the TASK-150 codec. READY comes only from LiveEkfWarmup on this run's
// acknowledged JSON IMU samples and CRC-checked EKF, GPS and heartbeat
// messages. Truth altitude is read from the session's published state.
// TASK-095: the quad stands, takes off and lands on its standard landing gear
// on the Rapier contact, and its attitude changes each step only by what its
// body rate turns it (no pad resetting it level).

const ROOT = process.cwd();
const HOME = join(ROOT, '.cache/task-152/home');
const ORIGIN = 'http://127.0.0.1:5173';
// ArduCopter's pre-arm check needs the gyro at 1.8 times its 400 Hz loop, so physics runs at 800 Hz (as scripts/sitl/frames-driver.mjs).
const HZ = 800, SPEEDUP = 4, TAKEOFF_M = 5, HOLD_S = 10;
/** EKF_STATUS_REPORT, GPS_RAW_INT and GLOBAL_POSITION_INT at 10 Hz: LiveEkfWarmup needs GPS within 0.3 s of the IMU. */
const STREAMS = [[193, 100000], [24, 100000], [33, 100000]] as const;
const installed = existsSync(join(HOME, 'install-manifest.json'));

describe.skipIf(!installed)('native ArduCopter flies the quad X profile through SitlJsonLink (TASK-153)', () => {
  test('warms up to READY, arms in GUIDED, takes off to 5 m, holds and lands', async () => {
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
    const module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
    // The vehicle stands on its standard landing gear (TASK-095).
    await prepareContact();
    const { profile, derived } = await quadProfile();
    // Heights of the CG with the fully extended feet touching the ground and at rest on them, from the gear's rules.
    const { touchM, restM } = standardGearHeights(derived.manifest);
    const frame = frameConfiguration(profile);
    if (!frame.ok) throw new Error('The quad X profile has no ArduPilot frame');
    expect(frame.kind).toBe('stock');
    const baseline = readFileSync(join(ROOT, 'tests/fixtures/sitl/parameters.parm'), 'utf8').split('\n').filter(line => /^[A-Z]/.test(line))
      .map(line => { const [name, value] = line.trim().split(/\s+/); return { name: name ?? '', value: Number(value) }; });
    // The link maps 1000-2000 us to ESC duty 0-1, so the autopilot's PWM range is pinned to the same span.
    const parameters = [...baseline, ...frame.parameters, { name: 'MOT_PWM_MIN', value: 1000 }, { name: 'MOT_PWM_MAX', value: 2000 }];

    const registry = new VehicleRegistry();
    await registry.register(derived.bytes, derived.sha256);
    const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator');
    const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
      { monotonicMs: () => performance.now(), wallMs: () => performance.timeOrigin + performance.now() }, undefined, null,
      profileModelPort(registry, () => module));
    const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2();
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
    expect(await command('model.load', { modelId: derived.manifest.modelId, manifestSha256: derived.sha256 })).toMatchObject({ status: 'applied' });
    expect(await command('sim.start')).toMatchObject({ status: 'applied' });

    const token = ensureToken(HOME);
    const [firmware] = readCatalog(HOME);
    if (!firmware) throw new Error('The installation has no firmware');
    const launcher = await startLauncher({ home: HOME, origin: ORIGIN, port: 0, python: join(HOME, 'venv/bin/python') });
    const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`http://127.0.0.1:${launcher.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return response.json();
    };
    const get = (value: unknown, ...keys: (string | number)[]): unknown =>
      keys.reduce<unknown>((at, key) => (typeof at === 'object' && at !== null ? Reflect.get(at, key) : undefined), value);
    let ws: WebSocket | null = null;
    let experimentId = '';
    try {
      const started = await api('POST', '/v1/experiments', { firmwareId: firmware.id, parameters, frameScript: null, speedup: SPEEDUP, rateHz: HZ,
        home: [-35.363261, 149.165230, 584, 0] });
      experimentId = String(get(started, 'id'));
      const bridgePort = Number(get(started, 'ports', 'bridge')), runs = get(started, 'runs');
      const epoch = Array.isArray(runs) ? runs.length : 0;
      expect(epoch).toBe(1);
      const link = new SitlJsonLink(stateBuffer, actuatorBuffer, {
        bridgeEpoch: epoch, motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1), motorMapId: derived.manifest.modelId });
      const warmup = new LiveEkfWarmup('external-sitl', 1, 0, 0, SPEEDUP, { imuSource: 'json-lockstep' });
      const gcs = new GroundStation(), packet = new Uint8Array(64), record = new Uint8Array(128);
      const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}`, ['mirage-v1', `session.${token}`], { origin: ORIGIN });
      ws = socket;
      const send = (n: number) => { if (n > 0) socket.send(record.subarray(0, link.mavlinkRecordInto(packet.subarray(0, n), record))); };

      // Autopilot state from its own heartbeats, command acknowledgements and status text.
      let armed = false, mode = -1, everArmed = false;
      const acks: { command: number; result: number }[] = [], text: string[] = [];
      const gcsParser = new MavParser((m: MavFrame) => {
        if (m.systemId !== 1 || m.componentId !== 1) return;
        if (m.id === 0) { mode = m.view.getUint32(0, true); armed = (m.view.getUint8(6) & 128) !== 0; everArmed ||= armed; }
        if (m.id === 77) acks.push({ command: m.view.getUint16(0, true), result: m.view.getUint8(2) });
        if (m.id === 253) text.push(new TextDecoder().decode(m.payload.subarray(1, 51)).replace(/\0.*$/s, ''));
      });

      type Stage = 'warmup' | 'guided' | 'arm' | 'takeoff' | 'hold' | 'land' | 'landed';
      let stage: Stage = 'warmup', stageAtS = 0, lastCommandS = -10, lastHeartbeatS = -10, readyAtS = -1, holdStartS = 0;
      let armedAtS = -1, takeoffAtS = -1, holdMinM = Infinity, holdMaxM = -Infinity, maxAltitudeM = 0, simTimeS = 0;
      // Attitude continuity: the largest step turn beyond the body rate's own turn over the step, and the touchdown.
      let qw = 1, qx = 0, qy = 0, qz = 0, rate = 0, steps = 0, turnExcessRad = 0, maxTurnRad = 0, touchdownAtS = -1, touchdownSinkMps = 0, turnExcessAtS = -1, turnExcessStage = '';
      const mavlink = new Uint8Array(4096), wallStart = performance.now();
      const diagnostics = () => JSON.stringify({ simTimeS, reason: warmup.warmup.reason, imuTimeS: warmup.imuTimeS, gpsTimeS: warmup.gpsTimeS,
        health: warmup.monitor.snapshot(simTimeS * 1000), acks: acks.slice(-6), text: text.slice(-6), frames: warmup.parser.frames });
      const finished = new Promise<void>((resolve, reject) => {
        const wall = setTimeout(() => reject(new Error(`Timed out in stage ${stage}: ${diagnostics()}`)), 400000);
        socket.on('close', (code, reason) => { if (stage !== 'landed') reject(new Error(`Bridge closed ${code} ${reason.toString()}`)); });
        socket.on('message', (data: Buffer) => {
          const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const event = link.receive(bytes);
          if (event === 'mavlink') {
            mavlink.set(link.inbound.subarray(link.mavlinkOffset, link.mavlinkOffset + link.mavlinkLength));
            const chunk = mavlink.subarray(0, link.mavlinkLength);
            warmup.ingest(chunk, simTimeS);
            gcsParser.push(chunk);
            return;
          }
          if (event === 'resend') { socket.send(link.outbound.slice(0, 16 + new DataView(link.outbound.buffer).getUint32(12, true))); return; }
          if (event === 'restart') { clearTimeout(wall); reject(new Error('SITL restarted during the flight')); return; }
          if (event !== 'step') return;
          warmup.acknowledgeJsonImu(link.lockstep.lastFrameCount, link.repliedFrame, link.replyTimeS);
          session.pump();
          const n = link.poll();
          if (n === 0) { clearTimeout(wall); reject(new Error(`No state for the stepped tick: ${session.fault}`)); return; }
          socket.send(link.outbound.slice(0, n));
          // The link's own copy of the stepped tick: a second FlightStateV2 would make the state decoder polymorphic.
          const truth = link.state;
          simTimeS = truth.simTimeS;
          const ready = warmup.observe(simTimeS, performance.now());
          if (ready && readyAtS < 0) readyAtS = simTimeS;
          const altitudeM = -truth.downM;
          maxAltitudeM = Math.max(maxAltitudeM, altitudeM);
          // The step's turn from the vector part of q_prev⁻¹ ⊗ q, w₁v₂ − w₂v₁ − v₁ × v₂: well conditioned for small turns, unlike
          // 2·acos(q_prev · q), which turns the published quaternion's rounding into turns of 10⁻⁴ rad.
          const vx = qw * truth.qx - truth.qw * qx - (qy * truth.qz - qz * truth.qy);
          const vy = qw * truth.qy - truth.qw * qy - (qz * truth.qx - qx * truth.qz);
          const vz = qw * truth.qz - truth.qw * qz - (qx * truth.qy - qy * truth.qx);
          const turn = 2 * Math.asin(Math.min(1, Math.hypot(vx, vy, vz))), nowRate = Math.hypot(truth.pRadS, truth.qRadS, truth.rRadS);
          if (steps++ > 0) {
            const excess = turn - 1.05 * Math.max(rate, nowRate) / HZ;
            if (excess > turnExcessRad) { turnExcessRad = excess; turnExcessAtS = simTimeS; turnExcessStage = stage; }
            maxTurnRad = Math.max(maxTurnRad, turn);
          }
          qw = truth.qw; qx = truth.qx; qy = truth.qy; qz = truth.qz; rate = nowRate;
          if (stage === 'land' && touchdownAtS < 0 && altitudeM <= touchM) { touchdownAtS = simTimeS; touchdownSinkMps = truth.vdMps; }
          if (simTimeS - lastHeartbeatS >= 1) {
            // The relay forwards to SITL only after SITL's first datagram, so requests repeat until acknowledged.
            const accepted = acks.filter(a => a.command === 511 && a.result === 0).length;
            if (accepted < STREAMS.length) for (const [id, us] of STREAMS) send(gcs.messageIntervalInto(id, us, packet));
            send(gcs.heartbeatInto(packet));
            lastHeartbeatS = simTimeS;
          }
          if (stage === 'warmup' && simTimeS > 180) { clearTimeout(wall); reject(new Error(`No READY after 180 s: ${diagnostics()}`)); return; }
          const retry = simTimeS - lastCommandS >= 2;
          const next = (to: Stage) => { stage = to; stageAtS = simTimeS; };
          switch (stage) {
            case 'warmup': if (ready) next('guided'); break;
            case 'guided': if (mode === CopterMode.Guided) next('arm'); else if (retry) { send(gcs.setModeInto(CopterMode.Guided, packet)); lastCommandS = simTimeS; } break;
            case 'arm': if (armed) { armedAtS = takeoffAtS = simTimeS; send(gcs.takeoffInto(TAKEOFF_M, packet)); lastCommandS = simTimeS; next('takeoff'); }
              else if (retry) { send(gcs.armInto(true, packet)); lastCommandS = simTimeS; } break;
            case 'takeoff':
              if (Math.abs(altitudeM - TAKEOFF_M) < 0.5 && Math.abs(truth.vdMps) < 0.3) { holdStartS = simTimeS; next('hold'); }
              else if (!armed && simTimeS - stageAtS > 5) { clearTimeout(wall); reject(new Error(`Disarmed during takeoff: ${text.slice(-5).join(' | ')}`)); }
              break;
            case 'hold':
              holdMinM = Math.min(holdMinM, altitudeM); holdMaxM = Math.max(holdMaxM, altitudeM);
              if (simTimeS - holdStartS >= HOLD_S) { send(gcs.setModeInto(CopterMode.Land, packet)); lastCommandS = simTimeS; next('land'); }
              break;
            case 'land':
              if (!armed && Math.abs(altitudeM - restM) < 1e-3 && Math.abs(truth.vdMps) < 0.01) { next('landed'); clearTimeout(wall); resolve(); }
              else if (mode !== CopterMode.Land && retry) { send(gcs.setModeInto(CopterMode.Land, packet)); lastCommandS = simTimeS; }
              break;
            case 'landed': break;
            default: { const never: never = stage; throw new Error(`Unhandled stage ${String(never)}`); }
          }
        });
      });
      await finished;
      // Evidence in an ignored file (test-results/ is ignored; no tracked report changes).
      mkdirSync(join(ROOT, 'test-results/validation'), { recursive: true });
      writeFileSync(join(ROOT, 'test-results/validation/task-153-flight.json'), JSON.stringify({ task: 'TASK-153', firmware: { id: firmware.id, commit: firmware.commit },
        manifestSha256: derived.sha256, hz: HZ, speedup: SPEEDUP, readyAtS, armedAtS, takeoffAtS, holdStartS, holdMinM, holdMaxM, maxAltitudeM,
        gear: { touchM, restM, touchdownAtS, touchdownSinkMps, landedAltitudeM: -link.state.downM, maxTurnRad, turnExcessRad, turnExcessAtS, turnExcessStage, steps },
        landedAtS: simTimeS, wallS: (performance.now() - wallStart) / 1000, lockstep: link.lockstepStats, link: link.stats, acks, text }, null, 2) + '\n');
      expect(readyAtS).toBeGreaterThanOrEqual(30);
      expect(everArmed).toBe(true);
      expect(acks.filter(a => a.command === 400 || a.command === 22).every(a => a.result === 0)).toBe(true);
      expect(maxAltitudeM).toBeGreaterThan(TAKEOFF_M - 0.5);
      expect(holdMaxM - holdMinM).toBeLessThan(1);
      expect(link.lockstepStats.duplicates + link.lockstepStats.gaps).toBe(0);
      // On the gear: no step turned the body more than its rate did, and it touched down at ArduCopter's landing speed.
      expect(turnExcessRad).toBeLessThan(1e-6);
      expect(touchdownAtS).toBeGreaterThan(holdStartS);
      expect(touchdownSinkMps).toBeGreaterThan(0.1);
      expect(touchdownSinkMps).toBeLessThan(1);
      expect(session.fault).toBe('');
    } finally {
      ws?.close();
      if (experimentId) await api('POST', `/v1/experiments/${experimentId}/stop`);
      await launcher.close();
      session.dispose();
    }
  }, 600000);
});
