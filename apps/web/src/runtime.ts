import { RecorderHost } from "@mirage/aar/recorder-host";
import demoDynamicsSource from "../../../packages/physics/src/demo-dynamics.ts?raw";
import { CommandLedger, type CommandPayload } from "./instructor/commands";
import {
  parseControlCommandV2,
  isPhysicsHz,
  type ControlCommandV2,
} from "@mirage/protocol";
import {
  ControlFlag,
  PilotWriterV2,
  PowerReaderV1,
  createPowerChannelV1,
  RuntimeFlagV2,
  StateReaderV2,
  UNKNOWN_U32,
  VehicleFlagV2,
  createSharedMemoryV2,
  createSpscQueue,
  newFlightStateV2,
  newHeaderSnapshotV2,
  newInput,
  newPilotInputV2,
  parseWorkerEventV2,
  tickToNumber,
  wallNow,
  type ClockModeV2,
  type FlightStateV2,
  type HistoryReadV2,
  type PhysicsHz,
  type WorkerInitV2,
} from "@mirage/protocol";
import { EkfMonitor } from "@mirage/autopilot/ekf-status";
import { newMavFrame, type MavFrame } from "@mirage/mavlink/codec";
import { GamepadAdapter, type GamepadCalibration } from "@mirage/input";
import { ScriptedPilot, newStickCommand, type FlightPlan } from "@mirage/input/scripted-flight";
import { applyAutopilotTelemetry } from "./hud/telemetry";
import { EVENT_LOG_SIZE, parseLimitEventsMessage } from "./run/PowerPanel";
import type { LimitEvent } from "@mirage/physics/limit-monitor";

// Main-thread runtime on ABI v2 and Control Protocol v2 (TASK-085). Main owns
// the pilot mailbox and creates every SAB; the physics Worker owns the state
// ring. Lifecycle state is read from the header's runtime flags rather than
// inferred from ACK order, so late, duplicate, or out-of-order ACKs cannot
// desynchronize the UI.

export interface ViewStats {
  ready: boolean;
  /** The physics session faulted; the Worker still answers and Reset starts a fault-free epoch. */
  faulted: boolean;
  running: boolean;
  armed: boolean;
  pending: boolean;
  tick: number;
  simTime: number;
  altitude: number;
  speed: number;
  voltage: number;
  flags: number;
  hz: number;
  targetHz: number;
  epoch: number;
  fps: number;
  dropped: number;
  overruns: number;
  input: { roll: number; pitch: number; yaw: number; throttle: number };
  device: string;
  inputStatus: string;
  selectedDevice: number | null;
  notice: string;
}
export type LifecycleCommand = "start" | "pause" | "reset";
/** Rearming requires throttle at or below 5% (SPECS_SHARED_MEMORY, pilot mailbox v2). */
const REARM_THROTTLE_MAX = 0.05;
const COMMAND_TYPE = {
  start: "sim.start",
  pause: "sim.pause",
  reset: "sim.reset",
} as const;

export class SimulationRuntime {
  recording: RecorderHost | null = null;
  async startRecording(): Promise<void> {
    if (this.recording) {
      this.worker.postMessage({ type: "recording.arm", queue: this.recording.queue });
      return;
    }
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(demoDynamicsSource),
        ),
      ),
      (x) => x.toString(16).padStart(2, "0"),
    ).join("");
    if (this.disposed) throw new Error("Session closed");
    if (!isPhysicsHz(this.header.physicsHz))
      throw new Error("Invalid recording physics rate");
    const recordHz = this.header.physicsHz;
    const maxRecords = Math.floor((32 * 1024 * 1024 - 8192) / 512);
    this.recording = new RecorderHost({
      formatVersion: 1,
      recordBytes: 512,
      modelSha256: hash,
      firmwareSha256: null,
      seed: 0,
      physicsHz: recordHz,
      recordHz,
      durationS: Math.max(1, Math.min(1800, Math.floor(maxRecords / recordHz))),
      clock: "simulation",
      source: "producer",
    });
    this.worker.postMessage({ type: "recording.arm", queue: this.recording.queue });
  }
  stopRecording(): void {
    this.worker.postMessage({ type: "recording.stop" });
  }
  readonly commands = new CommandLedger();
  readonly stateBuffer = createSharedMemoryV2(400);
  readonly sensorBuffer = createSpscQueue("sensor");
  readonly actuatorBuffer = createSpscQueue("actuator");
  readonly reader = new StateReaderV2(this.stateBuffer);
  /** TASK-146 power telemetry v1, written by the physics Worker after every step. */
  readonly powerBuffer = createPowerChannelV1();
  readonly power = new PowerReaderV1(this.powerBuffer);
  /** The latest limit events, oldest first, at most `EVENT_LOG_SIZE`. */
  private limitLog: readonly LimitEvent[] = [];
  /** Stable accessor for the power panel. */
  readonly limitEvents = (): readonly LimitEvent[] => this.limitLog;
  readonly pilotWriter = new PilotWriterV2(this.stateBuffer);
  readonly header = newHeaderSnapshotV2();
  readonly gamepad = new GamepadAdapter();
  readonly current: FlightStateV2 = newFlightStateV2();
  readonly previous: FlightStateV2 = newFlightStateV2();
  history: HistoryReadV2 = "none";
  /** Calibrated stick sample in [-1,1]/[0,1] with Connected/Armed flags. */
  readonly input = newInput();
  private readonly pilot = newPilotInputV2();
  readonly worker = new Worker(
    new URL("./physics.worker.ts", import.meta.url),
    { type: "module", name: "mirage-physics" },
  );
  source: "demo" | "usb" | "script" = "demo";
  /** Last `pilot.rejected` diagnostic from the Worker (TASK-073), or null. */
  pilotRejection: PilotRejectionNotice | null = null;
  demoThrottle = 0;
  /** TASK-073 scripted flight: a closed-loop pilot that only moves the sticks. */
  scripted: ScriptedPilot | null = null;
  private readonly scriptedStick = newStickCommand();
  ready = false;
  armed = false;
  pending = false;
  notice = "";
  /** Session fault message shown until a new epoch clears the header Fault flag. */
  private faultNotice = "";
  /** The published state showed the session armed for the current arm request. */
  private armConfirmed = false;
  private deviceGeneration = 0;
  private readonly ekfFrame: MavFrame = newMavFrame();
  private ekfMonitor = new EkfMonitor(1, 1, 0, 1000);
  private lastAutopilotMode = UNKNOWN_U32;
  private autopilotActive = false;
  private adapterGeneration = 0;
  private requestId = 0;
  private pendingId = -2;
  private raf = 0;
  private lastReport = performance.now();
  private lastTick = 0;
  private frames = 0;
  private disposed = false;
  private readonly report: (stats: ViewStats) => void;

  constructor(report: (stats: ViewStats) => void) {
    this.report = report;
    this.worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      const command = scenarioSubmit(data);
      if (command) {
        this.requestId = Math.max(this.requestId, command.requestId);
        this.commands.track(command);
        return;
      }
      const rejection = scenarioRejection(data);
      if (rejection) {
        this.notice = rejection;
        return;
      }
      const limits = parseLimitEventsMessage(data);
      if (limits) {
        this.limitLog = [...this.limitLog, ...limits.events].slice(-EVENT_LOG_SIZE);
        return;
      }
      if (isPilotRejection(data)) {
        // Diagnostics (TASK-073): the Worker blocked the armed latch on an invalid pilot sample.
        this.pilotRejection = data;
        Reflect.set(globalThis, "__miragePilotRejection", data); // read by the G3 capture's flight log
        console.warn("Pilot sample rejected; armed latch blocked", JSON.stringify(data));
        return;
      }
      this.onWorkerEvent(data);
    };
    this.worker.onerror = (event) =>
      this.fail(event.message || "Physics worker failed");
    const init: WorkerInitV2 = {
      type: "init-v2",
      protocolVersion: 2,
      stateBuffer: this.stateBuffer,
      sensorBuffer: this.sensorBuffer,
      actuatorBuffer: this.actuatorBuffer,
    };
    this.worker.postMessage(init);
    this.worker.postMessage({ type: "power.attach", buffer: this.powerBuffer });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.raf = requestAnimationFrame(this.frame);
  }
  get running(): boolean {
    return (this.header.runtimeFlags & RuntimeFlagV2.Running) !== 0;
  }
  get faulted(): boolean {
    return (this.header.runtimeFlags & RuntimeFlagV2.Fault) !== 0;
  }
  get epoch(): number {
    return this.header.sessionEpoch;
  }

  private onWorkerEvent(data: unknown): void {
    const event = parseWorkerEventV2(data);
    if (!event) return; // unknown messages are ignored, never trusted
    this.reader.readHeader(this.header);
    this.commands.receive(event, this.epoch);
    switch (event.type) {
      case "ready-v2":
        this.ready = true;
        return;
      case "fault-v2":
        // Before ready-v2 the Worker never initialized. Afterwards only the
        // session faulted: the Worker still answers, so Reset stays available.
        if (this.ready) this.sessionFault(event.message);
        else this.fail(event.message);
        return;
      case "ack-v2":
        if (event.requestId === this.pendingId && event.status === "applied")
          this.pending = false;
        return;
      case "reject-v2":
        if (event.requestId === this.pendingId) {
          this.pending = false;
          this.notice = event.message;
        }
        return;
      default: {
        const never: never = event;
        return never;
      }
    }
  }
  private fail(message: string) {
    this.commands.cancelAll(message);
    this.notice = message;
    this.ready = this.armed = this.pending = false;
  }
  /** Queued commands keep their own final results; the Worker cancels them on Reset. */
  private sessionFault(message: string) {
    this.notice = this.faultNotice = message;
    this.armed = false;
  }
  private send(
    type: (typeof COMMAND_TYPE)[LifecycleCommand] | "sim.configure",
    extra: Record<string, unknown> = {},
  ): void {
    this.pending = true;
    const command = this.submitControl({ type, ...extra });
    this.pendingId = command?.requestId ?? -2;
    if (!command) this.pending = false;
  }
  nextTick(): { lo: number; hi: number } {
    const lo = (this.current.tickId.lo + 1) >>> 0;
    return { lo, hi: this.current.tickId.hi + (lo === 0 ? 1 : 0) };
  }
  submitControl(
    payload: CommandPayload | Record<string, unknown>,
  ): ControlCommandV2 | null {
    if (!this.ready) return null;
    this.reader.readHeader(this.header);
    const value = {
      ...payload,
      protocolVersion: 2,
      requestId: ++this.requestId,
      expectedEpoch: this.epoch,
    };
    const parsed = parseControlCommandV2(value);
    if (!parsed.ok) {
      this.notice = parsed.message;
      return null;
    }
    this.commands.track(parsed.command);
    this.worker.postMessage(parsed.command);
    return parsed.command;
  }

  /** Loads a scenario into the physics Worker. Faults apply only after its ACK. */
  armScenario(scenario: unknown): void {
    if (!this.ready) return;
    this.worker.postMessage({ type: "scenario.arm", scenario });
  }
  command(command: LifecycleCommand): void {
    if (!this.ready || this.pending) return;
    this.disarm();
    this.send(COMMAND_TYPE[command], command === "reset" ? { seed: 0 } : {});
  }
  /** Rate/clock changes require a paused, disarmed session and start a new epoch. */
  configureRate(hz: PhysicsHz, clockMode: ClockModeV2 = "interactive"): void {
    if (!this.ready || this.pending) return;
    this.disarm();
    this.send("sim.configure", { hz, clockMode });
  }
  setArmed(value: boolean): void {
    if (!value) {
      this.disarm();
      return;
    }
    if (!this.running || this.pending) return;
    if (this.input.throttle > REARM_THROTTLE_MAX) {
      this.notice = "Lower throttle to 0% before arming.";
      return;
    }
    if (this.source === "usb" && this.gamepad.status !== "connected") {
      this.notice = "Connect a USB transmitter and check its axes.";
      return;
    }
    this.notice = "";
    this.armed = true;
    this.armConfirmed = false;
  }
  disarm(): void {
    this.armed = false;
    this.input.flags &= ~ControlFlag.Armed;
    this.input.wallTimeMs = wallNow();
    this.publishPilot();
  }
  /** Hands the sticks to a scripted flight plan; it arms itself at zero throttle once the session runs. */
  useScriptedFlight(plan: FlightPlan): void {
    this.disarm();
    this.scripted = new ScriptedPilot(plan);
    this.source = "script";
    this.newDevice();
  }
  selectSource(source: "demo" | "usb") {
    this.disarm();
    this.scripted = null;
    this.source = source;
    this.newDevice();
  }
  selectDevice(index: number | null) {
    this.disarm();
    this.gamepad.selectDevice(index);
  }
  configure(calibration: GamepadCalibration) {
    this.disarm();
    this.gamepad.calibration = calibration;
  }
  /** A new device identity: the Worker drops any arm latch, and rearming must be explicit. */
  private newDevice(): void {
    this.deviceGeneration = (this.deviceGeneration + 1) >>> 0;
    this.armed = false;
  }
  /** Drops HUD autopilot diagnostics. A serial grant never admits browser READY. */
  clearAutopilotStatus(): void {
    this.ekfMonitor = new EkfMonitor(1, 1, this.current.epoch, 1000);
    this.lastAutopilotMode = UNKNOWN_U32;
    this.autopilotActive = false;
    applyAutopilotTelemetry(this.current, null);
  }
  /**
   * Copies one decoded serial.frame into the preallocated EkfMonitor scratch.
   * Returns false for malformed messages and for frames the bound identity rejects.
   */
  ingestSerialFrame(data: unknown, receivedMs = wallNow()): boolean {
    const frame = readSerialFrame(data);
    if (!frame) return false;
    this.bindAutopilotEpoch();
    const scratch = this.ekfFrame;
    scratch.id = frame.id;
    scratch.sequence = frame.sequence;
    scratch.systemId = frame.systemId;
    scratch.componentId = frame.componentId;
    scratch.payload.fill(0);
    scratch.payload.set(frame.payload);
    if (!this.ekfMonitor.ingest(scratch, receivedMs)) return false;
    this.autopilotActive = true;
    const status = this.ekfMonitor.snapshot(receivedMs);
    if (status.mode !== null) this.lastAutopilotMode = status.mode;
    this.syncAutopilotTelemetry(receivedMs);
    return true;
  }
  private bindAutopilotEpoch(): void {
    const epoch = this.current.epoch;
    if ((epoch >>> 0) !== epoch || this.ekfMonitor.epoch === epoch) return;
    this.ekfMonitor = new EkfMonitor(1, 1, epoch, 1000);
    this.lastAutopilotMode = UNKNOWN_U32;
    this.autopilotActive = false;
  }
  private syncAutopilotTelemetry(nowMs = wallNow()): void {
    applyAutopilotTelemetry(
      this.current,
      this.autopilotActive ? this.ekfMonitor.snapshot(nowMs) : null,
      this.lastAutopilotMode,
    );
  }
  /**
   * The session owns the arm latch: stale input disarms it and rearming is explicit
   * (SPECS_SHARED_MEMORY, pilot mailbox v2). Withdraw an arm request the session dropped,
   * or can no longer grant because the throttle rose before it armed, so the UI never
   * shows armed motors that the session has disarmed.
   */
  private followSessionArming(): void {
    const s = this.current;
    if (!this.armed || s.epoch !== this.epoch) return;
    if ((s.vehicleFlags & VehicleFlagV2.Armed) !== 0) {
      this.armConfirmed = true;
      return;
    }
    if (this.armConfirmed) {
      this.notice = "The physics session disarmed the motors after stale or interrupted input. Lower the throttle and arm again.";
    } else if (this.input.throttle > REARM_THROTTLE_MAX) {
      this.notice = "The physics session did not arm before the throttle rose above 5%. Lower the throttle and arm again.";
    } else {
      return; // the session has not seen this request yet
    }
    this.armConfirmed = false;
    this.disarm();
  }
  private publishPilot(): void {
    const p = this.pilot,
      i = this.input;
    p.expectedEpoch = this.header.sessionEpoch;
    p.sampledWallTimeMs = i.wallTimeMs;
    p.roll = i.roll;
    p.pitch = i.pitch;
    p.yaw = i.yaw;
    p.throttle = i.throttle;
    p.flags = i.flags;
    p.calibratedModeSlot =
      this.source === "usb" && this.gamepad.calibratedModeSlot >= 0
        ? this.gamepad.calibratedModeSlot
        : UNKNOWN_U32;
    p.requestedMode = UNKNOWN_U32;
    p.deviceGeneration = this.deviceGeneration;
    this.pilotWriter.publish(p);
  }
  private onVisibility = () => {
    if (!document.hidden) return;
    this.disarm();
    // A pending start ACK can arrive after visibilitychange; queue the pause regardless.
    if (this.ready) this.send("sim.pause");
  };
  private frame = (now: number) => {
    if (this.disposed) return;
    this.reader.readHeader(this.header);
    this.commands.epochChanged(this.epoch);
    if (this.faultNotice !== "" && !this.faulted) {
      // A new epoch cleared the session fault.
      if (this.notice === this.faultNotice) this.notice = "";
      this.faultNotice = "";
    }
    if (this.source === "usb") {
      this.gamepad.poll(this.input, wallNow(), this.armed);
      if (this.gamepad.generation !== this.adapterGeneration) {
        this.adapterGeneration = this.gamepad.generation;
        this.newDevice();
      }
      if (this.gamepad.status !== "connected") this.armed = false;
      if (!this.armed) this.input.flags &= ~ControlFlag.Armed;
    } else if (this.source === "script" && this.scripted) {
      const stick = this.scriptedStick;
      if (this.running) this.scripted.update(this.current, stick);
      else { stick.roll = stick.pitch = stick.yaw = stick.throttle = 0; stick.arm = false; }
      this.input.roll = stick.roll;
      this.input.pitch = stick.pitch;
      this.input.yaw = stick.yaw;
      this.input.throttle = stick.throttle;
      if (stick.arm && !this.armed && this.running && stick.throttle <= 0.05) this.armed = true;
      if (!stick.arm) this.armed = false;
      this.input.flags = ControlFlag.Connected | (this.armed ? ControlFlag.Armed : 0);
      this.input.wallTimeMs = wallNow();
    } else {
      this.input.roll = this.input.pitch = this.input.yaw = 0;
      this.input.throttle = this.demoThrottle;
      this.input.flags =
        ControlFlag.Connected | (this.armed ? ControlFlag.Armed : 0);
      this.input.wallTimeMs = wallNow();
    }
    if (!this.running) this.armed = false;
    this.publishPilot();
    const read = this.reader.latestPair(this.current, this.previous);
    if (read !== "none") {
      this.history = read;
    }
    this.followSessionArming();
    this.bindAutopilotEpoch();
    this.syncAutopilotTelemetry(wallNow());
    this.frames++;
    const elapsed = now - this.lastReport;
    if (elapsed >= 150) {
      const s = this.current,
        tick = tickToNumber(s.tickId);
      this.report({
        ready: this.ready,
        faulted: this.faulted,
        running: this.running,
        armed: this.armed,
        pending: this.pending,
        tick,
        simTime: s.simTimeS,
        altitude: -s.downM,
        speed: Math.hypot(s.vnMps, s.veMps, s.vdMps),
        voltage: s.batteryVoltage,
        flags: s.vehicleFlags,
        hz:
          tick >= this.lastTick ? ((tick - this.lastTick) * 1000) / elapsed : 0,
        targetHz: this.header.physicsHz,
        epoch: this.header.sessionEpoch,
        fps: (this.frames * 1000) / elapsed,
        dropped: this.header.droppedSteps,
        overruns: this.header.overruns,
        input: {
          roll: this.input.roll,
          pitch: this.input.pitch,
          yaw: this.input.yaw,
          throttle: this.input.throttle,
        },
        device: this.gamepad.deviceName,
        inputStatus: this.gamepad.status,
        selectedDevice: this.gamepad.selectedIndex,
        notice: this.notice,
      });
      this.lastTick = tick;
      this.lastReport = now;
      this.frames = 0;
    }
    this.raf = requestAnimationFrame(this.frame);
  };
  dispose(): void {
    this.disposed = true;
    this.disarm();
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.commands.cancelAll("Session closed");
    this.recording?.close();
    this.worker.terminate();
  }
}

function scenarioSubmit(data: unknown): ControlCommandV2 | null {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "scenario.submit" || !("command" in data)) return null;
  const parsed = parseControlCommandV2(data.command);
  return parsed.ok ? parsed.command : null;
}
export interface PilotRejectionNotice {
  type: "pilot.rejected"; count: number; ageMs: number; wallMs: number; sampleWallMs: number; sampleId: number;
  expectedEpoch: number; sessionEpoch: number; flags: number; valuesValid: boolean;
}
function isPilotRejection(data: unknown): data is PilotRejectionNotice {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "pilot.rejected") return false;
  const numbers = ["count", "ageMs", "wallMs", "sampleWallMs", "sampleId", "expectedEpoch", "sessionEpoch", "flags"] as const;
  return numbers.every(key => key in data && typeof Reflect.get(data, key) === "number") && "valuesValid" in data && typeof data.valuesValid === "boolean";
}
function scenarioRejection(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "scenario.reject" || !("message" in data) || typeof data.message !== "string") return null;
  return data.message;
}

interface SerialFrameMessage {
  id: number;
  systemId: number;
  componentId: number;
  sequence: number;
  payload: Uint8Array;
}

function readSerialFrame(data: unknown): SerialFrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  if (
    !("type" in data) ||
    data.type !== "serial.frame" ||
    !("id" in data) ||
    !("systemId" in data) ||
    !("componentId" in data) ||
    !("sequence" in data) ||
    !("payload" in data)
  )
    return null;
  const id = data.id;
  const systemId = data.systemId;
  const componentId = data.componentId;
  const sequence = data.sequence;
  const payload = data.payload;
  if (
    typeof id !== "number" ||
    typeof systemId !== "number" ||
    typeof componentId !== "number" ||
    typeof sequence !== "number" ||
    !Number.isInteger(id) ||
    !Number.isInteger(systemId) ||
    !Number.isInteger(componentId) ||
    !Number.isInteger(sequence) ||
    !(payload instanceof Uint8Array) ||
    payload.byteLength > 255
  )
    return null;
  return { id, systemId, componentId, sequence, payload };
}
