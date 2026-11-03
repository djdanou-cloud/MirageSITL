import { SeededRandom } from '@mirage/test-support/prng';
import { WEATHER_GUST_RMS, WEATHER_SEED, WEATHER_WIND_DOWN, WEATHER_WIND_EAST, WEATHER_WIND_NORTH } from './atmosphere.ts';
export interface WindConfig {
  meanNedMps: readonly [number, number, number]; gustRmsMps: number;
  /** The physics rate; 4800 Hz is the BET convergence rate (TASK-033). */
  bandwidthHz: number; hz: 400 | 800 | 1200 | 4800;
}
/** Synthetic bounded-innovation first-order gust; not a Dryden turbulence model. */
export class Wind {
  private readonly mean: Float64Array;
  private readonly state = new Float64Array(3);
  private readonly streams: readonly SeededRandom[];
  private readonly decay: number;
  /** The innovation gain; a typed slot, because a weather.set rewrites it on the step and V8 can box a double field. */
  private readonly scale = new Float64Array(1);
  constructor(config: WindConfig, seed: number) {
    if (config.meanNedMps.length !== 3 || !config.meanNedMps.every(value => Number.isFinite(value) && Math.abs(value) <= 200) ||
      !Number.isFinite(config.gustRmsMps) || config.gustRmsMps < 0 || config.gustRmsMps > 50 ||
      !Number.isFinite(config.bandwidthHz) || config.bandwidthHz <= 0 || config.bandwidthHz >= config.hz / 2 ||
      ![400, 800, 1200, 4800].includes(config.hz)) throw new Error('Invalid wind configuration');
    this.mean = new Float64Array(config.meanNedMps);
    this.streams = [new SeededRandom(seed, 0), new SeededRandom(seed, 1), new SeededRandom(seed, 2)];
    this.decay = Math.exp(-2 * Math.PI * config.bandwidthHz / config.hz);
    if (this.decay >= 1) throw new Error('Wind bandwidth is below numerical resolution');
    this.scale[0] = config.gustRmsMps * Math.sqrt(3 * (1 - this.decay * this.decay));
  }
  /**
   * Sets the mean wind, the gust RMS and the seed in place from `weather` (its WEATHER_* slots: TASK-093, a weather.set at a
   * tick boundary), keeping the bandwidth and rate of construction; the gust starts again from the seed. The caller checks
   * the envelope of the constructor. Allocation-free.
   */
  configure(weather: Float64Array): void {
    this.mean[0] = weather[WEATHER_WIND_NORTH]!; this.mean[1] = weather[WEATHER_WIND_EAST]!; this.mean[2] = weather[WEATHER_WIND_DOWN]!;
    this.scale[0] = weather[WEATHER_GUST_RMS]! * Math.sqrt(3 * (1 - this.decay * this.decay));
    this.state.fill(0);
    for (let axis = 0; axis < 3; axis++) this.streams[axis]!.resetFrom(weather, WEATHER_SEED, axis);
  }
  reset(seed: number): void {
    this.state.fill(0);
    for (let axis = 0; axis < 3; axis++) this.streams[axis]!.reset(seed, axis);
  }
  /** Caller owns a length >=3 output; fixed three-axis storage proves indices. */
  stepInto(out: Float64Array): void {
    for (let axis = 0; axis < 3; axis++) {
      this.state[axis] = this.decay * this.state[axis]! + this.scale[0]! * (2 * this.streams[axis]!.nextFloat() - 1);
      out[axis] = this.mean[axis]! + this.state[axis]!;
    }
  }
}
