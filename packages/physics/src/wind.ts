import { SeededRandom } from '@mirage/test-support/prng';
export interface WindConfig {
  meanNedMps: readonly [number, number, number]; gustRmsMps: number;
  bandwidthHz: number; hz: 400 | 800 | 1200;
}
/** Synthetic bounded-innovation first-order gust; not a Dryden turbulence model. */
export class Wind {
  private readonly mean: Float64Array;
  private readonly state = new Float64Array(3);
  private readonly streams: readonly SeededRandom[];
  private readonly decay: number;
  private readonly scale: number;
  constructor(config: WindConfig, seed: number) {
    if (config.meanNedMps.length !== 3 || !config.meanNedMps.every(value => Number.isFinite(value) && Math.abs(value) <= 200) ||
      !Number.isFinite(config.gustRmsMps) || config.gustRmsMps < 0 || config.gustRmsMps > 50 ||
      !Number.isFinite(config.bandwidthHz) || config.bandwidthHz <= 0 || config.bandwidthHz >= config.hz / 2 ||
      ![400, 800, 1200].includes(config.hz)) throw new Error('Invalid wind configuration');
    this.mean = new Float64Array(config.meanNedMps);
    this.streams = [new SeededRandom(seed, 0), new SeededRandom(seed, 1), new SeededRandom(seed, 2)];
    this.decay = Math.exp(-2 * Math.PI * config.bandwidthHz / config.hz);
    if (this.decay >= 1) throw new Error('Wind bandwidth is below numerical resolution');
    this.scale = config.gustRmsMps * Math.sqrt(3 * (1 - this.decay * this.decay));
  }
  reset(seed: number): void {
    this.state.fill(0);
    for (let axis = 0; axis < 3; axis++) this.streams[axis]!.reset(seed, axis);
  }
  /** Caller owns a length >=3 output; fixed three-axis storage proves indices. */
  stepInto(out: Float64Array): void {
    for (let axis = 0; axis < 3; axis++) {
      this.state[axis] = this.decay * this.state[axis]! + this.scale * (2 * this.streams[axis]!.nextFloat() - 1);
      out[axis] = this.mean[axis]! + this.state[axis]!;
    }
  }
}
