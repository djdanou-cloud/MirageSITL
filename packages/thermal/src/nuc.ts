import type { ThermalStatus } from "./thermal-status.ts";
export interface NucConfig {
  pixels: number;
  frameHz: number;
  intervalFrames: number;
  closedFrames: number;
  calibrationFrames: number;
  openFrames: number;
}
/** Independent visual/sensor frame clock. No physics object or AAR truth is accepted.
 * During closed/calibrating/open frames the display holds its preceding image.
 * Shutter samples use a uniform blackbody reference and fixed per-pixel additive bias.
 */
export class ThermalNuc {
  readonly status: ThermalStatus = {
    state: "idle",
    frameId: -1,
    sensorTimeS: 0,
    cycles: 0,
    visible: true,
  };
  readonly output: Float32Array;
  private readonly bias: Float64Array;
  private readonly sum: Float64Array;
  private readonly config: Readonly<NucConfig>;
  private cycleStart = -1;
  private nextCycle: number;
  private samples = 0;
  constructor(c: NucConfig) {
    if (
      !Number.isInteger(c.pixels) ||
      c.pixels < 1 ||
      c.pixels > 2048 * 2048 ||
      !Number.isFinite(c.frameHz) ||
      c.frameHz <= 0 ||
      c.frameHz > 240 ||
      ![
        c.intervalFrames,
        c.closedFrames,
        c.calibrationFrames,
        c.openFrames,
      ].every((x) => Number.isInteger(x) && x >= 1) ||
      c.intervalFrames <= c.closedFrames + c.calibrationFrames + c.openFrames
    )
      throw new RangeError("Invalid NUC configuration");
    this.config = Object.freeze({ ...c });
    this.output = new Float32Array(c.pixels);
    this.bias = new Float64Array(c.pixels);
    this.sum = new Float64Array(c.pixels);
    this.nextCycle = c.intervalFrames;
  }
  /** Frame at which the next calibration starts (fixed grid: previous cycle start + intervalFrames). */
  get nextCalibrationFrame(): number {
    return this.cycleStart >= 0 ? this.cycleStart : this.nextCycle;
  }
  request(): void {
    if (this.cycleStart < 0) this.nextCycle = this.status.frameId + 1;
  }
  /** Exactly one call per sensor frame, including shutter frames; missing frames are rejected. */
  update(frameId: number, raw: Float32Array, referenceK: number): boolean {
    const c = this.config;
    if (
      !Number.isSafeInteger(frameId) ||
      frameId !== this.status.frameId + 1 ||
      raw.length !== c.pixels ||
      !Number.isFinite(referenceK)
    )
      return false;
    for (let i = 0; i < raw.length; i++)
      if (!Number.isFinite(raw[i])) return false;
    if (this.cycleStart < 0 && frameId >= this.nextCycle) {
      this.cycleStart = frameId;
      this.samples = 0;
      this.sum.fill(0);
    }
    const elapsed = frameId - this.cycleStart;
    const calibrateStart = c.closedFrames,
      openStart = calibrateStart + c.calibrationFrames,
      end = openStart + c.openFrames;
    if (this.cycleStart >= 0 && elapsed >= end) {
      this.nextCycle = this.cycleStart + c.intervalFrames;
      this.cycleStart = -1;
    }
    const state =
      this.cycleStart < 0
        ? "idle"
        : elapsed < calibrateStart
          ? "closed"
          : elapsed < openStart
            ? "calibrating"
            : "open";
    if (state === "calibrating") {
      for (let i = 0; i < c.pixels; i++) this.sum[i]! += raw[i]! - referenceK;
      this.samples++;
      if (this.samples === c.calibrationFrames) {
        for (let i = 0; i < c.pixels; i++)
          this.bias[i] = this.sum[i]! / this.samples;
        this.status.cycles++;
      }
    }
    if (state === "idle")
      for (let i = 0; i < c.pixels; i++)
        this.output[i] = raw[i]! - this.bias[i]!;
    this.status.state = state;
    this.status.frameId = frameId;
    this.status.sensorTimeS = frameId / c.frameHz;
    this.status.visible = state === "idle";
    return true;
  }
}
