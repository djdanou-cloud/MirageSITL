/** Integer-phase rational sampler. Call exactly once per physical tick. */
export class SensorScheduler {
  private phase = 0;
  private ticks = 0;
  constructor(
    readonly physicsHz: 400 | 800 | 1200,
    readonly sensorHz: number,
  ) {
    if (
      ![400, 800, 1200].includes(physicsHz) ||
      !Number.isInteger(sensorHz) ||
      sensorHz < 1 ||
      sensorHz > physicsHz
    )
      throw new Error("Invalid sampling rates");
  }
  reset(): void {
    this.phase = 0;
    this.ticks = 0;
  }
  /** Sample at the ending tick, never at construction/reset. */
  advance(): boolean {
    this.ticks++;
    this.phase += this.sensorHz;
    if (this.phase >= this.physicsHz) {
      this.phase -= this.physicsHz;
      return true;
    }
    return false;
  }
  /** Integer sample timestamp split into uint32 microseconds, no BigInt in step. */
  timeInto(out: { lo: number; hi: number }): void {
    const us = Math.floor((this.ticks * 1000000) / this.physicsHz);
    out.lo = us >>> 0;
    out.hi = Math.floor(us / 4294967296) >>> 0;
  }
}
