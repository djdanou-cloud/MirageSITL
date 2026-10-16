import { assertLittleEndianHost } from './layout-v2.ts';

// Sensor and actuator SPSC queues (docs/SPECS_SHARED_MEMORY.md section 5).
// One SAB per direction, one producer and one consumer per queue. The
// producer owns write_counter/full_events, the consumer owns read_counter.
// Counters are modular uint32; a full queue never overwrites unread frames.
// Every shared word is accessed through Atomics; slots are copied to and from
// thread-local scratch, so push/pop allocate nothing.

export const SPSC_VERSION = 2;
export const SPSC_HEADER_BYTES = 64;
export const SPSC_STRIDE = 128;
export const SPSC_CAPACITY = 1024;
export const SPSC_BYTES = SPSC_HEADER_BYTES + SPSC_CAPACITY * SPSC_STRIDE; // 131,136
export const SPSC_SLOT_WORDS = SPSC_STRIDE / 4;
export const SPSC_HEADER_WORDS = SPSC_HEADER_BYTES / 4;
export const SENSOR_QUEUE_MAGIC = 0x4d534e53;
export const ACTUATOR_QUEUE_MAGIC = 0x4d414354;

/** Queue header word indices (byte offset / 4). */
export const SpscHeader = {
  Magic: 0, Version: 1, Stride: 2, Capacity: 3, WriteCounter: 4, ReadCounter: 5, FullEvents: 6, Epoch: 7,
} as const;

export type QueueKind = 'sensor' | 'actuator';
const MAGIC: Record<QueueKind, number> = { sensor: SENSOR_QUEUE_MAGIC, actuator: ACTUATOR_QUEUE_MAGIC };

export function createSpscQueue(kind: QueueKind): SharedArrayBuffer {
  assertLittleEndianHost();
  const buffer = new SharedArrayBuffer(SPSC_BYTES), words = new Int32Array(buffer);
  Atomics.store(words, SpscHeader.Version, SPSC_VERSION);
  Atomics.store(words, SpscHeader.Stride, SPSC_STRIDE);
  Atomics.store(words, SpscHeader.Capacity, SPSC_CAPACITY);
  Atomics.store(words, SpscHeader.Epoch, 1);
  Atomics.store(words, SpscHeader.Magic, MAGIC[kind]);
  return buffer;
}

export function validateSpscQueue(buffer: unknown, kind: QueueKind): asserts buffer is SharedArrayBuffer {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== SPSC_BYTES) throw new Error(`Invalid ${kind} queue size`);
  const words = new Int32Array(buffer), word = (index: number) => Atomics.load(words, index) >>> 0;
  if (word(SpscHeader.Magic) !== MAGIC[kind] || word(SpscHeader.Version) !== SPSC_VERSION ||
    word(SpscHeader.Stride) !== SPSC_STRIDE || word(SpscHeader.Capacity) !== SPSC_CAPACITY) {
    throw new Error(`${kind} queue ABI mismatch`);
  }
  for (let index = 8; index < SPSC_HEADER_WORDS; index++) if (word(index) !== 0) throw new Error(`${kind} queue reserved words must be zero`);
}

/**
 * Overflow policy. SITL never overwrites and reports would-block so lockstep
 * waits; HITL treats a full queue as a session fault and refuses further
 * pushes until the queue is reset. Neither drops silently: every full
 * condition increments full_events.
 */
export type OverflowPolicy = 'sitl-would-block' | 'hitl-fault';
export type PushResult = 'ok' | 'would-block' | 'faulted';

function slotWord(counter: number): number {
  return SPSC_HEADER_WORDS + (counter % SPSC_CAPACITY) * SPSC_SLOT_WORDS;
}

export class SpscProducer {
  readonly kind: QueueKind;
  readonly policy: OverflowPolicy;
  private readonly shared: Int32Array;
  private faultedValue = false;

  constructor(buffer: SharedArrayBuffer, kind: QueueKind, policy: OverflowPolicy) {
    validateSpscQueue(buffer, kind);
    this.shared = new Int32Array(buffer); this.kind = kind; this.policy = policy;
  }
  get faulted(): boolean { return this.faultedValue; }
  get fullEvents(): number { return Atomics.load(this.shared, SpscHeader.FullEvents) >>> 0; }
  /** Unread frames, by the producer's view. */
  get depth(): number {
    return (Atomics.load(this.shared, SpscHeader.WriteCounter) - Atomics.load(this.shared, SpscHeader.ReadCounter)) >>> 0;
  }

  /** Copies words 0..31 of `frame` into the next free slot. Allocation-free. */
  tryPush(frame: Int32Array): PushResult {
    if (this.faultedValue) return 'faulted';
    const w = this.shared;
    const write = Atomics.load(w, SpscHeader.WriteCounter) >>> 0, read = Atomics.load(w, SpscHeader.ReadCounter) >>> 0;
    if (((write - read) >>> 0) >= SPSC_CAPACITY) {
      Atomics.add(w, SpscHeader.FullEvents, 1);
      if (this.policy === 'hitl-fault') { this.faultedValue = true; return 'faulted'; }
      return 'would-block';
    }
    const base = slotWord(write);
    for (let i = 0; i < SPSC_SLOT_WORDS; i++) Atomics.store(w, base + i, frame[i]!);
    Atomics.store(w, SpscHeader.WriteCounter, (write + 1) | 0); // publishes the slot
    return 'ok';
  }
}

export class SpscConsumer {
  readonly kind: QueueKind;
  private readonly shared: Int32Array;

  constructor(buffer: SharedArrayBuffer, kind: QueueKind) {
    validateSpscQueue(buffer, kind);
    this.shared = new Int32Array(buffer); this.kind = kind;
  }
  get epoch(): number { return Atomics.load(this.shared, SpscHeader.Epoch) >>> 0; }

  /**
   * Copies the oldest unread slot into `out` (32 words), then releases it.
   * The slot is released before the caller decodes or acts on the copy.
   * Returns false when empty. Allocation-free.
   */
  tryPop(out: Int32Array): boolean {
    const w = this.shared;
    const read = Atomics.load(w, SpscHeader.ReadCounter) >>> 0, write = Atomics.load(w, SpscHeader.WriteCounter) >>> 0;
    if (read === write) return false;
    const base = slotWord(read);
    for (let i = 0; i < SPSC_SLOT_WORDS; i++) out[i] = Atomics.load(w, base + i);
    Atomics.store(w, SpscHeader.ReadCounter, (read + 1) | 0); // producer may reuse the slot now
    return true;
  }
}

/**
 * Clears a queue and advances its epoch. Only call while both endpoints are
 * stopped (paused session); a running producer or consumer would race it.
 * Producers created afterwards start unfaulted.
 */
export function resetSpscQueue(buffer: SharedArrayBuffer, kind: QueueKind): void {
  validateSpscQueue(buffer, kind);
  const w = new Int32Array(buffer);
  Atomics.store(w, SpscHeader.WriteCounter, 0);
  Atomics.store(w, SpscHeader.ReadCounter, 0);
  Atomics.store(w, SpscHeader.FullEvents, 0);
  Atomics.store(w, SpscHeader.Epoch, (Atomics.load(w, SpscHeader.Epoch) + 1) | 0 || 1);
}

/** Slot byte offsets shared by sensor and actuator frames (section 5 slot table). */
export const SlotOffsetV2 = {
  kind: 0, epoch: 4, tickId: 8, timeUs: 16, flags: 24, count: 28, values: 32, geo: 96, sourceId: 120, reserved: 124,
} as const;
export const SLOT_VALUES = 16;
export const SLOT_GEO = 3;
