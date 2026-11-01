// Run states of an integrated ArduPilot SITL experiment (TASK-154, S02).
//
// A pure state machine on injected ports, so Node tests drive it with
// scripted launcher answers, Worker events and a fake clock; the Run panel
// only renders `state`. The contract's states are idle, starting, loading
// parameters, warming, ready, running, paused, stopping and failed. A
// failure after the launcher owns a run always passes through stopping, so
// failed is shown only once the run's process group is gone, with the
// launcher's diagnostics and a restart path. A restart is a new experiment
// with a new record (user decision of 2026-11-01). `paused` is part of the
// union and the view; synchronized pause and its control belong to TASK-156.
import type { ExperimentPayload } from "@mirage/aircraft/experiment";
import { CopterMode, GroundStation, MavCommand } from "@mirage/autopilot/ground-station";
import { ParameterReadback, type AbsentRule } from "@mirage/autopilot/parameter-readback";
import { MavParser, type MavFrame } from "@mirage/mavlink/codec";
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
}

// ---- the vehicle, the physics Worker, the record and the clock -----------------------------

export interface PreparedRun {
  readonly profile: { readonly sha256: string; readonly id: string; readonly version: number; readonly name: string };
  readonly parameters: readonly ExperimentPayload["parameters"][number][];
  readonly frameScript: string | null;
  readonly sensors: ExperimentPayload["sensors"];
  readonly manifestSha256: string;
  readonly modelId: number;
  readonly motorChannels: readonly number[];
  /** The absent-parameter rule of the pinned ArduPilot catalog. */
  readonly absentRule: AbsentRule;
}
export interface PhysicsPort {
  /** Loads the BET module, the manifest and its ratings and starts the session in sitl-lockstep; resolves with the module's SHA-256. */
  load(): Promise<{ readonly betModuleSha256: string }>;
  connect(port: number, bridgeEpoch: number, speedup: number): void;
  disconnect(): void;
  sendMavlink(bytes: Uint8Array): void;
  /** Truth of the latest published tick, for the flight stages. */
  altitudeM(): number;
  verticalSpeedMps(): number;
}
export interface RecordPort { create(payload: ExperimentPayload): Promise<{ readonly sha256: string }> }
export interface ClockPort {
  nowMs(): number;
  every(ms: number, callback: () => void): () => void;
}

export interface StartRequest {
  readonly prepare: () => Promise<PreparedRun>;
  readonly firmwareId: string;
  readonly speedup: number;
  readonly physicsHz: 800 | 1200;
  readonly home: readonly [number, number, number, number];
}

// ---- states ---------------------------------------------------------------------------------

export type StartStep = "prepare" | "firmware" | "physics" | "launcher" | "record" | "connecting";
export type FlightStep = "arming" | "climbing" | "flying" | "landing";
export type FailureReason =
  | { readonly kind: "vehicle"; readonly message: string }
  | { readonly kind: "firmware"; readonly message: string }
  | { readonly kind: "launcher-unreachable"; readonly message: string }
  | { readonly kind: "launcher-foreign"; readonly message: string }
  | { readonly kind: "launcher-refused"; readonly message: string }
  | { readonly kind: "physics"; readonly message: string }
  | { readonly kind: "record"; readonly message: string }
  | { readonly kind: "no-heartbeat"; readonly seconds: number }
  | { readonly kind: "parameters"; readonly message: string }
  | { readonly kind: "sitl-ended"; readonly during: RunStateName; readonly ending: string }
  | { readonly kind: "bridge-lost"; readonly message: string }
  | { readonly kind: "sitl-restarted" }
  | { readonly kind: "stop-failed"; readonly message: string };
export type RestartPath =
  | { readonly kind: "start-again" }
  | { readonly kind: "fix-first"; readonly instruction: string }
  /** The stop itself failed: Stop again retries it and then ends as the stop was meant to (idle, or failed with `prior`). */
  | { readonly kind: "stop-again"; readonly experimentId: string; readonly prior: FailureReason | null; readonly during: RunStateName };
export interface Diagnostics {
  readonly experimentId: string; readonly launcherState: LauncherRunState | null; readonly exitCode: number | null;
  readonly signal: string | null; readonly ending: string | null; readonly stdout: string; readonly stderr: string;
  readonly dataflash: readonly string[];
}
export type RunStateName = RunState["name"];
export type RunState =
  | { readonly name: "idle"; readonly last: string | null }
  | { readonly name: "starting"; readonly step: StartStep; readonly experimentId: string | null }
  | { readonly name: "loading-parameters"; readonly experimentId: string; readonly received: number; readonly total: number | null }
  | { readonly name: "warming"; readonly experimentId: string; readonly reason: string }
  | { readonly name: "ready"; readonly experimentId: string }
  | { readonly name: "running"; readonly experimentId: string; readonly flight: FlightStep; readonly warning: string | null }
  | { readonly name: "paused"; readonly experimentId: string; readonly atSimTimeS: number }
  | { readonly name: "stopping"; readonly experimentId: string; readonly cause: "user" | "failure" }
  | { readonly name: "failed"; readonly reason: FailureReason; readonly during: RunStateName; readonly diagnostics: Diagnostics | null;
      readonly restart: RestartPath };

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
    case "no-heartbeat": return `SITL started but sent no heartbeat within ${reason.seconds} s`;
    case "parameters": return `ArduPilot did not confirm the initial parameters: ${reason.message}`;
    case "sitl-ended": return `SITL ended ${STATE_PHRASE[reason.during]} (${reason.ending})`;
    case "bridge-lost": return `The bridge to SITL closed (${reason.message}) while SITL kept running; MirageSITL stopped the run`;
    case "sitl-restarted": return "SITL restarted on its own; MirageSITL stopped the run";
    case "stop-failed": return `Stopping SITL failed: ${reason.message}`;
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
/** PARAM_REQUEST_LIST repeated at this simulated-time interval while the list is incomplete. */
const PARAMETER_RETRY_S = 5;
/** EKF_STATUS_REPORT, GPS_RAW_INT and GLOBAL_POSITION_INT at 10 Hz: LiveEkfWarmup needs GPS within 0.3 s of the IMU. */
const STREAMS: readonly (readonly [number, number])[] = [[193, 100000], [24, 100000], [33, 100000]];

export interface ControllerView {
  readonly state: RunState;
  readonly status: SitlStatus | null;
  readonly mode: number | null;
  readonly armed: boolean;
  readonly statusText: readonly string[];
  /** The record of the current or last run. */
  readonly recordSha256: string | null;
}

const ACTIVE: ReadonlySet<RunStateName> = new Set(["starting", "loading-parameters", "warming", "ready", "running", "paused"]);

export class SessionController {
  private stateValue: RunState = { name: "idle", last: null };
  private status: SitlStatus | null = null;
  private mode: number | null = null;
  private armed = false;
  private statusText: string[] = [];
  private recordSha256: string | null = null;
  private experimentId: string | null = null;
  private readback: ParameterReadback | null = null;
  private parametersSinceS = 0;
  private lastParameterRequestS = 0;
  private heartbeatSeen = false;
  private connectedAtMs = 0;
  private takeoffM = 0;
  private acks: { command: number; result: number }[] = [];
  private stopTimer: (() => void) | null = null;
  /** Increased by every Start, Stop and failure stop, so a start chain that resumes after one of them ends instead of going on. */
  private generation = 0;
  private readonly gcs = new GroundStation();
  private readonly packet = new Uint8Array(64);
  private readonly parser = new MavParser(frame => this.autopilot(frame));

  constructor(private readonly launcher: LauncherPort, private readonly physics: PhysicsPort, private readonly records: RecordPort,
    private readonly clock: ClockPort, private readonly onChange: (view: ControllerView) => void) {}

  get state(): RunState { return this.stateValue; }
  get view(): ControllerView {
    return { state: this.stateValue, status: this.status, mode: this.mode, armed: this.armed, statusText: this.statusText, recordSha256: this.recordSha256 };
  }
  get active(): boolean { return ACTIVE.has(this.stateValue.name); }
  /** The current state name, read afresh after an await (not narrowed by earlier checks). */
  private stateName(): RunStateName { return this.stateValue.name; }

  /** Starts a new experiment; from idle, or from failed as its restart (a new experiment and a new record). */
  async start(request: StartRequest): Promise<void> {
    const from = this.stateValue.name;
    if (from !== "idle" && from !== "failed") return;
    this.reset();
    const generation = ++this.generation;
    const cancelled = () => generation !== this.generation;
    let prepared: PreparedRun;
    this.set({ name: "starting", step: "prepare", experimentId: null });
    try { prepared = await request.prepare(); } catch (error) {
      if (!cancelled()) this.fail({ kind: "vehicle", message: messageOf(error) }, "starting", null);
      return;
    }
    if (cancelled()) return;
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
    try { ({ betModuleSha256 } = await this.physics.load()); } catch (error) {
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
    const run = experiment.runs.at(-1);
    if (experiment.state === "start-failed" || !run || !experiment.ports) {
      await this.stopAfter({ kind: "launcher-refused", message: experiment.startError ?? "SITL did not start" }, "starting");
      return;
    }

    this.set({ name: "starting", step: "record", experimentId: experiment.id });
    const payload: ExperimentPayload = {
      schemaVersion: 1, profile: prepared.profile,
      ardupilot: { catalogId: experiment.firmware.id, firmwareVersion: experiment.firmware.firmwareVersion, commit: experiment.firmware.commit,
        binarySha256: experiment.firmware.binarySha256, defaultParametersSha256: experiment.firmware.defaultParametersSha256 },
      launcher: { experimentId: experiment.id },
      session: { physicsHz: request.physicsHz, clockMode: "sitl-lockstep", speedup: request.speedup, home: request.home, modelId: prepared.modelId,
        manifestSha256: prepared.manifestSha256, betModuleSha256 },
      parameters: prepared.parameters, frameScript: prepared.frameScript, sensors: prepared.sensors,
    };
    try { this.recordSha256 = (await this.records.create(payload)).sha256; } catch (error) {
      // No unrecorded run flies; after a Stop, the stop already ended the run.
      if (!cancelled()) await this.stopAfter({ kind: "record", message: messageOf(error) }, "starting");
      return;
    }
    if (cancelled()) return;

    this.readback = new ParameterReadback(prepared.parameters, prepared.absentRule);
    this.set({ name: "starting", step: "connecting", experimentId: experiment.id });
    this.connectedAtMs = this.clock.nowMs();
    this.physics.connect(experiment.ports.bridge, run.run, request.speedup);
    this.stopTimer = this.clock.every(1000, () => this.beat());
  }

  /** User Stop: from any active state; from failed{stop-failed} it tries again. */
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
    if (!id) { this.set({ name: "idle", last: "Start cancelled" }); return; }
    await this.userStop(id);
  }
  private async userStop(id: string): Promise<void> {
    this.set({ name: "stopping", experimentId: id, cause: "user" });
    try {
      await this.launcher.stop(id);
      this.set({ name: "idle", last: `Run ${id} stopped` });
    } catch (error) {
      this.fail({ kind: "stop-failed", message: messageOf(error) }, "stopping", null, { kind: "stop-again", experimentId: id, prior: null, during: "stopping" });
    }
  }

  /** GUIDED, arm, then NAV_TAKEOFF to `altitudeM`; only when READY. */
  takeOff(altitudeM: number): boolean {
    const s = this.stateValue;
    if (s.name !== "ready" || !(altitudeM >= 1 && altitudeM <= 100)) return false;
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

  /** Every message from the physics Worker. */
  worker(data: unknown): void {
    const type = field(data, "type");
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
    if (data.state === "fault") { void this.stopAfter(data.message.startsWith("SITL restarted") ? { kind: "sitl-restarted" } : { kind: "bridge-lost", message: data.message }, this.stateValue.name); return; }
    if (data.state === "closed") { void this.bridgeClosed(data.message); return; }
    this.progress();
    this.emit();
  }

  // ---- internals ----------------------------------------------------------------------------

  /** Advances on a status: parameter deadline, warmup, READY revocation and the climb. */
  private progress(): void {
    const s = this.stateValue, status = this.status;
    if (!status) return;
    switch (s.name) {
      case "loading-parameters": {
        const elapsed = status.simTimeS - this.parametersSinceS;
        if (elapsed > PARAMETER_DEADLINE_S) {
          void this.stopAfter({ kind: "parameters", message: `the parameter list was not complete after ${PARAMETER_DEADLINE_S} s of simulated time (${s.received} of ${s.total ?? "?"} received)` }, s.name);
        } else if (status.simTimeS - this.lastParameterRequestS >= PARAMETER_RETRY_S) {
          this.lastParameterRequestS = status.simTimeS;
          this.send(this.gcs.paramRequestListInto(this.packet));
        }
        return;
      }
      case "warming":
        if (status.ready) this.set({ name: "ready", experimentId: s.experimentId });
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
        }
        return;
      case "idle": case "paused": case "stopping": case "failed": return;
      default: { const never: never = s; return never; }
    }
  }

  private autopilot(frame: MavFrame): void {
    if (frame.systemId !== 1 || frame.componentId !== 1) return;
    const s = this.stateValue;
    switch (frame.id) {
      case 0: {
        // ArduPilot's own heartbeat only (MAV_AUTOPILOT_ARDUPILOTMEGA); another component of system 1 may declare none.
        if (frame.view.getUint8(5) !== MAV_AUTOPILOT_ARDUPILOTMEGA) return;
        this.mode = frame.view.getUint32(0, true);
        const armed = (frame.view.getUint8(6) & 128) !== 0, was = this.armed;
        this.armed = armed;
        if (!this.heartbeatSeen) {
          this.heartbeatSeen = true;
          if (s.name === "starting" && s.experimentId) {
            this.parametersSinceS = this.lastParameterRequestS = this.status?.simTimeS ?? 0;
            this.set({ name: "loading-parameters", experimentId: s.experimentId, received: 0, total: null });
            this.send(this.gcs.paramRequestListInto(this.packet));
          }
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
      case 22: { // PARAM_VALUE
        if (s.name !== "loading-parameters" || !this.readback) return;
        this.readback.ingest(frame);
        const verdict = this.readback.verdict();
        switch (verdict.kind) {
          case "incomplete": this.set({ ...s, received: verdict.received, total: verdict.total }); return;
          case "confirmed":
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
      case 77: {
        const command = frame.view.getUint16(0, true), result = frame.view.getUint8(2);
        this.acks.push({ command, result });
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

  /** Ground-station duties once per wall second: heartbeat, stream requests until acknowledged, retries, and the heartbeat deadline. */
  private beat(): void {
    if (!this.active) return;
    if (this.stateValue.name === "starting") this.progress();
    // The Worker accepts MAVLink only while its bridge socket is open.
    if (this.status?.state !== "open") return;
    this.send(this.gcs.heartbeatInto(this.packet));
    if (this.acks.filter(a => a.command === MavCommand.SetMessageInterval && a.result === 0).length < STREAMS.length) {
      for (const [id, us] of STREAMS) this.send(this.gcs.messageIntervalInto(id, us, this.packet));
    }
    const s = this.stateValue;
    if (s.name === "running" && s.flight === "arming") {
      if (this.mode !== CopterMode.Guided) this.send(this.gcs.setModeInto(CopterMode.Guided, this.packet));
      else if (!this.armed) this.send(this.gcs.armInto(true, this.packet));
    } else if (s.name === "running" && s.flight === "landing" && this.mode !== CopterMode.Land) {
      this.send(this.gcs.setModeInto(CopterMode.Land, this.packet));
    }
  }

  /** The bridge closed while active: SITL ended on its own, or only the bridge was lost. */
  private async bridgeClosed(message: string): Promise<void> {
    const during = this.stateValue.name, id = this.experimentId;
    // Silence the beat first: a closed Worker refuses its MAVLink, which must not replace this reason.
    this.quiet();
    this.generation++;
    if (!id) { this.fail({ kind: "bridge-lost", message }, during, null); return; }
    // The launcher marks the run's end before it closes the bridge, so a crash already reads crashed or exited here.
    let run: LauncherRun | undefined;
    try { run = (await this.launcher.experiment(id)).runs.at(-1); } catch { run = undefined; }
    if (run && (run.state === "exited" || run.state === "crashed")) {
      await this.stopAfter({ kind: "sitl-ended", during, ending: run.reason ?? endingOf(run) }, during);
    } else {
      await this.stopAfter({ kind: "bridge-lost", message }, during);
    }
  }

  /** A failure after the launcher owns a run: stop it, collect its diagnostics, then show failed. */
  private async stopAfter(reason: FailureReason, during: RunStateName, retry = false): Promise<void> {
    const id = this.experimentId;
    this.quiet();
    this.generation++;
    if (!id) { this.fail(reason, during, null); return; }
    // One failure stop at a time; a second failure while stopping, idle or failed changes nothing (Stop again retries explicitly).
    const now = this.stateValue.name;
    if (!retry && (now === "stopping" || now === "idle" || now === "failed")) return;
    this.set({ name: "stopping", experimentId: id, cause: "failure" });
    let after: LauncherExperiment;
    try { after = await this.launcher.stop(id); } catch (error) {
      this.fail({ kind: "stop-failed", message: messageOf(error) }, "stopping", null, { kind: "stop-again", experimentId: id, prior: reason, during });
      return;
    }
    let logs: LauncherLogs = { stdout: "", stderr: "", dataflash: [] };
    try { logs = await this.launcher.logs(id); } catch { /* the reason stands without the tails */ }
    const run = after.runs.at(-1);
    this.fail(reason, during, {
      experimentId: id, launcherState: run?.state ?? after.state, exitCode: run?.exitCode ?? null, signal: run?.signal ?? null,
      ending: run?.reason ?? null, stdout: logs.stdout, stderr: logs.stderr, dataflash: logs.dataflash,
    });
  }

  private fail(reason: FailureReason, during: RunStateName, diagnostics: Diagnostics | null, restart: RestartPath = restartFor(reason)): void {
    this.quiet();
    this.set({ name: "failed", reason, during, diagnostics, restart });
  }

  /** Stops every timer and the Worker's bridge, so nothing later overwrites the reason. */
  private quiet(): void {
    this.stopTimer?.();
    this.stopTimer = null;
    this.physics.disconnect();
  }

  private reset(): void {
    this.status = null; this.mode = null; this.armed = false; this.statusText = []; this.recordSha256 = null;
    this.experimentId = null; this.readback = null; this.heartbeatSeen = false; this.acks = [];
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

function restartFor(reason: FailureReason): RestartPath {
  switch (reason.kind) {
    case "vehicle": return { kind: "fix-first", instruction: "Fix the aircraft profile in the Aircraft, Components or Sensors tab, then press Start again" };
    case "firmware": return { kind: "fix-first", instruction: "Reinstall the build with node scripts/install-macos.mjs, or choose another ArduPilot build, then press Start again" };
    case "launcher-unreachable": return { kind: "fix-first", instruction: "Start the launcher with npm run start -w @mirage/launcher, then press Start again" };
    case "launcher-foreign": return { kind: "fix-first", instruction: "Enter the port of the MirageSITL launcher, or stop the program that holds it, then press Start again" };
    case "launcher-refused": case "physics": case "record": case "no-heartbeat": case "parameters":
    case "sitl-ended": case "bridge-lost": case "sitl-restarted":
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
function isStatus(data: unknown): data is SitlStatus {
  return field(data, "type") === "sitl.status" && typeof field(data, "ready") === "boolean" && typeof field(data, "simTimeS") === "number" &&
    typeof field(data, "state") === "string" && typeof field(data, "reason") === "string" && typeof field(data, "message") === "string";
}
