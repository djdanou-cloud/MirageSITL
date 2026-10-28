// Fidelity metrics (TASK-090): time-domain agreement and frequency-response
// identification. Offline evidence code; never call from a physics step.

/** Frequency-response cost weights (Ågren et al., NASA, AIAA 2025; Tischler and Remple 2012). */
export const MAGNITUDE_WEIGHT = 1;
/** Phase weight: 0.01745 makes 1 dB of magnitude error count as about 7.57 degrees of phase error. */
export const PHASE_WEIGHT = 0.01745;
/** Accepted-model guideline for J; J <= 50 is reported as nearly indistinguishable from flight. */
export const COST_GUIDELINE = 100;
/** Rule-of-thumb lower bound on the coherence of usable frequency points. */
export const COHERENCE_GUIDELINE = 0.6;

export interface TimeDomainMetrics {
  readonly samples: number;
  /** sqrt(mean((simulated - measured)^2)), in the series unit. */
  readonly rms: number;
  /** mean(simulated - measured), in the series unit. */
  readonly bias: number;
  /** Theil inequality coefficient in [0, 1]; 0 is a perfect match. */
  readonly theil: number;
}
export interface FrequencyResponse {
  readonly sampleRateHz: number;
  readonly segmentLength: number;
  readonly segments: number;
  /** Bins k = 1..N/2 at f_k = k·fs/N. */
  readonly frequencyHz: Float64Array;
  readonly real: Float64Array;
  readonly imag: Float64Array;
  /** Magnitude-squared coherence in [0, 1]; 0 at unexcited bins. */
  readonly coherence: Float64Array;
}
export interface FrequencyResponseCost {
  readonly cost: number;
  /** Frequency points used, after removing points below the coherence limit. */
  readonly points: number;
  readonly excludedPoints: number;
  readonly frequencyHz: readonly number[];
}
export type SpectralWindow = 'hann' | 'rectangular';
/**
 * A bin whose input auto-spectrum is at or below this fraction of the
 * strongest bin carries only round-off (an f64 FFT bin errs by ~1e-16 in
 * amplitude, 1e-32 in power) and is reported as unexcited: H is NaN and
 * γ² is 0. The floor sits 200 dB below the strongest bin.
 */
export const UNEXCITED_POWER_FRACTION = 1e-20;

function assertFiniteSeries(values: ArrayLike<number>, label: string): void {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new Error(`${label} contains a non-finite value at index ${i}`);
  }
}

/** Agreement of a simulated series with a measured one sampled at the same instants. */
export function timeDomainMetrics(measured: ArrayLike<number>, simulated: ArrayLike<number>): TimeDomainMetrics {
  const n = measured.length;
  if (n < 2 || simulated.length !== n) throw new Error('Time-domain series need equal lengths of at least two samples');
  assertFiniteSeries(measured, 'Measured series'); assertFiniteSeries(simulated, 'Simulated series');
  let errorSquares = 0, errorSum = 0, measuredSquares = 0, simulatedSquares = 0;
  for (let i = 0; i < n; i++) {
    const m = measured[i]!, s = simulated[i]!, e = s - m;
    errorSquares += e * e; errorSum += e; measuredSquares += m * m; simulatedSquares += s * s;
  }
  const rms = Math.sqrt(errorSquares / n), scale = Math.sqrt(simulatedSquares / n) + Math.sqrt(measuredSquares / n);
  if (!(scale > 0)) throw new Error('Theil coefficient is undefined for two all-zero series');
  return Object.freeze({ samples: n, rms, bias: errorSum / n, theil: rms / scale });
}

/** In-place iterative radix-2 FFT (decimation in time), X_k = Σ x_n·e^(−j2πkn/N). */
export function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (imag.length !== n || n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const r = real[i]!; real[i] = real[j]!; real[j] = r;
      const m = imag[i]!; imag[i] = imag[j]!; imag[j] = m;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = -2 * Math.PI / size;
    for (let k = 0; k < half; k++) {
      // Direct twiddles avoid the round-off growth of a recurrence.
      const wr = Math.cos(step * k), wi = Math.sin(step * k);
      for (let start = 0; start < n; start += size) {
        const a = start + k, b = a + half;
        const br = real[b]! * wr - imag[b]! * wi, bi = real[b]! * wi + imag[b]! * wr;
        real[b] = real[a]! - br; imag[b] = imag[a]! - bi;
        real[a] = real[a]! + br; imag[a] = imag[a]! + bi;
      }
    }
  }
}

/**
 * Welch H1 estimate H = Gxy/Gxx with magnitude-squared coherence
 * γ² = |Gxy|²/(Gxx·Gyy). Each segment has its mean removed and is windowed;
 * window scale factors cancel in both ratios. At least two segments are
 * required because a single segment gives γ² = 1 identically.
 */
export function welchFrequencyResponse(input: ArrayLike<number>, output: ArrayLike<number>, sampleRateHz: number,
  segmentLength: number, overlap: number, window: SpectralWindow = 'hann'): FrequencyResponse {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) throw new Error('Sample rate must be positive and finite');
  if (!Number.isInteger(segmentLength) || segmentLength < 16 || segmentLength > 65536 || (segmentLength & (segmentLength - 1)) !== 0) {
    throw new Error('Segment length must be a power of two in [16, 65536]');
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= segmentLength) throw new Error('Overlap must be an integer in [0, segment length)');
  if (input.length !== output.length) throw new Error('Input and output lengths differ');
  assertFiniteSeries(input, 'Input series'); assertFiniteSeries(output, 'Output series');
  const hop = segmentLength - overlap;
  const segments = input.length >= segmentLength ? Math.floor((input.length - segmentLength) / hop) + 1 : 0;
  if (segments < 2) throw new Error('Welch estimation needs at least two segments');
  const n = segmentLength, bins = n / 2;
  const weights = new Float64Array(n);
  for (let i = 0; i < n; i++) weights[i] = window === 'hann' ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n) : 1;
  const xr = new Float64Array(n), xi = new Float64Array(n), yr = new Float64Array(n), yi = new Float64Array(n);
  const gxx = new Float64Array(bins + 1), gyy = new Float64Array(bins + 1), gxyr = new Float64Array(bins + 1), gxyi = new Float64Array(bins + 1);
  for (let s = 0; s < segments; s++) {
    const start = s * hop;
    let meanX = 0, meanY = 0;
    for (let i = 0; i < n; i++) { meanX += input[start + i]!; meanY += output[start + i]!; }
    meanX /= n; meanY /= n;
    for (let i = 0; i < n; i++) {
      xr[i] = (input[start + i]! - meanX) * weights[i]!; xi[i] = 0;
      yr[i] = (output[start + i]! - meanY) * weights[i]!; yi[i] = 0;
    }
    fftInPlace(xr, xi); fftInPlace(yr, yi);
    for (let k = 1; k <= bins; k++) {
      gxx[k] = gxx[k]! + xr[k]! * xr[k]! + xi[k]! * xi[k]!;
      gyy[k] = gyy[k]! + yr[k]! * yr[k]! + yi[k]! * yi[k]!;
      // conj(X)·Y
      gxyr[k] = gxyr[k]! + xr[k]! * yr[k]! + xi[k]! * yi[k]!;
      gxyi[k] = gxyi[k]! + xr[k]! * yi[k]! - xi[k]! * yr[k]!;
    }
  }
  const frequencyHz = new Float64Array(bins), real = new Float64Array(bins), imag = new Float64Array(bins), coherence = new Float64Array(bins);
  let strongest = 0;
  for (let k = 1; k <= bins; k++) strongest = Math.max(strongest, gxx[k]!);
  const floor = strongest * UNEXCITED_POWER_FRACTION;
  for (let k = 1; k <= bins; k++) {
    const i = k - 1, xx = gxx[k]!, yy = gyy[k]!, cr = gxyr[k]!, ci = gxyi[k]!, excited = xx > floor && xx > 0;
    frequencyHz[i] = k * sampleRateHz / n;
    real[i] = excited ? cr / xx : NaN; imag[i] = excited ? ci / xx : NaN;
    coherence[i] = excited && yy > 0 ? Math.min(1, (cr * cr + ci * ci) / (xx * yy)) : 0;
  }
  return Object.freeze({ sampleRateHz, segmentLength, segments, frequencyHz, real, imag, coherence });
}

/** CIFER coherence weighting W_γ = [1.58·(1 − e^(−γ²))]². */
export function coherenceWeight(coherence: number): number {
  if (!Number.isFinite(coherence) || coherence < 0 || coherence > 1) throw new Error('Coherence must be in [0, 1]');
  const w = 1.58 * (1 - Math.exp(-coherence));
  return w * w;
}
function wrapDegrees(value: number): number {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}
/** Phase of x + jy in degrees, (−180, 180]. */
export function phaseDegrees(real: number, imag: number): number { return wrapDegrees(Math.atan2(imag, real) * 180 / Math.PI); }

/**
 * J = (20/n)·Σ W_γ·[W_g·(Δ|H|_dB)² + W_p·(Δ∠H_deg)²] over `points` logarithmically
 * spaced target frequencies in `bandHz`, each mapped to its nearest bin. W_γ
 * uses the reference (measured) coherence; points below `minCoherence` are
 * excluded and n counts the remaining points. Phase differences are wrapped.
 */
export function frequencyResponseCost(reference: FrequencyResponse, model: FrequencyResponse,
  options: { readonly bandHz: readonly [number, number]; readonly points: number; readonly minCoherence: number }): FrequencyResponseCost {
  if (reference.sampleRateHz !== model.sampleRateHz || reference.segmentLength !== model.segmentLength) {
    throw new Error('Reference and model frequency responses use different bins');
  }
  const [low, high] = options.bandHz, nyquist = reference.sampleRateHz / 2, binHz = reference.sampleRateHz / reference.segmentLength;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < binHz || high <= low || high > nyquist) {
    throw new Error('Cost band must lie within the first bin and the Nyquist frequency');
  }
  if (!Number.isInteger(options.points) || options.points < 2 || options.points > 1000) throw new Error('Point count must be an integer in [2, 1000]');
  if (!Number.isFinite(options.minCoherence) || options.minCoherence < 0 || options.minCoherence > 1) throw new Error('Minimum coherence must be in [0, 1]');
  const bins = new Set<number>();
  for (let i = 0; i < options.points; i++) {
    const target = low * (high / low) ** (i / (options.points - 1));
    bins.add(Math.min(reference.segmentLength / 2, Math.max(1, Math.round(target / binHz))));
  }
  let sum = 0, used = 0, excluded = 0;
  const frequencyHz: number[] = [];
  for (const k of [...bins].sort((a, b) => a - b)) {
    const i = k - 1, gamma = reference.coherence[i]!;
    const rr = reference.real[i]!, ri = reference.imag[i]!, mr = model.real[i]!, mi = model.imag[i]!;
    const referenceMagnitude = Math.hypot(rr, ri), modelMagnitude = Math.hypot(mr, mi);
    if (gamma < options.minCoherence || !(referenceMagnitude > 0) || !(modelMagnitude > 0)) { excluded++; continue; }
    const magnitudeDb = 20 * Math.log10(modelMagnitude / referenceMagnitude);
    const phaseDeg = wrapDegrees(phaseDegrees(mr, mi) - phaseDegrees(rr, ri));
    sum += coherenceWeight(gamma) * (MAGNITUDE_WEIGHT * magnitudeDb * magnitudeDb + PHASE_WEIGHT * phaseDeg * phaseDeg);
    used++;
    frequencyHz.push(reference.frequencyHz[i]!);
  }
  if (used === 0) throw new Error('No frequency point meets the coherence limit');
  return Object.freeze({ cost: 20 * sum / used, points: used, excludedPoints: excluded, frequencyHz: Object.freeze(frequencyHz) });
}
