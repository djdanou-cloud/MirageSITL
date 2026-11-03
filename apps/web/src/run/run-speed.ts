// Run speed of an integrated session (TASK-175, S10, decision A-05). In JSON
// lockstep every physics step answers one SITL frame, so a real-time run and
// an accelerated run take the same step sequence; only ArduPilot's own
// --speedup pacing differs, and acceleration is limited by the host, never
// reached by skipping steps. The meter measures what happens: simulated time
// over wall time with paused wall time left out, over the last WINDOW_S and
// over the whole run. A real-time run counts as real time only while it
// averages at least REAL_TIME_MIN_RATIO (A-05). Every INTERVAL_S of running
// wall time in which a real-time run advanced less than that ratio is a
// dropped interval, and every one is kept and reported. The run is judged
// from begin(), which the session controller calls at the autopilot's first
// heartbeat: before it SITL boots, which on the reference Mac took about
// 10 s of wall time for 2 s of simulated time. That start-up is measured and
// shown on its own, never folded into the run's verdict or hidden. Cold path:
// one sample per Worker status.

/** A-05: a real-time run averages at least this much simulated time per wall-clock second. */
export const REAL_TIME_MIN_RATIO = 0.99;
/** The wall-time length of one judged interval, s. */
export const INTERVAL_S = 1;
/** The displayed current speed is measured over this much running wall time, s. */
export const WINDOW_S = 5;
/** The --speedup of "as fast as possible": the launcher's largest, which no host reaches, so the host sets the pace. */
export const AS_FAST_AS_POSSIBLE = 100;

/** The requested pace: real time, a cap above it, as fast as the host runs, or a SITL the user started, whose own command line sets it. */
export type SpeedMode = "real-time" | "capped" | "as-fast-as-possible" | "external";
export function speedModeOf(speedup: number | null): SpeedMode {
  if (speedup === null) return "external";
  if (speedup === 1) return "real-time";
  return speedup >= AS_FAST_AS_POSSIBLE ? "as-fast-as-possible" : "capped";
}

/** One interval of a real-time run that advanced less than REAL_TIME_MIN_RATIO of its wall time. */
export interface DroppedInterval {
  /** 0 for the first INTERVAL_S of running wall time. */
  readonly index: number;
  /** The interval's start in running wall time and in simulated time, s. */
  readonly startWallS: number;
  readonly startSimS: number;
  readonly simAdvancedS: number;
}
export interface RunSpeedView {
  readonly mode: SpeedMode;
  /** The --speedup the launcher passed to SITL; null for a SITL the user started. */
  readonly requestedSpeedup: number | null;
  /** Simulated over running wall time over the last WINDOW_S; null before any running wall time. */
  readonly windowSpeed: number | null;
  /** The same over the whole run. */
  readonly averageSpeed: number | null;
  /** Running wall time and the simulated time it covered, s. */
  readonly runningWallS: number;
  readonly simElapsedS: number;
  /** Completed intervals; a real-time run's dropped ones, oldest first. */
  readonly intervals: number;
  readonly dropped: readonly DroppedInterval[];
  /** A real-time run with at least one completed interval: true while it averages at least REAL_TIME_MIN_RATIO; null otherwise. */
  readonly realTime: boolean | null;
  /** SITL's start-up before begin(): the simulated time it covered and its wall time without pauses, s; null before any sample. */
  readonly startup: { readonly simS: number; readonly wallS: number } | null;
}

interface Sample { readonly wallS: number; readonly simS: number }

export class RunSpeedMeter {
  readonly mode: SpeedMode;
  private samples: Sample[] = [];
  private firstSimS = 0;
  /** Running wall time, ms, summed from the clock's own differences so that intervals close at exact boundaries. */
  private runningWallMs = 0;
  private get runningWallS(): number { return this.runningWallMs / 1000; }
  /** Wall time of the latest sample, ms; null before the first and while paused. */
  private lastWallMs: number | null = null;
  private started = false;
  private paused = false;
  private intervals = 0;
  private boundarySimS = 0;
  private dropped: readonly DroppedInterval[] = [];
  private begun = false;
  /** Start-up before begin(): its first sample, the latest, and its paused wall time, ms. */
  private startupFirst: { readonly wallMs: number; readonly simS: number } | null = null;
  private startupLast: { readonly wallMs: number; readonly simS: number } | null = null;
  private startupPausedMs = 0;
  private startupPausedAtMs: number | null = null;

  constructor(readonly requestedSpeedup: number | null) {
    if (requestedSpeedup !== null && !(Number.isFinite(requestedSpeedup) && requestedSpeedup > 0)) throw new Error("The requested speed-up must be positive");
    this.mode = speedModeOf(requestedSpeedup);
  }

  /** The run is judged from here on, the autopilot's first heartbeat; what came before is its start-up. */
  begin(wallMs: number, simTimeS: number): void {
    if (this.begun) return;
    if (this.startupFirst === null) this.startupFirst = { wallMs, simS: simTimeS };
    this.startupLast = { wallMs, simS: simTimeS };
    this.begun = true;
    if (!this.paused) this.sample(wallMs, simTimeS);
  }
  /** The session's simulated time at a wall time; ignored while paused. */
  sample(wallMs: number, simTimeS: number): void {
    if (!Number.isFinite(wallMs) || !Number.isFinite(simTimeS) || this.paused) return;
    if (!this.begun) {
      if (this.startupFirst === null) this.startupFirst = { wallMs, simS: simTimeS };
      this.startupLast = { wallMs, simS: simTimeS };
      return;
    }
    if (!this.started) {
      this.started = true;
      this.firstSimS = this.boundarySimS = simTimeS;
      this.samples = [{ wallS: 0, simS: simTimeS }];
      this.lastWallMs = wallMs;
      return;
    }
    const last = this.samples[this.samples.length - 1];
    if (this.lastWallMs === null || !last || wallMs < this.lastWallMs || simTimeS < last.simS) return;
    this.runningWallMs += wallMs - this.lastWallMs;
    this.lastWallMs = wallMs;
    this.samples.push({ wallS: this.runningWallS, simS: simTimeS });
    this.closeIntervals(last);
    this.trim();
  }
  /** The run paused at `simTimeS`: the wall time until resume() is not running time. */
  pause(wallMs: number, simTimeS: number): void {
    if (this.paused) return;
    this.sample(wallMs, simTimeS);
    this.paused = true;
    this.lastWallMs = null;
    if (!this.begun) this.startupPausedAtMs = wallMs;
  }
  resume(wallMs: number): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.started) this.lastWallMs = wallMs;
    if (this.startupPausedAtMs !== null) { this.startupPausedMs += wallMs - this.startupPausedAtMs; this.startupPausedAtMs = null; }
  }

  get view(): RunSpeedView {
    const last = this.samples[this.samples.length - 1];
    const elapsed = last ? last.simS - this.firstSimS : 0, wall = this.runningWallS;
    let windowSpeed: number | null = null;
    if (last && wall > 0) {
      const from = Math.max(0, wall - WINDOW_S);
      windowSpeed = (last.simS - this.simAt(from)) / (wall - from);
    }
    const averageSpeed = wall > 0 ? elapsed / wall : null;
    return {
      mode: this.mode, requestedSpeedup: this.requestedSpeedup, windowSpeed, averageSpeed, runningWallS: wall, simElapsedS: elapsed,
      intervals: this.intervals, dropped: this.dropped,
      realTime: this.mode === "real-time" && this.intervals > 0 && averageSpeed !== null ? averageSpeed >= REAL_TIME_MIN_RATIO : null,
      startup: this.startupFirst && this.startupLast
        ? { simS: this.startupLast.simS - this.startupFirst.simS, wallS: (this.startupLast.wallMs - this.startupFirst.wallMs - this.startupPausedMs) / 1000 } : null,
    };
  }

  /** Closes every interval whose end lies at or before the newest sample, between `before` and it. */
  private closeIntervals(before: Sample): void {
    const newest = this.samples[this.samples.length - 1];
    if (!newest) return;
    while ((this.intervals + 1) * INTERVAL_S <= newest.wallS) {
      const endWallS = (this.intervals + 1) * INTERVAL_S;
      const span = newest.wallS - before.wallS;
      const endSimS = span > 0 ? before.simS + (newest.simS - before.simS) * (endWallS - before.wallS) / span : newest.simS;
      const advanced = endSimS - this.boundarySimS;
      if (this.mode === "real-time" && advanced < REAL_TIME_MIN_RATIO * INTERVAL_S) {
        this.dropped = [...this.dropped, { index: this.intervals, startWallS: endWallS - INTERVAL_S, startSimS: this.boundarySimS, simAdvancedS: advanced }];
      }
      this.boundarySimS = endSimS;
      this.intervals++;
      before = { wallS: endWallS, simS: endSimS };
    }
  }
  /** Simulated time at a running wall time, interpolated between the kept samples. */
  private simAt(wallS: number): number {
    const samples = this.samples;
    let previous = samples[0];
    if (!previous || wallS <= previous.wallS) return previous?.simS ?? 0;
    for (let i = 1; i < samples.length; i++) {
      const next = samples[i];
      if (!next) break;
      if (next.wallS >= wallS) {
        const span = next.wallS - previous.wallS;
        return span > 0 ? previous.simS + (next.simS - previous.simS) * (wallS - previous.wallS) / span : next.simS;
      }
      previous = next;
    }
    return previous.simS;
  }
  /** Keeps the samples the window needs, and the one before it. */
  private trim(): void {
    const keepFrom = this.runningWallS - WINDOW_S;
    let first = 0;
    while (first + 1 < this.samples.length && (this.samples[first + 1]?.wallS ?? Infinity) <= keepFrom) first++;
    if (first > 0) this.samples = this.samples.slice(first);
  }
}
