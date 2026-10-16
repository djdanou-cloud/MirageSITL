import { RECORD_BYTES } from "./format.ts";
const MAGIC = 0x4d415251,
  HEADER_WORDS = 16;
export const HANDOFF_CAPACITY = 256;
export function createRecordingQueue(): SharedArrayBuffer {
  const b = new SharedArrayBuffer(64 + HANDOFF_CAPACITY * RECORD_BYTES),
    w = new Int32Array(b);
  Atomics.store(w, 0, MAGIC);
  Atomics.store(w, 1, 1);
  return b;
}
/** Separate SPSC queue; never attach this consumer to the flight sensor/actuator queues.
 * Header words: magic/version/write/read/lost. Full queue drops NEW data and increments lost.
 */
export class RecordingHandoff {
  private readonly words: Int32Array;
  constructor(buffer: SharedArrayBuffer) {
    if (
      !(buffer instanceof SharedArrayBuffer) ||
      buffer.byteLength !== 64 + HANDOFF_CAPACITY * RECORD_BYTES
    )
      throw new Error("Invalid recording queue");
    this.words = new Int32Array(buffer);
    if (
      Atomics.load(this.words, 0) !== MAGIC ||
      Atomics.load(this.words, 1) !== 1
    )
      throw new Error("Recording queue ABI mismatch");
  }
  get lost(): number {
    return Atomics.load(this.words, 4) >>> 0;
  }
  push(record: Int32Array): boolean {
    if (record.length !== RECORD_BYTES / 4) return false;
    const w = Atomics.load(this.words, 2) >>> 0,
      r = Atomics.load(this.words, 3) >>> 0;
    if ((w - r) >>> 0 >= HANDOFF_CAPACITY) {
      Atomics.add(this.words, 4, 1);
      return false;
    }
    const offset = HEADER_WORDS + (w % HANDOFF_CAPACITY) * (RECORD_BYTES / 4);
    for (let i = 0; i < RECORD_BYTES / 4; i++)
      Atomics.store(this.words, offset + i, record[i]!);
    Atomics.store(this.words, 2, (w + 1) | 0);
    return true;
  }
  pop(out: Int32Array): boolean {
    if (out.length !== RECORD_BYTES / 4) return false;
    const r = Atomics.load(this.words, 3) >>> 0,
      w = Atomics.load(this.words, 2) >>> 0;
    if (r === w) return false;
    const offset = HEADER_WORDS + (r % HANDOFF_CAPACITY) * (RECORD_BYTES / 4);
    for (let i = 0; i < RECORD_BYTES / 4; i++)
      out[i] = Atomics.load(this.words, offset + i);
    Atomics.store(this.words, 3, (r + 1) | 0);
    return true;
  }
}
