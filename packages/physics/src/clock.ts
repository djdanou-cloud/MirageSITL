import { isPhysicsHz, tickToNumber, type PhysicsHz, type TickId } from '@mirage/protocol';

// Fixed-step clocks for 400/800/1200 Hz (docs/PROJECT_ROADMAP.md TASK-011).
// Integration dt is always exactly 1/hz; wall time only decides how many
// steps run per wakeup. Deadlines are computed from integer step counts
// (origin + n*1000/hz), never by repeatedly adding a rounded step length,
// so they cannot accumulate floating-point drift.

export const DEFAULT_MAX_CATCH_UP = 8;

export interface MultiRateClockOptions { hz?: PhysicsHz; maxCatchUp?: number }

/** Wall-clock pacing for interactive mode: bounded catch-up, excess wall time is dropped and counted. */
export class MultiRateClock {
  readonly hz: PhysicsHz;
  readonly maxCatchUp: number;
  readonly stepMs: number;
  /** Wall time (ms) of the next step deadline. */
  nextMs = 0;
  droppedSteps = 0;
  overruns = 0;
  /** Last integrated tick in the current epoch; tick 1 is the first integration. */
  readonly tick: TickId = { lo: 0, hi: 0 };
  private originMs = 0;
  /** Deadlines consumed since reset (executed + dropped); an exact integer below 2^53. */
  private scheduled = 0;

  constructor(options: MultiRateClockOptions = {}) {
    const hz = options.hz ?? 400, maxCatchUp = options.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
    if (!isPhysicsHz(hz)) throw new Error('Unsupported physics rate');
    if (!Number.isInteger(maxCatchUp) || maxCatchUp < 1) throw new Error('maxCatchUp must be a positive integer');
    this.hz = hz; this.maxCatchUp = maxCatchUp; this.stepMs = 1000 / hz;
  }

  /** Starts (or resumes) pacing at nowMs; the first deadline is one step later and no backlog carries over. */
  reset(nowMs: number): void {
    this.originMs = nowMs; this.scheduled = 0;
    this.nextMs = this.deadline(1);
  }
  /** Restarts the epoch: tick counter and diagnostics return to zero. */
  resetEpoch(nowMs: number): void {
    this.tick.lo = 0; this.tick.hi = 0; this.droppedSteps = 0; this.overruns = 0;
    this.reset(nowMs);
  }
  private deadline(n: number): number {
    return this.originMs + (n * 1000) / this.hz;
  }

  /**
   * Runs every due step (at most maxCatchUp), advancing `tick` before each
   * call. Remaining overdue deadlines are dropped and counted. Returns the
   * number of executed steps. Allocation-free.
   */
  advance(nowMs: number, step: (tick: TickId) => void): number {
    let count = 0;
    while (nowMs >= this.nextMs && count < this.maxCatchUp) {
      this.incrementTick();
      step(this.tick);
      count++; this.scheduled++;
      this.nextMs = this.deadline(this.scheduled + 1);
    }
    if (nowMs >= this.nextMs) {
      // Number of deadlines n with deadline(n) <= nowMs, computed from integers.
      const due = Math.floor(((nowMs - this.originMs) * this.hz) / 1000);
      const dropped = Math.max(1, due - this.scheduled);
      this.scheduled += dropped;
      this.nextMs = this.deadline(this.scheduled + 1);
      this.droppedSteps += dropped; this.overruns++;
    }
    return count;
  }
  /** Integrates one tick without wall-clock pacing (simulation-time lockstep). Allocation-free. */
  stepOnce(step: (tick: TickId) => void): void {
    this.incrementTick();
    step(this.tick);
  }
  private incrementTick(): void {
    this.tick.lo = (this.tick.lo + 1) >>> 0;
    if (this.tick.lo === 0) this.tick.hi = (this.tick.hi + 1) >>> 0;
  }
}

/**
 * Exact floor(tick * 1e6 / hz): MAVLink time_usec for a tick. At 1200 Hz
 * consecutive intervals are 833 or 834 microseconds and never accumulate
 * error. Returns NaN (without allocating) if the result would exceed 2^53 us
 * (about 285 years of simulated time).
 */
export function tickToMicros(tick: TickId, hz: PhysicsHz): number {
  return scaleTick(tick, 1_000_000, hz);
}

/**
 * Index of the sensor sample containing `tick`: floor(tick * sensorHz / hz).
 * A sample is due on a tick when this index increases. Rational, so a 200 Hz
 * IMU or 10 Hz GNSS stays phase-locked to 400/800/1200 Hz physics.
 */
export function sampleIndexAtTick(tick: TickId, sensorHz: number, hz: PhysicsHz): number {
  return scaleTick(tick, sensorHz, hz);
}
export function isSampleDue(tick: TickId, sensorHz: number, hz: PhysicsHz): boolean {
  const n = tickToNumber(tick);
  if (n === 0) return false;
  return floorScaled(n, sensorHz, hz) !== floorScaled(n - 1, sensorHz, hz);
}

function scaleTick(tick: TickId, numerator: number, hz: number): number {
  return floorScaled(tickToNumber(tick), numerator, hz);
}
/** floor(n * numerator / hz) using n = a*hz + b so that every product stays exact. */
function floorScaled(n: number, numerator: number, hz: number): number {
  let a = Math.floor(n / hz), b = n - a * hz;
  if (b < 0) { a--; b += hz; } else if (b >= hz) { a++; b -= hz; }
  const result = a * numerator + Math.floor((b * numerator) / hz);
  return result <= Number.MAX_SAFE_INTEGER ? result : NaN;
}
