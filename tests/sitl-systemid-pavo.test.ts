import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { frameConfiguration } from '@mirage/aircraft/frame-parameters';
import { GroundStation, CopterMode } from '@mirage/autopilot/ground-station';
import { LiveEkfWarmup } from '@mirage/autopilot/live-warmup';
import { SitlJsonLink } from '@mirage/autopilot/sitl-link';
import { MavParser, type MavFrame } from '@mirage/mavlink/codec';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newHeaderSnapshotV2, type CommandResultV2 } from '@mirage/protocol';
import { columnText, readDataFlash, type DataFlashLog } from '../packages/dataflash/src/reader.ts';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { ensureToken, startLauncher } from '../apps/launcher/src/server.ts';
import { readCatalog } from '../apps/launcher/src/catalog.ts';
import { buildPavo } from './support/pavo.ts';

// TASK-090, SystemId flights of the Pavo20 Pro II (SPECS_SIMULATION_ENGINES "Fidelity evidence pipeline", "SystemId flights of the
// Pavo20 Pro II"), declared before the simulated flight. Native ArduCopter V4.7.2 flies the Pavo profile in JSON lockstep at 800 Hz:
// a GUIDED take-off to 5 m and 5 s of hover, then Stabilize under RC override with a pilot model holding 5 m, then SYSTEMID with the
// real log's SID_* and attitude controller, until "SystemID Finished", then LAND. Its DataFlash log and the real one go through
// scripts/fidelity-capture.mjs and scripts/check-fidelity.mjs over the sweeps. The SITL log is simulated data, never a flight.
// Opt-in: MIRAGE_SITL_HOME is an installation home (catalog.json with the V4.7.2 firmware, token, venv), used read-only;
// MIRAGE_FORUM_LOG_DIR holds the inventory's logs; MIRAGE_SYSTEMID_LOG picks the real log (default 34); MIRAGE_SYSTEMID_OUT is the
// directory for the simulated log, the capture and the report.
const ROOT = process.cwd();
const INSTALL = process.env.MIRAGE_SITL_HOME ?? '';
const LOG_DIR = process.env.MIRAGE_FORUM_LOG_DIR ?? '';
const LOG_NUMBER = process.env.MIRAGE_SYSTEMID_LOG ?? '34';
const LOG_FILE = `stakeholder-pavo-log_${LOG_NUMBER}_UnknownDate.bin`;
const OUT = process.env.MIRAGE_SYSTEMID_OUT ?? '';
const ORIGIN = 'http://127.0.0.1:5173';
const FIRMWARE_ID = 'arducopter-fb773567';
const HZ = 800, SPEEDUP = 4, TAKEOFF_M = 5, HOVER_S = 5, SETTLE_S = 3;
const STREAMS = [[193, 100000], [24, 100000], [33, 100000]] as const;
const ready = INSTALL !== '' && existsSync(join(INSTALL, 'catalog.json')) && LOG_DIR !== '' && existsSync(join(LOG_DIR, LOG_FILE)) && OUT !== '';

/** The real log's last value of each parameter. */
function parametersOf(log: DataFlashLog): Map<string, number> {
  const group = log.groups.find(item => item.name === 'PARM' && item.count > 0), names = group?.columns.find(c => c.name === 'Name'), values = group?.columns.find(c => c.name === 'Value');
  if (!group || !names || !values) throw new Error('The log has no PARM records');
  const out = new Map<string, number>();
  for (let row = 0; row < group.count; row++) out.set(columnText(names, row), Number(values.values[row]));
  return out;
}
const COPIED = /^(ATC_RAT_(RLL|PIT|YAW)_.+|ATC_ANG_(RLL|PIT|YAW)_P|ATC_INPUT_TC|ATC_RATE_FF_ENAB|ATC_RATE_[RPY]_MAX|ATC_THR_MIX_.+|ATC_ANGLE_BOOST|INS_GYRO_FILTER|INS_ACCEL_FILTER|MOT_THST_EXPO|MOT_SPIN_(ARM|MIN|MAX)|MOT_HOVER_LEARN|MOT_THST_HOVER|MOT_BAT_VOLT_(MAX|MIN)|LOG_BITMASK|SID_.+)$/;
/** The declared parameters of the real log under V4.7.2's names. */
function systemIdParameters(real: Map<string, number>): { name: string; value: number }[] {
  const out: { name: string; value: number }[] = [];
  for (const [name, value] of real) if (COPIED.test(name)) out.push({ name, value });
  for (const [from, to] of [['ATC_ACCEL_R_MAX', 'ATC_ACC_R_MAX'], ['ATC_ACCEL_P_MAX', 'ATC_ACC_P_MAX'], ['ATC_ACCEL_Y_MAX', 'ATC_ACC_Y_MAX'], ['ANGLE_MAX', 'ATC_ANGLE_MAX']] as const) {
    const value = real.get(from);
    if (value === undefined) throw new Error(`The real log has no ${from}`);
    out.push({ name: to, value: value / 100 });
  }
  out.push({ name: 'INS_HNTCH_ENABLE', value: 0 });
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}
/** The sweep of a log: the SIDS record's time and the "SystemID Finished" message after it, s. */
function sweepOf(log: DataFlashLog, which: 'last' | 'first' = 'last'): { fromS: number; toS: number } {
  const sids = log.groups.find(item => item.name === 'SIDS' && item.count > 0), time = sids?.columns.find(c => c.name === 'TimeUS');
  const msg = log.groups.find(item => item.name === 'MSG' && item.count > 0), msgTime = msg?.columns.find(c => c.name === 'TimeUS'), text = msg?.columns.find(c => c.name === 'Message');
  if (!sids || !time || !msg || !msgTime || !text) throw new Error('The log has no SIDS or MSG records');
  const finished: number[] = [];
  for (let row = 0; row < msg.count; row++) if (columnText(text, row).startsWith('SystemID Finished')) finished.push(Number(msgTime.values[row]) * 1e-6);
  const starts = Array.from({ length: sids.count }, (_, row) => Number(time.values[row]) * 1e-6);
  const complete = starts.map(fromS => ({ fromS, toS: finished.find(t => t > fromS && !starts.some(s => s > fromS && s < t)) })).filter((s): s is { fromS: number; toS: number } => s.toS !== undefined);
  const sweep = which === 'last' ? complete.at(-1) : complete[0];
  if (!sweep) throw new Error('The log has no complete sweep');
  return sweep;
}
function newestDataflash(home: string): string {
  const found: { path: string; mtime: number }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.bin$/i.test(entry.name)) found.push({ path, mtime: statSync(path).mtimeMs });
    }
  };
  walk(join(home, 'experiments'));
  const newest = found.sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) throw new Error('The run wrote no DataFlash log');
  return newest.path;
}

describe.skipIf(!ready)('the Pavo\'s SystemId flight in native SITL against its real log (TASK-090)', () => {
  test('flies the logged sweep and reports the comparison', async () => {
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
    const module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
    const inventory = JSON.parse(readFileSync(join(ROOT, 'data/flight-logs/inventory.json'), 'utf8')) as { logs: { file: string; sha256: string }[] };
    const realBytes = readFileSync(join(LOG_DIR, LOG_FILE)), realSha256 = createHash('sha256').update(realBytes).digest('hex');
    expect(realSha256).toBe(inventory.logs.find(item => item.file === LOG_FILE)?.sha256);
    const realLog = readDataFlash(new Uint8Array(realBytes.buffer, realBytes.byteOffset, realBytes.byteLength));
    const logged = systemIdParameters(parametersOf(realLog));
    const { profile, derived } = await buildPavo();
    const frame = frameConfiguration(profile);
    if (!frame.ok) throw new Error('The Pavo profile has no ArduPilot frame');
    const baseline = readFileSync(join(ROOT, 'tests/fixtures/sitl/parameters.parm'), 'utf8').split('\n').filter(line => /^[A-Z]/.test(line))
      .map(line => { const [name, value] = line.trim().split(/\s+/); return { name: name ?? '', value: Number(value) }; });
    const parameters = [...baseline, ...frame.parameters, { name: 'MOT_PWM_MIN', value: 1000 }, { name: 'MOT_PWM_MAX', value: 2000 }, ...logged];

    const home = mkdtempSync(join(tmpdir(), 'mirage-pavo-systemid-'));
    copyFileSync(join(INSTALL, 'token'), join(home, 'token'));
    chmodSync(join(home, 'token'), 0o600);
    copyFileSync(join(INSTALL, 'catalog.json'), join(home, 'catalog.json'));
    const registry = new VehicleRegistry();
    await registry.register(derived.bytes, derived.sha256);
    const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator');
    const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
      { monotonicMs: () => performance.now(), wallMs: () => performance.timeOrigin + performance.now() }, undefined, null,
      profileModelPort(registry, () => module, { syntheticPad: true }));
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

    const token = ensureToken(home);
    const firmware = readCatalog(home).find(item => item.id === FIRMWARE_ID);
    if (!firmware) throw new Error(`The installation has no ${FIRMWARE_ID}`);
    const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(INSTALL, 'venv/bin/python') });
    const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`http://127.0.0.1:${launcher.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return response.json();
    };
    const get = (value: unknown, ...keys: (string | number)[]): unknown =>
      keys.reduce<unknown>((at, key) => (typeof at === 'object' && at !== null ? Reflect.get(at, key) : undefined), value);
    let ws: WebSocket | null = null;
    let experimentId = '';
    const summary: Record<string, unknown> = {};
    try {
      const started = await api('POST', '/v1/experiments', { firmwareId: firmware.id, parameters, frameScript: frame.script, speedup: SPEEDUP, rateHz: HZ,
        home: [-35.363261, 149.165230, 584, 0] });
      experimentId = String(get(started, 'id'));
      if (experimentId === 'undefined') throw new Error(`The launcher refused the run: ${JSON.stringify(started)}`);
      const bridgePort = Number(get(started, 'ports', 'bridge')), runs = get(started, 'runs');
      const epoch = Array.isArray(runs) ? runs.length : 0;
      const link = new SitlJsonLink(stateBuffer, actuatorBuffer, {
        bridgeEpoch: epoch, motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1), motorMapId: derived.manifest.modelId });
      const warmup = new LiveEkfWarmup('external-sitl', 1, 0, 0, SPEEDUP, { imuSource: 'json-lockstep' });
      const gcs = new GroundStation(), packet = new Uint8Array(64), record = new Uint8Array(128), sticks = new Uint16Array(18).fill(65535);
      const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}`, ['mirage-v1', `session.${token}`], { origin: ORIGIN });
      ws = socket;
      const send = (n: number) => { if (n > 0) socket.send(record.subarray(0, link.mavlinkRecordInto(packet.subarray(0, n), record))); };
      let armed = false, mode = -1;
      const acks: { command: number; result: number }[] = [], text: { atS: number; text: string }[] = [];
      let simTimeS = 0;
      const gcsParser = new MavParser((m: MavFrame) => {
        if (m.systemId !== 1 || m.componentId !== 1) return;
        if (m.id === 0) { mode = m.view.getUint32(0, true); armed = (m.view.getUint8(6) & 128) !== 0; }
        if (m.id === 77) acks.push({ command: m.view.getUint16(0, true), result: m.view.getUint8(2) });
        if (m.id === 253) text.push({ atS: simTimeS, text: new TextDecoder().decode(m.payload.subarray(1, 51)).replace(/\0.*$/s, '') });
      });
      type Stage = 'warmup' | 'guided' | 'arm' | 'takeoff' | 'hover' | 'stabilize' | 'settle' | 'systemid' | 'sweep' | 'land' | 'landed';
      let stage: Stage = 'warmup', stageAtS = 0, lastCommandS = -10, lastHeartbeatS = -10, lastSticksS = -10, sweepStartS = -1, sweepEndS = -1;
      let minSweepM = Infinity, maxSweepM = -Infinity;
      const mavlink = new Uint8Array(4096), wallStart = performance.now();
      const finished = new Promise<void>((resolve, reject) => {
        const wall = setTimeout(() => reject(new Error(`Timed out in stage ${stage} at ${simTimeS} s: ${JSON.stringify(text.slice(-6))}`)), 1_500_000);
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
          const truth = link.state;
          simTimeS = truth.simTimeS;
          const isReady = warmup.observe(simTimeS, performance.now());
          const altitudeM = -truth.downM;
          if (simTimeS - lastHeartbeatS >= 1) {
            const accepted = acks.filter(a => a.command === 511 && a.result === 0).length;
            if (accepted < STREAMS.length) for (const [id, us] of STREAMS) send(gcs.messageIntervalInto(id, us, packet));
            send(gcs.heartbeatInto(packet));
            lastHeartbeatS = simTimeS;
          }
          // The pilot model from the hover on: sticks centred, throttle holding 5 m, at 25 Hz.
          if (stage === 'hover' || stage === 'stabilize' || stage === 'settle' || stage === 'systemid' || stage === 'sweep') {
            if (simTimeS - lastSticksS >= 0.04) {
              const throttle = 1500 + Math.max(-150, Math.min(150, 30 * (TAKEOFF_M - altitudeM) + 40 * truth.vdMps));
              sticks[0] = 1500; sticks[1] = 1500; sticks[2] = Math.round(throttle); sticks[3] = 1500;
              send(gcs.rcOverrideInto(sticks, packet));
              lastSticksS = simTimeS;
            }
          }
          if (stage === 'warmup' && simTimeS > 180) { clearTimeout(wall); reject(new Error('No READY after 180 s')); return; }
          if (stage !== 'warmup' && stage !== 'guided' && stage !== 'arm' && stage !== 'land' && stage !== 'landed' && !armed && simTimeS - stageAtS > 2) {
            clearTimeout(wall); reject(new Error(`Disarmed in stage ${stage} at ${simTimeS} s: ${JSON.stringify(text.slice(-6))}`)); return;
          }
          const retry = simTimeS - lastCommandS >= 2;
          const next = (to: Stage) => { stage = to; stageAtS = simTimeS; };
          switch (stage) {
            case 'warmup': if (isReady) next('guided'); break;
            case 'guided': if (mode === CopterMode.Guided) next('arm'); else if (retry) { send(gcs.setModeInto(CopterMode.Guided, packet)); lastCommandS = simTimeS; } break;
            case 'arm': if (armed) { send(gcs.takeoffInto(TAKEOFF_M, packet)); lastCommandS = simTimeS; next('takeoff'); }
              else if (retry) { send(gcs.armInto(true, packet)); lastCommandS = simTimeS; } break;
            case 'takeoff': if (Math.abs(altitudeM - TAKEOFF_M) < 0.3 && Math.abs(truth.vdMps) < 0.2) next('hover'); break;
            case 'hover': if (simTimeS - stageAtS >= HOVER_S) next('stabilize'); break;
            case 'stabilize': if (mode === CopterMode.Stabilize) next('settle'); else if (retry) { send(gcs.setModeInto(CopterMode.Stabilize, packet)); lastCommandS = simTimeS; } break;
            case 'settle': if (simTimeS - stageAtS >= SETTLE_S) next('systemid'); break;
            case 'systemid':
              if (mode === 25) { sweepStartS = simTimeS; next('sweep'); }
              else if (retry) { send(gcs.setModeInto(25, packet)); lastCommandS = simTimeS; }
              break;
            case 'sweep':
              minSweepM = Math.min(minSweepM, altitudeM); maxSweepM = Math.max(maxSweepM, altitudeM);
              if (text.some(item => item.atS >= sweepStartS && item.text.startsWith('SystemID Finished'))) { sweepEndS = simTimeS; send(gcs.setModeInto(CopterMode.Land, packet)); lastCommandS = simTimeS; next('land'); }
              else if (simTimeS - stageAtS > 120) { clearTimeout(wall); reject(new Error('The sweep did not finish in 120 s')); }
              break;
            case 'land':
              if (!armed) { next('landed'); clearTimeout(wall); resolve(); }
              else if (mode !== CopterMode.Land && retry) { send(gcs.setModeInto(CopterMode.Land, packet)); lastCommandS = simTimeS; }
              else if (simTimeS - stageAtS > 60) { next('landed'); clearTimeout(wall); resolve(); }
              break;
            case 'landed': break;
            default: { const never: never = stage; throw new Error(`Unhandled stage ${String(never)}`); }
          }
        });
      });
      await finished;
      Object.assign(summary, { sweepStartS, sweepEndS, minSweepM, maxSweepM, wallS: (performance.now() - wallStart) / 1000, lockstep: link.lockstepStats, text });
      expect(sweepEndS).toBeGreaterThan(sweepStartS);
      expect(session.fault).toBe('');
    } finally {
      ws?.close();
      if (experimentId) await api('POST', `/v1/experiments/${experimentId}/stop`);
      await launcher.close();
      session.dispose();
    }
    // The comparison over both sweeps, with the declared scripts; the SITL log is simulated data.
    mkdirSync(OUT, { recursive: true });
    const simulatedPath = join(OUT, `pavo-sitl-systemid-log${LOG_NUMBER}.bin`);
    copyFileSync(newestDataflash(home), simulatedPath);
    rmSync(home, { recursive: true, force: true });
    const simulatedBytes = readFileSync(simulatedPath);
    const real = sweepOf(realLog), simulated = sweepOf(readDataFlash(new Uint8Array(simulatedBytes.buffer, simulatedBytes.byteOffset, simulatedBytes.byteLength)));
    const capturePath = join(OUT, `pavo-systemid-log${LOG_NUMBER}-capture.json`);
    const capture = spawnSync(process.execPath, ['scripts/fidelity-capture.mjs', '--real', join(LOG_DIR, LOG_FILE), '--simulated', simulatedPath,
      '--firmware-sha256', firmware.binarySha256, '--model-sha256', derived.sha256, '--operator', 'stakeholder (real flight); MirageSITL (SITL run)',
      '--recorded-at', '2026-11-08T00:00:00Z', '--out', capturePath, '--from', String(real.fromS), '--to', String(real.toS),
      '--simulated-offset', String(simulated.fromS - real.fromS)], { encoding: 'utf8' });
    expect(capture.status, capture.stderr).toBe(0);
    const captureSha256 = createHash('sha256').update(readFileSync(capturePath)).digest('hex');
    // The validator always writes test-results/validation/fidelity.json, which is ignored and untracked; a copy goes to OUT.
    const check = spawnSync(process.execPath, ['scripts/check-fidelity.mjs', '--input', capturePath, '--sha256', captureSha256], { encoding: 'utf8' });
    copyFileSync(join(ROOT, 'test-results/validation/fidelity.json'), join(OUT, `pavo-systemid-log${LOG_NUMBER}-fidelity.json`));
    writeFileSync(join(OUT, `pavo-systemid-log${LOG_NUMBER}-run.json`), `${JSON.stringify({ realFile: LOG_FILE, realSha256, simulatedSha256: createHash('sha256').update(simulatedBytes).digest('hex'),
      firmware: { id: firmware.id, commit: firmware.commit, binarySha256: firmware.binarySha256 }, manifestSha256: derived.sha256, hz: HZ, speedup: SPEEDUP,
      realSweep: real, simulatedSweep: simulated, parameters: logged, captureSha256, captureStdout: capture.stdout, checkStatus: check.status, checkStdout: check.stdout, ...summary }, null, 2)}\n`);
    expect(check.status, check.stdout + check.stderr).toBe(0);
  }, 1_800_000);
});
