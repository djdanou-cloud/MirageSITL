import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { frameConfiguration } from '@mirage/aircraft/frame-parameters';
import { siteParameters } from '@mirage/aircraft/site-parameters';
import { GroundStation } from '@mirage/autopilot/ground-station';
import { autopilotModeName, taskCommandInto } from '@mirage/autopilot/guided';
import { LiveEkfWarmup } from '@mirage/autopilot/live-warmup';
import { MissionUpload, routeMissionItems, routePointReached } from '@mirage/autopilot/mission';
import { SitlJsonLink } from '@mirage/autopilot/sitl-link';
import { MavParser, type MavFrame } from '@mirage/mavlink/codec';
import { profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newHeaderSnapshotV2, type CommandResultV2 } from '@mirage/protocol';
import {
  FlightTaskRunner, GUIDANCE_PARAMETERS, guidanceLimitsOf, parseFlightTask, wrapDeg, type FlightTaskDefinition, type FlightTaskStep,
} from '@mirage/scenarios/flight-tasks';
import { attitudeManeuverRefusal, eulerDegOf } from '@mirage/scenarios/maneuvers';
import { PhysicsSessionV2 } from '../../packages/physics/src/session-v2.ts';
import { ensureToken, startLauncher } from '../../apps/launcher/src/server.ts';
import { readCatalog } from '../../apps/launcher/src/catalog.ts';
import { prepareContact } from '../contact-support.ts';
import { exampleCard } from '../support/quad-profile.ts';
import { validateComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';

const ROOT = process.cwd();
const HOME = join(ROOT, '.cache/task-152/home');
const ORIGIN = 'http://127.0.0.1:5173';
const HZ = 800, SPEEDUP = 4;
const SESSION_HOME = [-35.363261, 149.16523, 584, 0] as const;
/** The Run tab observes on the session's status: every 80 physics steps (apps/web/src/sitl/bridge-client.ts). */
const OBSERVE_EVERY_STEPS = 80;
/** EKF status, GPS and position, and ATTITUDE: ArduPilot's own estimate of the attitude it is holding, kept beside the truth. */
const STREAMS = [[193, 100000], [24, 100000], [33, 100000], [30, 50000], [1, 200000]] as const;
const installed = existsSync(join(HOME, 'install-manifest.json'));

const GROUND = { northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 1 };
/** The Logging tab's default common rate: the truth a recording would hold, from which the metrics are computed. */
const TRUTH_EVERY_STEPS = HZ / 50;
interface TruthRow { t: number; rollDeg: number; pitchDeg: number; yawDeg: number; altitudeM: number }
interface EstimateRow { t: number; rollDeg: number; pitchDeg: number; yawDeg: number }

interface Row { t: number; stage: string; measured: boolean; taskT: number | null; requested: FlightTaskStep['requested']; actual: FlightTaskStep['actual'] }
interface Flight { steps: FlightTaskStep[]; rows: Row[]; truth: TruthRow[]; estimate: EstimateRow[]; text: string[]; simTimeS: number; wallS: number;
  /** The highest pack current and lowest bus voltage of any physics step. */ pack: { maxCurrentA: number; minVoltageV: number }; lockstep: { duplicates: number; gaps: number };
  low: LowReport[]; reportedVoltages: { t: number; voltageV: number; currentA: number }[]; doneAtS: number | null }
interface LowReport { t: number; stage: string; line: string; truthVoltageV: number; truthCurrentA: number; altitudeM: number }


// TASK-104 check 9 (SPECS_SIMULATION_ENGINES "Battery v2", declared before the implementation): native ArduCopter V4.7.2 through the
// TASK-152 home and the TASK-172 Node harness, on the S19 quad X with a battery v2 pack, in two flights from the same start. BATT_LOW_VOLT
// sits between the pack's loaded voltage in a 5 m/s climb and its resting voltage there, BATT_FS_LOW_ACT 0 only warns, and
// BATT_LOW_TIMER 2 s lets a 7 s climb trigger it (the default 10 s would outlast the climb). With BATT_FS_VOLTSRC 0 the autopilot
// reports the low battery during the climb; with BATT_FS_VOLTSRC 1, its sag-compensated resting voltage, it does not, and it does once
// the resting voltage falls below the threshold in the long hover after the climb. The check reads the autopilot's own STATUSTEXT.

const START_CHARGE = 0.45;
/** The example 4S pack on battery card schema 2: the chen-2006 curve and two RC branches, 2 Ah so the hover drains it in minutes. */
function dynamicPack() {
  const pack = exampleCard('battery');
  if (pack.type !== 'battery') throw new Error('Not a battery card');
  return validateComponentCard({ ...pack, schemaVersion: 2,
    values: { ...pack.values, capacityAh: 2, openCircuitCurve: 'chen-2006', rcFastResistanceOhm: 0.02, rcFastCapacitanceF: 250, rcSlowResistanceOhm: 0.02,
      rcSlowCapacitanceF: 3000, resistanceActivationK: null, heatCapacityJPerK: null, stillAirConductanceWPerK: null, airflowConductanceWPerK: null,
      entropicCoefficientVPerK: null, capacityRetention: null, resistanceGrowth: null },
    provenance: { ...pack.provenance, capacityAh: 'example', openCircuitCurve: 'example', rcFastResistanceOhm: 'example', rcFastCapacitanceF: 'example',
      rcSlowResistanceOhm: 'example', rcSlowCapacitanceF: 'example', resistanceActivationK: null, heatCapacityJPerK: null, stillAirConductanceWPerK: null,
      airflowConductanceWPerK: null, entropicCoefficientVPerK: null, capacityRetention: null, resistanceGrowth: null } });
}
async function dynamicQuad() {
  const [motor, propeller, esc, battery] = ['11', '22', '33', '55'].map(h => h.repeat(32)) as [string, string, string, string];
  const fixture = validateAircraftProfile(JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/aircraft/quad-x.json'), 'utf8')));
  const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: battery },
    motors: fixture.motors.map(item => ({ ...item, components: { motor, propeller, esc } })) }), [{ card: propeller, polar: 'naca6409-neuralfoil-v1' }]);
  const resolved = resolveComponents(profile, new Map([[motor, exampleCard('motor')], [propeller, exampleCard('propeller')], [esc, exampleCard('esc')], [battery, dynamicPack()]]));
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  return { profile, derived: await deriveVehicleManifest(profile, resolved.components, { modelId: 104 }) };
}

let module: WebAssembly.Module;
let home = '';
const evidence: Record<string, unknown> = {};
beforeAll(async () => {
  if (!installed) return;
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  await prepareContact();
  home = mkdtempSync(join(tmpdir(), 'mirage-battery-failsafe-'));
  copyFileSync(join(HOME, 'catalog.json'), join(home, 'catalog.json'));
}, 600000);
afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  if (Object.keys(evidence).length > 0) {
    // Ignored output; the roadmap records its numbers.
    mkdirSync(join(ROOT, 'test-results/browser'), { recursive: true });
    writeFileSync(join(ROOT, 'test-results/browser/task-104-battery-failsafe.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  }
});

/** Starts SITL, waits for READY and flies the task from there. */
async function fly(task: FlightTaskDefinition, extra: { name: string; value: number }[], holdS: number, stopOnLow: boolean): Promise<Flight> {
  const { profile, derived } = await dynamicQuad();
  const frame = frameConfiguration(profile);
  if (!frame.ok) throw new Error('The quad X profile has no ArduPilot frame');
  const baseline = readFileSync(join(ROOT, 'tests/fixtures/sitl/parameters.parm'), 'utf8').split('\n').filter(line => /^[A-Z]/.test(line))
    .map(line => { const [name, value] = line.trim().split(/\s+/); return { name: name ?? '', value: Number(value) }; });
  const parameters = [...baseline, ...frame.parameters, { name: 'MOT_PWM_MIN', value: 1000 }, { name: 'MOT_PWM_MAX', value: 2000 }, { name: 'INS_GYRO_FILTER', value: 40 }, ...siteParameters(SESSION_HOME), ...extra];
  const registry = new VehicleRegistry();
  await registry.register(derived.bytes, derived.sha256);
  const stateBuffer = createSharedMemoryV2(), actuatorBuffer = createSpscQueue('actuator');
  const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'), actuatorBuffer },
    { monotonicMs: () => performance.now(), wallMs: () => performance.timeOrigin + performance.now() }, undefined, null,
    profileModelPort(registry, () => module, {}, () => null, () => ({ initialGround: task.initial.ground, initialStateOfCharge: task.initial.ground.stateOfCharge })));
  const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), results: CommandResultV2[] = [];
  let requestId = 0;
  for (const [type, extra] of [['sim.configure', { hz: HZ, clockMode: 'sitl-lockstep' }], ['model.load', { modelId: derived.manifest.modelId, manifestSha256: derived.sha256 }], ['sim.start', {}]] as const) {
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
    const response = await fetch(`http://127.0.0.1:${launcher.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.json();
  };
  const get = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((at, key) => (typeof at === 'object' && at !== null ? Reflect.get(at, key) : undefined), value);
  let socket: WebSocket | null = null, experimentId = '';
  try {
    const started = await api('POST', '/v1/experiments', { firmwareId: firmware.id, parameters, frameScript: null, speedup: SPEEDUP, rateHz: HZ, home: [...SESSION_HOME] });
    experimentId = String(get(started, 'id'));
    const link = new SitlJsonLink(stateBuffer, actuatorBuffer, { bridgeEpoch: 1, motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1), motorMapId: derived.manifest.modelId });
    const warmup = new LiveEkfWarmup('external-sitl', 1, 0, 0, SPEEDUP, { imuSource: 'json-lockstep' });
    const gcs = new GroundStation(), packet = new Uint8Array(280), record = new Uint8Array(320);
    const ws = new WebSocket(`ws://127.0.0.1:${String(get(started, 'ports', 'bridge'))}`, ['mirage-v1', `session.${token}`], { origin: ORIGIN });
    socket = ws;
    const send = (n: number) => { if (n > 0) ws.send(record.subarray(0, link.mavlinkRecordInto(packet.subarray(0, n), record))); };
    const text: string[] = [], acks: { command: number; result: number }[] = [];
    let armed = false, mode: number | null = null, routePoint = -1, simTimeS = 0, lastBeatS = -10, stepsSinceObserve = 0, lastRowS = -10, ready = false;
    let upload: MissionUpload | null = null, runner: FlightTaskRunner | null = null;
    const steps: FlightTaskStep[] = [], rows: Row[] = [], truthRows: TruthRow[] = [], wallStart = performance.now(), reported = new Map<string, number>(), wanted = [...GUIDANCE_PARAMETERS, 'GUID_OPTIONS'];
    const estimateRows: EstimateRow[] = [];
    const pack = { maxCurrentA: 0, minVoltageV: Number.POSITIVE_INFINITY };
    const low: LowReport[] = [], reportedVoltages: { t: number; voltageV: number; currentA: number }[] = [];
    let doneAtS: number | null = null, stage = 'warmup';
    let stepsSinceTruth = 0;
    const lastTruth = { voltageV: 0, currentA: 0, altitudeM: 0 };
    const parser = new MavParser((m: MavFrame) => {
      if (m.systemId !== 1 || m.componentId !== 1) return;
      if (m.id === 0) { mode = m.view.getUint32(0, true); armed = (m.view.getUint8(6) & 128) !== 0; }
      if (m.id === 77) acks.push({ command: m.view.getUint16(0, true), result: m.view.getUint8(2) });
      // ATTITUDE: roll, pitch and yaw in radians at 4, 8 and 12.
      if (m.id === 30) estimateRows.push({ t: simTimeS, rollDeg: m.view.getFloat32(4, true) * 180 / Math.PI, pitchDeg: m.view.getFloat32(8, true) * 180 / Math.PI, yawDeg: m.view.getFloat32(12, true) * 180 / Math.PI });
      if (m.id === 253) {
        const line = new TextDecoder().decode(m.payload.subarray(1, 51)).replace(/\0.*$/s, '');
        text.push(line);
        // The autopilot's own report (AP_BattMonitor::check_failsafes): "Battery 1 is low 14.80V used 123 mAh".
        if (/^Battery 1 is low/.test(line)) low.push({ t: simTimeS, stage, line, truthVoltageV: lastTruth.voltageV, truthCurrentA: lastTruth.currentA, altitudeM: lastTruth.altitudeM });
      }
      // SYS_STATUS: voltage_battery u16 mV at 14, current_battery i16 cA at 16.
      if (m.id === 1) reportedVoltages.push({ t: simTimeS, voltageV: m.view.getUint16(14, true) / 1000, currentA: m.view.getInt16(16, true) / 100 });
      // PARAM_VALUE: a float at 0, and its name at 8.
      if (m.id === 22) reported.set(new TextDecoder().decode(m.payload.subarray(8, 24)).replace(/\0.*$/s, ''), m.view.getFloat32(0, true));
      upload?.frame(m, simTimeS);
      const reached = routePointReached(m);
      if (reached !== null) routePoint = Math.max(routePoint, reached);
    });
    const mavlink = new Uint8Array(4096);
    await new Promise<void>((resolve, reject) => {
      const wall = setTimeout(() => reject(new Error(`Timed out in ${steps.at(-1)?.stage ?? 'warmup'} at ${simTimeS.toFixed(1)} s: ${text.slice(-6).join(' | ')}`)), 900000);
      ws.on('close', (code, reason) => { if (steps.at(-1)?.progress.state !== 'done') reject(new Error(`Bridge closed ${code} ${reason.toString()}`)); });
      ws.on('message', (data: Buffer) => {
        const event = link.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        if (event === 'mavlink') {
          mavlink.set(link.inbound.subarray(link.mavlinkOffset, link.mavlinkOffset + link.mavlinkLength));
          const chunk = mavlink.subarray(0, link.mavlinkLength);
          warmup.ingest(chunk, simTimeS);
          parser.push(chunk);
          return;
        }
        if (event === 'resend') { ws.send(link.outbound.slice(0, 16 + new DataView(link.outbound.buffer).getUint32(12, true))); return; }
        if (event !== 'step') return;
        warmup.acknowledgeJsonImu(link.lockstep.lastFrameCount, link.repliedFrame, link.replyTimeS);
        session.pump();
        const n = link.poll();
        if (n === 0) { clearTimeout(wall); reject(new Error(`No state for the stepped tick: ${session.fault}`)); return; }
        ws.send(link.outbound.slice(0, n));
        const truth = link.state;
        simTimeS = truth.simTimeS;
        pack.maxCurrentA = Math.max(pack.maxCurrentA, truth.batteryCurrentA);
        lastTruth.voltageV = truth.batteryVoltage; lastTruth.currentA = truth.batteryCurrentA; lastTruth.altitudeM = -truth.downM;
        if (truth.batteryVoltage > 0) pack.minVoltageV = Math.min(pack.minVoltageV, truth.batteryVoltage);
        ready ||= warmup.observe(simTimeS, performance.now());
        if (++stepsSinceTruth >= TRUTH_EVERY_STEPS) {
          stepsSinceTruth = 0;
          const { rollDeg, pitchDeg, yawDeg } = eulerDegOf(truth.qw, truth.qx, truth.qy, truth.qz);
          truthRows.push({ t: simTimeS, rollDeg, pitchDeg, yawDeg, altitudeM: -truth.downM });
        }
        if (simTimeS - lastBeatS >= 1) {
          if (acks.filter(a => a.command === 511 && a.result === 0).length < STREAMS.length) for (const [id, us] of STREAMS) send(gcs.messageIntervalInto(id, us, packet));
          send(gcs.heartbeatInto(packet));
          lastBeatS = simTimeS;
        }
        if (!ready || ++stepsSinceObserve < OBSERVE_EVERY_STEPS) return;
        stepsSinceObserve = 0;
        // As the Run tab does from its parameter list: the limits are what this autopilot reports.
        if (!runner) {
          for (const name of wanted) if (!reported.has(name)) send(gcs.paramRequestReadInto(name, packet));
          if (wanted.every(name => reported.has(name))) {
            const refusal = attitudeManeuverRefusal(task.type, name => reported.get(name));
            if (refusal !== null) { clearTimeout(wall); reject(new Error(refusal)); return; }
            runner = new FlightTaskRunner(task, guidanceLimitsOf(name => reported.get(name)));
          }
          return;
        }
        upload?.tick(simTimeS);
        const { rollDeg, pitchDeg, yawDeg } = eulerDegOf(truth.qw, truth.qx, truth.qy, truth.qz);
        const step = runner.observe({ simTimeS, northM: truth.northM, eastM: truth.eastM, altitudeM: -truth.downM, northMps: truth.vnMps, eastMps: truth.veMps, downMps: truth.vdMps,
          headingDeg: wrapDeg(yawDeg), rollDeg, pitchDeg, armed, mode: autopilotModeName(mode), mission: upload?.state ?? 'idle', routePointReached: routePoint });
        steps.push(step);
        stage = step.stage;
        // Every observation of the Run tab's cadence; the margin is for rounding in the sum of the physics steps.
        if (simTimeS - lastRowS >= 0.099) {
          lastRowS = simTimeS;
          rows.push({ t: simTimeS, stage: step.stage, measured: step.measured, taskT: step.taskTimeS, requested: step.requested, actual: step.actual });
        }
        for (const command of step.commands) {
          if (command.kind === 'upload-route') {
            upload = new MissionUpload(routeMissionItems(command.points, { latitudeDeg: SESSION_HOME[0], longitudeDeg: SESSION_HOME[1] }, command.groundAltitudeM),
              { sendCount: count => send(gcs.missionCountInto(count, packet)), sendItem: item => send(gcs.missionItemInto(item, packet)) });
            upload.start(simTimeS);
          } else send(taskCommandInto(command, gcs, packet));
        }
        if (step.progress.state === 'failed') { clearTimeout(wall); resolve(); return; }
        // After the task, the vehicle holds in GUIDED: the long hover of check 9, until its time or the first low report.
        if (step.progress.state === 'done') {
          stage = 'hold';
          doneAtS ??= simTimeS;
          if (simTimeS - doneAtS >= holdS || (stopOnLow && low.some(report => report.stage === 'hold'))) { clearTimeout(wall); resolve(); }
        }
      });
    });
    return { steps, rows, truth: truthRows, estimate: estimateRows, text, simTimeS, wallS: (performance.now() - wallStart) / 1000, pack, lockstep: link.lockstepStats, low, reportedVoltages, doneAtS };
  } finally {
    socket?.close();
    if (experimentId) await api('POST', `/v1/experiments/${experimentId}/stop`);
    await launcher.close();
    session.dispose();
  }
}


describe.skipIf(!installed)('the sag-compensated battery failsafe with a battery v2 pack (TASK-104 check 9)', () => {
  test('VOLTSRC 0 warns in the climb; VOLTSRC 1 does not, and warns once the resting voltage falls in the hover', async () => {
    const { derived } = await dynamicQuad();
    const table = derived.manifest.battery?.dynamics?.openCircuitTableV;
    if (!table) throw new Error('The pack has no dynamics');
    const x = START_CHARGE * 20, i = Math.floor(x), resting = table[i]! + (table[i + 1]! - table[i]!) * (x - i);
    // Between the climb's loaded voltage (about 25 A through 0.018 ohm and a charged fast branch, 1 V below) and the resting one.
    const threshold = Math.round((resting - 0.45) * 100) / 100;
    const climb = parseFlightTask({ schemaVersion: 1, type: 'climb', parameters: { fromAltitudeM: 5, toAltitudeM: 40, rateMps: 5 }, route: null,
      initial: { ground: { ...GROUND, stateOfCharge: START_CHARGE }, air: null }, finish: 'hold' });
    const battery = (source: number) => [{ name: 'BATT_LOW_VOLT', value: threshold }, { name: 'BATT_FS_LOW_ACT', value: 0 }, { name: 'BATT_LOW_TIMER', value: 2 },
      { name: 'BATT_FS_VOLTSRC', value: source }, { name: 'BATT_CRT_VOLT', value: 0 }, { name: 'BATT_LOW_MAH', value: 0 }];
    const raw = await fly(climb, battery(0), 5, false);
    const sag = await fly(climb, battery(1), 400, true);
    const summary = (flight: Flight) => ({ simTimeS: flight.simTimeS, wallS: flight.wallS, doneAtS: flight.doneAtS, lockstep: flight.lockstep, pack: flight.pack,
      low: flight.low, lastText: flight.text.slice(-8), minimumReportedV: Math.min(...flight.reportedVoltages.map(r => r.voltageV)) });
    evidence.check9 = { startCharge: START_CHARGE, restingV: resting, thresholdV: threshold, voltsrc0: summary(raw), voltsrc1: summary(sag) };
    console.log(`EVID battery: ${JSON.stringify(evidence.check9)}`.slice(0, 4000));
    expect(raw.steps.at(-1)?.progress, raw.text.slice(-6).join(' | ')).toEqual({ state: 'done' });
    expect(sag.steps.at(-1)?.progress, sag.text.slice(-6).join(' | ')).toEqual({ state: 'done' });
    expect(raw.lockstep.duplicates + raw.lockstep.gaps + sag.lockstep.duplicates + sag.lockstep.gaps).toBe(0);
    // VOLTSRC 0: reported during the climb.
    expect(raw.low.filter(r => r.stage !== 'hold' && r.stage !== 'warmup').length, 'raw voltage warns in the climb').toBeGreaterThan(0);
    // VOLTSRC 1: nothing before the hold, then a report in the hold.
    expect(sag.low.filter(r => r.stage !== 'hold'), 'resting voltage stays quiet in the climb').toEqual([]);
    expect(sag.low.filter(r => r.stage === 'hold').length, 'resting voltage warns in the hover').toBeGreaterThan(0);
  }, 1800000);
});
