import type { AutopilotBackend } from "./adapter.ts";
import type { EkfStatus } from "./ekf-status.ts";
export interface WarmupSample {
  epoch: number;
  simTimeS: number;
  wallTimeMs: number;
  imuTimeS: number;
  gpsTimeS: number;
  health: EkfStatus;
}
/** Batch-boundary admission only. It cannot manufacture diagnostics or drive firmware time.
 * The external harness supplies the lockstep samples; live integration remains TASK-042.
 */
export class EkfWarmup {
  ready = false;
  ewAllowed = false;
  accelerationFactor = 0;
  reason = "Waiting for coherent sensors and autopilot diagnostics";
  private lastSim: number;
  private lastWall: number;
  constructor(
    readonly backend: AutopilotBackend,
    readonly epoch: number,
    private readonly startSimS: number,
    private readonly startWallMs: number,
    readonly speed = 1,
  ) {
    if (
      !["external-sitl", "wasm-sitl", "hitl"].includes(backend) ||
      epoch >>> 0 !== epoch ||
      ![startSimS, startWallMs, speed].every(Number.isFinite) ||
      startSimS < 0 ||
      startWallMs < 0 ||
      speed < 1 ||
      speed > 1000 ||
      (backend === "hitl" && speed !== 1)
    )
      throw new RangeError("Invalid warmup clock (HITL cannot fast-forward)");
    this.lastSim = startSimS;
    this.lastWall = startWallMs;
  }
  observe(s: WarmupSample): boolean {
    this.ready = this.ewAllowed = false;
    if (
      s.epoch !== this.epoch ||
      ![s.simTimeS, s.wallTimeMs, s.imuTimeS, s.gpsTimeS].every(
        Number.isFinite,
      ) ||
      s.simTimeS < this.lastSim ||
      s.wallTimeMs < this.lastWall
    ) {
      this.reason = "Warmup epoch or clock mismatch";
      return false;
    }
    this.lastSim = s.simTimeS;
    this.lastWall = s.wallTimeMs;
    const elapsed = s.simTimeS - this.startSimS,
      wall = s.wallTimeMs - this.startWallMs;
    this.accelerationFactor = wall > 0 ? (elapsed * 1000) / wall : 0;
    if (this.backend === "hitl" && elapsed > (wall / 1000) * 1.01 + 0.1) {
      this.reason = "HITL clock advanced faster than real time";
      return false;
    }
    if (
      s.imuTimeS > s.simTimeS ||
      s.gpsTimeS > s.simTimeS ||
      s.simTimeS - s.imuTimeS > 0.01 ||
      s.simTimeS - s.gpsTimeS > 0.3
    ) {
      this.reason = "Sensor timestamps are incoherent";
      return false;
    }
    if (elapsed < 30) {
      this.reason = "Warmup requires 30 simulated seconds";
      return false;
    }
    const h = s.health;
    if (
      h.source !== "autopilot" ||
      h.epoch !== this.epoch ||
      !h.healthy ||
      !h.heartbeatFresh ||
      !h.reportFresh ||
      !h.innovationHealthy ||
      h.flags !== 31 ||
      !Number.isFinite(h.ageMs) ||
      h.ageMs < 0 ||
      h.ageMs > 1000
    ) {
      this.reason = "Autopilot EKF diagnostics are unhealthy or stale";
      return false;
    }
    this.ready = this.ewAllowed = true;
    this.reason = "EKF health and warmup gate passed";
    return true;
  }
}
