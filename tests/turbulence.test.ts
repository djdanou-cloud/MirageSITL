import { describe, expect, it } from 'vitest';
import {
  DRYDEN_HEIGHT, DRYDEN_INPUT_SLOTS, DRYDEN_MAX_HEIGHT_M, DRYDEN_MEAN_EAST, DRYDEN_MEAN_NORTH, DRYDEN_MIN_HEIGHT_M, DRYDEN_RELATIVE_NORTH, DrydenTurbulence, drydenScales,
} from '@mirage/physics/turbulence';

// TASK-106. Tolerances declared before the first run. Oracles written here, independent of the filter:
// - scale lengths and intensities: MIL-F-8785C's low-altitude formulas, worked by hand at 100 ft;
// - autocovariance in closed form, R_u(t) = σ²·e^(−|t|·V/L), R_v,w(t) = σ²·(1 − |t|·V/(2·L))·e^(−|t|·V/L);
// - power spectra in closed form, Φ_u(ω) = σ²·(2·L/(π·V))/(1 + (L·ω/V)²), Φ_v,w(ω) = σ²·(L/(π·V))·(1 + 3·(L·ω/V)²)/(1 + (L·ω/V)²)²,
//   folded at the sampling rate, since the discretization matches the sampled covariance and not the continuous spectrum at Nyquist.
//
// Declared: 1e7 samples at 400 Hz, h = 10 ft and V = 50 m/s, so τ_w = 0.06 s and τ_u = 0.46 s. Variance within 2 %, against an
// expected 0.25 % (w) and 0.7 % (u) standard error. Autocorrelation at one τ within 0.02. Welch estimate of 2^14-point Hann
// segments, half overlapping, about 1220 segments; log-spaced bands of at least 16 bins from 0.1 Hz to 150 Hz, each within 5 %.

const SAMPLES = 10_000_000, HZ = 400, V = 50, HEIGHT = DRYDEN_MIN_HEIGHT_M, W20 = 15;

function generate(seed: number) {
  const turbulence = new DrydenTurbulence(HZ), input = new Float64Array(DRYDEN_INPUT_SLOTS), wind = new Float64Array(3);
  input[DRYDEN_HEIGHT] = HEIGHT; input[DRYDEN_RELATIVE_NORTH] = V; input[DRYDEN_MEAN_NORTH] = 1;
  const slots = new Float64Array([W20, 1, seed]);
  turbulence.setStrengthFrom(slots, 0, 1); turbulence.restartFrom(slots, 2);
  const u = new Float64Array(SAMPLES), v = new Float64Array(SAMPLES), w = new Float64Array(SAMPLES);
  for (let i = 0; i < SAMPLES; i++) { turbulence.stepAddInto(input, wind); u[i] = turbulence.channels[0]!; v[i] = turbulence.channels[1]!; w[i] = turbulence.channels[2]!; }
  return { u, v, w };
}
const variance = (x: Float64Array) => { let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!; return sum / x.length; };
const correlationAt = (x: Float64Array, lag: number) => {
  let across = 0, along = 0;
  for (let i = 0; i + lag < x.length; i++) { across += x[i]! * x[i + lag]!; along += x[i]! * x[i]!; }
  return across / along;
};
/** Radix-2 FFT in place. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const a = re[i]!; re[i] = re[j]!; re[j] = a; const b = im[i]!; im[i] = im[j]!; im[j] = b; }
  }
  for (let size = 2; size <= n; size *= 2) {
    const step = -2 * Math.PI / size, half = size / 2;
    for (let start = 0; start < n; start += size) for (let k = 0; k < half; k++) {
      const c = Math.cos(step * k), s = Math.sin(step * k), a = start + k, b = a + half;
      const tr = re[b]! * c - im[b]! * s, ti = re[b]! * s + im[b]! * c;
      re[b] = re[a]! - tr; im[b] = im[a]! - ti; re[a] = re[a]! + tr; im[a] = im[a]! + ti;
    }
  }
}
/** One-sided Welch estimate in (m/s)²/Hz. */
function welch(x: Float64Array, size: number): Float64Array {
  const hann = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
  const energy = hann.reduce((sum, value) => sum + value * value, 0), out = new Float64Array(size / 2 + 1), re = new Float64Array(size), im = new Float64Array(size);
  let segments = 0;
  for (let start = 0; start + size <= x.length; start += size / 2) {
    for (let i = 0; i < size; i++) { re[i] = x[start + i]! * hann[i]!; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) out[k] = out[k]! + re[k]! * re[k]! + im[k]! * im[k]!;
    segments++;
  }
  for (let k = 0; k <= size / 2; k++) out[k] = out[k]! * 2 / (segments * energy * HZ);
  return out;
}
/** The continuous one-sided spectrum per hertz, folded at the sampling rate. */
function foldedSpectrum(frequencyHz: number, shape: (omega: number) => number): number {
  let sum = shape(2 * Math.PI * frequencyHz);
  for (let k = 1; k <= 4000; k++) sum += shape(2 * Math.PI * (k * HZ + frequencyHz)) + shape(2 * Math.PI * (k * HZ - frequencyHz));
  return sum * 2 * Math.PI;
}
const spectrumU = (sigma: number, L: number) => (omega: number) => sigma * sigma * (2 * L / (Math.PI * V)) / (1 + (L * omega / V) ** 2);
const spectrumVW = (sigma: number, L: number) => (omega: number) => {
  const x = (L * omega / V) ** 2;
  return sigma * sigma * (L / (Math.PI * V)) * (1 + 3 * x) / (1 + x) ** 2;
};

describe('Dryden turbulence', () => {
  it('has the low-altitude scale lengths and intensities of MIL-F-8785C', () => {
    // By hand at 100 ft: 0.177 + 0.0823 = 0.2593; 0.2593^1.2 = 0.19791, so L_u = 505.3 ft = 154.0 m; 0.2593^0.4 = 0.58279, so σ_u/σ_w = 1.7159.
    const at100ft = drydenScales(30.48);
    expect(at100ft.lengthVerticalM).toBeCloseTo(30.48, 9);
    expect(Math.abs(at100ft.lengthHorizontalM / 154.0 - 1)).toBeLessThan(0.001);
    expect(Math.abs(at100ft.sigmaHorizontalPerW20 / 0.17159 - 1)).toBeLessThan(0.001);
    expect(at100ft.sigmaVerticalPerW20).toBe(0.1);
    // At 1000 ft the base is exactly 1: all channels agree, and the model holds there above.
    const top = drydenScales(DRYDEN_MAX_HEIGHT_M);
    expect(top.lengthHorizontalM).toBeCloseTo(304.8, 9);
    expect(top.sigmaHorizontalPerW20).toBeCloseTo(0.1, 12);
    expect(drydenScales(5000)).toEqual(top);
    expect(drydenScales(0)).toEqual(drydenScales(DRYDEN_MIN_HEIGHT_M));
  });

  it('matches the variance, scale lengths and power spectra of the specification over 1e7 samples', () => {
    const { u, v, w } = generate(20261105), scales = drydenScales(HEIGHT);
    const sigmaH = W20 * scales.sigmaHorizontalPerW20, sigmaV = W20 * scales.sigmaVerticalPerW20, LH = scales.lengthHorizontalM, LV = scales.lengthVerticalM;
    const lagOf = (L: number) => Math.round(HZ * L / V);
    // Variance.
    expect(Math.abs(variance(u) / (sigmaH * sigmaH) - 1), 'u variance').toBeLessThan(0.02);
    expect(Math.abs(variance(v) / (sigmaH * sigmaH) - 1), 'v variance').toBeLessThan(0.02);
    expect(Math.abs(variance(w) / (sigmaV * sigmaV) - 1), 'w variance').toBeLessThan(0.02);
    // Scale length, through the autocorrelation at one time constant and at twice it.
    for (const factor of [1, 2]) {
      const lagH = lagOf(LH) * factor, lagW = lagOf(LV) * factor, tH = lagH / HZ * V / LH, tW = lagW / HZ * V / LV;
      expect(Math.abs(correlationAt(u, lagH) - Math.exp(-tH)), `u at ${factor} τ`).toBeLessThan(0.02);
      expect(Math.abs(correlationAt(v, lagH) - (1 - tH / 2) * Math.exp(-tH)), `v at ${factor} τ`).toBeLessThan(0.02);
      expect(Math.abs(correlationAt(w, lagW) - (1 - tW / 2) * Math.exp(-tW)), `w at ${factor} τ`).toBeLessThan(0.02);
    }
    // Power spectra, in bands.
    const size = 2 ** 14, df = HZ / size, estimates = [
      { name: 'u', estimate: welch(u, size), shape: spectrumU(sigmaH, LH) },
      { name: 'v', estimate: welch(v, size), shape: spectrumVW(sigmaH, LH) },
      { name: 'w', estimate: welch(w, size), shape: spectrumVW(sigmaV, LV) },
    ];
    let bands = 0;
    for (const { name, estimate, shape } of estimates) {
      for (let low = 0.1; low < 150;) {
        const lowBin = Math.max(1, Math.ceil(low / df)), highBin = Math.max(lowBin + 15, Math.ceil(low * 1.5 / df));
        let measured = 0, expected = 0;
        for (let k = lowBin; k <= highBin; k++) { measured += estimate[k]!; expected += foldedSpectrum(k * df, shape); }
        expect(Math.abs(measured / expected - 1), `${name} band ${(lowBin * df).toFixed(2)} Hz`).toBeLessThan(0.05);
        bands++;
        low = (highBin + 1) * df;
      }
    }
    expect(bands).toBeGreaterThan(30);
  }, 240_000);

  it('holds the variance when the step is far shorter than the eddy, where the noise covariance cancels', () => {
    // The largest eddy at the slowest carry and the highest rate: θ = (1/1200)·V/L, about 3e-5 and smaller.
    const turbulence = new DrydenTurbulence(1200), input = new Float64Array(DRYDEN_INPUT_SLOTS), wind = new Float64Array(3);
    input[DRYDEN_HEIGHT] = DRYDEN_MAX_HEIGHT_M; input[DRYDEN_RELATIVE_NORTH] = 1;
    const slots = new Float64Array([1, 1, 5]);
    turbulence.setStrengthFrom(slots, 0, 1); turbulence.restartFrom(slots, 2);
    let finite = true, total = 0;
    const steps = 2_000_000;
    for (let i = 0; i < steps; i++) { turbulence.stepAddInto(input, wind); const w = turbulence.channels[2]!; finite &&= Number.isFinite(w); total += w * w; }
    expect(finite).toBe(true);
    // 1667 s against τ = 305 s holds few independent samples, so this says only that the state neither died nor ran away; the
    // next test checks the variance where many are independent.
    expect(Math.sqrt(total / steps) / 0.1).toBeGreaterThan(0.3);
    expect(Math.sqrt(total / steps) / 0.1).toBeLessThan(2);
  });

  it('keeps unit variance across a change of coefficients, with no transient', () => {
    // Exact discretization: a state of unit variance stays at unit variance whatever θ follows.
    for (const height of [DRYDEN_MIN_HEIGHT_M, 30, 150]) for (const speed of [1, 15, 80]) {
      const turbulence = new DrydenTurbulence(800), input = new Float64Array(DRYDEN_INPUT_SLOTS), wind = new Float64Array(3);
      input[DRYDEN_HEIGHT] = height; input[DRYDEN_RELATIVE_NORTH] = speed;
      const slots = new Float64Array([1, 1, 11]);
      turbulence.setStrengthFrom(slots, 0, 1); turbulence.restartFrom(slots, 2);
      let sum = 0;
      const steps = 400_000, scales = drydenScales(height);
      for (let i = 0; i < steps; i++) { turbulence.stepAddInto(input, wind); sum += turbulence.channels[2]! ** 2; }
      const ratio = sum / steps / scales.sigmaVerticalPerW20 ** 2, independent = (steps / 800) * speed / (2 * scales.lengthVerticalM);
      // Four standard errors of a variance estimate, from the samples that are independent.
      expect(Math.abs(ratio - 1), `h ${height}, V ${speed}`).toBeLessThan(4 * Math.sqrt(2 / Math.max(independent, 1)));
    }
  });

  it('replays by seed, is exactly linear in intensity, and takes a separate stream per channel', () => {
    const series = (seed: number, intensity: number) => {
      const turbulence = new DrydenTurbulence(400), input = new Float64Array(DRYDEN_INPUT_SLOTS), wind = new Float64Array(3), out: number[] = [];
      input[DRYDEN_HEIGHT] = 20; input[DRYDEN_RELATIVE_NORTH] = 10;
      const slots = new Float64Array([10, intensity, seed]);
      turbulence.setStrengthFrom(slots, 0, 1); turbulence.restartFrom(slots, 2);
      for (let i = 0; i < 2000; i++) { wind.fill(0); turbulence.stepAddInto(input, wind); out.push(wind[0]!, wind[1]!, wind[2]!); }
      return out;
    };
    const one = series(7, 1), two = series(7, 2), half = series(7, 0.5);
    expect(series(7, 1)).toEqual(one);
    expect(series(8, 1)).not.toEqual(one);
    one.forEach((value, i) => { expect(two[i]).toBe(2 * value); expect(half[i]).toBe(0.5 * value); });
  });

  it('puts u along the mean wind and v across it, and north when there is none', () => {
    const axes = (north: number, east: number) => {
      const turbulence = new DrydenTurbulence(400), input = new Float64Array(DRYDEN_INPUT_SLOTS), wind = new Float64Array(3);
      input[DRYDEN_HEIGHT] = 20; input[DRYDEN_RELATIVE_NORTH] = 10; input[DRYDEN_MEAN_NORTH] = north; input[DRYDEN_MEAN_EAST] = east;
      const slots = new Float64Array([10, 1, 3]);
      turbulence.setStrengthFrom(slots, 0, 1); turbulence.restartFrom(slots, 2);
      turbulence.stepAddInto(input, wind);
      return { u: turbulence.channels[0]!, v: turbulence.channels[1]!, w: turbulence.channels[2]!, wind: Array.from(wind) };
    };
    const northerly = axes(4, 0);
    expect(northerly.wind).toEqual([northerly.u, northerly.v, northerly.w]);
    expect(axes(0, 0).wind).toEqual(northerly.wind);
    const easterly = axes(0, 7);
    expect(easterly.wind[0]).toBeCloseTo(-easterly.v, 12);
    expect(easterly.wind[1]).toBeCloseTo(easterly.u, 12);
    expect(easterly.wind[2]).toBe(easterly.w);
  });

  it('refreshes its coefficients on tick indices about 50 times a second, at every rate', () => {
    for (const [hz, ticks] of [[400, 8], [800, 16], [1200, 24]] as const) expect(new DrydenTurbulence(hz).refreshTicks).toBe(ticks);
    const turbulence = new DrydenTurbulence(400), input = new Float64Array(DRYDEN_INPUT_SLOTS), wind = new Float64Array(3);
    input[DRYDEN_HEIGHT] = 20; input[DRYDEN_RELATIVE_NORTH] = 30;
    const slots = new Float64Array([10, 1, 3]);
    turbulence.setStrengthFrom(slots, 0, 1); turbulence.restartFrom(slots, 2);
    turbulence.stepAddInto(input, wind);
    expect(turbulence.advectionMps).toBe(30);
    input[DRYDEN_RELATIVE_NORTH] = 40;
    for (let i = 1; i < 8; i++) { turbulence.stepAddInto(input, wind); expect(turbulence.advectionMps).toBe(30); }
    turbulence.stepAddInto(input, wind);
    expect(turbulence.advectionMps).toBe(40);
    // A vehicle hovering in still air is still in air the turbulence moves through at W20.
    input[DRYDEN_RELATIVE_NORTH] = 0;
    for (let i = 0; i < 8; i++) turbulence.stepAddInto(input, wind);
    expect(turbulence.advectionMps).toBe(10);
  });
});
