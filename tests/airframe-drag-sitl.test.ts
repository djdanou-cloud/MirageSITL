import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { prepareContact } from './contact-support.ts';
import { WebSocket } from 'ws';
import { frameConfiguration } from '@mirage/aircraft/frame-parameters';
import { GroundStation, CopterMode } from '@mirage/autopilot/ground-station';
import { LiveEkfWarmup } from '@mirage/autopilot/live-warmup';
import { SitlJsonLink } from '@mirage/autopilot/sitl-link';
import { columnText, readDataFlash, type DataFlashGroup } from '@mirage/dataflash/reader';
import { MavParser, type MavFrame } from '@mirage/mavlink/codec';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newHeaderSnapshotV2, tickToNumber, type CommandResultV2 } from '@mirage/protocol';
import { ensureToken, startLauncher } from '../apps/launcher/src/server.ts';
import { readCatalog } from '../apps/launcher/src/catalog.ts';
import { quadProfile } from './support/quad-profile.ts';

// TASK-096 increment 3 (G4 on the reference Mac): the installed native ArduCopter flies the S19 quad X profile, now with
// the standard hull's preliminary airframe drag, in a steady north wind (weather.set, TASK-093). It holds position in
// GUIDED at 4 and 8 m/s of wind with EKF3 drag fusion off; the steady tilt there, against the body drag alone, is the
// trimmed lean angle that decision F-02 shows and does not judge, and its rotor share calibrates EK3_DRAG_MCOEF as
// ArduPilot's own SITL calibration does. Then EK3_DRAG_BCOEF_X/Y = m/(C_D·A) from the manifest and that MCOEF are set in
// flight, and the EKF must learn the wind from drag. Declared before the run: over the last 10 s of a 60 s fusion its
// XKF2 wind is within 1.0 m/s of the true wind along it, while without fusion (the negative control) it stays within
// 0.5 m/s of zero. The cross-wind estimate is recorded, not asserted. EKF3 predicts each body axis's drag from that axis's
// airspeed alone (½·ρ·u²/BCOEF and MCOEF·u), as ArduPilot's built-in SITL multicopter computes it (SIM_Frame.cpp), so its
// own SITL never shows a mismatch; drag along the relative wind, the contract's and a bluff body's, with the BET rotors' side
// forces, leaves a persistent sideways innovation that EKF3 absorbs into heading and cross-wind. With ArduPilot's default
// simulated gyro drift (SIM_DRIFT_SPEED 0.05°/s per minute) the heading then turns about 0.045°/s and the cross-wind estimate
// reaches −2.07 m/s after 175 s; without it the heading settles about 2° off and the cross-wind estimate about 0.5 m/s off.

const ROOT = process.cwd();
const HOME = join(ROOT, '.cache/task-152/home');
const ORIGIN = 'http://127.0.0.1:5173';
const HZ = 800, SPEEDUP = 4, TAKEOFF_M = 10, SETTLE_S = 15, AVERAGE_S = 10, FUSION_S = 60, GRAVITY = 9.80665;
const WINDS_MPS = [4, 8] as const;
const STREAMS = [[193, 100000], [24, 100000], [33, 100000]] as const;
/** MAV_PARAM_TYPE_REAL32. */
const REAL32 = 9;
const installed = existsSync(join(HOME, 'install-manifest.json'));

/** One numeric column of a DataFlash group, scaled to its unit (TimeUS to seconds). */
function column(group: DataFlashGroup, name: string): number[] {
  const c = group.columns.find(item => item.name === name);
  if (!c) throw new Error(`${group.name} has no column ${name}`);
  return Array.from({ length: group.count }, (_, row) => Number(c.values[row]) * c.valueScale);
}

describe.skipIf(!installed)('EKF3 drag fusion and the trimmed lean angle with airframe drag (TASK-096)', () => {
  test('holds position in a north wind, shows its lean against the body drag, and learns the wind from drag', async () => {
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
    const module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
    await prepareContact();
    const { profile, derived } = await quadProfile();
    const drag = derived.manifest.airframe.drag, massKg = derived.manifest.massProperties.massKg;
    if (!drag) throw new Error('The derived manifest has no airframe drag');
    const frame = frameConfiguration(profile);
    if (!frame.ok) throw new Error('The quad X profile has no ArduPilot frame');
    const baseline = readFileSync(join(ROOT, 'tests/fixtures/sitl/parameters.parm'), 'utf8').split('\n').filter(line => /^[A-Z]/.test(line))
      .map(line => { const [name, value] = line.trim().split(/\s+/); return { name: name ?? '', value: Number(value) }; });
    const parameters = [...baseline, ...frame.parameters, { name: 'MOT_PWM_MIN', value: 1000 }, { name: 'MOT_PWM_MAX', value: 2000 },
      { name: 'EK3_DRAG_BCOEF_X', value: 0 }, { name: 'EK3_DRAG_BCOEF_Y', value: 0 }, { name: 'EK3_DRAG_MCOEF', value: 0 }];

    const registry = new VehicleRegistry();
    await registry.register(derived.bytes, derived.sha256);
    const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator');
    const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
      { monotonicMs: () => performance.now(), wallMs: () => performance.timeOrigin + performance.now() }, undefined, null,
      profileModelPort(registry, () => module));
    const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2();
    const results: CommandResultV2[] = [];
    let requestId = 0;
    const handle = (type: string, extra: Record<string, unknown> = {}) => {
      reader.readHeader(header);
      session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
      session.drain(result => results.push(result));
      return results.at(-1);
    };
    const command = async (type: string, extra: Record<string, unknown> = {}) => {
      handle(type, extra);
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
    const url = (path: string) => `http://127.0.0.1:${launcher.port}${path}`;
    const headers = { authorization: `Bearer ${token}`, origin: ORIGIN };
    const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(url(path), { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
      // As the physics Worker wires it: the weather's wind goes to SITL as velocity_wind.
      const link = new SitlJsonLink(stateBuffer, actuatorBuffer, {
        bridgeEpoch: epoch, motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1), motorMapId: derived.manifest.modelId,
        wind: session.wind });
      const warmup = new LiveEkfWarmup('external-sitl', 1, 0, 0, SPEEDUP, { imuSource: 'json-lockstep' });
      const gcs = new GroundStation(), packet = new Uint8Array(64), record = new Uint8Array(128);
      const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}`, ['mirage-v1', `session.${token}`], { origin: ORIGIN });
      ws = socket;
      const send = (n: number) => { if (n > 0) socket.send(record.subarray(0, link.mavlinkRecordInto(packet.subarray(0, n), record))); };

      let armed = false, mode = -1;
      const acks: { command: number; result: number }[] = [], text: string[] = [];
      const gcsParser = new MavParser((m: MavFrame) => {
        if (m.systemId !== 1 || m.componentId !== 1) return;
        if (m.id === 0) { mode = m.view.getUint32(0, true); armed = (m.view.getUint8(6) & 128) !== 0; }
        if (m.id === 77) acks.push({ command: m.view.getUint16(0, true), result: m.view.getUint8(2) });
        if (m.id === 253) text.push(new TextDecoder().decode(m.payload.subarray(1, 51)).replace(/\0.*$/s, ''));
      });

      // The steady hold in each wind: tilt of the body z axis from down, and the air's velocity past the body (−v_a) in body axes.
      interface Hold { windMps: number; samples: number; tiltRad: number; airspeedMps: number; bodyAirMps: number[]; startS: number; endS: number }
      const holds: Hold[] = [];
      let sums = { n: 0, tilt: 0, airspeed: 0, x: 0, y: 0, z: 0 };
      type Stage = 'warmup' | 'guided' | 'arm' | 'takeoff' | 'wind' | 'fusion' | 'land' | 'landed';
      let stage: Stage = 'warmup', stageAtS = 0, lastCommandS = -10, lastHeartbeatS = -10, simTimeS = 0, windIndex = 0, windAtS = 0;
      let fusionAtS = -1, mcoef = 0;
      // Truth in 5 s means while the wind blows: body-axis specific force and air past the body, attitude, pack voltage, position.
      const TRACE_KEYS = ['fx', 'fy', 'ax', 'ay', 'az', 'rollDeg', 'pitchDeg', 'yawDeg', 'voltage', 'north', 'east'] as const;
      type TraceKey = typeof TRACE_KEYS[number];
      const truthTrace: ({ fromS: number } & Record<TraceKey, number>)[] = [];
      let traceFromS = -1, traceN = 0, traceSums = new Map<TraceKey, number>();
      const traceStep = (values: Record<TraceKey, number>) => {
        if (traceFromS < 0 || simTimeS - traceFromS >= 5) {
          if (traceN > 0) truthTrace.push({ fromS: traceFromS, ...Object.fromEntries(TRACE_KEYS.map(key => [key, (traceSums.get(key) ?? 0) / traceN])) as Record<TraceKey, number> });
          traceFromS = simTimeS; traceN = 0; traceSums = new Map();
        }
        traceN++;
        for (const key of TRACE_KEYS) traceSums.set(key, (traceSums.get(key) ?? 0) + values[key]);
      };
      const coefficients = { bcoefX: massKg / drag.dragAreaBodyM2[0]!, bcoefY: massKg / drag.dragAreaBodyM2[4]! };
      const mavlink = new Uint8Array(4096), wallStart = performance.now();
      const startWind = (speedMps: number) => {
        reader.readHeader(header);
        const tick = tickToNumber(link.state.tickId) + 10;
        expect(handle('weather.set', { atTick: { lo: tick, hi: 0 }, windNedMps: [-speedMps, 0, 0], temperatureK: 288.15, pressurePa: 101325,
          turbulenceRmsMps: 0, seed: 0 })).toMatchObject({ status: 'queued' });
        windAtS = simTimeS; sums = { n: 0, tilt: 0, airspeed: 0, x: 0, y: 0, z: 0 };
      };
      const finished = new Promise<void>((resolve, reject) => {
        const wall = setTimeout(() => reject(new Error(`Timed out in stage ${stage} at ${simTimeS} s: ${text.slice(-5).join(' | ')}`)), 900000);
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
          session.drain(result => results.push(result));
          const n = link.poll();
          if (n === 0) { clearTimeout(wall); reject(new Error(`No state for the stepped tick: ${session.fault}`)); return; }
          socket.send(link.outbound.slice(0, n));
          const s = link.state;
          simTimeS = s.simTimeS;
          const ready = warmup.observe(simTimeS, performance.now());
          const altitudeM = -s.downM;
          if (simTimeS - lastHeartbeatS >= 1) {
            const accepted = acks.filter(a => a.command === 511 && a.result === 0).length;
            if (accepted < STREAMS.length) for (const [id, us] of STREAMS) send(gcs.messageIntervalInto(id, us, packet));
            send(gcs.heartbeatInto(packet));
            lastHeartbeatS = simTimeS;
          }
          if (stage === 'warmup' && simTimeS > 180) { clearTimeout(wall); reject(new Error('No READY after 180 s')); return; }
          const retry = simTimeS - lastCommandS >= 2;
          const next = (to: Stage) => { stage = to; stageAtS = simTimeS; };
          switch (stage) {
            case 'warmup': if (ready) next('guided'); break;
            case 'guided': if (mode === CopterMode.Guided) next('arm'); else if (retry) { send(gcs.setModeInto(CopterMode.Guided, packet)); lastCommandS = simTimeS; } break;
            case 'arm': if (armed) { send(gcs.takeoffInto(TAKEOFF_M, packet)); lastCommandS = simTimeS; next('takeoff'); }
              else if (retry) { send(gcs.armInto(true, packet)); lastCommandS = simTimeS; } break;
            case 'takeoff':
              if (Math.abs(altitudeM - TAKEOFF_M) < 0.5 && Math.abs(s.vdMps) < 0.3) { startWind(WINDS_MPS[0]); next('wind'); }
              else if (!armed && simTimeS - stageAtS > 5) { clearTimeout(wall); reject(new Error(`Disarmed during takeoff: ${text.slice(-5).join(' | ')}`)); }
              break;
            case 'wind':
            case 'fusion': {
              const elapsed = simTimeS - windAtS, settled = elapsed >= SETTLE_S;
              // Tilt of body z from down: R33 = 1 − 2(qx² + qy²). The air past the body: R^T·(w − v), w = (−speed, 0, 0).
              const w = -WINDS_MPS[Math.min(windIndex, WINDS_MPS.length - 1)]!, ax = w - s.vnMps, ay = -s.veMps, az = -s.vdMps;
              const { qw, qx, qy, qz } = s;
              const bx = (1 - 2 * (qy * qy + qz * qz)) * ax + 2 * (qx * qy + qw * qz) * ay + 2 * (qx * qz - qw * qy) * az;
              const by = 2 * (qx * qy - qw * qz) * ax + (1 - 2 * (qx * qx + qz * qz)) * ay + 2 * (qy * qz + qw * qx) * az;
              const bz = 2 * (qx * qz + qw * qy) * ax + 2 * (qy * qz - qw * qx) * ay + (1 - 2 * (qx * qx + qy * qy)) * az;
              const degrees = 180 / Math.PI;
              traceStep({ fx: s.specificForceXBodyMps2, fy: s.specificForceYBodyMps2, ax: bx, ay: by, az: bz,
                rollDeg: Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy)) * degrees,
                pitchDeg: Math.asin(Math.max(-1, Math.min(1, 2 * (qw * qy - qz * qx)))) * degrees,
                yawDeg: Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)) * degrees,
                voltage: s.batteryVoltage, north: s.northM, east: s.eastM });
              if (stage === 'wind' && settled) {
                sums.n++; sums.tilt += Math.acos(Math.min(1, 1 - 2 * (qx * qx + qy * qy))); sums.airspeed += Math.hypot(ax, ay, az);
                sums.x += bx; sums.y += by; sums.z += bz;
              }
              if (stage === 'wind' && elapsed >= SETTLE_S + AVERAGE_S) {
                holds.push({ windMps: WINDS_MPS[windIndex]!, samples: sums.n, tiltRad: sums.tilt / sums.n, airspeedMps: sums.airspeed / sums.n,
                  bodyAirMps: [sums.x / sums.n, sums.y / sums.n, sums.z / sums.n], startS: windAtS + SETTLE_S, endS: simTimeS });
                if (++windIndex < WINDS_MPS.length) { startWind(WINDS_MPS[windIndex]!); break; }
                // Calibration: the steady thrust tilt carries all the drag, g·tanθ; the rest after the body's ½ρV²·C_xx/m is the
                // rotors', which EKF3 models as MCOEF·V·(ρ/ρ0); a least-squares fit through the origin over both winds.
                const rho = 1.225 * (1 - 0.0065 * TAKEOFF_M / 288.15) ** 4.2559, ratio = rho / 1.225;
                let num = 0, den = 0;
                for (const hold of holds) {
                  const v = hold.airspeedMps, rotor = GRAVITY * Math.tan(hold.tiltRad) - 0.5 * rho * v * v * drag.dragAreaBodyM2[0]! / massKg;
                  num += rotor * v * ratio; den += (v * ratio) ** 2;
                }
                mcoef = num / den;
                for (const [name, value] of [['EK3_DRAG_BCOEF_X', coefficients.bcoefX], ['EK3_DRAG_BCOEF_Y', coefficients.bcoefY],
                  ['EK3_DRAG_MCOEF', mcoef]] as const) send(gcs.paramSetInto(name, value, REAL32, packet));
                fusionAtS = simTimeS; next('fusion');
              }
              if (stage === 'fusion' && simTimeS - fusionAtS >= FUSION_S) { send(gcs.setModeInto(CopterMode.Land, packet)); lastCommandS = simTimeS; next('land'); }
              if (!armed) { clearTimeout(wall); reject(new Error(`Disarmed in the wind: ${text.slice(-5).join(' | ')}`)); }
              break;
            }
            case 'land':
              if (!armed && altitudeM < 0.5 && Math.abs(s.vdMps) < 0.05) { next('landed'); clearTimeout(wall); resolve(); }
              else if (mode !== CopterMode.Land && retry) { send(gcs.setModeInto(CopterMode.Land, packet)); lastCommandS = simTimeS; }
              break;
            case 'landed': break;
            default: { const never: never = stage; throw new Error(`Unhandled stage ${String(never)}`); }
          }
        });
      });
      await finished;

      // The flight's DataFlash log: the EKF's wind (XKF2, core 0) and the parameter changes (PARM).
      const logs = await api('GET', `/v1/experiments/${experimentId}/logs`);
      const files = get(logs, 'dataflash');
      const names = Array.isArray(files) ? files.map(file => String(get(file, 'name'))) : [];
      const newest = names.at(-1);
      if (!newest) throw new Error('The flight left no DataFlash log');
      const log = readDataFlash(new Uint8Array(await (await fetch(url(`/v1/experiments/${experimentId}/dataflash/${newest}`), { headers })).arrayBuffer()));
      const group = (name: string) => { const g = log.groups.find(item => item.name === name); if (!g) throw new Error(`No ${name} records`); return g; };
      const xkf2 = group('XKF2'), parm = group('PARM');
      const timeS = column(xkf2, 'TimeUS'), core = column(xkf2, 'C'), vwn = column(xkf2, 'VWN'), vwe = column(xkf2, 'VWE');
      const parmTimeS = column(parm, 'TimeUS'), parmValue = column(parm, 'Value'), nameColumn = parm.columns.find(c => c.name === 'Name');
      if (!nameColumn) throw new Error('PARM has no Name');
      const dragRows = Array.from({ length: parm.count }, (_, row) => row).filter(row => columnText(nameColumn, row).startsWith('EK3_DRAG'))
        .map(row => ({ name: columnText(nameColumn, row), timeS: parmTimeS[row]!, value: parmValue[row]! }));
      const setRow = Array.from({ length: parm.count }, (_, row) => row)
        .filter(row => columnText(nameColumn, row) === 'EK3_DRAG_BCOEF_X' && parmValue[row]! > 1).at(-1);
      if (setRow === undefined) throw new Error(`The log does not record the in-flight EK3_DRAG_BCOEF_X: ${JSON.stringify(dragRows)}`);
      const fusionStartS = parmTimeS[setRow]!;
      const mean = (from: number, to: number) => {
        const rows = timeS.map((t, i) => i).filter(i => core[i] === 0 && timeS[i]! >= from && timeS[i]! < to);
        return { rows: rows.length, north: rows.reduce((sum, i) => sum + vwn[i]!, 0) / rows.length, east: rows.reduce((sum, i) => sum + vwe[i]!, 0) / rows.length };
      };
      const learned = mean(fusionStartS + FUSION_S - 10, fusionStartS + FUSION_S);
      const control = mean(fusionStartS - AVERAGE_S, fusionStartS);
      // How the EKF's wind evolves after the coefficients are set: 5 s means.
      const trace = Array.from({ length: FUSION_S / 5 }, (_, k) => ({ fromS: 5 * k, ...mean(fusionStartS + 5 * k, fusionStartS + 5 * k + 5) }));

      const rho = 1.225 * (1 - 0.0065 * TAKEOFF_M / 288.15) ** 4.2559;
      // The open finding: the true heading's change over the fusion hold and the cross-wind estimate's.
      const atFusion = truthTrace.filter(row => row.fromS >= fusionAtS), headingChangeDeg = (atFusion.at(-1)?.yawDeg ?? NaN) - (atFusion[0]?.yawDeg ?? NaN);
      const lean = holds.map(hold => {
        const bodyOnly = Math.atan(0.5 * rho * hold.airspeedMps ** 2 * drag.dragAreaBodyM2[0]! / (massKg * GRAVITY));
        return { windMps: hold.windMps, airspeedMps: hold.airspeedMps, leanDeg: hold.tiltRad * 180 / Math.PI, bodyDragOnlyLeanDeg: bodyOnly * 180 / Math.PI,
          bodyAirMps: hold.bodyAirMps, samples: hold.samples };
      });
      mkdirSync(join(ROOT, 'test-results/validation'), { recursive: true });
      writeFileSync(join(ROOT, 'test-results/validation/task-096-drag-sitl.json'), JSON.stringify({ task: 'TASK-096',
        firmware: { id: firmware.id, commit: firmware.commit }, manifestSha256: derived.sha256, hz: HZ, speedup: SPEEDUP, massKg,
        dragAreaBodyM2: drag.dragAreaBodyM2, lean, ek3: { ...coefficients, mcoef }, truthTrace, fusion: { startS: fusionStartS, seconds: FUSION_S, learned, control, trace, headingChangeDeg, parameters: dragRows,
          trueWindNedMps: [-WINDS_MPS[1], 0] }, wallS: (performance.now() - wallStart) / 1000, lockstep: link.lockstepStats, acks, text }, null, 2) + '\n');

      expect(link.lockstepStats.duplicates + link.lockstepStats.gaps).toBe(0);
      expect(session.fault).toBe('');
      expect(results.filter(r => r.type === 'ack-v2' && r.status === 'applied').length).toBeGreaterThanOrEqual(3 + WINDS_MPS.length);
      // The lean is shown, not judged (F-02): it only has to hold the station, leaning into the wind more than the body alone needs.
      for (const row of lean) { expect(row.airspeedMps).toBeGreaterThan(0.8 * row.windMps); expect(row.leanDeg).toBeGreaterThan(row.bodyDragOnlyLeanDeg); }
      expect(mcoef).toBeGreaterThan(0);
      // The declared tolerances: without fusion no wind is estimated; with it, the EKF learns the true wind from drag.
      expect(control.rows).toBeGreaterThan(10);
      expect(Math.hypot(control.north, control.east)).toBeLessThan(0.5);
      expect(learned.rows).toBeGreaterThan(10);
      expect(Math.abs(learned.north - -WINDS_MPS[1])).toBeLessThan(1);
    } finally {
      ws?.close();
      if (experimentId) await api('POST', `/v1/experiments/${experimentId}/stop`);
      await launcher.close();
      session.dispose();
    }
  }, 900000);
});
