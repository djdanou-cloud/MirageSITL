import type {
  AutopilotBackend,
  AutopilotHealth,
  AutopilotState,
} from "./adapter.ts";
import { isIssuedHitlReady } from "./hitl-capabilities.ts";
/** Protocol/lifecycle reference. Readiness requires fresh autopilot-sourced health. */
export class AutopilotSession {
  private phase: AutopilotState = "disconnected";
  get state(): AutopilotState {
    return this.phase;
  }
  backend: AutopilotBackend | null = null;
  epoch = 0;
  faultReason = "";
  readonly actuators = new Float64Array(16);
  private healthTimeMs = -Infinity;
  private actuatorTimeMs = -Infinity;
  private lastNowMs = 0;
  private readonly nowInput = new Float64Array(1);
  private readonly sampleInput = new Float64Array(1);
  constructor(private readonly staleMs = 100) {
    if (!Number.isFinite(staleMs) || staleMs <= 0 || staleMs > 1000)
      throw new Error("Invalid autopilot timeout");
  }
  /**
   * "hitl" additionally requires a READY verdict issued by
   * evaluateHitlCapability (TASK-050); SITL readiness never implies HITL.
   */
  connect(backend: AutopilotBackend, epoch: number, nowMs: number, hitlCapability?: unknown): boolean {
    if (
      this.state !== "disconnected" ||
      (backend === "hitl" && !isIssuedHitlReady(hitlCapability)) ||
      (backend !== "external-sitl" &&
        backend !== "wasm-sitl" &&
        backend !== "hitl") ||
      epoch >>> 0 !== epoch ||
      !Number.isFinite(nowMs) ||
      nowMs < 0
    )
      return false;
    this.backend = backend;
    this.epoch = epoch;
    this.phase = "initializing";
    this.lastNowMs = nowMs;
    this.healthTimeMs = this.actuatorTimeMs = -Infinity;
    this.actuators.fill(0);
    return true;
  }
  initialized(): boolean {
    if (this.state !== "initializing") return false;
    this.phase = "warming";
    return true;
  }
  health(value: AutopilotHealth, nowMs: number): boolean {
    this.nowInput[0] = nowMs;
    return this.healthAt(value, this.nowInput);
  }
  healthAt(value: AutopilotHealth, clockMs: Float64Array): boolean {
    if (clockMs.length !== 1) return false;
    const nowMs = clockMs[0]!;
    if (
      value.source !== "autopilot" ||
      value.epoch !== this.epoch ||
      !Number.isFinite(nowMs) ||
      nowMs < this.lastNowMs ||
      !Number.isFinite(value.sampleTimeMs) ||
      value.sampleTimeMs > nowMs ||
      value.sampleTimeMs < this.healthTimeMs ||
      nowMs - value.sampleTimeMs > this.staleMs
    )
      return false;
    if (
      this.state !== "warming" &&
      this.state !== "ready" &&
      this.state !== "running"
    )
      return false;
    this.lastNowMs = nowMs;
    this.healthTimeMs = value.sampleTimeMs;
    if (!value.linkHealthy || !value.ekfHealthy) {
      this.fault("Autopilot health failed");
      return false;
    }
    if (this.phase === "warming") this.phase = "ready";
    return true;
  }
  acceptActuators(
    values: Float64Array,
    epoch: number,
    sampleTimeMs: number,
    nowMs: number,
  ): boolean {
    this.nowInput[0] = nowMs;
    this.sampleInput[0] = sampleTimeMs;
    return this.acceptActuatorsAt(
      values,
      epoch,
      this.sampleInput,
      this.nowInput,
    );
  }
  acceptActuatorsAt(
    values: Float64Array,
    epoch: number,
    sampleMs: Float64Array,
    clockMs: Float64Array,
  ): boolean {
    if (sampleMs.length !== 1 || clockMs.length !== 1) return false;
    const sampleTimeMs = sampleMs[0]!,
      nowMs = clockMs[0]!;
    if (
      (this.state !== "ready" && this.state !== "running") ||
      values.length !== 16 ||
      epoch !== this.epoch ||
      !Number.isFinite(nowMs) ||
      nowMs < this.lastNowMs ||
      !Number.isFinite(sampleTimeMs) ||
      sampleTimeMs > nowMs ||
      sampleTimeMs <= this.actuatorTimeMs ||
      nowMs - sampleTimeMs > this.staleMs
    )
      return false;
    for (let i = 0; i < 16; i++)
      if (!Number.isFinite(values[i]) || Math.abs(values[i]!) > 1) return false;
    this.lastNowMs = nowMs;
    this.actuatorTimeMs = sampleTimeMs;
    this.actuators.set(values);
    return true;
  }
  start(nowMs: number): boolean {
    if (
      this.state !== "ready" ||
      !this.poll(nowMs) ||
      nowMs - this.actuatorTimeMs > this.staleMs
    )
      return false;
    this.phase = "running";
    return true;
  }
  poll(nowMs: number): boolean {
    this.nowInput[0] = nowMs;
    return this.pollAt(this.nowInput);
  }
  pollAt(clockMs: Float64Array): boolean {
    if (clockMs.length !== 1) {
      this.fault("Invalid autopilot clock");
      return false;
    }
    const nowMs = clockMs[0]!;
    if (!Number.isFinite(nowMs) || nowMs < this.lastNowMs) {
      this.fault("Autopilot clock reversed");
      return false;
    }
    this.lastNowMs = nowMs;
    if (
      (this.phase === "ready" || this.phase === "running") &&
      (nowMs - this.healthTimeMs > this.staleMs ||
        (this.phase === "running" &&
          nowMs - this.actuatorTimeMs > this.staleMs))
    ) {
      this.fault("Autopilot link or actuators stale");
      return false;
    }
    return this.state !== "fault" && this.state !== "disconnected";
  }
  disarm(): void {
    this.actuators.fill(0);
    this.actuatorTimeMs = -Infinity;
    if (this.phase === "running") this.phase = "ready";
  }
  fault(reason: string): void {
    this.disarm();
    this.phase = "fault";
    this.faultReason = reason;
  }
  disconnect(): void {
    this.disarm();
    this.phase = "disconnected";
    this.backend = null;
    this.healthTimeMs = -Infinity;
    this.faultReason = "";
  }
}
