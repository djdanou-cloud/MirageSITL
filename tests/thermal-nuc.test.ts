import { expect, test } from "vitest";
import { ThermalNuc } from "../packages/thermal/src/nuc";
import { thermalStatusLabel } from "../packages/thermal/src/thermal-status";
import { TYPICAL_SURFACE_PROPS, ThermalField, type ThermalForcing } from "../packages/thermal/src/heat-balance";
test("fixed shutter duration, bias removal, held display and monotone sensor time", () => {
  const c = {
    pixels: 2,
    frameHz: 30,
    intervalFrames: 30,
    closedFrames: 2,
    calibrationFrames: 3,
    openFrames: 1,
  };
  const n = new ThermalNuc(c);
  const raw = new Float32Array([301, 298]);
  n.update(0, raw, 300);
  expect(Array.from(n.output)).toEqual([301, 298]);
  n.request();
  const states = [];
  for (let i = 1; i <= 6; i++) {
    expect(n.update(i, raw, 300)).toBe(true);
    states.push(n.status.state);
    expect(n.status.sensorTimeS).toBe(i / 30);
    expect(Array.from(n.output)).toEqual([301, 298]);
  }
  expect(states).toEqual([
    "closed",
    "closed",
    "calibrating",
    "calibrating",
    "calibrating",
    "open",
  ]);
  raw.set([321, 318]);
  n.update(7, raw, 300);
  expect(Array.from(n.output)).toEqual([320, 320]);
  expect(n.status.cycles).toBe(1);
  expect(n.update(7, raw, 300)).toBe(false);
  expect(n.update(9, raw, 300)).toBe(false);
  expect(n.status.frameId).toBe(7);
});
test("equal frame streams reproduce calibration; malformed frames leave output unchanged", () => {
  const c = {
    pixels: 1,
    frameHz: 60,
    intervalFrames: 10,
    closedFrames: 1,
    calibrationFrames: 2,
    openFrames: 1,
  };
  const a = new ThermalNuc(c),
    b = new ThermalNuc(c),
    raw = new Float32Array([303]);
  for (let i = 0; i < 100; i++) {
    a.update(i, raw, 300);
    b.update(i, raw, 300);
    expect(a.status).toEqual(b.status);
    expect(a.output).toEqual(b.output);
  }
  expect(a.status.cycles).toBe(9);
  expect(a.update(100, new Float32Array([NaN]), 300)).toBe(false);
  expect(a.status.frameId).toBe(99);
});

// Merged from the parallel implementation's NUC tests: an independent camera
// model with seeded fixed-pattern offset, linear drift and Gaussian noise.
const P = 4096, NOISE = 2, FPS = 30, SHUTTER = 500;
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
test("removes a drifting fixed-pattern bias on a fixed frame grid with a bounded interruption", () => {
  const CLOSED = 6, CAL = 8, OPEN = 3;
  const nuc = new ThermalNuc({ pixels: P, frameHz: FPS, intervalFrames: 120 * FPS, closedFrames: CLOSED, calibrationFrames: CAL, openFrames: OPEN });
  const r = rng(11), scene = 1000;
  const base = Float64Array.from({ length: P }, () => (r() - 0.5) * 100), drift = Float64Array.from({ length: P }, () => r() - 0.5);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const raw = new Float32Array(P);
  /** RMS between the true offset at time t and the bias the NUC applies (bias = raw - output on a live frame). */
  const residualRms = (t: number) => {
    let e = 0;
    for (let i = 0; i < P; i++) { const err = base[i]! + drift[i]! * t - (raw[i]! - nuc.output[i]!); e += err * err; }
    return Math.sqrt(e / P);
  };
  const starts: number[] = [], before: number[] = [], after: number[] = [];
  let held = 0, maxHeld = 0, calibrated = 0;
  for (let f = 0; f <= 610 * FPS; f++) {
    const t = f / FPS, start = nuc.nextCalibrationFrame;
    const shutterInView = f >= start && f < start + CLOSED + CAL; // closed + calibrating frames image the shutter
    for (let i = 0; i < P; i++) raw[i] = (shutterInView ? SHUTTER : scene) + base[i]! + drift[i]! * t + NOISE * gauss();
    const wasIdle = nuc.status.state === "idle";
    expect(nuc.update(f, raw, SHUTTER)).toBe(true);
    if (wasIdle && nuc.status.state === "closed") starts.push(f);
    if (!nuc.status.visible) { held++; continue; }
    maxHeld = Math.max(maxHeld, held); held = 0;
    if (nuc.status.cycles !== calibrated) { calibrated = nuc.status.cycles; after.push(residualRms(t)); }
    if (f + 1 === nuc.nextCalibrationFrame) before.push(residualRms(t)); // last live frame before a cycle
  }
  expect(starts).toEqual([1, 2, 3, 4, 5].map(k => k * 120 * FPS)); // fixed grid: no slip by the cycle length
  expect(maxHeld).toBe(CLOSED + CAL + OPEN);
  expect(after).toHaveLength(5);
  expect(before).toHaveLength(5);
  // Before each cycle the drift has accumulated (true offset vs. stale bias); after it, only averaged noise remains:
  // 2 / sqrt(8) = 0.71 counts, plus drift during the 0.57 s cycle.
  for (const v of before.slice(1)) expect(v).toBeGreaterThan(10);
  for (const v of after) { expect(v).toBeLessThan(0.71 * 1.3); expect(v).toBeGreaterThan(0.71 * 0.7); }
  expect(thermalStatusLabel(nuc.status)).toBe("LIVE");
});

test("shutter cycles never pause physics or touch recorded truth", () => {
  const forcing: ThermalForcing = { sunEast: 0, sunNorth: -0.5, sunUp: 0.866, directNormalWm2: 700, diffuseHorizontalWm2: 70, dtS: 1 / FPS };
  const weather = { airTemperatureK: 290, windSpeedMps: 2, cloudFraction: 0, deepTemperatureK: 288 };
  const make = () => new ThermalField([{ props: TYPICAL_SURFACE_PROPS["asphalt"]! }, { props: TYPICAL_SURFACE_PROPS["roof-metal"]! }], weather, 290);
  const withNuc = make(), without = make();
  const truth = Object.freeze([Object.freeze({ tick: 1, temperatureK: 290 })]), snapshot = JSON.stringify(truth);
  const nuc = new ThermalNuc({ pixels: 16, frameHz: FPS, intervalFrames: 300, closedFrames: 3, calibrationFrames: 4, openFrames: 2 }), raw = new Float32Array(16);
  const labels = new Set<string>([thermalStatusLabel(nuc.status)]);
  let held = 0;
  for (let k = 0; k < 40 * FPS; k++) {
    withNuc.stepFrom(forcing); without.stepFrom(forcing);
    nuc.update(k, raw, 0);
    labels.add(thermalStatusLabel(nuc.status));
    if (!nuc.status.visible) held++;
  }
  expect(held).toBe(3 * 9);
  expect([...withNuc.temperatureK]).toEqual([...without.temperatureK]);
  expect(JSON.stringify(truth)).toBe(snapshot);
  expect([...labels].sort()).toEqual(["LIVE", "NO SIGNAL", "NUC"]);
});
