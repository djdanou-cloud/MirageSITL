import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { prepareContact } from './contact-support.ts';
import { WebSocket } from 'ws';
import { frameConfiguration } from '@mirage/aircraft/frame-parameters';
import { ARDUPILOT_FAULT_PARAMETERS } from '@mirage/autopilot/fault-effects';
import { GroundStation, CopterMode } from '@mirage/autopilot/ground-station';
import { createSessionFaultPort } from '@mirage/ew/session-port';
import { MavParser, type MavFrame } from '@mirage/mavlink/codec';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newHeaderSnapshotV2, tickToNumber, type CommandResultV2, type EffectControl, type EffectId } from '@mirage/protocol';
import { SitlBridgeClient, type SitlNotice } from '../apps/web/src/sitl/bridge-client.ts';
import { ensureToken, startLauncher } from '../apps/launcher/src/server.ts';
import { readCatalog } from '../apps/launcher/src/catalog.ts';
import { quadProfile } from './support/quad-profile.ts';

// TASK-168 on the reference Mac: the installed stock ArduCopter flies the S19 quad X profile through the same bridge client as the
// physics Worker, one flight per fault, since a frozen IMU can end a flight, which is an answer and would spoil the next. What is
// checked is that the fault reached ArduPilot: a parameter read back, a reading that stopped, a link that went quiet. What ArduPilot
// then does about it is recorded in test-results/validation/task-168-faults.json and not predicted: no mode, failsafe or landing is
// asserted. It takes about six minutes, so it runs on request: MIRAGE_SITL_FAULTS=1 npx vitest run tests/sitl-fault-effects.test.ts

const ROOT = process.cwd();
const HOME = join(ROOT, '.cache/task-152/home');
const ORIGIN = 'http://127.0.0.1:5173';
const HZ = 800, SPEEDUP = 4, TAKEOFF_M = 10, ON_S = 8, RECOVER_S = 8;
/** MAVLink messages asked of ArduPilot, at 10 Hz: SYS_STATUS, GPS_RAW_INT, RAW_IMU, EKF_STATUS_REPORT. */
const STREAMS = [[1, 100000], [24, 100000], [27, 100000], [193, 100000]] as const;
const REAL32 = 9, CONDITION_YAW = 115;
const wanted = existsSync(join(HOME, 'install-manifest.json')) && process.env.MIRAGE_SITL_FAULTS === '1';
const SYS_STATUS_HEALTH = { gyro: 1, accel: 2, mag: 4, baro: 8, gps: 32 } as const;

interface Span { min: number; max: number; samples: number }
const span = (): Span => ({ min: Infinity, max: -Infinity, samples: 0 });
const widen = (s: Span, value: number) => { s.min = Math.min(s.min, value); s.max = Math.max(s.max, value); s.samples++; };
const width = (s: Span) => (s.samples === 0 ? null : s.max - s.min);

interface Measured {
  lat: Span; lon: Span; xmag: Span; ymag: Span; zmag: Span; gyro: Span; truthNorth: Span; truthYaw: Span; truthDown: Span;
  fixMin: number; healthLost: number; statusText: string[]; frames: number; modeAtEnd: number; armedAtEnd: boolean; ekfFlagsAtEnd: number;
}
const measured = (): Measured => ({ lat: span(), lon: span(), xmag: span(), ymag: span(), zmag: span(), gyro: span(), truthNorth: span(), truthYaw: span(), truthDown: span(),
  fixMin: 99, healthLost: 0, statusText: [], frames: 0, modeAtEnd: -1, armedAtEnd: false, ekfFlagsAtEnd: -1 });
const summary = (m: Measured) => ({ latSpan: width(m.lat), lonSpan: width(m.lon), fixMin: m.fixMin, magSpanMilliGauss: [width(m.xmag), width(m.ymag), width(m.zmag)], gyroSpan: width(m.gyro),
  truthNorthSpanM: width(m.truthNorth), truthDownSpanM: width(m.truthDown), truthYawSpanRad: width(m.truthYaw), framesFromAutopilot: m.frames, healthLost: m.healthLost,
  modeAtEnd: m.modeAtEnd, armedAtEnd: m.armedAtEnd, ekfFlagsAtEnd: m.ekfFlagsAtEnd, statusText: m.statusText });

const plain = (effect: EffectId, enabled = true): EffectControl => ({ schemaVersion: 1, id: effect.replaceAll('.', '-'), effect, enabled, intensity: 1, parameters: {} });
const motor = (enabled = true): EffectControl => ({ schemaVersion: 1, id: 'motor', effect: 'motor.loss', enabled, intensity: 1, parameters: { motorIndex: 0, mode: 'power-cut', remainingThrustFraction: 0.75 } });
const northWind: EffectControl = { schemaVersion: 1, id: 'wind', effect: 'wind.mean', enabled: true, intensity: 1, parameters: { windNedMps: [4, 0, 0] } };
/** What makes a reading worth holding: a wind that moves the aircraft while its fix is frozen, a turn while its compass is. */
const STEPS: readonly { name: EffectId; control?: (enabled: boolean) => EffectControl; push?: 'wind' | 'turn' }[] = [
  { name: 'sensor.imu.frozen' }, { name: 'sensor.gnss.frozen', push: 'wind' }, { name: 'sensor.mag.frozen', push: 'turn' }, { name: 'sensor.baro.frozen' }, { name: 'sensor.baro.missing' },
  { name: 'sensor.mag.missing' }, { name: 'sensor.gnss.missing' }, { name: 'link.pilot' }, { name: 'link.gcs' }, { name: 'motor.loss', control: motor }, { name: 'sensor.imu.missing' },
];
type Plans = Partial<Record<EffectId, readonly { readonly name: string; readonly on: number }[]>>;
const PLANS: Plans = ARDUPILOT_FAULT_PARAMETERS;

describe.skipIf(!wanted)('faults reaching native ArduCopter (TASK-168)', () => {
  test('each reaches ArduPilot through its own path while it hovers, and its response is recorded', async () => {
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
    const module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
    await prepareContact();
    const { profile, derived } = await quadProfile();
    const frame = frameConfiguration(profile);
    if (!frame.ok) throw new Error('The quad X profile has no ArduPilot frame');
    const baseline = readFileSync(join(ROOT, 'tests/fixtures/sitl/parameters.parm'), 'utf8').split('\n').filter(line => /^[A-Z]/.test(line))
      .map(line => { const [name, value] = line.trim().split(/\s+/); return { name: name ?? '', value: Number(value) }; });
    const parameters = [...baseline, ...frame.parameters, { name: 'MOT_PWM_MIN', value: 1000 }, { name: 'MOT_PWM_MAX', value: 2000 }, { name: 'INS_GYRO_FILTER', value: 40 }];
    const registry = new VehicleRegistry();
    await registry.register(derived.bytes, derived.sha256);
    const token = ensureToken(HOME);
    const [firmware] = readCatalog(HOME);
    if (!firmware) throw new Error('The installation has no firmware');
    const launcher = await startLauncher({ home: HOME, origin: ORIGIN, port: 0, python: join(HOME, 'venv/bin/python') });
    const url = (path: string) => `http://127.0.0.1:${launcher.port}${path}`;
    const headers = { authorization: `Bearer ${token}`, origin: ORIGIN };
    const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(url(path), { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return response.json();
    };
    const get = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((at, key) => (typeof at === 'object' && at !== null ? Reflect.get(at, key) : undefined), value);

    /** One flight: up to 10 m, the fault on for 8 s, off for 8 s, unless the aircraft strikes something first. */
    const flight = async (step: typeof STEPS[number]) => {
      const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator');
      const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
        { monotonicMs: () => performance.now(), wallMs: () => performance.timeOrigin + performance.now() }, undefined, createSessionFaultPort(), profileModelPort(registry, () => module));
      const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), results: CommandResultV2[] = [];
      let requestId = 0;
      const handle = (message: Record<string, unknown>) => {
        reader.readHeader(header);
        session.handle({ requestId: ++requestId, expectedEpoch: header.sessionEpoch, ...message });
        session.drain(result => results.push(result));
        return results.at(-1);
      };
      const command = async (type: string, extra: Record<string, unknown> = {}) => {
        handle({ protocolVersion: 2, type, ...extra });
        await session.settled();
        session.drain(result => results.push(result));
        return results.at(-1);
      };
      expect(await command('sim.configure', { hz: HZ, clockMode: 'sitl-lockstep' })).toMatchObject({ status: 'applied' });
      expect(await command('model.load', { modelId: derived.manifest.modelId, manifestSha256: derived.sha256 })).toMatchObject({ status: 'applied' });
      expect(await command('sim.start')).toMatchObject({ status: 'applied' });
      let ws: WebSocket | null = null, experimentId = '';
      try {
        const started = await api('POST', '/v1/experiments', { firmwareId: firmware.id, parameters, frameScript: null, speedup: SPEEDUP, rateHz: HZ, home: [-35.363261, 149.165230, 584, 0] });
        experimentId = String(get(started, 'id'));
        const bridgePort = Number(get(started, 'ports', 'bridge')), runs = get(started, 'runs');
        const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}`, ['mirage-v1', `session.${token}`], { origin: ORIGIN });
        ws = socket;
        let armed = false, mode = -1, simTimeS = 0, window = measured();
        const text: string[] = [], paramValues = new Map<string, number>();
        const parser = new MavParser((m: MavFrame) => {
          if (m.systemId !== 1 || m.componentId !== 1) return;
          window.frames++;
          switch (m.id) {
            case 0: mode = m.view.getUint32(0, true); armed = (m.view.getUint8(6) & 128) !== 0; break;
            case 1: window.healthLost |= m.view.getUint32(0, true) & ~m.view.getUint32(8, true); break;
            case 22: paramValues.set(new TextDecoder().decode(m.payload.subarray(8, 24)).replace(/\0[\s\S]*$/, ''), m.view.getFloat32(0, true)); break;
            case 24: widen(window.lat, m.view.getInt32(8, true)); widen(window.lon, m.view.getInt32(12, true)); window.fixMin = Math.min(window.fixMin, m.view.getUint8(28)); break;
            case 27: widen(window.gyro, m.view.getInt16(14, true)); widen(window.xmag, m.view.getInt16(20, true)); widen(window.ymag, m.view.getInt16(22, true)); widen(window.zmag, m.view.getInt16(24, true)); break;
            case 193: window.ekfFlagsAtEnd = m.view.getUint16(20, true); break;
            case 253: { const line = new TextDecoder().decode(m.payload.subarray(1, 51)).replace(/\0[\s\S]*$/, ''); text.push(line); window.statusText.push(line); break; }
            default: break;
          }
        });
        const client = new SitlBridgeClient(stateBuffer, actuatorBuffer, { bridgeEpoch: Array.isArray(runs) ? runs.length : 0, motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1),
          motorMapId: derived.manifest.modelId, sessionEpoch: 1, speedup: SPEEDUP, wind: session.wind, delivery: session.delivery },
        { pump: () => { session.pump(); session.drain(result => results.push(result)); }, flush: () => undefined,
          post: (message: SitlNotice) => { if (message.type === 'sitl.mavlink') parser.push(message.bytes); },
          send: bytes => { if (socket.readyState === WebSocket.OPEN) socket.send(bytes.slice()); }, close: reason => socket.close(1000, reason.slice(0, 120)), nowMs: () => performance.now() });
        session.attachDelivery(true);
        const gcs = new GroundStation(), packet = new Uint8Array(64);
        const send = (n: number) => { if (n > 0) client.sendMavlink(packet.slice(0, n)); };
        const plan = PLANS[step.name];
        const nextTick = () => ({ lo: tickToNumber(client.link.state.tickId) + 2, hi: 0 });
        const apply = (enabled: boolean) => {
          if (plan) {
            for (const { name, on } of plan) send(gcs.paramSetInto(name, enabled ? on : earlier.get(name) ?? 0, REAL32, packet));
          } else handle({ protocolVersion: 3, type: 'effect.set', atTick: nextTick(), control: step.control?.(enabled) ?? plain(step.name, enabled), recovery: 'hold-offset' });
          if (enabled && step.push === 'wind') handle({ protocolVersion: 3, type: 'effect.set', atTick: nextTick(), control: northWind, recovery: 'hold-offset' });
          if (enabled && step.push === 'turn') send(gcs.commandInto(CONDITION_YAW, [90, 30, 1, 1, 0, 0, 0], packet));
        };
        // What each fault parameter held before: its first reading, asked for on the way up.
        const earlier = new Map<string, number>();
        let during: Measured | null = null, parametersOn: Record<string, number | null> = {}, accident: number | null = null;
        type Stage = 'warmup' | 'guided' | 'arm' | 'takeoff' | 'settle' | 'on' | 'recover' | 'done';
        let stage: Stage = 'warmup', stageAtS = 0, lastCommandS = -10, lastHeartbeatS = -10, lastRcS = -10;
        const finished = new Promise<void>((resolve, reject) => {
          const wall = setTimeout(() => reject(new Error(`${step.name}: the flight did not finish; stage ${stage}, at ${simTimeS} s: ${text.slice(-5).join(' | ')}`)), 150_000);
          const end = () => { stage = 'done'; clearTimeout(wall); resolve(); };
          socket.on('error', reject);
          socket.on('close', () => { if (stage !== 'done') { clearTimeout(wall); reject(new Error(`${step.name}: the bridge closed at ${stage}`)); } });
          socket.on('open', () => client.opened());
          socket.on('message', (data: Buffer) => {
            if (stage === 'done') return;
            const event = client.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            if (event !== 'step') return;
            const s = client.link.state;
            simTimeS = s.simTimeS;
            // An accident pauses the session on its tick, and the autopilot waits: this flight's answer is in.
            if (!session.running) { accident = simTimeS; end(); return; }
            widen(window.truthNorth, s.northM); widen(window.truthDown, s.downM);
            widen(window.truthYaw, Math.atan2(2 * (s.qw * s.qz + s.qx * s.qy), 1 - 2 * (s.qy * s.qy + s.qz * s.qz)));
            if (simTimeS - lastHeartbeatS >= 1) {
              for (const [id, us] of STREAMS) send(gcs.messageIntervalInto(id, us, packet));
              send(gcs.heartbeatInto(packet));
              lastHeartbeatS = simTimeS;
            }
            if (stage === 'warmup' && simTimeS > 180) { clearTimeout(wall); reject(new Error('No READY after 180 s')); return; }
            const retry = simTimeS - lastCommandS >= 2;
            const next = (to: Stage) => { stage = to; stageAtS = simTimeS; };
            switch (stage) {
              case 'warmup': if (client.ready) { for (const { name } of plan ?? []) send(gcs.paramRequestReadInto(name, packet)); next('guided'); } break;
              case 'guided': if (mode === CopterMode.Guided) next('arm'); else if (retry) { send(gcs.setModeInto(CopterMode.Guided, packet)); lastCommandS = simTimeS; } break;
              case 'arm': if (armed) { send(gcs.takeoffInto(TAKEOFF_M, packet)); lastCommandS = simTimeS; next('takeoff'); } else if (retry) { send(gcs.armInto(true, packet)); lastCommandS = simTimeS; } break;
              case 'takeoff':
                if (Math.abs(-s.downM - TAKEOFF_M) < 0.5 && Math.abs(s.vdMps) < 0.3) next('settle');
                else if (!armed && simTimeS - stageAtS > 5) { clearTimeout(wall); reject(new Error(`${step.name}: disarmed during takeoff: ${text.slice(-5).join(' | ')}`)); }
                break;
              case 'settle':
                if (simTimeS - stageAtS >= 3) {
                  for (const { name } of plan ?? []) { const value = paramValues.get(name); if (value !== undefined) earlier.set(name, value); paramValues.delete(name); }
                  window = measured(); apply(true); next('on');
                }
                break;
              case 'on':
                // A pilot's stick commands, which only the pilot and link effects stop.
                if (simTimeS - lastRcS >= 0.1) { send(gcs.rcOverrideInto(Uint16Array.of(1500, 1500, 1500, 1500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), packet)); lastRcS = simTimeS; }
                if (simTimeS - stageAtS >= ON_S) {
                  during = window; during.modeAtEnd = mode; during.armedAtEnd = armed;
                  parametersOn = Object.fromEntries((plan ?? []).map(({ name }) => [name, paramValues.get(name) ?? null]));
                  window = measured(); apply(false); next('recover');
                }
                break;
              case 'recover':
                if (simTimeS - stageAtS >= RECOVER_S) { window.modeAtEnd = mode; window.armedAtEnd = armed; end(); }
                break;
              default: { const never: never = stage; throw new Error(`Unhandled stage ${String(never)}`); }
            }
          });
        });
        await finished;
        expect(results.filter(result => result.type === 'reject-v2')).toEqual([]);
        return { effect: step.name, parameters: parametersOn, earlier: Object.fromEntries(earlier), accidentAtS: accident, during: during === null ? summary(window) : summary(during), after: during === null ? null : summary(window),
          droppedFromAutopilot: client.droppedFromAutopilot, droppedToAutopilot: client.droppedToAutopilot };
      } finally {
        ws?.close();
        if (experimentId) await api('POST', `/v1/experiments/${experimentId}/stop`);
        session.dispose();
      }
    };
    try {
      const rows: Awaited<ReturnType<typeof flight>>[] = [];
      for (const step of STEPS) rows.push(await flight(step));
      mkdirSync(join(ROOT, 'test-results/validation'), { recursive: true });
      writeFileSync(join(ROOT, 'test-results/validation/task-168-faults.json'), `${JSON.stringify({ task: 'TASK-168', firmware: { id: firmware.id, commit: firmware.commit }, manifestSha256: derived.sha256, hz: HZ, speedup: SPEEDUP, healthBits: SYS_STATUS_HEALTH, rows }, null, 2)}\n`);
      const by = (effect: EffectId) => { const row = rows.find(item => item.effect === effect); if (!row) throw new Error(`No row for ${effect}`); return row; };
      expect(rows.map(row => row.effect)).toEqual(STEPS.map(step => step.name));
      // A link that went quiet: nothing from the autopilot while lost, and it talks again after.
      expect(by('link.gcs').during.framesFromAutopilot).toBeLessThan(5);
      expect(by('link.gcs').after?.framesFromAutopilot).toBeGreaterThan(50);
      expect(by('link.gcs').droppedFromAutopilot).toBeGreaterThan(50);
      expect(by('link.gcs').droppedToAutopilot).toBeGreaterThan(50);
      expect(by('link.pilot').droppedToAutopilot).toBeGreaterThan(50);
      expect(by('link.pilot').during.framesFromAutopilot).toBeGreaterThan(50);
      // Each parameter fault read back as written.
      for (const effect of ['sensor.baro.frozen', 'sensor.baro.missing', 'sensor.mag.missing', 'sensor.gnss.missing'] as const) {
        for (const { name, on } of ARDUPILOT_FAULT_PARAMETERS[effect]) expect(by(effect).parameters[name], `${effect} ${name}`).toBe(on);
      }
      // The fix goes while missing; the reading stands still while frozen, though the aircraft moved or turned.
      expect(by('sensor.gnss.missing').during.fixMin).toBeLessThan(3);
      expect(by('sensor.gnss.frozen').during.truthNorthSpanM).toBeGreaterThan(0.5);
      expect([by('sensor.gnss.frozen').during.latSpan, by('sensor.gnss.frozen').during.lonSpan]).toEqual([0, 0]);
      expect(by('sensor.mag.frozen').during.truthYawSpanRad).toBeGreaterThan(0.3);
      expect(by('sensor.mag.frozen').during.magSpanMilliGauss).toEqual([0, 0, 0]);
      expect(by('sensor.imu.frozen').during.gyroSpan).toBe(0);
      // What is missing, ArduPilot reports unhealthy or stops reading.
      expect(by('sensor.baro.missing').during.healthLost & SYS_STATUS_HEALTH.baro).toBe(SYS_STATUS_HEALTH.baro);
      expect(by('sensor.mag.missing').during.healthLost & SYS_STATUS_HEALTH.mag).toBe(SYS_STATUS_HEALTH.mag);
      expect(by('sensor.mag.missing').during.magSpanMilliGauss).toEqual([0, 0, 0]);
    } finally {
      await launcher.close();
    }
  }, 1_200_000);
});
