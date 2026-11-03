// Run states of an integrated ArduPilot SITL experiment (TASK-154, TASK-155, S02).
//
// A pure state machine on injected ports, so Node tests drive it with
// scripted launcher answers, Worker events and a fake clock; the Run panel
// only renders `state`. The contract's states are idle, starting, loading
// parameters, warming, ready, running, paused, stopping and failed. A
// failure after the launcher owns a run always passes through stopping, so
// failed is shown only once the run's process group is gone, with the
// launcher's diagnostics and a restart path. A restart is a new experiment
// with a new record (user decision of 2026-11-01). An accident (TASK-149,
// decision F-09) pauses the physics session on its tick, and with it the
// autopilot, which waits in JSON lockstep: the run is `paused` with the
// accidents, and it may continue, labelled as not validated for a physically
// damaged aircraft. TASK-156 gives every pause that one path: the user's
// Pause, a hidden tab (the browser slows a hidden page's timers, which run the
// ground station, so a run never goes on there unwatched), an accident and,
// with TASK-186, missing terrain. In JSON lockstep the autopilot waits on the
// frame the paused session holds, so its simulated time stops with the
// physics; Resume continues both, and a run continued after an accident
// stays labelled. Each pause and resume is logged with its tick, simulated
// time and wall time.
//
// A run records (TASK-163) when the controller has a recording port: the
// recording is prepared before the experiment record, which names it, and
// started after the record and before the autopilot's first frame; the
// autopilot's telemetry, the parameter snapshot and the run's accidents and
// pauses go into it, and every end of the run closes it.
//
// The run's parameters (TASK-160) come from the TASK-159 parameter service,
// which downloads the autopilot's complete list when the run loads its
// parameters and classifies every later write by read-back. Writes are
// possible from warmup until the run stops, in flight and while paused; a
// paused lockstep SITL answers them after Resume. Each write is a parameter
// change with its old and new value, wall and simulated time, experiment and
// outcome.
//
// The run's speed (TASK-175) is measured from the Worker's statuses: the
// simulated over the running wall time, with paused time left out, and, for a
// real-time run, whether it holds A-05's ratio and which intervals dropped.
//
// Manual flight (TASK-174) sends the calibrated USB controller's sticks as
// RC_CHANNELS_OVERRIDE at MANUAL_RATE_HZ, with MirageSITL commanding the flight
// mode. A controller that disconnects, becomes invalid or is swapped pauses
// the run (user decision of 2026-11-03), as does the physics Worker when no
// stick command reached it for INPUT_TIMEOUT_MS, so thrust is never held on
// stale input. A run resumes in manual control only on the same, never
// unplugged controller; after an unplug or a swap, which the GamepadAdapter
// counts as a new device (TASK-038), Resume releases manual control and
// ArduPilot holds position in GUIDED.
//
// Connect (TASK-155) runs the same states against a SITL the user started.
// The launcher owns only the connection, so Stop and every failure
// disconnect and never signal the process. A connection is refused, naming
// every reason, unless (user decisions of 2026-11-01) SITL sends JSON physics
// packets, is disarmed, reports a verified source
// commit, already holds every generated parameter (nothing is written to
// it), and its GPS puts it at the session's home; the profile must need no
// frame script. Its experiment record is written once all of that holds,
// before READY can be shown.
import { EXPERIMENT_SCHEMA_VERSION, type ExperimentParameter, type ExperimentPayload, type ExperimentRecording, type ExperimentSitl } from "@mirage/aircraft/experiment";
import { readAutopilotVersion, verifiedCommit } from "@mirage/autopilot/autopilot-version";
import { CopterMode, GroundStation } from "@mirage/autopilot/ground-station";
import { MotorCheck, type ExpectedMotor, type MotorCheckResult, type PhysicsRotor } from "@mirage/autopilot/motor-test";
import type { ParameterMetadataCatalog, ParameterMetadataSet } from "@mirage/autopilot/param-metadata";
import { ParameterService, type DownloadState, type ParameterValue } from "@mirage/autopilot/param-service";
import { ParameterReadback, type AbsentRule, type ParameterDifference } from "@mirage/autopilot/parameter-readback";
import { MavParser, type MavFrame } from "@mirage/mavlink/codec";
import { PilotRcMapper } from "@mirage/mavlink/rc-override";
import { UNKNOWN_U32, newPilotInputV2, type PilotInput } from "@mirage/protocol";
import { fieldOf, readNumber } from "@mirage/mavlink/messages";
import type { AccidentEvent } from "@mirage/physics/accident";
import type { ParameterChange } from "../params/parameter-sets";
import { RunSpeedMeter, type RunSpeedView } from "./run-speed";
import type { SitlStatus } from "../sitl/bridge-client";

// ---- the launcher as the controller sees it ------------------------------------------------

export type LauncherRunState = "starting" | "start-failed" | "running" | "stopping" | "stopped" | "exited" | "crashed";
export interface LauncherRun {
  readonly run: number; readonly pid: number; readonly state: LauncherRunState;
  readonly exitCode: number | null; readonly signal: string | null; readonly reason: string | null;
}
export interface LauncherFirmware {
  readonly id: string; readonly firmwareVersion: string; readonly commit: string;
  readonly binarySha256: string; readonly defaultParametersSha256: string;
}
export interface LauncherExperiment {
  readonly id: string; readonly state: LauncherRunState; readonly startError: string | null;
  readonly firmware: LauncherFirmware; readonly runs: readonly LauncherRun[];
  readonly ports: { readonly bridge: number } | null;
}
export interface LauncherLogs { readonly stdout: string; readonly stderr: string; readonly dataflash: readonly string[] }
export interface CatalogEntry { readonly id: string; readonly firmwareVersion: string; readonly usable: boolean; readonly reason: string | null }
export interface StartSpec {
  readonly firmwareId: string; readonly parameters: readonly { readonly name: string; readonly value: number }[];
  readonly frameScript: string | null; readonly speedup: number; readonly rateHz: number; readonly home: readonly [number, number, number, number];
}
/** Where a SITL the user started sends JSON physics and talks MAVLink (launcher API v1 POST /v1/connections). */
export interface ConnectionSpec {
  readonly jsonPhysicsPort: number;
  readonly mavlink: { readonly transport: "tcp" | "udp"; readonly port: number };
}
export interface LauncherConnection {
  readonly id: string;
  readonly state: "open" | "sitl-closed" | "disconnected";
  readonly closedReason: string | null;
  readonly endpoints: ConnectionSpec;
  readonly ports: { readonly bridge: number; readonly epoch: number } | null;
  readonly physics: { readonly servoPackets: number; readonly rateHz: number | null; readonly channels: number | null };
  readonly mavlink: { readonly bytesFromSitl: number };
}
/** What a launcher call can fail with, as the panel words it. */
export class LauncherError extends Error {
  constructor(readonly kind: "unreachable" | "foreign" | "refused", message: string, readonly status: number | null = null,
    readonly experimentId: string | null = null) {
    super(message);
  }
}
export interface LauncherPort {
  catalog(): Promise<readonly CatalogEntry[]>;
  start(spec: StartSpec): Promise<LauncherExperiment>;
  stop(id: string): Promise<LauncherExperiment>;
  experiment(id: string): Promise<LauncherExperiment>;
  logs(id: string): Promise<LauncherLogs>;
  connect(spec: ConnectionSpec): Promise<LauncherConnection>;
  disconnect(id: string): Promise<LauncherConnection>;
  connection(id: string): Promise<LauncherConnection>;
}

// ---- the vehicle, the physics Worker, the record and the clock -----------------------------

export interface PreparedRun {
  readonly profile: { readonly sha256: string; readonly id: string; readonly version: number; readonly name: string };
  readonly parameters: readonly ExperimentParameter[];
  readonly frameScript: string | null;
  readonly sensors: ExperimentPayload["sensors"];
  readonly manifestSha256: string;
  readonly modelId: number;
  readonly motorChannels: readonly number[];
  /** The absent-parameter rule of the pinned ArduPilot catalog. */
  readonly absentRule: AbsentRule;
  /** The motor check (TASK-157): ArduPilot's test order and the physics rotors in power-telemetry order. */
  readonly motorTest: { readonly expected: readonly ExpectedMotor[]; readonly physics: readonly PhysicsRotor[] };
}
export interface PhysicsPort {
  /** Loads the BET module, the manifest and its ratings and starts the session in sitl-lockstep at `physicsHz`; resolves with the module's SHA-256. */
  load(physicsHz: 800 | 1200): Promise<{ readonly betModuleSha256: string }>;
  connect(port: number, bridgeEpoch: number, speedup: number): void;
  disconnect(): void;
  sendMavlink(bytes: Uint8Array): void;
  /** Truth of the latest published tick, for the flight stages. */
  altitudeM(): number;
  verticalSpeedMps(): number;
  /** Each rotor's speed, rev/min, in rotor order from the latest power telemetry; false when none was published. */
  motorSpeedsInto(out: Float64Array): boolean;
  /** Resumes a paused session with sim.start (TASK-149, TASK-156); resolves on its applied acknowledgement. */
  resume(): Promise<void>;
  /** Pauses the session with sim.pause (TASK-156); resolves on its applied acknowledgement. */
  pause(): Promise<void>;
  /** The session's latest published tick and simulated time, s. */
  tickNow(): { readonly tick: number; readonly simTimeS: number };
  /** Manual control started or ended: the Worker's stale-input watchdog follows it (TASK-174). */
  manualInput(active: boolean): void;
}
/** The calibrated USB controller (GamepadAdapter of TASK-038). */
export interface PilotInputPort {
  /** Fills `out` with the controller's sticks now, flags Connected when they are valid. */
  poll(out: PilotInput, nowMs: number, armed: boolean): void;
  readonly status: "connected" | "disconnected" | "invalid-axes" | "unavailable";
  /** Changes whenever the device behind the selection changes, a replug included. */
  readonly generation: number;
  readonly deviceName: string;
}
export interface RecordPort { create(payload: ExperimentPayload): Promise<{ readonly sha256: string }> }
/** Who a run's recording belongs to: the recording header's identity. */
export interface RecordingStart {
  /** The launcher experiment or connection ID. */
  readonly experimentId: string;
  readonly modelSha256: string;
  readonly firmware: { readonly commit: string; readonly binarySha256: string } | null;
}
/** A run's recording (TASK-163, recorder v2). */
export interface RecordingPort {
  /** Creates the run's record; what it returns goes into the experiment record. */
  prepare(identity: RecordingStart): ExperimentRecording;
  /** Opens the record and arms the physics Worker's producer; resolves once it records. */
  start(): Promise<void>;
  /** An autopilot message; the recording keeps the catalog's telemetry at its rate. */
  telemetry(frame: MavFrame): void;
  /** The parameter snapshot, once the autopilot holds the run's parameters. */
  parameters(list: readonly { readonly name: string; readonly value: number }[]): void;
  accidents(events: readonly AccidentEvent[]): void;
  pause(paused: boolean): void;
  /** Closes the record; idempotent. */
  stop(): Promise<void>;
}
export interface ClockPort {
  nowMs(): number;
  /** The current UTC time as YYYY-MM-DDTHH:mm:ss.sssZ, for the parameter change log. */
  utcNow(): string;
  every(ms: number, callback: () => void): () => void;
}

export interface StartRequest {
  readonly prepare: () => Promise<PreparedRun>;
  readonly firmwareId: string;
  readonly speedup: number;
  readonly physicsHz: 800 | 1200;
  readonly home: readonly [number, number, number, number];
}
export interface ConnectRequest {
  readonly prepare: () => Promise<PreparedRun>;
  readonly endpoints: ConnectionSpec;
  /**
   * The rate MirageSITL steps the SITL at. SIM_JSON adopts the physics peer's
   * step (Aircraft::adjust_frame_time with 1/deltat of each reply), so the
   * rate in its first servo packets is only its SIM_RATE_HZ default.
   */
  readonly physicsHz: 800 | 1200;
  /** The session's home, which the SITL's own --home must match. */
  readonly home: readonly [number, number, number, number];
  /** Source commits whose SITL behaviour MirageSITL has verified (the pinned ArduPilot catalog). */
  readonly verifiedCommits: readonly string[];
}

// ---- states ---------------------------------------------------------------------------------

export type Ownership = ExperimentSitl["ownership"];
export type StartStep = "prepare" | "firmware" | "physics" | "launcher" | "record" | "recording" | "connecting" | "probing" | "version";
export type FlightStep = "arming" | "climbing" | "flying" | "landing" | "manual";
/** The flight modes manual control can fly (ArduCopter's own). */
export type ManualMode = "stabilize" | "alt-hold" | "loiter";
const MANUAL_MODES: Readonly<Record<ManualMode, number>> = { stabilize: CopterMode.Stabilize, "alt-hold": CopterMode.AltHold, loiter: CopterMode.Loiter };
export type FailureReason =
  | { readonly kind: "vehicle"; readonly message: string }
  | { readonly kind: "firmware"; readonly message: string }
  | { readonly kind: "launcher-unreachable"; readonly message: string }
  | { readonly kind: "launcher-foreign"; readonly message: string }
  | { readonly kind: "launcher-refused"; readonly message: string }
  | { readonly kind: "physics"; readonly message: string }
  | { readonly kind: "record"; readonly message: string }
  /** The run's recording could not be prepared or started (TASK-163). */
  | { readonly kind: "recording"; readonly message: string }
  | { readonly kind: "no-heartbeat"; readonly seconds: number }
  | { readonly kind: "parameters"; readonly message: string }
  | { readonly kind: "sitl-ended"; readonly during: RunStateName; readonly ending: string }
  | { readonly kind: "bridge-lost"; readonly message: string }
  | { readonly kind: "sitl-restarted" }
  | { readonly kind: "stop-failed"; readonly message: string }
  /** A SITL the user started does not fit this profile or MirageSITL; every reason is named. */
  | { readonly kind: "incompatible"; readonly reasons: readonly string[] }
  /** A SITL the user started stopped sending heartbeats. */
  | { readonly kind: "sitl-silent"; readonly seconds: number };
export type RestartPath =
  /** Start (or, for a connection, Connect) again: a new experiment with a new record. */
  | { readonly kind: "start-again" }
  | { readonly kind: "fix-first"; readonly instruction: string }
  /** The stop itself failed: Stop again retries it and then ends as the stop was meant to (idle, or failed with `prior`). */
  | { readonly kind: "stop-again"; readonly experimentId: string; readonly prior: FailureReason | null; readonly during: RunStateName };
export interface Diagnostics {
  readonly ownership: Ownership;
  readonly experimentId: string; readonly launcherState: LauncherRunState | null; readonly exitCode: number | null;
  readonly signal: string | null; readonly ending: string | null; readonly stdout: string; readonly stderr: string;
  readonly dataflash: readonly string[];
  /** What the launcher saw of an external SITL; null for a launcher-owned run. */
  readonly connection: { readonly servoPackets: number; readonly rateHz: number | null; readonly bytesFromSitl: number } | null;
}
export type RunStateName = RunState["name"];
/**
 * Why a run is paused: an accident (TASK-149), the user, a hidden tab, missing terrain (TASK-186), or a lost or stale
 * controller in manual flight (TASK-174), through one path (TASK-156).
 */
export type PauseReason = "accident" | "user" | "visibility" | "terrain" | "controller";
/** One pause of a run and its resume (TASK-156). */
export interface PauseEvent {
  readonly reason: PauseReason;
  /** The tick and simulated time the run paused on. */
  readonly tick: number;
  readonly simTimeS: number;
  /** Wall time of the pause and of the resume, ms (the controller's clock); null while paused. */
  readonly pausedWallMs: number;
  readonly resumedWallMs: number | null;
}
/** The states a run can pause from. */
const PAUSABLE: ReadonlySet<RunStateName> = new Set(["loading-parameters", "warming", "ready", "running"]);
/**
 * The starting steps in which SITL runs and the physics steps, so an accident can happen and pause
 * the run: an aircraft that tips over on its supports does so before the autopilot's first
 * heartbeat. Without this the frozen autopilot would end the start as a lost heartbeat.
 */
const ACCIDENT_STEPS: ReadonlySet<StartStep> = new Set(["connecting", "probing", "version"]);
export type RunState =
  | { readonly name: "idle"; readonly last: string | null }
  | { readonly name: "starting"; readonly step: StartStep; readonly experimentId: string | null }
  | { readonly name: "loading-parameters"; readonly experimentId: string; readonly received: number; readonly total: number | null }
  | { readonly name: "warming"; readonly experimentId: string; readonly reason: string }
  | { readonly name: "ready"; readonly experimentId: string }
  | { readonly name: "running"; readonly experimentId: string; readonly flight: FlightStep; readonly warning: string | null }
  | { readonly name: "paused"; readonly experimentId: string; readonly atSimTimeS: number; readonly reason: PauseReason;
      /** The accidents that paused the run, for reason `accident`. */
      readonly accidents: readonly AccidentEvent[] }
  | { readonly name: "stopping"; readonly experimentId: string; readonly cause: "user" | "failure" }
  | { readonly name: "failed"; readonly reason: FailureReason; readonly during: RunStateName; readonly diagnostics: Diagnostics | null;
      readonly restart: RestartPath };
/** One passed check of a connection, as the panel lists it. */
export interface CompatibilityCheck { readonly check: "physics" | "clock" | "armed" | "version" | "parameters" | "home"; readonly text: string }

/** The text the panel shows for a failure reason. */
export function failureText(reason: FailureReason): string {
  switch (reason.kind) {
    case "vehicle": return `The aircraft profile cannot run: ${reason.message}`;
    case "firmware": return reason.message;
    case "launcher-unreachable": return reason.message;
    case "launcher-foreign": return reason.message;
    case "launcher-refused": return `The launcher refused the run: ${reason.message}`;
    case "physics": return `The physics session could not be prepared: ${reason.message}`;
    case "record": return `The experiment record could not be saved: ${reason.message}`;
    case "recording": return `The run's recording could not start: ${reason.message}`;
    case "no-heartbeat": return `SITL started but sent no heartbeat within ${reason.seconds} s`;
    case "parameters": return `ArduPilot did not confirm the initial parameters: ${reason.message}`;
    case "sitl-ended": return `SITL ended ${STATE_PHRASE[reason.during]} (${reason.ending})`;
    case "bridge-lost": return `The bridge to SITL closed (${reason.message}) while SITL kept running; MirageSITL stopped the run`;
    case "sitl-restarted": return "SITL restarted on its own; MirageSITL stopped the run";
    case "stop-failed": return `Stopping SITL failed: ${reason.message}`;
    case "incompatible": return `This SITL cannot be used with this profile: ${reason.reasons.join("; ")}`;
    case "sitl-silent": return `The SITL sent no heartbeat for ${reason.seconds} s; MirageSITL disconnected (the SITL itself was not stopped)`;
    default: { const never: never = reason; return never; }
  }
}
const STATE_PHRASE: Readonly<Record<RunStateName, string>> = {
  idle: "before the run", starting: "while starting", "loading-parameters": "while loading parameters", warming: "during EKF warmup",
  ready: "while ready", running: "in flight", paused: "while paused", stopping: "while stopping", failed: "after a failure",
};

/** MAV_AUTOPILOT_ARDUPILOTMEGA (common.xml): the heartbeat ArduPilot sends. */
const MAV_AUTOPILOT_ARDUPILOTMEGA = 3;
/** A first heartbeat after spawn within this wall time. */
export const HEARTBEAT_DEADLINE_S = 60;
/** The parameter list confirmed within this simulated time of the first heartbeat (scripts/sitl/driver.mjs). */
export const PARAMETER_DEADLINE_S = 30;
/**
 * The parameter service resends PARAM_REQUEST_LIST every 2 s of simulated time while nothing
 * answers (ArduPilot ignores it until its parameters are ready), up to the start's deadline.
 */
const PARAMETER_LIST_REQUESTS = PARAMETER_DEADLINE_S / 2;
/** The states in which the run's parameters can be written (TASK-160). */
const WRITABLE: ReadonlySet<RunStateName> = new Set(["warming", "ready", "running", "paused"]);
/** A SITL the user started sends its first JSON servo packet within this wall time of the connection. */
export const PROBE_DEADLINE_S = 15;
/** Its AUTOPILOT_VERSION within this simulated time of its first heartbeat; requested once per wall second until then. */
export const VERSION_DEADLINE_S = 10;
/** A connected SITL that sends no heartbeat for this wall time has gone (TASK-156 suspends it while paused). */
export const HEARTBEAT_LOSS_S = 10;
/** Its GPS fix within these distances of the session's home (declared before the first connection): metres. */
export const HOME_HORIZONTAL_M = 10, HOME_VERTICAL_M = 5;
/** EKF_STATUS_REPORT, GPS_RAW_INT and GLOBAL_POSITION_INT at 10 Hz: LiveEkfWarmup needs GPS within 0.3 s of the IMU. */
const STREAMS: readonly (readonly [number, number])[] = [[193, 100000], [24, 100000], [33, 100000]];
/**
 * A stream is requested again while none of its messages arrived for this wall
 * time. An acknowledgement does not prove the stream runs: a link's first
 * send pass sets every interval from its SRn_ stream rates
 * (GCS_MAVLINK::update_send, initialise_message_intervals_from_streamrates at
 * 8ab6afde), overwriting an interval acknowledged before it, which a SITL
 * whose scheduler starts only when MirageSITL connects (TASK-155) receives.
 */
const STREAM_SILENCE_MS = 2000;
/** At most this many parameter differences are listed one by one. */
const LISTED_DIFFERENCES = 12;
/** Manual control sends the sticks at this rate (TASK-174); the Worker's watchdog pauses after INPUT_TIMEOUT_MS without one. */
export const MANUAL_RATE_HZ = 25;
/** Arming in manual control needs the throttle at or below this (the pilot mailbox v2 rearm rule, TASK-038). */
const ARM_THROTTLE_MAX = 0.05;
/** WGS-84 mean radius for the home distance, metres. */
const EARTH_RADIUS_M = 6371008.8;
function gpsField(name: string, type: string) {
  const field = fieldOf(24, name);
  if (!field || field.type !== type || field.count !== 0) throw new Error(`MAVLink table changed GPS_RAW_INT.${name}`);
  return field;
}
const GPS_LAT = gpsField("lat", "int32_t"), GPS_LON = gpsField("lon", "int32_t"), GPS_ALT = gpsField("alt", "int32_t"), GPS_FIX = gpsField("fix_type", "uint8_t");

export interface ControllerView {
  readonly state: RunState;
  readonly status: SitlStatus | null;
  readonly mode: number | null;
  readonly armed: boolean;
  readonly statusText: readonly string[];
  /** The record of the current or last run. */
  readonly recordSha256: string | null;
  /** Who owns the SITL of the current or last run. */
  readonly ownership: Ownership;
  /** The checks a connection has passed so far; empty for a launcher-owned run. */
  readonly compatibility: readonly CompatibilityCheck[];
  /** The motor check of this run (TASK-157), or null before one is started. */
  readonly motorCheck: MotorCheckView | null;
  /** Every accident of this run (TASK-149), oldest first. */
  readonly accidents: readonly AccidentEvent[];
  /** The run continued after an accident: what follows is not validated for a physically damaged aircraft (F-09). */
  readonly afterAccident: boolean;
  /** Every pause of this run, oldest first (TASK-156). */
  readonly pauses: readonly PauseEvent[];
  /** Wall time the run has been paused so far, ms, which simulated time does not count. */
  readonly pausedWallMs: number;
  /** The run's parameters (TASK-160), or null before it loads them. */
  readonly parameters: ParameterView | null;
  /** The measured run speed (TASK-175). */
  readonly speed: RunSpeedView;
  /** Manual control (TASK-174), or null when MirageSITL flies the run. */
  readonly manual: ManualView | null;
}
export interface ManualView {
  readonly mode: ManualMode;
  readonly device: string;
  /** Why an arm waits, or null. */
  readonly waiting: string | null;
}
/** The parameter state of a run (TASK-160); the list itself is read with `parameterList()`. */
export interface ParameterView {
  /** Increases whenever the list, its download or a write changes. */
  readonly revision: number;
  readonly download: DownloadState;
  /** The autopilot renumbered its list after the download: download it again. */
  readonly stale: boolean;
  /** Why a write is refused now, or null when parameters can be written. */
  readonly writeRefusal: string | null;
  /** Every parameter change of the run, oldest first. */
  readonly changes: readonly ParameterChange[];
  /** Confirmed values that take effect only after a restart, by ArduPilot's metadata. */
  readonly rebootPending: readonly string[];
  /** The ArduPilot source commit of the run's SITL, and whether MirageSITL has metadata for it. */
  readonly firmwareCommit: string | null;
  readonly metadata: boolean;
}
export interface MotorCheckView {
  readonly running: boolean;
  /** Motors judged so far, and in all. */
  readonly step: number;
  readonly total: number;
  /** The motor ArduPilot is testing now, or null. */
  readonly testing: number | null;
  readonly results: readonly MotorCheckResult[];
  /** Why the check stopped before the last motor, or null. */
  readonly stopped: string | null;
  readonly passed: boolean;
}
/** MAV_CMD_DO_MOTOR_TEST (common.xml). */
const MOTOR_TEST_COMMAND = 209;
/** Ground clearance above which the aircraft counts as airborne for the motor check, m. */
const MOTOR_CHECK_MAX_ALTITUDE_M = 0.3;

const ACTIVE: ReadonlySet<RunStateName> = new Set(["starting", "loading-parameters", "warming", "ready", "running", "paused"]);

/** What a connection established, kept for its record. */
interface ExternalFacts {
  spec: ConnectionSpec;
  connectionId: string;
  physicsHz: 800 | 1200;
  betModuleSha256: string;
  home: readonly [number, number, number, number];
  verifiedCommits: readonly string[];
  version: { readonly commit: string; readonly gitHash: string; readonly firmwareVersion: string } | null;
  versionSinceS: number;
  homeChecked: boolean;
}

export class SessionController {
  private stateValue: RunState = { name: "idle", last: null };
  private status: SitlStatus | null = null;
  private mode: number | null = null;
  private armed = false;
  private statusText: string[] = [];
  private recordSha256: string | null = null;
  private experimentId: string | null = null;
  private ownership: Ownership = "launcher";
  private external: ExternalFacts | null = null;
  private prepared: PreparedRun | null = null;
  private compatibility: CompatibilityCheck[] = [];
  private motorCheck: MotorCheck | null = null;
  private motorSpeeds = new Float64Array(0);
  private readback: ParameterReadback | null = null;
  private parametersSinceS = 0;
  private params: ParameterService | null = null;
  private paramMetadata: ParameterMetadataSet | null = null;
  private changes: ParameterChange[] = [];
  private firmwareCommit: string | null = null;
  private speed = new RunSpeedMeter(1);
  private input: PilotInputPort | null = null;
  private manual: { mode: ManualMode; generation: number; device: string; armedOnce: boolean; waiting: string | null } | null = null;
  private stopManualTimer: (() => void) | null = null;
  private readonly pilot: PilotInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0, flags: 0, wallTimeMs: 0 };
  private readonly pilotV2 = newPilotInputV2();
  private readonly mapper = new PilotRcMapper();
  private heartbeatSeen = false;
  private lastHeartbeatMs = 0;
  private accidents: AccidentEvent[] = [];
  private afterAccident = false;
  private pauses: PauseEvent[] = [];
  /** A user or hidden-tab pause waiting for its acknowledgement. */
  private pausing = false;
  /** The state a paused run returns to. */
  private resumeTo: RunState | null = null;
  private connectedAtMs = 0;
  private takeoffM = 0;
  /** Wall time at which each stream's message last arrived. */
  private readonly streamSeenMs = new Map<number, number>();
  private stopTimer: (() => void) | null = null;
  /** Increased by every Start, Stop and failure stop, so a start chain that resumes after one of them ends instead of going on. */
  private generation = 0;
  private readonly gcs = new GroundStation();
  private readonly packet = new Uint8Array(64);
  private readonly parser = new MavParser(frame => this.autopilot(frame));

  constructor(private readonly launcher: LauncherPort, private readonly physics: PhysicsPort, private readonly records: RecordPort,
    private readonly clock: ClockPort, private readonly onChange: (view: ControllerView) => void, private readonly recording: RecordingPort | null = null,
    private readonly metadata: ParameterMetadataCatalog | null = null) {}

  get state(): RunState { return this.stateValue; }
  get view(): ControllerView {
    return { state: this.stateValue, status: this.status, mode: this.mode, armed: this.armed, statusText: this.statusText, recordSha256: this.recordSha256,
      ownership: this.ownership, compatibility: this.compatibility, motorCheck: this.motorCheckView(), accidents: this.accidents,
      afterAccident: this.afterAccident, pauses: this.pauses, pausedWallMs: this.pausedWallTotal(), parameters: this.parameterView(),
      speed: this.speed.view,
      manual: this.manual ? { mode: this.manual.mode, device: this.manual.device, waiting: this.manual.waiting } : null };
  }
  get active(): boolean { return ACTIVE.has(this.stateValue.name); }
  /** The current state name, read afresh after an await (not narrowed by earlier checks). */
  private stateName(): RunStateName { return this.stateValue.name; }

  /** Starts a new experiment; from idle, or from failed as its restart (a new experiment and a new record). */
  async start(request: StartRequest): Promise<void> {
    const from = this.stateValue.name;
    if (from !== "idle" && from !== "failed") return;
    this.reset("launcher");
    this.speed = new RunSpeedMeter(request.speedup);
    const generation = ++this.generation;
    const cancelled = () => generation !== this.generation;
    let prepared: PreparedRun;
    this.set({ name: "starting", step: "prepare", experimentId: null });
    try { prepared = await request.prepare(); } catch (error) {
      if (!cancelled()) this.fail({ kind: "vehicle", message: messageOf(error) }, "starting", null);
      return;
    }
    if (cancelled()) return;
    this.prepared = prepared;
    this.set({ name: "starting", step: "firmware", experimentId: null });
    let firmware: CatalogEntry | undefined;
    try { firmware = (await this.launcher.catalog()).find(entry => entry.id === request.firmwareId); } catch (error) {
      if (!cancelled()) this.fail(launcherFailure(error), "starting", null);
      return;
    }
    if (cancelled()) return;
    if (!firmware) { this.fail({ kind: "firmware", message: `The launcher has no ArduPilot build ${request.firmwareId}` }, "starting", null); return; }
    if (!firmware.usable) { this.fail({ kind: "firmware", message: `ArduPilot build ${firmware.id} cannot be started: ${firmware.reason ?? "unusable"}` }, "starting", null); return; }
    this.set({ name: "starting", step: "physics", experimentId: null });
    let betModuleSha256: string;
    try { ({ betModuleSha256 } = await this.physics.load(request.physicsHz)); } catch (error) {
      if (!cancelled()) this.fail({ kind: "physics", message: messageOf(error) }, "starting", null);
      return;
    }
    if (cancelled()) return;

    this.set({ name: "starting", step: "launcher", experimentId: null });
    let experiment: LauncherExperiment;
    try {
      experiment = await this.launcher.start({ firmwareId: firmware.id, parameters: prepared.parameters.map(p => ({ name: p.name, value: p.value })),
        frameScript: prepared.frameScript, speedup: request.speedup, rateHz: request.physicsHz, home: request.home });
    } catch (error) {
      // A 500 after the folder exists names the experiment, so its logs stay reachable.
      const id = error instanceof LauncherError ? error.experimentId : null;
      if (cancelled()) { if (id) await this.launcher.stop(id).catch(() => undefined); return; }
      if (id) { this.experimentId = id; await this.stopAfter(launcherFailure(error), "starting"); } else this.fail(launcherFailure(error), "starting", null);
      return;
    }
    // Stopped while the launcher was starting SITL: the run it reports is stopped at once, and the state stays idle.
    if (cancelled()) { await this.launcher.stop(experiment.id).catch(() => undefined); return; }
    this.experimentId = experiment.id;
    this.firmwareCommit = experiment.firmware.commit;
    const run = experiment.runs.at(-1);
    if (experiment.state === "start-failed" || !run || !experiment.ports) {
      await this.stopAfter({ kind: "launcher-refused", message: experiment.startError ?? "SITL did not start" }, "starting");
      return;
    }

    this.set({ name: "starting", step: "record", experimentId: experiment.id });
    let recording: ExperimentRecording | null;
    try {
      recording = this.recording?.prepare({ experimentId: experiment.id, modelSha256: prepared.manifestSha256,
        firmware: { commit: experiment.firmware.commit, binarySha256: experiment.firmware.binarySha256 } }) ?? null;
    } catch (error) {
      await this.stopAfter({ kind: "recording", message: messageOf(error) }, "starting");
      return;
    }
    const payload: ExperimentPayload = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION, profile: prepared.profile,
      sitl: { ownership: "launcher", experimentId: experiment.id, ardupilot: { catalogId: experiment.firmware.id, firmwareVersion: experiment.firmware.firmwareVersion,
        commit: experiment.firmware.commit, binarySha256: experiment.firmware.binarySha256, defaultParametersSha256: experiment.firmware.defaultParametersSha256 } },
      session: { physicsHz: request.physicsHz, clockMode: "sitl-lockstep", speedup: request.speedup, home: request.home, modelId: prepared.modelId,
        manifestSha256: prepared.manifestSha256, betModuleSha256 },
      parameters: prepared.parameters, frameScript: prepared.frameScript, sensors: prepared.sensors, recording,
    };
    try { this.recordSha256 = (await this.records.create(payload)).sha256; } catch (error) {
      // No unrecorded run flies; after a Stop, the stop already ended the run.
      if (!cancelled()) await this.stopAfter({ kind: "record", message: messageOf(error) }, "starting");
      return;
    }
    if (cancelled()) return;
    // The recording takes every tick: it records before the autopilot's first frame steps the physics.
    if (this.recording) {
      this.set({ name: "starting", step: "recording", experimentId: experiment.id });
      try { await this.recording.start(); } catch (error) {
        if (!cancelled()) await this.stopAfter({ kind: "recording", message: messageOf(error) }, "starting");
        return;
      }
      if (cancelled()) return;
    }

    this.readback = new ParameterReadback(prepared.parameters, prepared.absentRule);
    this.set({ name: "starting", step: "connecting", experimentId: experiment.id });
    this.connectedAtMs = this.clock.nowMs();
    this.physics.connect(experiment.ports.bridge, run.run, request.speedup);
    this.stopTimer = this.clock.every(1000, () => this.beat());
  }

  /** Connects to a SITL the user started; from idle, or from failed as its restart (a new connection and, once compatible, a new record). */
  async connect(request: ConnectRequest): Promise<void> {
    const from = this.stateValue.name;
    if (from !== "idle" && from !== "failed") return;
    this.reset("external");
    // A SITL the user started paces itself by its own --speedup.
    this.speed = new RunSpeedMeter(null);
    const generation = ++this.generation;
    const cancelled = () => generation !== this.generation;
    let prepared: PreparedRun;
    this.set({ name: "starting", step: "prepare", experimentId: null });
    try { prepared = await request.prepare(); } catch (error) {
      if (!cancelled()) this.fail({ kind: "vehicle", message: messageOf(error) }, "starting", null);
      return;
    }
    if (cancelled()) return;
    if (prepared.frameScript !== null) {
      this.fail({ kind: "incompatible", reasons: ["this profile's frame needs a MirageSITL frame script, which MirageSITL installs only in a SITL it starts; use Start SITL run"] },
        "starting", null);
      return;
    }
    this.prepared = prepared;

    this.set({ name: "starting", step: "launcher", experimentId: null });
    let connection: LauncherConnection;
    try { connection = await this.launcher.connect(request.endpoints); } catch (error) {
      if (!cancelled()) this.fail(launcherFailure(error), "starting", null);
      return;
    }
    if (cancelled()) { await this.launcher.disconnect(connection.id).catch(() => undefined); return; }
    this.experimentId = connection.id;

    // JSON servo packets prove that SITL runs --model JSON before physics is loaded.
    this.set({ name: "starting", step: "probing", experimentId: connection.id });
    const probeEnd = this.clock.nowMs() + PROBE_DEADLINE_S * 1000;
    while (connection.state === "open" && connection.physics.rateHz === null && this.clock.nowMs() < probeEnd) {
      await this.wait(250);
      if (cancelled()) return;
      try { connection = await this.launcher.connection(connection.id); } catch (error) {
        if (!cancelled()) await this.stopAfter(launcherFailure(error), "starting");
        return;
      }
      if (cancelled()) return;
    }
    if (connection.state !== "open") {
      await this.stopAfter({ kind: "sitl-ended", during: "starting", ending: connection.closedReason ?? `connection ${connection.state}` }, "starting");
      return;
    }
    const { rateHz } = connection.physics, port = request.endpoints.jsonPhysicsPort;
    if (rateHz === null) {
      await this.stopAfter({ kind: "incompatible", reasons: [connection.mavlink.bytesFromSitl > 0
        ? `the SITL talks MAVLink but sent no JSON physics packets to UDP port ${port} within ${PROBE_DEADLINE_S} s: it runs a built-in physics model, which cannot fly this profile and whose clock MirageSITL cannot pause, or sends JSON elsewhere; start it with --model JSON and --sim-port-out ${port}`
        : `no JSON physics packets reached UDP port ${port} within ${PROBE_DEADLINE_S} s: start SITL with --model JSON and --sim-port-out ${port}, and check its MAVLink port`] }, "starting");
      return;
    }
    const { physicsHz } = request;
    this.compatibility = [
      { check: "physics", text: `JSON physics on UDP port ${port} with ${connection.physics.channels ?? "?"} servo channels; MirageSITL steps it at ${physicsHz} Hz, which SITL adopts (it announced ${rateHz} Hz)` },
      { check: "clock", text: "JSON lockstep: SITL's clock waits for each MirageSITL reply, which never sets no_lockstep, so Pause stops it with the physics (TASK-156)" },
    ];

    this.set({ name: "starting", step: "physics", experimentId: connection.id });
    let betModuleSha256: string;
    try { ({ betModuleSha256 } = await this.physics.load(physicsHz)); } catch (error) {
      if (!cancelled()) await this.stopAfter({ kind: "physics", message: messageOf(error) }, "starting");
      return;
    }
    if (cancelled()) return;
    if (!connection.ports) {
      await this.stopAfter({ kind: "sitl-ended", during: "starting", ending: connection.closedReason ?? "the connection closed" }, "starting");
      return;
    }
    this.external = { spec: request.endpoints, connectionId: connection.id, physicsHz, betModuleSha256, home: request.home,
      verifiedCommits: request.verifiedCommits, version: null, versionSinceS: 0, homeChecked: false };
    this.readback = new ParameterReadback(prepared.parameters, prepared.absentRule);
    this.set({ name: "starting", step: "connecting", experimentId: connection.id });
    this.connectedAtMs = this.clock.nowMs();
    // The speed factor only labels the warmup; an external SITL's own command line paces it.
    this.physics.connect(connection.ports.bridge, connection.ports.epoch, 1);
    this.stopTimer = this.clock.every(1000, () => this.beat());
  }

  /** User Stop (Disconnect for a connection): from any active state; from failed{stop-failed} it tries again. */
  async stop(): Promise<void> {
    const s = this.stateValue;
    if (s.name === "failed" && s.restart.kind === "stop-again") {
      const { experimentId, prior, during } = s.restart;
      this.experimentId = experimentId;
      if (prior) await this.stopAfter(prior, during, true);
      else await this.userStop(experimentId);
      return;
    }
    if (!this.active) return;
    this.generation++;
    const id = this.experimentId;
    this.quiet();
    if (!id) { this.set({ name: "idle", last: this.ownership === "external" ? "Connect cancelled" : "Start cancelled" }); return; }
    await this.userStop(id);
  }
  private async userStop(id: string): Promise<void> {
    this.set({ name: "stopping", experimentId: id, cause: "user" });
    try {
      if (this.ownership === "external") {
        await this.launcher.disconnect(id);
        this.set({ name: "idle", last: `Disconnected from connection ${id}; the SITL keeps running` });
      } else {
        await this.launcher.stop(id);
        this.set({ name: "idle", last: `Run ${id} stopped` });
      }
    } catch (error) {
      this.fail({ kind: "stop-failed", message: messageOf(error) }, "stopping", null, { kind: "stop-again", experimentId: id, prior: null, during: "stopping" });
    }
  }

  /**
   * Starts the motor check (TASK-157): ArduPilot's motor test spins each motor
   * alone in its test order. Returns the refusal, or null when it started.
   * Only on the ground, disarmed, while warming or READY.
   */
  checkMotors(): string | null {
    const s = this.stateValue, prepared = this.prepared;
    if (this.motorCheck && !this.motorCheck.done) return "A motor check is already running";
    if (s.name !== "warming" && s.name !== "ready") return "Check the motors once the parameters are loaded, before take-off";
    if (this.armed) return "Disarm before checking the motors";
    if (this.physics.altitudeM() > MOTOR_CHECK_MAX_ALTITUDE_M) return "Land before checking the motors";
    if (!prepared) return "The aircraft is not prepared";
    this.motorCheck = new MotorCheck(prepared.motorTest.expected, prepared.motorTest.physics);
    this.motorSpeeds = new Float64Array(prepared.motorTest.physics.length);
    this.emit();
    return null;
  }

  /** GUIDED, arm, then NAV_TAKEOFF to `altitudeM`; only when READY and no motor check runs. */
  takeOff(altitudeM: number): boolean {
    const s = this.stateValue;
    if (s.name !== "ready" || !(altitudeM >= 1 && altitudeM <= 100) || (this.motorCheck !== null && !this.motorCheck.done)) return false;
    this.takeoffM = altitudeM;
    this.set({ name: "running", experimentId: s.experimentId, flight: "arming", warning: null });
    this.send(this.gcs.setModeInto(CopterMode.Guided, this.packet));
    return true;
  }
  land(): boolean {
    const s = this.stateValue;
    if (s.name !== "running" || (s.flight !== "climbing" && s.flight !== "flying")) return false;
    this.set({ ...s, flight: "landing" });
    this.send(this.gcs.setModeInto(CopterMode.Land, this.packet));
    return true;
  }

  /**
   * Pauses the run (TASK-156) for the user or because its tab was hidden: the physics session stops
   * stepping, and the autopilot, which waits on its next frame in JSON lockstep, with it. False when
   * the run cannot pause now.
   */
  pause(reason: "user" | "visibility" | "controller"): boolean {
    const s = this.stateValue;
    if (!PAUSABLE.has(s.name) || this.pausing || !("experimentId" in s) || s.experimentId === null) return false;
    const generation = this.generation;
    this.pausing = true;
    this.physics.pause().then(() => {
      this.pausing = false;
      // An accident may have paused the run first; then that pause stands.
      if (generation !== this.generation || this.stateValue !== s) return;
      this.enterPause(reason, []);
    }, (error: unknown) => {
      this.pausing = false;
      if (generation === this.generation && this.stateValue === s) void this.stopAfter({ kind: "physics", message: messageOf(error) }, s.name);
    });
    return true;
  }

  /**
   * Resumes a paused run, whatever paused it: the session steps again, and the autopilot with it.
   * After an accident (TASK-149) the rest of the run is labelled as not validated for a physically
   * damaged aircraft. False unless the run is paused.
   */
  resume(): boolean {
    const s = this.stateValue, before = this.resumeTo;
    if (s.name !== "paused" || !before || this.resumeBlocker() !== null) return false;
    const generation = this.generation;
    this.physics.resume().then(() => {
      if (generation !== this.generation || this.stateValue !== s) return;
      // TASK-174: manual control goes on with the same controller only; a swapped or replugged one is never taken silently,
      // and releasing it changes the state the run returns to.
      if (this.manual && this.input && this.input.generation !== this.manual.generation) this.endManual();
      else if (this.manual) this.physics.manualInput(true);
      const to = this.resumeTo ?? before;
      this.resumeTo = null;
      this.speed.resume(this.clock.nowMs());
      if (s.reason === "accident") this.afterAccident = true;
      this.recording?.pause(false);
      const last = this.pauses.at(-1);
      if (last && last.resumedWallMs === null) this.pauses = [...this.pauses.slice(0, -1), { ...last, resumedWallMs: this.clock.nowMs() }];
      // The autopilot sent nothing while it waited; its heartbeat count, and a start's first-heartbeat deadline, start again now.
      this.lastHeartbeatMs = this.clock.nowMs();
      if (to.name === "starting") this.connectedAtMs = this.clock.nowMs();
      this.set(to);
    }, (error: unknown) => {
      if (generation === this.generation && this.stateValue === s) void this.stopAfter({ kind: "physics", message: messageOf(error) }, "paused");
    });
    return true;
  }
  /** Continues a run that an accident paused (TASK-149); `resume` for that pause. */
  continueAfterAccident(): boolean {
    const s = this.stateValue;
    return s.name === "paused" && s.reason === "accident" && this.resume();
  }

  /** The calibrated USB controller manual control reads (TASK-174). */
  setInput(input: PilotInputPort | null): void { this.input = input; }

  /**
   * Takes manual control (TASK-174): on the ground at READY, disarmed, with the throttle down, MirageSITL sets `mode` and
   * arms; in flight, armed in GUIDED, it switches to `mode` (altitude hold or loiter, which hold with the throttle
   * centred). The sticks then go to ArduPilot at MANUAL_RATE_HZ. Returns why not, or null.
   */
  takeManual(mode: ManualMode): string | null {
    const s = this.stateValue, input = this.input;
    if (this.manual) return "Manual control is already on";
    if (!input) return "No controller is set up";
    input.poll(this.pilot, this.clock.nowMs(), this.armed);
    if (input.status !== "connected") return `The controller is ${input.status === "invalid-axes" ? "not calibrated for its axes" : "not connected"}`;
    const onGround = s.name === "ready" && !this.armed;
    const inFlight = s.name === "running" && (s.flight === "climbing" || s.flight === "flying") && this.armed;
    if (!onGround && !inFlight) return "Take manual control at READY on the ground, or in flight";
    if (inFlight && mode === "stabilize") return "In flight, take manual control in altitude hold or loiter, which hold with the throttle centred";
    if (onGround && this.pilot.throttle > ARM_THROTTLE_MAX) return "Lower the throttle to take manual control on the ground";
    if (!("experimentId" in s) || s.experimentId === null) return "No run is active";
    this.manual = { mode, generation: input.generation, device: input.deviceName, armedOnce: inFlight, waiting: null };
    this.physics.manualInput(true);
    this.stopManualTimer = this.clock.every(1000 / MANUAL_RATE_HZ, () => this.manualTick());
    this.send(this.gcs.setModeInto(MANUAL_MODES[mode], this.packet));
    this.manualTick();
    this.set({ name: "running", experimentId: s.experimentId, flight: "manual", warning: null });
    return null;
  }
  /**
   * Gives the flight back to MirageSITL: the override is released and, while armed, ArduPilot holds position in GUIDED.
   * Possible while paused, when it takes effect with Resume. Returns why not, or null.
   */
  releaseManual(): string | null {
    if (!this.manual) return "Manual control is not on";
    this.endManual();
    return null;
  }
  /** Why Resume is not possible now, or null (TASK-174: a run paused for its controller waits for it). */
  resumeBlocker(): string | null {
    const s = this.stateValue;
    if (s.name !== "paused" || s.reason !== "controller" || !this.manual || !this.input) return null;
    this.input.poll(this.pilot, this.clock.nowMs(), this.armed);
    return this.input.status === "connected" ? null : "Reconnect the controller, or release manual control";
  }

  /** The run's parameters as the autopilot reported them (TASK-160), in list order; empty before the run loads them. */
  parameterList(): readonly ParameterValue[] { return this.params?.parameters() ?? []; }
  /** ArduPilot's metadata for the run's exact source commit, or null. */
  get parameterMetadata(): ParameterMetadataSet | null { return this.paramMetadata; }
  /** The session's latest published tick and simulated time, s. */
  tickNow(): { readonly tick: number; readonly simTimeS: number } { return this.physics.tickNow(); }

  /**
   * Writes one parameter (TASK-160): the parameter service sends PARAM_SET and
   * classifies the write by read-back, and the change is logged with its old
   * value and the tick it was sent on. Returns why the write was not sent, or
   * null; a write the service refuses is logged as refused. `value` must be a
   * finite float32, as parseParameterValue gives.
   */
  setParameter(name: string, value: number): string | null {
    const refusal = this.writeRefusal(), params = this.params, s = this.stateValue;
    if (refusal !== null || !params || !("experimentId" in s) || s.experimentId === null) return refusal ?? "No run has loaded its parameters";
    if (!Number.isFinite(value) || Math.fround(value) !== value) return "The value must be a finite float32";
    const at = this.physics.tickNow(), old = params.get(name)?.value ?? null;
    const outcome = params.set(name, value, this.status?.simTimeS ?? at.simTimeS);
    this.changes = [...this.changes, { writeId: outcome.id, name, oldValue: old, newValue: value, requestedAt: this.clock.utcNow(), tick: at.tick,
      simTimeS: at.simTimeS, experimentId: s.experimentId, whilePaused: s.name === "paused", outcome }];
    // A pending write of the same name is now stale.
    this.syncChanges();
    this.emit();
    return null;
  }
  /** Downloads the complete list again, for example after the autopilot renumbered it; returns why not, or null. */
  refreshParameters(): string | null {
    const params = this.params;
    if (!params || !WRITABLE.has(this.stateValue.name)) return "Parameters can be downloaded once the run has loaded them, until it stops";
    if (this.status?.state !== "open") return "The bridge to SITL is not open";
    if (params.download().kind === "downloading") return "The list is being downloaded";
    params.requestList(this.status.simTimeS);
    this.emit();
    return null;
  }

  /** Every message from the physics Worker. */
  worker(data: unknown): void {
    const type = field(data, "type");
    if (type === "accident.events") {
      const events = parseAccidents(field(data, "events"));
      if (events.length > 0 && this.active) this.accident(events);
      return;
    }
    if (type === "sitl.input-stale") {
      // The Worker paused the session: Main sent no stick command for INPUT_TIMEOUT_MS (TASK-174).
      if (this.manual && this.active && this.stateValue.name !== "paused") this.enterPause("controller", []);
      return;
    }
    if (type === "sitl.mavlink") {
      const bytes = field(data, "bytes");
      if (bytes instanceof Uint8Array && this.active) this.parser.push(bytes);
      return;
    }
    if (type === "sitl.reject") {
      if (this.active) void this.stopAfter({ kind: "physics", message: String(field(data, "message")) }, this.stateValue.name);
      return;
    }
    if (!isStatus(data)) return;
    this.status = data;
    if (!this.active) { this.emit(); return; }
    // A paused session holds its time; the meter leaves paused wall time out.
    if (data.state === "open" && this.stateValue.name !== "paused") this.speed.sample(this.clock.nowMs(), data.simTimeS);
    if (data.state === "fault") { void this.stopAfter(data.message.startsWith("SITL restarted") ? { kind: "sitl-restarted" } : { kind: "bridge-lost", message: data.message }, this.stateValue.name); return; }
    if (data.state === "closed") { void this.bridgeClosed(data.message); return; }
    this.progress();
    this.emit();
  }

  // ---- internals ----------------------------------------------------------------------------

  /** The physics session paused itself on an accident's tick (F-09); the autopilot waits in lockstep. */
  private accident(events: readonly AccidentEvent[]): void {
    this.accidents = [...this.accidents, ...events];
    this.recording?.accidents(events);
    const s = this.stateValue;
    if (PAUSABLE.has(s.name) || (s.name === "starting" && ACCIDENT_STEPS.has(s.step))) { this.enterPause("accident", events); return; }
    if (s.name === "paused") { this.set({ ...s, reason: "accident", accidents: [...s.accidents, ...events] }); return; }
    this.emit();
  }
  /** The one path into `paused` (TASK-156): the state to return to, the pause row and the log entry. */
  private enterPause(reason: PauseReason, accidents: readonly AccidentEvent[]): void {
    const s = this.stateValue;
    if (!("experimentId" in s) || s.experimentId === null) return;
    const at = this.physics.tickNow(), first = accidents[0];
    this.speed.pause(this.clock.nowMs(), at.simTimeS);
    this.resumeTo = s;
    this.recording?.pause(true);
    this.pauses = [...this.pauses, { reason, tick: first?.tick ?? at.tick, simTimeS: first?.simTimeS ?? at.simTimeS, pausedWallMs: this.clock.nowMs(), resumedWallMs: null }];
    this.set({ name: "paused", experimentId: s.experimentId, atSimTimeS: first?.simTimeS ?? at.simTimeS, reason, accidents });
  }
  /** Wall time spent paused so far, ms. */
  private pausedWallTotal(): number {
    const now = this.clock.nowMs();
    return this.pauses.reduce((sum, pause) => sum + ((pause.resumedWallMs ?? now) - pause.pausedWallMs), 0);
  }

  /**
   * One manual-control period: the controller's sticks out as RC_CHANNELS_OVERRIDE. A disconnected, invalid or
   * swapped controller pauses the run instead (user decision of 2026-11-03). Nothing is sent while paused.
   */
  private manualTick(): void {
    const manual = this.manual, input = this.input;
    if (!manual || !input || this.stateValue.name === "paused" || this.status?.state !== "open") return;
    input.poll(this.pilot, this.clock.nowMs(), this.armed);
    if (input.status !== "connected" || input.generation !== manual.generation) {
      this.pause("controller");
      return;
    }
    const p = this.pilotV2;
    p.roll = this.pilot.roll; p.pitch = this.pilot.pitch; p.yaw = this.pilot.yaw; p.throttle = this.pilot.throttle;
    // MirageSITL commands the mode itself, so the mode channel is left to ArduPilot (ignore sentinel).
    p.flags = this.pilot.flags & 1; p.calibratedModeSlot = UNKNOWN_U32;
    if (this.mapper.mapInto(p)) this.send(this.gcs.rcOverrideInto(this.mapper.channels, this.packet));
  }
  /** Ends manual control: the override is released and, while armed, ArduPilot holds position in GUIDED. */
  private endManual(): void {
    this.stopManualTimer?.();
    this.stopManualTimer = null;
    this.manual = null;
    this.physics.manualInput(false);
    const p = this.pilotV2;
    p.flags = 0; p.calibratedModeSlot = UNKNOWN_U32;
    if (this.status?.state === "open" && this.mapper.mapInto(p)) this.send(this.gcs.rcOverrideInto(this.mapper.channels, this.packet));
    const s = this.stateValue, back = this.armed ? { flight: "flying" as const } : null;
    if (this.armed && this.status?.state === "open") this.send(this.gcs.setModeInto(CopterMode.Guided, this.packet));
    if (s.name === "running" && s.flight === "manual") {
      this.set(back ? { ...s, flight: back.flight } : this.status?.ready ? { name: "ready", experimentId: s.experimentId }
        : { name: "warming", experimentId: s.experimentId, reason: this.status?.reason ?? "" });
    } else if (s.name === "paused" && this.resumeTo?.name === "running" && this.resumeTo.flight === "manual") {
      const to = this.resumeTo;
      this.resumeTo = back ? { ...to, flight: back.flight } : { name: "ready", experimentId: to.experimentId };
      this.emit();
    } else {
      this.emit();
    }
  }

  /** Advances on a status: version and parameter deadlines, warmup, READY revocation and the climb. */
  private progress(): void {
    const s = this.stateValue, status = this.status;
    if (!status) return;
    if (this.motorCheck && !this.motorCheck.done) this.stepMotorCheck(status.simTimeS);
    // The Worker accepts MAVLink only while its bridge socket is open.
    if (this.params && status.state === "open") {
      this.params.tick(status.simTimeS);
      this.syncChanges();
    }
    switch (s.name) {
      case "loading-parameters": {
        const elapsed = status.simTimeS - this.parametersSinceS;
        if (elapsed > PARAMETER_DEADLINE_S) {
          void this.stopAfter({ kind: "parameters", message: `the parameter list was not complete after ${PARAMETER_DEADLINE_S} s of simulated time (${s.received} of ${s.total ?? "?"} received)` }, s.name);
        } else if (this.params?.download().kind === "failed" && status.state === "open") {
          // Entries the index reads did not recover: the start's deadline allows the whole list again.
          this.params.requestList(status.simTimeS);
        }
        return;
      }
      case "warming":
        // A connection's READY waits for its record, which follows the home check.
        if (status.ready && (this.ownership === "launcher" || this.recordSha256 !== null)) this.set({ name: "ready", experimentId: s.experimentId });
        else if (status.reason !== s.reason) this.set({ ...s, reason: status.reason });
        return;
      case "ready":
        if (!status.ready) this.set({ name: "warming", experimentId: s.experimentId, reason: status.reason }); // stale diagnostics revoke READY
        return;
      case "running": {
        const warning = status.ready ? null : `READY was revoked in flight: ${status.reason}`;
        let flight = s.flight;
        if (flight === "climbing" && Math.abs(this.physics.altitudeM() - this.takeoffM) < 0.5 && Math.abs(this.physics.verticalSpeedMps()) < 0.3) flight = "flying";
        if (flight !== s.flight || warning !== s.warning) this.set({ ...s, flight, warning });
        return;
      }
      case "starting":
        if (s.step === "connecting" && !this.heartbeatSeen && this.clock.nowMs() - this.connectedAtMs > HEARTBEAT_DEADLINE_S * 1000) {
          void this.stopAfter({ kind: "no-heartbeat", seconds: HEARTBEAT_DEADLINE_S }, s.name);
        } else if (s.step === "version" && this.external && status.simTimeS - this.external.versionSinceS > VERSION_DEADLINE_S) {
          void this.stopAfter({ kind: "incompatible", reasons: [`the SITL did not report its version (AUTOPILOT_VERSION) within ${VERSION_DEADLINE_S} s of simulated time`] }, s.name);
        }
        return;
      case "idle": case "paused": case "stopping": case "failed": return;
      default: { const never: never = s; return never; }
    }
  }

  private autopilot(frame: MavFrame): void {
    if (frame.systemId !== 1 || frame.componentId !== 1) return;
    this.recording?.telemetry(frame);
    if (frame.id === 193 || frame.id === 24 || frame.id === 33) this.streamSeenMs.set(frame.id, this.clock.nowMs());
    const s = this.stateValue;
    switch (frame.id) {
      case 0: {
        // ArduPilot's own heartbeat only (MAV_AUTOPILOT_ARDUPILOTMEGA); another component of system 1 may declare none.
        if (frame.view.getUint8(5) !== MAV_AUTOPILOT_ARDUPILOTMEGA) return;
        this.mode = frame.view.getUint32(0, true);
        const armed = (frame.view.getUint8(6) & 128) !== 0, was = this.armed;
        this.armed = armed;
        this.lastHeartbeatMs = this.clock.nowMs();
        if (!this.heartbeatSeen) {
          this.heartbeatSeen = true;
          // The autopilot has booted: its run speed is judged from here (TASK-175).
          if (this.status) this.speed.begin(this.clock.nowMs(), this.status.simTimeS);
          if (s.name === "starting" && s.experimentId) this.firstHeartbeat(s.experimentId, armed);
        }
        if (s.name === "running" && s.flight === "manual" && this.manual) {
          if (armed) { this.manual.armedOnce = true; this.manual.waiting = null; }
          // Landed and disarmed by ArduPilot (or the pilot): MirageSITL takes the run back.
          else if (was && this.manual.armedOnce) this.endManual();
        }
        if (s.name === "running") {
          if (s.flight === "arming" && armed) {
            this.send(this.gcs.takeoffInto(this.takeoffM, this.packet));
            this.set({ ...s, flight: "climbing" });
          } else if (s.flight === "landing" && was && !armed) {
            this.set(this.status?.ready ? { name: "ready", experimentId: s.experimentId } : { name: "warming", experimentId: s.experimentId, reason: this.status?.reason ?? "" });
          }
        }
        this.emit();
        return;
      }
      case 148: { // AUTOPILOT_VERSION
        const external = this.external;
        if (s.name !== "starting" || s.step !== "version" || !external || !s.experimentId) return;
        const reported = readAutopilotVersion(frame);
        if (!reported) return;
        const commit = verifiedCommit(reported.gitHash, external.verifiedCommits);
        if (commit === null || reported.gitHash === null) {
          const verified = external.verifiedCommits.map(c => c.slice(0, 8)).join(", ");
          void this.stopAfter({ kind: "incompatible", reasons: [`the SITL reports ArduPilot ${reported.firmwareVersion} built from ${reported.gitHash === null
            ? "a source without a git hash" : `commit ${reported.gitHash}`}; MirageSITL has verified only commit ${verified}`] }, s.name);
          return;
        }
        external.version = { commit, gitHash: reported.gitHash, firmwareVersion: reported.firmwareVersion };
        this.firmwareCommit = commit;
        this.compatibility = [...this.compatibility, { check: "version", text: `ArduPilot ${reported.firmwareVersion}, commit ${reported.gitHash} (verified)` }];
        this.requestParameters(s.experimentId);
        return;
      }
      case 22: { // PARAM_VALUE
        if (this.params?.ingest(frame, this.status?.simTimeS ?? 0)) this.syncChanges();
        if (s.name !== "loading-parameters" || !this.readback) { if (this.params) this.emit(); return; }
        this.readback.ingest(frame);
        const verdict = this.readback.verdict();
        if (verdict.kind === "incomplete") { this.set({ ...s, received: verdict.received, total: verdict.total }); return; }
        if (this.ownership === "external") { this.judgeExternalParameters(s.experimentId); return; }
        switch (verdict.kind) {
          case "confirmed":
            this.recording?.parameters(this.prepared?.parameters ?? []);
            this.set(this.status?.ready ? { name: "ready", experimentId: s.experimentId } : { name: "warming", experimentId: s.experimentId, reason: this.status?.reason ?? "" });
            return;
          case "mismatch":
            void this.stopAfter({ kind: "parameters", message: `${verdict.name} reads back ${verdict.reported}, not ${verdict.expected}` }, s.name);
            return;
          case "absent":
            void this.stopAfter({ kind: "parameters", message: `${verdict.name} does not exist in this ArduPilot build` }, s.name);
            return;
          default: { const never: never = verdict; return never; }
        }
      }
      case 24: { // GPS_RAW_INT: a connection's home check, once its parameters are confirmed
        if (s.name !== "warming" || !this.external || this.external.homeChecked) return;
        if (readNumber(frame.view, GPS_FIX) < 3) return; // below a 3D fix
        // lat and lon in 1e-7 degrees, alt in millimetres above mean sea level.
        this.checkHome(s.experimentId, readNumber(frame.view, GPS_LAT) / 1e7, readNumber(frame.view, GPS_LON) / 1e7, readNumber(frame.view, GPS_ALT) / 1000);
        return;
      }
      case 77: { // COMMAND_ACK: only the motor test's acknowledgement is used
        if (frame.view.getUint16(0, true) === MOTOR_TEST_COMMAND && this.motorCheck) {
          this.motorCheck.ack(frame.view.getUint8(2), this.status?.simTimeS ?? 0, this.statusText.at(-1) ?? "");
          this.emit();
        }
        return;
      }
      case 253: {
        const text = new TextDecoder().decode(frame.payload.subarray(1, 51)).replace(/\0[\s\S]*$/, "");
        this.statusText = [...this.statusText, text].slice(-8);
        this.emit();
        return;
      }
      default: return;
    }
  }

  /** Owned runs go on to the parameter list; a connection must be disarmed and then report its version first. */
  private firstHeartbeat(experimentId: string, armed: boolean): void {
    const external = this.external;
    if (!external) { this.requestParameters(experimentId); return; }
    if (armed) {
      void this.stopAfter({ kind: "incompatible", reasons: ["the SITL is armed: disarm it before connecting, since MirageSITL physics cannot continue another model's flight"] }, "starting");
      return;
    }
    this.compatibility = [...this.compatibility, { check: "armed", text: "Disarmed" }];
    external.versionSinceS = this.status?.simTimeS ?? 0;
    this.set({ name: "starting", step: "version", experimentId });
    this.send(this.gcs.requestMessageInto(148, this.packet));
  }
  /** The run loads its parameters through the parameter service, which downloads the autopilot's complete list (TASK-160). */
  private requestParameters(experimentId: string): void {
    const now = this.status?.simTimeS ?? 0;
    this.parametersSinceS = now;
    this.paramMetadata = this.firmwareCommit === null ? null : this.metadata?.forCommit(this.firmwareCommit) ?? null;
    this.params = new ParameterService({ ground: this.gcs, send: frame => this.physics.sendMavlink(frame.slice()), metadata: this.paramMetadata,
      timing: { maxListRequests: PARAMETER_LIST_REQUESTS } });
    this.set({ name: "loading-parameters", experimentId, received: 0, total: null });
    this.params.requestList(now);
  }
  /** Why parameters cannot be written now, or null. */
  private writeRefusal(): string | null {
    const params = this.params;
    if (!params) return "No run has loaded its parameters";
    if (this.ownership === "external") return "MirageSITL writes nothing to a SITL it did not start (decision of 2026-11-01), so its parameters are shown read-only";
    if (!WRITABLE.has(this.stateValue.name)) return "Parameters can be written once the run has loaded them, until it stops";
    if (this.status?.state !== "open") return "The bridge to SITL is not open";
    const download = params.download();
    if (download.kind !== "complete") return download.kind === "downloading" ? "The list is being downloaded" : "Download the parameter list first";
    if (params.stale) return "The autopilot renumbered its list: download it again first";
    return null;
  }
  /** Each logged change takes its write's latest state. */
  private syncChanges(): void {
    const params = this.params;
    if (!params) return;
    let changed = false;
    const next = this.changes.map(change => {
      const outcome = params.write(change.writeId);
      if (!outcome || outcome === change.outcome) return change;
      changed = true;
      return { ...change, outcome };
    });
    if (changed) this.changes = next;
  }
  private parameterView(): ParameterView | null {
    const params = this.params;
    if (!params) return null;
    return { revision: params.revision, download: params.download(), stale: params.stale, writeRefusal: this.writeRefusal(), changes: this.changes,
      rebootPending: params.rebootPending(), firmwareCommit: this.firmwareCommit, metadata: this.paramMetadata !== null };
  }
  /** A connection is never written to: every generated parameter it does not hold is a reason to refuse it. */
  private judgeExternalParameters(experimentId: string): void {
    const differences = this.readback?.differences();
    if (!differences) return;
    if (differences.length > 0) {
      const listed = differences.slice(0, LISTED_DIFFERENCES).map(differenceText);
      if (differences.length > LISTED_DIFFERENCES) listed.push(`and ${differences.length - LISTED_DIFFERENCES} more parameters differ`);
      void this.stopAfter({ kind: "incompatible", reasons: [`the SITL's parameters differ from what this profile needs (MirageSITL writes nothing to a SITL it did not start): ${listed.join(", ")}`] }, "loading-parameters");
      return;
    }
    const count = this.prepared?.parameters.length ?? 0;
    this.compatibility = [...this.compatibility, { check: "parameters", text: `All ${count} frame, output, PWM and sensor parameters match the profile` }];
    this.set({ name: "warming", experimentId, reason: "Checking the SITL's home position" });
  }
  private checkHome(experimentId: string, latitudeDeg: number, longitudeDeg: number, altitudeM: number): void {
    const external = this.external;
    if (!external) return;
    external.homeChecked = true;
    const [homeLat, homeLon, homeAlt] = external.home;
    const north = (latitudeDeg - homeLat) * Math.PI / 180 * EARTH_RADIUS_M;
    const east = (longitudeDeg - homeLon) * Math.PI / 180 * EARTH_RADIUS_M * Math.cos(homeLat * Math.PI / 180);
    const horizontal = Math.hypot(north, east), vertical = Math.abs(altitudeM - homeAlt);
    if (!(horizontal <= HOME_HORIZONTAL_M && vertical <= HOME_VERTICAL_M)) {
      void this.stopAfter({ kind: "incompatible", reasons: [`the SITL's GPS puts it ${Math.round(horizontal)} m from and ${Math.round(vertical)} m above or below the session's home: start it with --home ${external.home.join(",")}`] }, "warming");
      return;
    }
    this.compatibility = [...this.compatibility, { check: "home", text: `GPS within ${horizontal.toFixed(1)} m and ${vertical.toFixed(1)} m of the session's home` }];
    void this.recordConnection(experimentId);
  }
  /** The record of a connection, written once every check passed; READY waits for it. */
  private async recordConnection(experimentId: string): Promise<void> {
    const external = this.external, prepared = this.prepared, generation = this.generation;
    if (!external?.version || !prepared) return;
    let recording: ExperimentRecording | null;
    try {
      // MirageSITL never read an external SITL's binary, so the recording names no firmware.
      recording = this.recording?.prepare({ experimentId: external.connectionId, modelSha256: prepared.manifestSha256, firmware: null }) ?? null;
    } catch (error) {
      await this.stopAfter({ kind: "recording", message: messageOf(error) }, this.stateName());
      return;
    }
    const payload: ExperimentPayload = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION, profile: prepared.profile,
      sitl: { ownership: "external", connectionId: external.connectionId, ardupilot: external.version, endpoints: external.spec },
      session: { physicsHz: external.physicsHz, clockMode: "sitl-lockstep", speedup: null, home: external.home, modelId: prepared.modelId,
        manifestSha256: prepared.manifestSha256, betModuleSha256: external.betModuleSha256 },
      parameters: prepared.parameters, frameScript: null, sensors: prepared.sensors, recording,
    };
    try {
      const { sha256 } = await this.records.create(payload);
      if (generation !== this.generation) return;
      this.recordSha256 = sha256;
    } catch (error) {
      if (generation === this.generation) await this.stopAfter({ kind: "record", message: messageOf(error) }, this.stateName());
      return;
    }
    // A connection records from its record on: the checks before it ran before anything was recorded.
    if (this.recording) {
      try { await this.recording.start(); } catch (error) {
        if (generation === this.generation) await this.stopAfter({ kind: "recording", message: messageOf(error) }, this.stateName());
        return;
      }
      if (generation !== this.generation) return;
      this.recording.parameters(prepared.parameters);
    }
    const s = this.stateValue;
    if (s.name === "warming" && s.experimentId === experimentId) {
      this.set(this.status?.ready ? { name: "ready", experimentId } : { ...s, reason: this.status?.reason ?? s.reason });
    } else {
      this.emit();
    }
  }

  /** One motor-check tick on a status: the rotors' speeds in, ArduPilot's next motor-test command out. */
  private stepMotorCheck(simTimeS: number): void {
    const check = this.motorCheck;
    if (!check) return;
    if (!this.physics.motorSpeedsInto(this.motorSpeeds)) this.motorSpeeds.fill(0);
    const before = check.step;
    const action = check.observe(simTimeS, this.motorSpeeds);
    if (action.kind === "command") this.send(this.gcs.motorTestInto(action.testOrder, action.pwmUs, action.timeoutS, this.packet));
    if (action.kind !== "wait" || check.step !== before) this.emit();
  }
  private motorCheckView(): MotorCheckView | null {
    const check = this.motorCheck;
    if (!check) return null;
    const running = !check.done;
    return { running, step: check.step, total: check.expected.length, testing: running ? check.expected[check.step]?.motorId ?? null : null,
      results: check.results, stopped: check.stoppedReason, passed: check.passed };
  }

  /** Ground-station duties once per wall second: heartbeat, stream requests until their messages arrive, retries, and the heartbeat deadlines. */
  private beat(): void {
    if (!this.active) return;
    if (this.stateValue.name === "starting") this.progress();
    // A paused autopilot waits in lockstep and sends nothing, so silence then is no loss.
    if (this.ownership === "external" && this.heartbeatSeen && this.stateValue.name !== "paused" &&
      this.clock.nowMs() - this.lastHeartbeatMs > HEARTBEAT_LOSS_S * 1000) {
      void this.stopAfter({ kind: "sitl-silent", seconds: HEARTBEAT_LOSS_S }, this.stateValue.name);
      return;
    }
    // The Worker accepts MAVLink only while its bridge socket is open.
    if (this.status?.state !== "open") return;
    this.send(this.gcs.heartbeatInto(this.packet));
    const now = this.clock.nowMs();
    for (const [id, us] of STREAMS) {
      const seen = this.streamSeenMs.get(id);
      if (seen === undefined || now - seen > STREAM_SILENCE_MS) this.send(this.gcs.messageIntervalInto(id, us, this.packet));
    }
    const s = this.stateValue;
    if (s.name === "starting" && s.step === "version") {
      this.send(this.gcs.requestMessageInto(148, this.packet));
    } else if (s.name === "running" && s.flight === "arming") {
      if (this.mode !== CopterMode.Guided) this.send(this.gcs.setModeInto(CopterMode.Guided, this.packet));
      else if (!this.armed) this.send(this.gcs.armInto(true, this.packet));
    } else if (s.name === "running" && s.flight === "landing" && this.mode !== CopterMode.Land) {
      this.send(this.gcs.setModeInto(CopterMode.Land, this.packet));
    } else if (s.name === "running" && s.flight === "manual" && this.manual) {
      const manual = this.manual, wanted = MANUAL_MODES[manual.mode];
      if (this.mode !== wanted) this.send(this.gcs.setModeInto(wanted, this.packet));
      else if (!this.armed && !manual.armedOnce) {
        // Zero-throttle arming (TASK-038): the arm request waits for the throttle.
        const waiting = this.pilot.throttle > ARM_THROTTLE_MAX ? "Lower the throttle to arm" : null;
        if (waiting === null) this.send(this.gcs.armInto(true, this.packet));
        if (waiting !== manual.waiting) { manual.waiting = waiting; this.emit(); }
      }
    }
  }

  /** The bridge closed while active: SITL ended on its own, or only the bridge was lost. */
  private async bridgeClosed(message: string): Promise<void> {
    const during = this.stateValue.name, id = this.experimentId;
    // Silence the beat first: a closed Worker refuses its MAVLink, which must not replace this reason.
    this.quiet();
    this.generation++;
    if (!id) { this.fail({ kind: "bridge-lost", message }, during, null); return; }
    let ending: string | null = null;
    if (this.ownership === "external") {
      // The launcher marks a connection sitl-closed before it closes the bridge.
      try {
        const connection = await this.launcher.connection(id);
        if (connection.state === "sitl-closed") ending = connection.closedReason ?? "SITL closed the connection";
      } catch { ending = null; }
    } else {
      // The launcher marks the run's end before it closes the bridge, so a crash already reads crashed or exited here.
      let run: LauncherRun | undefined;
      try { run = (await this.launcher.experiment(id)).runs.at(-1); } catch { run = undefined; }
      if (run && (run.state === "exited" || run.state === "crashed")) ending = run.reason ?? endingOf(run);
    }
    await this.stopAfter(ending === null ? { kind: "bridge-lost", message } : { kind: "sitl-ended", during, ending }, during);
  }

  /** A failure after the launcher owns a run or a connection: stop or disconnect it, collect its diagnostics, then show failed. */
  private async stopAfter(reason: FailureReason, during: RunStateName, retry = false): Promise<void> {
    const id = this.experimentId;
    this.quiet();
    this.generation++;
    if (!id) { this.fail(reason, during, null); return; }
    // One failure stop at a time; a second failure while stopping, idle or failed changes nothing (Stop again retries explicitly).
    const now = this.stateValue.name;
    if (!retry && (now === "stopping" || now === "idle" || now === "failed")) return;
    this.set({ name: "stopping", experimentId: id, cause: "failure" });
    if (this.ownership === "external") {
      let connection: LauncherConnection;
      try { connection = await this.launcher.disconnect(id); } catch (error) {
        this.fail({ kind: "stop-failed", message: messageOf(error) }, "stopping", null, { kind: "stop-again", experimentId: id, prior: reason, during });
        return;
      }
      this.fail(reason, during, {
        ownership: "external", experimentId: id, launcherState: null, exitCode: null, signal: null, ending: connection.closedReason,
        stdout: "", stderr: "", dataflash: [],
        connection: { servoPackets: connection.physics.servoPackets, rateHz: connection.physics.rateHz, bytesFromSitl: connection.mavlink.bytesFromSitl },
      });
      return;
    }
    let after: LauncherExperiment;
    try { after = await this.launcher.stop(id); } catch (error) {
      this.fail({ kind: "stop-failed", message: messageOf(error) }, "stopping", null, { kind: "stop-again", experimentId: id, prior: reason, during });
      return;
    }
    let logs: LauncherLogs = { stdout: "", stderr: "", dataflash: [] };
    try { logs = await this.launcher.logs(id); } catch { /* the reason stands without the tails */ }
    const run = after.runs.at(-1);
    this.fail(reason, during, {
      ownership: "launcher", experimentId: id, launcherState: run?.state ?? after.state, exitCode: run?.exitCode ?? null, signal: run?.signal ?? null,
      ending: run?.reason ?? null, stdout: logs.stdout, stderr: logs.stderr, dataflash: logs.dataflash, connection: null,
    });
  }

  private fail(reason: FailureReason, during: RunStateName, diagnostics: Diagnostics | null, restart: RestartPath = restartFor(reason, this.ownership)): void {
    this.quiet();
    this.set({ name: "failed", reason, during, diagnostics, restart });
  }

  /** Stops every timer and the Worker's bridge, so nothing later overwrites the reason. */
  private quiet(): void {
    this.stopTimer?.();
    this.stopTimer = null;
    this.stopManualTimer?.();
    this.stopManualTimer = null;
    this.manual = null;
    this.physics.disconnect();
    // The record closes on its own; a failure to close is the recording's, shown in the Logging tab.
    void this.recording?.stop().catch(() => undefined);
  }

  /** Resolves after `ms` on the injected clock. */
  private wait(ms: number): Promise<void> {
    return new Promise(done => {
      const stop = this.clock.every(ms, () => { stop(); done(); });
    });
  }

  private reset(ownership: Ownership): void {
    this.status = null; this.mode = null; this.armed = false; this.statusText = []; this.recordSha256 = null;
    this.experimentId = null; this.readback = null; this.heartbeatSeen = false; this.streamSeenMs.clear();
    this.ownership = ownership; this.external = null; this.prepared = null; this.compatibility = []; this.motorCheck = null;
    this.accidents = []; this.afterAccident = false; this.resumeTo = null; this.pauses = []; this.pausing = false;
    this.params = null; this.paramMetadata = null; this.changes = []; this.firmwareCommit = null;
    this.parser.reset();
  }

  private send(n: number): void {
    if (n > 0) this.physics.sendMavlink(this.packet.slice(0, n));
  }
  private set(state: RunState): void {
    this.stateValue = state;
    this.emit();
  }
  private emit(): void { this.onChange(this.view); }
}

function differenceText(difference: ParameterDifference): string {
  return difference.reported === null ? `${difference.name} does not exist (needs ${difference.expected})`
    : `${difference.name} is ${difference.reported} (needs ${difference.expected})`;
}

function restartFor(reason: FailureReason, ownership: Ownership): RestartPath {
  const again = ownership === "external" ? "Connect" : "Start";
  switch (reason.kind) {
    case "vehicle": return { kind: "fix-first", instruction: `Fix the aircraft profile in the Aircraft, Components or Sensors tab, then press ${again} again` };
    case "firmware": return { kind: "fix-first", instruction: "Reinstall the build with node scripts/install-macos.mjs, or choose another ArduPilot build, then press Start again" };
    case "launcher-unreachable": return { kind: "fix-first", instruction: `Start the launcher with npm run start -w @mirage/launcher, then press ${again} again` };
    case "launcher-foreign": return { kind: "fix-first", instruction: `Enter the port of the MirageSITL launcher, or stop the program that holds it, then press ${again} again` };
    case "incompatible": return { kind: "fix-first", instruction: "Restart your SITL as the reasons say, or choose another profile, then press Connect again" };
    case "launcher-refused":
      return ownership === "external" ? { kind: "fix-first", instruction: "Check that your SITL is running and which ports it uses, then press Connect again" } : { kind: "start-again" };
    case "recording": return { kind: "fix-first", instruction: `Free storage or lower the rates in the Logging tab, then press ${again} again` };
    case "physics": case "record": case "no-heartbeat": case "parameters":
    case "sitl-ended": case "bridge-lost": case "sitl-restarted": case "sitl-silent":
      return { kind: "start-again" };
    case "stop-failed": return { kind: "start-again" };
    default: { const never: never = reason; return never; }
  }
}

function launcherFailure(error: unknown): FailureReason {
  if (error instanceof LauncherError) {
    switch (error.kind) {
      case "unreachable": return { kind: "launcher-unreachable", message: error.message };
      case "foreign": return { kind: "launcher-foreign", message: error.message };
      case "refused": return { kind: "launcher-refused", message: error.message };
      default: { const never: never = error.kind; return never; }
    }
  }
  return { kind: "launcher-refused", message: messageOf(error) };
}
function endingOf(run: LauncherRun): string {
  if (run.signal) return `killed by ${run.signal}`;
  return run.exitCode === null ? `run state ${run.state}` : `exit code ${run.exitCode}`;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function field(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  return current;
}
/** The events of a Worker `accident.events` message, validated from unknown; invalid entries are left out. */
export function parseAccidents(value: unknown): AccidentEvent[] {
  if (!Array.isArray(value)) return [];
  const list: readonly unknown[] = value, finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  return list.flatMap((item): AccidentEvent[] => {
    const part = field(item, "part"), kind = field(part, "part"), point = field(item, "pointBodyM"), speed = field(item, "rotorSpeedRadS");
    const id = kind === "hull" ? field(part, "hullId") : field(part, "rotorId");
    const xyz: readonly unknown[] = Array.isArray(point) ? point : [];
    const [x, y, z] = xyz;
    const tick = field(item, "tick"), simTimeS = field(item, "simTimeS"), penetrationM = field(item, "penetrationM");
    const impulseNs = field(item, "impulseNs"), forceN = field(item, "forceN");
    if ((kind !== "hull" && kind !== "propeller") || !finite(id) || xyz.length !== 3 || !finite(x) || !finite(y) || !finite(z) ||
      !finite(tick) || !finite(simTimeS) || !finite(penetrationM) || !finite(impulseNs) || !finite(forceN) ||
      (kind === "propeller" ? !finite(speed) : speed !== null)) return [];
    return [{ tick, simTimeS, part: kind === "hull" ? { part: "hull", hullId: id } : { part: "propeller", rotorId: id }, pointBodyM: [x, y, z],
      penetrationM, impulseNs, forceN, rotorSpeedRadS: kind === "propeller" && finite(speed) ? speed : null }];
  });
}

function isStatus(data: unknown): data is SitlStatus {
  return field(data, "type") === "sitl.status" && typeof field(data, "ready") === "boolean" && typeof field(data, "simTimeS") === "number" &&
    typeof field(data, "state") === "string" && typeof field(data, "reason") === "string" && typeof field(data, "message") === "string";
}
