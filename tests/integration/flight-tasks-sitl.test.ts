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
  COMPLETION, FLIGHT_TASK_TYPES, FlightTaskRunner, GUIDANCE_PARAMETERS, flightTaskSchemaVersion, guidanceLimitsOf, parseFlightTask, wrapDeg, type FlightTaskDefinition, type FlightTaskStep, type FlightTaskType,
} from '@mirage/scenarios/flight-tasks';
import { MANEUVER_TYPES, attitudeManeuverRefusal, eulerDegOf, isManeuverType, maneuverResponse, maneuverTimeline, unwrapDeg, type EdgeResponse, type ManeuverType, type ResponseSeries } from '@mirage/scenarios/maneuvers';
import { PhysicsSessionV2 } from '../../packages/physics/src/session-v2.ts';
import { ensureToken, startLauncher } from '../../apps/launcher/src/server.ts';
import { readCatalog } from '../../apps/launcher/src/catalog.ts';
import { prepareContact } from '../contact-support.ts';
import { quadProfile } from '../support/quad-profile.ts';

// TASK-172 (G4 on the reference Mac): each task type flown by the installed
// native ArduCopter (TASK-152 home) in the physics session, through the
// launcher's bridge, as the Run tab flies it: observed every 80 physics steps, with
// the limits this autopilot reports and the COMPASS_DEC a run's home gives it. The
// S19 quad X flies with the 40 Hz gyro filter of decision A-13. Requested and actual
// values go to an ignored report, one row per observation. The tolerances are
// operational, as the task's status declares them: they check that ArduPilot flew
// what was asked, and do not judge fidelity (SA-01).

const ROOT = process.cwd();
const HOME = join(ROOT, '.cache/task-152/home');
const ORIGIN = 'http://127.0.0.1:5173';
const HZ = 800, SPEEDUP = 4;
const SESSION_HOME = [-35.363261, 149.16523, 584, 0] as const;
/** The Run tab observes on the session's status: every 80 physics steps (apps/web/src/sitl/bridge-client.ts). */
const OBSERVE_EVERY_STEPS = 80;
/** EKF status, GPS and position, and ATTITUDE: ArduPilot's own estimate of the attitude it is holding, kept beside the truth. */
const STREAMS = [[193, 100000], [24, 100000], [33, 100000], [30, 50000]] as const;
const installed = existsSync(join(HOME, 'install-manifest.json'));

const GROUND = { northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 1 };
const TASKS: Record<FlightTaskType, Pick<FlightTaskDefinition, 'parameters' | 'route'>> = {
  takeoff: { parameters: { altitudeM: 5 }, route: null },
  hover: { parameters: { altitudeM: 5, durationS: 10 }, route: null },
  landing: { parameters: { altitudeM: 5 }, route: null },
  straight: { parameters: { altitudeM: 10, headingDeg: 90, speedMps: 5, distanceM: 50 }, route: null },
  climb: { parameters: { fromAltitudeM: 5, toAltitudeM: 15, rateMps: 2 }, route: null },
  descent: { parameters: { fromAltitudeM: 15, toAltitudeM: 5, rateMps: 1 }, route: null },
  acceleration: { parameters: { altitudeM: 10, headingDeg: 45, fromSpeedMps: 2, toSpeedMps: 8, rateMps2: 1.5 }, route: null },
  braking: { parameters: { altitudeM: 10, headingDeg: 45, fromSpeedMps: 8, toSpeedMps: 0, rateMps2: 2 }, route: null },
  turn: { parameters: { altitudeM: 10, headingDeg: 350, speedMps: 4, angleDeg: 90, rateDegS: 15 }, route: null },
  route: { parameters: {}, route: [{ northM: 20, eastM: 0, altitudeM: 8, speedMps: 4 }, { northM: 20, eastM: 30, altitudeM: 12, speedMps: 6 }, { northM: 0, eastM: 30, altitudeM: 6, speedMps: 3 }] },
  'roll-step': { parameters: { altitudeM: 10, headingDeg: 30, amplitudeDeg: 10, holdS: 2 }, route: null },
  'roll-doublet': { parameters: { altitudeM: 10, headingDeg: 30, amplitudeDeg: 10, holdS: 2 }, route: null },
  'pitch-step': { parameters: { altitudeM: 10, headingDeg: 30, amplitudeDeg: -10, holdS: 2 }, route: null },
  'pitch-doublet': { parameters: { altitudeM: 10, headingDeg: 30, amplitudeDeg: -10, holdS: 2 }, route: null },
  'heading-step': { parameters: { altitudeM: 10, headingDeg: 350, amplitudeDeg: 45, holdS: 6 }, route: null },
  'heading-doublet': { parameters: { altitudeM: 10, headingDeg: 350, amplitudeDeg: 30, holdS: 5 }, route: null },
  'altitude-step': { parameters: { altitudeM: 10, amplitudeM: 3, holdS: 8 }, route: null },
  'altitude-doublet': { parameters: { altitudeM: 10, amplitudeM: 2, holdS: 6 }, route: null },
};
const taskOf = (type: FlightTaskType): FlightTaskDefinition => parseFlightTask({ schemaVersion: flightTaskSchemaVersion(type), type, ...TASKS[type], initial: { ground: GROUND, air: null }, finish: 'land' });
/** The Logging tab's default common rate: the truth a recording would hold, from which the metrics are computed. */
const TRUTH_EVERY_STEPS = HZ / 50;
interface TruthRow { t: number; rollDeg: number; pitchDeg: number; yawDeg: number; altitudeM: number }
interface EstimateRow { t: number; rollDeg: number; pitchDeg: number; yawDeg: number }

interface Row { t: number; stage: string; measured: boolean; taskT: number | null; requested: FlightTaskStep['requested']; actual: FlightTaskStep['actual'] }
interface Flight { steps: FlightTaskStep[]; rows: Row[]; truth: TruthRow[]; estimate: EstimateRow[]; text: string[]; simTimeS: number; wallS: number; lockstep: { duplicates: number; gaps: number } }

let module: WebAssembly.Module;
let home = '';
const evidence: Record<string, unknown> = {}, maneuverEvidence: Record<string, unknown> = {};
beforeAll(async () => {
  if (!installed) return;
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  await prepareContact();
  home = mkdtempSync(join(tmpdir(), 'mirage-flight-tasks-'));
  copyFileSync(join(HOME, 'catalog.json'), join(home, 'catalog.json'));
}, 600000);
afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  if (Object.keys(evidence).length > 0) {
    mkdirSync(join(ROOT, 'test-results/validation'), { recursive: true });
    writeFileSync(join(ROOT, 'test-results/validation/task-172-flights.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  if (Object.keys(maneuverEvidence).length > 0) {
    mkdirSync(join(ROOT, 'test-results/validation'), { recursive: true });
    writeFileSync(join(ROOT, 'test-results/validation/task-173-flights.json'), `${JSON.stringify(maneuverEvidence, null, 2)}\n`);
  }
});

/** Starts SITL, waits for READY and flies the task from there. */
async function fly(task: FlightTaskDefinition): Promise<Flight> {
  const { profile, derived } = await quadProfile();
  const frame = frameConfiguration(profile);
  if (!frame.ok) throw new Error('The quad X profile has no ArduPilot frame');
  const baseline = readFileSync(join(ROOT, 'tests/fixtures/sitl/parameters.parm'), 'utf8').split('\n').filter(line => /^[A-Z]/.test(line))
    .map(line => { const [name, value] = line.trim().split(/\s+/); return { name: name ?? '', value: Number(value) }; });
  const parameters = [...baseline, ...frame.parameters, { name: 'MOT_PWM_MIN', value: 1000 }, { name: 'MOT_PWM_MAX', value: 2000 }, { name: 'INS_GYRO_FILTER', value: 40 }, ...siteParameters(SESSION_HOME)];
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
    let stepsSinceTruth = 0;
    const parser = new MavParser((m: MavFrame) => {
      if (m.systemId !== 1 || m.componentId !== 1) return;
      if (m.id === 0) { mode = m.view.getUint32(0, true); armed = (m.view.getUint8(6) & 128) !== 0; }
      if (m.id === 77) acks.push({ command: m.view.getUint16(0, true), result: m.view.getUint8(2) });
      // ATTITUDE: roll, pitch and yaw in radians at 4, 8 and 12.
      if (m.id === 30) estimateRows.push({ t: simTimeS, rollDeg: m.view.getFloat32(4, true) * 180 / Math.PI, pitchDeg: m.view.getFloat32(8, true) * 180 / Math.PI, yawDeg: m.view.getFloat32(12, true) * 180 / Math.PI });
      if (m.id === 253) text.push(new TextDecoder().decode(m.payload.subarray(1, 51)).replace(/\0.*$/s, ''));
      // PARAM_VALUE: a float at 0, and its name at 8.
      if (m.id === 22) reported.set(new TextDecoder().decode(m.payload.subarray(8, 24)).replace(/\0.*$/s, ''), m.view.getFloat32(0, true));
      upload?.frame(m, simTimeS);
      const reached = routePointReached(m);
      if (reached !== null) routePoint = Math.max(routePoint, reached);
    });
    const mavlink = new Uint8Array(4096);
    await new Promise<void>((resolve, reject) => {
      const wall = setTimeout(() => reject(new Error(`Timed out in ${steps.at(-1)?.stage ?? 'warmup'} at ${simTimeS.toFixed(1)} s: ${text.slice(-6).join(' | ')}`)), 500000);
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
        if (step.progress.state !== 'running') { clearTimeout(wall); resolve(); }
      });
    });
    return { steps, rows, truth: truthRows, estimate: estimateRows, text, simTimeS, wallS: (performance.now() - wallStart) / 1000, lockstep: link.lockstepStats };
  } finally {
    socket?.close();
    if (experimentId) await api('POST', `/v1/experiments/${experimentId}/stop`);
    await launcher.close();
    session.dispose();
  }
}

const measured = (flight: Flight) => flight.rows.filter(row => row.measured);
const OFFSET_GROUND = { northM: 10, eastM: -5, headingDeg: 90, stateOfCharge: 0.8 };
const near = (actual: number | null | undefined, expected: number, tolerance: number, what: string) => expect(Math.abs((actual ?? Number.NaN) - expected), what).toBeLessThanOrEqual(tolerance);
const summary = (flight: Flight) => ({ simTimeS: flight.simTimeS, wallS: flight.wallS, lockstep: flight.lockstep, arrival: flight.steps.at(-1)?.arrival ?? null, rows: flight.rows, text: flight.text });
/** The worst difference between actual and requested over the measured rows, skipping the first `settleS` of the task's clock. */
function worst(flight: Flight, key: 'altitudeM' | 'speedMps' | 'headingDeg', settleS = 0): number {
  const errors = measured(flight).filter(row => (row.taskT ?? 0) >= settleS && row.requested[key] !== null && row.actual[key] !== null).map(row => {
    const difference = Math.abs((row.actual[key] ?? 0) - (row.requested[key] ?? 0));
    return key === 'headingDeg' ? Math.min(difference, 360 - difference) : difference;
  });
  return errors.length > 0 ? Math.max(...errors) : Number.NaN;
}

describe.skipIf(!installed)('each flight task with native ArduCopter (TASK-172)', () => {
  test.each(FLIGHT_TASK_TYPES.filter(type => !isManeuverType(type)))('%s completes with requested and actual traces', async type => {
    const flight = await fly(taskOf(type));
    evidence[type] = summary(flight);
    const last = flight.steps.at(-1);
    expect(last?.progress, flight.text.slice(-6).join(' | ')).toEqual({ state: 'done' });
    expect(flight.lockstep.duplicates + flight.lockstep.gaps).toBe(0);
    // A measured trace with both sides, and it landed: the last actual altitude is back at the rest height it armed from.
    expect(measured(flight).length, 'measured rows').toBeGreaterThan(type === 'landing' ? 10 : 5);
    expect(last?.arrival, 'arrival').not.toBeNull();
    near(last?.actual.altitudeM, flight.steps[0]?.actual.altitudeM ?? 0, 0.05, 'landed height');
    console.log(`EVID ${type}: ${JSON.stringify({ sim: flight.simTimeS, altitude: worst(flight, 'altitudeM'), speed: worst(flight, 'speedMps'), heading: worst(flight, 'headingDeg'), arrival: last?.arrival?.actual })}`);
    switch (type) {
      case 'takeoff': near(measured(flight).at(-1)?.actual.altitudeM, 5, COMPLETION.altitudeM, 'climbed to'); break;
      case 'hover':
        expect(measured(flight).at(-1)?.taskT ?? 0).toBeGreaterThanOrEqual(9.8);
        expect(worst(flight, 'altitudeM'), 'hover height').toBeLessThanOrEqual(0.5);
        break;
      case 'landing': near(measured(flight)[0]?.actual.altitudeM, 5, 0.5, 'started from'); break;
      case 'straight': {
        const rows = measured(flight), first = rows[0], final = rows.at(-1);
        near((final?.actual.eastM ?? 0) - (first?.actual.eastM ?? 0), 50, 3, 'distance east');
        near((final?.actual.northM ?? 0) - (first?.actual.northM ?? 0), 0, 1, 'stays on its line');
        expect(worst(flight, 'speedMps'), 'speed').toBeLessThanOrEqual(1);
        // A run without COMPASS_DEC at boot learned a false gyro error, and this reached 2°.
        expect(worst(flight, 'headingDeg'), 'heading').toBeLessThanOrEqual(1);
        expect(worst(flight, 'altitudeM'), 'height').toBeLessThanOrEqual(1);
        break;
      }
      // A target with sharp corners flew these 2.38 m and 0.74 m from what was asked, and 2.28 m past the end (TASK-172 status).
      case 'climb':
        near(measured(flight).at(-1)?.actual.altitudeM, 15, COMPLETION.altitudeM, 'climbed to');
        expect(worst(flight, 'altitudeM'), 'height').toBeLessThanOrEqual(COMPLETION.altitudeM);
        expect(Math.max(...measured(flight).map(row => row.actual.altitudeM ?? 0)), 'highest').toBeLessThanOrEqual(15 + COMPLETION.altitudeM);
        break;
      case 'descent':
        near(measured(flight).at(-1)?.actual.altitudeM, 5, COMPLETION.altitudeM, 'descended to');
        expect(worst(flight, 'altitudeM'), 'height').toBeLessThanOrEqual(COMPLETION.altitudeM);
        expect(Math.min(...measured(flight).map(row => row.actual.altitudeM ?? 0)), 'lowest').toBeGreaterThanOrEqual(5 - COMPLETION.altitudeM);
        break;
      case 'acceleration':
        near(measured(flight).at(-1)?.actual.speedMps, 8, COMPLETION.speedMps, 'reached speed');
        expect(worst(flight, 'speedMps'), 'speed').toBeLessThanOrEqual(1);
        break;
      case 'braking':
        near(measured(flight).at(-1)?.actual.speedMps, 0, COMPLETION.speedMps, 'stopped');
        expect(worst(flight, 'speedMps'), 'speed').toBeLessThanOrEqual(1);
        break;
      case 'turn': {
        const final = measured(flight).at(-1);
        expect(Math.min(Math.abs((final?.actual.headingDeg ?? 0) - 80), 360 - Math.abs((final?.actual.headingDeg ?? 0) - 80)), 'turned to').toBeLessThanOrEqual(15);
        near(final?.actual.speedMps, 4, 1, 'kept speed');
        break;
      }
      case 'route': {
        const points = taskOf('route').route ?? [], rows = measured(flight);
        for (const [i, point] of points.entries()) {
          const closest = Math.min(...rows.map(row => Math.hypot((row.actual.northM ?? 0) - point.northM, (row.actual.eastM ?? 0) - point.eastM, (row.actual.altitudeM ?? 0) - point.altitudeM)));
          expect(closest, `distance to point ${i + 1}`).toBeLessThanOrEqual(3);
        }
        break;
      }
      default: { const never: never = type; throw new Error(String(never)); }
    }
  }, 600000);

  // ArduCopter's WP_SPD_UP is 2.5 m/s and WP_SPD_DN 1.5 m/s, but those limit only how fast it corrects: it follows a target that moves faster.
  // Reaching 5 m/s at 1 m/s² takes 5.2 s and 13 m, each way, so these go 35 m.
  test.each([['climb', 5, 40], ['descent', 40, 5]] as const)('a %s at 5 m/s, the largest rate a task may ask, stays on its path', async (type, fromAltitudeM, toAltitudeM) => {
    const flight = await fly(parseFlightTask({ schemaVersion: 1, type, parameters: { fromAltitudeM, toAltitudeM, rateMps: 5 }, route: null, initial: { ground: GROUND, air: null }, finish: 'land' }));
    evidence[`${type}-5`] = summary(flight);
    expect(flight.steps.at(-1)?.progress, flight.text.slice(-6).join(' | ')).toEqual({ state: 'done' });
    expect(worst(flight, 'altitudeM'), 'height').toBeLessThanOrEqual(COMPLETION.altitudeM);
    expect(Math.max(...measured(flight).map(row => row.requested.verticalSpeedMps ?? 0).map(Math.abs)), 'the rate is reached').toBe(5);
    console.log(`EVID ${type}-5: ${JSON.stringify({ sim: flight.simTimeS, altitude: worst(flight, 'altitudeM') })}`);
  }, 600000);

  // An airborne start is a lead-in: the task's clock starts on arrival, with requested against actual there, and the stop is flown before the hold.
  test('a hover from an airborne start, its arrival shown as requested against actual', async () => {
    const air = { altitudeM: 8, headingDeg: 45, speedMps: 3 };
    const task = parseFlightTask({ schemaVersion: 1, type: 'hover', parameters: { altitudeM: 8, durationS: 5 }, route: null, initial: { ground: GROUND, air }, finish: 'land' });
    const flight = await fly(task);
    evidence['hover-airborne'] = summary(flight);
    const last = flight.steps.at(-1);
    expect(last?.progress, flight.text.slice(-6).join(' | ')).toEqual({ state: 'done' });
    // The first measured tick is the clock's start: everything before it is the lead-in.
    const arrival = last?.arrival;
    expect(arrival).not.toBeNull();
    near(arrival?.actual.altitudeM, 8, COMPLETION.altitudeM, 'arrived at height');
    near(arrival?.actual.speedMps, 3, COMPLETION.speedMps, 'arrived at speed');
    near(arrival?.actual.headingDeg, 45, COMPLETION.headingDeg, 'arrived on heading');
    expect(arrival?.requested).toMatchObject({ altitudeM: 8, speedMps: 3, headingDeg: 45 });
    expect(flight.steps.findIndex(step => step.measured)).toBeGreaterThan(0);
    console.log(`EVID hover-airborne: ${JSON.stringify({ sim: flight.simTimeS, arrival })}`);
  }, 600000);

  // The ground values are in truth at the start tick, ArduPilot's frame starts where the vehicle stands, and targets and waypoints still mean the pad's frame.
  test('a straight flight from another place, heading and charge', async () => {
    const task = parseFlightTask({ schemaVersion: 1, type: 'straight', ...TASKS.straight, initial: { ground: OFFSET_GROUND, air: null }, finish: 'land' });
    const flight = await fly(task);
    evidence['straight-offset'] = summary(flight);
    expect(flight.steps.at(-1)?.progress, flight.text.slice(-6).join(' | ')).toEqual({ state: 'done' });
    const first = flight.steps[0]?.actual;
    near(first?.northM, 10, 0.01, 'stands north');
    near(first?.eastM, -5, 0.01, 'stands east');
    near(first?.headingDeg, 90, 0.5, 'faces');
    const rows = measured(flight);
    near(rows[0]?.actual.northM, 10, 1.5, 'lead-in climbed where it stood');
    near((rows.at(-1)?.actual.eastM ?? 0) - (rows[0]?.actual.eastM ?? 0), 50, 3, 'distance east');
    expect(worst(flight, 'speedMps'), 'speed').toBeLessThanOrEqual(1);
    expect(worst(flight, 'headingDeg'), 'heading').toBeLessThanOrEqual(5);
    console.log(`EVID straight-offset: ${JSON.stringify({ sim: flight.simTimeS, first, speed: worst(flight, 'speedMps'), heading: worst(flight, 'headingDeg') })}`);
  }, 600000);
  test('a route from another place reaches the same points in the pad\'s frame', async () => {
    const task = parseFlightTask({ schemaVersion: 1, type: 'route', ...TASKS.route, initial: { ground: OFFSET_GROUND, air: null }, finish: 'land' });
    const flight = await fly(task);
    evidence['route-offset'] = summary(flight);
    expect(flight.steps.at(-1)?.progress, flight.text.slice(-6).join(' | ')).toEqual({ state: 'done' });
    near(flight.steps[0]?.actual.northM, 10, 0.01, 'stands north');
    const rows = measured(flight);
    for (const [i, point] of (task.route ?? []).entries()) {
      const closest = Math.min(...rows.map(row => Math.hypot((row.actual.northM ?? 0) - point.northM, (row.actual.eastM ?? 0) - point.eastM, (row.actual.altitudeM ?? 0) - point.altitudeM)));
      console.log(`EVID route-offset point ${i + 1}: ${closest.toFixed(2)} m`);
      expect(closest, `distance to point ${i + 1}`).toBeLessThanOrEqual(3);
    }
  }, 600000);
});

/** The response of a flown maneuver, as the Experiments tab computes it: the requests of the maneuver's rows against the truth at the recording's rate. */
function responseOf(flight: Flight, type: ManeuverType): { requested: ResponseSeries; actual: ResponseSeries; edges: EdgeResponse[] } {
  const { axis } = MANEUVER_TYPES[type], rows = flight.rows.filter(row => row.stage === 'maneuver');
  const firstS = rows[0]?.t ?? 0, lastS = rows.at(-1)?.t ?? 0, window = flight.truth.filter(row => row.t >= firstS - 1 && row.t <= lastS + 0.1);
  const time = rows.map(row => row.t);
  const series = (): { requested: number[]; actual: number[] } => {
    switch (axis) {
      case 'roll': return { requested: rows.map(row => row.requested.rollDeg ?? Number.NaN), actual: window.map(row => row.rollDeg) };
      case 'pitch': return { requested: rows.map(row => row.requested.pitchDeg ?? Number.NaN), actual: window.map(row => row.pitchDeg) };
      case 'altitude': return { requested: rows.map(row => row.requested.altitudeM ?? Number.NaN), actual: window.map(row => row.altitudeM) };
      case 'heading': {
        const requested = unwrapDeg(rows.map(row => row.requested.headingDeg ?? Number.NaN)), actual = unwrapDeg(window.map(row => wrapDeg(row.yawDeg)));
        const turns = Math.round(((requested[0] ?? 0) - (actual[0] ?? 0)) / 360);
        return { requested, actual: actual.map(value => value + turns * 360) };
      }
      default: { const never: never = axis; throw new Error(String(never)); }
    }
  };
  const { requested, actual } = series(), requestedSeries = { timeS: time, value: requested }, actualSeries = { timeS: window.map(row => row.t), value: actual };
  return { requested: requestedSeries, actual: actualSeries, edges: maneuverResponse(requestedSeries, actualSeries, 0.05) };
}

describe.skipIf(!installed)('each maneuver with native ArduCopter (TASK-173)', () => {
  test.each(Object.keys(MANEUVER_TYPES) as ManeuverType[])('%s flies, and every change of its request gets a response', async type => {
    const flight = await fly(taskOf(type));
    const { requested, actual, edges } = responseOf(flight, type);
    const firstS = requested.timeS[0] ?? 0;
    const lastS = requested.timeS.at(-1) ?? firstS, estimate = flight.estimate.filter(row => row.t >= firstS && row.t <= lastS);
    maneuverEvidence[type] = { definition: taskOf(type), simTimeS: flight.simTimeS, wallS: flight.wallS, lockstep: flight.lockstep, firstS, edges, requested, actual, estimate };
    console.log(`EVID ${type}: ${JSON.stringify({ sim: flight.simTimeS, edges: edges.map(edge => ({ at: +(edge.edgeTimeS - firstS).toFixed(2), from: +edge.from.toFixed(2), to: +edge.to.toFixed(2), start: edge.startActual === null ? null : +edge.startActual.toFixed(2),
      delay: edge.delayS === null ? null : +edge.delayS.toFixed(3), rise: edge.riseTimeS === null ? null : +edge.riseTimeS.toFixed(3), overshoot: edge.overshootPercent === null ? null : +edge.overshootPercent.toFixed(1), settle: edge.settlingTimeS === null ? null : +edge.settlingTimeS.toFixed(3), endError: edge.endError === null ? null : +edge.endError.toFixed(3), missing: edge.missing })) })}`);
    expect(flight.steps.at(-1)?.progress, flight.text.slice(-6).join(' | ')).toEqual({ state: 'done' });
    expect(flight.lockstep.duplicates + flight.lockstep.gaps).toBe(0);
    near(flight.steps.at(-1)?.actual.altitudeM, flight.steps[0]?.actual.altitudeM ?? 0, 0.05, 'landed height');
    const { axis, shape } = MANEUVER_TYPES[type];
    expect(edges, 'one result per change').toHaveLength(shape === 'doublet' ? 3 : axis === 'roll' || axis === 'pitch' ? 2 : 1);
    // Each change comes at its moment on the timeline, on the task's clock: at an observation every 0.1 s of simulated time.
    const planned = maneuverTimeline(axis, shape, Number(TASKS[type].parameters.amplitudeDeg ?? TASKS[type].parameters.amplitudeM), Number(TASKS[type].parameters.holdS));
    edges.forEach((edge, i) => near(edge.edgeTimeS - firstS, planned.edges[i]?.timeS ?? Number.NaN, 1e-3, `change ${i}`));
    for (const edge of edges) {
      expect(edge.missing).toBeNull();
      // That ArduPilot flew it, not how well (SA-01): it went at least most of the way that was asked.
      const change = edge.to - edge.from, moved = (edge.peak ?? Number.NaN) - edge.from;
      expect(moved / change, `moved towards ${edge.to}`).toBeGreaterThan(0.8);
    }
  }, 600000);
});
