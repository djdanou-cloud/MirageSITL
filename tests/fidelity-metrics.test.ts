import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SeededRandom } from '@mirage/test-support/prng';
import { ARDUPILOT_MESSAGES, syntheticLog, type SyntheticValue } from './support/synthetic-log';
import captureV1 from './fixtures/validation/fidelity-synthetic-capture.json';
import capture from './fixtures/validation/fidelity-synthetic-capture-v2.json';
import {
  COST_GUIDELINE, PHASE_WEIGHT, coherenceWeight, fftInPlace, frequencyResponseCost, phaseDegrees, timeDomainMetrics,
  welchFrequencyResponse, type FrequencyResponse,
} from '@mirage/physics/fidelity-metrics';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const N = 64, FS = 100, A = 0.8;
/** Schroeder multisine over bins 1..31 of a 64-sample period, as in the synthetic capture. */
function multisine(samples: number): number[] {
  return Array.from({ length: samples }, (_, i) => {
    let x = 0;
    for (let k = 1; k <= 31; k++) x += 0.05 * Math.cos(2 * Math.PI * k * i / N - Math.PI * k * (k - 1) / 31);
    return x;
  });
}
/** Analytic H(e^jω) = (1 − a)/(1 − a·e^(−jω)) of y[n] = a·y[n−1] + (1 − a)·x[n]. */
function lowPass(k: number, n = N): [number, number] {
  const w = 2 * Math.PI * k / n, dr = 1 - A * Math.cos(w), di = A * Math.sin(w), den = dr * dr + di * di;
  return [(1 - A) * dr / den, -(1 - A) * di / den];
}
function filtered(input: readonly number[]): number[] {
  let y = 0;
  return input.map(x => (y = A * y + (1 - A) * x));
}
function wrap(deg: number): number { const v = ((deg + 180) % 360 + 360) % 360 - 180; return v === -180 ? 180 : v; }
/** A copy of an estimate with each bin rotated by `degrees` and scaled by `gain`, or a replaced coherence. */
function altered(source: FrequencyResponse, gain: number, degrees: number, coherence?: (i: number) => number): FrequencyResponse {
  const c = Math.cos(degrees * Math.PI / 180), s = Math.sin(degrees * Math.PI / 180);
  const real = source.real.map((r, i) => gain * (r * c - source.imag[i]! * s));
  const imag = source.imag.map((m, i) => gain * (source.real[i]! * s + m * c));
  return { ...source, real, imag, coherence: coherence ? source.coherence.map((_, i) => coherence(i)) : source.coherence };
}

describe('spectral estimation', () => {
  it('matches a direct DFT', () => {
    const rng = new SeededRandom(90, 1), n = 64;
    const x = Array.from({ length: n }, () => rng.nextFloat() - 0.5);
    const real = Float64Array.from(x), imag = new Float64Array(n);
    fftInPlace(real, imag);
    for (let k = 0; k < n; k++) {
      let dr = 0, di = 0;
      for (let t = 0; t < n; t++) { dr += x[t]! * Math.cos(-2 * Math.PI * k * t / n); di += x[t]! * Math.sin(-2 * Math.PI * k * t / n); }
      expect(Math.abs(real[k]! - dr)).toBeLessThan(1e-12);
      expect(Math.abs(imag[k]! - di)).toBeLessThan(1e-12);
    }
    expect(() => fftInPlace(new Float64Array(12), new Float64Array(12))).toThrow('power of two');
  });

  it('recovers a time-domain IIR filter as its analytic response with unit coherence', () => {
    // Ten periods through the filter; the first six carry the transient (0.8^384 ≈ 1e-37).
    const x = multisine(10 * N), y = filtered(x);
    const estimate = welchFrequencyResponse(x.slice(6 * N), y.slice(6 * N), FS, N, 0, 'rectangular');
    expect(estimate.segments).toBe(4);
    for (let k = 1; k <= 31; k++) {
      const [hr, hi] = lowPass(k), i = k - 1;
      expect(estimate.frequencyHz[i]).toBe(k * FS / N);
      expect(Math.hypot(estimate.real[i]! - hr, estimate.imag[i]! - hi) / Math.hypot(hr, hi)).toBeLessThan(1e-12);
      expect(estimate.coherence[i]).toBeGreaterThan(1 - 1e-12);
    }
    // The unexcited Nyquist bin has no input power.
    expect(estimate.coherence[31]).toBe(0);
    expect(Number.isNaN(estimate.real[31])).toBe(true);
  });

  it('gives a pure delay 0 dB and a phase of −360·f·d/fs degrees', () => {
    const x = multisine(5 * N), d = 3, y = x.map((_, i) => x[(i - d + 5 * N) % (5 * N)]!);
    const estimate = welchFrequencyResponse(x, y, FS, N, 0, 'rectangular');
    for (let k = 1; k <= 31; k++) {
      const i = k - 1;
      expect(Math.abs(20 * Math.log10(Math.hypot(estimate.real[i]!, estimate.imag[i]!)))).toBeLessThan(1e-11);
      expect(Math.abs(wrap(phaseDegrees(estimate.real[i]!, estimate.imag[i]!) + 360 * k * d / N))).toBeLessThan(1e-9);
    }
  });

  it('estimates the coherence of a known signal-to-noise ratio', () => {
    // y = x + v with independent white v of equal variance: γ² = 1/2 and H = 1 at every bin.
    const signal = new SeededRandom(90, 2), noise = new SeededRandom(90, 3), samples = 256 * 64;
    const x = Array.from({ length: samples }, () => signal.nextFloat() - 0.5);
    const y = x.map(v => v + noise.nextFloat() - 0.5);
    const estimate = welchFrequencyResponse(x, y, FS, 256, 128, 'hann');
    expect(estimate.segments).toBe(127);
    let coherence = 0, magnitude = 0;
    for (let i = 0; i < 128; i++) { coherence += estimate.coherence[i]!; magnitude += Math.hypot(estimate.real[i]!, estimate.imag[i]!); }
    // Bendat and Piersol: the normalized random error of γ² is √2·(1−γ²)/(|γ|·√n_d) = 0.125 for
    // n_d = 64 independent segments, ≈0.06 absolute per bin (the 127 overlapping Hann segments
    // measure ≈0.05). About 64 independent bins in the band mean give σ ≈ 0.006, so 0.03 is a 5σ
    // bound. |H| errs by √(1−γ²)/(|γ|·√(2·n_d)) ≈ 0.09 per bin, σ ≈ 0.011 in the mean: 0.04 ≈ 4σ.
    expect(Math.abs(coherence / 128 - 0.5)).toBeLessThan(0.03);
    expect(Math.abs(magnitude / 128 - 1)).toBeLessThan(0.04);
  });

  it('rejects invalid spectral inputs', () => {
    const x = multisine(4 * N);
    expect(() => welchFrequencyResponse(x, x, FS, 48, 0)).toThrow('power of two');
    expect(() => welchFrequencyResponse(x, x, FS, 256, 0)).toThrow('two segments');
    expect(() => welchFrequencyResponse(x, x.slice(1), FS, N, 0)).toThrow('lengths differ');
    expect(() => welchFrequencyResponse([...x.slice(1), NaN], x, FS, N, 0)).toThrow('non-finite');
    expect(() => welchFrequencyResponse(x, x, 0, N, 0)).toThrow('Sample rate');
    expect(() => welchFrequencyResponse(x, x, FS, N, N)).toThrow('Overlap');
  });
});

describe('frequency-response cost', () => {
  const x = multisine(4 * N), y = filtered(multisine(10 * N)).slice(6 * N);
  const reference = welchFrequencyResponse(x, y, FS, N, 0, 'rectangular');
  const bandHz: [number, number] = [FS / N, 30 * FS / N];
  const band = { bandHz, points: 20, minCoherence: 0.6 };
  const unitWeight = (1.58 * (1 - Math.exp(-1))) ** 2;

  it('uses the CIFER coherence weighting [1.58(1 − e^(−γ²))]²', () => {
    expect(coherenceWeight(1)).toBeCloseTo(unitWeight, 15);
    expect(coherenceWeight(0)).toBe(0);
    expect(coherenceWeight(0.6)).toBeCloseTo((1.58 * (1 - Math.exp(-0.6))) ** 2, 15);
    expect(() => coherenceWeight(1.01)).toThrow();
  });

  it('gives the analytic J for known magnitude and phase mismatches', () => {
    const gain = 10 ** (1 / 20);
    // An output scaled by +1 dB end to end: J = 20·W(1)·1².
    const scaled = welchFrequencyResponse(x, y.map(v => gain * v), FS, N, 0, 'rectangular');
    const fit = frequencyResponseCost(reference, scaled, band);
    expect(Math.abs(fit.cost - 20 * unitWeight) / (20 * unitWeight)).toBeLessThan(1e-9);
    expect(fit.excludedPoints).toBe(0);
    // Log-spaced targets that share a bin count once: 20 targets over bins 1..30 hit 15 bins.
    expect(fit.points).toBe(15);
    const lagged = frequencyResponseCost(reference, altered(reference, 1, -10), band);
    expect(lagged.cost).toBeCloseTo(20 * unitWeight * PHASE_WEIGHT * 100, 9);
    const both = frequencyResponseCost(reference, altered(reference, gain, 10), band);
    expect(both.cost).toBeCloseTo(20 * unitWeight * (1 + PHASE_WEIGHT * 100), 9);
    // A 350° difference is the same −10° error, not a 350° error.
    expect(frequencyResponseCost(reference, altered(reference, 1, 350), band).cost).toBeCloseTo(lagged.cost, 9);
    expect(frequencyResponseCost(reference, reference, band).cost).toBe(0);
  });

  it('weights by the reference coherence and excludes points below the limit', () => {
    const gain = 10 ** (1 / 20);
    const partial = altered(reference, 1, 0, () => 0.8);
    expect(frequencyResponseCost(partial, altered(reference, gain, 0), band).cost).toBeCloseTo(20 * coherenceWeight(0.8), 9);
    const holes = altered(reference, 1, 0, i => (i % 2 === 0 ? 0.5 : 1));
    const fit = frequencyResponseCost(holes, altered(reference, gain, 0), band);
    expect(fit.excludedPoints).toBeGreaterThan(0);
    expect(fit.points + fit.excludedPoints).toBe(15);
    // A constant mismatch keeps J independent of how many points survive.
    expect(fit.cost).toBeCloseTo(20 * unitWeight, 9);
    expect(() => frequencyResponseCost(altered(reference, 1, 0, () => 0.1), reference, band)).toThrow('coherence');
  });

  it('rejects incompatible bins and invalid options', () => {
    const other = welchFrequencyResponse(multisine(8 * N), multisine(8 * N), FS, 2 * N, 0);
    expect(() => frequencyResponseCost(reference, other, band)).toThrow('different bins');
    expect(() => frequencyResponseCost(reference, reference, { ...band, bandHz: [0.5, 20] })).toThrow('band');
    expect(() => frequencyResponseCost(reference, reference, { ...band, bandHz: [2, 60] })).toThrow('band');
    expect(() => frequencyResponseCost(reference, reference, { ...band, points: 1 })).toThrow('Point count');
    expect(() => frequencyResponseCost(reference, reference, { ...band, minCoherence: 2 })).toThrow('coherence');
  });
});

describe('time-domain metrics', () => {
  it('gives the analytic RMS, bias and Theil coefficient of a biased sinusoid', () => {
    // Two full periods of 0.5·sin(2π·2t) at 100 Hz; the simulation adds 0.01.
    const measured = Array.from({ length: 100 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 2 * i / 100));
    const metrics = timeDomainMetrics(measured, measured.map(v => v + 0.01));
    expect(metrics.bias).toBeCloseTo(0.01, 14);
    expect(metrics.rms).toBeCloseTo(0.01, 14);
    expect(metrics.theil).toBeCloseTo(0.01 / (Math.sqrt(0.125 + 0.0001) + Math.sqrt(0.125)), 12);
    expect(timeDomainMetrics(measured, measured)).toEqual({ samples: 100, rms: 0, bias: 0, theil: 0 });
    expect(() => timeDomainMetrics([0, 0], [0, 0])).toThrow('Theil');
    expect(() => timeDomainMetrics([1, 2], [1])).toThrow('equal lengths');
    expect(() => timeDomainMetrics([1, Infinity], [1, 2])).toThrow('non-finite');
  });
});

describe('synthetic fidelity capture and check-fidelity CLI', () => {
  // TASK-184: capture schema 2 holds the same series without limits; the CLI reports metrics and never judges them (SA-01).
  const fixturePath = new URL('./fixtures/validation/fidelity-synthetic-capture-v2.json', import.meta.url).pathname;
  const v1Path = new URL('./fixtures/validation/fidelity-synthetic-capture.json', import.meta.url).pathname;
  const bytes = readFileSync(fixturePath);
  const csv = readFileSync(new URL('./fixtures/validation/bench-synthetic.csv', import.meta.url), 'utf8');
  /** Checked access into an untrusted JSON report. */
  function at(value: unknown, ...keys: string[]): unknown {
    let current = value;
    for (const key of keys) {
      const entry = typeof current === 'object' && current !== null && !Array.isArray(current)
        ? Object.entries(current).find(([name]) => name === key) : undefined;
      if (!entry) throw new Error(`Report lacks ${keys.join('.')}`);
      current = entry[1];
    }
    return current;
  }
  function numberAt(value: unknown, ...keys: string[]): number {
    const found = at(value, ...keys);
    if (typeof found !== 'number') throw new Error(`Report field ${keys.join('.')} is not a number`);
    return found;
  }
  function run(args: readonly string[]): { status: number | null; report: unknown } {
    const result = spawnSync(process.execPath, ['scripts/check-fidelity.mjs', ...args], { encoding: 'utf8' });
    const report: unknown = JSON.parse(readFileSync('test-results/validation/fidelity.json', 'utf8'));
    return { status: result.status, report };
  }
  /** Writes a changed copy of the fixture to a temporary file and returns hashed CLI arguments. */
  function variant(change: (copy: typeof capture) => unknown): string[] {
    const text = JSON.stringify(change(structuredClone(capture)));
    const path = join(mkdtempSync(join(tmpdir(), 'mirage-fidelity-')), 'capture.json');
    writeFileSync(path, text);
    return ['--input', path, '--sha256', sha256(text)];
  }
  const flight = (c: typeof capture) => ({ ...c, provenance: { ...c.provenance, source: 'flight-test', firmwareSha256: 'a'.repeat(64) } });
  const response = (c: typeof capture, change: Record<string, unknown>) => ({ ...c, frequencyResponse: [{ ...c.frequencyResponse[0]!, ...change }] });
  const unitCost = 20 * (1.58 * (1 - Math.exp(-1))) ** 2;

  it('stores the analytic series it documents, those of capture schema 1 without its limits', () => {
    const series = capture.frequencyResponse[0]!, input = multisine(4 * N);
    for (let i = 0; i < 4 * N; i++) {
      let y = 0;
      for (let k = 1; k <= 31; k++) {
        const [hr, hi] = lowPass(k);
        y += 0.05 * Math.hypot(hr, hi) * Math.cos(2 * Math.PI * k * i / N - Math.PI * k * (k - 1) / 31 + Math.atan2(hi, hr));
      }
      expect(Math.abs(series.measuredInput[i]! - input[i]!)).toBeLessThan(1e-12);
      expect(Math.abs(series.measuredOutput[i]! - y)).toBeLessThan(1e-12);
      expect(Math.abs(series.simulatedOutput[i]! - 10 ** (1 / 20) * y)).toBeLessThan(1e-12);
    }
    const roll = capture.timeDomain[0]!;
    for (let i = 0; i < 100; i++) expect(Math.abs(roll.simulated[i]! - roll.measured[i]! - 0.01)).toBeLessThan(1e-15);
    expect(capture.bench.csv).toBe(csv);
    expect(capture.bench.csvSha256).toBe(sha256(csv));
    const { limits: _timeLimits, ...v1Roll } = captureV1.timeDomain[0]!, { maxCost: _cost, ...v1Response } = captureV1.frequencyResponse[0]!;
    const { limits: _benchLimits, ...v1Bench } = captureV1.bench;
    expect([roll, series, capture.bench]).toEqual([v1Roll, v1Response, v1Bench]);
    expect([_timeLimits, _cost, _benchLimits].every(value => value !== undefined)).toBe(true);
  });

  it('reports BLOCKED_EXTERNAL without input and for synthetic provenance, with the metrics and no verdict', () => {
    const missing = run([]);
    expect(missing.status).toBe(2);
    expect(at(missing.report, 'status')).toBe('BLOCKED_EXTERNAL');
    const synthetic = run(['--input', fixturePath, '--sha256', sha256(bytes)]);
    expect(synthetic.status).toBe(2);
    expect(at(synthetic.report, 'status')).toBe('BLOCKED_EXTERNAL');
    expect(Math.abs(numberAt(synthetic.report, 'metrics', 'frequencyResponse', 'roll-rate-response', 'cost') - unitCost)).toBeLessThan(1e-9);
    expect(numberAt(synthetic.report, 'metrics', 'timeDomain', 'roll-rate', 'bias')).toBeCloseTo(0.01, 12);
    expect(numberAt(synthetic.report, 'metrics', 'bench', 'flaggedRows')).toBe(0);
    expect(numberAt(synthetic.report, 'metrics', 'bench', 'largestCtRelativeError')).toBeCloseTo(0.02, 9);
    expect(numberAt(synthetic.report, 'metrics', 'bench', 'largestCpRelativeError')).toBeCloseTo(0.03, 9);
    expect(JSON.stringify(synthetic.report)).not.toMatch(/limitsMet|"passed"|"limits"|maxCost/);
  });

  it('reports a measured capture\'s metrics without a limit or a verdict, whatever they are', () => {
    const reported = run(variant(flight));
    expect(reported.status).toBe(0);
    expect(at(reported.report, 'status')).toBe('REPORTED');
    expect(at(reported.report, 'reasons')).toEqual(['The metrics are reported without a limit or a verdict (SA-01); the user judges them']);
    expect(Math.abs(numberAt(reported.report, 'metrics', 'frequencyResponse', 'roll-rate-response', 'cost') - unitCost)).toBeLessThan(1e-9);
    // A model ten times further off is reported the same way: nothing here passes or fails it.
    const far = run(variant(c => ({ ...flight(c), timeDomain: [{ ...c.timeDomain[0]!, simulated: c.timeDomain[0]!.measured.map(x => x + 0.1) }] })));
    expect(far.status).toBe(0);
    expect(at(far.report, 'status')).toBe('REPORTED');
    expect(numberAt(far.report, 'metrics', 'timeDomain', 'roll-rate', 'bias')).toBeCloseTo(0.1, 12);
  });

  it('refuses capture schema 1, whose limits are no longer applied', () => {
    const refused = run(['--input', v1Path, '--sha256', sha256(readFileSync(v1Path))]);
    expect(refused.status).toBe(1);
    expect(at(refused.report, 'status')).toBe('FAIL');
    expect(at(refused.report, 'reasons')).toEqual(['Capture schema 1 declares limits, which MirageSITL no longer applies (SA-01, TASK-184): write capture schema 2 without them']);
  });

  it('fails malformed or unhashed evidence, and a limit written into schema 2', () => {
    const cases: [string, string[]][] = [
      ['hash mismatch', ['--input', fixturePath, '--sha256', 'f'.repeat(64)]],
      ['missing hash', ['--input', fixturePath]],
      ['unknown key', variant(c => ({ ...flight(c), extra: true }))],
      ['a time-domain limit', variant(c => ({ ...flight(c), timeDomain: [{ ...c.timeDomain[0]!, limits: { maxRms: 1, maxAbsBias: 1, maxTheil: 1 } }] }))],
      ['a cost limit', variant(c => response(flight(c), { maxCost: COST_GUIDELINE }))],
      ['a bench limit', variant(c => ({ ...flight(c), bench: { ...c.bench, limits: { maxCtRelativeError: 0.05, maxCpRelativeError: 0.05 } } }))],
      ['coherence threshold below the method\'s', variant(c => response(flight(c), { minCoherence: 0.5 }))],
      ['zero firmware hash on a flight test', variant(c => ({ ...c, provenance: { ...c.provenance, source: 'flight-test' } }))],
      ['unknown source', variant(c => ({ ...c, provenance: { ...c.provenance, source: 'simulation' } }))],
      ['tampered bench CSV', variant(c => ({ ...flight(c), bench: { ...c.bench, csv: c.bench.csv.replace('2000,', '2001,') } }))],
      ['no sections', variant(c => ({ ...flight(c), timeDomain: [], frequencyResponse: [], bench: null }))],
    ];
    for (const [label, args] of cases) {
      const result = run(args);
      expect(result.status, label).toBe(1);
      expect(at(result.report, 'status'), label).toBe('FAIL');
    }
  });

  it('lists physically inconsistent bench rows and leaves them out of the bench errors', () => {
    const result = run(variant(c => {
      const text = c.bench.csv.replace('2000,0.610472757547,', '2000,-0.610472757547,');
      return { ...flight(c), bench: { ...c.bench, csv: text, csvSha256: sha256(text) } };
    }));
    expect(result.status).toBe(0);
    expect(at(result.report, 'status')).toBe('REPORTED');
    expect(numberAt(result.report, 'metrics', 'bench', 'flaggedRows')).toBe(1);
    expect(numberAt(result.report, 'metrics', 'bench', 'comparedRows')).toBe(numberAt(result.report, 'metrics', 'bench', 'rows') - 1);
    expect(at(result.report, 'metrics', 'bench', 'flagged')).toEqual([{ row: 1, rpm: 2000, flags: ['negative-thrust'] }]);
    expect(at(result.report, 'reasons')).toContain('1 bench rows are physically inconsistent and left out of the bench errors');
  });
});

// TASK-090: scripts/fidelity-capture.mjs turns two DataFlash logs into a capture schema 2. Declared before the first run:
//  - a real log and a simulated one whose roll is 2° off give RMS 2 and bias 2 through scripts/check-fidelity.mjs within the logs' float32
//    storage (1e-5), with a REPORTED status and no limit or verdict in it;
//  - a requested rate answered by a first-order lag at 2 Hz in both logs gives J = 0 within 1e-9, and the same lag at another corner a J above 0;
//  - a SITL log as the "real" one is a synthetic capture, BLOCKED_EXTERNAL, whatever the file is called;
//  - a quantity a log lacks is left out and listed; missing input exits 2, invalid input exits 1.

const HEX = 'ab'.repeat(32), RATE = 50, SECONDS = 60;
/** An uneven multisine that excites the band, deg/s. */
const requested = (t: number): number => [0.7, 1.3, 2.3, 3.7, 5.3, 7.1, 11, 17].reduce((sum, f, i) => sum + Math.sin(2 * Math.PI * f * t + i * i), 0);
function log(options: { simulated?: boolean; rollOffsetDeg?: number; cornerHz?: number; noRate?: boolean }): Uint8Array {
  const rows: { message: string; values: SyntheticValue[] }[] = [], us = (t: number) => Math.round(t * 1e6);
  rows.push({ message: 'PARM', values: [0, options.simulated ? 'SIM_RATE_HZ' : 'ATC_RAT_RLL_P', options.simulated ? 1200 : 0.135, 0] });
  const a = 1 - Math.exp(-2 * Math.PI * (options.cornerHz ?? 2) / RATE);
  let actual = 0;
  for (let i = 0; i <= SECONDS * RATE; i++) {
    const t = i / RATE, wanted = requested(t);
    actual += a * (wanted - actual);
    rows.push({ message: 'ATT', values: [us(t), 0, 5 * Math.sin(t) + (options.rollOffsetDeg ?? 0), 0, 3 * Math.cos(t), 0, 10] });
    if (!options.noRate) rows.push({ message: 'RATE', values: [us(t), wanted, actual, 0, 0, 0, 0] });
  }
  return syntheticLog(ARDUPILOT_MESSAGES.filter(message => ['PARM', 'ATT', ...(options.noRate ? [] : ['RATE'])].includes(message.name)), rows);
}
const directory = mkdtempSync(join(tmpdir(), 'mirage-capture-'));
const write = (name: string, bytes: Uint8Array) => { const path = join(directory, name); writeFileSync(path, bytes); return path; };
function fromLogs(real: string, simulated: string, name: string) {
  const out = join(directory, name);
  const run = spawnSync(process.execPath, ['scripts/fidelity-capture.mjs', '--real', real, '--simulated', simulated, '--firmware-sha256', HEX, '--model-sha256', HEX,
    '--operator', 'test', '--recorded-at', '2026-11-06T00:00:00Z', '--out', out], { encoding: 'utf8' });
  return { run, out };
}
function checkCapture(path: string) {
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  // The checker writes one report file, so these run in this file's sequence, beside its other uses of it.
  const run = spawnSync(process.execPath, ['scripts/check-fidelity.mjs', '--input', path, '--sha256', sha], { encoding: 'utf8' });
  const report = JSON.parse(readFileSync('test-results/validation/fidelity.json', 'utf8')) as { status: string; reasons: string[]; metrics: { source: string; timeDomain: Record<string, { rms: number; bias: number }>; frequencyResponse: Record<string, { cost: number }> } };
  return { status: run.status, report };
}

describe('a capture from two logs', () => {
  const real = write('real.bin', log({})), off = write('off.bin', log({ simulated: true, rollOffsetDeg: 2 }));
  it('reports a real flight beside its simulation, with no limit and no verdict', () => {
    const { run, out } = fromLogs(real, off, 'flight.json');
    expect(run.status, run.stderr).toBe(0);
    const made = JSON.parse(readFileSync(out, 'utf8')) as { provenance: { source: string; logs: { realSha256: string } } };
    expect(made.provenance.source).toBe('flight-test');
    expect(made.provenance.logs.realSha256).toBe(createHash('sha256').update(readFileSync(real)).digest('hex'));
    const { status, report } = checkCapture(out);
    expect(status).toBe(0);
    expect(report.status).toBe('REPORTED');
    expect(report.metrics.timeDomain.roll?.rms).toBeCloseTo(2, 4);
    expect(report.metrics.timeDomain.roll?.bias).toBeCloseTo(2, 4);
    expect(report.metrics.frequencyResponse['roll-rate-response']?.cost).toBeLessThan(1e-9);
    expect(JSON.stringify(report).toLowerCase()).not.toMatch(/"(pass|fail|limit|verdict)"/);
  });
  it('sees a different response as a cost above zero', () => {
    const slower = write('slower.bin', log({ simulated: true, cornerHz: 1 }));
    const { run, out } = fromLogs(real, slower, 'slower.json');
    expect(run.status, run.stderr).toBe(0);
    expect(checkCapture(out).report.metrics.frequencyResponse['roll-rate-response']?.cost).toBeGreaterThan(1);
  });
  it('never takes a SITL log for a flight, whatever the file is called', () => {
    const named = write('real-flight.bin', log({ simulated: true }));
    const { run, out } = fromLogs(named, off, 'sitl.json');
    expect(run.status, run.stderr).toBe(0);
    const { status, report } = checkCapture(out);
    expect(status).toBe(2);
    expect(report.status).toBe('BLOCKED_EXTERNAL');
    expect(report.metrics.source).toBe('synthetic');
  });
  it('leaves out what a log lacks, and lists it', () => {
    const { run, out } = fromLogs(write('no-rate.bin', log({ noRate: true })), off, 'no-rate.json');
    expect(run.status, run.stderr).toBe(0);
    const summary = JSON.parse(run.stdout) as { timeDomain: string[]; frequencyResponse: string[]; skipped: { id: string; reason: string }[] };
    expect(summary.timeDomain).toContain('roll');
    expect(summary.timeDomain).not.toContain('roll-rate');
    expect(summary.frequencyResponse).toEqual([]);
    expect(summary.skipped.map(item => item.id)).toEqual(expect.arrayContaining(['roll-rate', 'altitude', 'roll-rate-response']));
    expect((JSON.parse(readFileSync(out, 'utf8')) as { frequencyResponse: unknown[] }).frequencyResponse).toEqual([]);
  });
  it('exits 2 without its input and 1 for what it cannot read', () => {
    expect(spawnSync(process.execPath, ['scripts/fidelity-capture.mjs'], { encoding: 'utf8' }).status).toBe(2);
    const bad = write('bad.bin', new Uint8Array([1, 2, 3]));
    expect(fromLogs(bad, off, 'bad.json').run.status).toBe(1);
    expect(spawnSync(process.execPath, ['scripts/fidelity-capture.mjs', '--unknown', 'x'], { encoding: 'utf8' }).status).toBe(1);
  });
});
