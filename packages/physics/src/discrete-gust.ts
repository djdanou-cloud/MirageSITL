import { WEATHER_DISCRETE_DOWN, WEATHER_DISCRETE_DURATION, WEATHER_DISCRETE_EAST, WEATHER_DISCRETE_KEEP, WEATHER_DISCRETE_NORTH } from './atmosphere.ts';

// The discrete gust (TASK-167, SPECS_SIMULATION_ENGINES "Weather tab: TASK-167"): the one-minus-cosine pulse of MIL-F-8785C 3.7.4,
// in time. On the k-th tick of a pulse of duration T at physics rate f, u_k = g/2 (1 - cos(2 pi k / (f T))) for k <= f T, and 0 after;
// k = 0 on the tick the control takes effect. It is one uniform field added to the wind of the CG and of every rotor hub. The state
// lives in typed slots, because a double object field can box on the step (TASK-093).

/** The model's envelope: the effect catalog's amplitude and duration ranges. */
export const DISCRETE_GUST_MAX_AMPLITUDE_MPS = 50, DISCRETE_GUST_MIN_DURATION_S = 0.1, DISCRETE_GUST_MAX_DURATION_S = 60;
const TICK = 0, DURATION = 1, ACTIVE = 2;

export class DiscreteGust {
  /** The peak air velocity, NED m/s. */
  private readonly peak = new Float64Array(3);
  /** The tick of the pulse, its duration in s, and whether it runs. */
  private readonly pulse = new Float64Array(3);
  constructor(private readonly hz: number) {
    if (!Number.isInteger(hz) || hz <= 0) throw new Error('Invalid discrete gust rate');
  }
  /** Whether a weather.set's discrete-gust slots lie in the envelope (a duration of 0 is none). Allocation-free. */
  static admits(weather: Float64Array): boolean {
    const duration = weather[WEATHER_DISCRETE_DURATION]!, north = weather[WEATHER_DISCRETE_NORTH]!, east = weather[WEATHER_DISCRETE_EAST]!, down = weather[WEATHER_DISCRETE_DOWN]!;
    if (duration === 0) return true;
    return duration >= DISCRETE_GUST_MIN_DURATION_S && duration <= DISCRETE_GUST_MAX_DURATION_S &&
      north * north + east * east + down * down <= DISCRETE_GUST_MAX_AMPLITUDE_MPS * DISCRETE_GUST_MAX_AMPLITUDE_MPS;
  }
  /** Whether a pulse is under way: started and not yet back at zero. */
  get running(): boolean { return this.pulse[ACTIVE] === 1; }
  /**
   * Reads a weather.set's discrete-gust slots (atmosphere.ts WEATHER_DISCRETE_*). A duration of 0 means none; otherwise the peak and the
   * duration must lie in the envelope. With KEEP = 1 a running pulse goes on; with 0 a new one starts on this tick. Returns false,
   * changing nothing, outside the envelope. Allocation-free.
   */
  configure(weather: Float64Array): boolean {
    if (!DiscreteGust.admits(weather)) return false;
    const duration = weather[WEATHER_DISCRETE_DURATION]!;
    if (duration === 0) { this.pulse[ACTIVE] = 0; return true; }
    if (weather[WEATHER_DISCRETE_KEEP] === 1) return true;
    const north = weather[WEATHER_DISCRETE_NORTH]!, east = weather[WEATHER_DISCRETE_EAST]!, down = weather[WEATHER_DISCRETE_DOWN]!;
    this.peak[0] = north; this.peak[1] = east; this.peak[2] = down;
    this.pulse[TICK] = 0; this.pulse[DURATION] = duration; this.pulse[ACTIVE] = 1;
    return true;
  }
  /** Ends any pulse at once. */
  stop(): void { this.pulse[ACTIVE] = 0; }
  /** Adds this tick's gust to `windNed` (length >= 3) and advances one tick. Allocation-free. */
  stepAddInto(windNed: Float64Array): void {
    const pulse = this.pulse;
    if (pulse[ACTIVE] !== 1) return;
    const k = pulse[TICK]!, ticks = this.hz * pulse[DURATION]!;
    if (k > ticks) { pulse[ACTIVE] = 0; return; }
    const shape = 0.5 * (1 - Math.cos(2 * Math.PI * k / ticks)), peak = this.peak;
    windNed[0] = windNed[0]! + shape * peak[0]!; windNed[1] = windNed[1]! + shape * peak[1]!; windNed[2] = windNed[2]! + shape * peak[2]!;
    pulse[TICK] = k + 1;
  }
}

/** The peak air velocity of a gust from `fromDeg` at `upwardDeg` above the horizontal, NED m/s: a gust from the north blows south. */
export function discreteGustPeakNedMps(amplitudeMps: number, fromDeg: number, upwardDeg: number): [number, number, number] {
  const from = fromDeg * Math.PI / 180, up = upwardDeg * Math.PI / 180, horizontal = amplitudeMps * Math.cos(up);
  return [-horizontal * Math.cos(from), -horizontal * Math.sin(from), -amplitudeMps * Math.sin(up)];
}
