import { ActuatorFrameCodecV2, ControlFlag, ControlProcessorV2, HeaderV2, INPUT_CLOCK_TOLERANCE_MS, INPUT_TIMEOUT_MS, PilotFlagV2, PilotReaderV2,
  RuntimeFlagV2, SensorFrameCodecV2, SpscConsumer, StateWriterV2, UNKNOWN_U32, VehicleFlagV2, isValidPilotInputV2, newActuatorFrameV2,
  newFlightStateV2, newInput, newPilotInputV2, newSensorFrameV2, tickToNumber, validateSharedMemoryV2, validateSpscQueue,
  type ClockModeV2, type CommandResultV2, type PhysicsHz, type ScheduledCommandV2, type TickId,
  type WorkerInitV2, type FlightState, type FlightStateV2, type PilotInput, type PilotInputV2, type ActuatorFrameV2, type SensorFrameV2 } from '@mirage/protocol';
import { SteppingPolicy, newPumpReport, type StepGate } from './clock-policy.ts';
import { DemoDynamics } from './demo-dynamics.ts';

// Physics Worker session on ABI v2 (TASK-085). Owns the state ring writer,
// pilot mailbox reader, actuator queue consumer, Control Protocol v2
// processor, stepping policy, and the demo dynamics. The Worker module is a
// thin message adapter around this class so the logic runs in Node tests.
// After construction the per-tick path allocates nothing.

/** Session registry key of the built-in demo quad. */
export const DEMO_MODEL_ID = 1;
export const DEMO_ROTOR_COUNT = 4;
/** Rearming requires throttle at or below 5% (SPECS_SHARED_MEMORY, pilot mailbox v2). */
export const REARM_THROTTLE_MAX = 0.05;
const STANDARD_GRAVITY_MPS2 = 9.80665;
/**
 * ISA troposphere (US Standard Atmosphere 1976): p = p0 (1 - L h / T0)^(g M / (R L)),
 * L/T0 = 0.0065/288.15 = 2.25577e-5 1/m, exponent 5.25588. Valid 0..11 km; the
 * demo field elevation is taken as mean sea level. Truth only, not a sensor.
 */
const ISA_SEA_LEVEL_PA = 101325, ISA_LAPSE_OVER_T0 = 2.25577e-5, ISA_EXPONENT = 5.25588;
export function isaPressurePa(altitudeM: number): number {
  const ratio = Math.max(0, 1 - ISA_LAPSE_OVER_T0 * Math.min(11000, altitudeM));
  return ISA_SEA_LEVEL_PA * ratio ** ISA_EXPONENT;
}

export interface SessionClock {
  /** Monotonic milliseconds (performance.now). */
  monotonicMs(): number;
  /** Absolute wall milliseconds shared with Main (performance.timeOrigin + performance.now). */
  wallMs(): number;
}

/** Arm latch states; see `evaluatePilot`. */
type ArmLatch = 'disarmed' | 'armed' | 'blocked';

/** Preallocated EW step context. The session fills it; the port must not allocate. */
export interface SessionFaultContext {
  dtS: number;
  simTimeS: number;
  northM: number;
  eastM: number;
  downM: number;
}
/**
 * Production fault registry. Weather and model loads stay outside this port.
 * `apply` runs at the tick boundary and must not allocate.
 */
export interface SessionRecordSample {
  state: FlightStateV2;
  pilot: Float64Array;
  actuator: ActuatorFrameV2 | null;
  sensor: SensorFrameV2 | null;
}

export interface SessionFaultPort {
  apply(command: Extract<ScheduledCommandV2, { type: "fault.set" }>, tick: TickId): "applied" | "registry-full" | "rejected";
  reset(seed: number): void;
  advanceInto(context: SessionFaultContext): boolean;
  readonly flags: number;
  readonly validityFlags: number;
}

/** A cold-selected dynamics implementation owns integration; the session owns transport. */
export interface SessionDynamics {
  readonly state: FlightState; readonly hz: PhysicsHz; nowMs: number;
  readonly modelId?: number; readonly rotorCount?: number; readonly validityFlags?: number;
  readonly referenceRotorRpm?: number; readonly fault?: string; readonly externalArmed?: boolean;
  reset(): void; stepNow(input: PilotInput): void; dispose?(): void;
  useActuators?(frame: ActuatorFrameV2): void;
}

export class PhysicsSessionV2 {
  private readonly writer: StateWriterV2;
  private readonly pilotReader: PilotReaderV2;
  private readonly actuators: SpscConsumer;
  private readonly sensors: SpscConsumer;
  private readonly sensorCodec = new SensorFrameCodecV2();
  private readonly sensorFrame = newSensorFrameV2();
  private readonly recordPilot = new Float64Array(4);
  private readonly recordSample: SessionRecordSample;
  private recordHook: ((sample: SessionRecordSample) => void) | null = null;
  private readonly actuatorCodec = new ActuatorFrameCodecV2();
  private readonly actuator = newActuatorFrameV2();
  private actuatorPending = false;
  private readonly processor: ControlProcessorV2;
  private readonly clock: SessionClock;
  private readonly header: Int32Array;
  private dynamics: SessionDynamics;
  private readonly dynamicsFactory: (hz: PhysicsHz) => SessionDynamics;
  private policy: SteppingPolicy;
  private readonly report = newPumpReport();
  private readonly pilot = newPilotInputV2();
  private readonly dynamicsInput = newInput();
  private readonly state = newFlightStateV2();
  private readonly bodyScratch = new Float64Array(3);
  private readonly faults: SessionFaultPort | null;
  private beforeTickHook: ((tick: TickId) => void) | null = null;
  private readonly faultContext: SessionFaultContext = { dtS: 0, simTimeS: 0, northM: 0, eastM: 0, downM: 0 };
  // Time registers: hot-path doubles live in fields, never in call arguments or returns (V8 boxes those).
  private monoMs = 0.5;
  private wallMsNow = 0.5;
  private scheduledWallMs = 0.5;
  private latch: ArmLatch = 'disarmed';
  /**
   * Why the armed latch was last blocked by an invalid pilot sample (diagnostics, TASK-073): written in the
   * hot path into preallocated numeric fields, read and cleared by the Worker after each pump.
   */
  readonly pilotRejection = new PilotRejection();
  private latchedGeneration = 0;
  private epoch: number;
  private runningValue = false;
  private disposedValue = false;
  private faultMessage = '';
  // Preallocated callbacks: the hot path never creates closures.
  private readonly integrateTick = (tick: TickId) => this.integrate(tick);
  private readonly gate: StepGate = { ready: (tick: TickId) => this.actuatorReady(tick) };

  constructor(init: WorkerInitV2, clock: SessionClock,
    dynamicsFactory: (hz: PhysicsHz) => SessionDynamics = hz => new DemoDynamics(hz),
    faults: SessionFaultPort | null = null) {
    validateSharedMemoryV2(init.stateBuffer);
    validateSpscQueue(init.sensorBuffer, 'sensor');
    validateSpscQueue(init.actuatorBuffer, 'actuator');
    this.clock = clock;
    this.header = new Int32Array(init.stateBuffer);
    this.writer = new StateWriterV2(init.stateBuffer);
    this.pilotReader = new PilotReaderV2(init.stateBuffer);
    // Sensor frames have no consumer until an I/O Worker exists (TASK-034+); nothing is produced
    // into init.sensorBuffer so it can never overflow or be read by Main.
    this.actuators = new SpscConsumer(init.actuatorBuffer, 'actuator');
    this.sensors = new SpscConsumer(init.sensorBuffer, 'sensor');
    this.recordSample = { state: this.state, pilot: this.recordPilot, actuator: null, sensor: null };
    const hz = this.hzFromHeader();
    this.epoch = Atomics.load(this.header, HeaderV2.SessionEpoch) >>> 0;
    this.dynamicsFactory = dynamicsFactory;
    this.dynamics = dynamicsFactory(hz);
    this.faults = faults;
    this.policy = new SteppingPolicy({ hz, mode: 'interactive' });
    this.processor = new ControlProcessorV2(this, { epoch: this.epoch, hz });
    this.writer.setRuntimeFlags(RuntimeFlagV2.Ready);
    this.publishEpochStart();
  }

  get running(): boolean { return this.runningValue; }
  get disposed(): boolean { return this.disposedValue; }
  get currentEpoch(): number { return this.epoch; }
  get hz(): PhysicsHz { return this.policy.hz; }
  get mode(): ClockModeV2 { return this.policy.mode; }
  get fault(): string { return this.faultMessage; }
  /** Runs at the start of a tick, before due commands apply. Must not allocate on an idle tick. */
  setBeforeTick(hook: ((tick: TickId) => void) | null): void { this.beforeTickHook = hook; }
  /**
   * Full-rate recording fanout. The hook must copy during the call.
   * Sensor frames are popped only while recording, so this session stays the only consumer.
   */
  setRecorder(hook: ((sample: SessionRecordSample) => void) | null): void { this.recordHook = hook; }
  allocateRequestId(): number { return this.processor.allocateRequestId(); }

  readyEvent(): CommandResultV2 {
    return { type: 'ready-v2', protocolVersion: 2, abiVersion: 2, epoch: this.epoch, hz: this.policy.hz };
  }

  /** Admits one untrusted control command; results are delivered by drain(). */
  handle(message: unknown): void {
    this.processor.submit(message);
    this.afterCommand();
  }
  /** Resolves when no model load is pending. */
  settled(): Promise<void> { return this.processor.settled().then(() => this.afterCommand()); }
  drain(send: (result: CommandResultV2) => void): void { this.processor.drain(send); }

  /**
   * One Worker wakeup. Returns the whole-millisecond delay until the next
   * wakeup (rounded up; an integer, so V8 never boxes it), or -1 when stepping
   * is idle (paused, disposed, or faulted). Allocation-free.
   */
  pump(): number {
    if (!this.runningValue || this.faultMessage !== '') return -1;
    this.monoMs = this.clock.monotonicMs();
    this.policy.nowMs = this.monoMs;
    this.policy.pumpNow(this.gate, this.integrateTick, this.report);
    this.writer.setCounters(this.policy.clock.overruns, this.policy.droppedSteps);
    if (this.report.fault !== 'none') {
      this.faultMessage = 'HITL session invalidated: a physics deadline was missed';
      this.writer.setRuntimeFlags(RuntimeFlagV2.Ready | RuntimeFlagV2.Fault);
      return -1;
    }
    if (this.report.waiting) return 1; // lockstep: poll for the autopilot's next frame
    return Math.max(0, Math.ceil(this.policy.clock.nextMs - this.clock.monotonicMs()));
  }

  // --- ControlTargetV2 -----------------------------------------------------

  isArmed(): boolean { return this.latch === 'armed' || this.dynamics.externalArmed === true; }
  rotorCount(): number { return this.dynamics.rotorCount ?? DEMO_ROTOR_COUNT; }
  start(): void {
    this.runningValue = true;
    this.policy.resume(this.clock.monotonicMs());
    this.writer.setRuntimeFlags(RuntimeFlagV2.Ready | RuntimeFlagV2.Running);
  }
  pause(): void {
    this.runningValue = false;
    this.latch = 'disarmed';
    this.writer.setRuntimeFlags(RuntimeFlagV2.Ready | (this.faultMessage ? RuntimeFlagV2.Fault : 0));
  }
  dispose(): void {
    this.runningValue = false; this.disposedValue = true;
    this.dynamics.dispose?.();
    this.writer.setRuntimeFlags(0);
  }
  reset(seed: number): void {
    this.dynamics.reset();
    this.faults?.reset(seed >>> 0);
  }
  configure(hz: PhysicsHz, clockMode: ClockModeV2): void {
    const next = this.dynamicsFactory(hz);
    this.dynamics.dispose?.();
    this.dynamics = next;
    this.policy = new SteppingPolicy({ hz, mode: clockMode });
    this.writer.setPhysicsHz(hz);
  }
  prepareModel(modelId: number): Promise<void> {
    return Promise.reject(new Error(`Model ${modelId} is not available: the runtime has no model registry yet; only the built-in demo quad runs`));
  }
  commitModel(): void { throw new Error('Unreachable: prepareModel never resolves'); }
  applyScheduled(command: ScheduledCommandV2, tick: TickId): void {
    if (command.type !== "fault.set" || !this.faults) return;
    const result = this.faults.apply(command, tick);
    if (result === "applied") return;
    this.faultMessage = result === "registry-full" ? "EW fault registry is full" : "EW fault command was rejected";
    this.runningValue = false;
    this.latch = "blocked";
    this.writer.setRuntimeFlags(RuntimeFlagV2.Ready | RuntimeFlagV2.Fault);
  }
  unsupportedReason(command: ScheduledCommandV2): string | null {
    if (command.type === "weather.set") return "The demo backend has no atmosphere/wind model; weather.set is not supported";
    return this.faults ? null : "The demo backend has no sensor or fault model; fault.set is not supported";
  }

  // --- internals -------------------------------------------------------------

  /** Completes reset/configure after the processor advanced the epoch. */
  private afterCommand(): void {
    const epoch = this.processor.epoch;
    if (epoch === this.epoch) return;
    this.epoch = epoch;
    this.writer.setEpoch(epoch);
    this.faultMessage = '';
    this.writer.setRuntimeFlags(RuntimeFlagV2.Ready | (this.runningValue ? RuntimeFlagV2.Running : 0));
    this.policy.resetEpoch(this.clock.monotonicMs());
    this.latch = 'disarmed';
    this.actuatorPending = false;
    this.publishEpochStart();
  }

  private hzFromHeader(): PhysicsHz {
    const hz = Atomics.load(this.header, HeaderV2.PhysicsHz);
    return hz === 800 ? 800 : hz === 1200 ? 1200 : 400;
  }

  /** SITL lockstep gate: the autopilot's actuator frame for exactly this tick of this epoch. */
  private actuatorReady(tick: TickId): boolean {
    if (this.policy.mode !== 'sitl-lockstep') return true;
    for (;;) {
      if (!this.actuatorPending) {
        if (!this.actuators.tryPop(this.actuatorCodec.words)) return false;
        this.actuatorPending = this.actuatorCodec.decode(this.actuator) && this.actuator.epoch === this.epoch;
        if (!this.actuatorPending) continue; // invalid or stale-epoch frame: discard
      }
      const at = this.actuator.tickId;
      if (at.hi < tick.hi || (at.hi === tick.hi && at.lo < tick.lo)) { this.actuatorPending = false; continue; } // past tick
      return at.hi === tick.hi && at.lo === tick.lo;
    }
  }

  /**
   * Turns the pilot mailbox into demo dynamics input. Arming latches only on an
   * explicit armed request at <=5% throttle; a stale epoch, stale/invalid input,
   * disconnect, or a changed device_generation unlatches and blocks rearming
   * until the armed request is withdrawn.
   */
  private evaluatePilot(): void {
    this.pilotReader.latest(this.pilot); // a miss keeps the last coherent sample
    // Capture receipt time after reading: Main may publish between clock and mailbox reads.
    this.wallMsNow = this.clock.wallMs();
    const p = this.pilot, input = this.dynamicsInput;
    const age = this.wallMsNow - p.sampledWallTimeMs;
    const valid = isValidPilotInputV2(p) && p.expectedEpoch === this.epoch && age >= -INPUT_CLOCK_TOLERANCE_MS && age <= INPUT_TIMEOUT_MS &&
      (p.flags & PilotFlagV2.Connected) !== 0;
    const requested = valid && (p.flags & PilotFlagV2.Armed) !== 0;
    if (this.latch === 'armed') {
      if (!requested && !valid) this.pilotRejection.record(p, age, this.wallMsNow, this.epoch);
      if (!requested) this.latch = valid ? 'disarmed' : 'blocked';
      else if (p.deviceGeneration !== this.latchedGeneration) this.latch = 'blocked';
    } else if (this.latch === 'blocked') {
      if (valid && !requested) this.latch = 'disarmed';
    } else if (requested && p.throttle <= REARM_THROTTLE_MAX) {
      this.latch = 'armed'; this.latchedGeneration = p.deviceGeneration;
    }
    input.roll = valid ? p.roll : 0; input.pitch = valid ? p.pitch : 0;
    input.yaw = valid ? p.yaw : 0; input.throttle = valid ? p.throttle : 0;
    input.flags = valid ? ControlFlag.Connected | (this.latch === 'armed' ? ControlFlag.Armed : 0) : 0;
    input.wallTimeMs = valid ? p.sampledWallTimeMs : 0;
  }

  /** Hot path: one fixed-dt integration and its state publication. */
  private integrate(tick: TickId): void {
    this.evaluatePilot();
    this.beforeTickHook?.(tick);
    this.processor.beforeTick(tick);
    if (this.actuatorPending) this.dynamics.useActuators?.(this.actuator);
    this.dynamics.nowMs = this.wallMsNow;
    this.dynamics.stepNow(this.dynamicsInput);
    if (this.faults && this.faultMessage === "") {
      const d = this.dynamics.state, context = this.faultContext;
      context.dtS = 1 / this.policy.hz;
      context.simTimeS = tickToNumber(tick) / this.policy.hz;
      context.northM = d.north; context.eastM = d.east; context.downM = d.down;
      if (!this.faults.advanceInto(context)) {
        this.faultMessage = "EW step rejected";
        this.runningValue = false; this.latch = "blocked";
        this.writer.setRuntimeFlags(RuntimeFlagV2.Ready | RuntimeFlagV2.Fault);
      }
    }
    if (this.dynamics.fault) {
      this.faultMessage = this.dynamics.fault;
      this.runningValue = false; this.latch = 'blocked';
      this.writer.setRuntimeFlags(RuntimeFlagV2.Ready | RuntimeFlagV2.Fault);
    }
    // Presentation time is the scheduled deadline in the shared wall timebase; freshness above used actual time.
    this.scheduledWallMs = this.wallMsNow - this.monoMs + this.policy.clock.nextMs;
    this.publish(tick);
    this.actuatorPending = false; // the frame for this tick was used
  }

  private publishEpochStart(): void {
    this.dynamics.state.wallTimeMs = this.clock.wallMs();
    this.scheduledWallMs = this.clock.wallMs();
    this.publish(this.policy.tick);
  }

  /** Maps demo truth into FlightStateV2 and publishes it. Allocation-free. */
  private publish(tick: TickId): void {
    const scheduledWallMs = this.scheduledWallMs;
    const d = this.dynamics.state, s = this.state, hz = this.policy.hz;
    s.tickId.lo = tick.lo; s.tickId.hi = tick.hi; s.epoch = this.epoch; s.simTimeS = tickToNumber(tick) / hz;
    s.northM = d.north; s.eastM = d.east; s.downM = d.down;
    s.qw = d.qw; s.qx = d.qx; s.qy = d.qy; s.qz = d.qz;
    s.vnMps = d.vn; s.veMps = d.ve; s.vdMps = d.vd;
    s.anMps2 = d.an; s.aeMps2 = d.ae; s.adMps2 = d.ad;
    s.pRadS = d.p; s.qRadS = d.q; s.rRadS = d.r;
    // Ideal specific force f_b = R_nb^T (a_n - g_n), g_n = [0, 0, g] (SPECS_SIMULATION_ENGINES section 1).
    rotateNedToBody(d.qw, d.qx, d.qy, d.qz, d.an, d.ae, d.ad - STANDARD_GRAVITY_MPS2, this.bodyScratch);
    s.specificForceXBodyMps2 = this.bodyScratch[0]!; s.specificForceYBodyMps2 = this.bodyScratch[1]!;
    s.specificForceZBodyMps2 = this.bodyScratch[2]!;
    s.trueAirspeedMps = Math.sqrt(d.vn * d.vn + d.ve * d.ve + d.vd * d.vd); // still air; not Math.hypot (allocates)
    s.batteryVoltage = d.batteryVoltage; s.batteryCurrentA = 0; // demo has no electrical model
    s.ambientPressurePa = isaPressurePa(-d.down);
    s.scheduledWallTimeMs = scheduledWallMs;
    s.groundClearanceM = -d.down; s.referenceRotorRpm = this.dynamics.referenceRotorRpm ?? 0;
    s.vehicleFlags = ((d.flags & 1) !== 0 ? VehicleFlagV2.GroundContact : 0) |
      ((d.flags & 2) !== 0 ? VehicleFlagV2.InputFailsafe : 0) |
      (this.isArmed() ? VehicleFlagV2.Armed : 0) |
      (this.dynamics.validityFlags ? VehicleFlagV2.ModelOutsideValidity : 0) |
      (this.faults?.validityFlags ?? 0) |
      (this.actuatorPending ? VehicleFlagV2.ActuatorValid : 0) |
      (this.runningValue ? 0 : VehicleFlagV2.Paused);
    s.ekfFlags = 0; s.ewFlags = this.faults?.flags ?? 0; s.sensorValidMask = 0; s.modelId = this.dynamics.modelId ?? DEMO_MODEL_ID;
    s.autopilotMode = UNKNOWN_U32; s.autopilotHealth = 0; s.autopilotStatusAgeMs = 0;
    if (this.actuatorPending) { s.lastActuatorTick.lo = this.actuator.tickId.lo; s.lastActuatorTick.hi = this.actuator.tickId.hi; }
    this.writer.publish(s);
    this.recordProducedTick();
  }

  /** Copies this tick into the recording fanout. The flight sensor queue is read only here. */
  private recordProducedTick(): void {
    const hook = this.recordHook;
    if (!hook) return;
    const pilot = this.recordPilot, input = this.dynamicsInput;
    pilot[0] = input.roll; pilot[1] = input.pitch; pilot[2] = input.yaw; pilot[3] = input.throttle;
    const sample = this.recordSample;
    sample.actuator = this.actuatorPending ? this.actuator : null;
    sample.sensor = this.sensors.tryPop(this.sensorCodec.words) && this.sensorCodec.decode(this.sensorFrame) && this.sensorFrame.epoch === this.epoch
      ? this.sensorFrame : null;
    hook(sample);
  }
}

/** out = R^T v for the body-to-NED unit quaternion (w,x,y,z), i.e. rotates an NED vector into body axes. */
export function rotateNedToBody(w: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, out: Float64Array): void {
  // v' = v + 2w(u x v) + 2 u x (u x v) with u = -(x, y, z) for the inverse rotation.
  const ux = -x, uy = -y, uz = -z;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  out[0] = vx + 2 * (w * cx + uy * cz - uz * cy);
  out[1] = vy + 2 * (w * cy + uz * cx - ux * cz);
  out[2] = vz + 2 * (w * cz + ux * cy - uy * cx);
}

/**
 * The pilot sample that blocked the armed latch, with each validity condition checked separately.
 * Numeric fields start as doubles so updates in the step loop stay unboxed.
 */
export class PilotRejection {
  count = 0.5;
  pending = false;
  ageMs = 0.5;
  wallMs = 0.5;
  sampleWallMs = 0.5;
  sampleId = 0.5;
  expectedEpoch = 0.5;
  sessionEpoch = 0.5;
  flags = 0.5;
  valuesValid = false;
  constructor() { this.count = 0; }
  record(p: PilotInputV2, ageMs: number, wallMs: number, sessionEpoch: number): void {
    this.count++;
    this.pending = true;
    this.ageMs = ageMs; this.wallMs = wallMs; this.sampleWallMs = p.sampledWallTimeMs; this.sampleId = p.inputSampleId;
    this.expectedEpoch = p.expectedEpoch; this.sessionEpoch = sessionEpoch; this.flags = p.flags;
    this.valuesValid = isValidPilotInputV2(p);
  }
}
