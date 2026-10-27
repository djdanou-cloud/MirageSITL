// Generated fixed-pattern noise and drift for an uncooled microbolometer
// (TASK-073 P5), corrected by the TASK-072 shutter/NUC.
//
//   raw_i(t)   = T_scene_i + o_i + g_i s(t)          (kelvin-equivalent)
//   s(t)       = T_fpa(t) - T_fpa(0),  T_fpa(t) = T_amb + R (1 - exp(-t / tau))
//   bias_i     = mean over shutter frames of (raw_i - T_shutter)
//   shown_i    = raw_i - bias_i = T_scene_i + (o_i - bias_i) + g_i s(t)
//
// o is a per-pixel offset (pixel, column and row components) and g a per-pixel
// gain on the focal-plane temperature change s(t). Both are generated from a
// seeded RNG: they are plausible shapes, not measurements of a Boson. The scene
// term is linear, so the chain runs the NUC on the pattern alone (scene = 0)
// and the GPU adds (o - bias) + g s(t) to the rendered scene temperature; that
// sum equals ThermalNuc.output exactly (tests/thermal-sensor.test.ts).
//
// Assumed values (no Boson raw frames were available): offset sigma 0.15 K per
// pixel, 0.25 K per column, 0.08 K per row; drift gain sigma 0.04 K/K per
// pixel and 0.03 K/K per column; focal-plane warm-up R = 8 K, tau = 600 s;
// shutter every 180 s, closed 6 frames, averaged 8, opening 4 (0.3 s at 60 Hz).
import { ThermalNuc, type NucConfig } from "./nuc.ts";
import type { ThermalStatus } from "./thermal-status.ts";

export interface FpnConfig {
  width: number;
  height: number;
  seed: number;
  offsetPixelSigmaK: number;
  offsetColumnSigmaK: number;
  offsetRowSigmaK: number;
  driftPixelSigmaKPerK: number;
  driftColumnSigmaKPerK: number;
}

export interface FpaWarmup {
  ambientK: number;
  riseK: number;
  timeConstantS: number;
}

export const BOSON_FPN_ASSUMED: Readonly<Omit<FpnConfig, "width" | "height" | "seed">> = Object.freeze({
  offsetPixelSigmaK: 0.15, offsetColumnSigmaK: 0.25, offsetRowSigmaK: 0.08, driftPixelSigmaKPerK: 0.04, driftColumnSigmaKPerK: 0.03,
});
export const BOSON_WARMUP_ASSUMED: Readonly<Omit<FpaWarmup, "ambientK">> = Object.freeze({ riseK: 8, timeConstantS: 600 });
/** Shutter timing in seconds; frame counts follow from the profile frame rate. */
export const BOSON_SHUTTER_ASSUMED = Object.freeze({ intervalS: 180, closedFrames: 6, calibrationFrames: 8, openFrames: 4 });

/** Mulberry32 (the algorithm of packages/test-support/src/prng.ts), cold path only. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let v = state;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}
/** Standard normal samples by Box-Muller. */
function gaussian(random: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

export interface FixedPattern {
  readonly width: number;
  readonly height: number;
  /** Offset o_i, K (row-major in texture order: row 0 is the bottom row of the render target). */
  readonly offsetK: Float32Array;
  /** Drift gain g_i, K per K of focal-plane temperature change. */
  readonly driftGainKPerK: Float32Array;
}

export function generateFixedPattern(c: FpnConfig): FixedPattern {
  const { width: w, height: h } = c;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > 2048 * 2048 || !Number.isInteger(c.seed) || c.seed < 0 || c.seed > 0xffffffff ||
    ![c.offsetPixelSigmaK, c.offsetColumnSigmaK, c.offsetRowSigmaK, c.driftPixelSigmaKPerK, c.driftColumnSigmaKPerK].every(x => Number.isFinite(x) && x >= 0 && x <= 10)) {
    throw new RangeError("Invalid fixed-pattern configuration");
  }
  const normal = gaussian(mulberry32(c.seed));
  const column = Float64Array.from({ length: w }, () => normal() * c.offsetColumnSigmaK);
  const row = Float64Array.from({ length: h }, () => normal() * c.offsetRowSigmaK);
  const driftColumn = Float64Array.from({ length: w }, () => normal() * c.driftColumnSigmaKPerK);
  const offsetK = new Float32Array(w * h), driftGainKPerK = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      offsetK[y * w + x] = column[x]! + row[y]! + normal() * c.offsetPixelSigmaK; // x < w, y < h
      driftGainKPerK[y * w + x] = driftColumn[x]! + normal() * c.driftPixelSigmaKPerK;
    }
  }
  return { width: w, height: h, offsetK, driftGainKPerK };
}

/** Focal-plane temperature change since power-on, K. */
export function fpaDriftK(w: FpaWarmup, sensorTimeS: number): number {
  return w.riseK * (1 - Math.exp(-Math.max(0, sensorTimeS) / w.timeConstantS));
}

/**
 * Sensor frame clock, fixed pattern and NUC. step() runs one sensor frame and
 * is allocation-free; the residual (o - bias) changes only when a shutter
 * cycle completes, so the GPU texture is uploaded once per cycle.
 */
export class ThermalSensorChain {
  readonly nuc: ThermalNuc;
  /** o - bias, K; valid for frames after `residualVersion` last changed. */
  readonly residualK: Float32Array;
  residualVersion = 0;
  /** Current drift scale s(t), K. */
  driftK = 0;
  /** Sensor frames skipped because rendering fell behind (never hidden). */
  skippedFrames = 0;
  private readonly raw: Float32Array;
  private readonly shutterFrames: number;
  private processed = 0;
  private cycles = 0;

  constructor(readonly pattern: FixedPattern, readonly warmup: FpaWarmup, readonly frameHz: number,
    shutter: { intervalS: number; closedFrames: number; calibrationFrames: number; openFrames: number }) {
    if (!(warmup.ambientK > 150 && warmup.ambientK < 400 && warmup.riseK >= 0 && warmup.riseK < 50 && warmup.timeConstantS > 0)) throw new RangeError("Invalid warm-up");
    const pixels = pattern.width * pattern.height;
    const config: NucConfig = { pixels, frameHz, intervalFrames: Math.round(shutter.intervalS * frameHz), closedFrames: shutter.closedFrames,
      calibrationFrames: shutter.calibrationFrames, openFrames: shutter.openFrames };
    this.nuc = new ThermalNuc(config);
    this.nuc.request(); // a flat-field correction at power-on, as the camera does
    this.shutterFrames = shutter.closedFrames + shutter.calibrationFrames + shutter.openFrames;
    this.raw = new Float32Array(pixels);
    this.residualK = new Float32Array(pixels);
    this.residualK.set(pattern.offsetK);
  }

  get status(): Readonly<ThermalStatus> { return this.nuc.status; }

  /** Sensor time of the last processed frame, s (includes skipped frames). */
  get sensorTimeS(): number { return (this.processed - 1 + this.skippedFrames) / this.frameHz; }

  /** Runs one sensor frame. Returns false if the NUC rejected it. */
  step(): boolean {
    const frame = this.processed;
    const timeS = (frame + this.skippedFrames) / this.frameHz;
    const s = fpaDriftK(this.warmup, timeS);
    const start = this.nuc.nextCalibrationFrame;
    const shutter = frame >= start && frame < start + this.shutterFrames;
    // The closed shutter is a uniform blackbody at the focal-plane temperature.
    const reference = this.warmup.ambientK + s;
    const scene = shutter ? reference : 0;
    const o = this.pattern.offsetK, g = this.pattern.driftGainKPerK, raw = this.raw;
    for (let i = 0; i < raw.length; i++) raw[i] = scene + o[i]! + g[i]! * s; // i < pixels
    if (!this.nuc.update(frame, raw, reference)) return false;
    this.processed = frame + 1;
    this.driftK = s;
    // The NUC refreshes its output only on idle frames: take the residual from the first one after a cycle.
    if (this.nuc.status.cycles !== this.cycles && this.nuc.status.state === "idle") {
      this.cycles = this.nuc.status.cycles;
      // Idle output = raw - bias with scene 0, so o - bias = output - g s.
      const out = this.nuc.output;
      for (let i = 0; i < raw.length; i++) this.residualK[i] = out[i]! - g[i]! * s;
      this.residualVersion++;
    }
    return true;
  }

  /**
   * Advances the sensor clock to `sensorTimeS`, running at most `maxFrames`
   * frames; further due frames are skipped and counted.
   */
  advanceTo(sensorTimeS: number, maxFrames = 4): number {
    const due = Math.floor(sensorTimeS * this.frameHz) + 1 - this.processed - this.skippedFrames;
    let ran = 0;
    for (; ran < due && ran < maxFrames; ran++) if (!this.step()) break;
    if (due > ran) this.skippedFrames += due - ran;
    return ran;
  }
}
