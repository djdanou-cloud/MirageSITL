import { isPhysicsHz, type PhysicsHz } from './layout-v2.ts';
import { MAX_SAFE_TICK_HI, compareTicks, copyTickInto, isUint32, tickToNumber, type TickId, type Vec3 } from './state-v2.ts';

// Worker Control Protocol v2 (docs/SPECS_SHARED_MEMORY.md section 6).
// parseControlCommandV2 validates low-frequency commands from unknown input;
// control-v2.schema.json is the equivalent JSON Schema 2020-12 contract.
// ControlProcessorV2 applies the admission, deduplication, epoch, scheduling,
// and lifecycle rules. Admission allocates; beforeTick does not.

export type EwEffect =
  | { kind: 'gnss-jamming'; severity: number }
  | { kind: 'position-step'; offsetNedM: Vec3 }
  | { kind: 'velocity-drift'; accelerationNedMps2: Vec3; maxSpeedMps: number }
  | { kind: 'magnetic'; rotationRad: Vec3; biasBodyGauss: Vec3 }
  | { kind: 'motor-loss'; motorIndex: number; mode: 'power-cut' | 'instant-thrust-loss'; remainingThrustFraction: number };
export interface EnvelopeV2 {
  protocolVersion: 2; requestId: number; expectedEpoch: number;
}
export type ScheduledCommandV2 = EnvelopeV2 & { atTick: TickId } & (
  | { type: 'weather.set'; windNedMps: Vec3; temperatureK: number;
      pressurePa: number; turbulenceRmsMps: number; seed: number }
  | { type: 'fault.set'; faultId: string; enabled: boolean; effect: EwEffect;
      recovery: 'hold-offset' | 'step-to-truth' }
);
export type LifecycleCommandV2 = EnvelopeV2 & (
  | { type: 'sim.start' | 'sim.pause' | 'worker.dispose' }
  | { type: 'sim.reset'; seed: number }
  | { type: 'sim.configure'; hz: PhysicsHz; clockMode: 'interactive' | 'sitl-lockstep' | 'hitl-realtime' }
  | { type: 'model.load'; modelId: number; manifestSha256: string }
);
export type ControlCommandV2 = ScheduledCommandV2 | LifecycleCommandV2;
export interface WorkerInitV2 {
  type: 'init-v2'; protocolVersion: 2; stateBuffer: SharedArrayBuffer;
  sensorBuffer: SharedArrayBuffer; actuatorBuffer: SharedArrayBuffer;
}
export type CommandResultV2 =
  | { type: 'ready-v2'; protocolVersion: 2; abiVersion: 2; epoch: number; hz: PhysicsHz }
  | { type: 'ack-v2'; requestId: number; status: 'queued' | 'applied';
      epoch: number; appliedTick: TickId }
  | { type: 'reject-v2'; requestId: number; code: 'SCHEMA' | 'STALE_EPOCH' |
      'BAD_STATE' | 'OUT_OF_RANGE' | 'ASSET_MISSING' | 'OVERLOAD'; message: string };

export type ClockModeV2 = Extract<LifecycleCommandV2, { type: 'sim.configure' }>['clockMode'];
export type RejectCodeV2 = Extract<CommandResultV2, { type: 'reject-v2' }>['code'];

export const CONTROL_PROTOCOL_VERSION = 2;
export const MAX_COMMAND_BYTES_V2 = 16 * 1024;
export const COMMAND_QUEUE_CAPACITY_V2 = 128;
export const DEDUPE_CACHE_SIZE_V2 = 128;
export const SCHEDULE_HORIZON_S = 10;
/** Received requestId reported when a malformed command has no readable uint32 ID. */
export const UNKNOWN_REQUEST_ID = -1;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ParseResultV2 =
  | { ok: true; command: ControlCommandV2 }
  | { ok: false; code: 'SCHEMA' | 'OUT_OF_RANGE'; message: string; requestId: number };

class CommandError extends Error {
  readonly code: 'SCHEMA' | 'OUT_OF_RANGE';
  constructor(code: 'SCHEMA' | 'OUT_OF_RANGE', message: string) {
    super(message);
    this.code = code;
  }
}
const schema = (message: string) => new CommandError('SCHEMA', message);
const range = (message: string) => new CommandError('OUT_OF_RANGE', message);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function record(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw schema(`${name} must be a plain object`);
  return value;
}
/** additionalProperties:false with every listed field required. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  for (const key of keys) if (!Object.hasOwn(value, key)) throw schema(`${name}.${key} is required`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw schema(`${name}.${key} is not allowed`);
}
function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw schema(`${name} must be a finite number`);
  return value;
}
function inRange(value: unknown, name: string, min: number, max: number, exclusiveMin = false): number {
  const n = finiteNumber(value, name);
  if ((exclusiveMin ? n <= min : n < min) || n > max) throw range(`${name} must be in ${exclusiveMin ? '(' : '['}${min}, ${max}]`);
  return n;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  const n = finiteNumber(value, name);
  if (!Number.isInteger(n)) throw schema(`${name} must be an integer`);
  if (n < min || n > max) throw range(`${name} must be in [${min}, ${max}]`);
  return n;
}
const uint32 = (value: unknown, name: string) => integer(value, name, 0, 0xffffffff);
function oneOf<T extends string | number>(value: unknown, name: string, options: readonly T[]): T {
  const match = options.find(option => option === value);
  if (match === undefined) throw schema(`${name} must be one of ${options.join(', ')}`);
  return match;
}
function text(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw schema(`${name} must match ${pattern.source}`);
  return value;
}
function vec3(value: unknown, name: string, min: number, max: number): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw schema(`${name} must be an array of three numbers`);
  const items: unknown[] = value;
  return [inRange(items[0], `${name}[0]`, min, max), inRange(items[1], `${name}[1]`, min, max), inRange(items[2], `${name}[2]`, min, max)];
}
function tick(value: unknown, name: string): TickId {
  const object = record(value, name);
  exactKeys(object, ['lo', 'hi'], name);
  return { lo: uint32(object.lo, `${name}.lo`), hi: uint32(object.hi, `${name}.hi`) };
}

const ENVELOPE = ['protocolVersion', 'requestId', 'expectedEpoch', 'type'] as const;
const FAULT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const MAX_DRIFT_NORM_MPS2 = 0.3;
/** Position-step envelope |b| <= 10 km, identical to the PositionStep kernel (packages/ew/src/position-step.ts). */
const MAX_POSITION_STEP_NORM_M = 10_000;

function effect(value: unknown): EwEffect {
  const e = record(value, 'effect');
  const kind = oneOf(e.kind, 'effect.kind', ['gnss-jamming', 'position-step', 'velocity-drift', 'magnetic', 'motor-loss'] as const);
  switch (kind) {
    case 'gnss-jamming':
      exactKeys(e, ['kind', 'severity'], 'effect');
      return { kind, severity: inRange(e.severity, 'effect.severity', 0, 1) };
    case 'position-step': {
      exactKeys(e, ['kind', 'offsetNedM'], 'effect');
      const offset = vec3(e.offsetNedM, 'effect.offsetNedM', -10000, 10000), [n, east, d] = offset;
      // Not expressible in JSON Schema; the same expression as PositionStep.schedule, so both agree at the boundary.
      if (Math.sqrt(n * n + east * east + d * d) > MAX_POSITION_STEP_NORM_M) throw range('effect.offsetNedM norm must be <= 10000');
      return { kind, offsetNedM: offset };
    }
    case 'velocity-drift': {
      exactKeys(e, ['kind', 'accelerationNedMps2', 'maxSpeedMps'], 'effect');
      const acceleration = vec3(e.accelerationNedMps2, 'effect.accelerationNedMps2', -0.3, 0.3);
      const maxSpeedMps = inRange(e.maxSpeedMps, 'effect.maxSpeedMps', 0, 20, true);
      // Not expressible in JSON Schema: the vector norm is limited too.
      if (Math.hypot(acceleration[0], acceleration[1], acceleration[2]) > MAX_DRIFT_NORM_MPS2) {
        throw range('effect.accelerationNedMps2 norm must be <= 0.3');
      }
      return { kind, accelerationNedMps2: acceleration, maxSpeedMps };
    }
    case 'magnetic':
      exactKeys(e, ['kind', 'rotationRad', 'biasBodyGauss'], 'effect');
      return { kind, rotationRad: vec3(e.rotationRad, 'effect.rotationRad', -Math.PI, Math.PI),
        biasBodyGauss: vec3(e.biasBodyGauss, 'effect.biasBodyGauss', -2, 2) };
    case 'motor-loss':
      exactKeys(e, ['kind', 'motorIndex', 'mode', 'remainingThrustFraction'], 'effect');
      return { kind, motorIndex: integer(e.motorIndex, 'effect.motorIndex', 0, 31),
        mode: oneOf(e.mode, 'effect.mode', ['power-cut', 'instant-thrust-loss'] as const),
        remainingThrustFraction: inRange(e.remainingThrustFraction, 'effect.remainingThrustFraction', 0, 1) };
    default: { const never: never = kind; throw schema(`Unhandled effect ${String(never)}`); }
  }
}

function parseCommand(c: Record<string, unknown>): ControlCommandV2 {
  if (c.protocolVersion !== CONTROL_PROTOCOL_VERSION) throw schema('protocolVersion must be 2');
  const type = oneOf(c.type, 'type', ['weather.set', 'fault.set', 'sim.start', 'sim.pause', 'worker.dispose',
    'sim.reset', 'sim.configure', 'model.load'] as const);
  const requestId = uint32(c.requestId, 'requestId'), expectedEpoch = uint32(c.expectedEpoch, 'expectedEpoch');
  const envelope = { protocolVersion: 2 as const, requestId, expectedEpoch };
  switch (type) {
    case 'sim.start': case 'sim.pause': case 'worker.dispose':
      exactKeys(c, ENVELOPE, 'command');
      return { ...envelope, type };
    case 'sim.reset':
      exactKeys(c, [...ENVELOPE, 'seed'], 'command');
      return { ...envelope, type, seed: uint32(c.seed, 'seed') };
    case 'sim.configure': {
      exactKeys(c, [...ENVELOPE, 'hz', 'clockMode'], 'command');
      const hz = c.hz;
      if (typeof hz !== 'number' || !Number.isInteger(hz)) throw schema('hz must be an integer');
      if (!isPhysicsHz(hz)) throw range('hz must be 400, 800, or 1200');
      return { ...envelope, type, hz, clockMode: oneOf(c.clockMode, 'clockMode', ['interactive', 'sitl-lockstep', 'hitl-realtime'] as const) };
    }
    case 'model.load':
      exactKeys(c, [...ENVELOPE, 'modelId', 'manifestSha256'], 'command');
      return { ...envelope, type, modelId: uint32(c.modelId, 'modelId'), manifestSha256: text(c.manifestSha256, 'manifestSha256', SHA256) };
    case 'weather.set':
      exactKeys(c, [...ENVELOPE, 'atTick', 'windNedMps', 'temperatureK', 'pressurePa', 'turbulenceRmsMps', 'seed'], 'command');
      return { ...envelope, atTick: tick(c.atTick, 'atTick'), type,
        windNedMps: vec3(c.windNedMps, 'windNedMps', -100, 100),
        temperatureK: inRange(c.temperatureK, 'temperatureK', 200, 340),
        pressurePa: inRange(c.pressurePa, 'pressurePa', 30000, 110000),
        turbulenceRmsMps: inRange(c.turbulenceRmsMps, 'turbulenceRmsMps', 0, 30),
        seed: uint32(c.seed, 'seed') };
    case 'fault.set': {
      exactKeys(c, [...ENVELOPE, 'atTick', 'faultId', 'enabled', 'effect', 'recovery'], 'command');
      if (typeof c.enabled !== 'boolean') throw schema('enabled must be a boolean');
      return { ...envelope, atTick: tick(c.atTick, 'atTick'), type, faultId: text(c.faultId, 'faultId', FAULT_ID),
        enabled: c.enabled, effect: effect(c.effect),
        recovery: oneOf(c.recovery, 'recovery', ['hold-offset', 'step-to-truth'] as const) };
    }
    default: { const never: never = type; throw schema(`Unhandled type ${String(never)}`); }
  }
}

function serializedBytes(input: unknown): number {
  let json: string | undefined;
  try { json = JSON.stringify(input); } catch { return Infinity; }
  return json === undefined ? Infinity : new TextEncoder().encode(json).byteLength;
}

/**
 * Validates an untrusted command. The returned command is a fresh, normalized
 * copy that shares nothing with the input. SCHEMA covers shape, types,
 * NaN/Infinity, non-integers, enums, and patterns; OUT_OF_RANGE covers
 * numeric bounds (including the drift and position-step norms, which JSON
 * Schema cannot express).
 */
export function parseControlCommandV2(input: unknown): ParseResultV2 {
  const received = typeof input === 'object' && input !== null && 'requestId' in input && isUint32(input.requestId)
    ? input.requestId : UNKNOWN_REQUEST_ID;
  if (serializedBytes(input) > MAX_COMMAND_BYTES_V2) {
    return { ok: false, code: 'SCHEMA', message: 'Command payload is not JSON or exceeds 16 KiB', requestId: received };
  }
  try {
    return { ok: true, command: parseCommand(record(input, 'command')) };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, code: error.code, message: error.message, requestId: received };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

/** Final reject for a due scheduled command that could not take effect; targets return preallocated constants. */
export interface ScheduledRejectV2 { readonly code: RejectCodeV2; readonly message: string }

/** The simulation side the processor drives. Implemented by the physics Worker. */
export interface ControlTargetV2 {
  isArmed(): boolean;
  rotorCount(): number;
  start(): void;
  pause(): void;
  dispose(): void;
  reset(seed: number): void;
  configure(hz: PhysicsHz, clockMode: ClockModeV2): void;
  /** Fetch, hash-verify, and initialize a backend while paused, without touching the active model; rejects on failure. */
  prepareModel(modelId: number, manifestSha256: string): Promise<void>;
  /** Swap to the prepared model; called only after prepareModel resolved and the session is still paused and disarmed. */
  commitModel(modelId: number): void;
  /**
   * Called before integrating `tick`; must not allocate. Returns null once the
   * command took effect, otherwise its final reject (never reported as applied).
   */
  applyScheduled(command: ScheduledCommandV2, tick: TickId): ScheduledRejectV2 | null;
  /** Null when the backend can model this scheduled command, otherwise the BAD_STATE reason (checked at admission). */
  unsupportedReason(command: ScheduledCommandV2): string | null;
}

/** Mutable result record; the outbox copies its scalars, so updating it later never rewrites a sent result. */
interface ResultRecord {
  requestId: number; kind: 'ack' | 'reject'; status: 'queued' | 'applied'; epoch: number;
  tick: TickId; code: RejectCodeV2; message: string;
}
function newRecord(requestId: number): ResultRecord {
  return { requestId, kind: 'ack', status: 'queued', epoch: 0, tick: { lo: 0, hi: 0 }, code: 'BAD_STATE', message: '' };
}
interface QueueSlot { command: ScheduledCommandV2 | null; record: ResultRecord | null; receipt: number }

export const OUTBOX_CAPACITY_V2 = 1024;

export class ControlProcessorV2 {
  private epochValue: number;
  private hzValue: PhysicsHz;
  private running = false;
  private disposed = false;
  private loading = false;
  /** Non-empty while the target is halted by a session fault; cleared by the next epoch. */
  private haltReason = '';
  private highWater = -1;
  private receipts = 0;
  private pendingLoad: Promise<void> = Promise.resolve();
  private readonly lastTick: TickId = { lo: 0, hi: 0 };
  private readonly cache = new Map<number, { payload: string; result: ResultRecord }>();
  /** Sorted by (atTick, receipt) descending: the next due command is at index count - 1. */
  private readonly queue: QueueSlot[] = Array.from({ length: COMMAND_QUEUE_CAPACITY_V2 }, () => ({ command: null, record: null, receipt: 0 }));
  private queued = 0;
  private readonly outbox: ResultRecord[] = Array.from({ length: OUTBOX_CAPACITY_V2 }, () => newRecord(0));
  private outboxCount = 0;
  /** Results that did not fit before the last drain; must stay zero when drained after each batch. */
  outboxOverflows = 0;
  private readonly target: ControlTargetV2;

  constructor(target: ControlTargetV2, options: { epoch?: number; hz?: PhysicsHz } = {}) {
    this.target = target;
    this.epochValue = options.epoch ?? 1;
    this.hzValue = options.hz ?? 400;
  }
  get epoch(): number { return this.epochValue; }
  get hz(): PhysicsHz { return this.hzValue; }
  get pendingCommands(): number { return this.queued; }
  /** Next id the processor will accept. The caller must submit it before asking again. */
  allocateRequestId(): number { return (this.highWater + 1) >>> 0; }
  /** Resolves when no model load is in flight. */
  settled(): Promise<void> { return this.pendingLoad; }

  /**
   * The target stopped stepping on its own (a session fault). The session then
   * counts as paused, so reset/configure/model.load are admitted; sim.start is
   * rejected and due commands stay queued until a new epoch cancels them.
   * Allocation-free, so the hot path may call it.
   */
  halt(reason: string): void {
    this.running = false;
    this.haltReason = reason;
  }

  /** Admits one command. Results go to the outbox; call drain() afterwards. */
  submit(input: unknown): void {
    const parsed = parseControlCommandV2(input);
    if (!parsed.ok) {
      // Malformed commands do not consume request IDs or enter the deduplication cache.
      this.pushReject(parsed.requestId, parsed.code, parsed.message);
      return;
    }
    const command = parsed.command, id = command.requestId, payload = JSON.stringify(command);
    const cached = this.cache.get(id);
    if (cached) {
      if (cached.payload === payload) this.push(cached.result); // exact duplicate: replay, never reapply
      else this.pushReject(id, 'BAD_STATE', 'requestId was already used with a different payload');
      return;
    }
    if (id <= this.highWater) {
      this.pushReject(id, 'BAD_STATE', 'requestId is at or below the high-water mark and no longer cached');
      return;
    }
    this.highWater = id;
    const result = newRecord(id);
    this.cache.set(id, { payload, result });
    if (this.cache.size > DEDUPE_CACHE_SIZE_V2) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.admit(command, result);
    this.push(result);
  }

  private admit(command: ControlCommandV2, result: ResultRecord): void {
    if (this.disposed) return reject(result, 'BAD_STATE', 'Worker is disposed');
    if (this.loading && command.type !== 'worker.dispose') return reject(result, 'BAD_STATE', 'A model load is in progress');
    if (command.expectedEpoch !== this.epochValue) return reject(result, 'STALE_EPOCH', `Current epoch is ${this.epochValue}`);
    switch (command.type) {
      case 'sim.start':
        if (this.haltReason !== '') {
          return reject(result, 'BAD_STATE', `Session faulted (${this.haltReason}); sim.reset or sim.configure starts a new epoch`);
        }
        if (!this.running) { this.target.start(); this.running = true; }
        return this.applied(result);
      case 'sim.pause':
        if (this.running) { this.target.pause(); this.running = false; }
        return this.applied(result);
      case 'worker.dispose':
        this.disposed = true; this.running = false;
        this.rejectPending('Worker is disposed');
        this.target.dispose();
        return this.applied(result);
      case 'sim.reset': case 'sim.configure': case 'model.load':
        if (this.running || this.target.isArmed()) return reject(result, 'BAD_STATE', `${command.type} requires a paused, disarmed session`);
        if (command.type === 'sim.reset') {
          this.target.reset(command.seed);
          return this.newEpoch(result, 'sim.reset');
        }
        if (command.type === 'sim.configure') {
          this.target.configure(command.hz, command.clockMode);
          this.hzValue = command.hz;
          return this.newEpoch(result, 'sim.configure');
        }
        return this.load(command.modelId, command.manifestSha256, result);
      case 'weather.set': case 'fault.set':
        return this.schedule(command, result);
      default: { const never: never = command; throw new Error(`Unhandled command ${JSON.stringify(never)}`); }
    }
  }

  private schedule(command: ScheduledCommandV2, result: ResultRecord): void {
    const at = command.atTick, next = this.nextTick();
    if (at.hi > MAX_SAFE_TICK_HI) return reject(result, 'OUT_OF_RANGE', 'atTick exceeds 2^53');
    if (compareTicks(at, next) < 0) return reject(result, 'OUT_OF_RANGE', 'atTick is in the past');
    if (tickToNumber(at) - tickToNumber(next) > SCHEDULE_HORIZON_S * this.hzValue) {
      return reject(result, 'OUT_OF_RANGE', 'atTick is beyond the 10 s horizon');
    }
    if (command.type === 'fault.set' && command.effect.kind === 'motor-loss' && command.effect.motorIndex >= this.target.rotorCount()) {
      return reject(result, 'OUT_OF_RANGE', 'motorIndex must be below the rotor count');
    }
    const unsupported = this.target.unsupportedReason(command);
    if (unsupported !== null) return reject(result, 'BAD_STATE', unsupported);
    if (this.queued === COMMAND_QUEUE_CAPACITY_V2) return reject(result, 'OVERLOAD', 'Command queue is full');
    // Insert keeping (atTick, receipt) descending; equal ticks keep receipt order.
    // Invariant: slots [0, queued) hold a command and record; queued < capacity here.
    const receipt = this.receipts++;
    let index = this.queued;
    while (index > 0 && compareTicks(this.queue[index - 1]!.command!.atTick, at) <= 0) {
      const from = this.queue[index - 1]!, to = this.queue[index]!;
      to.command = from.command; to.record = from.record; to.receipt = from.receipt;
      index--;
    }
    const slot = this.queue[index]!;
    slot.command = command; slot.record = result; slot.receipt = receipt;
    this.queued++;
    result.kind = 'ack'; result.status = 'queued'; result.epoch = this.epochValue;
    copyTickInto(at, result.tick);
  }

  private load(modelId: number, manifestSha256: string, result: ResultRecord): void {
    this.loading = true;
    result.kind = 'ack'; result.status = 'queued'; result.epoch = this.epochValue;
    copyTickInto(this.lastTick, result.tick);
    this.pendingLoad = this.target.prepareModel(modelId, manifestSha256).then(
      () => {
        this.loading = false;
        if (this.disposed) return reject(result, 'BAD_STATE', 'Worker was disposed during the model load');
        if (this.running || this.target.isArmed()) return reject(result, 'BAD_STATE', 'Session left the paused, disarmed state');
        this.target.commitModel(modelId);
        this.newEpoch(result, 'model.load');
      },
      (error: unknown) => {
        // The previous model stays active and paused; nothing was swapped.
        this.loading = false;
        reject(result, 'ASSET_MISSING', error instanceof Error ? error.message : 'Model preparation failed');
      },
    ).then(() => this.push(result));
  }

  /** reset/configure/model swap: cancel pending commands, restart ticks, and advance the epoch. */
  private newEpoch(result: ResultRecord, reason: string): void {
    this.rejectPending(`Cancelled by ${reason}`);
    this.haltReason = '';
    this.epochValue = (this.epochValue + 1) >>> 0 || 1;
    this.lastTick.lo = 0; this.lastTick.hi = 0;
    this.applied(result);
  }

  private applied(result: ResultRecord): void {
    result.kind = 'ack'; result.status = 'applied'; result.epoch = this.epochValue;
    copyTickInto(this.lastTick, result.tick);
  }

  /** Rejects queued commands in due order: (atTick, receipt) ascending, i.e. from the end of the queue. */
  private rejectPending(message: string): void {
    for (let i = this.queued - 1; i >= 0; i--) {
      const slot = this.queue[i]!;
      if (slot.record) { reject(slot.record, 'BAD_STATE', message); this.push(slot.record); }
      slot.command = null; slot.record = null;
    }
    this.queued = 0;
  }

  private nextTick(): TickId {
    const next = { lo: (this.lastTick.lo + 1) >>> 0, hi: this.lastTick.hi };
    if (next.lo === 0) next.hi = (next.hi + 1) >>> 0;
    return next;
  }

  /**
   * Hot path: call before integrating `tick`. Applies every command due at or
   * before it in (atTick, receipt) order and records the actual tick, or the
   * target's final reject. A halted target applies nothing. Allocates nothing.
   */
  beforeTick(tick: TickId): void {
    // Invariant: 0 < queued <= capacity inside the loop, so queue[queued - 1] exists.
    while (this.queued > 0 && this.haltReason === '') {
      const slot = this.queue[this.queued - 1]!, command = slot.command, result = slot.record;
      if (!command || !result || compareTicks(command.atTick, tick) > 0) break;
      const failure = this.target.applyScheduled(command, tick);
      if (failure) reject(result, failure.code, failure.message);
      else {
        result.status = 'applied'; result.epoch = this.epochValue;
        result.tick.lo = tick.lo; result.tick.hi = tick.hi;
      }
      this.push(result);
      slot.command = null; slot.record = null;
      this.queued--;
    }
    this.lastTick.lo = tick.lo; this.lastTick.hi = tick.hi;
  }

  /** Copies a result's scalars into the bounded outbox without allocating. */
  private push(result: ResultRecord): void {
    if (this.outboxCount === OUTBOX_CAPACITY_V2) { this.outboxOverflows++; return; }
    const slot = this.outbox[this.outboxCount++]!;
    slot.requestId = result.requestId; slot.kind = result.kind; slot.status = result.status; slot.epoch = result.epoch;
    slot.tick.lo = result.tick.lo; slot.tick.hi = result.tick.hi; slot.code = result.code; slot.message = result.message;
  }
  private pushReject(requestId: number, code: RejectCodeV2, message: string): void {
    const result = newRecord(requestId);
    reject(result, code, message);
    this.push(result);
  }

  /** Delivers results in order; call after each message and after each compute batch, never inside step. */
  drain(send: (result: CommandResultV2) => void): void {
    const count = this.outboxCount;
    this.outboxCount = 0;
    for (let i = 0; i < count; i++) {
      const r = this.outbox[i]!;
      send(r.kind === 'ack'
        ? { type: 'ack-v2', requestId: r.requestId, status: r.status, epoch: r.epoch, appliedTick: { lo: r.tick.lo, hi: r.tick.hi } }
        : { type: 'reject-v2', requestId: r.requestId, code: r.code, message: r.message });
    }
  }
}

function reject(result: ResultRecord, code: RejectCodeV2, message: string): void {
  result.kind = 'reject'; result.code = code; result.message = message;
}

// ---------------------------------------------------------------------------
// Worker boundary guards
// ---------------------------------------------------------------------------

/** Session fault reported by the Worker outside the command/result flow (for example a failed init-v2). */
export interface WorkerFaultV2 { type: 'fault-v2'; protocolVersion: 2; message: string }
export type WorkerEventV2 = CommandResultV2 | WorkerFaultV2;

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const tickLike = (value: unknown): value is TickId =>
  plain(value) && isUint32(value.lo) && isUint32(value.hi) && Object.keys(value).length === 2;

/** Structural check of the structured-clone init message; buffers are validated by their own layouts. */
export function isWorkerInitV2(value: unknown): value is WorkerInitV2 {
  return plain(value) && value.type === 'init-v2' && value.protocolVersion === CONTROL_PROTOCOL_VERSION &&
    value.stateBuffer instanceof SharedArrayBuffer && value.sensorBuffer instanceof SharedArrayBuffer &&
    value.actuatorBuffer instanceof SharedArrayBuffer && Object.keys(value).length === 5;
}

const REJECT_CODES: readonly RejectCodeV2[] = ['SCHEMA', 'STALE_EPOCH', 'BAD_STATE', 'OUT_OF_RANGE', 'ASSET_MISSING', 'OVERLOAD'];
/** Validates a Worker-to-Main message; anything unrecognized returns null and must be ignored. */
export function parseWorkerEventV2(value: unknown): WorkerEventV2 | null {
  if (!plain(value)) return null;
  switch (value.type) {
    case 'ready-v2':
      return value.protocolVersion === 2 && value.abiVersion === 2 && isUint32(value.epoch) && isPhysicsHz(value.hz)
        ? { type: 'ready-v2', protocolVersion: 2, abiVersion: 2, epoch: value.epoch, hz: value.hz } : null;
    case 'ack-v2':
      return (value.requestId === UNKNOWN_REQUEST_ID || isUint32(value.requestId)) && (value.status === 'queued' || value.status === 'applied') &&
        isUint32(value.epoch) && tickLike(value.appliedTick)
        ? { type: 'ack-v2', requestId: value.requestId, status: value.status, epoch: value.epoch,
          appliedTick: { lo: value.appliedTick.lo, hi: value.appliedTick.hi } } : null;
    case 'reject-v2': {
      const code = REJECT_CODES.find(candidate => candidate === value.code);
      return (value.requestId === UNKNOWN_REQUEST_ID || isUint32(value.requestId)) && code !== undefined && typeof value.message === 'string'
        ? { type: 'reject-v2', requestId: value.requestId, code, message: value.message } : null;
    }
    case 'fault-v2':
      return value.protocolVersion === 2 && typeof value.message === 'string'
        ? { type: 'fault-v2', protocolVersion: 2, message: value.message } : null;
    default:
      return null;
  }
}
