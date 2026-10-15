/** ABI v1: single worker producer, single main-thread consumer. SI, NED / FRD. */
export const ABI_VERSION = 1;
export const PHYSICS_HZ = 400;
export const DT = 1 / PHYSICS_HZ;
export const CAPACITY = 256;
export const HEADER_WORDS = 16;
export const STATE_WORDS = 32;
export const CONTROL_WORDS = 16;
export const CONTROL_OFFSET = HEADER_WORDS + CAPACITY * STATE_WORDS;
export const SHARED_BYTES = (CONTROL_OFFSET + CONTROL_WORDS) * 4;
export const MAGIC = 0x4d534954;
export const Header = { Magic: 0, Version: 1, Capacity: 2, StateWords: 3,
  Published: 4, Overruns: 5, DroppedSteps: 6 } as const;
export const ControlFlag = { Connected: 1, Armed: 2 } as const;
export const StateFlag = { OnGround: 1, InputFailsafe: 2 } as const;
export const INPUT_TIMEOUT_MS = 250;

export interface PilotInput {
  /** roll/pitch/yaw in [-1,1], throttle in [0,1]. */
  roll: number; pitch: number; yaw: number; throttle: number;
  flags: number; wallTimeMs: number;
}
export interface FlightState {
  tick: number; simTime: number;
  /** NED metres. Origin = initial ground contact. Down is positive. */
  north: number; east: number; down: number;
  /** Unit quaternion (w,x,y,z), body FRD -> world NED. */
  qw: number; qx: number; qy: number; qz: number;
  vn: number; ve: number; vd: number;
  an: number; ae: number; ad: number;
  p: number; q: number; r: number;
  spool: number; batteryVoltage: number; flags: number; wallTimeMs: number;
}
export function newInput(): PilotInput {
  return { roll: 0, pitch: 0, yaw: 0, throttle: 0, flags: 0, wallTimeMs: 0 };
}
export function newState(): FlightState {
  return { tick: 0, simTime: 0, north: 0, east: 0, down: 0,
    qw: 1, qx: 0, qy: 0, qz: 0, vn: 0, ve: 0, vd: 0,
    an: 0, ae: 0, ad: 0, p: 0, q: 0, r: 0, spool: 0,
    batteryVoltage: 12.6, flags: StateFlag.OnGround | StateFlag.InputFailsafe, wallTimeMs: 0 };
}
export const wallNow = () => performance.timeOrigin + performance.now();

export function createSharedMemory(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(SHARED_BYTES);
  const words = new Int32Array(buffer);
  Atomics.store(words, Header.Version, ABI_VERSION);
  Atomics.store(words, Header.Capacity, CAPACITY);
  Atomics.store(words, Header.StateWords, STATE_WORDS);
  Atomics.store(words, Header.Magic, MAGIC);
  return buffer;
}
export function validateSharedMemory(buffer: SharedArrayBuffer): void {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== SHARED_BYTES)
    throw new Error('Invalid shared memory size');
  const words = new Int32Array(buffer);
  if (Atomics.load(words, Header.Magic) !== MAGIC ||
    Atomics.load(words, Header.Version) !== ABI_VERSION ||
    Atomics.load(words, Header.Capacity) !== CAPACITY ||
    Atomics.load(words, Header.StateWords) !== STATE_WORDS)
    throw new Error('Shared memory ABI mismatch');
}

// Atomic int32 transport of float bit patterns. Never concurrently access a
// shared Float32/Float64Array: seqlock alone cannot prevent torn float64 reads.
class AtomicFrame {
  readonly shared: Int32Array;
  readonly scratch = new Int32Array(STATE_WORDS);
  readonly data = new DataView(this.scratch.buffer);
  constructor(buffer: SharedArrayBuffer) {
    validateSharedMemory(buffer);
    this.shared = new Int32Array(buffer);
  }
  put32(word: number, value: number) { this.data.setFloat32(word * 4, value, true); }
  get32(word: number) { return this.data.getFloat32(word * 4, true); }
  put64(word: number, value: number) { this.data.setFloat64(word * 4, value, true); }
  get64(word: number) { return this.data.getFloat64(word * 4, true); }
  write(offset: number, length: number): void {
    // Sequence wrap is safe for bounded reads; a reader never waits on a writer.
    const seq = Atomics.load(this.shared, offset);
    Atomics.store(this.shared, offset, (seq + 1) | 0);
    for (let i = 1; i < length; i++) Atomics.store(this.shared, offset + i, this.scratch[i]!);
    Atomics.store(this.shared, offset, (seq + 2) | 0);
  }
  read(offset: number, length: number): boolean {
    const before = Atomics.load(this.shared, offset);
    if (before & 1) return false;
    for (let i = 1; i < length; i++) this.scratch[i] = Atomics.load(this.shared, offset + i);
    return before === Atomics.load(this.shared, offset);
  }
}

export class StateWriter extends AtomicFrame {
  publish(s: FlightState): void {
    const count = Atomics.load(this.shared, Header.Published) >>> 0;
    this.scratch[1] = s.tick;
    this.put64(2, s.simTime);
    this.put64(4, s.north); this.put64(6, s.east); this.put64(8, s.down);
    this.put32(10, s.qw); this.put32(11, s.qx); this.put32(12, s.qy); this.put32(13, s.qz);
    this.put32(14, s.vn); this.put32(15, s.ve); this.put32(16, s.vd);
    this.put32(17, s.an); this.put32(18, s.ae); this.put32(19, s.ad);
    this.put32(20, s.p); this.put32(21, s.q); this.put32(22, s.r);
    this.put32(23, s.spool); this.put32(24, s.batteryVoltage);
    this.scratch[25] = s.flags;
    this.put64(26, s.wallTimeMs);
    this.write(HEADER_WORDS + (count % CAPACITY) * STATE_WORDS, STATE_WORDS);
    Atomics.store(this.shared, Header.Published, (count + 1) | 0);
  }
}
export class StateReader extends AtomicFrame {
  private decode(s: FlightState): void {
    s.tick = this.scratch[1]! >>> 0; s.simTime = this.get64(2);
    s.north = this.get64(4); s.east = this.get64(6); s.down = this.get64(8);
    s.qw = this.get32(10); s.qx = this.get32(11); s.qy = this.get32(12); s.qz = this.get32(13);
    s.vn = this.get32(14); s.ve = this.get32(15); s.vd = this.get32(16);
    s.an = this.get32(17); s.ae = this.get32(18); s.ad = this.get32(19);
    s.p = this.get32(20); s.q = this.get32(21); s.r = this.get32(22);
    s.spool = this.get32(23); s.batteryVoltage = this.get32(24);
    s.flags = this.scratch[25]!; s.wallTimeMs = this.get64(26);
  }
  latest(target: FlightState, age = 0): boolean {
    if (!Number.isInteger(age) || age < 0 || age >= CAPACITY) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const count = Atomics.load(this.shared, Header.Published) >>> 0;
      // Session must restart before uint32 publication counter wraps (~124 days).
      if (count <= age) return false;
      const offset = HEADER_WORDS + ((count - 1 - age) % CAPACITY) * STATE_WORDS;
      if (this.read(offset, STATE_WORDS) && count === (Atomics.load(this.shared, Header.Published) >>> 0)) {
        this.decode(target);
        return true;
      }
    }
    return false; // Caller retains last good snapshot; never blocks the renderer.
  }
}
export class ControlWriter extends AtomicFrame {
  publish(input: PilotInput): void {
    this.put64(2, input.wallTimeMs);
    this.put32(4, input.roll); this.put32(5, input.pitch);
    this.put32(6, input.yaw); this.put32(7, input.throttle);
    this.scratch[8] = input.flags;
    this.write(CONTROL_OFFSET, CONTROL_WORDS);
  }
}
export class ControlReader extends AtomicFrame {
  latest(target: PilotInput): boolean {
    if (!this.read(CONTROL_OFFSET, CONTROL_WORDS)) return false;
    target.wallTimeMs = this.get64(2);
    target.roll = this.get32(4); target.pitch = this.get32(5);
    target.yaw = this.get32(6); target.throttle = this.get32(7);
    target.flags = this.scratch[8]!;
    return true;
  }
}

export type PhysicsCommand = 'start' | 'pause' | 'reset' | 'dispose';
export type MainToPhysics =
  | { type: 'init'; version: typeof ABI_VERSION; buffer: SharedArrayBuffer }
  | { type: PhysicsCommand; requestId: number };
export type PhysicsToMain =
  | { type: 'ready'; version: typeof ABI_VERSION; hz: typeof PHYSICS_HZ }
  | { type: 'ack'; command: PhysicsCommand; requestId: number }
  | { type: 'error'; message: string };
