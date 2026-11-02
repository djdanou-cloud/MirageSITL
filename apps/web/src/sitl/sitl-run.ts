// Integrated ArduPilot SITL run from the Run tab (TASK-153, TASK-154): what
// Main prepares and talks to. prepareVehicle turns a stored aircraft profile
// version and its component cards into the derived manifest, ratings, initial
// parameters and sensor snapshot; LauncherClient is the launcher API (TASK-151)
// with validated answers; RuntimePhysics gives the physics Worker the BET
// module, the manifest and its ratings, loads the model in sitl-lockstep and
// connects the Worker to the run's bridge. The run states and the ground
// station are in ../run/session-controller.ts. READY comes from the Worker's
// LiveEkfWarmup only.
//
// TASK-154: the initial parameters carry their source (frame, output, PWM or
// the ArduPilot-owned sensor parameters of TASK-147), and a profile that sets
// a MirageSITL-owned sensor error is refused, because this path does not
// apply those errors on the JSON line yet.
import { describeClash, propellerClearance } from "@mirage/aircraft/clearance";
import { readComponentCard, type ComponentCard } from "@mirage/aircraft/components";
import { combineMassProperties, deriveVehicleManifest, type DerivedVehicleManifest } from "@mirage/aircraft/derive-manifest";
import { FRAME_PARAMETER_NAMES, frameConfiguration, type ParameterValue } from "@mirage/aircraft/frame-parameters";
import { profileDependencies, readAircraftProfile, type AircraftProfile } from "@mirage/aircraft/profile";
import { componentRatings, resolveComponents } from "@mirage/aircraft/resolve-components";
import { sensorField, type Vector3 } from "@mirage/aircraft/sensor-fields";
import { resolveSensorConfiguration, sensorSnapshot, type SensorSnapshot } from "@mirage/aircraft/sensor-ownership";
import { sensorRuntime, STOCK_COMPASS_OFFSETS_MILLIGAUSS } from "@mirage/aircraft/sensor-parameters";
import { parseArduPilotCatalog, type ArduPilotCatalog } from "@mirage/autopilot/error-ownership";
import catalogFile from "../../../../tests/fixtures/sitl/ardupilot-catalog.json" with { type: "json" };
import { catalogAbsentRule, type AbsentRule } from "@mirage/autopilot/parameter-readback";
import { expectedMotors, physicsRotors, type ExpectedMotor, type PhysicsRotor } from "@mirage/autopilot/motor-test";
import type { LimitRatings } from "@mirage/physics/limit-monitor";
import { newFlightStateV2, newPowerSnapshotV1 } from "@mirage/protocol";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import type { SimulationRuntime } from "../runtime";
import { LauncherError, type CatalogEntry, type ConnectionSpec, type LauncherConnection, type LauncherExperiment, type LauncherLogs, type LauncherPort,
  type LauncherRunState, type PhysicsPort, type PreparedRun, type StartSpec } from "../run/session-controller";

/** Model ID of the vehicle an integrated session loads. */
export const SITL_MODEL_ID = 153;
/** ArduCopter's pre-arm check needs the gyro at 1.8 times its 400 Hz loop, so physics runs at 800 Hz. */
export const SITL_PHYSICS_HZ = 800;
/** The link maps 1000-2000 us to ESC duty 0-1; the autopilot's PWM range is pinned to the same span. */
const PWM_PARAMETERS: readonly ParameterValue[] = [{ name: "MOT_PWM_MIN", value: 1000 }, { name: "MOT_PWM_MAX", value: 2000 }];
/** Default home: ArduPilot's SITL test site (CMAC, Canberra), as the launcher tests use. */
export const DEFAULT_HOME: readonly [number, number, number, number] = [-35.363261, 149.16523, 584, 0];

/** Where an initial parameter comes from: the frame, a motor output's function, the PWM range, or a sensor configuration. */
export type ParameterSource = "frame" | "output" | "pwm" | "sensor";
export interface TaggedParameter extends ParameterValue { readonly source: ParameterSource }

export interface PreparedVehicle {
  readonly profileName: string;
  readonly profileSha256: string;
  readonly derived: DerivedVehicleManifest;
  readonly ratings: LimitRatings;
  /** Every initial parameter in launch order: frame and output, PWM, then sensor; names are unique. */
  readonly parameters: readonly TaggedParameter[];
  readonly frameScript: string | null;
  /** The sensor section of the stored profile version, as an experiment record copies it. */
  readonly sensorSnapshot: SensorSnapshot;
  /** 1-based servo output of every rotor, in rotor order. */
  readonly motorChannels: readonly number[];
  /** The motor check (TASK-157): ArduPilot's test order from the frame configuration, and the physics rotors of the manifest. */
  readonly motorTest: { readonly expected: readonly ExpectedMotor[]; readonly physics: readonly PhysicsRotor[] };
}

let arduPilotCatalog: ArduPilotCatalog | null = null;
/**
 * The pinned-source ArduPilot catalog (TASK-089), parsed once on first use.
 * A static JSON import, as frame-parameters.ts reads frames.json: Vite's dev
 * server serves a dynamic JSON import as a JavaScript module, which Chromium
 * refuses under the JSON import attribute.
 */
function pinnedArduPilotCatalog(): ArduPilotCatalog {
  arduPilotCatalog ??= parseArduPilotCatalog(catalogFile);
  return arduPilotCatalog;
}

/** The frame parameters TASK-142 emits: SERVOn_FUNCTION sets an output, every other name the frame. */
function frameSource(name: string): ParameterSource {
  if (!FRAME_PARAMETER_NAMES.has(name)) throw new Error(`${name} is not a frame parameter`);
  return /^SERVO[0-9]+_FUNCTION$/.test(name) ? "output" : "frame";
}

/**
 * Refuses a sensor configuration that specifies a MirageSITL-owned error
 * (IMU noise, bias, latency, position or orientation; battery measurement
 * errors). TASK-147 applies those on the JSON state line through
 * ConfiguredImu and ConfiguredBattery in the native driver, but this run path
 * sends the truth, so the run would silently lack them. Any stored value
 * counts, a neutral one (an explicit zero, or an IMU position at the CG)
 * included: the profile configures the term, and this path applies none.
 */
function refuseMirageSensorErrors(profile: AircraftProfile): void {
  const owned = resolveSensorConfiguration(profile.sensorConfiguration).fields
    .filter(field => field.owner === "mirage" && field.effective.kind === "specified").map(field => `${sensorField(field.path).label} (${field.path})`);
  if (owned.length > 0) {
    throw new Error(`The Run tab does not apply MirageSITL-owned sensor errors yet; clear ${owned.join(", ")} in the Sensors tab, or use Ideal`);
  }
}

/** No run starts from a profile whose propellers clash (TASK-195); the Aircraft tab lists the clashes and proposes a fix. */
function refuseClashes(profile: AircraftProfile, motors: readonly { readonly motorId: number; readonly rotor: { readonly radiusM: number } }[]): void {
  const radii = new Map(motors.map(motor => [motor.motorId, motor.rotor.radiusM]));
  const { clashes } = propellerClearance(profile, motorId => radii.get(motorId) ?? Number.NaN);
  if (clashes.length > 0) {
    throw new Error(`the propellers clash. ${clashes.map(describeClash).join(". ")}. The Aircraft tab proposes a fix`);
  }
}

/** Throws when two initial parameters share a name: the frame, PWM and sensor names must be disjoint. */
export function requireUniqueNames(parameters: readonly TaggedParameter[]): void {
  const sources = new Map<string, ParameterSource>();
  for (const parameter of parameters) {
    const earlier = sources.get(parameter.name);
    if (earlier !== undefined) throw new Error(`${parameter.name} is generated twice, as a parameter of sources ${earlier} and ${parameter.source}`);
    sources.set(parameter.name, parameter.source);
  }
}

/** The CG of the aircraft with its payload, body FRD metres. */
function cgBodyM(profile: AircraftProfile): Vector3 {
  const [x, y, z, ...rest] = combineMassProperties(profile.massProperties, profile.payload).cgOffsetBodyM;
  if (x === undefined || y === undefined || z === undefined || rest.length > 0) throw new Error("The profile's CG is not a 3-vector");
  return [x, y, z];
}

/** Resolves a stored profile version and the exact card versions it names into what an integrated session needs. */
export async function prepareVehicle(store: ProjectStore, stored: StoredVersion): Promise<PreparedVehicle> {
  const profile = readAircraftProfile(stored);
  refuseMirageSensorErrors(profile);
  const cards = new Map<string, ComponentCard>();
  for (const dependency of profileDependencies(profile)) {
    if (dependency.kind === "component-card") cards.set(dependency.sha256, readComponentCard(await store.get(dependency.sha256)));
  }
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`The profile cannot fly yet: ${resolved.missing.join("; ")}`);
  refuseClashes(profile, resolved.components.motors);
  const frame = frameConfiguration(profile, stored.sha256);
  if (!frame.ok) throw new Error(`ArduPilot has no frame for this profile: ${frame.reasons.map(reason => reason.message).join(" ")}`);
  // The barometer parameters scale with the home altitude, so the launcher's home and this context share DEFAULT_HOME.
  const sensors = sensorRuntime(profile.sensorConfiguration, pinnedArduPilotCatalog(),
    { homeAltitudeM: DEFAULT_HOME[2], compassOffsetsMilliGauss: STOCK_COMPASS_OFFSETS_MILLIGAUSS, cgBodyM: cgBodyM(profile) });
  const parameters: TaggedParameter[] = [
    ...frame.parameters.map(parameter => ({ name: parameter.name, value: parameter.value, source: frameSource(parameter.name) })),
    ...PWM_PARAMETERS.map(parameter => ({ name: parameter.name, value: parameter.value, source: "pwm" as const })),
    ...sensors.parameters.map(parameter => ({ name: parameter.name, value: parameter.value, source: "sensor" as const })),
  ];
  requireUniqueNames(parameters);
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: SITL_MODEL_ID });
  return {
    profileName: stored.record.name, profileSha256: stored.sha256, derived, ratings: componentRatings(profile, cards),
    parameters, frameScript: frame.script, sensorSnapshot: sensorSnapshot(stored),
    motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1),
    motorTest: { expected: expectedMotors(frame.motors), physics: physicsRotors(derived.manifest.rotors) },
  };
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  return current;
}

/** Source commits whose SITL behaviour MirageSITL has verified: the pinned catalog's (apps/launcher/src/catalog.ts COMPATIBLE_COMMITS). */
export function verifiedCommits(): readonly string[] {
  return [pinnedArduPilotCatalog().commit];
}

/** The absent-parameter rule of the pinned ArduPilot catalog, for the parameter read-back. */
export function parameterAbsentRule(): AbsentRule {
  return catalogAbsentRule(pinnedArduPilotCatalog());
}

/** What the session controller starts from: the prepared vehicle with the identity of its profile version. */
export async function preparedRun(store: ProjectStore, stored: StoredVersion): Promise<{ vehicle: PreparedVehicle; run: PreparedRun }> {
  const vehicle = await prepareVehicle(store, stored);
  return {
    vehicle,
    run: {
      profile: { sha256: stored.sha256, id: stored.record.id, version: stored.record.version, name: stored.record.name },
      parameters: vehicle.parameters, frameScript: vehicle.frameScript, sensors: vehicle.sensorSnapshot,
      manifestSha256: vehicle.derived.sha256, modelId: SITL_MODEL_ID, motorChannels: vehicle.motorChannels, absentRule: parameterAbsentRule(),
      motorTest: vehicle.motorTest,
    },
  };
}

const STATES: ReadonlySet<string> = new Set(["starting", "start-failed", "running", "stopping", "stopped", "exited", "crashed"]);
function isLauncherState(value: unknown): value is LauncherRunState {
  return typeof value === "string" && STATES.has(value);
}
function launcherState(value: unknown): LauncherRunState {
  if (!isLauncherState(value)) throw new LauncherError("foreign", `The launcher reported an unknown state ${String(value)}`);
  return value;
}
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new LauncherError("foreign", `The launcher's answer lacks ${label}`);
  return value;
};
const integerOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
/** An experiment view (apps/launcher/src/server.ts view()), validated from unknown. */
export function parseLauncherExperiment(value: unknown): LauncherExperiment {
  const runs = field(value, "runs"), ports = field(value, "ports"), firmware = field(value, "firmware");
  if (!Array.isArray(runs)) throw new LauncherError("foreign", "The launcher's answer has no runs");
  const list: readonly unknown[] = runs;
  const bridge = field(ports, "bridge");
  return {
    id: text(field(value, "id"), "an experiment ID"), state: launcherState(field(value, "state")), startError: textOrNull(field(value, "startError")),
    firmware: { id: text(field(firmware, "id"), "the firmware ID"), firmwareVersion: text(field(firmware, "firmwareVersion"), "the firmware version"),
      commit: text(field(firmware, "commit"), "the firmware commit"), binarySha256: text(field(firmware, "binarySha256"), "the binary SHA-256"),
      defaultParametersSha256: text(field(firmware, "defaultParametersSha256"), "the default-parameter SHA-256") },
    runs: list.map(run => {
      const number = integerOrNull(field(run, "run")), pid = integerOrNull(field(run, "pid"));
      if (number === null || pid === null) throw new LauncherError("foreign", "The launcher's run lacks its number or PID");
      return { run: number, pid, state: launcherState(field(run, "state")), exitCode: integerOrNull(field(run, "exitCode")),
        signal: textOrNull(field(run, "signal")), reason: textOrNull(field(run, "reason")) };
    }),
    ports: typeof bridge === "number" && Number.isInteger(bridge) ? { bridge } : null,
  };
}

const CONNECTION_STATES: readonly LauncherConnection["state"][] = ["open", "sitl-closed", "disconnected"];
const count = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new LauncherError("foreign", `The launcher's answer lacks ${label}`);
  return value;
};
/** A connection view (apps/launcher/src/connections.ts view()), validated from unknown. */
export function parseLauncherConnection(value: unknown): LauncherConnection {
  const state = CONNECTION_STATES.find(item => item === field(value, "state"));
  if (field(value, "ownership") !== "external" || state === undefined) throw new LauncherError("foreign", "The launcher's answer is not a connection");
  const transport = field(value, "endpoints", "mavlink", "transport");
  if (transport !== "tcp" && transport !== "udp") throw new LauncherError("foreign", "The launcher's connection lacks its MAVLink transport");
  const bridge = integerOrNull(field(value, "ports", "bridge")), epoch = integerOrNull(field(value, "ports", "epoch"));
  return {
    id: text(field(value, "id"), "a connection ID"), state, closedReason: textOrNull(field(value, "closedReason")),
    endpoints: { jsonPhysicsPort: count(field(value, "endpoints", "jsonPhysicsPort"), "the JSON physics port"),
      mavlink: { transport, port: count(field(value, "endpoints", "mavlink", "port"), "the MAVLink port") } },
    ports: bridge !== null && epoch !== null ? { bridge, epoch } : null,
    physics: { servoPackets: count(field(value, "physics", "servoPackets"), "the servo packet count"),
      rateHz: integerOrNull(field(value, "physics", "rateHz")), channels: integerOrNull(field(value, "physics", "channels")) },
    mavlink: { bytesFromSitl: count(field(value, "mavlink", "bytesFromSitl"), "the MAVLink byte count") },
  };
}

/** The launcher API (TASK-151) on 127.0.0.1; the token goes in the Authorization header only. */
export class LauncherClient implements LauncherPort {
  constructor(readonly port: number, private readonly token: string) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter the launcher's port (1 to 65535)");
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("The launcher token is 64 lower-case hexadecimal characters");
  }
  get bearer(): string { return this.token; }
  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method, cache: "no-store", headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // The browser reports a refused connection and a foreign server without CORS alike.
      throw new LauncherError("unreachable", `No MirageSITL launcher answered on 127.0.0.1:${this.port}; start it with npm run start -w @mirage/launcher, or check the port`);
    }
    const raw = await response.text();
    let json: unknown;
    try { json = raw === "" ? null : JSON.parse(raw); } catch {
      throw new LauncherError("foreign", `Port ${this.port} answers, but not as the MirageSITL launcher`, response.status);
    }
    if (!response.ok) {
      const reason = field(json, "error"), experimentId = field(json, "experimentId");
      throw new LauncherError("refused", typeof reason === "string" ? reason : `status ${response.status}`, response.status,
        typeof experimentId === "string" ? experimentId : null);
    }
    return json;
  }
  async catalog(): Promise<readonly CatalogEntry[]> {
    const list = field(await this.call("GET", "/v1/catalog"), "firmware");
    if (!Array.isArray(list)) throw new LauncherError("foreign", `Port ${this.port} answers, but not as the MirageSITL launcher`);
    const entries: readonly unknown[] = list;
    return entries.map(item => ({ id: text(field(item, "entry", "id"), "a catalog ID"), firmwareVersion: text(field(item, "entry", "firmwareVersion"), "a firmware version"),
      usable: field(item, "usable") === true, reason: textOrNull(field(item, "reason")) }));
  }
  async start(spec: StartSpec): Promise<LauncherExperiment> { return parseLauncherExperiment(await this.call("POST", "/v1/experiments", spec)); }
  async stop(id: string): Promise<LauncherExperiment> { return parseLauncherExperiment(await this.call("POST", `/v1/experiments/${encodeURIComponent(id)}/stop`)); }
  async connect(spec: ConnectionSpec): Promise<LauncherConnection> { return parseLauncherConnection(await this.call("POST", "/v1/connections", spec)); }
  async disconnect(id: string): Promise<LauncherConnection> {
    return parseLauncherConnection(await this.call("POST", `/v1/connections/${encodeURIComponent(id)}/disconnect`));
  }
  async connection(id: string): Promise<LauncherConnection> { return parseLauncherConnection(await this.call("GET", `/v1/connections/${encodeURIComponent(id)}`)); }
  async experiment(id: string): Promise<LauncherExperiment> { return parseLauncherExperiment(await this.call("GET", `/v1/experiments/${encodeURIComponent(id)}`)); }
  async logs(id: string): Promise<LauncherLogs> {
    const json = await this.call("GET", `/v1/experiments/${encodeURIComponent(id)}/logs`);
    const dataflash = field(json, "dataflash");
    const files: readonly unknown[] = Array.isArray(dataflash) ? dataflash : [];
    return { stdout: textOrNull(field(json, "stdout")) ?? "", stderr: textOrNull(field(json, "stderr")) ?? "",
      dataflash: files.flatMap(file => { const name = typeof file === "string" ? file : field(file, "name"); return typeof name === "string" ? [name] : []; }) };
  }
}

/** The physics Worker of a SimulationRuntime as the session controller's PhysicsPort. */
export class RuntimePhysics implements PhysicsPort {
  private vehicleValue: PreparedVehicle | null = null;
  constructor(private readonly runtime: SimulationRuntime, private readonly token: string) {}

  /** The vehicle this session flies, set once it is prepared. */
  use(vehicle: PreparedVehicle): void { this.vehicleValue = vehicle; }
  private get vehicle(): PreparedVehicle {
    if (!this.vehicleValue) throw new Error("The vehicle is not prepared");
    return this.vehicleValue;
  }

  async load(physicsHz: 800 | 1200): Promise<{ betModuleSha256: string }> {
    const { vehicle, runtime } = this;
    runtime.pauseWhenHidden = false;
    const module = await fetchBetModule();
    await this.request({ type: "bet.module", bytes: module.bytes, sha256: module.sha256 }, "bet.module.ready", "bet.module.reject");
    // The vehicle stands on its landing gear on the Rapier contact (TASK-095).
    const contact = await fetchContactModule();
    await this.request({ type: "contact.module", bytes: contact.bytes, manifest: contact.manifest }, "contact.module.ready", "contact.module.reject");
    await this.request({ type: "model.register", bytes: vehicle.derived.bytes, sha256: vehicle.derived.sha256 }, "model.registered", "model.reject");
    await this.request({ type: "limits.register", sha256: vehicle.derived.sha256, ratings: vehicle.ratings }, "limits.registered", "limits.reject");
    await this.control({ type: "sim.configure", hz: physicsHz, clockMode: "sitl-lockstep" });
    await this.control({ type: "model.load", modelId: SITL_MODEL_ID, manifestSha256: vehicle.derived.sha256 });
    await this.control({ type: "sim.start" });
    return { betModuleSha256: module.sha256 };
  }
  connect(port: number, bridgeEpoch: number, speedup: number): void {
    this.runtime.postToWorker({ type: "sitl.connect", port, token: this.token, bridgeEpoch, motorChannels: this.vehicle.motorChannels,
      motorMapId: SITL_MODEL_ID, speedup });
  }
  disconnect(): void { this.runtime.postToWorker({ type: "sitl.disconnect" }); }
  sendMavlink(bytes: Uint8Array): void { this.runtime.postToWorker({ type: "sitl.mavlink.send", bytes }); }
  resume(): Promise<void> { return this.control({ type: "sim.start" }); }
  pause(): Promise<void> { return this.control({ type: "sim.pause" }); }
  private readonly latest = newFlightStateV2();
  tickNow(): { tick: number; simTimeS: number } {
    const s = this.latest;
    this.runtime.latestInto(s);
    return { tick: s.tickId.hi * 2 ** 32 + s.tickId.lo, simTimeS: s.simTimeS };
  }
  altitudeM(): number { return -this.runtime.current.downM; }
  verticalSpeedMps(): number { return this.runtime.current.vdMps; }
  private readonly power = newPowerSnapshotV1();
  motorSpeedsInto(out: Float64Array): boolean {
    if (!this.runtime.power.latest(this.power)) return false;
    for (let i = 0; i < out.length; i++) out[i] = i < this.power.motorCount ? this.power.motors[i * 5] ?? 0 : 0;
    return true;
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

/** The contact module and its build manifest from /__contact/ (Vite, loopback only); the Worker checks one against the other. */
async function fetchContactModule(): Promise<{ bytes: Uint8Array; manifest: unknown }> {
  const manifest: unknown = await (await fetch("/__contact/manifest.json", { cache: "no-store" })).json().catch(() => null);
  if (typeof field(manifest, "sha256") !== "string") throw new Error("No contact module is built; run node scripts/build-contact.mjs");
  const response = await fetch("/__contact/contact.wasm", { cache: "no-store" });
  if (!response.ok) throw new Error("The contact module contact.wasm is not served");
  return { bytes: new Uint8Array(await response.arrayBuffer()), manifest };
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
