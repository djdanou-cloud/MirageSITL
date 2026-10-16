import type { MavFrame } from "@mirage/mavlink/codec";
import { EkfFlagV2 } from "@mirage/protocol";
export interface EkfStatus {
  source: "autopilot";
  epoch: number;
  flags: number;
  healthy: boolean;
  mode: number | null;
  ageMs: number;
  heartbeatFresh: boolean;
  reportFresh: boolean;
  innovationHealthy: boolean;
}
/** Low-rate I/O diagnostics. Input frames must already pass MavParser CRC/dialect validation.
 * Bound to one configured FC identity; timestamps use sim ms for SITL and monotonic wall ms for HITL.
 */
export class EkfMonitor {
  private heartbeatMs = -Infinity;
  private reportMs = -Infinity;
  private flags = 0;
  private innovations = false;
  private mode: number | null = null;
  constructor(
    readonly systemId: number,
    readonly componentId: number,
    readonly epoch: number,
    readonly staleMs = 1000,
  ) {
    if (
      !Number.isInteger(systemId) ||
      systemId < 1 ||
      systemId > 255 ||
      !Number.isInteger(componentId) ||
      componentId < 0 ||
      componentId > 255 ||
      epoch >>> 0 !== epoch ||
      !Number.isFinite(staleMs) ||
      staleMs <= 0
    )
      throw new RangeError("Invalid EKF monitor identity");
  }
  ingest(frame: MavFrame, receivedMs: number): boolean {
    if (
      frame.systemId !== this.systemId ||
      frame.componentId !== this.componentId ||
      !Number.isFinite(receivedMs) ||
      receivedMs < 0
    )
      return false;
    const v = frame.view;
    if (frame.id === 0) {
      if (
        receivedMs < this.heartbeatMs ||
        v.getUint8(5) !== 3 ||
        v.getUint8(8) !== 3
      )
        return false;
      this.mode = v.getUint32(0, true);
      this.heartbeatMs = receivedMs;
      return true;
    }
    if (frame.id !== 193 || receivedMs < this.reportMs) return false;
    const raw = v.getUint16(20, true);
    let mapped = 0;
    if (raw & 1) mapped |= EkfFlagV2.AttitudeValid;
    if (raw & 2) mapped |= EkfFlagV2.HorizontalVelocityValid;
    if (raw & 4) mapped |= EkfFlagV2.VerticalVelocityValid;
    if (raw & 16) mapped |= EkfFlagV2.AbsoluteHorizontalPositionValid;
    if (raw & 32) mapped |= EkfFlagV2.AbsoluteVerticalPositionValid;
    let valid = (raw & 1024) === 0;
    for (let i = 0; i < 5; i++) {
      const ratio = v.getFloat32(i * 4, true);
      if (!Number.isFinite(ratio) || ratio < 0 || ratio >= 1) valid = false;
    }
    this.flags = mapped;
    this.innovations = valid;
    this.reportMs = receivedMs;
    return true;
  }
  snapshot(nowMs: number): EkfStatus {
    const heartbeatFresh =
      Number.isFinite(nowMs) &&
      nowMs >= this.heartbeatMs &&
      nowMs - this.heartbeatMs <= this.staleMs;
    const reportFresh =
      Number.isFinite(nowMs) &&
      nowMs >= this.reportMs &&
      nowMs - this.reportMs <= this.staleMs;
    return {
      source: "autopilot",
      epoch: this.epoch,
      flags: this.flags,
      healthy:
        heartbeatFresh && reportFresh && this.innovations && this.flags === 31,
      mode: heartbeatFresh ? this.mode : null,
      ageMs: Math.max(nowMs - this.heartbeatMs, nowMs - this.reportMs),
      heartbeatFresh,
      reportFresh,
      innovationHealthy: this.innovations,
    };
  }
}
