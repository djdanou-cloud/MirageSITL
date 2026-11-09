// Measured coaxial rotors (TASK-101; SPECS_SIMULATION_ENGINES "Measured coaxial rotors: NACA TN 2318"): two 25-ft coaxial
// rotors and the same rotors alone in static thrust in the Langley full-scale tunnel (Harrington 1951), digitized from the
// report's figures 4 and 8 into tests/fixtures/rotors/harrington-coaxial.json. Everything here was declared in the
// specification before the model's prediction was computed. Cold path.

import { POLAR_SCALE_RANGE } from '@mirage/physics/propulsion-calibration';

export const HARRINGTON_METHOD = Object.freeze({
  /** The fixture `scripts/digitize-harrington.mjs` writes, and the report it reads (the NTRS PDF without its 436-byte wrapper). */
  fixture: Object.freeze({ file: 'tests/fixtures/rotors/harrington-coaxial.json', sha256: '9f0dd22b72b2bc0e845b2d5bab7590cb6b1ee5ad758211bae03f3547442c0bf8' }),
  pdfSha256: '78e327b96dd4aaf8ab07dce706cb424bfb2c6c239f0fe9a62a847a920d056acf',
  /** Exact unit conversions. */
  metrePerInch: 0.0254, metrePerFoot: 0.3048,
  /** The report states no air state; the coefficients carry density out, so the model runs in ISA sea-level air. */
  air: Object.freeze({ densityKgM3: 1.225, temperatureK: 288.15 }),
  /** The catalog's one symmetrical NACA four-digit section. */
  polar: 'naca0012-extended-v1',
  /** Collective sweep, degrees; it stops at the first collective whose C_T exceeds `sweepBeyond` times the largest C_T needed. */
  collectiveDeg: Object.freeze({ from: 0, to: 20, step: 0.5 }), sweepBeyond: 1.1,
  /** Yaw trim of a coaxial run: differential collective (added to the lower rotor, taken from the upper) until the torques agree. */
  trim: Object.freeze({ torqueTolerance: 0.005, maxIterations: 8, firstStepDeg: 0.5 }),
  /** Each run: rate, length, the averaged tail, the speed hold and the steadiness of the last two half-seconds. */
  run: Object.freeze({ hz: 800, seconds: 10, averageS: 1, speedTolerance: 1e-3, steadyTolerance: 2e-3 }),
  /** Assumed mass of one blade, kg, for the shaft inertia only (a uniform bar from root to tip): it shapes the governor's transient, not a held speed's loads. */
  bladeMassKg: 40,
  /** Fit of measured C_Q against C_T: C_Q = a0 + a1 C_T^1.5 + a2 C_T^2 (profile, induced and the growth of profile drag with lift). */
  fitPowers: Object.freeze([0, 1.5, 2]),
  /** Performance: model C_Q at each measured C_T over the measured C_Q; summarized over points at C_T >= minCt. */
  performance: Object.freeze({ minCt: 0.001, tolerance: 0.05, standardErrors: 2, minFitPoints: 5 }),
  performanceConfigurations: Object.freeze([
    { id: 'r2-coaxial-392', rotor: 2, kind: 'coaxial', tipSpeedFps: 392, series: Object.freeze(['r2-coaxial-392']) },
    { id: 'r2-coaxial-327', rotor: 2, kind: 'coaxial', tipSpeedFps: 327, series: Object.freeze(['r2-coaxial-327']) },
    { id: 'r2-single-262', rotor: 2, kind: 'single', tipSpeedFps: 262, series: Object.freeze(['r2-single-lower-262']) },
    { id: 'r2-single-392', rotor: 2, kind: 'single', tipSpeedFps: 392, series: Object.freeze(['r2-single-lower-392']) },
    { id: 'r1-coaxial-500', rotor: 1, kind: 'coaxial', tipSpeedFps: 500, series: Object.freeze(['r1-coaxial-500']) },
    { id: 'r1-coaxial-450', rotor: 1, kind: 'coaxial', tipSpeedFps: 450, series: Object.freeze(['r1-coaxial-450']) },
    { id: 'r1-coaxial-327', rotor: 1, kind: 'coaxial', tipSpeedFps: 327, series: Object.freeze(['r1-coaxial-327']) },
    { id: 'r1-single-500', rotor: 1, kind: 'single', tipSpeedFps: 500, series: Object.freeze(['r1-single-lower-500', 'r1-single-upper-500', 'r1-single-unidentified-500']) },
  ] as const),
  /**
   * Interference: kappa = C_Q,coaxial(C_T) / (2 C_Q,single(C_T / 2)), the coaxial pair's torque over two lone rotors' at equal
   * thrust per rotor and tip speed; the single rotor's measured C_Q from the fit of its points, used only inside their C_T range.
   */
  interference: Object.freeze({ minCt: 0.002, tolerance: 0.02, standardErrors: 2 }),
  interferenceConfigurations: Object.freeze([
    { id: 'r2-392', rotor: 2, tipSpeedFps: 392, coaxial: 'r2-coaxial-392', single: Object.freeze(['r2-single-lower-262', 'r2-single-lower-392']) },
    { id: 'r2-327', rotor: 2, tipSpeedFps: 327, coaxial: 'r2-coaxial-327', single: Object.freeze(['r2-single-lower-262', 'r2-single-lower-392']) },
    { id: 'r1-500', rotor: 1, tipSpeedFps: 500, coaxial: 'r1-coaxial-500', single: Object.freeze(['r1-single-lower-500', 'r1-single-upper-500', 'r1-single-unidentified-500']) },
  ] as const),
});
/**
 * Second variant (declared 2026-11-09 before its prediction, SPECS_SIMULATION_ENGINES "Second variant"): every drag
 * coefficient of a rotor's polar multiplied by one scale s_D (TASK-145's form, within its range), fitted by the secant method
 * from `start` so that the model's mean C_Q over the measured one, over that rotor's single-rotor points used in the
 * performance comparison, is 1 within `tolerance`; no coaxial point enters the fit. Kept apart from HARRINGTON_METHOD so
 * that the first variant's method record stays as it was.
 */
export const HARRINGTON_DRAG_VARIANT = Object.freeze({
  id: 'sectionDragFitted',
  scaleRange: POLAR_SCALE_RANGE,
  start: Object.freeze([1, 2] as const), tolerance: 0.002, maxIterations: 8,
  fits: Object.freeze([
    { rotor: 2, performance: Object.freeze(['r2-single-262', 'r2-single-392'] as const) },
    { rotor: 1, performance: Object.freeze(['r1-single-500'] as const) },
  ] as const),
});
export type HarringtonPerformanceId = typeof HARRINGTON_METHOD.performanceConfigurations[number]['id'];
export type HarringtonInterferenceId = typeof HARRINGTON_METHOD.interferenceConfigurations[number]['id'];

/** A digitized point: C_T and C_Q on one disk area, with the digitization's standard uncertainties. */
export interface HarringtonPoint { readonly ct: number; readonly cq: number; readonly uCt: number; readonly uCq: number }
export interface HarringtonSeries {
  readonly id: string; readonly rotor: 1 | 2; readonly configuration: string; readonly solidity: number; readonly tipSpeedFps: number;
  readonly points: readonly HarringtonPoint[];
}
export interface HarringtonRotor {
  readonly rotor: 1 | 2; readonly radiusIn: number; readonly blades: number; readonly hubSpacingFt: number;
  /** Chord c0 + slope r, inches, r the radius in inches. */
  readonly chordC0In: number; readonly chordSlopeInPerIn: number; readonly rootCutoutIn: number;
}
export interface HarringtonFixture { readonly rotors: readonly HarringtonRotor[]; readonly series: readonly HarringtonSeries[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function finite(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`The Harrington fixture lacks a finite ${key}`);
  return value;
}
function rotorNumber(value: number): 1 | 2 {
  if (value === 1 || value === 2) return value;
  throw new Error(`The Harrington fixture names rotor ${value}`);
}
/** The fixture's parts this comparison reads, checked; anything else in it is provenance. */
export function validateHarringtonFixture(input: unknown): HarringtonFixture {
  if (!isRecord(input) || input.kind !== 'harrington-coaxial' || input.schemaVersion !== 1) throw new Error('Not a Harrington fixture of schema 1');
  const { rotors, series } = input;
  if (!Array.isArray(rotors) || !Array.isArray(series)) throw new Error('The Harrington fixture lacks rotors or series');
  return {
    rotors: rotors.map((value: unknown): HarringtonRotor => {
      if (!isRecord(value) || !isRecord(value.chord) || !isRecord(value.rootCutoutIn)) throw new Error('Invalid Harrington rotor');
      return { rotor: rotorNumber(finite(value, 'rotor')), radiusIn: finite(value, 'radiusIn'), blades: finite(value, 'blades'), hubSpacingFt: finite(value, 'hubSpacingFt'),
        chordC0In: finite(value.chord, 'c0In'), chordSlopeInPerIn: finite(value.chord, 'slopeInPerIn'), rootCutoutIn: finite(value.rootCutoutIn, 'value') };
    }),
    series: series.map((value: unknown): HarringtonSeries => {
      if (!isRecord(value) || typeof value.id !== 'string' || typeof value.configuration !== 'string' || !Array.isArray(value.points)) throw new Error('Invalid Harrington series');
      return { id: value.id, configuration: value.configuration, rotor: rotorNumber(finite(value, 'rotor')), solidity: finite(value, 'solidity'), tipSpeedFps: finite(value, 'tipSpeedFps'),
        points: value.points.map((p: unknown): HarringtonPoint => {
          if (!isRecord(p)) throw new Error(`Invalid point in ${String(value.id)}`);
          return { ct: finite(p, 'ct'), cq: finite(p, 'cq'), uCt: finite(p, 'uCt'), uCq: finite(p, 'uCq') };
        }) };
    }),
  };
}
/** The points of the named series together. */
export function pointsOf(fixture: HarringtonFixture, ids: readonly string[]): HarringtonPoint[] {
  return ids.flatMap(id => {
    const found = fixture.series.find(s => s.id === id);
    if (!found) throw new Error(`The Harrington fixture has no series ${id}`);
    return found.points;
  });
}

/** Least-squares fit of C_Q = sum a_k C_T^p_k (HARRINGTON_METHOD.fitPowers), with its residual RMS relative to C_Q. */
export interface TorqueFit {
  readonly coefficients: readonly number[]; readonly rmsRelative: number; readonly points: number;
  readonly ctMin: number; readonly ctMax: number;
}
export function fitTorque(points: readonly { readonly ct: number; readonly cq: number }[], powers: readonly number[] = HARRINGTON_METHOD.fitPowers): TorqueFit {
  const n = powers.length;
  if (points.length <= n) throw new Error(`A torque fit of ${n} terms needs more than ${n} points`);
  // Normal equations, solved by Gaussian elimination with partial pivoting; C_T^0 is 1 even at C_T = 0.
  const basis = (ct: number) => powers.map(p => (p === 0 ? 1 : Math.sign(ct) * Math.abs(ct) ** p));
  const m = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (const { ct, cq } of points) {
    const b = basis(ct);
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) m[i]![j]! += b[i]! * b[j]!; m[i]![n]! += b[i]! * cq; }
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const d = m[col]![col]!;
    if (Math.abs(d) < 1e-300) throw new Error('Singular torque fit');
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / d;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  const coefficients = m.map((row, i) => row[n]! / row[i]!);
  const at = (ct: number) => basis(ct).reduce((s, b, i) => s + b * coefficients[i]!, 0);
  const rmsRelative = Math.sqrt(points.reduce((s, { ct, cq }) => s + ((cq - at(ct)) / cq) ** 2, 0) / (points.length - n));
  return { coefficients, rmsRelative, points: points.length, ctMin: Math.min(...points.map(p => p.ct)), ctMax: Math.max(...points.map(p => p.ct)) };
}
export function evaluateTorque(fit: TorqueFit, ct: number, powers: readonly number[] = HARRINGTON_METHOD.fitPowers): number {
  return powers.reduce((s, p, i) => s + (p === 0 ? 1 : Math.sign(ct) * Math.abs(ct) ** p) * fit.coefficients[i]!, 0);
}

/** One point of the model's sweep. */
export interface SweepPoint { readonly collectiveDeg: number; readonly ct: number; readonly cq: number }
/**
 * The model's C_Q at `ct`, linear in C_T between the two sweep points around it; null outside the sweep's C_T range or where
 * the sweep's C_T does not rise with collective there.
 */
export function torqueAt(sweep: readonly SweepPoint[], ct: number): number | null {
  for (let i = 0; i + 1 < sweep.length; i++) {
    const a = sweep[i]!, b = sweep[i + 1]!;
    if (ct >= a.ct && ct <= b.ct) return b.ct > a.ct ? a.cq + (ct - a.ct) / (b.ct - a.ct) * (b.cq - a.cq) : null;
  }
  return null;
}

/** The declared summary rule: the model's mean inside the measured mean widened by `standardErrors` standard errors and the tolerance. */
export function reproduced(modelMean: number, measuredMean: number, standardError: number, tolerance: number, standardErrors: number): boolean {
  return Math.abs(modelMean - measuredMean) <= standardErrors * standardError + tolerance;
}

/**
 * The polar with every drag coefficient multiplied by `scale` and everything else (lift, axes, confidence, rotational lift
 * augmentation) as it was. TASK-145's `scaledPolar` drops the rotational augmentation, so the variant does not use it.
 */
export function dragScaledPolar<P extends { readonly cd: readonly number[] }>(polar: P, scale: number): P {
  const [low, high] = HARRINGTON_DRAG_VARIANT.scaleRange;
  if (!(scale >= low && scale <= high)) throw new Error(`A drag scale must be ${low} to ${high}, not ${scale}`);
  return { ...polar, cd: polar.cd.map(value => value * scale) };
}

/** One evaluation of the drag-scale fit: the scale and the model's mean C_Q over the measured one there, less 1. */
export interface DragFitStep { readonly scale: number; readonly residual: number }
/**
 * The secant method on `residual(scale)` from the two declared starts, until |residual| <= tolerance; throws after
 * `maxIterations` steps beyond the starts, on a flat secant, or when a step leaves the scale range.
 */
export function fitDragScale(residual: (scale: number) => number, variant: Pick<typeof HARRINGTON_DRAG_VARIANT, 'start' | 'tolerance' | 'maxIterations' | 'scaleRange'> = HARRINGTON_DRAG_VARIANT): { scale: number; steps: DragFitStep[] } {
  const [low, high] = variant.scaleRange;
  const steps: DragFitStep[] = [];
  const evaluate = (scale: number): DragFitStep => {
    if (!(scale >= low && scale <= high)) throw new Error(`The drag-scale fit left ${low} to ${high}: ${scale}`);
    const step = { scale, residual: residual(scale) };
    steps.push(step);
    return step;
  };
  let a = evaluate(variant.start[0]);
  if (Math.abs(a.residual) <= variant.tolerance) return { scale: a.scale, steps };
  let b = evaluate(variant.start[1]);
  for (let iteration = 0; Math.abs(b.residual) > variant.tolerance; iteration++) {
    if (iteration >= variant.maxIterations || b.residual === a.residual) throw new Error(`No drag-scale fit: residual ${b.residual} at ${b.scale}`);
    const next = b.scale - b.residual * (b.scale - a.scale) / (b.residual - a.residual);
    a = b; b = evaluate(next);
  }
  return { scale: b.scale, steps };
}

/** Measured interference at each coaxial point inside the single fit's C_T range (at C_T / 2) and at C_T >= minCt. */
export interface MeasuredKappa { readonly ct: number; readonly cq: number; readonly singleCq: number; readonly kappa: number; readonly kappaInduced: number }
export function measuredKappa(coaxial: readonly HarringtonPoint[], coaxialFit: TorqueFit, single: TorqueFit, minCt: number): MeasuredKappa[] {
  const out: MeasuredKappa[] = [];
  for (const p of coaxial) {
    const half = p.ct / 2;
    if (p.ct < minCt || half < single.ctMin || half > single.ctMax) continue;
    const singleCq = evaluateTorque(single, half);
    // The induced share: each curve less its own fitted profile torque at zero thrust (a0).
    const kappaInduced = (p.cq - coaxialFit.coefficients[0]!) / (2 * (singleCq - single.coefficients[0]!));
    out.push({ ct: p.ct, cq: p.cq, singleCq, kappa: p.cq / (2 * singleCq), kappaInduced });
  }
  return out;
}
