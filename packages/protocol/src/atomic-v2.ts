import { CAPACITY_V2, HEADER_WORDS_V2, HeaderV2, PILOT_WORDS_V2, PILOT_WORD_OFFSET_V2, RUNTIME_FLAGS_MASK_V2,
  STATE_WORDS_V2, isPhysicsHz, validateSharedMemoryV2, type PhysicsHz } from './layout-v2.ts';
import { PilotCodecV2, type PilotInputV2 } from './pilot-v2.ts';
import { StateCodecV2, copyFlightStateV2, isValidFlightStateV2, newFlightStateV2, type FlightStateV2 } from './state-v2.ts';

// Bounded seqlock transport for ABI v2 (docs/SPECS_SHARED_MEMORY.md section 4).
// Single writer per region; the writer never waits for readers and a reader
// returns a bounded-time miss instead of spinning. Every shared access uses
// Atomics on Int32Array; scratch frames are thread-local and preallocated, so
// publish/read paths allocate nothing after construction.

/** Maximum read attempts before a reader reports a miss. */
export const MAX_READ_ATTEMPTS_V2 = 3;

export function publishAtomicFrame(
  shared: Int32Array, scratch: Int32Array, baseWord: number, words: number,
): void {
  const seq = Atomics.load(shared, baseWord);
  Atomics.store(shared, baseWord, (seq + 1) | 0); // odd
  for (let i = 1; i < words; i++) {
    Atomics.store(shared, baseWord + i, scratch[i]!);
  }
  Atomics.store(shared, baseWord, (seq + 2) | 0); // even; payload committed
}
export function tryReadAtomicFrame(
  shared: Int32Array, scratch: Int32Array, baseWord: number, words: number,
): boolean {
  const before = Atomics.load(shared, baseWord);
  if (before & 1) return false;
  for (let i = 1; i < words; i++) {
    scratch[i] = Atomics.load(shared, baseWord + i);
  }
  return before === Atomics.load(shared, baseWord);
}

function slotWord(slot: number): number {
  return HEADER_WORDS_V2 + slot * STATE_WORDS_V2;
}

/** Physics Worker side: the only writer of the state ring and the Worker-owned header words. */
export class StateWriterV2 {
  private readonly shared: Int32Array;
  private readonly codec = new StateCodecV2();

  constructor(buffer: SharedArrayBuffer) {
    validateSharedMemoryV2(buffer);
    this.shared = new Int32Array(buffer);
  }

  /**
   * Assigns state.sampleId = published + 1, publishes the frame, then advances
   * published. Returns false without touching shared memory if the state
   * violates the value contract (nonfinite truth, unassigned bits, ...).
   */
  publish(state: FlightStateV2): boolean {
    const count = Atomics.load(this.shared, HeaderV2.Published) >>> 0;
    const sampleId = (count + 1) >>> 0;
    const previousSampleId = state.sampleId;
    state.sampleId = sampleId;
    if (!isValidFlightStateV2(state)) { state.sampleId = previousSampleId; return false; }
    this.codec.pack(state);
    publishAtomicFrame(this.shared, this.codec.words, slotWord(count % CAPACITY_V2), STATE_WORDS_V2);
    Atomics.store(this.shared, HeaderV2.Published, sampleId | 0);
    return true;
  }
  setCounters(overruns: number, droppedSteps: number): void {
    Atomics.store(this.shared, HeaderV2.Overruns, overruns | 0);
    Atomics.store(this.shared, HeaderV2.DroppedSteps, droppedSteps | 0);
  }
  setRuntimeFlags(flags: number): void {
    if ((flags & ~RUNTIME_FLAGS_MASK_V2) !== 0) throw new Error('Unknown runtime flags');
    Atomics.store(this.shared, HeaderV2.RuntimeFlags, flags);
  }
  /** Starts a new session epoch (reset, configure, or model swap); states carry their own epoch. */
  setEpoch(epoch: number): void {
    if (!Number.isInteger(epoch) || epoch < 1 || epoch > 0xffffffff) throw new Error('Invalid session epoch');
    Atomics.store(this.shared, HeaderV2.SessionEpoch, epoch | 0);
  }
  /** Changes the advertised rate; callers must be paused and disarmed and start a new epoch. */
  setPhysicsHz(hz: PhysicsHz): void {
    if (!isPhysicsHz(hz)) throw new Error('Unsupported physics rate');
    Atomics.store(this.shared, HeaderV2.PhysicsHz, hz);
  }
}

/** Independent diagnostic header words; not a transactional snapshot. */
export interface HeaderSnapshotV2 {
  published: number; overruns: number; droppedSteps: number;
  physicsHz: number; sessionEpoch: number; runtimeFlags: number;
}
export function newHeaderSnapshotV2(): HeaderSnapshotV2 {
  return { published: 0, overruns: 0, droppedSteps: 0, physicsHz: 0, sessionEpoch: 0, runtimeFlags: 0 };
}
export type HistoryReadV2 = 'none' | 'latest' | 'pair';

/** Render/consumer side. Outputs are mutated only after a fully validated read. */
export class StateReaderV2 {
  private readonly shared: Int32Array;
  private readonly codec = new StateCodecV2();
  private readonly candidate = newFlightStateV2();

  constructor(buffer: SharedArrayBuffer) {
    validateSharedMemoryV2(buffer);
    this.shared = new Int32Array(buffer);
  }

  /**
   * Reads the frame published `age` frames before the newest. Requires
   * published > age, an even unchanged seqlock, an unchanged head, and
   * sample_id == published - age; at most three attempts. A miss leaves
   * target unchanged.
   */
  latest(target: FlightStateV2, age = 0): boolean {
    if (!Number.isInteger(age) || age < 0 || age >= CAPACITY_V2) return false;
    const words = this.codec.words;
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS_V2; attempt++) {
      const count = Atomics.load(this.shared, HeaderV2.Published) >>> 0;
      if (count <= age) return false;
      const expected = (count - age) >>> 0;
      if (tryReadAtomicFrame(this.shared, words, slotWord((count - 1 - age) % CAPACITY_V2), STATE_WORDS_V2) &&
        (Atomics.load(this.shared, HeaderV2.Published) >>> 0) === count && (words[1]! >>> 0) === expected) {
        this.codec.unpack(target);
        return true;
      }
    }
    return false;
  }

  /**
   * Epoch-safe render history. Returns 'pair' when previous holds the frame
   * immediately before current in the same epoch and model with adjacent
   * ticks; 'latest' when only current is coherent (previous is set equal to
   * current, so interpolation never crosses a reset or model swap); 'none'
   * on a miss, leaving both outputs unchanged.
   */
  latestPair(current: FlightStateV2, previous: FlightStateV2): HistoryReadV2 {
    if (!this.latest(current)) return 'none';
    const c = this.candidate;
    if (this.latest(c, 1) && ((c.sampleId + 1) >>> 0) === current.sampleId &&
      c.epoch === current.epoch && c.modelId === current.modelId &&
      ((c.tickId.lo + 1) >>> 0) === current.tickId.lo &&
      (current.tickId.lo === 0 ? ((c.tickId.hi + 1) >>> 0) === current.tickId.hi : c.tickId.hi === current.tickId.hi)) {
      copyFlightStateV2(c, previous);
      return 'pair';
    }
    copyFlightStateV2(current, previous);
    return 'latest';
  }

  readHeader(out: HeaderSnapshotV2): void {
    const w = this.shared;
    out.published = Atomics.load(w, HeaderV2.Published) >>> 0;
    out.overruns = Atomics.load(w, HeaderV2.Overruns) >>> 0;
    out.droppedSteps = Atomics.load(w, HeaderV2.DroppedSteps) >>> 0;
    out.physicsHz = Atomics.load(w, HeaderV2.PhysicsHz) >>> 0;
    out.sessionEpoch = Atomics.load(w, HeaderV2.SessionEpoch) >>> 0;
    out.runtimeFlags = Atomics.load(w, HeaderV2.RuntimeFlags) >>> 0;
  }
}

/** Main side: the only writer of the pilot mailbox. */
export class PilotWriterV2 {
  private readonly shared: Int32Array;
  private readonly codec = new PilotCodecV2();
  private published = 0;

  constructor(buffer: SharedArrayBuffer) {
    validateSharedMemoryV2(buffer);
    this.shared = new Int32Array(buffer);
  }
  /** Assigns input.inputSampleId (uint32, wrapping) and publishes the mailbox. Consumers validate values. */
  publish(input: PilotInputV2): void {
    this.published = (this.published + 1) >>> 0;
    input.inputSampleId = this.published;
    this.codec.pack(input);
    publishAtomicFrame(this.shared, this.codec.words, PILOT_WORD_OFFSET_V2, PILOT_WORDS_V2);
  }
}

/** Physics Worker side: reads the pilot mailbox; a miss leaves target unchanged. */
export class PilotReaderV2 {
  private readonly shared: Int32Array;
  private readonly codec = new PilotCodecV2();

  constructor(buffer: SharedArrayBuffer) {
    validateSharedMemoryV2(buffer);
    this.shared = new Int32Array(buffer);
  }
  latest(target: PilotInputV2): boolean {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS_V2; attempt++) {
      if (tryReadAtomicFrame(this.shared, this.codec.words, PILOT_WORD_OFFSET_V2, PILOT_WORDS_V2)) {
        this.codec.unpack(target);
        return true;
      }
    }
    return false;
  }
}
