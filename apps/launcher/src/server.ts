import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../../bridge/src/server.ts";
import { nativeAdmission, readCatalog, verifyEntry, type ExecutableAdmission, type FirmwareEntry } from "./catalog.ts";
import { dataflashPath, listDataflash, tail } from "./logs.ts";
import { ConnectionRefused, ExternalConnection, type ConnectionSpec } from "./connections.ts";
import { checkPrerequisites } from "./prerequisites.ts";
import { OwnedProcess, type RunInfo, type RunState } from "./processes.ts";
import { MavlinkRelay } from "./relay.ts";

// MirageSITL local launcher (TASK-151, S01/S02). A web page cannot start
// programs; this loopback service, which the user starts, is the only
// component that does. API v1 (JSON over HTTP on 127.0.0.1):
//   GET  /v1/status                       launcher and experiment states
//   GET  /v1/prerequisites                structured checks with fixes
//   GET  /v1/catalog                      installed SITL builds and usability
//   POST /v1/experiments                  start an owned SITL run
//   GET  /v1/experiments/{id}             one experiment and its runs
//   POST /v1/experiments/{id}/stop        stop its owned process group
//   POST /v1/experiments/{id}/restart     start a new run of a stopped one
//   GET  /v1/experiments/{id}/logs        diagnostics tails and DataFlash list
//   GET  /v1/experiments/{id}/dataflash/{name}  one DataFlash file
//   POST /v1/connections                  connect to a SITL the user started
//   GET  /v1/connections/{id}             one connection
//   POST /v1/connections/{id}/disconnect  release it; the SITL keeps running
// Every request needs `Authorization: Bearer <token>` and the exact
// configured Origin; Host must name the loopback listener. The token is
// generated locally into <home>/token (mode 0600) and is never printed, put
// in a URL or accepted from one. Each run hosts its own WebSocket bridge
// (TASK-040) for JSON physics and MAVLink, authenticated with the same token.
// A start is checked completely (body, firmware, one running experiment,
// firmware files) before anything is created, so a refused start leaves no
// experiment and no folder. An experiment's view echoes the identity of the
// build it runs, without machine paths. Its state is "starting" while a run
// is being launched and "start-failed" (with startError) when the launch
// failed before SITL ran; otherwise it is the state of its latest run. Its
// ports are null whenever no bridge and relay are open. A connection
// (TASK-155) has ownership "external": the launcher owns its bridge and relay,
// never the SITL process, so disconnecting signals nothing. One experiment
// run or one open connection at a time.

export const LAUNCHER_API_VERSION = 1;
export const DEFAULT_LAUNCHER_PORT = 47800;
const TOKEN = /^[0-9a-f]{64}$/;
const PARAMETER_NAME = /^[A-Z][A-Z0-9_]{0,15}$/;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PARAMETERS = 4096;
const MAX_SCRIPT_BYTES = 64 * 1024;

export interface LauncherOptions {
  readonly home: string;
  readonly origin: string;
  /** 0 picks a free port. */
  readonly port?: number;
  readonly python: string;
  readonly admit?: ExecutableAdmission;
}
interface ExperimentSpec {
  readonly firmwareId: string;
  readonly parameters: readonly { readonly name: string; readonly value: number }[];
  readonly frameScript: string | null;
  readonly speedup: number;
  readonly rateHz: number;
  readonly home: readonly [number, number, number, number];
}
/** Where the latest launch of an experiment stands; "launched" defers to its latest run. */
type Launch =
  | { readonly phase: "launching" }
  | { readonly phase: "launched" }
  | { readonly phase: "failed"; readonly error: string };
type ExperimentState = RunState | "starting" | "start-failed";
interface Experiment {
  readonly id: string;
  readonly spec: ExperimentSpec;
  readonly firmware: FirmwareEntry;
  readonly workDirectory: string;
  readonly runs: RunInfo[];
  process: OwnedProcess | null;
  bridge: { readonly port: number; close(): Promise<void> } | null;
  relay: MavlinkRelay | null;
  launch: Launch;
  ports: { bridge: number; jsonPhysics: number; mavlinkRelay: number } | null;
}
class HttpError extends Error {
  readonly status: number;
  /** The experiment the failed request created, so its logs stay reachable. */
  readonly experimentId: string | null;
  constructor(status: number, message: string, experimentId: string | null = null) {
    super(message);
    this.status = status;
    this.experimentId = experimentId;
  }
}

/** The launcher token of a home folder, created on first use; refuses a token file others can read. */
export function ensureToken(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "token");
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`The launcher token file ${path} must be readable by its owner only (chmod 600)`);
  const token = readFileSync(path, "utf8").trim();
  if (!TOKEN.test(token)) throw new Error(`The launcher token file ${path} is damaged; delete it to create a new token`);
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new HttpError(400, `${label} must be a number from ${min} to ${max}`);
  return value;
}
/** Validates a connection request from `unknown`: the JSON physics port and the MAVLink transport and port. */
export function parseConnectionSpec(input: unknown): ConnectionSpec {
  if (!isRecord(input)) throw new HttpError(400, "The request body must be a JSON object");
  if (Object.keys(input).sort().join(",") !== "jsonPhysicsPort,mavlink") throw new HttpError(400, "Expected jsonPhysicsPort and mavlink");
  const { jsonPhysicsPort, mavlink } = input;
  if (!isRecord(mavlink) || Object.keys(mavlink).sort().join(",") !== "port,transport") throw new HttpError(400, "mavlink must be { transport, port }");
  const { transport, port } = mavlink;
  if (transport !== "tcp" && transport !== "udp") throw new HttpError(400, "mavlink.transport must be tcp or udp");
  const jsonPort = finite(jsonPhysicsPort, "jsonPhysicsPort", 1, 65535), mavlinkPort = finite(port, "mavlink.port", 1, 65535);
  if (!Number.isInteger(jsonPort) || !Number.isInteger(mavlinkPort)) throw new HttpError(400, "Ports must be integers");
  if (transport === "udp" && jsonPort === mavlinkPort) throw new HttpError(400, "The JSON physics port and the MAVLink UDP port must differ");
  return { jsonPhysicsPort: jsonPort, mavlink: { transport, port: mavlinkPort } };
}

/** Validates a start request from `unknown`. */
export function parseExperimentSpec(input: unknown): ExperimentSpec {
  if (!isRecord(input)) throw new HttpError(400, "The request body must be a JSON object");
  const keys = Object.keys(input).sort().join(",");
  if (keys !== "firmwareId,frameScript,home,parameters,rateHz,speedup") throw new HttpError(400, "Expected firmwareId, parameters, frameScript, speedup, rateHz and home");
  const { firmwareId, parameters, frameScript, speedup, rateHz, home } = input;
  if (typeof firmwareId !== "string" || firmwareId === "") throw new HttpError(400, "firmwareId must name a catalog entry");
  if (!Array.isArray(parameters) || parameters.length > MAX_PARAMETERS) throw new HttpError(400, `parameters must be a list of at most ${MAX_PARAMETERS}`);
  const raw: readonly unknown[] = parameters;
  const names = new Set<string>();
  const list = raw.map(item => {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "name,value") throw new HttpError(400, "Each parameter needs name and value");
    const { name, value } = item;
    if (typeof name !== "string" || !PARAMETER_NAME.test(name) || names.has(name)) throw new HttpError(400, `Invalid or repeated parameter name ${String(name)}`);
    names.add(name);
    return { name, value: finite(value, name, -3.4e38, 3.4e38) };
  });
  if (frameScript !== null && (typeof frameScript !== "string" || Buffer.byteLength(frameScript) > MAX_SCRIPT_BYTES || /[^\t\n\x20-\x7e]/.test(frameScript))) {
    throw new HttpError(400, `frameScript must be null or printable ASCII Lua of at most ${MAX_SCRIPT_BYTES} bytes`);
  }
  if (!Array.isArray(home) || home.length !== 4) throw new HttpError(400, "home must be [latitudeDeg, longitudeDeg, altitudeM, headingDeg]");
  const location: readonly unknown[] = home;
  return {
    firmwareId, parameters: list, frameScript, speedup: finite(speedup, "speedup", 0.1, 100), rateHz: finite(rateHz, "rateHz", 100, 2000),
    home: [finite(location[0], "latitude", -90, 90), finite(location[1], "longitude", -180, 180), finite(location[2], "altitude", -500, 9000), finite(location[3], "heading", 0, 360)],
  };
}

export async function startLauncher(options: LauncherOptions) {
  const allowed = new URL(options.origin);
  if (allowed.origin !== options.origin || !["http:", "https:"].includes(allowed.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(allowed.hostname)) {
    throw new Error("The launcher origin must be one loopback web origin, such as http://127.0.0.1:5173");
  }
  const home = resolve(options.home);
  const token = ensureToken(home);
  const admit = options.admit ?? nativeAdmission;
  const experiments = new Map<string, Experiment>();
  let server: Server | null = null;

  // True while a run starts, so admitRun refuses a second start; no await separates admitRun from launchRun.
  let launching = false;
  const connections = new Map<string, ExternalConnection>();
  /** A connection being opened, so a start or a second connection waits its turn. */
  let connecting = false;
  const openConnection = (): boolean => connecting || [...connections.values()].some(connection => connection.state === "open");
  const newId = () => `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomBytes(4).toString("hex")}`;

  const stateOf = (experiment: Experiment): ExperimentState => {
    const { launch } = experiment;
    switch (launch.phase) {
      case "launching": return "starting";
      case "failed": return "start-failed";
      // A launched experiment always has a run: launchRun pushes it before marking the launch done.
      case "launched": return experiment.runs.at(-1)?.state ?? "starting";
      default: { const unreachable: never = launch; return unreachable; }
    }
  };
  const view = (experiment: Experiment) => {
    const { id, firmwareVersion, commit, binarySha256, defaultParametersSha256 } = experiment.firmware;
    return {
      id: experiment.id, firmwareId: id, firmware: { id, firmwareVersion, commit, binarySha256, defaultParametersSha256 },
      state: stateOf(experiment), startError: experiment.launch.phase === "failed" ? experiment.launch.error : null,
      runs: experiment.runs, workDirectory: experiment.workDirectory, ports: experiment.ports,
    };
  };
  const authorized = (request: IncomingMessage): boolean => {
    const header = request.headers.authorization ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    return TOKEN.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  };
  const hostValid = (request: IncomingMessage): boolean => {
    const address = server?.address();
    const port = address && typeof address === "object" ? address.port : -1;
    return request.headers.host === `127.0.0.1:${port}` || request.headers.host === `localhost:${port}`;
  };
  const readBody = (request: IncomingMessage): Promise<unknown> => new Promise((done, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, "The request body is too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        done(parsed);
      } catch {
        reject(new HttpError(400, "The request body is not JSON"));
      }
    });
    request.on("error", reject);
  });
  const experimentOf = (id: string): Experiment => {
    const experiment = experiments.get(id);
    if (!experiment) throw new HttpError(404, "No experiment of this launcher has that ID");
    return experiment;
  };

  async function endRun(experiment: Experiment): Promise<void> {
    const bridge = experiment.bridge, relay = experiment.relay;
    experiment.bridge = null;
    experiment.relay = null;
    // The ports named the bridge and relay just closed; a view must not offer them.
    experiment.ports = null;
    relay?.close();
    await bridge?.close();
  }
  /** The checks of a start or restart, before it creates anything: no other run, and firmware files as installed. */
  function admitRun(firmware: FirmwareEntry): void {
    if (launching || [...experiments.values()].some(other => other.process?.running)) throw new HttpError(409, "Another experiment is running; stop it first");
    if (openConnection()) throw new HttpError(409, "A connection to an external SITL is open; disconnect it first");
    const status = verifyEntry(firmware, admit);
    if (!status.usable) throw new HttpError(409, `Firmware ${firmware.id} cannot be started: ${status.reason}`);
  }
  /** Starts the next run of an admitted experiment; call it right after admitRun, with no await between. */
  async function launchRun(experiment: Experiment): Promise<void> {
    launching = true;
    experiment.launch = { phase: "launching" };
    try {
      const run = experiment.runs.length + 1;
      let relay: MavlinkRelay, bridge: Awaited<ReturnType<typeof startBridge>>;
      try {
        relay = await MavlinkRelay.open();
      } catch (error) {
        throw new HttpError(500, `The MAVLink relay did not start: ${error instanceof Error ? error.message : String(error)}`, experiment.id);
      }
      try {
        // physicsPort is unused in ArduPilot JSON mode; the bridge only requires it to differ from the MAVLink port.
        bridge = await startBridge({ port: 0, origin: options.origin, token, epoch: run, udp: { mavlinkPort: relay.bridgePort, physicsPort: relay.sitlPort }, ardupilotJson: { localPort: 0 } });
      } catch (error) {
        relay.close();
        throw new HttpError(500, `The bridge did not start: ${error instanceof Error ? error.message : String(error)}`, experiment.id);
      }
      // The bridge's MAVLink socket is its only UDP socket in JSON mode.
      relay.attachBridge(bridge.udpLocalPorts[0]!);
      const jsonPort = bridge.jsonPhysics!.localPort;
      experiment.relay = relay;
      experiment.bridge = bridge;
      experiment.ports = { bridge: bridge.port, jsonPhysics: jsonPort, mavlinkRelay: relay.sitlPort };
      const { spec, firmware, workDirectory } = experiment;
      const args = [
        "--model", "JSON:127.0.0.1", "--speedup", String(spec.speedup), "--rate", String(spec.rateHz),
        "--home", spec.home.join(","), "--sim-port-out", String(jsonPort),
        "--serial0", `udpclient:127.0.0.1:${relay.sitlPort}`, "--serial1", "none", "--serial2", "none",
        "--defaults", `${firmware.defaultParametersPath},${join(workDirectory, "experiment.parm")}`,
      ];
      try {
        experiment.process = await OwnedProcess.start({ command: firmware.binaryPath, args, cwd: workDirectory, run }, () => { void endRun(experiment); });
      } catch (error) {
        await endRun(experiment);
        throw new HttpError(500, `SITL did not start: ${error instanceof Error ? error.message : String(error)}`, experiment.id);
      }
      experiment.runs.push(experiment.process.info);
      experiment.launch = { phase: "launched" };
    } catch (error) {
      experiment.launch = { phase: "failed", error: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally {
      launching = false;
    }
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? "";
    if (url.includes("?") || url.includes("#")) throw new HttpError(400, "Query strings are not accepted; send the token in the Authorization header");
    const parts = url.split("/").filter(Boolean);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    const method = request.method ?? "";
    if (parts[0] !== `v${LAUNCHER_API_VERSION}`) throw new HttpError(404, "Unknown API version or path");
    const [, resource, id, action, name] = parts;
    if (method === "GET" && resource === "status" && parts.length === 2) {
      send(200, { apiVersion: LAUNCHER_API_VERSION, launcherPid: process.pid, experiments: [...experiments.values()].map(view),
        connections: [...connections.values()].map(connection => connection.view()) });
    } else if (method === "GET" && resource === "prerequisites" && parts.length === 2) {
      send(200, { checks: checkPrerequisites({ home, python: options.python, admit }) });
    } else if (method === "GET" && resource === "catalog" && parts.length === 2) {
      send(200, { firmware: readCatalog(home).map(entry => verifyEntry(entry, admit)) });
    } else if (method === "POST" && resource === "experiments" && parts.length === 2) {
      const spec = parseExperimentSpec(await readBody(request));
      const firmware = readCatalog(home).find(entry => entry.id === spec.firmwareId);
      if (!firmware) throw new HttpError(404, `No installed firmware ${spec.firmwareId}`);
      // Every refusal comes before the folder, experiment.json and the registration below.
      admitRun(firmware);
      const experimentId = newId();
      const workDirectory = join(home, "experiments", experimentId);
      mkdirSync(join(workDirectory, "logs"), { recursive: true, mode: 0o700 });
      writeFileSync(join(workDirectory, "experiment.parm"), spec.parameters.map(parameter => `${parameter.name} ${parameter.value}\n`).join(""), { mode: 0o600 });
      if (spec.frameScript !== null) {
        mkdirSync(join(workDirectory, "scripts"), { mode: 0o700 });
        writeFileSync(join(workDirectory, "scripts", "frame.lua"), spec.frameScript, { mode: 0o600 });
      }
      writeFileSync(join(workDirectory, "experiment.json"), `${JSON.stringify({ id: experimentId, firmware, spec }, null, 2)}\n`, { mode: 0o600 });
      const experiment: Experiment = { id: experimentId, spec, firmware, workDirectory, runs: [], process: null, bridge: null, relay: null, launch: { phase: "launching" }, ports: null };
      experiments.set(experimentId, experiment);
      await launchRun(experiment);
      send(201, view(experiment));
    } else if (resource === "experiments" && id !== undefined) {
      const experiment = experimentOf(id);
      if (method === "GET" && parts.length === 3) {
        send(200, view(experiment));
      } else if (method === "POST" && action === "stop" && parts.length === 4) {
        await experiment.process?.stop();
        await endRun(experiment);
        send(200, view(experiment));
      } else if (method === "POST" && action === "restart" && parts.length === 4) {
        if (experiment.process?.running) throw new HttpError(409, "The experiment is still running");
        admitRun(experiment.firmware);
        await launchRun(experiment);
        send(200, view(experiment));
      } else if (method === "GET" && action === "logs" && parts.length === 4) {
        const run = experiment.runs.length;
        send(200, {
          run, stdout: tail(join(experiment.workDirectory, `stdout-${run}.log`)), stderr: tail(join(experiment.workDirectory, `stderr-${run}.log`)),
          dataflash: listDataflash(experiment.workDirectory),
        });
      } else if (method === "GET" && action === "dataflash" && name !== undefined && parts.length === 5) {
        const path = dataflashPath(experiment.workDirectory, name);
        if (!path) throw new HttpError(404, "No DataFlash file of that name");
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(path).size, "cache-control": "no-store" });
        createReadStream(path).pipe(response);
      } else {
        throw new HttpError(404, "Unknown experiment action");
      }
    } else if (method === "POST" && resource === "connections" && parts.length === 2) {
      const spec = parseConnectionSpec(await readBody(request));
      if (launching || [...experiments.values()].some(other => other.process?.running)) throw new HttpError(409, "An experiment is running; stop it first");
      if (openConnection()) throw new HttpError(409, "A connection to an external SITL is open; disconnect it first");
      connecting = true;
      try {
        const connection = await ExternalConnection.open(newId(), spec, { origin: options.origin, token });
        connections.set(connection.id, connection);
        send(201, connection.view());
      } catch (error) {
        // A refused connection leaves nothing open and nothing registered.
        if (error instanceof ConnectionRefused) throw new HttpError(409, error.message);
        throw error;
      } finally {
        connecting = false;
      }
    } else if (resource === "connections" && id !== undefined) {
      const connection = connections.get(id);
      if (!connection) throw new HttpError(404, "No connection of this launcher has that ID");
      if (method === "GET" && parts.length === 3) {
        send(200, connection.view());
      } else if (method === "POST" && action === "disconnect" && parts.length === 4) {
        await connection.disconnect();
        send(200, connection.view());
      } else {
        throw new HttpError(404, "Unknown connection action");
      }
    } else {
      throw new HttpError(404, "Unknown API path");
    }
  }

  server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (origin !== options.origin || !hostValid(request)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Forbidden origin or host" }));
      request.resume();
      return;
    }
    response.setHeader("access-control-allow-origin", options.origin);
    response.setHeader("vary", "Origin");
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600" });
      response.end();
      return;
    }
    if (!authorized(request)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Missing or wrong launcher token" }));
      request.resume();
      return;
    }
    route(request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
      const experimentId = error instanceof HttpError ? error.experimentId : null;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(experimentId === null ? {} : { experimentId }) }));
    });
  });
  await new Promise<void>((done, reject) => {
    server?.once("error", reject);
    server?.listen(options.port ?? DEFAULT_LAUNCHER_PORT, "127.0.0.1", () => done());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No launcher address");
  return {
    port: address.port,
    tokenPath: join(home, "token"),
    /**
     * Fault injection for tests, reachable in-process only: no HTTP route
     * calls it. Ends the run's bridge and relay as a lost bridge would,
     * without signalling SITL, which keeps running until stopped. Resolves
     * false when the experiment is unknown or has no bridge open.
     */
    closeBridge: async (experimentId: string): Promise<boolean> => {
      const experiment = experiments.get(experimentId);
      if (!experiment || (experiment.bridge === null && experiment.relay === null)) return false;
      await endRun(experiment);
      return true;
    },
    /** Releases every connection, stops every owned run, then closes the listener. */
    close: async () => {
      for (const connection of connections.values()) await connection.disconnect();
      for (const experiment of experiments.values()) {
        await experiment.process?.stop();
        await endRun(experiment);
      }
      await new Promise<void>((done, reject) => server?.close(error => (error ? reject(error) : done())));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.env.MIRAGE_LAUNCHER_HOME ?? join(homedir(), "Library", "Application Support", "MirageSITL", "launcher");
  const launcher = await startLauncher({
    home, origin: process.env.MIRAGE_LAUNCHER_ORIGIN ?? "http://127.0.0.1:5173",
    port: Number(process.env.MIRAGE_LAUNCHER_PORT ?? DEFAULT_LAUNCHER_PORT),
    python: process.env.MIRAGE_LAUNCHER_PYTHON ?? join(home, "venv", "bin", "python"),
  });
  // The token itself is never printed; the user reads it from the file.
  console.log(`MirageSITL launcher listening on 127.0.0.1:${launcher.port}; token file ${launcher.tokenPath}`);
  const shutdown = () => { void launcher.close().then(() => process.exit(0)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
