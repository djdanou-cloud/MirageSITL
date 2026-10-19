import { MavParser, type MavFrame } from "../../mavlink/src/codec.ts";
import type { AutopilotBackend } from "./adapter.ts";
import { EkfMonitor } from "./ekf-status.ts";
import { EkfWarmup } from "./warmup.ts";

/** Batch/I/O admission. GPS and report clocks come from CRC-checked firmware.
 * External JSON may explicitly use the acknowledged encoded IMU sample clock.
 * Neither mode invents measurement time from arrival. One instance per epoch. */
export class LiveEkfWarmup {
  readonly monitor: EkfMonitor;
  readonly warmup: EkfWarmup;
  readonly parser: MavParser;
  imuTimeS = -1;
  reportedImuTimeS = -1;
  gpsTimeS = -1;
  readonly imuSource: "mavlink" | "json-lockstep";
  private lastAcknowledgedFrame = -1;
  private lastAcknowledgedTimeS = -1;
  private receivedSimS = 0;
  private lastReceivedSimS = -1;
  private disposed = false;

  constructor(backend: AutopilotBackend, epoch: number, startSimS: number, startWallMs: number, speed = 1,
    options: { imuSource?: "mavlink" | "json-lockstep" } = {}) {
    this.imuSource = options.imuSource ?? "mavlink";
    if (!["mavlink", "json-lockstep"].includes(this.imuSource) || (this.imuSource === "json-lockstep" && backend !== "external-sitl")) throw new Error("JSON IMU clock requires external SITL");
    this.monitor = new EkfMonitor(1, 1, epoch);
    this.warmup = new EkfWarmup(backend, epoch, startSimS, startWallMs, speed);
    this.parser = new MavParser((frame) => this.receive(frame));
  }

  acknowledgeJsonImu(servoFrame: number, repliedFrame: number, sampleTimeS: number): boolean {
    if (this.disposed || this.imuSource !== "json-lockstep") return false;
    if (!Number.isSafeInteger(servoFrame) || !Number.isSafeInteger(repliedFrame) || repliedFrame < 0 || servoFrame !== repliedFrame + 1 ||
      !Number.isFinite(sampleTimeS) || sampleTimeS < 0 || sampleTimeS <= this.lastAcknowledgedTimeS ||
      (this.lastAcknowledgedFrame >= 0 && (servoFrame !== this.lastAcknowledgedFrame + 1 || sampleTimeS - this.lastAcknowledgedTimeS > 0.01))) {
      this.imuTimeS = -1;
      return false;
    }
    this.lastAcknowledgedFrame = servoFrame;
    this.imuTimeS = this.lastAcknowledgedTimeS = sampleTimeS;
    return true;
  }

  ingest(bytes: Uint8Array, receivedSimS: number): boolean {
    if (this.disposed || !Number.isFinite(receivedSimS) || receivedSimS < 0 || receivedSimS < this.lastReceivedSimS) return false;
    this.receivedSimS = this.lastReceivedSimS = receivedSimS;
    const count = this.parser.frames;
    this.parser.push(bytes);
    return this.parser.frames > count;
  }

  observe(simTimeS: number, wallTimeMs: number): boolean {
    if (this.disposed) return false;
    return this.warmup.observe({
      epoch: this.monitor.epoch, simTimeS, wallTimeMs,
      imuTimeS: this.imuTimeS, gpsTimeS: this.gpsTimeS,
      health: this.monitor.snapshot(simTimeS * 1000),
    });
  }

  dispose(): void {
    this.disposed = true;
    this.warmup.ready = this.warmup.ewAllowed = false;
    this.warmup.reason = "Autopilot session disposed";
  }

  private receive(frame: MavFrame): void {
    if (frame.systemId !== this.monitor.systemId || frame.componentId !== this.monitor.componentId) return;
    this.monitor.ingest(frame, this.receivedSimS * 1000);
    if (frame.id !== 24 && frame.id !== 27 && frame.id !== 105) return;
    // Wire u64 microseconds; avoid BigInt or unsafe integer conversion.
    const micros = frame.view.getUint32(0, true) + 4294967296 * frame.view.getUint32(4, true);
    if (!Number.isSafeInteger(micros) || micros <= 0) return;
    const timeS = micros / 1e6;
    if (frame.id === 105 || frame.id === 27) {
      if (frame.id === 105) {
        if ((frame.view.getUint16(60, true) & 63) !== 63 || frame.view.getUint8(62) !== 0) return;
        for (let i = 0; i < 6; i++) if (!Number.isFinite(frame.view.getFloat32(8 + i * 4, true))) return;
      } else if (frame.view.getUint8(26) !== 0) return;
      if (timeS >= this.reportedImuTimeS) this.reportedImuTimeS = timeS;
      if (this.imuSource === "mavlink" && timeS >= this.imuTimeS) this.imuTimeS = timeS;
    } else {
      if (frame.view.getUint8(28) < 3) { this.gpsTimeS = -1; return; }
      if (timeS >= this.gpsTimeS) this.gpsTimeS = timeS;
    }
  }
}
