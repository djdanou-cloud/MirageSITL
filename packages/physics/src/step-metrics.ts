// Hot-path metrics (docs/PROJECT_ROADMAP.md TASK-014). Recording is
// allocation-free: a fixed-bin histogram over preallocated typed arrays.
// Percentiles are computed outside the hot path. Compute duration, wakeup
// lateness, and executed rate are kept as separate metrics (G1/G3).

/** Fixed-width histogram with an overflow bin and an exact maximum. */
export class FixedHistogram {
  readonly binWidth: number;
  readonly binCount: number;
  private readonly bins: Uint32Array;
  count = 0;
  sum = 0;
  max = 0;
  min = Infinity;

  constructor(binWidth: number, binCount: number) {
    if (!(binWidth > 0) || !Number.isInteger(binCount) || binCount < 1) throw new Error('Invalid histogram shape');
    this.binWidth = binWidth; this.binCount = binCount;
    this.bins = new Uint32Array(binCount + 1); // last bin collects values >= binWidth * binCount
  }
  /** Records one nonnegative finite sample; others are ignored. Allocation-free. */
  record(value: number): void {
    if (!(value >= 0) || value === Infinity) return;
    const index = Math.min(this.binCount, Math.floor(value / this.binWidth));
    this.bins[index]!++;
    this.count++; this.sum += value;
    if (value > this.max) this.max = value;
    if (value < this.min) this.min = value;
  }
  reset(): void {
    this.bins.fill(0); this.count = 0; this.sum = 0; this.max = 0; this.min = Infinity;
  }
  get mean(): number { return this.count === 0 ? NaN : this.sum / this.count; }
  /** Samples that fell beyond the histogram range (their exact maximum is still `max`). */
  get overflow(): number { return this.bins[this.binCount]!; }
  /**
   * Upper bound of the bin holding the q-quantile (0 < q <= 1): a conservative
   * estimate within one bin width, never below the true quantile. Returns the
   * exact maximum when the quantile lies in the overflow bin. NaN when empty.
   */
  quantile(q: number): number {
    if (this.count === 0 || !(q > 0 && q <= 1)) return NaN;
    const rank = Math.ceil(q * this.count);
    let seen = 0;
    for (let i = 0; i < this.binCount; i++) {
      seen += this.bins[i]!;
      if (seen >= rank) return Math.min(this.max, (i + 1) * this.binWidth);
    }
    return this.max;
  }
}

export interface DistributionSummary {
  count: number; mean: number; p50: number; p95: number; p99: number; max: number; overflow: number; binWidth: number;
}
export function summarize(histogram: FixedHistogram): DistributionSummary {
  return { count: histogram.count, mean: histogram.mean, p50: histogram.quantile(0.5), p95: histogram.quantile(0.95),
    p99: histogram.quantile(0.99), max: histogram.max, overflow: histogram.overflow, binWidth: histogram.binWidth };
}

/**
 * Per-session step metrics: compute duration of each wakeup (microseconds),
 * wakeup lateness against the scheduled deadline (milliseconds), and executed
 * steps over a wall-clock window. Allocate once; record on the hot path.
 */
export class StepMetrics {
  /** 0.1 us bins up to 5 ms. */
  readonly computeUs = new FixedHistogram(0.1, 50_000);
  /** 0.01 ms bins up to 100 ms. */
  readonly latenessMs = new FixedHistogram(0.01, 10_000);
  executedSteps = 0;
  droppedSteps = 0;
  windowStartMs = NaN;
  windowEndMs = NaN;

  recordWakeup(computeUs: number, latenessMs: number, executed: number, dropped: number, nowMs: number): void {
    this.computeUs.record(computeUs);
    this.latenessMs.record(latenessMs);
    this.executedSteps += executed; this.droppedSteps += dropped;
    if (!(this.windowStartMs <= nowMs)) this.windowStartMs = nowMs;
    this.windowEndMs = nowMs;
  }
  /** Executed steps per second over the recorded window. */
  get executedHz(): number {
    const seconds = (this.windowEndMs - this.windowStartMs) / 1000;
    return seconds > 0 ? this.executedSteps / seconds : NaN;
  }
  reset(): void {
    this.computeUs.reset(); this.latenessMs.reset();
    this.executedSteps = 0; this.droppedSteps = 0; this.windowStartMs = NaN; this.windowEndMs = NaN;
  }
}
