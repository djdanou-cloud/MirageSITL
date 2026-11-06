import type { BridgeRecord } from "./framing.ts";
/** One epoch per authenticated socket; reconnect must explicitly start another session. */
/** Records a client may send per wall second when nothing more is known of its run: MAVLink and pilot traffic at real time. */
export const DEFAULT_MESSAGE_LIMIT = 4096;
/**
 * The limit for a lockstep run: one physics record per step comes on top of the default. A flat limit would close any run faster than
 * 4096 / rate times real time, about 5.1 times at 800 Hz, however good its records are. It stays a limit, on what this run asks for.
 */
export const messageLimitFor = (rateHz: number, speedup: number): number => DEFAULT_MESSAGE_LIMIT + Math.ceil(rateHz * speedup);
export class BridgeSession {
  private readonly sequence = new Float64Array([-1, -1, -1]);
  private count = 0;
  private windowMs = -1;
  constructor(
    readonly epoch: number,
    private readonly limit = DEFAULT_MESSAGE_LIMIT,
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
