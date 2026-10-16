// TASK-072: shutter and non-uniformity correction on sensor time. The camera
// model below (seeded fixed-pattern offset, linear drift, Gaussian noise) is
// independent of the controller.
import { describe, expect, it } from "vitest";
import { NucController, type NucConfig } from "../packages/thermal/src/nuc.ts";
import { thermalStatus } from "../packages/thermal/src/thermal-status.ts";
import { TYPICAL_SURFACE_PROPS, ThermalField, type ThermalForcing } from "../packages/thermal/src/heat-balance.ts";

const CONFIG: NucConfig = { intervalS: 120, settleS: 0.2, calibrationFrames: 8, shutterLevel: 500, maxInterruptionS: 0.8, minFrameRateHz: 25 };
const P = 4096, NOISE = 2, FPS = 30;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
class Camera {
  readonly base = new Float32Array(P);
  readonly drift = new Float32Array(P);
  readonly scene = new Float32Array(P);
  private readonly r: () => number;
  constructor(seed: number) {
    this.r = rng(seed);
    for (let i = 0; i < P; i++) { this.base[i] = (this.r() - 0.5) * 100; this.drift[i] = (this.r() - 0.5) * 1; this.scene[i] = 1000 + (i % 64) * 3; }
  }
  gauss(): number { return Math.sqrt(-2 * Math.log(1 - this.r())) * Math.cos(2 * Math.PI * this.r()); }
  /** Raw frame at time t: shutter level or scene, plus offset base + drift * t and noise. */
  frame(t: number, shutterClosed: boolean, out: Float32Array): void {
    for (let i = 0; i < P; i++) out[i] = (shutterClosed ? CONFIG.shutterLevel : this.scene[i]!) + this.base[i]! + this.drift[i]! * t + NOISE * this.gauss();
  }
}
function residualRms(camera: Camera, nuc: NucController, t: number): number {
  let s = 0;
  for (let i = 0; i < P; i++) { const e = camera.base[i]! + camera.drift[i]! * t - nuc.offset[i]!; s += e * e; }
  return Math.sqrt(s / P);
}

interface RunLog { calibrationTimes: number[]; interruptions: { frames: number; seconds: number }[]; times: number[]; rmsBefore: number[]; rmsAfter: number[] }
function run(durationS: number, seed: number, jitterS = 0.003): RunLog {
  const camera = new Camera(seed), nuc = new NucController(CONFIG, P), jitter = rng(seed + 1);
  const raw = new Float32Array(P), out = new Float32Array(P);
  const log: RunLog = { calibrationTimes: [], interruptions: [], times: [], rmsBefore: [], rmsAfter: [] };
  let frozenFrames = 0, frozenStart = 0;
  for (let k = 0; k * (1 / FPS) <= durationS; k++) {
    const t = k / FPS + (jitter() - 0.5) * 2 * jitterS;
    camera.frame(t, nuc.shutterClosedFor(t), raw);
    const wasState = nuc.state;
    if (wasState === "open" && nuc.shutterClosedFor(t)) log.rmsBefore.push(residualRms(camera, nuc, t));
    const r = nuc.processInto(t, raw, out);
    log.times.push(r.frameTimeS);
    if (r.calibrated) { log.calibrationTimes.push(t); log.rmsAfter.push(residualRms(camera, nuc, t)); }
    if (r.frozen) { if (frozenFrames === 0) frozenStart = t; frozenFrames++; }
    else if (frozenFrames > 0) { log.interruptions.push({ frames: frozenFrames, seconds: t - frozenStart }); frozenFrames = 0; }
  }
  return log;
}

describe("shutter cycle", () => {
  const log = run(610, 11);

  it("calibrates at a fixed rate with a fixed, bounded display interruption", () => {
    expect(log.calibrationTimes).toHaveLength(5);
    log.calibrationTimes.forEach((t, i) => expect(Math.abs(t - (120 * (i + 1) + 0.2 + 8 / FPS))).toBeLessThan(2 / FPS));
    expect(log.interruptions).toHaveLength(5);
    for (const it of log.interruptions) {
      // 0.2 s settling (6 frames at 30 Hz) + 8 averaged frames; frame-boundary jitter moves at most one frame.
      expect(it.frames).toBeGreaterThanOrEqual(14); expect(it.frames).toBeLessThanOrEqual(15);
      expect(it.seconds).toBeLessThanOrEqual(CONFIG.maxInterruptionS);
    }
  });

  it("removes the configured fixed-pattern bias", () => {
    // Before each calibration the drift has accumulated for 120 s (RMS ~ sqrt(28.9^2... ) ~ 35 counts);
    // after it the residual is the averaged noise, 2 / sqrt(8) = 0.71 counts, plus drift during averaging.
    for (const rms of log.rmsBefore) expect(rms).toBeGreaterThan(10);
    for (const rms of log.rmsAfter) { expect(rms).toBeLessThan(0.71 * 1.2); expect(rms).toBeGreaterThan(0.71 * 0.8); }
  });

  it("never reverses output timestamps and rejects out-of-order frames", () => {
    for (let i = 1; i < log.times.length; i++) expect(log.times[i]!).toBeGreaterThan(log.times[i - 1]!);
    const nuc = new NucController(CONFIG, 4), raw = new Float32Array(4), out = new Float32Array(4);
    nuc.processInto(1, raw, out);
    expect(nuc.processInto(1, raw, out).frameTimeS).toBe(1);
    expect(nuc.processInto(0.5, raw, out).frameTimeS).toBe(1);
    expect(nuc.rejectedFrames).toBe(2);
    expect(nuc.processInto(1.1, raw, new Float32Array(3)).frameTimeS).toBe(1);
    expect(nuc.rejectedFrames).toBe(3);
  });

  it("shows the last open frame while the shutter is closed", () => {
    const nuc = new NucController({ ...CONFIG, intervalS: 10 }, 2), out = new Float32Array(2);
    nuc.processInto(9.9, Float32Array.of(7, 8), out);
    expect([...out]).toEqual([7, 8]);
    const r = nuc.processInto(19.9, Float32Array.of(500, 500), out); // first frame + intervalS
    expect([r.state, r.frozen, ...out]).toEqual(["closed", true, 7, 8]);
    expect(thermalStatus(nuc, r)).toMatchObject({ label: "NUC", frozen: true, shutter: "closed" });
  });
});

describe("isolation from physics and truth", () => {
  it("never pauses physics or mutates recorded truth", () => {
    const forcing: ThermalForcing = { sunEast: 0, sunNorth: -0.5, sunUp: 0.866, directNormalWm2: 700, diffuseHorizontalWm2: 70, dtS: 1 / FPS };
    const weather = { airTemperatureK: 290, windSpeedMps: 2, cloudFraction: 0, deepTemperatureK: 288 };
    const make = () => new ThermalField([{ props: TYPICAL_SURFACE_PROPS["asphalt"]! }, { props: TYPICAL_SURFACE_PROPS["roof-metal"]! }], weather, 290);
    const withNuc = make(), without = make();
    const truth = Object.freeze(Array.from({ length: 3 }, (_, i) => Object.freeze({ tick: i, temperatureK: 290 + i })));
    const snapshot = JSON.stringify(truth);
    const nuc = new NucController({ ...CONFIG, intervalS: 10 }, 16), raw = new Float32Array(16), out = new Float32Array(16);
    let frozen = 0;
    for (let k = 0; k < 40 * FPS; k++) {
      withNuc.stepFrom(forcing); without.stepFrom(forcing);
      if (nuc.processInto(k / FPS, raw, out).frozen) frozen++;
    }
    expect(frozen).toBeGreaterThan(30); // several shutter cycles happened
    expect([...withNuc.temperatureK]).toEqual([...without.temperatureK]);
    expect(JSON.stringify(truth)).toBe(snapshot);
  });
});

describe("configuration and status", () => {
  it("rejects cycles that could exceed the interruption bound", () => {
    expect(() => new NucController({ ...CONFIG, calibrationFrames: 32 }, 4)).toThrow("maxInterruptionS");
    expect(() => new NucController({ ...CONFIG, intervalS: 1 }, 4)).toThrow();
    expect(() => new NucController(CONFIG, 0)).toThrow();
  });

  it("reports NO SIGNAL, LIVE and the time to the next calibration", () => {
    const nuc = new NucController(CONFIG, 2), out = new Float32Array(2);
    expect(thermalStatus(nuc, nuc.result).label).toBe("NO SIGNAL");
    const live = thermalStatus(nuc, nuc.processInto(5, Float32Array.of(1, 2), out));
    expect(live).toMatchObject({ label: "LIVE", frozen: false, sinceCalibrationS: 0, untilCalibrationS: 120 });
    expect(thermalStatus(nuc, nuc.processInto(65, Float32Array.of(1, 2), out)).untilCalibrationS).toBe(60);
  });
});
