import { SeededRandom } from "@mirage/test-support/prng";
/** Stationary colored Gaussian noise plus independent bias random walk.
 * sigma is post-filter RMS; pole Hz is explicit, not an unqualified noise PSD.
 */
export class SensorNoise {
  private readonly random: SeededRandom;
  private readonly biasRandom: SeededRandom;
  private readonly state = new Float64Array(2);
  private readonly decay: number;
  private readonly gain: number;
  private readonly biasGain: number;
  constructor(
    seed: number,
    private readonly streamId: number,
    readonly hz: number,
    readonly rms: number,
    readonly bandwidthHz: number,
    readonly biasWalkPerSqrtS = 0,
  ) {
    if (
      !Number.isInteger(hz) ||
      hz < 1 ||
      ![rms, bandwidthHz, biasWalkPerSqrtS].every(Number.isFinite) ||
      rms < 0 ||
      biasWalkPerSqrtS < 0 ||
      bandwidthHz <= 0 ||
      bandwidthHz >= hz / 2 ||
      !Number.isInteger(streamId) ||
      streamId < 0 ||
      streamId > 0x7fffffff
    )
      throw new Error("Invalid sensor noise configuration");
    this.random = new SeededRandom(seed, streamId * 2);
    this.biasRandom = new SeededRandom(seed, streamId * 2 + 1);
    this.decay = Math.exp((-2 * Math.PI * bandwidthHz) / hz);
    if (this.decay >= 1)
      throw new Error("Noise bandwidth below numerical resolution");
    this.gain = rms * Math.sqrt(1 - this.decay * this.decay);
    this.biasGain = biasWalkPerSqrtS / Math.sqrt(hz);
  }
  reset(seed: number): void {
    this.random.reset(seed, this.streamId * 2);
    this.biasRandom.reset(seed, this.streamId * 2 + 1);
    this.state.fill(0);
  }
  private gaussian(rng: SeededRandom): number {
    return (
      Math.sqrt(-2 * Math.log(1 - rng.nextFloat())) *
      Math.cos(2 * Math.PI * rng.nextFloat())
    );
  }
  /** Fixed work, no rejection loops, arrays or per-sample allocation. */
  sampleInto(values: Float64Array, out: Float64Array, index = 0): boolean {
    if (
      index >>> 0 !== index ||
      index >= values.length ||
      index >= out.length ||
      !Number.isFinite(values[index])
    )
      return false;
    this.state[0] =
      this.decay * this.state[0]! + this.gain * this.gaussian(this.random);
    this.state[1] =
      this.state[1]! + this.biasGain * this.gaussian(this.biasRandom);
    out[index] = values[index]! + this.state[0] + this.state[1];
    return true;
  }
}
