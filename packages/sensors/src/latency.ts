/** Fixed-capacity monotonic latency FIFO, one numeric sample per slot.
 * Independent queues are required for different sample schemas/streams.
 */
export class LatencyQueue {
  private readonly times: Float64Array;
  private readonly values: Float64Array;
  private head = 0;
  private tail = 0;
  private count = 0;
  private lastDue = -Infinity;
  private lastPoll = -Infinity;
  dropped = 0;
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536)
      throw new Error("Invalid latency capacity");
    this.times = new Float64Array(capacity);
    this.values = new Float64Array(capacity);
  }
  reset(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.lastDue = -Infinity;
    this.lastPoll = -Infinity;
    this.dropped = 0;
  }
  push(sampleTimeUs: number, delayUs: number, value: number): boolean {
    const due = sampleTimeUs + delayUs;
    if (
      !Number.isSafeInteger(sampleTimeUs) ||
      sampleTimeUs < 0 ||
      !Number.isSafeInteger(delayUs) ||
      delayUs < 0 ||
      !Number.isSafeInteger(due) ||
      due < this.lastDue ||
      !Number.isFinite(value)
    )
      return false;
    if (this.count === this.capacity) {
      this.dropped++;
      return false;
    }
    this.times[this.tail] = due;
    this.values[this.tail] = value;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
    this.lastDue = due;
    return true;
  }
  pollInto(nowUs: number, out: Float64Array): boolean {
    if (
      out.length !== 2 ||
      !Number.isSafeInteger(nowUs) ||
      nowUs < this.lastPoll
    )
      return false;
    this.lastPoll = nowUs;
    if (this.count === 0 || this.times[this.head]! > nowUs) return false;
    out[0] = this.times[this.head]!;
    out[1] = this.values[this.head]!;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return true;
  }
}
