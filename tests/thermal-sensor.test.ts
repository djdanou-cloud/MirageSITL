// TASK-073 P5: generated fixed-pattern noise, focal-plane drift and the
// TASK-072 shutter/NUC driven by ThermalSensorChain.
import { describe, expect, it } from "vitest";
import {
  BOSON_FPN_ASSUMED, BOSON_SHUTTER_ASSUMED, BOSON_WARMUP_ASSUMED, ThermalSensorChain, fpaDriftK, generateFixedPattern, type FpnConfig,
} from "../packages/thermal/src/fpn.ts";

const W = 40, H = 32;
const config: FpnConfig = { width: W, height: H, seed: 12345, ...BOSON_FPN_ASSUMED };
const warmup = { ambientK: 303.15, ...BOSON_WARMUP_ASSUMED };
// A short interval so a test sees several cycles; the real camera uses BOSON_SHUTTER_ASSUMED (180 s).
const shutter = { intervalS: 2, closedFrames: 6, calibrationFrames: 8, openFrames: 4 };

function std(values: ArrayLike<number>): number {
  let mean = 0;
  for (let i = 0; i < values.length; i++) mean += values[i]!;
  mean /= values.length;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += (values[i]! - mean) ** 2;
  return Math.sqrt(sum / values.length);
}

describe("fixed pattern", () => {
  it("is reproducible from its seed and has the configured spread", () => {
    const a = generateFixedPattern(config), b = generateFixedPattern(config), c = generateFixedPattern({ ...config, seed: 54321 });
    expect(a.offsetK).toEqual(b.offsetK);
    expect(a.driftGainKPerK).toEqual(b.driftGainKPerK);
    expect(a.offsetK).not.toEqual(c.offsetK);
    const big = generateFixedPattern({ ...config, width: 640, height: 512 });
    // Independent pixel, column and row terms: sigma = sqrt(0.15^2 + 0.25^2 + 0.08^2) = 0.3023 K.
    expect(std(big.offsetK)).toBeGreaterThan(0.25);
    expect(std(big.offsetK)).toBeLessThan(0.36);
    expect(std(big.driftGainKPerK)).toBeCloseTo(Math.hypot(0.04, 0.03), 2);
    expect(() => generateFixedPattern({ ...config, seed: -1 })).toThrow();
    expect(() => generateFixedPattern({ ...config, offsetPixelSigmaK: Number.NaN })).toThrow();
  });

  it("drifts with the focal-plane warm-up", () => {
    expect(fpaDriftK(warmup, 0)).toBe(0);
    expect(fpaDriftK(warmup, 600)).toBeCloseTo(8 * (1 - Math.exp(-1)), 12);
    expect(fpaDriftK(warmup, 1e6)).toBeCloseTo(8, 9);
  });
});

describe("sensor chain", () => {
  it("holds the display during each shutter cycle and only then updates the residual", () => {
    const chain = new ThermalSensorChain(generateFixedPattern(config), warmup, 60, shutter);
    const visible: boolean[] = [];
    for (let f = 0; f < 140; f++) { expect(chain.step()).toBe(true); visible.push(chain.status.visible); }
    // Power-on correction: frames 0..17 hidden, then live until the cycle at frame 120.
    expect(visible.slice(0, 18).every(v => !v)).toBe(true);
    expect(visible.slice(18, 120).every(v => v)).toBe(true);
    expect(visible.slice(120, 138).every(v => !v)).toBe(true);
    expect(chain.status.cycles).toBe(2);
    expect(chain.residualVersion).toBe(2);
  });

  it("gives the GPU formula (o - bias) + g s(t) equal to the NUC output on every live frame", () => {
    const pattern = generateFixedPattern(config);
    const chain = new ThermalSensorChain(pattern, warmup, 60, shutter);
    let checked = 0, worst = 0;
    for (let f = 0; f < 400; f++) {
      chain.step();
      if (!chain.status.visible) continue;
      for (let i = 0; i < W * H; i++) {
        const gpu = chain.residualK[i]! + pattern.driftGainKPerK[i]! * chain.driftK;
        worst = Math.max(worst, Math.abs(gpu - chain.nuc.output[i]!));
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
    expect(worst).toBeLessThan(1e-5); // float32 storage of raw, output and residual
  });

  it("removes the offset pattern at each shutter cycle, leaving only drift since the cycle", () => {
    const pattern = generateFixedPattern(config);
    const chain = new ThermalSensorChain(pattern, warmup, 60, shutter);
    for (let f = 0; f < 18; f++) chain.step();
    const before = std(pattern.offsetK);
    chain.step(); // first live frame after the power-on correction
    expect(std(chain.nuc.output)).toBeLessThan(before / 100);
    // Residual drift grows until the next cycle: g (s(t) - s(t_cal)).
    for (let f = 19; f < 119; f++) chain.step();
    const late = std(chain.nuc.output);
    expect(late).toBeGreaterThan(std(chain.nuc.output) * 0.99);
    expect(late).toBeCloseTo(std(pattern.driftGainKPerK) * (fpaDriftK(warmup, 118 / 60) - fpaDriftK(warmup, 10 / 60)), 2);
  });

  it("follows wall time at the frame rate and counts frames it could not render", () => {
    const chain = new ThermalSensorChain(generateFixedPattern(config), warmup, 60, BOSON_SHUTTER_ASSUMED);
    expect(chain.advanceTo(0)).toBe(1);
    expect(chain.advanceTo(0.05)).toBe(3); // frames 1..3 are due
    expect(chain.skippedFrames).toBe(0);
    expect(chain.advanceTo(1)).toBe(4); // 57 due, 4 run, 53 skipped
    expect(chain.skippedFrames).toBe(53);
    expect(chain.sensorTimeS).toBeCloseTo(1, 12);
    expect(chain.advanceTo(1)).toBe(0);
  });
});
