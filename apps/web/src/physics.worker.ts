/// <reference lib="webworker" />
import { AarRecord } from '@mirage/aar/record';
import { RecordingHandoff } from '@mirage/aar/handoff';
import { isProducerPlan, RecordingProducerV2 } from '@mirage/aar/recorder-v2';
import { createSessionFaultPort } from '@mirage/ew/session-port';
import { isWorkerInitV2, tickToNumber, validatePowerChannelV1, type CommandResultV2, type ControlCommand, type WorkerFaultV2 } from '@mirage/protocol';
import { parseLimitRatings, type LimitEvent, type LimitRatings } from '@mirage/physics/limit-monitor';
import type { AccidentEvent } from '@mirage/physics/accident';
import { PhysicsSessionV2, TERRAIN_MISSING_COUNT, TERRAIN_MISSING_EAST, TERRAIN_MISSING_NORTH, TERRAIN_MISSING_SIM_S, TERRAIN_MISSING_TICK, type SessionClock } from '@mirage/physics';
import { CollisionChunks } from '@mirage/terrain/collision-chunks';
import { RUN_CHUNK_RESOLUTION, RUN_CHUNK_SPACING_M, RUN_TERRAIN_EPOCH } from '@mirage/terrain/run-terrain';
import { GroundContact } from '@mirage/physics/ground-contact';
import { atmosphereFromState } from '@mirage/physics/atmosphere';
import { profileModelPort, type ProfileDynamicsOptions } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { ScenarioBinder } from '@mirage/scenarios/bind';
import { parseGroundStart, type GroundStart } from '@mirage/scenarios/flight-tasks';
import { SitlBridgeClient, bridgeSocketArguments, type SitlNotice } from './sitl/bridge-client';
import { parseScenario } from '@mirage/scenarios/schema';

// Thin message adapter around PhysicsSessionV2 (ABI v2, Control Protocol v2).
// Messages are validated at runtime: init-v2 by shape and buffer layouts,
// commands by the Control Protocol v2 validator inside the session.

const clock: SessionClock = {
  monotonicMs: () => performance.now(),
  wallMs: () => performance.timeOrigin + performance.now(),
};
let session: PhysicsSessionV2 | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let binder: ScenarioBinder | null = null;
let haltPosted = false;
let recorder: { handoff: RecordingHandoff; record: AarRecord } | null = null;
// TASK-153: the integrated SITL session, on the init buffers; one at a time.
let buffers: { state: SharedArrayBuffer; actuator: SharedArrayBuffer } | null = null;
let sitl: { client: SitlBridgeClient; socket: WebSocket } | null = null;
// Profile dynamics (TASK-144): manifests registered by hash and the BET module they run on. The demo stays the
// default; a registered model runs only after a Control Protocol v2 `model.load` names its ID and hash.
const registry = new VehicleRegistry();
let betModule: WebAssembly.Module | null = null;
// TASK-146 limit ratings by manifest SHA-256, bound before model.load; a model without ratings checks none.
const ratings = new Map<string, LimitRatings>();
// TASK-148: the location's gravity and origin air, set by environment.set before model.load; without them a model
// flies at standard gravity with a sea-level ISA origin. The model port reads this object when it builds, and the
// Run tab starts a fresh Worker for every run, so one run's environment never reaches the next.
const environment: { gravityMps2?: number; originAir?: { readonly temperatureK: number; readonly pressurePa: number } } = {};
const environmentOptions: ProfileDynamicsOptions = environment;
const groundStarts = new Map<string, GroundStart>();
// TASK-186: the published lattice of a real-terrain run, and how many missing-terrain ticks have been posted.
let terrainPosted = 0;
/** TASK-116: the barometer samples of the current session posted so far. */
let barometerPosted = 0;
type WorkerNotice = CommandResultV2 | WorkerFaultV2 | SitlNotice | { type: "sitl.reject"; message: string }
  | { type: "bet.module.ready"; sha256: string } | { type: "bet.module.reject"; message: string }
  | { type: "contact.module.ready"; sha256: string } | { type: "contact.module.reject"; message: string }
  | { type: "model.registered"; modelId: number; sha256: string } | { type: "model.reject"; message: string }
  | { type: "limits.registered"; sha256: string } | { type: "limits.reject"; message: string }
  | { type: "environment.ready" } | { type: "environment.reject"; message: string }
  | { type: "ground.registered"; sha256: string } | { type: "ground.reject"; message: string }
  | { type: "limits.events"; events: LimitEvent[]; dropped: number }
  | { type: "accident.events"; events: AccidentEvent[]; dropped: number; total: number }
  /** Manual control's stick commands stopped for INPUT_TIMEOUT_MS: the session paused before its next tick (TASK-174). */
  | { type: "sitl.input-stale"; simTimeS: number; staleMs: number }
  | { type: "power.attached" } | { type: "power.reject"; message: string }
  | { type: "terrain.ready"; chunks: number } | { type: "terrain.reject"; message: string }
  | { type: "validity.changes"; changes: { tick: number; simTimeS: number; flags: number }[]; dropped: number }
  | { type: "contact.events"; events: { tick: number; simTimeS: number; code: number; value: number }[]; dropped: number }
  | { type: "terrain.missing"; tick: number; simTimeS: number; northM: number; eastM: number; count: number }
  | { type: "barometer.sample"; tick: number; simTimeS: number; errorPa: number; active: boolean }
  | { type: "recording-v2.armed" } | { type: "recording-v2.reject"; message: string }
  | { type: "scenario.submit"; command: ControlCommand }
  | { type: "scenario.reject"; message: string }
  | { type: "pilot.rejected"; count: number; ageMs: number; wallMs: number; sampleWallMs: number; sampleId: number; expectedEpoch: number;
      sessionEpoch: number; flags: number; valuesValid: boolean };

function createdRequestId(): number {
  return session?.allocateRequestId() ?? 1;
}
function post(event: WorkerNotice): void { postMessage(event); }
function flush(): void {
  session?.drain((event) => {
    binder?.observe(event);
    post(event);
  });
  // TASK-146: limit events leave after the compute batch, as one message.
  const events: LimitEvent[] = [];
  if (session && session.drainLimitEvents(event => events.push(event)) > 0) post({ type: "limits.events", events, dropped: session.limitEventsDropped });
  // TASK-149: accidents, which paused the session on their tick, leave the same way.
  const accidents: AccidentEvent[] = [];
  if (session && session.drainAccidents(event => accidents.push(event)) > 0) {
    post({ type: "accident.events", events: accidents, dropped: session.accidentsDropped, total: session.accidentTotal });
  }
  // TASK-145: changes of the model's validity bits, for the recording's events.validity.
  const changes: { tick: number; simTimeS: number; flags: number }[] = [];
  if (session && session.drainValidityChanges((tick, simTimeS, flags) => changes.push({ tick, simTimeS, flags })) > 0) {
    post({ type: "validity.changes", changes, dropped: session.validityChangesDropped });
  }
  // TASK-187: touchdowns and lift-offs, for the recording's events.contact.
  const contacts: { tick: number; simTimeS: number; code: number; value: number }[] = [];
  if (session && session.drainContactEvents((tick, simTimeS, code, value) => contacts.push({ tick, simTimeS, code, value })) > 0) {
    post({ type: "contact.events", events: contacts, dropped: session.contactEventsDropped });
  }
  // TASK-116: the newest barometer error sample, for the run controller's offset stream; samples between two flushes are superseded.
  const barometer = session?.barometerSample;
  if (barometer && (barometer[0] ?? 0) > barometerPosted) {
    barometerPosted = barometer[0] ?? 0;
    post({ type: "barometer.sample", tick: barometer[1] ?? 0, simTimeS: barometer[2] ?? 0, errorPa: barometer[3] ?? 0, active: barometer[4] === 1 });
  }
  // TASK-186: a tick that found the terrain missing paused the session; say where, once per such tick.
  const missing = session?.terrainMissing;
  if (missing && (missing[TERRAIN_MISSING_COUNT] ?? 0) > terrainPosted) {
    terrainPosted = missing[TERRAIN_MISSING_COUNT] ?? 0;
    post({ type: "terrain.missing", tick: missing[TERRAIN_MISSING_TICK] ?? 0, simTimeS: missing[TERRAIN_MISSING_SIM_S] ?? 0, northM: missing[TERRAIN_MISSING_NORTH] ?? 0, eastM: missing[TERRAIN_MISSING_EAST] ?? 0, count: terrainPosted });
  }
}
/**
 * `terrain.chunks` (TASK-186): the real terrain of a run, built on Main as 129 by 129 posts 4 m apart, staged and published
 * before the run starts and checked under the vehicle every tick. An empty list is a run on the synthetic pad.
 */
function attachTerrain(current: PhysicsSessionV2, value: unknown): number {
  if (current.running) throw new Error("Terrain is loaded before a run starts");
  if (!Array.isArray(value) || value.length > 64) throw new Error("terrain.chunks needs at most 64 chunks");
  const tiles: readonly unknown[] = value;
  if (tiles.length === 0) { current.attachGround(null); return 0; }
  const chunks = new CollisionChunks(RUN_TERRAIN_EPOCH, RUN_CHUNK_RESOLUTION, RUN_CHUNK_SPACING_M);
  for (const tile of tiles) {
    if (typeof tile !== "object" || tile === null || !("northIndex" in tile) || !("eastIndex" in tile) || !("downM" in tile) ||
      typeof tile.northIndex !== "number" || typeof tile.eastIndex !== "number" || !(tile.downM instanceof Float64Array)) throw new Error("Invalid terrain chunk");
    if (!chunks.stage({ version: 1, epoch: RUN_TERRAIN_EPOCH, revision: 0, resolution: RUN_CHUNK_RESOLUTION, spacingM: RUN_CHUNK_SPACING_M,
      northIndex: tile.northIndex, eastIndex: tile.eastIndex, downM: tile.downM })) throw new Error(`Terrain chunk ${tile.northIndex}, ${tile.eastIndex} was refused: a repeat, a seam that does not match, or over the byte cap`);
  }
  if (!chunks.publishAtTick(RUN_TERRAIN_EPOCH, 0)) throw new Error("The terrain could not be published");
  current.attachGround(chunks);
  terrainPosted = 0;
  return tiles.length;
}
function isTyped<T extends string>(data: unknown, type: T): data is { type: T } & Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data) && "type" in data && data.type === type;
}
function armScenario(value: unknown): void {
  try {
    const scenario = parseScenario(value);
    haltPosted = false;
    binder = new ScenarioBinder(scenario, () => createdRequestId());
  } catch (error) {
    binder = null;
    post({ type: "scenario.reject", message: error instanceof Error ? error.message : "Invalid scenario" });
  }
}
function isRecordingArm(data: unknown): data is { type: "recording.arm"; queue: SharedArrayBuffer } {
  return typeof data === "object" && data !== null && "type" in data && data.type === "recording.arm" && "queue" in data && data.queue instanceof SharedArrayBuffer;
}
function isRecordingStop(data: unknown): boolean {
  return typeof data === "object" && data !== null && "type" in data && data.type === "recording.stop";
}
function armRecording(queue: SharedArrayBuffer): void {
  if (!session) return;
  const handoff = new RecordingHandoff(queue);
  const record = new AarRecord();
  const pilot = new Float64Array(4);
  let notedLost = 0;
  recorder = { handoff, record };
  session.setRecorder((sample) => {
    const active = recorder;
    if (!active) return;
    for (let i = 0; i < 4; i++) pilot[i] = sample.pilot[i] ?? 0;
    const lost = (active.handoff.lost - notedLost) >>> 0;
    if (!active.record.encode(sample.state, pilot, sample.sensor, sample.actuator, 0, lost, false)) return;
    if (active.handoff.push(active.record.words)) notedLost = active.handoff.lost;
  });
}
/**
 * TASK-162: arms recorder v2's producer on the session's record hook. It replaces a TASK-076 recorder; the flight
 * queues keep one consumer, and a full recording queue drops and counts rows instead of waiting.
 */
function armRecordingV2(data: Record<string, unknown>): void {
  if (!session) throw new Error("The physics session is not initialized");
  if (!(data.queue instanceof SharedArrayBuffer) || !isProducerPlan(data.plan)) throw new Error("Invalid recording-v2.arm message");
  if (data.plan.physicsHz !== session.hz) throw new Error(`The recording plan is for ${data.plan.physicsHz} Hz; the session runs ${session.hz} Hz`);
  const producer = new RecordingProducerV2(data.queue, data.plan);
  recorder = null;
  session.setRecorder(sample => producer.record(sample));
  post({ type: "recording-v2.armed" });
}
function isBinaryMessage<T extends string>(data: unknown, type: T): data is { type: T; bytes: Uint8Array; sha256: string } {
  return typeof data === "object" && data !== null && "type" in data && data.type === type && "bytes" in data &&
    data.bytes instanceof Uint8Array && "sha256" in data && typeof data.sha256 === "string" && /^[a-f0-9]{64}$/.test(data.sha256);
}
function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2, "0")).join("");
}
/** Cold: verifies the BET module's hash, compiles it and checks it imports nothing and exports the drive and bus. */
async function loadBetModule(bytes: Uint8Array, sha256: string): Promise<void> {
  const copy = new Uint8Array(bytes);
  if (hex(await crypto.subtle.digest("SHA-256", copy)) !== sha256) throw new Error("BET module SHA-256 mismatch");
  const module = await WebAssembly.compile(copy);
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error("The BET module must not import host functions");
  const names = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
  for (const name of ["bet_bound_step_v2", "bet_bus_step", "bet_body_step"]) if (!names.has(name)) throw new Error(`The BET module lacks ${name}`);
  betModule = module;
}
function uint(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}
/**
 * `sitl.connect`: opens the run's bridge (port and token from Main, which got them from the launcher) and steps the
 * session on its servo frames. The session must be in sitl-lockstep with the profile model loaded and started.
 */
function connectSitl(data: Record<string, unknown>): void {
  const current = session;
  if (!current || !buffers) throw new Error("The physics session is not initialized");
  if (current.mode !== "sitl-lockstep") throw new Error("Configure the session for sitl-lockstep before connecting SITL");
  if (sitl) throw new Error("An integrated SITL session is already connected");
  const port = uint(data.port, 65535), bridgeEpoch = uint(data.bridgeEpoch, 0xffffffff), motorMapId = uint(data.motorMapId, 0xffffffff);
  const channels: unknown = data.motorChannels;
  if (port === null || bridgeEpoch === null || motorMapId === null || typeof data.token !== "string" || typeof data.speedup !== "number" ||
    !Array.isArray(channels) || channels.length < 1 || channels.length > 16) throw new Error("Invalid sitl.connect message");
  const motorChannels = channels.map(channel => uint(channel, 16));
  if (motorChannels.some(channel => channel === null || channel === 0)) throw new Error("Invalid motor channels");
  const [url, protocols] = bridgeSocketArguments(port, data.token);
  const socket = new WebSocket(url, protocols);
  socket.binaryType = "arraybuffer";
  const client = new SitlBridgeClient(buffers.state, buffers.actuator, {
    bridgeEpoch, motorChannels: motorChannels.map(Number), motorMapId, sessionEpoch: current.currentEpoch, speedup: data.speedup,
    // TASK-093: a weather.set's wind goes to SITL as velocity_wind.
    wind: current.wind,
    // TASK-168: what the link holds back or drops.
    delivery: current.delivery,
  }, {
    pump: () => { current.pump(); reportFault(); },
    flush,
    post,
    send: record => { if (socket.readyState === WebSocket.OPEN) socket.send(record); },
    close: reason => socket.close(1000, reason.slice(0, 120)),
    nowMs: () => performance.now(),
    inputStale: staleMs => {
      current.holdForInput();
      client.setPaused(true);
      post({ type: "sitl.input-stale", simTimeS: client.link.state.simTimeS, staleMs });
    },
  });
  sitl = { client, socket };
  current.attachDelivery(true);
  socket.onopen = () => client.opened();
  socket.onmessage = event => {
    if (!(event.data instanceof ArrayBuffer)) return;
    try {
      client.receive(new Uint8Array(event.data));
    } catch (error) {
      stepThrew(error);
    }
  };
  socket.onclose = event => {
    client.closed(event.code, event.reason);
    if (sitl?.client === client) { sitl = null; current.attachDelivery(false); }
  };
}
function handleSitl(data: unknown): boolean {
  if (isTyped(data, "sitl.connect")) {
    try { connectSitl(data); } catch (error) { post({ type: "sitl.reject", message: error instanceof Error ? error.message : "Invalid sitl.connect" }); }
    return true;
  }
  if (isTyped(data, "sitl.mavlink.send")) {
    if (!(data.bytes instanceof Uint8Array) || !sitl?.client.sendMavlink(data.bytes)) post({ type: "sitl.reject", message: "No open SITL session for MAVLink" });
    return true;
  }
  if (isTyped(data, "sitl.manual")) {
    sitl?.client.setManual(data.active === true);
    return true;
  }
  if (isTyped(data, "sitl.disconnect")) {
    sitl?.client.close();
    return true;
  }
  return false;
}
function isScenarioArm(data: unknown): data is { type: "scenario.arm"; scenario: unknown } {
  return typeof data === "object" && data !== null && "type" in data && data.type === "scenario.arm" && "scenario" in data;
}

/** The fault Main last heard of: each session fault reaches it once, from a SITL frame's step as from this thread's own pump. */
let reportedFault = "";
function reportFault(): void {
  const fault = session?.fault ?? "";
  if (fault === reportedFault) return;
  reportedFault = fault;
  if (fault !== "") post({ type: 'fault-v2', protocolVersion: 2, message: fault });
}
/** A step that throws is a fault with its reason. Left alone it would end the handler, and ArduPilot would wait for that frame's reply forever. */
function stepThrew(error: unknown): void {
  console.error(error);
  session?.failFromHost(`The physics step threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  reportFault();
}
/** Steps the session, then sends results after the compute batch, never inside a step. */
function pump(): void {
  timer = undefined;
  if (!session) return;
  let delay: number;
  try {
    delay = session.pump();
  } catch (error) {
    stepThrew(error);
    return;
  }
  // A SITL frame that waited while the session was paused is answered once a resumed pump has stepped it.
  sitl?.client.answer();
  // An accident pauses the session inside the pump (TASK-149, TASK-156).
  sitl?.client.setPaused(!session.running);
  flush();
  const rejection = session.pilotRejection;
  if (rejection.pending) {
    // Diagnostics (TASK-073): why the armed latch blocked; posted after the compute batch, never from the step.
    rejection.pending = false;
    post({ type: "pilot.rejected", count: rejection.count, ageMs: rejection.ageMs, wallMs: rejection.wallMs, sampleWallMs: rejection.sampleWallMs,
      sampleId: rejection.sampleId, expectedEpoch: rejection.expectedEpoch, sessionEpoch: rejection.sessionEpoch, flags: rejection.flags,
      valuesValid: rejection.valuesValid });
  }
  reportFault();
  if (!session.fault && delay >= 0) timer = setTimeout(pump, delay);
}
function schedule(): void {
  if (session?.running && timer === undefined && !session.fault) timer = setTimeout(pump, 0);
  if (!session?.running && timer !== undefined) { clearTimeout(timer); timer = undefined; }
}

addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (!session) {
    if (!isWorkerInitV2(data)) { post({ type: 'fault-v2', protocolVersion: 2, message: 'Expected init-v2' }); return; }
    try {
      barometerPosted = 0;
      session = new PhysicsSessionV2(data, clock, undefined, createSessionFaultPort(),
        profileModelPort(registry, () => betModule, environmentOptions, sha256 => ratings.get(sha256) ?? null, sha256 => {
          const start = groundStarts.get(sha256);
          return start ? { initialGround: start, initialStateOfCharge: start.stateOfCharge } : null;
        }));
      const created = session;
      created.setBeforeTick((tick) => {
        if (!binder) return;
        for (;;) {
          const command = binder.poll(tickToNumber(tick), false, created.currentEpoch);
          if (binder.halted && !haltPosted) {
            haltPosted = true;
            post({ type: "scenario.reject", message: "Scenario missed a simulation tick" });
            return;
          }
          if (!command) return;
          post({ type: "scenario.submit", command });
          created.handle(command);
        }
      });
      buffers = { state: data.stateBuffer, actuator: data.actuatorBuffer };
      post(session.readyEvent());
    } catch (error) {
      post({ type: 'fault-v2', protocolVersion: 2, message: error instanceof Error ? error.message : 'Initialization failed' });
    }
    return;
  }
  const current = session;
  if (isBinaryMessage(data, "bet.module")) {
    loadBetModule(data.bytes, data.sha256).then(() => post({ type: "bet.module.ready", sha256: data.sha256 }),
      (error: unknown) => post({ type: "bet.module.reject", message: error instanceof Error ? error.message : "Invalid BET module" }));
    return;
  }
  // TASK-095: the contact module the profile vehicles stand on; GroundContact.initialize checks it against its build manifest.
  if (typeof data === "object" && data !== null && "type" in data && data.type === "contact.module" && "bytes" in data &&
    data.bytes instanceof Uint8Array && "manifest" in data) {
    const bytes = new Uint8Array(data.bytes), manifest: unknown = data.manifest;
    const sha256 = typeof manifest === "object" && manifest !== null && "sha256" in manifest ? String(manifest.sha256) : "";
    GroundContact.initialize(bytes, manifest).then(() => post({ type: "contact.module.ready", sha256 }),
      (error: unknown) => post({ type: "contact.module.reject", message: error instanceof Error ? error.message : "Invalid contact module" }));
    return;
  }
  if (isBinaryMessage(data, "model.register")) {
    registry.register(data.bytes, data.sha256).then(record => post({ type: "model.registered", modelId: record.manifest.modelId, sha256: record.sha256 }),
      (error: unknown) => post({ type: "model.reject", message: error instanceof Error ? error.message : "Invalid model" }));
    return;
  }
  if (isTyped(data, "limits.register")) {
    try {
      const sha256 = data.sha256;
      if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("limits.register needs a manifest SHA-256");
      ratings.set(sha256, parseLimitRatings(data.ratings));
      post({ type: "limits.registered", sha256 });
    } catch (error) {
      post({ type: "limits.reject", message: error instanceof Error ? error.message : "Invalid limit ratings" });
    }
    return;
  }
  if (isTyped(data, "environment.set")) {
    try {
      const gravity = data.gravityMps2, air = data.originAir;
      if (typeof gravity !== "number" || !Number.isFinite(gravity) || gravity < 9.7 || gravity > 9.9) throw new Error("environment.set needs a gravity of 9.7 to 9.9 m/s²");
      if (typeof air !== "object" || air === null || !("temperatureK" in air) || !("pressurePa" in air) ||
        typeof air.temperatureK !== "number" || typeof air.pressurePa !== "number") throw new Error("environment.set needs the origin air's temperature and pressure");
      // The atmosphere envelope, as the model will check it again.
      atmosphereFromState({ temperatureK: air.temperatureK, pressurePa: air.pressurePa });
      environment.gravityMps2 = gravity;
      environment.originAir = { temperatureK: air.temperatureK, pressurePa: air.pressurePa };
      post({ type: "environment.ready" });
    } catch (error) {
      post({ type: "environment.reject", message: error instanceof Error ? error.message : "Invalid environment" });
    }
    return;
  }
  // TASK-172: where the vehicle stands, and its charge, at the start tick of the load that follows.
  if (isTyped(data, "ground.register")) {
    try {
      const sha256 = data.sha256;
      if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("ground.register needs a manifest SHA-256");
      groundStarts.set(sha256, parseGroundStart(data.ground));
      post({ type: "ground.registered", sha256 });
    } catch (error) {
      post({ type: "ground.reject", message: error instanceof Error ? error.message : "Invalid ground start" });
    }
    return;
  }
  if (isTyped(data, "terrain.chunks")) {
    try { post({ type: "terrain.ready", chunks: attachTerrain(current, data.tiles) }); }
    catch (error) { post({ type: "terrain.reject", message: error instanceof Error ? error.message : "Invalid terrain" }); }
    return;
  }
  if (isTyped(data, "power.attach")) {
    try {
      validatePowerChannelV1(data.buffer);
      current.attachPowerChannel(data.buffer);
      post({ type: "power.attached" });
    } catch (error) {
      post({ type: "power.reject", message: error instanceof Error ? error.message : "Invalid power channel" });
    }
    return;
  }
  if (handleSitl(data)) return;
  if (isScenarioArm(data)) {
    armScenario(data.scenario);
    return;
  }
  if (isRecordingArm(data)) {
    armRecording(data.queue);
    return;
  }
  if (isTyped(data, "recording-v2.arm")) {
    try { armRecordingV2(data); } catch (error) { post({ type: "recording-v2.reject", message: error instanceof Error ? error.message : "Invalid recording-v2.arm" }); }
    return;
  }
  if (isRecordingStop(data) || isTyped(data, "recording-v2.stop")) {
    recorder = null;
    current.setRecorder(null);
    return;
  }
  current.handle(data);
  // sim.pause and sim.start pause and resume the run's clock (TASK-156).
  sitl?.client.setPaused(!current.running);
  flush();
  // A model load completes asynchronously; deliver its final result when it settles.
  void current.settled().then(() => { flush(); schedule(); });
  schedule();
  if (current.disposed) { clearTimeout(timer); sitl?.client.close(); close(); }
});
