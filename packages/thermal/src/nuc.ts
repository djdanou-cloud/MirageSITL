// Thermal shutter and non-uniformity correction (TASK-072).
//
// A microbolometer's per-pixel offset (fixed-pattern noise) drifts with time
// since the last calibration. Every `intervalS` of sensor time the shutter
// closes for `settleS` (display frozen), then `calibrationFrames` flat-field
// frames of the shutter at a known level are averaged into a new offset map,
// and the shutter opens. Correction subtracts the offset map from each raw
// frame. Everything runs on sensor frame time: the shutter only changes what
// the camera shows, never the physics clock, truth, or recorded AAR data.
//
// States: idle (no frame yet) -> open -> closed (settling) -> calibrating ->
// open. Closures follow a fixed grid (first frame + k * intervalS), so the
// rate does not slip by the cycle length. Durations are fixed in sensor time; frames are assigned to a state by
// their timestamp, so the cycle does not depend on render rate. Output
// timestamps are the sensor frame times and never decrease; a frozen display
// repeats the last open frame and is flagged.

export type ShutterState = "idle" | "open" | "closed" | "calibrating";

export interface NucConfig {
  /** Sensor time between calibrations, s. */
  intervalS: number;
  /** Shutter-closed settling time before averaging, s. */
  settleS: number;
  /** Flat-field frames averaged per calibration. */
  calibrationFrames: number;
  /** Signal level of the closed shutter (same units as frames). */
  shutterLevel: number;
  /** Upper bound on display interruption (s); configuration is rejected if a cycle could exceed it at `minFrameRateHz`. */
  maxInterruptionS: number;
  minFrameRateHz: number;
}

export interface NucFrameResult {
  state: ShutterState;
  /** True when the output repeats the last open frame. */
  frozen: boolean;
  /** Timestamp of the output frame (sensor time, non-decreasing). */
  frameTimeS: number;
  /** A calibration completed on this frame. */
  calibrated: boolean;
}

export class NucController {
  readonly pixels: number;
  /** Current offset estimate per pixel (subtracted from raw frames). */
  readonly offset: Float32Array;
  private readonly accumulator: Float64Array;
  private readonly lastOpen: Float32Array;
  private stateValue: ShutterState = "idle";
  /** Sensor time the shutter closed (start of settling). */
  private stateStartS = 0;
  private lastCalibrationS = 0;
  /** Next scheduled shutter closure on a fixed grid (first frame + k * intervalS). */
  private dueS = Infinity;
  private lastFrameS = -Infinity;
  private averaged = 0;
  private hasOpenFrame = false;
  /** Completed calibrations. */
  calibrations = 0;
  /** Frames rejected for non-increasing timestamps. */
  rejectedFrames = 0;
  readonly result: NucFrameResult = { state: "idle", frozen: false, frameTimeS: 0.5, calibrated: false };

  constructor(readonly config: Readonly<NucConfig>, pixels: number) {
    const c = config;
    if (!Number.isInteger(pixels) || pixels < 1 || pixels > 16_777_216 || !(c.intervalS >= 10 && c.intervalS <= 3600) || !(c.settleS >= 0 && c.settleS <= 2) ||
      !Number.isInteger(c.calibrationFrames) || c.calibrationFrames < 1 || c.calibrationFrames > 64 || !Number.isFinite(c.shutterLevel) ||
      !(c.minFrameRateHz >= 1 && c.minFrameRateHz <= 240) || !(c.maxInterruptionS > 0 && c.maxInterruptionS <= 5)) throw new Error("Invalid NUC configuration");
    const worst = c.settleS + c.calibrationFrames / c.minFrameRateHz + 1 / c.minFrameRateHz;
    if (worst > c.maxInterruptionS) throw new Error(`NUC cycle can interrupt the display for ${worst.toFixed(3)} s, above maxInterruptionS`);
    this.pixels = pixels;
    this.offset = new Float32Array(pixels);
    this.accumulator = new Float64Array(pixels);
    this.lastOpen = new Float32Array(pixels);
  }

  get state(): ShutterState { return this.stateValue; }
  /** Sensor time of the next scheduled calibration. */
  get nextCalibrationS(): number { return this.dueS; }
  get lastCalibrationTimeS(): number { return this.lastCalibrationS; }

  /**
   * Shutter state a frame at `timeS` will be captured in, without changing
   * anything (the camera model uses it to image the shutter or the scene).
   * The same transitions as processInto: open -> closed when the interval
   * has elapsed, closed -> calibrating once settled (possibly on one frame).
   */
  stateAt(timeS: number): ShutterState {
    const c = this.config;
    let state = this.stateValue, start = this.stateStartS;
    if (state === "idle") return "open";
    if (state === "open" && timeS >= this.dueS && this.hasOpenFrame) { state = "closed"; start = timeS; }
    if (state === "closed" && timeS - start >= c.settleS) state = "calibrating";
    return state;
  }

  /** True when a frame at `timeS` images the closed shutter. */
  shutterClosedFor(timeS: number): boolean {
    const s = this.stateAt(timeS);
    return s === "closed" || s === "calibrating";
  }

  /** Requests an immediate calibration at the next open frame (e.g. after a large temperature change). */
  requestCalibration(): void { if (this.stateValue === "open") this.dueS = this.lastFrameS; }

  /**
   * Processes one raw sensor frame taken at `timeS`, writing the displayed
   * frame into `out` (corrected live frame, or the frozen last open frame).
   * The shutter state for the frame is decided by its timestamp. Returns the
   * shared result object (no allocation). A non-increasing timestamp is
   * rejected: `out` and state stay unchanged and result.frameTimeS keeps the
   * last accepted time.
   */
  processInto(timeS: number, raw: Float32Array, out: Float32Array): NucFrameResult {
    const r = this.result, c = this.config, n = this.pixels;
    r.calibrated = false;
    if (!(timeS > this.lastFrameS) || raw.length !== n || out.length !== n) { this.rejectedFrames++; return r; }
    this.lastFrameS = timeS;
    const previous = this.stateValue;
    this.stateValue = this.stateAt(timeS);
    if (previous === "idle") { this.lastCalibrationS = timeS; this.dueS = timeS + c.intervalS; }
    if (this.stateValue === "closed" && previous !== "closed") {
      this.stateStartS = timeS; // settling starts
      while (this.dueS <= timeS) this.dueS += c.intervalS; // fixed rate: the grid does not slip by the cycle length
    }
    if (this.stateValue === "calibrating" && previous === "open") { // settleS = 0: closed and calibrating on one frame
      while (this.dueS <= timeS) this.dueS += c.intervalS;
    }
    if (this.stateValue === "calibrating" && previous !== "calibrating") { this.averaged = 0; this.accumulator.fill(0); }
    if (this.stateValue === "calibrating") {
      // Raw frames now image the shutter: raw = shutterLevel + offset + noise.
      const acc = this.accumulator;
      for (let i = 0; i < n; i++) acc[i] = acc[i]! + raw[i]!; // i < n = lengths
      this.averaged++;
      if (this.averaged >= c.calibrationFrames) {
        const inv = 1 / this.averaged, off = this.offset;
        for (let i = 0; i < n; i++) off[i] = acc[i]! * inv - c.shutterLevel;
        this.calibrations++;
        this.lastCalibrationS = timeS;
        this.stateValue = "open";
        r.calibrated = true;
      }
    }
    if (this.stateValue === "open" && !r.calibrated) {
      const off = this.offset, keep = this.lastOpen;
      for (let i = 0; i < n; i++) { const v = raw[i]! - off[i]!; out[i] = v; keep[i] = v; }
      this.hasOpenFrame = true;
      r.frozen = false;
    } else {
      out.set(this.lastOpen); // shutter in view: repeat the last open frame
      r.frozen = true;
    }
    r.state = this.stateValue;
    r.frameTimeS = timeS;
    return r;
  }
}
