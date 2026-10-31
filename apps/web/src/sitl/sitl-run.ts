// Integrated ArduPilot SITL run from the Run tab (TASK-153). Main prepares
// the vehicle from a stored aircraft profile version and its component cards,
// gives the physics Worker the BET module, the derived manifest and its
// ratings, loads the model in sitl-lockstep, starts an owned SITL run through
// the local launcher, connects the Worker to that run's bridge, and acts as
// the ground station: heartbeat, telemetry stream requests, mode, arm,
// take-off and land. The autopilot's own heartbeat, acknowledgements and
// status text are shown as they arrive; READY comes from the Worker's
// LiveEkfWarmup only.
import { readComponentCard, type ComponentCard } from "@mirage/aircraft/components";
import { deriveVehicleManifest, type DerivedVehicleManifest } from "@mirage/aircraft/derive-manifest";
import { frameConfiguration, type ParameterValue } from "@mirage/aircraft/frame-parameters";
import { profileDependencies, readAircraftProfile } from "@mirage/aircraft/profile";
import { componentRatings, resolveComponents } from "@mirage/aircraft/resolve-components";
import { CopterMode, GroundStation, MavCommand } from "@mirage/autopilot/ground-station";
import { MavParser, type MavFrame } from "@mirage/mavlink/codec";
import type { LimitRatings } from "@mirage/physics/limit-monitor";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import type { SimulationRuntime } from "../runtime";
import type { SitlStatus } from "./bridge-client";

/** Model ID of the vehicle an integrated session loads. */
export const SITL_MODEL_ID = 153;
/** ArduCopter's pre-arm check needs the gyro at 1.8 times its 400 Hz loop, so physics runs at 800 Hz. */
export const SITL_PHYSICS_HZ = 800;
/** The link maps 1000-2000 us to ESC duty 0-1; the autopilot's PWM range is pinned to the same span. */
const PWM_PARAMETERS: readonly ParameterValue[] = [{ name: "MOT_PWM_MIN", value: 1000 }, { name: "MOT_PWM_MAX", value: 2000 }];
/** EKF_STATUS_REPORT, GPS_RAW_INT and GLOBAL_POSITION_INT at 10 Hz: LiveEkfWarmup needs GPS within 0.3 s of the IMU. */
const STREAMS: readonly (readonly [number, number])[] = [[193, 100000], [24, 100000], [33, 100000]];
/** Default home: ArduPilot's SITL test site (CMAC, Canberra), as the launcher tests use. */
export const DEFAULT_HOME: readonly [number, number, number, number] = [-35.363261, 149.16523, 584, 0];

export interface PreparedVehicle {
  readonly profileName: string;
  readonly profileSha256: string;
  readonly derived: DerivedVehicleManifest;
  readonly ratings: LimitRatings;
  readonly parameters: readonly ParameterValue[];
  readonly frameScript: string | null;
  /** 1-based servo output of every rotor, in rotor order. */
  readonly motorChannels: readonly number[];
}

/** Resolves a stored profile version and the exact card versions it names into what an integrated session needs. */
export async function prepareVehicle(store: ProjectStore, stored: StoredVersion): Promise<PreparedVehicle> {
  const profile = readAircraftProfile(stored);
  const cards = new Map<string, ComponentCard>();
  for (const dependency of profileDependencies(profile)) {
    if (dependency.kind === "component-card") cards.set(dependency.sha256, readComponentCard(await store.get(dependency.sha256)));
  }
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`The profile cannot fly yet: ${resolved.missing.join("; ")}`);
  const frame = frameConfiguration(profile, stored.sha256);
  if (!frame.ok) throw new Error(`ArduPilot has no frame for this profile: ${frame.reasons.map(reason => reason.message).join(" ")}`);
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: SITL_MODEL_ID });
  return {
    profileName: stored.record.name, profileSha256: stored.sha256, derived, ratings: componentRatings(profile, cards),
    parameters: [...frame.parameters, ...PWM_PARAMETERS], frameScript: frame.script,
    motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1),
  };
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  return current;
}

/** The launcher API (TASK-151) on 127.0.0.1; the token goes in the Authorization header only. */
export class LauncherClient {
  constructor(readonly port: number, private readonly token: string) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter the launcher's port (1 to 65535)");
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("The launcher token is 64 lower-case hexadecimal characters");
  }
  get bearer(): string { return this.token; }
  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method, cache: "no-store", headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const json: unknown = text === "" ? null : JSON.parse(text);
    if (!response.ok) {
      const reason = field(json, "error");
      throw new Error(`Launcher ${method} ${path}: ${typeof reason === "string" ? reason : `status ${response.status}`}`);
    }
    return json;
  }
  /** The first installed SITL build the launcher reports as usable. */
  async firmware(): Promise<string> {
    const list = field(await this.call("GET", "/v1/catalog"), "firmware");
    const entries: readonly unknown[] = Array.isArray(list) ? list : [];
    const usable = entries.find(item => field(item, "usable") === true);
    const id = field(usable, "entry", "id");
    if (typeof id !== "string") throw new Error("The launcher has no usable SITL build; run node scripts/install-macos.mjs");
    return id;
  }
}

export type AutopilotStage = "idle" | "preparing" | "warming" | "ready" | "arming" | "climbing" | "flying" | "landing" | "landed" | "stopped" | "failed";
export interface RunView {
  readonly stage: AutopilotStage;
  readonly message: string;
  readonly status: SitlStatus | null;
  /** From the autopilot's heartbeat, or null before the first one. */
  readonly mode: number | null;
  readonly armed: boolean;
  readonly statusText: readonly string[];
  readonly experimentId: string | null;
}

function isStatus(data: unknown): data is SitlStatus {
  return field(data, "type") === "sitl.status" && typeof field(data, "ready") === "boolean" && typeof field(data, "simTimeS") === "number" &&
    typeof field(data, "state") === "string" && typeof field(data, "reason") === "string";
}

/** One integrated run: start(), then takeOff()/land(), then stop(). */
export class SitlRun {
  private view: RunView = { stage: "idle", message: "", status: null, mode: null, armed: false, statusText: [], experimentId: null };
  private readonly gcs = new GroundStation();
  private readonly packet = new Uint8Array(64);
  private readonly parser: MavParser;
  private readonly acks: { command: number; result: number }[] = [];
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private unlisten: (() => void) | null = null;
  private takeoffM = 0;
  /** Set by stop(): the socket's close that follows is the end of the run, not a failure. */
  private stopping = false;

  constructor(private readonly runtime: SimulationRuntime, private readonly launcher: LauncherClient, private readonly onChange: (view: RunView) => void) {
    this.parser = new MavParser((frame: MavFrame) => this.autopilot(frame));
  }

  get current(): RunView { return this.view; }

  async start(vehicle: PreparedVehicle, speedup: number): Promise<void> {
    if (this.view.stage !== "idle") throw new Error("This run has already started");
    this.update({ stage: "preparing", message: `Preparing ${vehicle.profileName}` });
    this.unlisten = this.runtime.listen(data => this.worker(data));
    try {
      this.runtime.pauseWhenHidden = false;
      const module = await fetchBetModule();
      await this.request({ type: "bet.module", bytes: module.bytes, sha256: module.sha256 }, "bet.module.ready", "bet.module.reject");
      await this.request({ type: "model.register", bytes: vehicle.derived.bytes, sha256: vehicle.derived.sha256 }, "model.registered", "model.reject");
      await this.request({ type: "limits.register", sha256: vehicle.derived.sha256, ratings: vehicle.ratings }, "limits.registered", "limits.reject");
      await this.control({ type: "sim.configure", hz: SITL_PHYSICS_HZ, clockMode: "sitl-lockstep" });
      await this.control({ type: "model.load", modelId: SITL_MODEL_ID, manifestSha256: vehicle.derived.sha256 });
      await this.control({ type: "sim.start" });
      const firmwareId = await this.launcher.firmware();
      const started = await this.launcher.call("POST", "/v1/experiments", { firmwareId, parameters: vehicle.parameters,
        frameScript: vehicle.frameScript, speedup, rateHz: SITL_PHYSICS_HZ, home: DEFAULT_HOME });
      const experimentId = field(started, "id"), port = field(started, "ports", "bridge"), runs = field(started, "runs");
      if (typeof experimentId !== "string" || typeof port !== "number" || !Array.isArray(runs)) throw new Error("The launcher's answer has no run");
      this.update({ stage: "warming", experimentId, message: `SITL run ${experimentId} started` });
      this.runtime.reader.readHeader(this.runtime.header);
      this.runtime.postToWorker({ type: "sitl.connect", port, token: this.launcher.bearer, bridgeEpoch: runs.length,
        motorChannels: vehicle.motorChannels, motorMapId: SITL_MODEL_ID, speedup });
      this.heartbeat = setInterval(() => this.beat(), 1000);
    } catch (error) {
      this.update({ stage: "failed", message: error instanceof Error ? error.message : String(error) });
      await this.stop();
    }
  }

  /** GUIDED, arm, then NAV_TAKEOFF to `altitudeM`; only after READY. */
  takeOff(altitudeM: number): void {
    if (this.view.stage !== "ready" && this.view.stage !== "landed") return;
    if (!(altitudeM >= 1 && altitudeM <= 100)) { this.update({ message: "Take-off altitude must be 1 to 100 m" }); return; }
    this.takeoffM = altitudeM;
    this.update({ stage: "arming", message: "Setting GUIDED and arming" });
    this.send(this.gcs.setModeInto(CopterMode.Guided, this.packet));
  }
  land(): void {
    if (this.view.stage !== "climbing" && this.view.stage !== "flying") return;
    this.update({ stage: "landing", message: "LAND" });
    this.send(this.gcs.setModeInto(CopterMode.Land, this.packet));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.runtime.postToWorker({ type: "sitl.disconnect" });
    const id = this.view.experimentId;
    if (id) {
      try { await this.launcher.call("POST", `/v1/experiments/${id}/stop`); } catch (error) {
        this.update({ message: `Stopping the SITL run failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    this.unlisten?.();
    this.unlisten = null;
    if (this.view.stage !== "failed") this.update({ stage: "stopped" });
  }

  /** Ground-station duties once per wall second: heartbeat, stream requests until acknowledged, and command retries. */
  private beat(): void {
    this.send(this.gcs.heartbeatInto(this.packet));
    if (this.acks.filter(a => a.command === MavCommand.SetMessageInterval && a.result === 0).length < STREAMS.length) {
      for (const [id, us] of STREAMS) this.send(this.gcs.messageIntervalInto(id, us, this.packet));
    }
    const { stage, mode, armed } = this.view;
    if (stage === "arming") {
      if (mode !== CopterMode.Guided) this.send(this.gcs.setModeInto(CopterMode.Guided, this.packet));
      else if (!armed) this.send(this.gcs.armInto(true, this.packet));
    } else if (stage === "landing" && mode !== CopterMode.Land) this.send(this.gcs.setModeInto(CopterMode.Land, this.packet));
  }

  private send(n: number): void {
    if (n > 0) this.runtime.postToWorker({ type: "sitl.mavlink.send", bytes: this.packet.slice(0, n) });
  }

  private autopilot(frame: MavFrame): void {
    if (frame.systemId !== 1 || frame.componentId !== 1) return;
    if (frame.id === 0) {
      const mode = frame.view.getUint32(0, true), armed = (frame.view.getUint8(6) & 128) !== 0, was = this.view;
      this.update({ mode, armed });
      if (was.stage === "arming" && armed) {
        this.send(this.gcs.takeoffInto(this.takeoffM, this.packet));
        this.update({ stage: "climbing", message: `Taking off to ${this.takeoffM} m` });
      }
      if (was.stage === "landing" && !armed) this.update({ stage: "landed", message: "Landed and disarmed" });
    } else if (frame.id === 77) {
      const command = frame.view.getUint16(0, true), result = frame.view.getUint8(2);
      this.acks.push({ command, result });
      if (result !== 0 && command !== MavCommand.SetMessageInterval) this.update({ message: `ArduPilot refused command ${command} (MAV_RESULT ${result})` });
    } else if (frame.id === 253) {
      const text = new TextDecoder().decode(frame.payload.subarray(1, 51)).replace(/\0[\s\S]*$/, "");
      this.update({ statusText: [...this.view.statusText, text].slice(-8) });
    }
  }

  private worker(data: unknown): void {
    if (field(data, "type") === "sitl.mavlink") {
      const bytes = field(data, "bytes");
      if (bytes instanceof Uint8Array) this.parser.push(bytes);
      return;
    }
    if (field(data, "type") === "sitl.reject") { this.update({ stage: "failed", message: String(field(data, "message")) }); return; }
    if (!isStatus(data)) return;
    let stage = this.view.stage;
    if (data.state === "closed" || data.state === "fault") stage = this.stopping && data.state === "closed" ? this.view.stage : "failed";
    else if (stage === "warming" && data.ready) stage = "ready";
    else if (stage === "ready" && !data.ready) stage = "warming"; // stale diagnostics revoke READY
    // Flying once the climb has settled at the target: within 0.5 m and below 0.3 m/s vertical speed (truth, as the panel shows it).
    const truth = this.runtime.current;
    if (stage === "climbing" && Math.abs(-truth.downM - this.takeoffM) < 0.5 && Math.abs(truth.vdMps) < 0.3) stage = "flying";
    this.update({ status: data, stage, ...(data.message && stage === "failed" ? { message: data.message } : {}) });
  }

  private update(change: Partial<RunView>): void {
    this.view = { ...this.view, ...change };
    this.onChange(this.view);
  }

  /** Posts a Worker message and resolves on its acceptance notice. */
  private request(message: Record<string, unknown>, ok: string, reject: string): Promise<void> {
    return new Promise((resolve, fail) => {
      const stop = this.runtime.listen(data => {
        const type = field(data, "type");
        if (type === ok) { stop(); resolve(); }
        if (type === reject) { stop(); fail(new Error(String(field(data, "message")))); }
      });
      this.runtime.postToWorker(message);
    });
  }

  /** Submits a Control Protocol v2 command and resolves on its applied acknowledgement. */
  private control(payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, fail) => {
      let requestId = -1;
      const stop = this.runtime.listen(data => {
        if (field(data, "requestId") !== requestId) return;
        if (field(data, "type") === "reject-v2") { stop(); fail(new Error(`${String(payload.type)}: ${String(field(data, "message"))}`)); }
        if (field(data, "type") === "ack-v2" && field(data, "status") === "applied") { stop(); resolve(); }
      });
      const command = this.runtime.submitControl(payload);
      if (!command) { stop(); fail(new Error(`${String(payload.type)} was not accepted: ${this.runtime.notice}`)); return; }
      requestId = command.requestId;
    });
  }
}

/** The scalar BET module from /__bet/ (Vite, loopback only), checked against its manifest. */
async function fetchBetModule(): Promise<{ bytes: Uint8Array; sha256: string }> {
  const manifest: unknown = await (await fetch("/__bet/manifest.json", { cache: "no-store" })).json().catch(() => null);
  const artifacts = field(manifest, "artifacts");
  const list: readonly unknown[] = Array.isArray(artifacts) ? artifacts : [];
  const scalar = list.find(item => field(item, "variant") === "scalar");
  const file = field(scalar, "file"), sha256 = field(scalar, "sha256");
  if (typeof file !== "string" || typeof sha256 !== "string") throw new Error("No BET module is built; run node scripts/build-wasm.mjs");
  const response = await fetch(`/__bet/${file}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`The BET module ${file} is not served`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), v => v.toString(16).padStart(2, "0")).join("");
  if (actual !== sha256) throw new Error("The BET module differs from its manifest");
  return { bytes, sha256 };
}
