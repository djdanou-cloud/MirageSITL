// TASK-154 (S02): the run states of an integrated ArduPilot SITL experiment.
// SessionController runs here on scripted ports and a fake clock whose
// ClockPort.every callbacks the tests fire by hand, and also on the real
// launcher (TASK-151) with the shared fake SITL. Oracles, independent of the
// controller: the contract's states and DoD (docs/PROJECT_ROADMAP.md,
// TASK-154) and the lead defaults of 2026-11-01 (parameter read-back within
// 30 s of simulated time, first heartbeat within 60 s of wall time, READY
// loss in flight is a warning, a refused start writes no record); MAVLink
// frames packed with the TASK-150 codec as ArduCopter sends them (system 1,
// component 1, MAV_AUTOPILOT_ARDUPILOTMEGA 3, MAV_MODE_FLAG_SAFETY_ARMED 128);
// command and mode numbers of the pinned common.xml and ArduCopter/mode.h;
// the experiment record checked by validateExperiment and by
// createExperimentRecord, which recomputes the snapshot, the frame parameters
// and the manifest from the stored profile; and the launcher's own answers,
// exit reasons, process groups and the files it writes for each experiment
// (experiment.parm, experiment.json, owner-N.json). On the real launcher the
// physics port opens a real WebSocket to the run's bridge, as the Worker
// does, and fetch follows the browser's CORS rules, so a fault reads as the
// panel in Chrome would read it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { readCatalog, writeCatalogEntry, type FirmwareEntry } from '../apps/launcher/src/catalog.ts';
import { ensureToken, startLauncher } from '../apps/launcher/src/server.ts';
import {
  failureText, HEARTBEAT_DEADLINE_S, LauncherError, PARAMETER_DEADLINE_S, SessionController, type CatalogEntry, type ClockPort,
  type ControllerView, type LauncherExperiment, type LauncherFirmware, type LauncherLogs, type LauncherPort, type LauncherRun,
  type LauncherRunState, type PhysicsPort, type PreparedRun, type RecordPort, type RunState, type StartRequest, type StartSpec,
} from '../apps/web/src/run/session-controller.ts';
import type { SitlStatus } from '../apps/web/src/sitl/bridge-client.ts';
import { DEFAULT_HOME, LauncherClient, parseLauncherExperiment, preparedRun } from '../apps/web/src/sitl/sitl-run.ts';
import { validateComponentCard } from '../packages/aircraft/src/components.ts';
import {
  createExperimentRecord, experimentRecordName, readExperiment, validateExperiment, type ExperimentPayload,
} from '../packages/aircraft/src/experiment.ts';
import { profileDraft, validateAircraftProfile, withSensorConfiguration } from '../packages/aircraft/src/profile.ts';
import { DEFAULT_SENSOR_CONFIGURATION, type SensorConfiguration } from '../packages/aircraft/src/sensor-fields.ts';
import { sensorSnapshot } from '../packages/aircraft/src/sensor-ownership.ts';
import { definition, encodeInto, MavParser } from '../packages/mavlink/src/codec.ts';
import { fieldOf, packInto, readNumber, type FieldValue } from '../packages/mavlink/src/messages.ts';
import { canonicalBytes, type StoredVersion } from '../packages/project/src/schema.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';
import { writeFakeFirmware } from './support/fake-firmware.ts';
import { exampleCard, quadProfile } from './support/quad-profile.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function field(value: unknown, key: string | number): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}
function readJson(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parsed;
}
/** The pinned ArduPilot commit of scripts/sitl.lock.json, checked as a 40-digit SHA-1. */
const SITL_COMMIT = (() => {
  const commit = field(readJson(new URL('../scripts/sitl.lock.json', import.meta.url).pathname), 'commit');
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('scripts/sitl.lock.json has no valid commit');
  return commit;
})();

// ---- MAVLink as ArduCopter sends it, and as the ground station sent it ------------------------

/** MAVLink message IDs (common.xml). */
const HEARTBEAT = 0, PARAM_REQUEST_LIST = 21, PARAM_VALUE = 22, COMMAND_LONG = 76, COMMAND_ACK = 77, STATUSTEXT = 253;
/** MAV_CMD numbers (common.xml). */
const NAV_TAKEOFF = 22, DO_SET_MODE = 176, COMPONENT_ARM_DISARM = 400, SET_MESSAGE_INTERVAL = 511;
/** ArduCopter custom modes (ArduCopter/mode.h, Mode::Number). */
const STABILIZE = 0, GUIDED = 4, LAND = 9;
/** MAV_TYPE_QUADROTOR, MAV_AUTOPILOT_ARDUPILOTMEGA, MAV_AUTOPILOT_INVALID, MAV_PARAM_TYPE_REAL32, MAV_MODE_FLAG_SAFETY_ARMED. */
const QUADROTOR = 2, ARDUPILOTMEGA = 3, AUTOPILOT_INVALID = 8, REAL32 = 9, SAFETY_ARMED = 128;
/** MAV_TYPE_GCS and MAV_TYPE_CAMERA, for heartbeats of other components. */
const TYPE_GCS = 6, TYPE_CAMERA = 30;
/** MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | MAV_MODE_FLAG_STABILIZE_ENABLED | MAV_MODE_FLAG_MANUAL_INPUT_ENABLED. */
const BASE_MODE = 1 | 16 | 64;

let autopilotSequence = 0;
/** One MAVLink 2 frame, by default of the autopilot (system 1, component 1), packed with the TASK-150 codec. */
function autopilotFrame(id: number, values: Readonly<Record<string, FieldValue>>, systemId = 1, componentId = 1): Uint8Array {
  const layout = definition(id);
  if (!layout) throw new Error(`Message ${id} is not in the pinned dialect`);
  const payload = new Uint8Array(layout.length);
  if (!packInto(id, values, payload)) throw new Error(`Message ${id} does not pack ${JSON.stringify(values)}`);
  const out = new Uint8Array(280);
  const n = encodeInto(id, payload, autopilotSequence, systemId, componentId, out);
  autopilotSequence = (autopilotSequence + 1) & 255;
  if (n === 0) throw new Error(`Message ${id} does not encode`);
  return out.slice(0, n);
}
interface HeartbeatSource { readonly systemId?: number; readonly componentId?: number; readonly type?: number; readonly autopilot?: number }
function heartbeat(customMode: number, armed: boolean, source: HeartbeatSource = {}): Uint8Array {
  return autopilotFrame(HEARTBEAT, { type: source.type ?? QUADROTOR, autopilot: source.autopilot ?? ARDUPILOTMEGA,
    base_mode: BASE_MODE | (armed ? SAFETY_ARMED : 0), custom_mode: customMode, system_status: armed ? 4 : 3, mavlink_version: 3 },
  source.systemId ?? 1, source.componentId ?? 1);
}
function paramValue(name: string, value: number, count: number, index: number): Uint8Array {
  return autopilotFrame(PARAM_VALUE, { param_id: name, param_value: value, param_type: REAL32, param_count: count, param_index: index });
}
function commandAck(command: number, result: number): Uint8Array {
  return autopilotFrame(COMMAND_ACK, { command, result });
}
function statusText(text: string): Uint8Array {
  return autopilotFrame(STATUSTEXT, { severity: 6, text });
}
/** Parameters the autopilot holds besides the generated ones (copter.parm and the build's own). */
const OTHER_PARAMETERS: readonly (readonly [string, number])[] = [['SYSID_THISMAV', 1], ['FS_GCS_ENABLE', 0], ['ARMING_CHECK', 1]];
/** The autopilot's complete PARAM_VALUE list: every generated parameter (as float32 on the wire) plus others. */
function parameterList(expected: readonly { readonly name: string; readonly value: number }[],
  change: { readonly name: string; readonly value: number | null } | null = null): Uint8Array[] {
  const list: (readonly [string, number])[] = [];
  for (const parameter of expected) {
    if (change?.name !== parameter.name) list.push([parameter.name, parameter.value]);
    else if (change.value !== null) list.push([parameter.name, change.value]);
  }
  list.push(...OTHER_PARAMETERS);
  return list.map(([name, value], index) => paramValue(name, value, list.length, index));
}

function layoutOf(id: number, name: string) {
  const field = fieldOf(id, name);
  if (!field) throw new Error(`No field ${id}.${name}`);
  return field;
}
const COMMAND = layoutOf(COMMAND_LONG, 'command');
const PARAMS = [1, 2, 3, 4, 5, 6, 7].map(i => layoutOf(COMMAND_LONG, `param${i}`));
const TARGET_SYSTEM = layoutOf(COMMAND_LONG, 'target_system'), LIST_TARGET_SYSTEM = layoutOf(PARAM_REQUEST_LIST, 'target_system');
const HEARTBEAT_TYPE = layoutOf(HEARTBEAT, 'type');
interface SentFrame {
  readonly id: number;
  readonly systemId: number;
  /** COMMAND_LONG and PARAM_REQUEST_LIST: target_system. */
  readonly target: number | null;
  /** COMMAND_LONG: the command and its seven parameters. */
  readonly command: number | null;
  readonly params: readonly number[];
  /** HEARTBEAT: MAV_TYPE. */
  readonly type: number | null;
}
/** Every frame the ground station sent, decoded with the codec's own CRC check. */
function decodeSent(chunks: readonly Uint8Array[]): SentFrame[] {
  const frames: SentFrame[] = [];
  const parser = new MavParser(frame => {
    const command = frame.id === COMMAND_LONG ? readNumber(frame.view, COMMAND) : null;
    frames.push({
      id: frame.id, systemId: frame.systemId, command, type: frame.id === HEARTBEAT ? readNumber(frame.view, HEARTBEAT_TYPE) : null,
      target: frame.id === COMMAND_LONG ? readNumber(frame.view, TARGET_SYSTEM) : frame.id === PARAM_REQUEST_LIST ? readNumber(frame.view, LIST_TARGET_SYSTEM) : null,
      params: command === null ? [] : PARAMS.map(field => readNumber(frame.view, field)),
    });
  });
  for (const chunk of chunks) parser.push(chunk);
  if (parser.badCrc !== 0 || parser.unsupported !== 0) throw new Error('The ground station sent a malformed frame');
  return frames;
}
const commands = (frames: readonly SentFrame[], command: number) => frames.filter(frame => frame.command === command);
const listRequests = (frames: readonly SentFrame[]) => frames.filter(frame => frame.id === PARAM_REQUEST_LIST);

// ---- scripted ports -------------------------------------------------------------------------------

/** A launcher experiment ID: 17 digits of UTC start time, '-' and 8 hexadecimal digits (apps/launcher/src/server.ts). */
const experimentId = (n: number) => `20261101120000000-${n.toString(16).padStart(8, '0')}`;
/** The build identity in the launcher's experiment view. */
const FIRMWARE: LauncherFirmware = {
  id: 'arducopter-8ab6afd', firmwareVersion: 'ArduCopter V4.8.0-dev (8ab6afde)', commit: SITL_COMMIT,
  binarySha256: sha('installed arducopter'), defaultParametersSha256: sha('installed copter.parm'),
};
/** The catalog listing of the same build; its version text differs, so a record that copied the catalog would show. */
const BUILD: CatalogEntry = { id: FIRMWARE.id, firmwareVersion: 'ArduCopter V4.8.0-dev', usable: true, reason: null };
const NO_SESSION = 'No open SITL session for MAVLink';
const BET_SHA = sha('scalar BET module');

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined, reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
/** Lets every pending promise continuation of resolved scripted answers run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>(done => setImmediate(done));
}

/** The launcher API as the controller sees it, with each answer replaceable by a test. */
class ScriptedLauncher implements LauncherPort {
  readonly starts: StartSpec[] = [];
  readonly stops: string[] = [];
  private readonly runs = new Map<string, { run: LauncherRun; bridge: number }>();
  private launched = 0;
  catalogAnswer: () => Promise<readonly CatalogEntry[]> = () => Promise.resolve([BUILD]);
  startAnswer: ((spec: StartSpec) => Promise<LauncherExperiment>) | null = null;
  stopAnswer: ((id: string) => Promise<LauncherExperiment>) | null = null;
  experimentAnswer: ((id: string) => Promise<LauncherExperiment>) | null = null;
  logsAnswer: (id: string) => Promise<LauncherLogs> = () => Promise.resolve({ stdout: 'SITL stdout tail\n', stderr: '', dataflash: ['00000001.BIN'] });
  constructor(private readonly events: string[]) {}

  get lastId(): string { return experimentId(this.launched); }
  count(method: string): number { return this.events.filter(event => event.startsWith(`launcher.${method}`)).length; }
  /** A new running experiment, as a 201 answer shows it. */
  launch(): LauncherExperiment {
    const n = ++this.launched, id = experimentId(n);
    this.runs.set(id, { run: { run: 1, pid: 40000 + n, state: 'running', exitCode: null, signal: null, reason: null }, bridge: 50000 + n });
    return this.view(id);
  }
  /** The run ended by itself, as OwnedProcess records it. */
  end(id: string, state: LauncherRunState, exitCode: number | null, signal: string | null, reason: string): void {
    const entry = this.runs.get(id);
    if (!entry) throw new Error(`No scripted experiment ${id}`);
    entry.run = { ...entry.run, state, exitCode, signal, reason };
  }
  view(id: string): LauncherExperiment {
    const entry = this.runs.get(id);
    if (!entry) throw new Error(`No scripted experiment ${id}`);
    const { run } = entry;
    return { id, state: run.state, startError: null, firmware: FIRMWARE, runs: [run], ports: run.state === 'running' ? { bridge: entry.bridge } : null };
  }
  bridgeOf(id: string): number {
    const entry = this.runs.get(id);
    if (!entry) throw new Error(`No scripted experiment ${id}`);
    return entry.bridge;
  }

  catalog(): Promise<readonly CatalogEntry[]> {
    this.events.push('launcher.catalog');
    return this.catalogAnswer();
  }
  start(spec: StartSpec): Promise<LauncherExperiment> {
    this.events.push('launcher.start');
    this.starts.push(spec);
    return this.startAnswer ? this.startAnswer(spec) : Promise.resolve(this.launch());
  }
  stop(id: string): Promise<LauncherExperiment> {
    this.events.push(`launcher.stop ${id}`);
    this.stops.push(id);
    if (this.stopAnswer) return this.stopAnswer(id);
    const entry = this.runs.get(id);
    // A requested stop of a running run ends it "stopped" with no reason; an ended run keeps its ending.
    if (entry && (entry.run.state === 'running' || entry.run.state === 'stopping')) entry.run = { ...entry.run, state: 'stopped', exitCode: null, signal: 'SIGTERM', reason: null };
    return Promise.resolve(this.view(id));
  }
  experiment(id: string): Promise<LauncherExperiment> {
    this.events.push('launcher.experiment');
    return this.experimentAnswer ? this.experimentAnswer(id) : Promise.resolve(this.view(id));
  }
  logs(id: string): Promise<LauncherLogs> {
    this.events.push('launcher.logs');
    return this.logsAnswer(id);
  }
}

/**
 * The physics Worker as the controller sees it. Like the real Worker
 * (apps/web/src/physics.worker.ts, handleSitl, and SitlBridgeClient.sendMavlink),
 * it forwards a MAVLink chunk only while its bridge socket is open and
 * otherwise posts sitl.reject 'No open SITL session for MAVLink', delivered
 * asynchronously as a Worker message is. The bridge state follows the
 * sitl.status the test posts (`status()`), or, on the real launcher, a real
 * WebSocket (BridgePhysics).
 */
class ScriptedPhysics implements PhysicsPort {
  readonly connects: { readonly port: number; readonly bridgeEpoch: number; readonly speedup: number }[] = [];
  /** Every chunk Main asked the Worker to send, forwarded or not. */
  readonly sent: Uint8Array[] = [];
  /** Chunks the Worker refused because its bridge was not open. */
  rejected = 0;
  disconnects = 0;
  altitude = 0;
  verticalSpeed = 0;
  /** The Worker's bridge socket: none before sitl.connect and after sitl.disconnect. */
  bridge: SitlStatus['state'] | 'none' = 'none';
  /** The controller's Worker message handler. */
  deliver: (data: unknown) => void = () => undefined;
  loadAnswer: () => Promise<{ readonly betModuleSha256: string }> = () => Promise.resolve({ betModuleSha256: BET_SHA });
  constructor(private readonly events: string[]) {}
  load(): Promise<{ readonly betModuleSha256: string }> {
    this.events.push('physics.load');
    return this.loadAnswer();
  }
  connect(port: number, bridgeEpoch: number, speedup: number): void {
    this.events.push('physics.connect');
    this.connects.push({ port, bridgeEpoch, speedup });
    this.bridge = 'connecting';
  }
  disconnect(): void {
    this.disconnects++;
    this.bridge = 'none';
  }
  sendMavlink(bytes: Uint8Array): void {
    this.sent.push(bytes);
    if (this.bridge === 'open') return;
    this.rejected++;
    queueMicrotask(() => { this.deliver({ type: 'sitl.reject', message: NO_SESSION }); });
  }
  altitudeM(): number { return this.altitude; }
  verticalSpeedMps(): number { return this.verticalSpeed; }
  frames(): SentFrame[] { return decodeSent(this.sent); }
}

/** ClockPort whose intervals run only when a test advances wall time. */
class FakeClock implements ClockPort {
  private now = 0;
  private next = 0;
  private readonly timers = new Map<number, { readonly ms: number; due: number; readonly callback: () => void }>();
  nowMs(): number { return this.now; }
  every(ms: number, callback: () => void): () => void {
    const id = ++this.next;
    this.timers.set(id, { ms, due: this.now + ms, callback });
    return () => { this.timers.delete(id); };
  }
  get intervals(): number { return this.timers.size; }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let due: { ms: number; due: number; callback: () => void } | undefined;
      for (const timer of this.timers.values()) if (timer.due <= end && (!due || timer.due < due.due)) due = timer;
      if (!due) break;
      this.now = due.due;
      due.due += due.ms;
      due.callback();
    }
    this.now = end;
  }
}

/** The project store as the Run tab writes records into it, through createExperimentRecord. */
class StoreRecords implements RecordPort {
  readonly payloads: ExperimentPayload[] = [];
  readonly stored: StoredVersion[] = [];
  answer: ((payload: ExperimentPayload) => Promise<{ readonly sha256: string }>) | null = null;
  constructor(private readonly fixture: Fixture, private readonly events: string[]) {}
  async create(payload: ExperimentPayload): Promise<{ readonly sha256: string }> {
    this.events.push('record.create');
    this.payloads.push(payload);
    if (this.answer) return this.answer(payload);
    const stored = await createExperimentRecord(this.fixture.store, this.fixture.projectId,
      { name: experimentRecordName(this.fixture.stored.record.name, payload.launcher.experimentId), payload });
    this.stored.push(stored);
    return { sha256: stored.sha256 };
  }
}

// ---- the stored aircraft profile ----------------------------------------------------------------

interface Fixture {
  readonly store: ProjectStore;
  readonly projectId: string;
  readonly stored: StoredVersion;
}
/** The S19 quad X on the four example cards, stored with them in a fresh project, with `sensors` as its sensor configuration. */
async function storedProfile(sensors: SensorConfiguration | null): Promise<Fixture> {
  const store = new ProjectStore(new MemoryBackend(), { storage: null,
    validators: { 'component-card': validateComponentCard, 'aircraft-profile': validateAircraftProfile, experiment: validateExperiment } });
  const projectId = (await store.createProject('Runs')).record.id;
  const card = async (type: 'motor' | 'propeller' | 'esc' | 'battery') =>
    (await store.createItem(projectId, 'component-card', { name: `Example ${type}`, payload: exampleCard(type) })).sha256;
  const addresses = { motor: await card('motor'), propeller: await card('propeller'), esc: await card('esc'), battery: await card('battery') };
  const { profile } = await quadProfile(addresses);
  const stored = await store.createItem(projectId, 'aircraft-profile', profileDraft('Quad', withSensorConfiguration(profile, sensors)));
  return { store, projectId, stored };
}
const DEFAULTS = DEFAULT_SENSOR_CONFIGURATION;
/** ArduPilot-owned sensor values only (TASK-147), so the run is admitted and sensor parameters are generated. */
const ARDUPILOT_OWNED: SensorConfiguration = {
  ...DEFAULTS,
  barometer: { ...DEFAULTS.barometer, noiseRmsPa: 3, biasPa: 20 },
  gnss: { ...DEFAULTS.gnss, updateRateHz: 10, horizontalSigmaM: 1.5 },
  magnetometer: { ...DEFAULTS.magnetometer, biasGauss: [0.01, 0, -0.02] },
};
/** Two MirageSITL-owned error terms, which the external-SITL path cannot apply yet (user decision: refused at start, naming them). */
const MIRAGE_OWNED: SensorConfiguration = {
  ...DEFAULTS,
  imu: { ...DEFAULTS.imu, accelBiasMps2: [0.1, 0, 0] },
  battery: { ...DEFAULTS.battery, voltageOffsetV: 0.1 },
};

// ---- the harness ----------------------------------------------------------------------------------

interface Harness {
  readonly controller: SessionController;
  readonly launcher: ScriptedLauncher;
  readonly physics: ScriptedPhysics;
  readonly clock: FakeClock;
  readonly records: StoreRecords;
  readonly events: string[];
  readonly views: ControllerView[];
  readonly request: StartRequest;
  readonly run: PreparedRun;
}
let fixture: Fixture;
let prepared: PreparedRun;
beforeAll(async () => {
  fixture = await storedProfile(ARDUPILOT_OWNED);
  prepared = (await preparedRun(fixture.store, fixture.stored)).run;
});

function harness(prepare: () => Promise<PreparedRun> = () => Promise.resolve(prepared)): Harness {
  const events: string[] = [], views: ControllerView[] = [];
  const launcher = new ScriptedLauncher(events), physics = new ScriptedPhysics(events), clock = new FakeClock();
  const records = new StoreRecords(fixture, events);
  const controller = new SessionController(launcher, physics, records, clock, view => {
    views.push(view);
    if (events.at(-1) !== `state:${view.state.name}`) events.push(`state:${view.state.name}`);
  });
  physics.deliver = data => { controller.worker(data); };
  const request: StartRequest = { prepare, firmwareId: BUILD.id, speedup: 1, physicsHz: 800, home: DEFAULT_HOME };
  return { controller, launcher, physics, clock, records, events, views, request, run: prepared };
}
const BASE_STATUS: SitlStatus = {
  type: 'sitl.status', state: 'open', ready: false, reason: 'Waiting for EKF_STATUS_REPORT', simTimeS: 0, steps: 0, duplicates: 0, gaps: 0,
  droppedFrames: 0, held: 0, restarts: 0, clampedPwm: 0, speed: 1, message: '',
};
/** A Worker status; the scripted Worker's bridge takes its state, as SitlBridgeClient reports its own. */
function status(h: Harness, patch: Partial<SitlStatus>): void {
  const full = { ...BASE_STATUS, ...patch };
  h.physics.bridge = full.state;
  h.controller.worker(full);
}
function mav(h: Harness, ...frames: Uint8Array[]): void {
  for (const bytes of frames) h.controller.worker({ type: 'sitl.mavlink', bytes });
}
/** The state with a failure reason; fails the test otherwise. */
function failed(h: Harness): Extract<RunState, { name: 'failed' }> {
  const state = h.controller.state;
  if (state.name !== 'failed') throw new Error(`Expected failed, the state is ${state.name}`);
  return state;
}
/** True when the launcher was asked to stop before the panel showed failed. */
function stoppedBeforeFailed(h: Harness): boolean {
  const stop = h.events.findIndex(event => event.startsWith('launcher.stop')), shown = h.events.indexOf('state:failed');
  return stop >= 0 && shown > stop;
}
async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(done => setTimeout(done, 20));
  }
}

type Stage = 'connecting' | 'loading-parameters' | 'warming' | 'ready' | 'arming' | 'climbing' | 'flying' | 'landing';
const STAGES: readonly Stage[] = ['connecting', 'loading-parameters', 'warming', 'ready', 'arming', 'climbing', 'flying', 'landing'];
const TAKEOFF_M = 5;
/** Drives the controller with ArduCopter's frames and the Worker's status until `stage`; returns the experiment ID. */
async function reach(h: Harness, stage: Stage): Promise<string> {
  await h.controller.start(h.request);
  const id = h.launcher.lastId;
  expect(h.controller.state).toEqual({ name: 'starting', step: 'connecting', experimentId: id });
  if (stage === 'connecting') return id;
  status(h, { state: 'open', simTimeS: 0.5 });
  mav(h, heartbeat(STABILIZE, false));
  expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: id });
  if (stage === 'loading-parameters') return id;
  mav(h, ...parameterList(h.run.parameters));
  expect(h.controller.state).toMatchObject({ name: 'warming', experimentId: id });
  if (stage === 'warming') return id;
  status(h, { ready: true, reason: '', simTimeS: 40 });
  expect(h.controller.state).toEqual({ name: 'ready', experimentId: id });
  if (stage === 'ready') return id;
  expect(h.controller.takeOff(TAKEOFF_M)).toBe(true);
  expect(h.controller.state).toMatchObject({ name: 'running', flight: 'arming' });
  if (stage === 'arming') return id;
  mav(h, heartbeat(GUIDED, false));
  h.clock.advance(1000);
  mav(h, heartbeat(GUIDED, true));
  expect(h.controller.state).toMatchObject({ name: 'running', flight: 'climbing' });
  if (stage === 'climbing') return id;
  h.physics.altitude = TAKEOFF_M - 0.1;
  h.physics.verticalSpeed = -0.1;
  status(h, { ready: true, reason: '', simTimeS: 50 });
  expect(h.controller.state).toMatchObject({ name: 'running', flight: 'flying' });
  if (stage === 'flying') return id;
  expect(h.controller.land()).toBe(true);
  expect(h.controller.state).toMatchObject({ name: 'running', flight: 'landing' });
  return id;
}

/**
 * A restart from failed: a NEW launcher experiment with a NEW record, connected to its own bridge and
 * loading parameters; then a user Stop of it. `recordsBefore` is the number of records written so far.
 */
async function restarted(h: Harness, recordsBefore: number): Promise<void> {
  const startsBefore = h.launcher.count('start');
  const earlier = h.records.payloads.map(payload => payload.launcher.experimentId);
  expect(h.controller.state.name).toBe('failed');
  await h.controller.start(h.request);
  const id = h.launcher.lastId;
  expect(h.launcher.count('start')).toBe(startsBefore + 1);
  expect(h.controller.state).toEqual({ name: 'starting', step: 'connecting', experimentId: id });
  expect(earlier).not.toContain(id);
  expect(h.records.payloads).toHaveLength(recordsBefore + 1);
  expect(h.records.payloads.at(-1)?.launcher.experimentId).toBe(id);
  expect(h.physics.connects.at(-1)).toEqual({ port: h.launcher.bridgeOf(id), bridgeEpoch: 1, speedup: 1 });
  status(h, { state: 'open', simTimeS: 0.1 });
  mav(h, heartbeat(STABILIZE, false));
  expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: id, received: 0 });
  await h.controller.stop();
  expect(h.launcher.stops.at(-1)).toBe(id);
  expect(h.controller.state.name).toBe('idle');
}

// ---- the happy path -----------------------------------------------------------------------------

describe('SessionController run states on scripted ports', () => {
  test('starts through every step, loads and confirms the parameters, warms, becomes READY, flies, lands and stops', async () => {
    const h = harness();
    // The generated list really carries values that are not float32, so the read-back must compare as float32.
    expect(h.run.parameters.some(p => Math.fround(p.value) !== p.value)).toBe(true);
    expect(h.run.parameters.some(p => p.source === 'sensor')).toBe(true);
    await h.controller.start(h.request);
    const id = h.launcher.lastId;
    const steps = h.views.flatMap(view => (view.state.name === 'starting' ? [view.state.step] : []));
    expect(steps.filter((step, i) => step !== steps[i - 1])).toEqual(['prepare', 'firmware', 'physics', 'launcher', 'record', 'connecting']);
    expect(h.controller.state).toEqual({ name: 'starting', step: 'connecting', experimentId: id });
    // The record exists before the Worker connects: no unrecorded run flies.
    expect(h.events.indexOf('record.create')).toBeLessThan(h.events.indexOf('physics.connect'));
    expect(h.physics.connects).toEqual([{ port: h.launcher.bridgeOf(id), bridgeEpoch: 1, speedup: 1 }]);
    expect(h.controller.view.recordSha256).toBe(h.records.stored[0]?.sha256);
    expect(h.launcher.starts).toEqual([{ firmwareId: BUILD.id, parameters: h.run.parameters.map(p => ({ name: p.name, value: p.value })),
      frameScript: h.run.frameScript, speedup: 1, rateHz: 800, home: DEFAULT_HOME }]);

    // The ground station beats once a wall second and asks for the EKF, GPS and position streams until they are acknowledged.
    status(h, { state: 'open', simTimeS: 0 });
    h.clock.advance(1000);
    const first = h.physics.frames();
    expect(first.some(frame => frame.id === HEARTBEAT && frame.systemId === 255 && frame.type === 6)).toBe(true);
    expect(commands(first, SET_MESSAGE_INTERVAL).map(frame => frame.params[0]).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([24, 33, 193]);
    expect(listRequests(first)).toEqual([]);

    // The first heartbeat starts the parameter download.
    status(h, { state: 'open', simTimeS: 1 });
    mav(h, heartbeat(STABILIZE, false));
    expect(h.controller.state).toEqual({ name: 'loading-parameters', experimentId: id, received: 0, total: null });
    expect(h.controller.view.mode).toBe(STABILIZE);
    expect(listRequests(h.physics.frames()).map(frame => [frame.systemId, frame.target])).toEqual([[255, 1]]);
    const list = parameterList(h.run.parameters);
    mav(h, ...list.slice(0, 3));
    expect(h.controller.state).toEqual({ name: 'loading-parameters', experimentId: id, received: 3, total: list.length });
    mav(h, commandAck(SET_MESSAGE_INTERVAL, 0), commandAck(SET_MESSAGE_INTERVAL, 0), commandAck(SET_MESSAGE_INTERVAL, 0));
    mav(h, ...list.slice(3));
    expect(h.controller.state).toMatchObject({ name: 'warming', experimentId: id });
    const sentBefore = h.physics.sent.length;
    h.clock.advance(1000);
    expect(commands(decodeSent(h.physics.sent.slice(sentBefore)), SET_MESSAGE_INTERVAL)).toEqual([]);

    // STATUSTEXT reaches the view; the Worker's READY makes the run ready.
    mav(h, statusText('EKF3 IMU0 is using GPS'));
    expect(h.controller.view.statusText).toContain('EKF3 IMU0 is using GPS');
    status(h, { ready: false, reason: 'EKF not converged', simTimeS: 20 });
    expect(h.controller.state).toMatchObject({ name: 'warming', reason: 'EKF not converged' });
    status(h, { ready: true, reason: '', simTimeS: 40 });
    expect(h.controller.state).toEqual({ name: 'ready', experimentId: id });

    // Take-off: GUIDED, arm, NAV_TAKEOFF once armed.
    expect(h.controller.takeOff(0.5)).toBe(false);
    expect(h.controller.takeOff(TAKEOFF_M)).toBe(true);
    expect(h.controller.state).toEqual({ name: 'running', experimentId: id, flight: 'arming', warning: null });
    expect(commands(h.physics.frames(), DO_SET_MODE).at(-1)?.params.slice(0, 2)).toEqual([1, GUIDED]);
    mav(h, heartbeat(GUIDED, false));
    h.clock.advance(1000);
    expect(commands(h.physics.frames(), COMPONENT_ARM_DISARM).at(-1)).toMatchObject({ target: 1, params: [1, 0, 0, 0, 0, 0, 0] });
    expect(commands(h.physics.frames(), NAV_TAKEOFF)).toEqual([]);
    mav(h, heartbeat(GUIDED, true));
    expect(h.controller.view.armed).toBe(true);
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'climbing' });
    expect(commands(h.physics.frames(), NAV_TAKEOFF).map(frame => frame.params[6])).toEqual([TAKEOFF_M]);

    // Flying once within 0.5 m of the take-off altitude and below 0.3 m/s: each condition alone keeps it climbing.
    let simTimeS = 44;
    const climbingAt = (altitudeM: number, verticalSpeedMps: number) => {
      h.physics.altitude = altitudeM; h.physics.verticalSpeed = verticalSpeedMps;
      status(h, { ready: true, reason: '', simTimeS: ++simTimeS });
      return h.controller.state.name === 'running' && h.controller.state.flight === 'climbing';
    };
    expect(climbingAt(3, -1.5)).toBe(true); // far and fast
    expect(climbingAt(TAKEOFF_M - 0.6, -0.1)).toBe(true); // slow, 0.6 m below
    expect(climbingAt(TAKEOFF_M - 0.51, 0)).toBe(true); // slow, 0.51 m below
    expect(climbingAt(TAKEOFF_M + 0.6, 0.1)).toBe(true); // slow, 0.6 m above
    expect(climbingAt(TAKEOFF_M - 0.3, -0.5)).toBe(true); // close, too fast upwards
    expect(climbingAt(TAKEOFF_M - 0.1, 0.31)).toBe(true); // close, too fast downwards
    expect(climbingAt(TAKEOFF_M - 0.49, -0.2)).toBe(false); // close and slow
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'flying', warning: null });

    // Landing: LAND mode, then READY again after the autopilot disarms.
    expect(h.controller.land()).toBe(true);
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'landing' });
    expect(commands(h.physics.frames(), DO_SET_MODE).at(-1)?.params.slice(0, 2)).toEqual([1, LAND]);
    mav(h, heartbeat(LAND, true));
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'landing' });
    mav(h, heartbeat(LAND, false));
    expect(h.controller.state).toEqual({ name: 'ready', experimentId: id });
    expect(h.controller.view.armed).toBe(false);

    // Everything went over an open bridge.
    expect(h.physics.rejected).toBe(0);
    await h.controller.stop();
    expect(h.launcher.stops).toEqual([id]);
    expect(h.controller.state.name).toBe('idle');
    expect(h.clock.intervals).toBe(0);
    expect(h.physics.disconnects).toBeGreaterThan(0);
    expect(h.launcher.count('start')).toBe(1);
  });

  test('the first ground-station beat while the bridge is still connecting does not fail the start', async () => {
    const h = harness();
    const id = await reach(h, 'connecting');
    // The Worker reports its socket connecting; it opens a little later than one wall second.
    status(h, { state: 'connecting', simTimeS: 0 });
    h.clock.advance(1000);
    await settle();
    expect(h.controller.state).toEqual({ name: 'starting', step: 'connecting', experimentId: id });
    expect(h.launcher.stops).toEqual([]);
    status(h, { state: 'open', simTimeS: 0.1 });
    mav(h, heartbeat(STABILIZE, false));
    expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: id });
    await h.controller.stop();
  });

  test('heartbeats of other systems or other components do not start the parameter download', async () => {
    const h = harness();
    const id = await reach(h, 'connecting');
    status(h, { state: 'open', simTimeS: 0.2 });
    mav(h,
      heartbeat(0, false, { systemId: 255, componentId: 190, type: TYPE_GCS, autopilot: AUTOPILOT_INVALID }), // a ground station
      heartbeat(0, false, { systemId: 1, componentId: 100, type: TYPE_CAMERA, autopilot: AUTOPILOT_INVALID }), // a camera of the vehicle
      heartbeat(STABILIZE, false, { systemId: 2 }), // another vehicle
      heartbeat(STABILIZE, false, { systemId: 1, componentId: 191 })); // a companion component of system 1
    expect(h.controller.state).toEqual({ name: 'starting', step: 'connecting', experimentId: id });
    expect(listRequests(h.physics.frames())).toEqual([]);
    mav(h, heartbeat(STABILIZE, false));
    expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: id });
    await h.controller.stop();
  });

  test('a heartbeat that declares no autopilot (MAV_AUTOPILOT_INVALID) does not start the parameter download, even from 1/1', async () => {
    const h = harness();
    const id = await reach(h, 'connecting');
    status(h, { state: 'open', simTimeS: 0.2 });
    // MAV_AUTOPILOT_INVALID: "No valid autopilot, e.g. a GCS or other MAVLink component" (common.xml), so it is not ArduCopter's heartbeat.
    mav(h, heartbeat(0, false, { type: TYPE_GCS, autopilot: AUTOPILOT_INVALID }));
    expect(h.controller.state).toEqual({ name: 'starting', step: 'connecting', experimentId: id });
    expect(listRequests(h.physics.frames())).toEqual([]);
    mav(h, heartbeat(STABILIZE, false));
    expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: id });
    await h.controller.stop();
  });

  test('the record holds exactly the POSTed parameters with their sources, the launcher-reported build, the BET module and the manifest', async () => {
    const h = harness();
    await h.controller.start(h.request);
    expect(h.records.payloads).toHaveLength(1);
    const payload = h.records.payloads[0];
    if (!payload) throw new Error('No record payload');
    // A valid experiment payload of schema 1.
    expect(validateExperiment(payload)).toEqual(payload);
    // Exactly the list the launcher received, in that order, with a source per parameter.
    const posted = h.launcher.starts[0];
    if (!posted) throw new Error('No start request');
    expect(payload.parameters.map(p => ({ name: p.name, value: p.value }))).toEqual(posted.parameters);
    expect(payload.parameters.map(p => p.source)).toEqual(h.run.parameters.map(p => p.source));
    expect(payload.frameScript).toBe(posted.frameScript);
    // The build identity is the launcher's answer, not the catalog request.
    const view = h.launcher.view(h.launcher.lastId);
    expect(payload.ardupilot).toEqual({ catalogId: view.firmware.id, firmwareVersion: view.firmware.firmwareVersion, commit: view.firmware.commit,
      binarySha256: view.firmware.binarySha256, defaultParametersSha256: view.firmware.defaultParametersSha256 });
    expect(payload.ardupilot.firmwareVersion).not.toBe(BUILD.firmwareVersion);
    expect(payload.launcher).toEqual({ experimentId: h.launcher.lastId });
    expect(payload.session).toEqual({ physicsHz: 800, clockMode: 'sitl-lockstep', speedup: 1, home: DEFAULT_HOME, modelId: 153,
      manifestSha256: h.run.manifestSha256, betModuleSha256: BET_SHA });
    expect(payload.profile).toEqual({ sha256: fixture.stored.sha256, id: fixture.stored.record.id, version: fixture.stored.record.version,
      name: fixture.stored.record.name });
    // The sensor snapshot of the exact profile version, byte for byte.
    expect(Buffer.from(canonicalBytes(payload.sensors)).equals(Buffer.from(canonicalBytes(sensorSnapshot(fixture.stored))))).toBe(true);
    // createExperimentRecord recomputed the snapshot, the frame parameters and the manifest SHA-256 and stored it on the profile version.
    const stored = h.records.stored[0];
    if (!stored) throw new Error('No stored record');
    expect(readExperiment(stored)).toEqual(payload);
    expect(stored.record.dependencies).toEqual([{ kind: 'aircraft-profile', sha256: fixture.stored.sha256 }]);
    await h.controller.stop();
  });

  test('READY revoked while ready returns to warming; revoked in flight is a warning and the flight continues', async () => {
    const h = harness();
    const id = await reach(h, 'ready');
    status(h, { ready: false, reason: 'EKF_STATUS_REPORT is stale', simTimeS: 41 });
    expect(h.controller.state).toEqual({ name: 'warming', experimentId: id, reason: 'EKF_STATUS_REPORT is stale' });
    expect(h.controller.takeOff(TAKEOFF_M)).toBe(false);
    status(h, { ready: true, reason: '', simTimeS: 42 });
    expect(h.controller.state).toEqual({ name: 'ready', experimentId: id });

    const flying = harness();
    await reach(flying, 'flying');
    status(flying, { ready: false, reason: 'GPS fix lost', simTimeS: 60 });
    const state = flying.controller.state;
    expect(state).toMatchObject({ name: 'running', flight: 'flying' });
    expect(state.name === 'running' ? state.warning : null).toContain('GPS fix lost');
    expect(flying.launcher.stops).toEqual([]);
    status(flying, { ready: true, reason: '', simTimeS: 61 });
    expect(flying.controller.state).toMatchObject({ name: 'running', flight: 'flying', warning: null });
    await h.controller.stop();
    await flying.controller.stop();
  });

  test('a landing that disarms while READY is revoked ends in warming with the reason, not ready', async () => {
    const h = harness();
    const id = await reach(h, 'landing');
    status(h, { ready: false, reason: 'EKF variance too high', simTimeS: 70 });
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'landing' });
    mav(h, heartbeat(LAND, true), heartbeat(LAND, false));
    expect(h.controller.state).toEqual({ name: 'warming', experimentId: id, reason: 'EKF variance too high' });
    expect(h.controller.takeOff(TAKEOFF_M)).toBe(false);
    expect(h.launcher.stops).toEqual([]);
    await h.controller.stop();
  });
});

// ---- deadlines and parameter failures -------------------------------------------------------------

describe('deadlines and the parameter read-back', () => {
  test('the parameter list must be complete within 30 s of simulated time from the first heartbeat, however long the wall time', async () => {
    expect(PARAMETER_DEADLINE_S).toBe(30);
    const h = harness();
    const id = await reach(h, 'connecting');
    status(h, { state: 'open', simTimeS: 2 });
    mav(h, heartbeat(STABILIZE, false));
    mav(h, ...parameterList(h.run.parameters).slice(0, 4));
    // Two wall minutes at a slow speed-up do not count.
    h.clock.advance(120_000);
    for (const simTimeS of [8, 14, 20, 26, 31.9]) status(h, { state: 'open', simTimeS });
    expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: id, received: 4 });
    // The request is repeated while the list is incomplete.
    expect(listRequests(h.physics.frames()).length).toBeGreaterThan(1);
    expect(h.launcher.stops).toEqual([]);
    status(h, { state: 'open', simTimeS: 32.1 });
    await settle();
    const state = failed(h);
    expect(state.reason.kind).toBe('parameters');
    expect(state.during).toBe('loading-parameters');
    expect(state.restart).toEqual({ kind: 'start-again' });
    expect(h.launcher.stops).toEqual([id]);
    expect(stoppedBeforeFailed(h)).toBe(true);
    expect(state.diagnostics).toMatchObject({ experimentId: id, launcherState: 'stopped' });
    expect(h.clock.intervals).toBe(0);
  });

  test('the 30 s of simulated time also hold when the first heartbeat came before any Worker status', async () => {
    const h = harness();
    const id = await reach(h, 'connecting');
    // The bridge is open but its status message has not reached Main yet.
    h.physics.bridge = 'open';
    mav(h, heartbeat(STABILIZE, false));
    expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: id });
    // SITL time starts at 0, so the heartbeat came at or after 0 s and at or before 1 s: 25 s is inside the deadline either way.
    for (const simTimeS of [1, 10, 25]) status(h, { state: 'open', simTimeS });
    await settle();
    expect(h.controller.state.name).toBe('loading-parameters');
    // 40 s is past it either way.
    status(h, { state: 'open', simTimeS: 40 });
    await settle();
    expect(failed(h).reason.kind).toBe('parameters');
    expect(h.launcher.stops).toEqual([id]);
  });

  /** A numeric token of `text` with the parameter name removed, so digits of the name do not count. */
  const hasNumber = (text: string, name: string, value: number) =>
    new RegExp(`(?<![0-9.])${String(value).replace(/[.+-]/g, '\\$&')}(?![0-9]|\\.[0-9])`).test(text.replaceAll(name, ''));
  test.each([
    ['a generated parameter reads back another value', (run: PreparedRun) => {
      const target = run.parameters.find(p => p.source === 'frame');
      if (!target) throw new Error('No frame parameter');
      return { name: target.name, expected: target.value, value: target.value + 7.5 };
    }],
    ['a generated sensor parameter reads back another float32', (run: PreparedRun) => {
      const target = run.parameters.find(p => p.source === 'sensor' && Math.fround(p.value) !== p.value);
      if (!target) throw new Error('No sensor parameter that is not float32');
      return { name: target.name, expected: target.value, value: target.value * 2 + 1 };
    }],
    ['a generated parameter is missing from the complete list', (run: PreparedRun) => {
      const target = run.parameters.find(p => p.source === 'output');
      if (!target) throw new Error('No output parameter');
      return { name: target.name, expected: target.value, value: null };
    }],
  ])('%s: failed with kind parameters after stopping, naming it', async (_label, pick) => {
    const h = harness();
    const id = await reach(h, 'loading-parameters');
    const change = pick(h.run);
    mav(h, ...parameterList(h.run.parameters, change));
    await settle();
    const state = failed(h);
    expect(state.reason.kind).toBe('parameters');
    const message = state.reason.kind === 'parameters' ? state.reason.message : '';
    expect(message).toContain(change.name);
    expect(failureText(state.reason)).toContain(change.name);
    if (change.value === null) {
      // Absent: no value was read back, so the reason reports none.
      expect(/[0-9]/.test(message.replaceAll(change.name, '')), message).toBe(false);
    } else {
      // The value ArduPilot holds (its float32 on the wire) and the generated one.
      expect(hasNumber(message, change.name, Math.fround(change.value)), message).toBe(true);
      expect(hasNumber(message, change.name, change.expected) || hasNumber(message, change.name, Math.fround(change.expected)), message).toBe(true);
    }
    expect(h.launcher.stops).toEqual([id]);
    expect(stoppedBeforeFailed(h)).toBe(true);
    // Never READY with a wrong parameter.
    expect(h.views.some(view => view.state.name === 'warming' || view.state.name === 'ready')).toBe(false);
  });

  test('no heartbeat within 60 s of wall time fails with no-heartbeat after stopping', async () => {
    expect(HEARTBEAT_DEADLINE_S).toBe(60);
    const h = harness();
    const id = await reach(h, 'connecting');
    status(h, { state: 'open', simTimeS: 0 });
    h.clock.advance(59_000);
    expect(h.controller.state).toMatchObject({ name: 'starting', step: 'connecting' });
    h.clock.advance(2_000);
    await settle();
    const state = failed(h);
    expect(state.reason).toEqual({ kind: 'no-heartbeat', seconds: 60 });
    expect(state.during).toBe('starting');
    expect(h.launcher.stops).toEqual([id]);
    expect(stoppedBeforeFailed(h)).toBe(true);
    expect(failureText(state.reason)).toContain('60 s');
  });

  test('a heartbeat before 60 s of wall time ends the heartbeat deadline', async () => {
    const h = harness();
    await reach(h, 'connecting');
    status(h, { state: 'open', simTimeS: 0 });
    h.clock.advance(59_000);
    status(h, { state: 'open', simTimeS: 0.1 });
    mav(h, heartbeat(STABILIZE, false));
    h.clock.advance(120_000);
    await settle();
    expect(h.controller.state.name).toBe('loading-parameters');
    expect(h.launcher.stops).toEqual([]);
    await h.controller.stop();
  });
});

// ---- Stop ---------------------------------------------------------------------------------------------

describe('user Stop', () => {
  test.each(STAGES)('from %s calls launcher.stop exactly once and ends idle', async stage => {
    const h = harness();
    const id = await reach(h, stage);
    const stopping = h.controller.stop();
    expect(h.controller.state).toEqual({ name: 'stopping', experimentId: id, cause: 'user' });
    await stopping;
    expect(h.controller.state.name).toBe('idle');
    expect(h.launcher.stops).toEqual([id]);
    expect(h.clock.intervals).toBe(0);
    expect(h.physics.disconnects).toBeGreaterThan(0);
    // Nothing later sends MAVLink, stops again or changes the state.
    const sent = h.physics.sent.length;
    h.clock.advance(5000);
    status(h, { state: 'closed', message: 'Bridge closed (1000: Session ended)' });
    await h.controller.stop();
    await settle();
    expect(h.physics.sent.length).toBe(sent);
    expect(h.launcher.stops).toEqual([id]);
    expect(h.controller.state.name).toBe('idle');
  });

  // The steps before the launcher answers: Stop must also cancel the start that is still under way.
  test.each(['prepare', 'firmware', 'physics'] as const)('during the %s step ends idle and SITL is never started', async step => {
    const gate = deferred<void>();
    const h = harness(step === 'prepare' ? async () => { await gate.promise; return prepared; } : undefined);
    if (step === 'firmware') h.launcher.catalogAnswer = async () => { await gate.promise; return [BUILD]; };
    if (step === 'physics') h.physics.loadAnswer = async () => { await gate.promise; return { betModuleSha256: BET_SHA }; };
    const starting = h.controller.start(h.request);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'starting', step });
    await h.controller.stop();
    expect(h.controller.state.name).toBe('idle');
    gate.resolve();
    await starting;
    await settle();
    expect(h.launcher.count('start')).toBe(0);
    expect(h.records.payloads).toEqual([]);
    expect(h.physics.connects).toEqual([]);
    expect(h.controller.state.name).toBe('idle');
  });

  test('while the launcher is starting SITL stops the run it then reports, exactly once, and ends idle', async () => {
    const h = harness();
    const answer = deferred<LauncherExperiment>();
    h.launcher.startAnswer = () => answer.promise;
    const starting = h.controller.start(h.request);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'starting', step: 'launcher' });
    const stopping = h.controller.stop();
    answer.resolve(h.launcher.launch());
    await Promise.all([starting, stopping]);
    await settle();
    // The launcher owns a run now; leaving it running would leave an owned process behind.
    expect(h.launcher.stops).toEqual([h.launcher.lastId]);
    expect(h.physics.connects).toEqual([]);
    expect(h.controller.state.name).toBe('idle');
  });

  test.each(['saved', 'not saved'] as const)('while the record is being written (%s afterwards) stops once and ends idle', async outcome => {
    const h = harness();
    const write = deferred<{ readonly sha256: string }>();
    h.records.answer = () => write.promise;
    const starting = h.controller.start(h.request);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'starting', step: 'record' });
    await h.controller.stop();
    expect(h.controller.state.name).toBe('idle');
    if (outcome === 'saved') write.resolve({ sha256: sha('record') }); else write.reject(new Error('QuotaExceededError'));
    await starting;
    await settle();
    expect(h.launcher.stops).toEqual([h.launcher.lastId]);
    expect(h.physics.connects).toEqual([]);
    expect(h.controller.state.name).toBe('idle');
  });

  test('a stop failure gives failed with restart stop-again; Stop again stops the same experiment and a new start works', async () => {
    const h = harness();
    const id = await reach(h, 'warming');
    h.launcher.stopAnswer = () => Promise.reject(new LauncherError('unreachable', 'No MirageSITL launcher answered on 127.0.0.1:47800'));
    await h.controller.stop();
    const state = failed(h);
    expect(state.reason.kind).toBe('stop-failed');
    // A user stop that failed keeps no prior cause: Stop again ends idle.
    expect(state.restart).toEqual({ kind: 'stop-again', experimentId: id, prior: null, during: 'stopping' });
    expect(h.controller.active).toBe(false);
    h.launcher.stopAnswer = null;
    await h.controller.stop();
    expect(h.launcher.stops).toEqual([id, id]);
    expect(h.controller.active).toBe(false);
    await h.controller.start(h.request);
    expect(h.launcher.count('start')).toBe(2);
    expect(h.controller.state).toMatchObject({ name: 'starting', step: 'connecting', experimentId: h.launcher.lastId });
    await h.controller.stop();
  });

  test('after a successful Stop again of a user stop the run ends idle', async () => {
    const user = harness();
    const id = await reach(user, 'ready');
    user.launcher.stopAnswer = () => Promise.reject(new LauncherError('unreachable', 'No MirageSITL launcher answered'));
    await user.controller.stop();
    user.launcher.stopAnswer = null;
    await user.controller.stop();
    expect(user.launcher.stops).toEqual([id, id]);
    // The user stopped the run and it is stopped now: idle, as after any completed user Stop.
    expect(user.controller.state.name).toBe('idle');
  });

  test('after a successful Stop again of a failure stop the failure keeps its cause and offers a plain restart', async () => {
    const lost = harness();
    const id = await reach(lost, 'ready');
    lost.launcher.stopAnswer = () => Promise.reject(new LauncherError('unreachable', 'No MirageSITL launcher answered'));
    status(lost, { state: 'closed', message: 'Bridge closed (1006)' });
    await settle();
    // The failure stop keeps the bridge loss as its prior cause for Stop again.
    expect(failed(lost).restart).toMatchObject({ kind: 'stop-again', experimentId: id, prior: { kind: 'bridge-lost' } });
    lost.launcher.stopAnswer = null;
    await lost.controller.stop();
    expect(lost.launcher.stops).toEqual([id, id]);
    const state = failed(lost);
    expect(state.reason.kind).toBe('bridge-lost');
    expect(state.restart).toEqual({ kind: 'start-again' });
  });

  test('a second Stop while stopping asks the launcher once', async () => {
    const h = harness();
    const id = await reach(h, 'flying');
    const answer = deferred<LauncherExperiment>();
    h.launcher.stopAnswer = () => answer.promise;
    const first = h.controller.stop(), second = h.controller.stop();
    expect(h.controller.state).toEqual({ name: 'stopping', experimentId: id, cause: 'user' });
    answer.resolve(h.launcher.view(id));
    await Promise.all([first, second]);
    expect(h.launcher.stops).toEqual([id]);
    expect(h.controller.state.name).toBe('idle');
  });
});

// ---- the DoD faults at the controller level -------------------------------------------------------

describe('fault injection on scripted ports', () => {
  test('missing binary: the launcher refuses the start with 409, nothing is stopped and no record is written', async () => {
    const h = harness();
    h.launcher.startAnswer = () => Promise.reject(new LauncherError('refused',
      `Firmware ${BUILD.id} cannot be started: Executable not admitted: ENOENT: no such file or directory`, 409));
    await h.controller.start(h.request);
    const state = failed(h);
    expect(state.reason.kind).toBe('launcher-refused');
    expect(failureText(state.reason)).toContain('ENOENT');
    expect(state.during).toBe('starting');
    expect(state.restart).toEqual({ kind: 'start-again' });
    expect(h.launcher.count('stop')).toBe(0);
    expect(h.records.payloads).toEqual([]);
    expect(h.physics.connects).toEqual([]);
    expect(h.clock.intervals).toBe(0);
    // The binary is back: a restart is a new experiment with its record.
    h.launcher.startAnswer = null;
    await restarted(h, 0);
  });

  test('missing binary seen in the catalog: fails with kind firmware before SITL is asked to start; a restart works once it is reinstalled', async () => {
    const h = harness();
    h.launcher.catalogAnswer = () => Promise.resolve([{ ...BUILD, usable: false, reason: 'Executable not admitted: ENOENT: no such file or directory' }]);
    await h.controller.start(h.request);
    const state = failed(h);
    expect(state.reason.kind).toBe('firmware');
    expect(failureText(state.reason)).toContain('ENOENT');
    expect(state.restart.kind).toBe('fix-first');
    expect(h.launcher.count('start')).toBe(0);
    expect(h.records.payloads).toEqual([]);
    h.launcher.catalogAnswer = () => Promise.resolve([BUILD]);
    await restarted(h, 0);
  });

  test('a 500 spawn failure naming its experiment: stopped, its logs read, launcher-refused, no record; a restart works', async () => {
    const h = harness();
    const id = experimentId(900);
    h.launcher.startAnswer = () => Promise.reject(new LauncherError('refused', 'SITL did not start: spawn EACCES', 500, id));
    h.launcher.stopAnswer = stopped => Promise.resolve({ id: stopped, state: 'start-failed', startError: 'SITL did not start: spawn EACCES', firmware: FIRMWARE,
      runs: [], ports: null });
    h.launcher.logsAnswer = () => Promise.resolve({ stdout: '', stderr: '', dataflash: [] });
    await h.controller.start(h.request);
    await settle();
    const state = failed(h);
    expect(state.reason.kind).toBe('launcher-refused');
    expect(failureText(state.reason)).toContain('EACCES');
    expect(h.launcher.stops).toEqual([id]);
    expect(stoppedBeforeFailed(h)).toBe(true);
    expect(h.launcher.count('logs')).toBe(1);
    expect(state.diagnostics).toMatchObject({ experimentId: id, launcherState: 'start-failed', exitCode: null, signal: null });
    expect(h.records.payloads).toEqual([]);
    expect(h.physics.connects).toEqual([]);
    expect(state.restart).toEqual({ kind: 'start-again' });
    h.launcher.startAnswer = null;
    h.launcher.stopAnswer = null;
    await restarted(h, 0);
  });

  test('a 201 view in state start-failed (defensive: the current launcher answers 500 instead) is stopped and shown as a refusal, with no record', async () => {
    const h = harness();
    const id = experimentId(901);
    h.launcher.startAnswer = () => Promise.resolve({ id, state: 'start-failed', startError: 'The bridge did not start: EADDRINUSE', firmware: FIRMWARE,
      runs: [], ports: null });
    h.launcher.stopAnswer = stopped => Promise.resolve({ id: stopped, state: 'start-failed', startError: 'The bridge did not start: EADDRINUSE',
      firmware: FIRMWARE, runs: [], ports: null });
    await h.controller.start(h.request);
    await settle();
    const state = failed(h);
    expect(state.reason.kind).toBe('launcher-refused');
    expect(failureText(state.reason)).toContain('EADDRINUSE');
    expect(h.launcher.stops).toEqual([id]);
    expect(stoppedBeforeFailed(h)).toBe(true);
    expect(h.records.payloads).toEqual([]);
    expect(h.physics.connects).toEqual([]);
  });

  test('busy port: the run crashes with exit code 1 and the bind failure; stop comes before failed and the diagnostics carry the stderr tail', async () => {
    const h = harness();
    const id = await reach(h, 'connecting');
    const bind = 'bind failed on port 5760 - Address already in use';
    h.launcher.end(id, 'crashed', 1, null, `exit code 1: ${bind}`);
    h.launcher.logsAnswer = () => Promise.resolve({ stdout: '', stderr: `${bind}\n`, dataflash: [] });
    status(h, { state: 'closed', message: 'Bridge closed (1006)' });
    await settle();
    const state = failed(h);
    expect(state.reason).toEqual({ kind: 'sitl-ended', during: 'starting', ending: `exit code 1: ${bind}` });
    expect(failureText(state.reason)).toContain(bind);
    expect(stoppedBeforeFailed(h)).toBe(true);
    expect(h.launcher.stops).toEqual([id]);
    expect(state.diagnostics).toMatchObject({ experimentId: id, launcherState: 'crashed', exitCode: 1, signal: null });
    expect(state.diagnostics?.stderr).toContain(bind);
    expect(state.restart).toEqual({ kind: 'start-again' });
    // The port is free again: a restart is a new experiment with its record.
    await restarted(h, 1);
  });

  test('crash during warmup: a closed bridge and a run killed by SIGKILL fail with sitl-ended during warming', async () => {
    const h = harness();
    const id = await reach(h, 'warming');
    h.launcher.end(id, 'crashed', null, 'SIGKILL', 'killed by SIGKILL');
    status(h, { state: 'closed', message: 'Bridge closed (1006)' });
    await settle();
    const state = failed(h);
    expect(state.reason).toEqual({ kind: 'sitl-ended', during: 'warming', ending: 'killed by SIGKILL' });
    expect(state.during).toBe('warming');
    expect(failureText(state.reason)).toContain('SIGKILL');
    expect(state.diagnostics).toMatchObject({ launcherState: 'crashed', exitCode: null, signal: 'SIGKILL', dataflash: ['00000001.BIN'] });
    expect(stoppedBeforeFailed(h)).toBe(true);
    expect(state.restart).toEqual({ kind: 'start-again' });
    await restarted(h, 1);
  });

  test('bridge loss: a closed bridge while the launcher still runs SITL fails with bridge-lost after stopping it', async () => {
    const h = harness();
    const id = await reach(h, 'ready');
    status(h, { state: 'closed', message: 'Bridge closed (1006)' });
    await settle();
    const state = failed(h);
    expect(state.reason.kind).toBe('bridge-lost');
    expect(state.during).toBe('ready');
    expect(h.launcher.count('experiment')).toBe(1);
    expect(h.launcher.stops).toEqual([id]);
    expect(stoppedBeforeFailed(h)).toBe(true);
    expect(state.diagnostics).toMatchObject({ experimentId: id, launcherState: 'stopped' });
    expect(h.clock.intervals).toBe(0);
    await restarted(h, 1);
  });

  test.each([
    ['bridge loss', 'bridge-lost', false],
    ['crash', 'sitl-ended', true],
  ] as const)('%s: the beat the Worker refuses while the launcher is asked does not replace the reason', async (_label, kind, crashed) => {
    const h = harness();
    const id = await reach(h, 'ready');
    if (crashed) h.launcher.end(id, 'crashed', null, 'SIGKILL', 'killed by SIGKILL');
    const answer = deferred<LauncherExperiment>();
    h.launcher.experimentAnswer = () => answer.promise;
    status(h, { state: 'closed', message: 'Bridge closed (1006)' });
    // The once-a-second ground-station beat falls inside the launcher round trip; the closed Worker refuses it.
    h.clock.advance(1000);
    await settle();
    answer.resolve(h.launcher.view(id));
    await settle();
    expect(failed(h).reason.kind).toBe(kind);
    expect(h.launcher.stops).toEqual([id]);
  });

  test('SITL restarting on its own fails with sitl-restarted after stopping', async () => {
    const h = harness();
    const id = await reach(h, 'flying');
    status(h, { state: 'fault', message: 'SITL restarted; start a new run' });
    await settle();
    expect(failed(h).reason.kind).toBe('sitl-restarted');
    expect(failed(h).during).toBe('running');
    expect(h.launcher.stops).toEqual([id]);
  });

  test('a Worker rejection of the connect fails with physics after stopping', async () => {
    const h = harness();
    const id = await reach(h, 'connecting');
    h.controller.worker({ type: 'sitl.reject', message: 'Configure the session for sitl-lockstep before connecting SITL' });
    await settle();
    const state = failed(h);
    expect(state.reason.kind).toBe('physics');
    expect(failureText(state.reason)).toContain('sitl-lockstep');
    expect(h.launcher.stops).toEqual([id]);
    expect(stoppedBeforeFailed(h)).toBe(true);
  });

  test.each([
    ['unreachable', 'launcher-unreachable'], ['foreign', 'launcher-foreign'],
  ] as const)('an %s launcher fails before anything starts, with a fix', async (kind, reason) => {
    const h = harness();
    h.launcher.catalogAnswer = () => Promise.reject(new LauncherError(kind, `Port 47800: ${kind}`));
    await h.controller.start(h.request);
    const state = failed(h);
    expect(state.reason.kind).toBe(reason);
    expect(state.restart.kind).toBe('fix-first');
    expect(h.launcher.count('start')).toBe(0);
    expect(h.launcher.count('stop')).toBe(0);
    expect(h.physics.connects).toEqual([]);
  });

  test('a record that cannot be saved stops the run before it connects', async () => {
    const h = harness();
    h.records.answer = () => Promise.reject(new Error('The project store is full'));
    await h.controller.start(h.request);
    await settle();
    const state = failed(h);
    expect(state.reason).toEqual({ kind: 'record', message: 'The project store is full' });
    expect(h.launcher.stops).toEqual([h.launcher.lastId]);
    expect(stoppedBeforeFailed(h)).toBe(true);
    expect(h.physics.connects).toEqual([]);
    expect(h.clock.intervals).toBe(0);
  });

  test('a profile with MirageSITL-owned sensor error terms fails with vehicle, naming them, before anything starts', async () => {
    const refused = await storedProfile(MIRAGE_OWNED);
    const h = harness(async () => (await preparedRun(refused.store, refused.stored)).run);
    await h.controller.start(h.request);
    const state = failed(h);
    expect(state.reason.kind).toBe('vehicle');
    const text = failureText(state.reason);
    expect(text).toContain('imu.accelBiasMps2');
    expect(text).toContain('battery.voltageOffsetV');
    expect(state.restart.kind).toBe('fix-first');
    expect(h.events.filter(event => event.startsWith('launcher.') || event.startsWith('physics.') || event === 'record.create')).toEqual([]);
  });

  test('a restart from failed is a new experiment with a new record, and the old run leaves nothing in the view', async () => {
    const h = harness();
    const first = await reach(h, 'climbing');
    mav(h, statusText('Arming motors'));
    status(h, { state: 'closed', message: 'Bridge closed (1006)' });
    await settle();
    expect(failed(h).reason.kind).toBe('bridge-lost');
    const firstRecord = h.controller.view.recordSha256;
    await h.controller.start(h.request);
    const second = h.launcher.lastId;
    expect(second).not.toBe(first);
    expect(h.launcher.count('start')).toBe(2);
    expect(h.records.payloads.map(payload => payload.launcher.experimentId)).toEqual([first, second]);
    expect(h.records.stored).toHaveLength(2);
    expect(h.controller.view.recordSha256).toBe(h.records.stored[1]?.sha256);
    expect(h.controller.view.recordSha256).not.toBe(firstRecord);
    expect(h.controller.state).toEqual({ name: 'starting', step: 'connecting', experimentId: second });
    expect(h.controller.view).toMatchObject({ armed: false, mode: null, statusText: [], status: null });
    expect(h.physics.connects.at(-1)).toEqual({ port: h.launcher.bridgeOf(second), bridgeEpoch: 1, speedup: 1 });
    status(h, { state: 'open', simTimeS: 0.2 });
    mav(h, heartbeat(STABILIZE, false));
    expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: second, received: 0 });
    await h.controller.stop();
    expect(h.launcher.stops).toEqual([first, second]);
  });

  test('a second start while active is ignored', async () => {
    const h = harness();
    await reach(h, 'warming');
    await h.controller.start(h.request);
    expect(h.launcher.count('start')).toBe(1);
    expect(h.records.payloads).toHaveLength(1);
    await h.controller.stop();
  });

  test('Worker events after a failure change neither the reason nor the launcher calls', async () => {
    const h = harness();
    const id = await reach(h, 'warming');
    h.launcher.end(id, 'crashed', null, 'SIGKILL', 'killed by SIGKILL');
    status(h, { state: 'closed', message: 'Bridge closed (1006)' });
    await settle();
    const before = failed(h), calls = h.events.filter(event => event.startsWith('launcher.')).length, sent = h.physics.sent.length;
    h.controller.worker({ type: 'sitl.reject', message: 'No open SITL session for MAVLink' });
    status(h, { state: 'fault', message: 'SITL restarted; start a new run' });
    status(h, { state: 'closed', message: 'Bridge closed (1000)' });
    mav(h, heartbeat(GUIDED, true), ...parameterList(h.run.parameters));
    h.clock.advance(10_000);
    await settle();
    expect(h.controller.state).toEqual(before);
    expect(h.events.filter(event => event.startsWith('launcher.')).length).toBe(calls);
    expect(h.physics.sent.length).toBe(sent);
  });
});

// ---- the real launcher ----------------------------------------------------------------------------

const ORIGIN = 'http://127.0.0.1:5173';
const scratch = mkdtempSync(join(tmpdir(), 'mirage-run-controller-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fake = writeFakeFirmware(scratch, { modeFile: join(scratch, 'fake-mode') });
const fakeDefaults = join(scratch, 'copter.parm');
writeFileSync(fakeDefaults, 'SYSID_THISMAV 1\n');
const fileSha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function entry(id: string, binary: string): FirmwareEntry {
  return { id, firmwareVersion: 'ArduCopter V4.8.0-dev', commit: SITL_COMMIT, binaryPath: binary, binarySha256: fileSha(binary),
    defaultParametersPath: fakeDefaults, defaultParametersSha256: fileSha(fakeDefaults) };
}
/** A copy of the fake wrapper under its own catalog ID, so a test may delete or chmod it. */
function copiedEntry(id: string): string {
  const path = join(scratch, `${id}-arducopter`);
  copyFileSync(fake.binary, path);
  chmodSync(path, 0o755);
  writeCatalogEntry(launcherHome, entry(id, path));
  return path;
}
/** Fakes are shell scripts; this admission accepts any executable regular file. */
const admitAny = (path: string) => readFileSync(path);
const launcherHome = join(scratch, 'home');
/** Where the launcher keeps an experiment's files (apps/launcher/src/server.ts: <home>/experiments/<id>). */
const workDirectory = (id: string) => join(launcherHome, 'experiments', id);
type Launcher = Awaited<ReturnType<typeof startLauncher>>;
let launcher: Launcher;
let token: string;
let nodeFetch: typeof fetch;

/** Members of a process group, from the process table. */
function groupMembers(pgid: number): number[] {
  const table = spawnSync('/bin/ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' }).stdout;
  return table.split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([pid, group]) => group === pgid && pid !== undefined)
    .map(([pid]) => pid ?? -1);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function listen(server: NetServer): Promise<number> {
  return new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('No TCP address'));
      else done(address.port);
    });
  });
}
const close = (server: { close(callback: () => void): unknown }) => new Promise<void>(done => { server.close(() => done()); });
/** A loopback port nothing listens on. */
async function freePort(): Promise<number> {
  const server = createHttpServer();
  const port = await listen(server);
  await close(server);
  return port;
}
async function experimentIds(client: LauncherClient): Promise<string[]> {
  const list = field(await client.call('GET', '/v1/status'), 'experiments');
  const items: readonly unknown[] = Array.isArray(list) ? list : [];
  return items.flatMap(item => {
    const id = field(item, 'id');
    return typeof id === 'string' ? [id] : [];
  });
}
async function rejection(action: () => Promise<unknown>): Promise<LauncherError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof LauncherError) return error;
    throw error;
  }
  throw new Error('The call did not fail');
}
const spec = (firmwareId = 'fake'): StartSpec => ({
  firmwareId, parameters: [{ name: 'FRAME_CLASS', value: 1 }, { name: 'FRAME_TYPE', value: 1 }], frameScript: null, speedup: 1, rateHz: 800, home: DEFAULT_HOME,
});
/** The build identity of a FirmwareEntry-shaped JSON value, without its machine paths. */
function identityOf(entryJson: unknown): Record<string, unknown> {
  return { id: field(entryJson, 'id'), firmwareVersion: field(entryJson, 'firmwareVersion'), commit: field(entryJson, 'commit'),
    binarySha256: field(entryJson, 'binarySha256'), defaultParametersSha256: field(entryJson, 'defaultParametersSha256') };
}
/** The SITL arguments the fake printed as its first stdout line. */
function sitlArguments(stdout: string): string[] {
  const first: unknown = JSON.parse(stdout.split('\n')[0] ?? '');
  const args = field(first, 'args');
  if (!Array.isArray(args)) throw new Error('The fake SITL printed no arguments');
  const list: readonly unknown[] = args;
  return list.map(arg => (typeof arg === 'string' ? arg : ''));
}
function argument(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** CORS-safelisted request headers (Fetch standard), which never need a preflight. */
function safelisted(name: string, value: string): boolean {
  if (['accept', 'accept-language', 'content-language'].includes(name)) return true;
  const type = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return name === 'content-type' && ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].includes(type);
}
/**
 * fetch as Chrome runs it for a page on ORIGIN (Fetch standard, CORS): the
 * request carries the page's Origin; a request with a header that is not
 * safelisted (here Authorization, and Content-Type application/json) is
 * preceded by an OPTIONS preflight, which must answer 2xx with
 * Access-Control-Allow-Origin naming the page and Access-Control-Allow-Headers
 * listing each such header (a wildcard never covers Authorization); and the
 * response itself must carry Access-Control-Allow-Origin. Otherwise the fetch
 * rejects with a TypeError, and the page reads neither status nor body.
 */
async function browserFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  const unsafe = [...headers.keys()].filter(name => !safelisted(name, headers.get(name) ?? '')).sort();
  const allows = (response: Response) => {
    const allowed = response.headers.get('access-control-allow-origin');
    return allowed === ORIGIN || allowed === '*';
  };
  if (unsafe.length > 0) {
    const preflight = await nodeFetch(url, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': init?.method ?? 'GET',
      'access-control-request-headers': unsafe.join(',') } });
    await preflight.arrayBuffer();
    const listed = (preflight.headers.get('access-control-allow-headers') ?? '').split(',').map(name => name.trim().toLowerCase());
    const covered = (name: string) => listed.includes(name) || (name !== 'authorization' && listed.includes('*'));
    if (!preflight.ok || !allows(preflight) || !unsafe.every(covered)) throw new TypeError('Failed to fetch');
  }
  headers.set('origin', ORIGIN);
  const response = await nodeFetch(url, { ...init, headers });
  if (!allows(response)) {
    await response.arrayBuffer();
    throw new TypeError('Failed to fetch');
  }
  return response;
}
/** Another program on a port: an HTML page or a JSON API, with or without CORS for the page's origin. */
async function foreignServer(kind: 'html' | 'json', cors: boolean): Promise<{ readonly port: number; close(): Promise<void> }> {
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const allow = cors ? { 'access-control-allow-origin': ORIGIN } : {};
    if (request.method === 'OPTIONS') {
      // A permissive preflight answer: every origin, method and header the page asks for.
      response.writeHead(cors ? 204 : 200, cors ? { ...allow, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type' }
        : { 'content-type': 'text/html' });
      response.end(cors ? undefined : '<html>another program</html>');
      return;
    }
    request.resume();
    if (kind === 'html') {
      response.writeHead(200, { ...allow, 'content-type': 'text/html' });
      response.end('<html>another program</html>');
    } else {
      response.writeHead(200, { ...allow, 'content-type': 'application/json' });
      response.end('{"service":"other"}');
    }
  });
  const port = await listen(server);
  return { port, close: () => close(server) };
}

/**
 * The physics port of the real-launcher tests. Like the Worker's connectSitl
 * (apps/web/src/physics.worker.ts), connect opens a real WebSocket to the
 * run's bridge with the launcher token as a subprotocol and the page's
 * Origin, and the Worker's open and closed statuses come from that socket's
 * own events, so a bridge the launcher closes, or that closed before the
 * client reached it, reaches the controller as it would in the browser.
 */
class BridgePhysics extends ScriptedPhysics {
  private socket: WebSocket | null = null;
  readonly closeCodes: number[] = [];
  override connect(port: number, bridgeEpoch: number, speedup: number): void {
    super.connect(port, bridgeEpoch, speedup);
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, ['mirage-v1', `session.${token}`], { origin: ORIGIN });
    this.socket = socket;
    // A refused connection also ends in 'close'.
    socket.on('error', () => undefined);
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.bridge = 'open';
      this.deliver({ ...BASE_STATUS, state: 'open' });
    });
    socket.on('close', code => {
      this.closeCodes.push(code);
      if (this.socket === socket) {
        this.socket = null;
        this.bridge = 'closed';
      }
      this.deliver({ ...BASE_STATUS, state: 'closed', message: `Bridge closed (${code})` });
    });
  }
  override disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    super.disconnect();
    socket?.close(1000, 'Session ended');
  }
}

describe('the real launcher with the fake SITL', () => {
  beforeAll(async () => {
    nodeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', browserFetch);
    token = ensureToken(launcherHome);
    writeCatalogEntry(launcherHome, entry('fake', fake.binary));
    launcher = await startLauncher({ home: launcherHome, origin: ORIGIN, port: 0, python: '/nonexistent/python', admit: admitAny });
  });
  // A failed assertion must not leave a fake SITL running into the next test (which would then get 409).
  afterEach(async () => {
    const owner = new LauncherClient(launcher.port, token);
    for (const id of await experimentIds(owner)) {
      const state = (await owner.experiment(id)).state;
      if (state === 'running' || state === 'stopping' || state === 'starting') await owner.stop(id);
    }
  });
  afterAll(async () => {
    await launcher.close();
    vi.unstubAllGlobals();
  });

  describe('LauncherClient', () => {
    test('refuses an invalid port or token before any request', () => {
      expect(() => new LauncherClient(0, token)).toThrow();
      expect(() => new LauncherClient(65536, token)).toThrow();
      expect(() => new LauncherClient(47800, token.toUpperCase())).toThrow();
      expect(() => new LauncherClient(47800, `${token}0`)).toThrow();
    });

    test('lists the catalog, parses a started experiment view, its logs and its stop', async () => {
      const client = new LauncherClient(launcher.port, token);
      expect(await client.catalog()).toContainEqual({ id: 'fake', firmwareVersion: 'ArduCopter V4.8.0-dev', usable: true, reason: null });
      fake.setMode('idle');
      const started = await client.start(spec());
      expect(started.id).toMatch(/^[0-9]{17}-[0-9a-f]{8}$/);
      expect(started.state).toBe('running');
      expect(started.startError).toBeNull();
      // The build identity is what the launcher recorded for the experiment, without its paths, and its hash is the executed file's.
      const recorded = field(readJson(join(workDirectory(started.id), 'experiment.json')), 'firmware');
      expect(started.firmware).toEqual(identityOf(recorded));
      expect(field(recorded, 'binaryPath')).toBe(fake.binary);
      expect(started.firmware.binarySha256).toBe(fileSha(fake.binary));
      expect(started.firmware.defaultParametersSha256).toBe(fileSha(fakeDefaults));
      expect(started.firmware).toEqual(identityOf(readCatalog(launcherHome).find(item => item.id === 'fake')));
      expect(started.runs).toHaveLength(1);
      const run = started.runs[0];
      expect(run).toMatchObject({ run: 1, state: 'running', exitCode: null, signal: null, reason: null });
      // The PID is the owner record's, and it leads its own process group.
      const owner = readJson(join(workDirectory(started.id), 'owner-1.json'));
      expect(run?.pid).toBe(field(owner, 'pid'));
      expect(field(owner, 'processGroup')).toBe(run?.pid);
      expect(groupMembers(run?.pid ?? -1)).toContain(run?.pid);
      // The bridge port is the raw answer's.
      const raw = await client.call('GET', `/v1/experiments/${started.id}`);
      expect(started.ports?.bridge).toBe(field(field(raw, 'ports'), 'bridge'));
      expect(Number.isInteger(started.ports?.bridge)).toBe(true);
      await until(async () => (await client.logs(started.id)).stdout.includes('--model'), 5000, 'the fake SITL arguments');
      expect((await client.logs(started.id)).dataflash).toEqual(['00000001.BIN']);
      const stopped = await client.stop(started.id);
      expect(stopped.state).toBe('stopped');
      expect(stopped.runs[0]).toMatchObject({ state: 'stopped', reason: null });
      expect(stopped.ports).toBeNull();
      expect(alive(run?.pid ?? -1)).toBe(false);
    });

    test('a missing binary: the catalog marks it unusable and a start is refused with 409 and no experiment', async () => {
      const client = new LauncherClient(launcher.port, token);
      const binary = copiedEntry('deleted');
      rmSync(binary);
      const listed = (await client.catalog()).find(item => item.id === 'deleted');
      expect(listed?.usable).toBe(false);
      expect(listed?.reason).toContain('ENOENT');
      const before = await experimentIds(client);
      const error = await rejection(() => client.start(spec('deleted')));
      expect(error.kind).toBe('refused');
      expect(error.status).toBe(409);
      expect(error.experimentId).toBeNull();
      expect(error.message).toMatch(/^Firmware deleted cannot be started: Executable not admitted: ENOENT/);
      expect(await experimentIds(client)).toEqual(before);
    });

    test('a spawn failure is refused with 500 and names the experiment, whose view parses as start-failed', async () => {
      const client = new LauncherClient(launcher.port, token);
      chmodSync(copiedEntry('unexecutable'), 0o644);
      const error = await rejection(() => client.start(spec('unexecutable')));
      expect(error.kind).toBe('refused');
      expect(error.status).toBe(500);
      expect(error.message).toMatch(/^SITL did not start: .*EACCES/);
      const id = error.experimentId;
      if (id === null) throw new Error('The 500 answer names no experiment');
      expect(await client.experiment(id)).toMatchObject({ id, state: 'start-failed', runs: [], ports: null });
      expect((await client.experiment(id)).startError).toMatch(/EACCES/);
    });

    test('a wrong token and a second start while one runs are refusals with their status', async () => {
      const wrong = new LauncherClient(launcher.port, 'b'.repeat(64));
      expect(await rejection(() => wrong.catalog())).toMatchObject({ kind: 'refused', status: 401 });
      const client = new LauncherClient(launcher.port, token);
      fake.setMode('idle');
      const running = await client.start(spec());
      try {
        const second = await rejection(() => client.start(spec()));
        expect(second).toMatchObject({ kind: 'refused', status: 409, message: 'Another experiment is running; stop it first' });
      } finally {
        await client.stop(running.id);
      }
    });

    test('no program on the port reads as unreachable', async () => {
      const port = await freePort();
      const client = new LauncherClient(port, token);
      expect((await rejection(() => client.catalog())).kind).toBe('unreachable');
      expect((await rejection(() => client.start(spec()))).kind).toBe('unreachable');
      expect((await rejection(() => client.catalog())).message).toContain(String(port));
    });

    test('another program on the port that answers the page (CORS) reads as foreign', async () => {
      const html = await foreignServer('html', true), json = await foreignServer('json', true);
      try {
        const page = await rejection(() => new LauncherClient(html.port, token).catalog());
        expect(page.kind).toBe('foreign');
        expect(page.message).toContain(String(html.port));
        expect((await rejection(() => new LauncherClient(html.port, token).start(spec()))).kind).toBe('foreign');
        expect((await rejection(() => new LauncherClient(json.port, token).catalog())).kind).toBe('foreign');
        expect((await rejection(() => new LauncherClient(json.port, token).experiment(experimentId(1)))).kind).toBe('foreign');
      } finally {
        await html.close();
        await json.close();
      }
    });

    test('another program without CORS reads as unreachable, as Chrome hides its answer from the page, and the message names the port', async () => {
      // The preflight that Authorization requires fails, so the browser rejects the fetch as it does a refused connection.
      const html = await foreignServer('html', false), json = await foreignServer('json', false);
      try {
        for (const server of [html, json]) {
          const error = await rejection(() => new LauncherClient(server.port, token).catalog());
          expect(error.kind).toBe('unreachable');
          expect(error.message).toContain(String(server.port));
        }
      } finally {
        await html.close();
        await json.close();
      }
    });

    test('parseLauncherExperiment refuses answers that are not a launcher view', () => {
      const valid = { id: experimentId(7), state: 'running', startError: null, firmware: { ...FIRMWARE }, runs: [{ run: 1, pid: 99, state: 'running',
        exitCode: null, signal: null, reason: null }], ports: { bridge: 5000 } };
      expect(parseLauncherExperiment(valid)).toEqual({ ...valid, firmware: FIRMWARE });
      for (const bad of [null, 'text', { ...valid, runs: undefined }, { ...valid, state: 'flying' }, { ...valid, id: 7 },
        { ...valid, runs: [{ run: 1, state: 'running' }] }, { ...valid, firmware: { id: 'x' } }]) {
        let error: unknown = null;
        try { parseLauncherExperiment(bad); } catch (cause) { error = cause; }
        expect(error instanceof LauncherError && error.kind === 'foreign', JSON.stringify(bad)).toBe(true);
      }
    });
  });

  describe('SessionController on the real launcher', () => {
    function realHarness(client: LauncherPort): Harness {
      const events: string[] = [], views: ControllerView[] = [];
      const counted: LauncherPort = {
        catalog: () => { events.push('launcher.catalog'); return client.catalog(); },
        start: spec => { events.push('launcher.start'); return client.start(spec); },
        stop: id => { events.push(`launcher.stop ${id}`); return client.stop(id); },
        experiment: id => { events.push('launcher.experiment'); return client.experiment(id); },
        logs: id => { events.push('launcher.logs'); return client.logs(id); },
      };
      const physics = new BridgePhysics(events), clock = new FakeClock(), records = new StoreRecords(fixture, events);
      const controller = new SessionController(counted, physics, records, clock, view => {
        views.push(view);
        if (events.at(-1) !== `state:${view.state.name}`) events.push(`state:${view.state.name}`);
      });
      physics.deliver = data => { controller.worker(data); };
      const request: StartRequest = { prepare: () => Promise.resolve(prepared), firmwareId: 'fake', speedup: 1, physicsHz: 800, home: DEFAULT_HOME };
      // ScriptedLauncher is only used for its event counting here.
      return { controller, launcher: new ScriptedLauncher(events), physics, clock, records, events, views, request, run: prepared };
    }
    const client = () => new LauncherClient(launcher.port, token);
    const stopCalls = (h: Harness) => h.events.filter(event => event.startsWith('launcher.stop'));
    async function runPid(id: string): Promise<number> {
      const pid = (await client().experiment(id)).runs.at(-1)?.pid;
      if (pid === undefined) throw new Error(`Experiment ${id} has no run`);
      return pid;
    }
    /** Waits until the fake SITL runs its mode (it prints a heartbeat line every 100 ms), so its signal handlers are installed. */
    async function sitlUp(id: string): Promise<void> {
      await until(async () => (await client().logs(id)).stdout.includes('fake sitl alive'), 5000, 'the fake SITL to run');
    }
    /** The /bin/sleep grandchild of a fake SITL in mode fork, once it is in the run's process group. */
    async function grandchildOf(id: string): Promise<number> {
      const path = join(workDirectory(id), 'grandchild.pid');
      await until(() => existsSync(path) && /^[0-9]+$/.test(readFileSync(path, 'utf8').trim()), 5000, 'the grandchild PID');
      return Number(readFileSync(path, 'utf8').trim());
    }
    async function connectedId(h: Harness, firmwareId = 'fake'): Promise<string> {
      await h.controller.start({ ...h.request, firmwareId });
      const state = h.controller.state;
      if (state.name !== 'starting' || state.step !== 'connecting' || state.experimentId === null) {
        throw new Error(`Not connecting: ${JSON.stringify(state)}`);
      }
      return state.experimentId;
    }
    /** The run's bridge socket open, then ArduCopter's heartbeat and its whole parameter list. */
    async function warm(h: Harness): Promise<void> {
      await until(() => h.physics.bridge === 'open', 5000, 'the bridge socket to open');
      status(h, { state: 'open', simTimeS: 0.4 });
      mav(h, heartbeat(STABILIZE, false), ...parameterList(prepared.parameters));
      expect(h.controller.state.name).toBe('warming');
    }
    /** A restart from failed on the real launcher: a new experiment (no 409) with a new record; then a user Stop that leaves no process. */
    async function restartAndStop(h: Harness, earlier: readonly string[], firmwareId = 'fake'): Promise<void> {
      fake.setMode('idle');
      const before = await experimentIds(client());
      const id = await connectedId(h, firmwareId);
      expect(earlier).not.toContain(id);
      expect(await experimentIds(client())).toEqual([...before, id]);
      expect(h.records.payloads.map(payload => payload.launcher.experimentId)).toEqual([...earlier, id]);
      expect(h.records.stored).toHaveLength(earlier.length + 1);
      await warm(h);
      const pid = await runPid(id);
      await h.controller.stop();
      expect(h.controller.state.name).toBe('idle');
      expect((await client().experiment(id)).state).toBe('stopped');
      expect(alive(pid)).toBe(false);
      expect(groupMembers(pid)).toEqual([]);
    }

    test('missing binary between the catalog and the start: launcher-refused, no record and no new launcher experiment; reinstalled, a restart works', async () => {
      const binary = copiedEntry('vanishing');
      const h = realHarness(client());
      const before = await experimentIds(client());
      h.physics.loadAnswer = () => { rmSync(binary); return Promise.resolve({ betModuleSha256: BET_SHA }); };
      await h.controller.start({ ...h.request, firmwareId: 'vanishing' });
      const state = failed(h);
      expect(state.reason.kind).toBe('launcher-refused');
      expect(failureText(state.reason)).toMatch(/Executable not admitted: ENOENT/);
      expect(stopCalls(h)).toEqual([]);
      expect(h.records.payloads).toEqual([]);
      expect(await experimentIds(client())).toEqual(before);
      copiedEntry('vanishing');
      h.physics.loadAnswer = () => Promise.resolve({ betModuleSha256: BET_SHA });
      await restartAndStop(h, [], 'vanishing');
    }, 20000);

    test('a spawn failure (500 with its experiment): the controller stops it, reads its logs and shows launcher-refused with no record; fixed, a restart works', async () => {
      const binary = copiedEntry('noexec');
      chmodSync(binary, 0o644);
      const h = realHarness(client());
      await h.controller.start({ ...h.request, firmwareId: 'noexec' });
      const state = failed(h);
      expect(state.reason.kind).toBe('launcher-refused');
      expect(failureText(state.reason)).toMatch(/EACCES/);
      const id = state.diagnostics?.experimentId;
      if (id === undefined) throw new Error('No diagnostics for the spawn failure');
      expect((await client().experiment(id)).state).toBe('start-failed');
      expect(stopCalls(h)).toEqual([`launcher.stop ${id}`]);
      expect(stoppedBeforeFailed(h)).toBe(true);
      expect(h.events).toContain('launcher.logs');
      expect(state.diagnostics).toMatchObject({ launcherState: 'start-failed', exitCode: null, signal: null });
      expect(h.records.payloads).toEqual([]);
      expect(h.physics.connects).toEqual([]);
      chmodSync(binary, 0o755);
      await restartAndStop(h, [], 'noexec');
    }, 20000);

    test('busy port: SITL fails to bind a held port; the closed bridge gives sitl-ended with exit code 1, no process is left, and a restart works once the port is free', async () => {
      const holder = createTcpServer();
      const port = await listen(holder);
      try {
        fake.setMode(`bind-busy ${port}`);
        const h = realHarness(client());
        const id = await connectedId(h);
        const pid = await runPid(id);
        // No status is injected: the closed status comes from the bridge socket, which the launcher closes when SITL exits.
        await until(() => h.controller.state.name === 'failed', 10000, 'failed');
        const state = failed(h);
        const bind = `bind failed on port ${port} - Address already in use`;
        expect(state.reason).toEqual({ kind: 'sitl-ended', during: 'starting', ending: `exit code 1: ${bind}` });
        expect(failureText(state.reason)).toContain(bind);
        expect(stoppedBeforeFailed(h)).toBe(true);
        expect(state.diagnostics).toMatchObject({ experimentId: id, launcherState: 'crashed', exitCode: 1, signal: null });
        expect(state.diagnostics?.stderr).toContain(bind);
        expect(alive(pid)).toBe(false);
        expect(groupMembers(pid)).toEqual([]);
        // The held port still belongs to its holder.
        expect(holder.listening).toBe(true);
        expect(h.records.payloads.map(payload => payload.launcher.experimentId)).toEqual([id]);
        await close(holder);
        await restartAndStop(h, [id]);
      } finally {
        await close(holder);
      }
    }, 30000);

    test('crash during warmup: SIGKILL of SITL closes its bridge and gives sitl-ended during warming; its grandchild is reaped; the restart is a new experiment', async () => {
      fake.setMode('fork');
      const h = realHarness(client());
      const first = await connectedId(h);
      await warm(h);
      const pid = await runPid(first);
      const grandchild = await grandchildOf(first);
      // The group really holds SITL and its descendant before the fault.
      expect(groupMembers(pid)).toEqual(expect.arrayContaining([pid, grandchild]));
      process.kill(pid, 'SIGKILL');
      await until(() => h.controller.state.name === 'failed', 10000, 'failed');
      const state = failed(h);
      // RunInfo.reason: "killed by SIGNAL", then ": " and the last stderr line.
      expect(state.reason).toEqual({ kind: 'sitl-ended', during: 'warming', ending: 'killed by SIGKILL: fake sitl diagnostics' });
      expect(state.diagnostics).toMatchObject({ experimentId: first, launcherState: 'crashed', exitCode: null, signal: 'SIGKILL', dataflash: ['00000001.BIN'] });
      expect(state.diagnostics?.stderr).toContain('fake sitl diagnostics');
      expect(state.diagnostics?.stdout).toContain('--model');
      expect(stoppedBeforeFailed(h)).toBe(true);
      await until(() => !alive(grandchild), 5000, 'the grandchild to end');
      await until(() => groupMembers(pid).length === 0, 5000, 'an empty process group');
      await restartAndStop(h, [first]);
    }, 30000);

    test('bridge loss: closeBridge while SITL runs gives bridge-lost; the controller stops SITL, no process is left, and a restart works', async () => {
      fake.setMode('idle');
      const h = realHarness(client());
      const id = await connectedId(h);
      await warm(h);
      status(h, { ready: true, reason: '', simTimeS: 41 });
      expect(h.controller.state.name).toBe('ready');
      const pid = await runPid(id);
      await sitlUp(id);
      expect(groupMembers(pid)).toContain(pid);
      expect(await launcher.closeBridge(id)).toBe(true);
      // The closed status comes from the bridge socket that closeBridge ended.
      await until(() => h.controller.state.name === 'failed', 10000, 'failed');
      const state = failed(h);
      expect(state.reason.kind).toBe('bridge-lost');
      expect(state.during).toBe('ready');
      expect(stoppedBeforeFailed(h)).toBe(true);
      expect(state.diagnostics).toMatchObject({ experimentId: id, launcherState: 'stopped' });
      // SITL was still running when the controller stopped it: the fake saw the launcher's SIGTERM.
      expect(state.diagnostics?.stdout).toContain('received SIGTERM');
      expect(alive(pid)).toBe(false);
      expect(groupMembers(pid)).toEqual([]);
      await restartAndStop(h, [id]);
    }, 30000);

    test('the record holds what the launcher really used: experiment.parm, the build of experiment.json, the hashes of the files SITL ran and its arguments', async () => {
      fake.setMode('idle');
      const h = realHarness(client());
      const id = await connectedId(h);
      const payload = h.records.payloads[0];
      if (!payload) throw new Error('No record payload');
      expect(validateExperiment(payload)).toEqual(payload);
      // Every parameter SITL loaded from experiment.parm, in order and as numbers, is in the record, and nothing else.
      const parm = readFileSync(join(workDirectory(id), 'experiment.parm'), 'utf8').split('\n').filter(line => line !== '').map(line => {
        const [name, value] = line.split(' ');
        return { name, value: Number(value) };
      });
      expect(parm.length).toBe(prepared.parameters.length);
      expect(payload.parameters.map(p => ({ name: p.name, value: p.value }))).toEqual(parm);
      // The build is the one the launcher recorded and ran.
      const recorded = field(readJson(join(workDirectory(id), 'experiment.json')), 'firmware');
      const identity = identityOf(recorded);
      expect(payload.ardupilot).toEqual({ catalogId: identity.id, firmwareVersion: identity.firmwareVersion, commit: identity.commit,
        binarySha256: identity.binarySha256, defaultParametersSha256: identity.defaultParametersSha256 });
      expect(payload.ardupilot.binarySha256).toBe(fileSha(fake.binary));
      expect(payload.ardupilot.defaultParametersSha256).toBe(fileSha(fakeDefaults));
      expect(payload.ardupilot.commit).toBe(SITL_COMMIT);
      // And the installed catalog entry of that build.
      expect(identity).toEqual(identityOf(readCatalog(launcherHome).find(item => item.id === 'fake')));
      // The arguments SITL got: those defaults and that parameter file, the session's rate, speed-up and home.
      await until(async () => (await client().logs(id)).stdout.includes('--model'), 5000, 'the fake SITL arguments');
      const args = sitlArguments((await client().logs(id)).stdout);
      expect(argument(args, '--defaults')).toBe(`${fakeDefaults},${join(workDirectory(id), 'experiment.parm')}`);
      expect(argument(args, '--rate')).toBe(String(payload.session.physicsHz));
      expect(argument(args, '--speedup')).toBe(String(payload.session.speedup));
      expect(argument(args, '--home')).toBe(payload.session.home.join(','));
      const script = join(workDirectory(id), 'scripts', 'frame.lua');
      if (payload.frameScript === null) expect(existsSync(script)).toBe(false);
      else expect(readFileSync(script, 'utf8')).toBe(payload.frameScript);
      await h.controller.stop();
      expect(h.controller.state.name).toBe('idle');
    }, 20000);

    test('a user Stop in flight stops the owned process group, descendants included', async () => {
      fake.setMode('fork');
      const h = realHarness(client());
      const id = await connectedId(h);
      await warm(h);
      status(h, { ready: true, reason: '', simTimeS: 41 });
      expect(h.controller.takeOff(TAKEOFF_M)).toBe(true);
      const pid = await runPid(id);
      const grandchild = await grandchildOf(id);
      expect(groupMembers(pid)).toEqual(expect.arrayContaining([pid, grandchild]));
      await h.controller.stop();
      expect(h.controller.state.name).toBe('idle');
      expect(stopCalls(h)).toEqual([`launcher.stop ${id}`]);
      expect((await client().experiment(id)).runs.at(-1)).toMatchObject({ state: 'stopped', reason: null });
      expect(alive(pid)).toBe(false);
      await until(() => !alive(grandchild), 5000, 'the grandchild to end');
      await until(() => groupMembers(pid).length === 0, 5000, 'an empty process group');
    }, 20000);

    test('a foreign program or nothing on the launcher port fails before any start', async () => {
      const html = await foreignServer('html', true);
      try {
        const foreign = realHarness(new LauncherClient(html.port, token));
        await foreign.controller.start(foreign.request);
        expect(failed(foreign).reason.kind).toBe('launcher-foreign');
        expect(failureText(failed(foreign).reason)).toContain(String(html.port));
        expect(failed(foreign).restart.kind).toBe('fix-first');
        expect(foreign.events.filter(event => event.startsWith('launcher.') && event !== 'launcher.catalog')).toEqual([]);
      } finally {
        await html.close();
      }
      const port = await freePort();
      const nothing = realHarness(new LauncherClient(port, token));
      await nothing.controller.start(nothing.request);
      expect(failed(nothing).reason.kind).toBe('launcher-unreachable');
      expect(failureText(failed(nothing).reason)).toContain(String(port));
      expect(nothing.events.filter(event => event.startsWith('launcher.') && event !== 'launcher.catalog')).toEqual([]);
    });
  });
});
