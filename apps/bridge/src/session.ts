import type { BridgeRecord } from "./framing.ts";
/** One epoch per authenticated socket; reconnect must explicitly start another session. */
export class BridgeSession {
  private readonly sequence = new Float64Array([-1, -1, -1]);
  private count = 0;
  private windowMs = -1;
  constructor(
    readonly epoch: number,
    private readonly limit = 4096,
  ) {
    if (epoch >>> 0 !== epoch || !Number.isInteger(limit) || limit < 1)
      throw new Error("Invalid bridge session");
  }
  accept(frame: BridgeRecord, nowMs: number): boolean {
    if (!Number.isFinite(nowMs) || nowMs < 0 || frame.epoch !== this.epoch)
      return false;
    const window = Math.floor(nowMs / 1000);
    if (window < this.windowMs) return false;
    if (window !== this.windowMs) {
      this.windowMs = window;
      this.count = 0;
    }
    if (++this.count > this.limit) return false;
    const i = frame.channel - 1,
      last = this.sequence[i]!;
    if (last >= 0) {
      const delta = (frame.sequence - last) >>> 0;
      if (delta === 0 || delta > 0x7fffffff) return false;
    }
    this.sequence[i] = frame.sequence;
    return true;
  }
}
