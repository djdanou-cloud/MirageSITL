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
  type ConnectionSpec, type ControllerView, type LauncherConnection, type LauncherExperiment, type LauncherFirmware, type LauncherLogs,
  type LauncherPort, type LauncherRun, type LauncherRunState, type PhysicsPort, type PreparedRun, type RecordingPort, type RecordingStart, type RecordPort,
  type RunState, type StartRequest, type StartSpec, MANUAL_RATE_HZ, type PilotInputPort, type TerrainChunk,
  type FlightTruth,
} from '../apps/web/src/run/session-controller.ts';
import { initialEffectParameters, type EffectControl, type EffectRecovery, type PilotInput } from '../packages/protocol/src/index.ts';
import { parseFaultSchedule, type FaultSchedule } from '../packages/scenarios/src/fault-schedule.ts';
import { weatherSchedule } from '../packages/scenarios/src/weather-schedule.ts';
import type { ExperimentRecording } from '../packages/aircraft/src/experiment.ts';
import type { MavFrame } from '../packages/mavlink/src/codec.ts';
import type { AccidentEvent } from '../packages/physics/src/accident.ts';
import type { SitlStatus } from '../apps/web/src/sitl/bridge-client.ts';
import { parseFlightTask, type FlightTaskDefinition, type FlightTaskStep } from '../packages/scenarios/src/flight-tasks.ts';
import { siteParameters } from '@mirage/aircraft/site-parameters';
import { DEFAULT_HOME, LauncherClient, parseLauncherExperiment, preparedRun } from '../apps/web/src/sitl/sitl-run.ts';
import { validateComponentCard } from '../packages/aircraft/src/components.ts';
import {
  createExperimentRecord, experimentRecordName, readExperiment, validateExperiment, type ExperimentPayload, type LauncherSitl,
} from '../packages/aircraft/src/experiment.ts';
import { profileDraft, validateAircraftProfile, withSensorConfiguration } from '../packages/aircraft/src/profile.ts';
import { DEFAULT_SENSOR_CONFIGURATION, type SensorConfiguration } from '../packages/aircraft/src/sensor-fields.ts';
import { sensorSnapshot } from '../packages/aircraft/src/sensor-ownership.ts';
import { definition, encodeInto, MavParser } from '../packages/mavlink/src/codec.ts';
import { fieldOf, packInto, readNumber, readText, type FieldValue } from '../packages/mavlink/src/messages.ts';
import { parseParameterMetadata, type ParameterMetadataCatalog } from '../packages/autopilot/src/param-metadata.ts';
import { canonicalBytes, type StoredVersion } from '../packages/project/src/schema.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';
import { writeFakeFirmware } from './support/fake-firmware.ts';
import { exampleCard, quadProfile } from './support/quad-profile.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** The launcher-owned SITL of a record payload. */
function owned(payload: ExperimentPayload | undefined): LauncherSitl {
  if (payload?.sitl.ownership !== 'launcher') throw new Error('The record is not of a launcher-owned SITL');
  return payload.sitl;
}
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
const HEARTBEAT = 0, PARAM_REQUEST_READ = 20, PARAM_REQUEST_LIST = 21, PARAM_VALUE = 22, COMMAND_LONG = 76, COMMAND_ACK = 77, STATUSTEXT = 253;
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
/** One message of a requested stream as ArduCopter sends it: EKF_STATUS_REPORT, GPS_RAW_INT or GLOBAL_POSITION_INT. */
/** Degrees of latitude per metre on the sphere the controller's home check uses; the tests work out where a fix lies apart from it. */
const DEGREES_PER_METRE = 180 / (Math.PI * 6371008.8);
/** A stream message; a GPS fix stands where the physics stands the aircraft, at the pad or at a flight task's ground start. */
function streamMessage(id: 193 | 24 | 33, start: { readonly northM: number; readonly eastM: number } = { northM: 0, eastM: 0 }): Uint8Array {
  switch (id) {
    case 193: return autopilotFrame(193, { velocity_variance: 0.1, pos_horiz_variance: 0.1, pos_vert_variance: 0.1, compass_variance: 0.1, terrain_alt_variance: 0, flags: 1 | 2 | 4 | 16 | 32 });
    case 24: return autopilotFrame(24, { time_usec: 1000000, fix_type: 3, lat: -353632610 + Math.round(start.northM * DEGREES_PER_METRE * 1e7), lon: 1491652300 + Math.round(start.eastM * DEGREES_PER_METRE / Math.cos(-35.363261 * Math.PI / 180) * 1e7), alt: 584000, eph: 100, epv: 100, vel: 0, cog: 0, satellites_visible: 10 });
    case 33: return autopilotFrame(33, { time_boot_ms: 1000, lat: -353632610, lon: 1491652300, alt: 584000, relative_alt: 0, vx: 0, vy: 0, vz: 0, hdg: 0 });
  }
}
function statusText(text: string): Uint8Array {
  return autopilotFrame(STATUSTEXT, { severity: 6, text });
}
/** Parameters the autopilot holds besides the generated ones (copter.parm and the build's own). */
const OTHER_PARAMETERS: readonly (readonly [string, number])[] = [
  // What a flight task's targets stay within: ArduCopter's defaults at the pinned commit.
  ['WP_ACC_Z', 1], ['PSC_D_JERK', 5], ['PSC_NE_JERK', 5], ['ATC_ACC_Y_MAX', 270],
  // What jamming writes (TASK-169), at their defaults; a run's generated list holds the magnetometer offsets.
  ['SIM_GPS1_NUMSATS', 10], ['SIM_GPS1_ACC', 0.3],
  // ArduPilot's own fault parameters (TASK-168), at their defaults. SIM_BAR3_FREEZE is left out for the test of an incomplete list.
  ['SIM_BARO_DISABLE', 0], ['SIM_BAR2_DISABLE', 0], ['SIM_BAR3_DISABLE', 0], ['SIM_GPS1_LCKTIME', 0], ['SIM_BARO_FREEZE', 0], ['SIM_BAR2_FREEZE', 0],
  ['SYSID_THISMAV', 1], ['FS_GCS_ENABLE', 0], ['ARMING_CHECK', 1]];
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

  // A SITL the user started (TASK-155): connections the scripted launcher opens, polls and releases.
  readonly connectSpecs: ConnectionSpec[] = [];
  readonly disconnects: string[] = [];
  private readonly connectionViews = new Map<string, Mutable<LauncherConnection>>();
  private connected = 0;
  connectAnswer: ((spec: ConnectionSpec) => Promise<LauncherConnection>) | null = null;
  disconnectAnswer: ((id: string) => Promise<LauncherConnection>) | null = null;
  /** What the SITL sends once the launcher has been polled `afterPolls` times: its servo rate and channels (null: no JSON) and MAVLink bytes. */
  probe: { rateHz: number | null; channels: number | null; bytesFromSitl: number; afterPolls: number } = { rateHz: 1200, channels: 16, bytesFromSitl: 512, afterPolls: 0 };
  private polls = 0;
  get lastConnectionId(): string { return experimentId(1000 + this.connected); }
  connectionView(id: string): LauncherConnection {
    const view = this.connectionViews.get(id);
    if (!view) throw new Error(`No scripted connection ${id}`);
    return structuredClone(view);
  }
  private observe(view: Mutable<LauncherConnection>): void {
    if (view.state !== 'open' || this.polls < this.probe.afterPolls) return;
    view.physics = { servoPackets: this.probe.rateHz === null ? 0 : 3, rateHz: this.probe.rateHz, channels: this.probe.channels };
    view.mavlink = { bytesFromSitl: this.probe.bytesFromSitl };
  }
  /** SITL ended its TCP connection: the launcher marks the connection and closes its bridge. */
  closeBySitl(id: string, reason: string): void {
    const view = this.connectionViews.get(id);
    if (!view) throw new Error(`No scripted connection ${id}`);
    Object.assign(view, { state: 'sitl-closed', closedReason: reason, ports: null });
  }
  connect(spec: ConnectionSpec): Promise<LauncherConnection> {
    this.events.push('launcher.connect');
    this.connectSpecs.push(spec);
    if (this.connectAnswer) return this.connectAnswer(spec);
    const id = experimentId(1000 + ++this.connected);
    this.polls = 0;
    const view: Mutable<LauncherConnection> = { id, state: 'open', closedReason: null, endpoints: structuredClone(spec), ports: { bridge: 52000 + this.connected, epoch: 1 },
      physics: { servoPackets: 0, rateHz: null, channels: null }, mavlink: { bytesFromSitl: 0 } };
    this.connectionViews.set(id, view);
    this.observe(view);
    return Promise.resolve(structuredClone(view));
  }
  connection(id: string): Promise<LauncherConnection> {
    this.events.push('launcher.connection');
    const view = this.connectionViews.get(id);
    if (!view) return Promise.reject(new LauncherError('refused', 'No connection of this launcher has that ID', 404));
    this.polls++;
    this.observe(view);
    return Promise.resolve(structuredClone(view));
  }
  disconnect(id: string): Promise<LauncherConnection> {
    this.events.push(`launcher.disconnect ${id}`);
    this.disconnects.push(id);
    if (this.disconnectAnswer) return this.disconnectAnswer(id);
    const view = this.connectionViews.get(id);
    if (!view) return Promise.reject(new LauncherError('refused', 'No connection of this launcher has that ID', 404));
    if (view.state === 'open') view.state = 'disconnected';
    view.ports = null;
    return Promise.resolve(structuredClone(view));
  }
}
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

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
  readonly loads: (800 | 1200)[] = [];
  /** The terrain chunks each load was handed (TASK-186). */
  readonly terrains: (readonly TerrainChunk[] | null)[] = [];
  readonly environments: unknown[] = [];
  load(physicsHz: 800 | 1200, environment: unknown = null, terrain: readonly TerrainChunk[] | null = null): Promise<{ readonly betModuleSha256: string }> {
    this.events.push('physics.load');
    this.loads.push(physicsHz);
    this.environments.push(environment);
    this.terrains.push(terrain);
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
  /** The truth a flight task flies from (TASK-172). */
  truth: FlightTruth = { simTimeS: 0, northM: 0, eastM: 0, altitudeM: 0.2, northMps: 0, eastMps: 0, downMps: 0, headingDeg: 0, rollDeg: 0, pitchDeg: 0 };
  flightTruth(): FlightTruth { return this.truth; }
  /** Each rotor's speed as power telemetry would report it, rev/min (TASK-157). */
  speeds: number[] = [];
  motorSpeedsInto(out: Float64Array): boolean {
    for (let i = 0; i < out.length; i++) out[i] = this.speeds[i] ?? 0;
    return true;
  }
  /** The session's sim.start acknowledgement after a pause (TASK-149, TASK-156). */
  resumeAnswer: () => Promise<void> = () => Promise.resolve();
  resume(): Promise<void> {
    this.events.push('physics.resume');
    return this.resumeAnswer();
  }
  /** The session's sim.pause acknowledgement (TASK-156). */
  pauseAnswer: () => Promise<void> = () => Promise.resolve();
  pause(): Promise<void> {
    this.events.push('physics.pause');
    return this.pauseAnswer();
  }
  /** The latest published tick, as the session would report it. */
  tick = 0;
  tickNow(): { tick: number; simTimeS: number } { return { tick: this.tick, simTimeS: this.tick / 800 }; }
  /** The Worker's stale-input watchdog, as manual control switched it (TASK-174). */
  readonly manual: boolean[] = [];
  manualInput(active: boolean): void { this.manual.push(active); }
  /** Effect controls sent to the session, and how the next is answered: null applied, or the reason it is rejected. */
  readonly effectsSent: { control: EffectControl; recovery: EffectRecovery; atSimS: number | undefined }[] = [];
  effectAnswer: string | null = null;
  effect(control: EffectControl, recovery: EffectRecovery, atSimS?: number): Promise<number | null> {
    this.effectsSent.push({ control, recovery, atSimS });
    return this.effectAnswer === null ? Promise.resolve(atSimS ?? null) : Promise.reject(new Error(this.effectAnswer));
  }
  frames(): SentFrame[] { return decodeSent(this.sent); }
}

/** ClockPort whose intervals run only when a test advances wall time. */
class FakeClock implements ClockPort {
  private now = 0;
  private next = 0;
  private readonly timers = new Map<number, { readonly ms: number; due: number; readonly callback: () => void }>();
  nowMs(): number { return this.now; }
  /** Wall time from 2026-11-02T00:00:00.000Z on. */
  utcNow(): string { return new Date(Date.UTC(2026, 10, 2) + this.now).toISOString(); }
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
    const { sitl } = payload;
    const stored = await createExperimentRecord(this.fixture.store, this.fixture.projectId, { name: experimentRecordName(this.fixture.stored.record.name,
      sitl.ownership === 'external' ? sitl.connectionId : sitl.experimentId, sitl.ownership), payload });
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

function harness(prepare: () => Promise<PreparedRun> = () => Promise.resolve(prepared), recordingOf: ((events: string[]) => RecordingPort) | null = null,
  metadata: ParameterMetadataCatalog | null = null): Harness {
  const events: string[] = [], views: ControllerView[] = [];
  const launcher = new ScriptedLauncher(events), physics = new ScriptedPhysics(events), clock = new FakeClock();
  const records = new StoreRecords(fixture, events), recording = recordingOf?.(events) ?? null;
  const controller = new SessionController(launcher, physics, records, clock, view => {
    views.push(view);
    if (events.at(-1) !== `state:${view.state.name}`) events.push(`state:${view.state.name}`);
  }, recording, metadata);
  physics.deliver = data => { controller.worker(data); };
  const request: StartRequest = { prepare, firmwareId: BUILD.id, speedup: 1, physicsHz: 800, home: DEFAULT_HOME, environment: null };
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
  // TASK-148: READY waits for ArduPilot's first 3D fix at the session's home, or at the flight task's ground start.
  mav(h, streamMessage(24, h.request.flightTask?.definition.initial.ground));
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
  const earlier = h.records.payloads.map(payload => owned(payload).experimentId);
  expect(h.controller.state.name).toBe('failed');
  await h.controller.start(h.request);
  const id = h.launcher.lastId;
  expect(h.launcher.count('start')).toBe(startsBefore + 1);
  expect(h.controller.state).toEqual({ name: 'starting', step: 'connecting', experimentId: id });
  expect(earlier).not.toContain(id);
  expect(h.records.payloads).toHaveLength(recordsBefore + 1);
  expect(owned(h.records.payloads.at(-1)).experimentId).toBe(id);
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
    // What a vehicle would have kept about this place goes after the generated list, for ArduPilot's first heading.
    expect(h.launcher.starts).toEqual([{ firmwareId: BUILD.id, parameters: [...h.run.parameters.map(p => ({ name: p.name, value: p.value })), ...siteParameters(DEFAULT_HOME)],
      frameScript: h.run.frameScript, speedup: 1, rateHz: 800, home: DEFAULT_HOME }]);

    // The ground station beats once a wall second and asks for the EKF, GPS and position streams until their messages arrive.
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
    // Acknowledgements alone do not stop the requests: ArduPilot's first send pass on a link resets intervals set before it.
    mav(h, commandAck(SET_MESSAGE_INTERVAL, 0), commandAck(SET_MESSAGE_INTERVAL, 0), commandAck(SET_MESSAGE_INTERVAL, 0));
    mav(h, ...list.slice(3));
    expect(h.controller.state).toMatchObject({ name: 'warming', experimentId: id });
    let sentBefore = h.physics.sent.length;
    h.clock.advance(1000);
    expect(commands(decodeSent(h.physics.sent.slice(sentBefore)), SET_MESSAGE_INTERVAL).map(frame => frame.params[0])).toEqual([193, 24, 33]);
    // Once a stream's message arrives it is not requested again; a stream silent for more than 2 s wall is requested again.
    mav(h, streamMessage(193), streamMessage(24));
    sentBefore = h.physics.sent.length;
    h.clock.advance(1000);
    expect(commands(decodeSent(h.physics.sent.slice(sentBefore)), SET_MESSAGE_INTERVAL).map(frame => frame.params[0])).toEqual([33]);
    mav(h, streamMessage(33));
    sentBefore = h.physics.sent.length;
    h.clock.advance(1000);
    expect(commands(decodeSent(h.physics.sent.slice(sentBefore)), SET_MESSAGE_INTERVAL)).toEqual([]);
    mav(h, streamMessage(193), streamMessage(33));
    sentBefore = h.physics.sent.length;
    h.clock.advance(1000);
    expect(commands(decodeSent(h.physics.sent.slice(sentBefore)), SET_MESSAGE_INTERVAL).map(frame => frame.params[0])).toEqual([24]);

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
    expect(payload.parameters.map(p => p.source)).toEqual([...h.run.parameters.map(p => p.source), 'site']);
    expect(payload.frameScript).toBe(posted.frameScript);
    // The build identity is the launcher's answer, not the catalog request.
    const view = h.launcher.view(h.launcher.lastId);
    expect(owned(payload).ardupilot).toEqual({ catalogId: view.firmware.id, firmwareVersion: view.firmware.firmwareVersion, commit: view.firmware.commit,
      binarySha256: view.firmware.binarySha256, defaultParametersSha256: view.firmware.defaultParametersSha256 });
    expect(owned(payload).ardupilot.firmwareVersion).not.toBe(BUILD.firmwareVersion);
    expect(owned(payload).experimentId).toBe(h.launcher.lastId);
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
    // While the list is incomplete the parameter service (TASK-160) reads the missing entries by index.
    expect(h.physics.frames().filter(frame => frame.id === PARAM_REQUEST_READ).length).toBeGreaterThan(0);
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

/** A Worker accident message as physics.worker.ts posts it (TASK-149). */
function accidentMessage(tick: number, rotorId: number): Record<string, unknown> {
  return { type: 'accident.events', dropped: 0, total: 1, events: [{ tick, simTimeS: tick / 800, part: { part: 'propeller', rotorId },
    pointBodyM: [0.1, 0.2, 0.03], penetrationM: 0.0005, impulseNs: 0.01, forceN: 8, rotorSpeedRadS: 900 }] };
}

/** A recording port that logs what the controller gives it (TASK-163). */
class ScriptedRecording implements RecordingPort {
  readonly calls: string[] = [];
  readonly frames: number[] = [];
  identity: RecordingStart | null = null;
  startAnswer: () => Promise<void> = () => Promise.resolve();
  constructor(private readonly events: string[]) {}
  prepare(identity: RecordingStart): ExperimentRecording {
    this.identity = identity;
    this.events.push('recording.prepare');
    return { recordId: 'c'.repeat(32), commonHz: 50, groups: {}, signals: {}, durationMin: 60, reserveMb: 500 };
  }
  start(): Promise<void> { this.events.push('recording.start'); return this.startAnswer(); }
  telemetry(frame: MavFrame): void { this.frames.push(frame.id); }
  parameters(list: readonly { readonly name: string; readonly value: number }[]): void { this.calls.push(`parameters:${list.length}`); }
  accidents(events: readonly AccidentEvent[]): void { this.calls.push(`accidents:${events.map(e => e.tick).join(',')}`); }
  pause(paused: boolean): void { this.calls.push(`pause:${paused ? 1 : 0}`); }
  flightTask(step: FlightTaskStep): void { this.calls.push(`task:${step.stage}`); }
  stop(): Promise<void> { this.events.push('recording.stop'); return Promise.resolve(); }
}

describe('a flight task on the Run tab (TASK-172)', () => {
  const SET_POSITION_TARGET = 84, MISSION_COUNT = 44, MISSION_ACK = 47;
  const ground = { northM: 10, eastM: -5, headingDeg: 90, stateOfCharge: 0.8 };
  const hover = parseFlightTask({ schemaVersion: 1, type: 'hover', parameters: { altitudeM: 5, durationS: 3 }, route: null, initial: { ground, air: null }, finish: 'land' });
  const route = parseFlightTask({ schemaVersion: 1, type: 'route', parameters: {}, route: [{ northM: 20, eastM: 0, altitudeM: 8, speedMps: 4 }, { northM: 20, eastM: 20, altitudeM: 8, speedMps: 4 }],
    initial: { ground: { northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 1 }, air: null }, finish: 'land' });
  const stored = async (definition: FlightTaskDefinition, name: string) => {
    const version = await fixture.store.createItem(fixture.projectId, 'flight-task', { name, payload: definition });
    return { recordSha256: version.sha256, name, definition };
  };
  test('the home check stands at the task\'s ground start, which the physics puts away from the pad (TASK-148)', async () => {
    const h = harness();
    await reach({ ...h, request: { ...h.request, flightTask: await stored(hover, 'Hover') } }, 'ready');
    expect(h.controller.view.compatibility).toEqual([{ check: 'home', text: 'GPS within 0.0 m and 0.0 m of the flight task\'s start' }]);
    // A fix at the pad is hypot(10, 5) = 11.2 m from that start, beyond the 10 m limit: the aircraft is not where the physics stands it.
    const away = harness(), request = { ...away.request, flightTask: await stored(hover, 'Hover') };
    await reach({ ...away, request }, 'warming');
    mav(away, streamMessage(24));
    await until(() => away.controller.state.name === 'failed', 5000, 'the run to fail');
    const state = away.controller.state;
    if (state.name !== 'failed') throw new Error('The run did not fail');
    expect(failureText(state.reason)).toBe('ArduPilot does not start at the session\'s home: its GPS puts it 11 m from and 0 m above or below the flight task\'s start, 10 m north and -5 m east of -35.363261,149.16523,584,0');
  });
  /** The next Worker status at `simTimeS`, with the truth the task flies from. */
  const at = (h: Harness, simTimeS: number, truth: Partial<FlightTruth> = {}) => {
    h.physics.truth = { ...h.physics.truth, ...truth, simTimeS };
    status(h, { ready: true, reason: '', simTimeS });
  };
  const flightOf = (h: Harness) => (h.controller.state.name === 'running' ? h.controller.state.flight : null);

  test('a task that ArduPilot\'s limits cannot shape is refused with the reason, and nothing flies', async () => {
    const h = harness();
    const flightTask = await stored(hover, 'Hover');
    await reach({ ...h, request: { ...h.request, flightTask } }, 'ready');
    const total = h.run.parameters.length + OTHER_PARAMETERS.length;
    mav(h, paramValue('WP_ACC_Z', 0, total, h.run.parameters.length));
    expect(h.controller.runTask()).toBe('ArduPilot reports WP_ACC_Z as 0, which cannot shape a flight task');
    expect(h.controller.view.flightTask).toMatchObject({ state: 'waiting' });
    expect(h.controller.state.name).toBe('ready');
  });

  test('flies from READY: the record holds the task, the runner\'s commands reach the autopilot, and the end hands the run back', async () => {
    const recording: { current: ScriptedRecording | null } = { current: null };
    const h = harness(undefined, events => (recording.current = new ScriptedRecording(events)));
    const flightTask = await stored(hover, 'Hover');
    await reach({ ...h, request: { ...h.request, flightTask } }, 'ready');
    expect(h.records.payloads.at(-1)?.flightTask).toEqual(flightTask);
    expect(h.controller.view.flightTask).toMatchObject({ name: 'Hover', state: 'waiting', step: null });

    h.physics.truth = { ...h.physics.truth, northM: 10, eastM: -5, headingDeg: 90 };
    expect(h.controller.runTask()).toBeNull();
    expect(flightOf(h)).toBe('task');
    expect(commands(h.physics.frames(), DO_SET_MODE).at(-1)?.params.slice(0, 2)).toEqual([1, GUIDED]);
    mav(h, heartbeat(GUIDED, false));
    at(h, 41);
    expect(commands(h.physics.frames(), COMPONENT_ARM_DISARM).at(-1)?.params[0]).toBe(1);
    mav(h, heartbeat(GUIDED, true));
    at(h, 42);
    at(h, 43);
    expect(commands(h.physics.frames(), NAV_TAKEOFF).at(-1)?.params[6]).toBeCloseTo(4.8, 5);
    expect(h.controller.view.flightTask?.step?.stage).toBe('takeoff');
    // Arrived and settled: the hover's clock starts and position targets go out, from where ArduPilot's frame starts.
    at(h, 50, { altitudeM: 5 });
    at(h, 52, { altitudeM: 5 });
    at(h, 52.3, { altitudeM: 5 });
    const step = h.controller.view.flightTask?.step;
    expect(step).toMatchObject({ stage: 'hold', measured: true, requested: { altitudeM: 5, northM: 10, eastM: -5 }, actual: { altitudeM: 5, northM: 10, eastM: -5 } });
    expect(h.physics.frames().filter(frame => frame.id === SET_POSITION_TARGET).length).toBeGreaterThan(0);
    expect(recording.current?.calls).toContain('task:hold');
    // Land refuses nothing while it flies, but this one finishes: the hold ends, LAND follows, and the disarm is the end.
    at(h, 55, { altitudeM: 5 });
    at(h, 55.1, { altitudeM: 5 });
    expect(commands(h.physics.frames(), DO_SET_MODE).at(-1)?.params.slice(0, 2)).toEqual([1, LAND]);
    mav(h, heartbeat(LAND, true));
    at(h, 60, { altitudeM: 0.2 });
    mav(h, heartbeat(LAND, false));
    at(h, 61, { altitudeM: 0.2 });
    expect(h.controller.view.flightTask).toMatchObject({ state: 'done', reason: null });
    expect(h.controller.state).toMatchObject({ name: 'ready' });
    expect(h.controller.runTask()).toBe('This run has flown its task; start a new run to fly it again');
  });

  test('READY of a launcher run waits for ArduPilot\'s first 3D fix at the session\'s home (TASK-148)', async () => {
    const h = harness();
    const id = await reach(h, 'warming');
    // A 2D fix is not a position yet; the Worker's READY alone does not make the run ready.
    mav(h, autopilotFrame(24, { time_usec: 0, fix_type: 2, lat: 0, lon: 0, alt: 0, eph: 0, epv: 0, vel: 0, cog: 0, satellites_visible: 4 }));
    status(h, { ready: true, reason: '', simTimeS: 40 });
    expect(h.controller.state).toMatchObject({ name: 'warming', experimentId: id });
    mav(h, streamMessage(24));
    status(h, { ready: true, reason: '', simTimeS: 41 });
    expect(h.controller.state).toEqual({ name: 'ready', experimentId: id });
    expect(h.controller.view.compatibility).toEqual([{ check: 'home', text: 'GPS within 0.0 m and 0.0 m of the session\'s home' }]);
  });

  test('a launcher run whose GPS is away from the session\'s home stops with the distance, never READY (TASK-148)', async () => {
    // The run's home is elsewhere than CMAC, where the scripted autopilot reports its fix: 31.5° N, 34.9° E, 250 m.
    const base = harness(), h = { ...base, request: { ...base.request, home: [31.5, 34.9, 250, 90] as const } };
    await reach(h, 'warming');
    mav(h, streamMessage(24));
    await until(() => h.controller.state.name === 'failed', 5000, 'the run to fail');
    const state = h.controller.state;
    if (state.name !== 'failed') throw new Error('The run did not fail');
    expect(state.reason).toMatchObject({ kind: 'home' });
    expect(failureText(state.reason)).toMatch(/^ArduPilot does not start at the session's home: its GPS puts it \d+ m from and 334 m above or below 31\.5,34\.9,250,90$/);
    expect(state.restart).toMatchObject({ kind: 'fix-first' });
  });

  test('flies only as the first flight of a READY run, and a run without a task says so', async () => {
    const h = harness();
    await reach(h, 'ready');
    expect(h.controller.runTask()).toBe('This run was started without a flight task');
    expect(h.records.payloads.at(-1)?.flightTask).toBeNull();
    const second = harness();
    const request = { ...second.request, flightTask: await stored(hover, 'Hover') };
    await reach({ ...second, request }, 'warming');
    expect(second.controller.runTask()).toBe('Run the task once the run is READY');
    mav(second, streamMessage(24, ground));
    status(second, { ready: true, reason: '', simTimeS: 40 });
    expect(second.controller.takeOff(TAKEOFF_M)).toBe(true);
    mav(second, heartbeat(GUIDED, true));
    expect(second.controller.runTask()).toBe('This run has already flown; a task flies as a run\'s first flight, so start a new run');
  });

  test('a route waits for ArduPilot\'s acknowledgement, and a refusal ends the task on the ground with its reason', async () => {
    const h = harness();
    await reach({ ...h, request: { ...h.request, flightTask: await stored(route, 'Route') } }, 'ready');
    expect(h.controller.runTask()).toBeNull();
    expect(h.physics.frames().filter(frame => frame.id === MISSION_COUNT)).toHaveLength(1);
    at(h, 41);
    // No acknowledgement, no arming: only the upload's repeat goes out.
    expect(commands(h.physics.frames(), COMPONENT_ARM_DISARM)).toEqual([]);
    mav(h, autopilotFrame(MISSION_ACK, { target_system: 255, target_component: 190, type: 13, mission_type: 0 }));
    at(h, 41.1);
    expect(h.controller.view.flightTask).toMatchObject({ state: 'failed', reason: 'ArduPilot refused the route: ArduPilot refused the mission: invalid sequence' });
    expect(h.controller.state).toMatchObject({ name: 'ready' });
    expect(commands(h.physics.frames(), COMPONENT_ARM_DISARM)).toEqual([]);
  });

  test('a task that fails in the air hands the flight to LAND, and so does the Land button', async () => {
    const start = async () => {
      const h = harness();
      await reach({ ...h, request: { ...h.request, flightTask: await stored(hover, 'Hover') } }, 'ready');
      h.controller.runTask();
      mav(h, heartbeat(GUIDED, true));
      at(h, 41);
      return h;
    };
    const failing = await start();
    // ArduPilot left GUIDED on its own: the task stops, and the run lands.
    mav(failing, heartbeat(STABILIZE, true));
    at(failing, 42);
    expect(failing.controller.view.flightTask).toMatchObject({ state: 'failed', reason: 'The autopilot left its flight mode during the takeoff stage' });
    expect(flightOf(failing)).toBe('landing');
    expect(commands(failing.physics.frames(), DO_SET_MODE).at(-1)?.params.slice(0, 2)).toEqual([1, LAND]);
    const stopped = await start();
    expect(stopped.controller.land()).toBe(true);
    expect(stopped.controller.view.flightTask).toMatchObject({ state: 'failed', reason: 'You landed the aircraft during the task' });
    // A status after Land does not fly the task on.
    const sent = stopped.physics.frames().length;
    at(stopped, 42);
    expect(stopped.physics.frames().filter(frame => frame.id === SET_POSITION_TARGET)).toEqual([]);
    expect(stopped.physics.frames().length).toBe(sent);
  });

  test('a run that stops during the task says the task ended, and a paused task sends nothing', async () => {
    const h = harness();
    await reach({ ...h, request: { ...h.request, flightTask: await stored(hover, 'Hover') } }, 'ready');
    h.controller.runTask();
    mav(h, heartbeat(GUIDED, true));
    at(h, 41);
    expect(h.controller.pause('user')).toBe(true);
    await vi.waitFor(() => { expect(h.controller.state.name).toBe('paused'); });
    const sent = h.physics.frames().length;
    at(h, 41);
    expect(h.physics.frames().length).toBe(sent);
    await h.controller.stop();
    expect(h.controller.view.flightTask).toMatchObject({ state: 'failed', reason: 'The run ended during the task' });
  });
});

describe('one pause path (TASK-156)', () => {
  test('the user pauses a flying run and resumes it to the same flight, and each pause is logged with its tick and wall time', async () => {
    const h = harness();
    const id = await reach(h, 'flying');
    h.physics.tick = 40800;
    expect(h.controller.pause('user')).toBe(true);
    // A second request while the first is pending is refused.
    expect(h.controller.pause('user')).toBe(false);
    await settle();
    expect(h.events).toContain('physics.pause');
    expect(h.controller.state).toEqual({ name: 'paused', experimentId: id, atSimTimeS: 51, reason: 'user', accidents: [] });
    expect(h.controller.takeOff(TAKEOFF_M)).toBe(false);
    expect(h.controller.land()).toBe(false);
    h.clock.advance(600_000);
    expect(h.controller.view.pausedWallMs).toBe(600_000);
    expect(h.controller.resume()).toBe(true);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'running', experimentId: id, flight: 'flying' });
    expect(h.controller.view.afterAccident).toBe(false);
    expect(h.controller.view.pauses).toEqual([{ reason: 'user', tick: 40800, simTimeS: 51, pausedWallMs: expect.any(Number) as unknown,
      resumedWallMs: expect.any(Number) as unknown }]);
    const [pause] = h.controller.view.pauses;
    expect((pause?.resumedWallMs ?? 0) - (pause?.pausedWallMs ?? 0)).toBe(600_000);
    // A long pause is no heartbeat loss: the clock of the loss check starts again on resume.
    expect(h.controller.state.name).toBe('running');
    await h.controller.stop();
  });

  test('a hidden tab pauses a READY run, which waits for the user; nothing pauses outside a run', async () => {
    const h = harness();
    expect(h.controller.pause('visibility')).toBe(false);
    await reach(h, 'ready');
    h.physics.tick = 32000;
    expect(h.controller.pause('visibility')).toBe(true);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'paused', reason: 'visibility', atSimTimeS: 40 });
    expect(h.controller.resume()).toBe(true);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'ready' });
    expect(h.controller.view.pauses.map(p => p.reason)).toEqual(['visibility']);
  });

  test('an accident before the first heartbeat pauses the start, and Resume restarts its heartbeat deadline', async () => {
    const h = harness();
    const id = await reach(h, 'connecting');
    status(h, { state: 'open', simTimeS: 0.3 });
    h.controller.worker(accidentMessage(240, 1));
    expect(h.controller.state).toMatchObject({ name: 'paused', experimentId: id, reason: 'accident' });
    // The frozen autopilot sends no heartbeat; the paused start does not fail for it.
    h.clock.advance((HEARTBEAT_DEADLINE_S + 30) * 1000);
    expect(h.controller.state.name).toBe('paused');
    expect(h.controller.resume()).toBe(true);
    await settle();
    expect(h.controller.state).toEqual({ name: 'starting', step: 'connecting', experimentId: id });
    expect(h.controller.view.afterAccident).toBe(true);
    h.clock.advance((HEARTBEAT_DEADLINE_S - 1) * 1000);
    expect(h.controller.state.name).toBe('starting');
    mav(h, heartbeat(STABILIZE, false));
    expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: id });
  });

  test('a refused pause stops the run with its reason, and a new run starts with no pauses', async () => {
    const h = harness();
    await reach(h, 'ready');
    h.physics.pauseAnswer = () => Promise.reject(new Error('sim.pause: Session is faulted'));
    expect(h.controller.pause('user')).toBe(true);
    await until(() => h.controller.state.name === 'failed', 5000, 'the failed pause');
    expect(failed(h).reason).toEqual({ kind: 'physics', message: 'sim.pause: Session is faulted' });
    h.physics.pauseAnswer = () => Promise.resolve();
    await reach(h, 'ready');
    expect(h.controller.view.pauses).toEqual([]);
  });
});

// ---- TASK-160: the run's parameters ---------------------------------------------------------------

/** PARAM_SET, also declared with the connection tests further down. */
const PARAM_SET_ID = 23, NOT_LISTED = 65535, INT8 = 2;
const SET_ID = layoutOf(PARAM_SET_ID, 'param_id'), SET_VALUE = layoutOf(PARAM_SET_ID, 'param_value');
/** Every PARAM_SET the ground station sent: name and float32 value. */
function paramSets(h: Harness): { name: string; value: number }[] {
  const sets: { name: string; value: number }[] = [];
  const parser = new MavParser(frame => { if (frame.id === PARAM_SET_ID) sets.push({ name: readText(frame.payload, SET_ID), value: readNumber(frame.view, SET_VALUE) }); });
  for (const chunk of h.physics.sent) parser.push(chunk);
  return sets;
}
/** ArduPilot's answer to a write or a read by name: PARAM_VALUE outside the list with the list's count. */
function answer(h: Harness, name: string, value: number, type = REAL32): Uint8Array {
  return autopilotFrame(PARAM_VALUE, { param_id: name, param_value: value, param_type: type, param_count: h.run.parameters.length + OTHER_PARAMETERS.length,
    param_index: NOT_LISTED });
}
let catalog: ParameterMetadataCatalog;
beforeAll(() => { catalog = parseParameterMetadata(readJson('data/ardupilot/param-metadata.json')); });

describe('the Faults and interference tab on a run (TASK-169)', () => {
  const control = (effect: EffectControl['effect'], parameters: Partial<Record<string, unknown>> = {}, enabled = true, intensity = 1) =>
    ({ schemaVersion: 1, id: effect.replaceAll('.', '-'), effect, enabled, intensity, parameters: { ...initialEffectParameters(effect), ...parameters } }) as EffectControl;
  const schedule = (...entries: readonly { control: EffectControl; onsetS: number; durationS: number | null }[]): FaultSchedule =>
    parseFaultSchedule({ schemaVersion: 1, entries: entries.map(entry => ({ ...entry, recovery: 'hold-offset' })) });
  /** A run that has reached READY and arms at `at` s of simulated time. */
  async function armed(faults: FaultSchedule | null, at = 100) {
    const base = harness(undefined, null, catalog), h = { ...base, request: { ...base.request, faults } };
    await reach(h, 'ready');
    status(h, { simTimeS: at });
    expect(h.physics.effectsSent).toEqual([]);
    mav(h, heartbeat(GUIDED, true));
    status(h, { simTimeS: at });
    return h;
  }

  test('a weather schedule counts from the same first arming, keeps its record, and queues each change on its exact tick (TASK-167)', async () => {
    const weather = weatherSchedule([
      { control: control('wind.mean', { windNedMps: [-5, 0, 0] }), onsetS: 0, durationS: null, recovery: 'hold-offset' },
      { control: control('wind.discrete-gust', { amplitudeMps: 6, durationS: 2, fromDeg: 270, upwardDeg: 0 }), onsetS: 3, durationS: 2, recovery: 'hold-offset' },
    ]);
    const base = harness(undefined, null, catalog), h = { ...base, request: { ...base.request, weather } };
    await reach(h, 'ready');
    status(h, { simTimeS: 100 });
    expect(h.physics.effectsSent).toEqual([]);
    mav(h, heartbeat(GUIDED, true));
    status(h, { simTimeS: 100 });
    const stored = h.records.stored.at(-1);
    if (!stored) throw new Error('No experiment was stored');
    expect(readExperiment(stored).weather).toEqual(weather);
    expect(readExperiment(stored).faults).toBeNull();
    // Within the 5 s queue lead: the wind on the tick of arming, the gust on and off at arming + 3 s and + 5 s.
    expect(h.physics.effectsSent).toMatchObject([{ control: { effect: 'wind.mean', enabled: true }, atSimS: 100 },
      { control: { effect: 'wind.discrete-gust', enabled: true }, atSimS: 103 }, { control: { effect: 'wind.discrete-gust', enabled: false }, atSimS: 105 }]);
    expect(h.controller.view.weatherPlan).toMatchObject({ armedAtS: 100, sent: 3 });
    await Promise.resolve(); await Promise.resolve();
    // Logged with their values: the seeds and amplitudes a repeat needs.
    expect(h.controller.view.effects[1]).toMatchObject({ effect: 'wind.discrete-gust', origin: 'schedule', parameters: { amplitudeMps: 6, durationS: 2, fromDeg: 270, upwardDeg: 0 } });
  });

  test('a schedule counts from the first arming, keeps its record, and queues a session effect on its exact tick', async () => {
    const faults = schedule({ control: control('link.pilot'), onsetS: 2, durationS: 6 }, { control: control('ew.position-step', { offsetNedM: [30, 0, 0] }), onsetS: 20, durationS: null });
    const h = await armed(faults);
    const stored = h.records.stored.at(-1);
    if (!stored) throw new Error('No experiment was stored');
    expect(readExperiment(stored).faults).toEqual(faults);
    // Within the queue lead of its time: on the tick of arming + onset, and not before anything is due.
    expect(h.physics.effectsSent).toMatchObject([{ control: { effect: 'link.pilot', enabled: true }, atSimS: 102 }]);
    expect(h.controller.view.faultPlan).toMatchObject({ armedAtS: 100, sent: 1 });
    status(h, { simTimeS: 103 });
    expect(h.physics.effectsSent.at(-1)).toMatchObject({ control: { effect: 'link.pilot', enabled: false }, atSimS: 108 });
    status(h, { simTimeS: 114 });
    expect(h.physics.effectsSent).toHaveLength(2);
    status(h, { simTimeS: 116 });
    expect(h.physics.effectsSent.at(-1)).toMatchObject({ control: { effect: 'ew.position-step', enabled: true }, atSimS: 120 });
    await Promise.resolve(); await Promise.resolve();
    expect(h.controller.view.effects[0]).toMatchObject({ origin: 'schedule', status: 'applied', requestedSimS: 102, appliedSimS: 102 });
    // A run that never arms never starts counting, and says so.
    const idleBase = harness(undefined, null, catalog), idle = { ...idleBase, request: { ...idleBase.request, faults } };
    await reach(idle, 'ready');
    status(idle, { simTimeS: 500 });
    expect(idle.physics.effectsSent).toEqual([]);
    expect(idle.controller.view.faultPlan).toMatchObject({ armedAtS: null, sent: 0 });
  });

  test('jamming goes to the session for its flag and to the receiver as logged writes, which go back when it ends', async () => {
    const h = await armed(schedule({ control: control('ew.gnss-jamming', { severity: 0.5 }), onsetS: 1, durationS: 4 }));
    h.physics.sent.length = 0;
    status(h, { simTimeS: 100.5 });
    expect(paramSets(h)).toEqual([]);
    status(h, { simTimeS: 101 });
    expect(paramSets(h)).toEqual([{ name: 'SIM_GPS1_NUMSATS', value: 6 }, { name: 'SIM_GPS1_ACC', value: Math.fround(0.3 * ((0.5 * 1.21 + 0.5 * 99) / 1.21)) }, { name: 'SIM_GPS1_LCKTIME', value: 0 }]);
    expect(h.physics.effectsSent.at(-1)).toMatchObject({ control: { effect: 'ew.gnss-jamming', enabled: true } });
    await Promise.resolve(); await Promise.resolve();
    // It stands as its session answer and its read-backs both do.
    expect(h.controller.view.effects[0]?.status).toBe('pending');
    mav(h, answer(h, 'SIM_GPS1_NUMSATS', 6), answer(h, 'SIM_GPS1_ACC', Math.fround(0.3 * ((0.5 * 1.21 + 0.5 * 99) / 1.21))), answer(h, 'SIM_GPS1_LCKTIME', 0));
    expect(h.controller.view.effects[0]).toMatchObject({ status: 'applied', writes: ['SIM_GPS1_NUMSATS', 'SIM_GPS1_ACC', 'SIM_GPS1_LCKTIME'] });
    h.physics.sent.length = 0;
    status(h, { simTimeS: 105 });
    expect(paramSets(h)).toEqual([{ name: 'SIM_GPS1_NUMSATS', value: 10 }, { name: 'SIM_GPS1_ACC', value: Math.fround(0.3) }, { name: 'SIM_GPS1_LCKTIME', value: 0 }]);
  });

  test('a magnetic bias adds to the offsets the run has and goes back to them; a rotation alone writes nothing', async () => {
    const h = await armed(null);
    h.physics.sent.length = 0;
    expect(h.controller.setEffect(control('ew.magnetic', { rotationRad: [0, 0, 0.5], biasBodyGauss: [0, 0, 0] }))).toBeNull();
    expect(paramSets(h)).toEqual([]);
    expect(h.controller.setEffect(control('ew.magnetic', { rotationRad: [0, 0, 0], biasBodyGauss: [0.3, -0.2, 0] }))).toBeNull();
    const sets = paramSets(h);
    expect(sets).toHaveLength(9);
    const held = new Map(h.controller.parameterList().map(parameter => [parameter.name, parameter.value]));
    const offset = (name: string) => { const value = held.get(name); if (value === undefined) throw new Error(`No ${name}`); return value; };
    expect(sets.find(set => set.name === 'SIM_MAG2_OFS_X')?.value).toBeCloseTo(offset('SIM_MAG2_OFS_X') - 300, 3);
    expect(sets.find(set => set.name === 'SIM_MAG2_OFS_Y')?.value).toBeCloseTo(offset('SIM_MAG2_OFS_Y') + 200, 3);
    expect(sets.find(set => set.name === 'SIM_MAG2_OFS_Z')?.value).toBeCloseTo(offset('SIM_MAG2_OFS_Z'), 3);
    h.physics.sent.length = 0;
    expect(h.controller.setEffect(control('ew.magnetic', { rotationRad: [0, 0, 0], biasBodyGauss: [0.3, -0.2, 0] }, false))).toBeNull();
    expect(paramSets(h).map(set => [set.name, set.value])).toEqual(sets.map(set => [set.name, offset(set.name)]));
  });

  test('what cannot be delivered is rejected where it shows, by hand and on a schedule, and the ledger keeps it', async () => {
    const h = await armed(schedule({ control: control('sensor.baro.frozen'), onsetS: 1, durationS: null }));
    expect(h.controller.setEffect(control('ew.position-step', { offsetNedM: [0, 0, 5] }))).toContain('barometer');
    expect(h.controller.view.effects[0]).toMatchObject({ effect: 'ew.position-step', status: 'rejected', origin: 'manual' });
    // SIM_BAR3_FREEZE is left out of the test list, so this one cannot be written whole; none of it goes.
    h.physics.sent.length = 0;
    status(h, { simTimeS: 102 });
    expect(paramSets(h)).toEqual([]);
    expect(h.controller.view.effects.at(-1)).toMatchObject({ effect: 'sensor.baro.frozen', status: 'rejected', origin: 'schedule', requestedSimS: 101 });
    expect(h.controller.view.effects.at(-1)?.message).toContain('SIM_BAR3_FREEZE');
    h.physics.effectAnswer = 'The session refused it';
    expect(h.controller.setEffect(control('link.pilot'))).toBeNull();
    await Promise.resolve(); await Promise.resolve();
    expect(h.controller.view.effects.at(-1)).toMatchObject({ effect: 'link.pilot', status: 'rejected', message: 'The session refused it' });
  });

  test('no run, no effect, and a stopped run stops its schedule', async () => {
    const idle = harness(undefined, null, catalog);
    expect(idle.controller.setEffect(control('link.pilot'))).toBe('No run is active');
    const h = await armed(schedule({ control: control('link.pilot'), onsetS: 50, durationS: null }));
    await h.controller.stop();
    status(h, { simTimeS: 200 });
    expect(h.physics.effectsSent).toEqual([]);
  });
});

describe('effect controls in a run (TASK-168)', () => {
  const control = (effect: EffectControl['effect'], enabled = true, intensity = 1): EffectControl => ({ schemaVersion: 1, id: effect.replaceAll('.', '-'), effect, enabled, intensity, parameters: {} });

  test('an ArduPilot fault writes its parameters, logged, stands as their read-back, and goes back to the earlier values', async () => {
    const h = harness(undefined, null, catalog);
    await reach(h, 'flying');
    expect(h.controller.setEffect(control('sensor.baro.missing'))).toBeNull();
    expect(paramSets(h)).toEqual([{ name: 'SIM_BARO_DISABLE', value: 1 }, { name: 'SIM_BAR2_DISABLE', value: 1 }, { name: 'SIM_BAR3_DISABLE', value: 1 }]);
    expect(h.controller.view.effects).toMatchObject([{ effect: 'sensor.baro.missing', enabled: true, intensity: 1, status: 'pending', message: '', origin: 'manual', writes: ['SIM_BARO_DISABLE', 'SIM_BAR2_DISABLE', 'SIM_BAR3_DISABLE'] }]);
    expect(h.controller.view.parameters?.changes.map(change => [change.name, change.oldValue, change.newValue])).toEqual([['SIM_BARO_DISABLE', 0, 1], ['SIM_BAR2_DISABLE', 0, 1], ['SIM_BAR3_DISABLE', 0, 1]]);
    mav(h, answer(h, 'SIM_BARO_DISABLE', 1), answer(h, 'SIM_BAR2_DISABLE', 1));
    expect(h.controller.view.effects[0]?.status).toBe('pending');
    mav(h, answer(h, 'SIM_BAR3_DISABLE', 1));
    expect(h.controller.view.effects[0]?.status).toBe('applied');
    // Off restores what each held, which for SIM_GPS1_LCKTIME below is the 0 it started from.
    h.physics.sent.length = 0;
    expect(h.controller.setEffect(control('sensor.baro.missing', false))).toBeNull();
    expect(paramSets(h)).toEqual([{ name: 'SIM_BARO_DISABLE', value: 0 }, { name: 'SIM_BAR2_DISABLE', value: 0 }, { name: 'SIM_BAR3_DISABLE', value: 0 }]);
    h.physics.sent.length = 0;
    expect(h.controller.setEffect(control('sensor.gnss.missing'))).toBeNull();
    expect(paramSets(h)).toEqual([{ name: 'SIM_GPS1_LCKTIME', value: 32767 }]);
    mav(h, answer(h, 'SIM_GPS1_LCKTIME', 32767));
    h.physics.sent.length = 0;
    expect(h.controller.setEffect(control('sensor.gnss.missing', true, 0))).toBeNull();
    expect(paramSets(h)).toEqual([{ name: 'SIM_GPS1_LCKTIME', value: 0 }]);
    // No session command: these are the autopilot's.
    expect(h.physics.effectsSent).toEqual([]);
  });

  test('an ArduPilot fault that was never on writes nothing, and ArduPilot refusing one shows', async () => {
    const h = harness(undefined, null, catalog);
    await reach(h, 'ready');
    h.physics.sent.length = 0;
    expect(h.controller.setEffect(control('sensor.baro.missing', false))).toBeNull();
    expect(h.controller.setEffect(control('sensor.baro.frozen', true, 0))).toBeNull();
    expect(paramSets(h)).toEqual([]);
    expect(h.controller.setEffect(control('sensor.gnss.missing'))).toBeNull();
    mav(h, answer(h, 'SIM_GPS1_LCKTIME', 1));
    status(h, { ready: true, reason: '', simTimeS: 41.5 });
    expect(h.controller.view.effects.at(-1)).toMatchObject({ effect: 'sensor.gnss.missing', status: 'rejected', message: expect.stringContaining('SIM_GPS1_LCKTIME') as string });
  });

  test('half a fault is never written: a parameter the list lacks refuses the whole effect', async () => {
    const h = harness(undefined, null, catalog);
    await reach(h, 'flying');
    h.physics.sent.length = 0;
    expect(h.controller.setEffect(control('sensor.baro.frozen'))).toContain('SIM_BAR3_FREEZE');
    expect(paramSets(h)).toEqual([]);
    expect(h.controller.view.effects).toMatchObject([{ effect: 'sensor.baro.frozen', status: 'rejected', writes: [] }]);
  });

  test('a link effect goes to the session, and its rejection shows', async () => {
    const h = harness(undefined, null, catalog);
    await reach(h, 'flying');
    expect(h.controller.setEffect(control('sensor.imu.frozen'))).toBeNull();
    expect(h.physics.effectsSent).toEqual([{ control: control('sensor.imu.frozen'), recovery: 'hold-offset' }]);
    expect(h.controller.view.effects[0]?.status).toBe('pending');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.controller.view.effects[0]?.status).toBe('applied');
    h.physics.effectAnswer = 'BAD_STATE: no link';
    expect(h.controller.setEffect(control('link.pilot'))).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.controller.view.effects[1]).toMatchObject({ status: 'rejected', message: 'BAD_STATE: no link' });
  });

  test('without a run, or with an invalid record, nothing is sent', () => {
    const h = harness(undefined, null, catalog);
    expect(h.controller.setEffect(control('sensor.imu.frozen'))).toBe('No run is active');
    expect(h.physics.effectsSent).toEqual([]);
    expect(h.controller.setEffect({ ...control('sensor.imu.frozen'), intensity: -1 })).toContain('intensity');
  });
});

describe('the run\'s parameters (TASK-160)', () => {
  test('the run downloads the complete list, and a write in flight is confirmed, applied and logged with its old value and tick', async () => {
    const h = harness(undefined, null, catalog);
    const id = await reach(h, 'flying');
    const view = () => h.controller.view.parameters;
    const total = h.run.parameters.length + OTHER_PARAMETERS.length;
    expect(view()?.download).toEqual({ kind: 'complete', total });
    expect(view()).toMatchObject({ stale: false, writeRefusal: null, firmwareCommit: SITL_COMMIT, metadata: true, changes: [], rebootPending: [] });
    expect(h.controller.parameterList().map(p => p.name).slice(-3)).toEqual(['SYSID_THISMAV', 'FS_GCS_ENABLE', 'ARMING_CHECK']);
    expect(h.controller.parameterMetadata?.get('FRAME_CLASS')?.rebootRequired).toBe(true);
    h.physics.tick = 40800;
    h.clock.advance(1500);
    expect(h.controller.setParameter('FS_GCS_ENABLE', 1)).toBeNull();
    expect(paramSets(h)).toEqual([{ name: 'FS_GCS_ENABLE', value: 1 }]);
    expect(view()?.changes).toEqual([{ writeId: 1, name: 'FS_GCS_ENABLE', oldValue: 0, newValue: 1, requestedAt: '2026-11-02T00:00:02.500Z', tick: 40800,
      simTimeS: 51, experimentId: id, whilePaused: false, outcome: { kind: 'requested', id: 1, name: 'FS_GCS_ENABLE', requested: 1, attempts: 1 } }]);
    mav(h, answer(h, 'FS_GCS_ENABLE', 1));
    expect(view()?.changes[0]?.outcome).toEqual({ kind: 'confirmed', id: 1, name: 'FS_GCS_ENABLE', requested: 1, value: 1, rebootRequired: false, outsideRange: false });
    expect(h.controller.parameterList().find(p => p.name === 'FS_GCS_ENABLE')?.value).toBe(1);
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'flying' });
  });

  test('a write whose metadata needs a restart is confirmed but pending a restart, never applied', async () => {
    const h = harness(undefined, null, catalog);
    await reach(h, 'ready');
    const frameClass = h.controller.parameterList().find(p => p.name === 'FRAME_CLASS');
    if (!frameClass) throw new Error('No FRAME_CLASS in the list');
    expect(h.controller.setParameter('FRAME_CLASS', frameClass.value + 1)).toBeNull();
    mav(h, answer(h, 'FRAME_CLASS', frameClass.value + 1));
    expect(h.controller.view.parameters?.changes[0]?.outcome).toMatchObject({ kind: 'confirmed', rebootRequired: true });
    expect(h.controller.view.parameters?.rebootPending).toEqual(['FRAME_CLASS']);
  });

  test('refusals by the service and by the autopilot, and a write nobody answers, end in their own logged states', async () => {
    const h = harness(undefined, null, catalog);
    await reach(h, 'ready');
    const total = h.run.parameters.length + OTHER_PARAMETERS.length;
    // ArduPilot reports FS_GCS_ENABLE as INT8.
    mav(h, autopilotFrame(PARAM_VALUE, { param_id: 'FS_GCS_ENABLE', param_value: 0, param_type: INT8, param_count: total, param_index: total - 2 }));
    expect(h.controller.setParameter('FS_GCS_ENABLE', 1.5)).toBeNull();
    expect(paramSets(h)).toEqual([]);
    expect(h.controller.setParameter('ARMING_CHECK', 0)).toBeNull();
    mav(h, answer(h, 'ARMING_CHECK', 1));
    status(h, { ready: true, reason: '', simTimeS: 41.5 });
    expect(h.controller.setParameter('SYSID_THISMAV', 2)).toBeNull();
    for (const simTimeS of [42.6, 43.7, 44.8]) status(h, { ready: true, reason: '', simTimeS });
    expect(h.controller.view.parameters?.changes.map(change => change.outcome)).toEqual([
      { kind: 'refused', id: 1, name: 'FS_GCS_ENABLE', requested: 1.5, by: 'service', reason: 'an integer from -128 to 127 is required', reported: null },
      { kind: 'refused', id: 2, name: 'ARMING_CHECK', requested: 0, by: 'autopilot', reason: 'the autopilot kept 1', reported: 1 },
      { kind: 'timeout', id: 3, name: 'SYSID_THISMAV', requested: 2, attempts: 3 },
    ]);
    expect(paramSets(h).filter(set => set.name === 'SYSID_THISMAV')).toHaveLength(3);
  });

  test('a write while paused waits for Resume without retry or timeout, a newer write makes it stale, and the answer after Resume confirms the newer one', async () => {
    const h = harness(undefined, null, catalog);
    await reach(h, 'ready');
    expect(h.controller.pause('user')).toBe(true);
    await settle();
    expect(h.controller.state.name).toBe('paused');
    expect(h.controller.setParameter('ARMING_CHECK', 0)).toBeNull();
    // Simulated time stands while paused, however long the wall time.
    h.clock.advance(120_000);
    for (let i = 0; i < 5; i++) status(h, { ready: true, reason: '', simTimeS: 40 });
    expect(h.controller.view.parameters?.changes[0]).toMatchObject({ whilePaused: true, outcome: { kind: 'requested', attempts: 1 } });
    expect(h.controller.setParameter('ARMING_CHECK', 2)).toBeNull();
    expect(h.controller.view.parameters?.changes.map(change => change.outcome.kind)).toEqual(['stale', 'requested']);
    expect(h.controller.resume()).toBe(true);
    await settle();
    mav(h, answer(h, 'ARMING_CHECK', 2));
    expect(h.controller.view.parameters?.changes.map(change => [change.whilePaused, change.outcome.kind])).toEqual([[true, 'stale'], [true, 'confirmed']]);
    expect(h.controller.state.name).toBe('ready');
  });

  test('writes are refused before the list is loaded, while it is renumbered, for a SITL MirageSITL did not start, and after the run stops', async () => {
    const h = harness(undefined, null, catalog);
    expect(h.controller.setParameter('ARMING_CHECK', 0)).toBe('No run has loaded its parameters');
    await reach(h, 'loading-parameters');
    expect(h.controller.setParameter('ARMING_CHECK', 0)).toBe('Parameters can be written once the run has loaded them, until it stops');
    mav(h, ...parameterList(h.run.parameters));
    status(h, { ready: true, reason: '', simTimeS: 40 });
    // An *_ENABLE write showed a group: the autopilot's list has a new count.
    const total = h.run.parameters.length + OTHER_PARAMETERS.length;
    mav(h, autopilotFrame(PARAM_VALUE, { param_id: 'ARMING_CHECK', param_value: 1, param_type: REAL32, param_count: total + 3, param_index: total - 1 }));
    expect(h.controller.view.parameters).toMatchObject({ stale: true, writeRefusal: 'The autopilot renumbered its list: download it again first' });
    const before = listRequests(h.physics.frames()).length;
    expect(h.controller.refreshParameters()).toBeNull();
    expect(listRequests(h.physics.frames())).toHaveLength(before + 1);
    expect(h.controller.view.parameters?.download).toEqual({ kind: 'downloading', received: 0, total: null });
    const renumbered: (readonly [string, number])[] = [...h.run.parameters.map(p => [p.name, p.value] as const), ...OTHER_PARAMETERS, ['NEW_A', 1], ['NEW_B', 2], ['NEW_C', 3]];
    mav(h, ...renumbered.map(([name, value], index) => paramValue(name, value, total + 3, index)));
    expect(h.controller.view.parameters).toMatchObject({ download: { kind: 'complete', total: total + 3 }, stale: false, writeRefusal: null });
    await h.controller.stop();
    expect(h.controller.setParameter('ARMING_CHECK', 0)).toBe('Parameters can be written once the run has loaded them, until it stops');
    expect(paramSets(h)).toEqual([]);

    const c = harness(undefined, null, catalog);
    await connectTo(c, 'ready');
    expect(c.controller.view.parameters?.download.kind).toBe('complete');
    expect(c.controller.setParameter('ARMING_CHECK', 0)).toMatch(/^MirageSITL writes nothing to a SITL it did not start/);
    expect(paramSets(c)).toEqual([]);
  });
});

// ---- TASK-174: manual flight with a controller -----------------------------------------------------

const ALT_HOLD = 2, RC_OVERRIDE = 70, SET_MODE = 176, ARM = 400;
const RC_FIELDS = Array.from({ length: 8 }, (_, i) => layoutOf(RC_OVERRIDE, `chan${i + 1}_raw`));
/** The first eight channels of every RC_CHANNELS_OVERRIDE the ground station sent, in order. */
function overrides(h: Harness): number[][] {
  const out: number[][] = [];
  const parser = new MavParser(frame => { if (frame.id === RC_OVERRIDE) out.push(RC_FIELDS.map(field => readNumber(frame.view, field))); });
  for (const chunk of h.physics.sent) parser.push(chunk);
  return out;
}
/** A scripted USB controller: sticks, status and device generation set by the test. */
class FakeController implements PilotInputPort {
  status: PilotInputPort['status'] = 'connected';
  generation = 1;
  deviceName = 'Test transmitter';
  sticks = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
  poll(out: PilotInput, nowMs: number): void {
    out.wallTimeMs = nowMs;
    const ok = this.status === 'connected';
    out.roll = ok ? this.sticks.roll : 0; out.pitch = ok ? this.sticks.pitch : 0; out.yaw = ok ? this.sticks.yaw : 0;
    out.throttle = ok ? this.sticks.throttle : 0; out.flags = ok ? 1 : 0;
  }
}
/** A READY run with a controller set; returns the controller. */
async function manualHarness(): Promise<{ h: Harness; pad: FakeController; id: string }> {
  const h = harness(), pad = new FakeController();
  h.controller.setInput(pad);
  const id = await reach(h, 'ready');
  return { h, pad, id };
}

describe('manual flight with a controller (TASK-174)', () => {
  test('on the ground it needs the throttle down, sets the mode, arms, and sends the sticks at 25 Hz', async () => {
    const { h, pad, id } = await manualHarness();
    expect(MANUAL_RATE_HZ).toBe(25);
    pad.sticks.throttle = 0.4;
    expect(h.controller.takeManual('alt-hold')).toBe('Lower the throttle to take manual control on the ground');
    pad.sticks.throttle = 0;
    pad.status = 'disconnected';
    expect(h.controller.takeManual('alt-hold')).toBe('The controller is not connected');
    pad.status = 'connected';
    expect(h.controller.takeManual('alt-hold')).toBeNull();
    expect(h.controller.state).toEqual({ name: 'running', experimentId: id, flight: 'manual', warning: null });
    expect(h.physics.manual).toEqual([true]);
    expect(commands(h.physics.frames(), SET_MODE).map(frame => frame.params[1])).toEqual([ALT_HOLD]);
    // Throttle down, sticks centred: 1000 us throttle, 1500 us elsewhere; channels 5 to 8 ignored (65535).
    expect(overrides(h).at(-1)).toEqual([1500, 1500, 1000, 1500, 65535, 65535, 65535, 65535]);
    const before = overrides(h).length;
    h.clock.advance(400);
    expect(overrides(h).length - before).toBe(10);
    // The mode is confirmed, so the next second's duty arms.
    mav(h, heartbeat(ALT_HOLD, false));
    h.clock.advance(1000);
    expect(commands(h.physics.frames(), ARM).map(frame => frame.params[0])).toEqual([1]);
    mav(h, heartbeat(ALT_HOLD, true));
    pad.sticks = { roll: 0.5, pitch: -0.25, yaw: 1, throttle: 0.75 };
    h.clock.advance(40);
    expect(overrides(h).at(-1)).toEqual([1750, 1375, 1750, 2000, 65535, 65535, 65535, 65535]);
    expect(h.controller.view.manual).toEqual({ mode: 'alt-hold', device: 'Test transmitter', waiting: null });
  });

  test('an unplugged controller pauses the run, which resumes only when it is back, and goes on in manual control', async () => {
    const { h, pad } = await manualHarness();
    expect(h.controller.takeManual('loiter')).toBeNull();
    mav(h, heartbeat(5, true));
    pad.status = 'disconnected';
    h.clock.advance(40);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'paused', reason: 'controller' });
    const sent = overrides(h).length;
    h.clock.advance(1000);
    expect(overrides(h).length).toBe(sent);
    expect(h.controller.resumeBlocker()).toBe('Reconnect the controller, or release manual control');
    expect(h.controller.resume()).toBe(false);
    pad.status = 'connected';
    expect(h.controller.resume()).toBe(true);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'manual' });
    expect(h.controller.view.manual?.mode).toBe('loiter');
    h.clock.advance(40);
    expect(overrides(h).length).toBeGreaterThan(sent);
  });

  test('a swapped controller pauses the run, and Resume gives the flight back to MirageSITL, holding position in GUIDED', async () => {
    const { h, pad } = await manualHarness();
    expect(h.controller.takeManual('alt-hold')).toBeNull();
    mav(h, heartbeat(ALT_HOLD, true));
    pad.generation = 2;
    pad.deviceName = 'Another transmitter';
    h.clock.advance(40);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'paused', reason: 'controller' });
    expect(h.controller.resume()).toBe(true);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'flying' });
    expect(h.controller.view.manual).toBeNull();
    // The override is released (0 for channels 1-4, the mapped ones) and the mode set to GUIDED.
    expect(overrides(h).at(-1)).toEqual([0, 0, 0, 0, 0, 65535, 65535, 65535]);
    expect(commands(h.physics.frames(), SET_MODE).at(-1)?.params[1]).toBe(GUIDED);
    expect(h.physics.manual).toEqual([true, false]);
  });

  test('the Worker pauses the run when stick commands stop, and a landing that disarms ends manual control', async () => {
    const { h, pad, id } = await manualHarness();
    expect(h.controller.takeManual('alt-hold')).toBeNull();
    mav(h, heartbeat(ALT_HOLD, true));
    h.controller.worker({ type: 'sitl.input-stale', simTimeS: 45 });
    expect(h.controller.state).toMatchObject({ name: 'paused', reason: 'controller' });
    expect(h.controller.resume()).toBe(true);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'manual' });
    pad.sticks.throttle = 0;
    mav(h, heartbeat(ALT_HOLD, false));
    expect(h.controller.view.manual).toBeNull();
    expect(h.controller.state).toEqual({ name: 'ready', experimentId: id });
  });

  test('in flight it takes over in altitude hold or loiter without arming, never in stabilize', async () => {
    const h = harness(), pad = new FakeController();
    h.controller.setInput(pad);
    await reach(h, 'flying');
    pad.sticks.throttle = 0.5;
    expect(h.controller.takeManual('stabilize')).toBe('In flight, take manual control in altitude hold or loiter, which hold with the throttle centred');
    expect(h.controller.takeManual('alt-hold')).toBeNull();
    mav(h, heartbeat(ALT_HOLD, true));
    h.clock.advance(1000);
    expect(commands(h.physics.frames(), ARM).filter(frame => frame.params[0] === 1)).toHaveLength(1);
    expect(h.controller.releaseManual()).toBeNull();
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'flying' });
  });
});

describe('the run\'s recording (TASK-163)', () => {
  test('is prepared before the record, which names it, records before the first frame, and gets the telemetry, parameters, accidents and pauses', async () => {
    const made: ScriptedRecording[] = [];
    const h = harness(undefined, events => { const made1 = new ScriptedRecording(events); made.push(made1); return made1; });
    const [r] = made;
    if (!r) throw new Error('No recording');
    const id = await reach(h, 'flying');
    // The recording sits between the record and the bridge: no tick of the run goes unrecorded.
    const at = (event: string) => h.events.indexOf(event);
    expect([at('recording.prepare') < at('record.create'), at('record.create') < at('recording.start'), at('recording.start') < at('physics.connect')])
      .toEqual([true, true, true]);
    expect(r.identity).toEqual({ experimentId: id, modelSha256: h.run.manifestSha256, firmware: { commit: FIRMWARE.commit, binarySha256: FIRMWARE.binarySha256 } });
    expect(h.views.flatMap(view => (view.state.name === 'starting' ? [view.state.step] : []))).toContain('recording');
    expect(h.records.payloads.at(-1)?.recording?.recordId).toBe('c'.repeat(32));
    // Every autopilot frame reaches it, and the snapshot follows the confirmed parameters.
    expect(r.frames).toContain(0);
    expect(r.calls).toEqual([`parameters:${h.run.parameters.length + siteParameters(DEFAULT_HOME).length}`]);
    h.controller.worker(accidentMessage(41000, 3));
    expect(h.controller.continueAfterAccident()).toBe(true);
    await settle();
    expect(r.calls.slice(1)).toEqual(['accidents:41000', 'pause:1', 'pause:0']);
    await h.controller.stop();
    expect(at('recording.stop')).toBeGreaterThan(at('recording.start'));
  });

  test('a recording that cannot start stops the run with its reason and a fix', async () => {
    const h = harness(undefined, events => {
      const recording = new ScriptedRecording(events);
      recording.startAnswer = () => Promise.reject(new Error('QuotaExceededError'));
      return recording;
    });
    await h.controller.start(h.request);
    await until(() => h.controller.state.name === 'failed', 5000, 'the failed recording');
    expect(failed(h).reason).toEqual({ kind: 'recording', message: 'QuotaExceededError' });
    expect(failed(h).restart).toEqual({ kind: 'fix-first', instruction: 'Free storage or lower the rates in the Logging tab, then press Start again' });
    expect(stoppedBeforeFailed(h)).toBe(true);
    expect(h.events).not.toContain('physics.connect');
    expect(h.events).toContain('recording.stop');
  });
});

describe('missing terrain (TASK-186)', () => {
  const chunks: TerrainChunk[] = [{ northIndex: 0, eastIndex: 0, downM: new Float64Array(129 * 129).fill(-2) }, { northIndex: -1, eastIndex: 0, downM: new Float64Array(129 * 129) }];
  const record = { sourceId: 'fabdem-elevation' as const, layerSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), radiusM: 256, level: 15, chunks: 2, missingChunks: 2,
    latticeSha256: 'c'.repeat(64), homeHeightM: 602.5 };
  const missing = (tick: number, northM = 520, eastM = -3) => ({ type: 'terrain.missing', tick, simTimeS: tick / 800, northM, eastM, count: 1 });
  test('a real-terrain run hands its chunks to the physics and its terrain to the record; a run on the pad hands neither', async () => {
    const h = harness();
    h.records.answer = () => Promise.resolve({ sha256: 'd'.repeat(64) });
    await h.controller.start({ ...h.request, terrain: { record, chunks } });
    expect(h.physics.terrains).toEqual([chunks]);
    expect(h.records.payloads[0]?.terrain).toEqual(record);
    await h.controller.stop();
    await h.controller.start(h.request);
    expect(h.physics.terrains.at(-1)).toBeNull();
    expect(h.records.payloads.at(-1)?.terrain).toBeNull();
  });
  test('missing terrain pauses the run on its tick with reason terrain and where; Resume is refused with why, and Stop ends it', async () => {
    const h = harness();
    const id = await reach(h, 'flying');
    h.controller.worker(missing(41000));
    expect(h.controller.state).toMatchObject({ name: 'paused', experimentId: id, reason: 'terrain' });
    expect(h.controller.view.terrainMissing).toEqual({ tick: 41000, simTimeS: 41000 / 800, northM: 520, eastM: -3 });
    expect(h.controller.view.pauses.at(-1)).toMatchObject({ reason: 'terrain', resumedWallMs: null });
    expect(h.controller.resumeBlocker()).toBe('The terrain under the aircraft is not loaded, and a run loads its terrain only before it starts: stop the run');
    expect(h.controller.resume()).toBe(false);
    expect(h.controller.continueAfterAccident()).toBe(false);
    await settle();
    expect(h.events).not.toContain('physics.resume');
    // The first place is kept; a malformed notice is ignored.
    h.controller.worker(missing(41001, 521, -3));
    h.controller.worker({ type: 'terrain.missing', tick: 'soon', simTimeS: 1, northM: 0, eastM: 0, count: 2 });
    expect(h.controller.view.terrainMissing?.tick).toBe(41000);
    await h.controller.stop();
    expect(h.controller.state).toMatchObject({ name: 'idle' });
    await reach(h, 'ready');
    expect(h.controller.view.terrainMissing).toBeNull();
  });
  test('a run already paused by its user takes the terrain as its reason, and an accident pause keeps its own', async () => {
    const h = harness();
    await reach(h, 'flying');
    expect(h.controller.pause('user')).toBe(true);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'paused', reason: 'user' });
    h.controller.worker(missing(42000));
    expect(h.controller.state).toMatchObject({ name: 'paused', reason: 'terrain' });
    expect(h.controller.resume()).toBe(false);
    await h.controller.stop();
    await reach(h, 'flying');
    h.controller.worker(accidentMessage(43000, 1));
    h.controller.worker(missing(43000));
    expect(h.controller.state).toMatchObject({ name: 'paused', reason: 'accident' });
    expect(h.controller.view.terrainMissing?.tick).toBe(43000);
  });
});

describe('accident pause (TASK-149)', () => {
  test('an accident in flight pauses the run with it; continuing returns to the flight, labelled, and the next accident pauses again', async () => {
    const h = harness();
    const id = await reach(h, 'flying');
    h.controller.worker(accidentMessage(41000, 3));
    expect(h.controller.state).toMatchObject({ name: 'paused', experimentId: id, atSimTimeS: 41000 / 800, reason: 'accident' });
    const paused = h.controller.state;
    if (paused.name !== 'paused') throw new Error('Expected paused');
    expect(paused.accidents.map(event => [event.tick, event.part])).toEqual([[41000, { part: 'propeller', rotorId: 3 }]]);
    expect(h.controller.view.afterAccident).toBe(false);
    // Paused: no flight-stage command and no stop.
    expect(h.controller.land()).toBe(false);
    expect(h.events.filter(event => event.startsWith('launcher.stop'))).toEqual([]);
    expect(h.controller.continueAfterAccident()).toBe(true);
    await settle();
    expect(h.events).toContain('physics.resume');
    expect(h.controller.state).toMatchObject({ name: 'running', experimentId: id, flight: 'flying' });
    expect(h.controller.view.afterAccident).toBe(true);
    expect(h.controller.view.accidents).toHaveLength(1);
    h.controller.worker(accidentMessage(42000, 1));
    expect(h.controller.state).toMatchObject({ name: 'paused', reason: 'accident' });
    expect(h.controller.view.accidents).toHaveLength(2);
    expect(h.controller.continueAfterAccident()).toBe(true);
    await settle();
    expect(h.controller.state).toMatchObject({ name: 'running', flight: 'flying' });
    await h.controller.stop();
    expect(h.controller.state).toMatchObject({ name: 'idle' });
  });

  test('continuing is refused unless an accident paused the run, and a failed resume stops the run with its reason', async () => {
    const h = harness();
    await reach(h, 'ready');
    expect(h.controller.continueAfterAccident()).toBe(false);
    h.controller.worker({ type: 'accident.events', events: [{ tick: 'one' }], dropped: 0, total: 1 });
    expect(h.controller.state.name).toBe('ready');
    h.controller.worker(accidentMessage(32000, 2));
    expect(h.controller.state).toMatchObject({ name: 'paused', reason: 'accident' });
    h.physics.resumeAnswer = () => Promise.reject(new Error('sim.start: Session is faulted'));
    expect(h.controller.continueAfterAccident()).toBe(true);
    await until(() => h.controller.state.name === 'failed', 5000, 'the failed resume');
    expect(failed(h).reason).toEqual({ kind: 'physics', message: 'sim.start: Session is faulted' });
    expect(stoppedBeforeFailed(h)).toBe(true);
  });

  test('a new run forgets the previous run\'s accidents and label', async () => {
    const h = harness();
    await reach(h, 'ready');
    h.controller.worker(accidentMessage(32000, 2));
    expect(h.controller.continueAfterAccident()).toBe(true);
    await settle();
    expect(h.controller.view.afterAccident).toBe(true);
    await h.controller.stop();
    await reach(h, 'ready');
    expect(h.controller.view.accidents).toEqual([]);
    expect(h.controller.view.afterAccident).toBe(false);
  });
});

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

  test('a physics fault during a run stops SITL and says why, so the flight never freezes without a word', async () => {
    const h = harness();
    const id = await reach(h, 'ready');
    h.controller.worker({ type: 'fault-v2', protocolVersion: 2, message: 'Contact step failed (status -6)' });
    await settle();
    const state = failed(h);
    expect(state.reason).toEqual({ kind: 'physics-fault', message: 'Contact step failed (status -6)' });
    expect(state.during).toBe('ready');
    expect(failureText(state.reason)).toContain('Contact step failed (status -6)');
    expect(h.launcher.stops).toEqual([id]);
    expect(stoppedBeforeFailed(h)).toBe(true);
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
    expect(h.records.payloads.map(payload => owned(payload).experimentId)).toEqual([first, second]);
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
        connect: spec => { events.push('launcher.connect'); return client.connect(spec); },
        disconnect: id => { events.push(`launcher.disconnect ${id}`); return client.disconnect(id); },
        connection: id => { events.push('launcher.connection'); return client.connection(id); },
      };
      const physics = new BridgePhysics(events), clock = new FakeClock(), records = new StoreRecords(fixture, events);
      const controller = new SessionController(counted, physics, records, clock, view => {
        views.push(view);
        if (events.at(-1) !== `state:${view.state.name}`) events.push(`state:${view.state.name}`);
      });
      physics.deliver = data => { controller.worker(data); };
      const request: StartRequest = { prepare: () => Promise.resolve(prepared), firmwareId: 'fake', speedup: 1, physicsHz: 800, home: DEFAULT_HOME, environment: null };
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
      // TASK-148: the first 3D fix at the session's home, which READY waits for.
      mav(h, streamMessage(24));
    }
    /** A restart from failed on the real launcher: a new experiment (no 409) with a new record; then a user Stop that leaves no process. */
    async function restartAndStop(h: Harness, earlier: readonly string[], firmwareId = 'fake'): Promise<void> {
      fake.setMode('idle');
      const before = await experimentIds(client());
      const id = await connectedId(h, firmwareId);
      expect(earlier).not.toContain(id);
      expect(await experimentIds(client())).toEqual([...before, id]);
      expect(h.records.payloads.map(payload => owned(payload).experimentId)).toEqual([...earlier, id]);
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
        expect(h.records.payloads.map(payload => owned(payload).experimentId)).toEqual([id]);
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
      expect(parm.length).toBe(prepared.parameters.length + siteParameters(DEFAULT_HOME).length);
      expect(payload.parameters.map(p => ({ name: p.name, value: p.value }))).toEqual(parm);
      // The build is the one the launcher recorded and ran.
      const recorded = field(readJson(join(workDirectory(id), 'experiment.json')), 'firmware');
      const identity = identityOf(recorded);
      expect(owned(payload).ardupilot).toEqual({ catalogId: identity.id, firmwareVersion: identity.firmwareVersion, commit: identity.commit,
        binarySha256: identity.binarySha256, defaultParametersSha256: identity.defaultParametersSha256 });
      expect(owned(payload).ardupilot.binarySha256).toBe(fileSha(fake.binary));
      expect(owned(payload).ardupilot.defaultParametersSha256).toBe(fileSha(fakeDefaults));
      expect(owned(payload).ardupilot.commit).toBe(SITL_COMMIT);
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

// ---- TASK-155: a SITL the user started -----------------------------------------------------------
//
// Oracles: the user decisions of 2026-11-01 (a SITL with built-in physics is
// refused; only verified source commits connect; parameters are checked, never
// written, and every difference is named; a connection is recorded as schema
// 2), the launcher's ownership rule (a connection is disconnected, never
// stopped), ArduPilot's AUTOPILOT_VERSION layout (flight_sw_version packs
// major, minor, patch and type; flight_custom_version is the git hash), and
// the declared limits: first servo packet within 15 s of wall time, version
// within 10 s of simulated time, GPS within 10 m and 5 m of home, heartbeat
// silence of 10 s wall.

const PARAM_SET = 23, REQUEST_MESSAGE = 512, AUTOPILOT_VERSION_ID = 148, GPS_RAW_INT = 24;
const ENDPOINTS: ConnectionSpec = { jsonPhysicsPort: 9002, mavlink: { transport: 'tcp', port: 5760 } };
/** FIRMWARE_VERSION_TYPE_DEV (common.xml). */
const VERSION_DEV = 0, VERSION_OFFICIAL = 255;
function autopilotVersion(gitHash: string, major = 4, minor = 8, patch = 0, type = VERSION_DEV): Uint8Array {
  const custom = Array.from({ length: 8 }, (_, i) => gitHash.charCodeAt(i) || 0);
  return autopilotFrame(AUTOPILOT_VERSION_ID, { capabilities: 0, uid: 0, flight_sw_version: ((major << 24) | (minor << 16) | (patch << 8) | type) >>> 0,
    middleware_sw_version: 0, os_sw_version: 0, board_version: 0, vendor_id: 0, product_id: 0, flight_custom_version: custom,
    middleware_custom_version: Array.from({ length: 8 }, () => 0), os_custom_version: Array.from({ length: 8 }, () => 0) });
}
/** A 3D GPS fix `northM` metres north and `upM` metres above the default home. */
function gpsFix(northM = 0, upM = 0): Uint8Array {
  const [lat, lon, alt] = DEFAULT_HOME;
  return autopilotFrame(GPS_RAW_INT, { time_usec: 0, fix_type: 3, lat: Math.round((lat + northM / 111194.9) * 1e7), lon: Math.round(lon * 1e7),
    alt: Math.round((alt + upM) * 1000), eph: 100, epv: 100, vel: 0, cog: 0, satellites_visible: 10 });
}
function connectRequest(prepare: () => Promise<PreparedRun> = () => Promise.resolve(prepared)) {
  return { prepare, endpoints: ENDPOINTS, physicsHz: 800 as const, home: DEFAULT_HOME, environment: null, verifiedCommits: [SITL_COMMIT] };
}
/** True when the connection was released before the panel showed failed, and nothing was ever stopped. */
function disconnectedBeforeFailed(h: Harness): boolean {
  const released = h.events.findIndex(event => event.startsWith('launcher.disconnect')), shown = h.events.indexOf('state:failed');
  return released >= 0 && shown > released && h.launcher.stops.length === 0;
}
type ConnectStage = 'connecting' | 'version' | 'loading-parameters' | 'warming' | 'ready';
/** Drives a connection with ArduCopter's frames until `stage`; returns the connection ID. */
async function connectTo(h: Harness, stage: ConnectStage): Promise<string> {
  await h.controller.connect(connectRequest());
  const id = h.launcher.lastConnectionId;
  expect(h.controller.state).toEqual({ name: 'starting', step: 'connecting', experimentId: id });
  if (stage === 'connecting') return id;
  status(h, { state: 'open', simTimeS: 0.5 });
  mav(h, heartbeat(STABILIZE, false));
  expect(h.controller.state).toEqual({ name: 'starting', step: 'version', experimentId: id });
  if (stage === 'version') return id;
  mav(h, autopilotVersion(SITL_COMMIT.slice(0, 8)));
  expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: id });
  if (stage === 'loading-parameters') return id;
  mav(h, ...parameterList(h.run.parameters));
  expect(h.controller.state).toMatchObject({ name: 'warming', experimentId: id });
  if (stage === 'warming') return id;
  // TASK-148: READY waits for ArduPilot's first 3D fix at the session's home, or at the flight task's ground start.
  mav(h, streamMessage(24, h.request.flightTask?.definition.initial.ground));
  status(h, { ready: true, reason: '', simTimeS: 40 });
  mav(h, gpsFix(1, 0.5));
  // The record goes through the real store (manifest derivation, hashing) before READY.
  await until(() => h.controller.state.name !== 'warming', 10000, 'the connection record');
  expect(h.controller.state).toEqual({ name: 'ready', experimentId: id });
  return id;
}
function reasons(h: Harness): readonly string[] {
  const reason = failed(h).reason;
  if (reason.kind !== 'incompatible') throw new Error(`Expected incompatible, the reason is ${reason.kind}`);
  return reason.reasons;
}

describe('SessionController connections to a SITL the user started (TASK-155)', () => {
  test('connects at the session rate, checks version, parameters and home without writing, records schema 2, becomes READY and disconnects', async () => {
    const h = harness();
    await h.controller.connect(connectRequest());
    const id = h.launcher.lastConnectionId;
    expect(h.launcher.connectSpecs).toEqual([ENDPOINTS]);
    // Physics steps at the session's rate, which SIM_JSON adopts, not at the 1200 Hz default its first packets announce.
    expect(h.physics.loads).toEqual([800]);
    expect(h.physics.connects).toEqual([{ port: h.launcher.connectionView(id).ports?.bridge, bridgeEpoch: 1, speedup: 1 }]);
    expect(h.events.indexOf('launcher.connect')).toBeLessThan(h.events.indexOf('physics.load'));
    expect(h.controller.view.ownership).toBe('external');
    expect(h.controller.view.compatibility.map(check => check.check)).toEqual(['physics', 'clock']);
    expect(h.controller.view.compatibility[0]?.text).toBe('JSON physics on UDP port 9002 with 16 servo channels; MirageSITL steps it at 800 Hz, which SITL adopts (it announced 1200 Hz)');
    expect(h.controller.view.compatibility[1]?.text).toContain('so Pause stops it with the physics (TASK-156)');
    status(h, { state: 'open', simTimeS: 0.5 });
    mav(h, heartbeat(STABILIZE, false));
    expect(h.controller.state).toEqual({ name: 'starting', step: 'version', experimentId: id });
    const versionRequests = () => commands(h.physics.frames(), REQUEST_MESSAGE);
    expect(versionRequests().map(frame => frame.params[0])).toEqual([AUTOPILOT_VERSION_ID]);
    h.clock.advance(1000);
    expect(versionRequests().length).toBe(2);
    mav(h, autopilotVersion(SITL_COMMIT.slice(0, 8)));
    expect(h.controller.state).toMatchObject({ name: 'loading-parameters', experimentId: id });
    expect(listRequests(h.physics.frames())).toHaveLength(1);
    mav(h, ...parameterList(h.run.parameters));
    expect(h.controller.state).toMatchObject({ name: 'warming', experimentId: id });
    // READY waits for the home check and the record.
    status(h, { ready: true, reason: '', simTimeS: 40 });
    expect(h.controller.state.name).toBe('warming');
    expect(h.records.payloads).toEqual([]);
    mav(h, autopilotFrame(GPS_RAW_INT, { time_usec: 0, fix_type: 2, lat: 0, lon: 0, alt: 0, eph: 0, epv: 0, vel: 0, cog: 0, satellites_visible: 4 }));
    expect(h.records.payloads).toEqual([]);
    mav(h, gpsFix(3, -2));
    await until(() => h.controller.state.name !== 'warming', 10000, 'the connection record');
    expect(h.controller.state).toEqual({ name: 'ready', experimentId: id });
    expect(h.controller.view.compatibility.map(check => check.check)).toEqual(['physics', 'clock', 'armed', 'version', 'parameters', 'home']);
    // The record: schema 2, external, written once, readable from the store.
    expect(h.records.payloads).toHaveLength(1);
    const payload = h.records.payloads[0];
    expect(payload?.sitl).toEqual({ ownership: 'external', connectionId: id,
      ardupilot: { commit: SITL_COMMIT, gitHash: SITL_COMMIT.slice(0, 8), firmwareVersion: '4.8.0-dev' }, endpoints: ENDPOINTS });
    expect(payload?.session).toMatchObject({ physicsHz: 800, speedup: null, home: DEFAULT_HOME, betModuleSha256: BET_SHA });
    expect(payload?.frameScript).toBeNull();
    expect(payload?.parameters).toEqual(h.run.parameters);
    const stored = h.records.stored[0];
    if (!stored) throw new Error('No stored record');
    expect(readExperiment(stored)).toEqual(payload);
    expect(stored.record.name).toBe(`${fixture.stored.record.name} connection ${id}`);
    expect(h.controller.view.recordSha256).toBe(stored.sha256);
    // Nothing was written to the SITL: no PARAM_SET, and the launcher never started or stopped a process.
    expect(h.physics.frames().filter(frame => frame.id === PARAM_SET)).toEqual([]);
    expect([h.launcher.count('start'), h.launcher.count('catalog'), h.launcher.stops]).toEqual([0, 0, []]);
    // The flight runs as for a launcher-owned SITL.
    expect(h.controller.takeOff(TAKEOFF_M)).toBe(true);
    await h.controller.stop();
    expect(h.launcher.disconnects).toEqual([id]);
    expect(h.launcher.stops).toEqual([]);
    expect(h.controller.state).toEqual({ name: 'idle', last: `Disconnected from connection ${id}; the SITL keeps running` });
  });

  test('a launcher-owned start still configures physics at its requested rate', async () => {
    const h = harness();
    await h.controller.start(h.request);
    expect(h.physics.loads).toEqual([800]);
    expect(h.controller.view.ownership).toBe('launcher');
    expect(h.controller.view.compatibility).toEqual([]);
  });

  describe('refuses an incompatible SITL, names every reason, records nothing and only disconnects', () => {
    test('a profile that needs a frame script, before any connection', async () => {
      const h = harness();
      await h.controller.connect(connectRequest(() => Promise.resolve({ ...prepared, frameScript: 'MotorsMatrix:init(16)\n' })));
      expect(reasons(h)).toEqual(['this profile\'s frame needs a MirageSITL frame script, which MirageSITL installs only in a SITL it starts; use Start SITL run']);
      expect(failed(h).restart).toMatchObject({ kind: 'fix-first' });
      expect([h.launcher.count('connect'), h.launcher.disconnects.length, h.records.payloads.length]).toEqual([0, 0, 0]);
    });

    test('built-in physics: MAVLink but no JSON servo packets within 15 s', async () => {
      const h = harness();
      h.launcher.probe = { rateHz: null, channels: null, bytesFromSitl: 4096, afterPolls: 0 };
      const connecting = h.controller.connect(connectRequest());
      await settle();
      expect(h.controller.state).toMatchObject({ name: 'starting', step: 'probing' });
      for (let ms = 0; ms <= 15000; ms += 250) { h.clock.advance(250); await settle(); }
      await connecting;
      expect(reasons(h)[0]).toContain('the SITL talks MAVLink but sent no JSON physics packets to UDP port 9002 within 15 s: it runs a built-in physics model');
      expect(reasons(h)[0]).toContain('start it with --model JSON and --sim-port-out 9002');
      expect(failed(h).restart).toEqual({ kind: 'fix-first', instruction: 'Restart your SITL as the reasons say, or choose another profile, then press Connect again' });
      expect(disconnectedBeforeFailed(h)).toBe(true);
      expect(h.physics.loads).toEqual([]);
      expect(failed(h).diagnostics).toMatchObject({ ownership: 'external', launcherState: null, stdout: '', connection: { servoPackets: 0, rateHz: null, bytesFromSitl: 4096 } });
    });

    test('nothing at all within 15 s', async () => {
      const h = harness();
      h.launcher.probe = { rateHz: null, channels: null, bytesFromSitl: 0, afterPolls: 0 };
      const connecting = h.controller.connect(connectRequest());
      for (let ms = 0; ms <= 15000; ms += 250) { await settle(); h.clock.advance(250); }
      await connecting;
      expect(reasons(h)[0]).toContain('no JSON physics packets reached UDP port 9002 within 15 s');
      expect(disconnectedBeforeFailed(h)).toBe(true);
    });

    test('JSON packets that arrive after a few polls are accepted, whatever rate they announce', async () => {
      const h = harness();
      h.launcher.probe = { rateHz: 400, channels: 32, bytesFromSitl: 0, afterPolls: 3 };
      const connecting = h.controller.connect(connectRequest());
      for (let i = 0; i < 4; i++) { await settle(); h.clock.advance(250); }
      await connecting;
      expect(h.controller.state).toMatchObject({ name: 'starting', step: 'connecting' });
      expect(h.physics.loads).toEqual([800]);
      expect(h.launcher.count('connection')).toBe(3);
      expect(h.controller.view.compatibility[0]?.text).toContain('with 32 servo channels; MirageSITL steps it at 800 Hz, which SITL adopts (it announced 400 Hz)');
    });

    test('an armed SITL', async () => {
      const h = harness();
      await connectTo(h, 'connecting');
      status(h, { state: 'open', simTimeS: 0.5 });
      mav(h, heartbeat(GUIDED, true));
      await settle();
      expect(reasons(h)[0]).toContain('the SITL is armed: disarm it before connecting');
      expect(disconnectedBeforeFailed(h)).toBe(true);
    });

    test.each([
      ['another commit', autopilotVersion('0123abcd', 4, 6, 2, VERSION_OFFICIAL), 'the SITL reports ArduPilot 4.6.2 built from commit 0123abcd; MirageSITL has verified only commit 8ab6afde'],
      ['no git hash', autopilotVersion('', 4, 7, 0), 'the SITL reports ArduPilot 4.7.0-dev built from a source without a git hash'],
    ])('a version from %s', async (_label, frame, message) => {
      const h = harness();
      await connectTo(h, 'version');
      mav(h, frame);
      await settle();
      expect(reasons(h)[0]).toContain(message);
      expect(disconnectedBeforeFailed(h)).toBe(true);
      expect(listRequests(h.physics.frames())).toEqual([]);
    });

    test('no version within 10 s of simulated time', async () => {
      const h = harness();
      await connectTo(h, 'version');
      status(h, { simTimeS: 10.4 });
      h.clock.advance(1000);
      expect(h.controller.state.name).toBe('starting');
      status(h, { simTimeS: 10.6 });
      h.clock.advance(1000);
      await settle();
      expect(reasons(h)).toEqual(['the SITL did not report its version (AUTOPILOT_VERSION) within 10 s of simulated time']);
    });

    test('parameters that differ: every difference is named and nothing is written', async () => {
      const h = harness();
      await connectTo(h, 'loading-parameters');
      const [first, second, third] = h.run.parameters;
      if (!first || !second || !third) throw new Error('Too few generated parameters');
      const list = parameterList(h.run.parameters.filter(p => p.name !== third.name).map(p =>
        p.name === first.name ? { ...p, value: first.value + 1 } : p.name === second.name ? { ...p, value: second.value + 2 } : p));
      mav(h, ...list);
      await settle();
      const [text] = reasons(h);
      expect(text).toContain('the SITL\'s parameters differ from what this profile needs (MirageSITL writes nothing to a SITL it did not start)');
      expect(text).toContain(`${first.name} is ${first.value + 1} (needs ${first.value})`);
      expect(text).toContain(`${second.name} is ${second.value + 2} (needs ${second.value})`);
      expect(text).toContain(`${third.name} does not exist (needs ${third.value})`);
      expect(h.physics.frames().filter(frame => frame.id === PARAM_SET)).toEqual([]);
      expect(disconnectedBeforeFailed(h)).toBe(true);
      expect(h.records.payloads).toEqual([]);
    });

    test('more than 12 differences are counted after the first 12', async () => {
      const h = harness();
      await connectTo(h, 'loading-parameters');
      expect(h.run.parameters.length).toBeGreaterThan(15);
      mav(h, ...parameterList(h.run.parameters.map((p, index) => (index < 15 ? { ...p, value: p.value + 1 } : p))));
      await settle();
      expect(reasons(h)[0]).toContain('and 3 more parameters differ');
      expect((reasons(h)[0] ?? '').split(' (needs ').length - 1).toBe(12);
    });

    test('a GPS fix away from the session home', async () => {
      const h = harness();
      await connectTo(h, 'warming');
      mav(h, gpsFix(1000, 0));
      await settle();
      expect(reasons(h)[0]).toContain('the SITL\'s GPS puts it 1000 m from and 0 m above or below the session\'s home: start it with --home -35.363261,149.16523,584,0');
      expect(disconnectedBeforeFailed(h)).toBe(true);
      expect(h.records.payloads).toEqual([]);
      const high = harness();
      await connectTo(high, 'warming');
      mav(high, gpsFix(0, 6));
      await settle();
      expect(reasons(high)[0]).toContain('0 m from and 6 m above or below');
    });

    test('a launcher refusal of the ports, with nothing to release', async () => {
      const h = harness();
      h.launcher.connectAnswer = () => Promise.reject(new LauncherError('refused', 'Nothing accepts MAVLink TCP connections on 127.0.0.1:5760; start SITL first', 409));
      await h.controller.connect(connectRequest());
      expect(failed(h).reason).toEqual({ kind: 'launcher-refused', message: 'Nothing accepts MAVLink TCP connections on 127.0.0.1:5760; start SITL first' });
      expect(failed(h).restart).toEqual({ kind: 'fix-first', instruction: 'Check that your SITL is running and which ports it uses, then press Connect again' });
      expect(h.launcher.disconnects).toEqual([]);
    });
  });

  describe('after admission', () => {
    test('SITL closing its TCP connection is sitl-ended with the launcher\'s reason; Connect again is a new connection', async () => {
      const h = harness();
      const id = await connectTo(h, 'ready');
      h.launcher.closeBySitl(id, 'SITL closed its MAVLink TCP connection');
      status(h, { state: 'closed', message: 'Bridge closed' });
      await settle();
      expect(failed(h).reason).toEqual({ kind: 'sitl-ended', during: 'ready', ending: 'SITL closed its MAVLink TCP connection' });
      expect(failureText(failed(h).reason)).toBe('SITL ended while ready (SITL closed its MAVLink TCP connection)');
      expect(failed(h).restart).toEqual({ kind: 'start-again' });
      expect(disconnectedBeforeFailed(h)).toBe(true);
      expect(failed(h).diagnostics).toMatchObject({ ownership: 'external', experimentId: id, ending: 'SITL closed its MAVLink TCP connection' });
      await h.controller.connect(connectRequest());
      expect(h.launcher.lastConnectionId).not.toBe(id);
      expect(h.controller.view.compatibility.map(check => check.check)).toEqual(['physics', 'clock']);
      expect(h.controller.view.recordSha256).toBeNull();
    });

    test('a bridge lost while the connection stays open is bridge-lost', async () => {
      const h = harness();
      await connectTo(h, 'warming');
      status(h, { state: 'closed', message: 'Bridge peer unresponsive' });
      await settle();
      expect(failed(h).reason).toEqual({ kind: 'bridge-lost', message: 'Bridge peer unresponsive' });
      expect(disconnectedBeforeFailed(h)).toBe(true);
    });

    test('heartbeat silence of 10 s wall disconnects with sitl-silent', async () => {
      const h = harness();
      await connectTo(h, 'ready');
      h.clock.advance(9000);
      expect(h.controller.state.name).toBe('ready');
      h.clock.advance(2000);
      await settle();
      expect(failed(h).reason).toEqual({ kind: 'sitl-silent', seconds: 10 });
      expect(failureText(failed(h).reason)).toContain('the SITL itself was not stopped');
      expect(disconnectedBeforeFailed(h)).toBe(true);
    });

    test('Disconnect while probing releases the connection and stays idle', async () => {
      const h = harness();
      h.launcher.probe = { rateHz: 1200, channels: 16, bytesFromSitl: 0, afterPolls: 100 };
      const connecting = h.controller.connect(connectRequest());
      await settle();
      expect(h.controller.state).toMatchObject({ name: 'starting', step: 'probing' });
      await h.controller.stop();
      h.clock.advance(250);
      await connecting;
      await settle();
      expect(h.controller.state.name).toBe('idle');
      expect(h.launcher.disconnects).toEqual([h.launcher.lastConnectionId]);
      expect(h.physics.loads).toEqual([]);
    });

    test('a failed disconnect offers Disconnect again with the original reason', async () => {
      const h = harness();
      const id = await connectTo(h, 'ready');
      h.launcher.disconnectAnswer = () => Promise.reject(new LauncherError('unreachable', 'No MirageSITL launcher answered on 127.0.0.1:47800'));
      h.clock.advance(11000);
      await settle();
      expect(failed(h).restart).toEqual({ kind: 'stop-again', experimentId: id, prior: { kind: 'sitl-silent', seconds: 10 }, during: 'ready' });
      h.launcher.disconnectAnswer = null;
      await h.controller.stop();
      expect(failed(h).reason).toEqual({ kind: 'sitl-silent', seconds: 10 });
      expect(h.launcher.disconnects).toEqual([id, id]);
      expect(h.launcher.stops).toEqual([]);
    });
  });
});

// ---- TASK-157: the motor check on scripted ports ------------------------------------------------
//
// Oracles: the S19 quad X frame of the TASK-128 catalog (ArduPilot test order
// 1, 2, 3, 4 = motors 1, 4, 2, 3; motors 1 and 2 counter-clockwise), the
// MAV_CMD_DO_MOTOR_TEST parameters of common.xml (motor instance, throttle
// type 1 = PWM, value, timeout, count) and the declared test throttle of
// 1150 us for 1.5 s.

const DO_MOTOR_TEST = 209;
describe('the motor check (TASK-157)', () => {
  /** Statuses every 0.1 s of simulated time from `fromS` to `toS`, with `turning` (a motor ID or none) at 2,000 rev/min. */
  function run(h: Harness, fromS: number, toS: number, turning: number | null): number {
    let t = fromS;
    for (; t <= toS + 1e-9; t += 0.1) {
      h.physics.speeds = h.run.motorTest.physics.map(rotor => (rotor.motorId === turning ? 2000 : 0));
      status(h, { ready: true, reason: '', simTimeS: t });
    }
    return t;
  }

  test('spins every motor once in ArduPilot\'s test order and passes when the right rotor turns', async () => {
    const h = harness();
    await reach(h, 'ready');
    expect(h.run.motorTest.expected.map(m => [m.testOrder, m.motorId, m.output, m.spin])).toEqual([
      [1, 1, 1, 'ccw'], [2, 4, 4, 'cw'], [3, 2, 2, 'ccw'], [4, 3, 3, 'cw']]);
    expect(h.controller.checkMotors()).toBeNull();
    let t = 40;
    for (const motor of h.run.motorTest.expected) {
      t = run(h, t, t, null); // the step's command goes out on the next status
      const sent = commands(h.physics.frames(), DO_MOTOR_TEST).at(-1);
      expect(sent?.params.slice(0, 5)).toEqual([motor.testOrder, 1, 1150, 1.5, 1]);
      expect(h.controller.view.motorCheck?.testing).toBe(motor.motorId);
      expect(h.controller.takeOff(5)).toBe(false);
      mav(h, commandAck(DO_MOTOR_TEST, 0));
      t = run(h, t, t + 1.5, motor.motorId);
      t = run(h, t, t + 1.5, null);
    }
    const check = h.controller.view.motorCheck;
    expect(check?.running).toBe(false);
    expect(check?.passed).toBe(true);
    expect(check?.results.map(r => [r.expected.motorId, r.observed?.motorId, r.pass])).toEqual([[1, 1, true], [4, 4, true], [2, 2, true], [3, 3, true]]);
    expect(commands(h.physics.frames(), DO_MOTOR_TEST)).toHaveLength(4);
    // Afterwards the flight may start.
    expect(h.controller.takeOff(5)).toBe(true);
  });

  test('refuses before the parameters are loaded, while armed or airborne, and while a check runs', async () => {
    const h = harness();
    await reach(h, 'loading-parameters');
    expect(h.controller.checkMotors()).toBe('Check the motors once the parameters are loaded, before take-off');
    mav(h, ...parameterList(h.run.parameters));
    mav(h, heartbeat(STABILIZE, true));
    expect(h.controller.checkMotors()).toBe('Disarm before checking the motors');
    mav(h, heartbeat(STABILIZE, false));
    h.physics.altitude = 1;
    expect(h.controller.checkMotors()).toBe('Land before checking the motors');
    h.physics.altitude = 0;
    expect(h.controller.checkMotors()).toBeNull();
    expect(h.controller.checkMotors()).toBe('A motor check is already running');
    // In flight: no check at all.
    const flying = harness();
    await reach(flying, 'flying');
    expect(flying.controller.checkMotors()).toBe('Check the motors once the parameters are loaded, before take-off');
  });

  test('a wrong rotor fails that motor, and an ArduPilot refusal stops the check with its reason', async () => {
    const h = harness();
    await reach(h, 'ready');
    expect(h.controller.checkMotors()).toBeNull();
    let t = run(h, 40, 40, null);
    mav(h, commandAck(DO_MOTOR_TEST, 0));
    t = run(h, t, t + 1.5, 2); // ArduPilot tested motor 1, the physics turned motor 2
    t = run(h, t, t + 1.6, null);
    const first = h.controller.view.motorCheck?.results[0];
    expect(first).toMatchObject({ pass: false, observed: { motorId: 2 } });
    expect(first?.reason).toBe('Output 1 should turn motor 1, but motor 2 turned: the motor mapping is swapped');
    mav(h, statusText('Motor Test: vehicle not landed'), commandAck(DO_MOTOR_TEST, 4));
    run(h, t, t + 0.2, null);
    expect(h.controller.view.motorCheck).toMatchObject({ running: false, passed: false,
      stopped: 'ArduPilot refused the motor test (MAV_RESULT 4): Motor Test: vehicle not landed' });
  });
});
