import type { DataFlashColumn, DataFlashGroup, DataFlashLog } from "@mirage/dataflash/reader";
import { BarometerEffect, BarometerErrors, BarometerInput } from "@mirage/physics/barometer";

// Logged barometer dips (TASK-116; SPECS_SIMULATION_ENGINES "Logged dips"): the barometer's excess pressure around each motor start
// and stop of a real ArduCopter log, against a height reference that does not use the barometer (the GNSS altitude), the fit of the
// ground-cushion model to the landings, and the model's own prediction for a held-out log. The method's constants were declared in the
// specification before the first comparison. Cold path.

export const DIP_METHOD = Object.freeze({
  /** `CTUN.ThO` above this is motors on. */
  throttleOn: 0.05,
  /** Motors-off reference windows, s from the start or stop. */
  referenceBeforeS: Object.freeze([-4.5, -0.5] as const),
  referenceAfterS: Object.freeze([1, 5] as const),
  minReferenceSamples: 10,
  /** The GNSS height at the start or stop is within this of the reference: the vehicle is on the ground, m. */
  groundToleranceM: 0.5,
  /** Measured samples: motors on within this after a start or before a stop, s. */
  windowS: 15,
  /** A start or stop counts only when the vehicle flew: a measured sample at least this high, m (added after the first run), */
  minFlightHeightM: 1,
  /** or samples at or above `nearGroundM` spanning at least this long, s (added for a low hover, 2026-11-07). */
  lowHoverS: 5,
  /** The near-ground excess is the mean of the samples within this of the reference height, m. */
  nearGroundM: 0.3,
  /** Air temperature of the hydrostatic correction, not logged, K. */
  airTemperatureK: 288.15,
  /** Landing samples fitted, m above the landed position. */
  fitMaxHeightM: 2,
  decayGrid: Object.freeze({ min: 0.1, max: 10, count: 200 }),
  /** A rangefinder height is used only within this of a good reading, s. */
  rangefinderGapS: 0.25,
  /** Height bins of the reported profile, m. */
  profileBinsM: Object.freeze([0, 0.15, 0.3, 0.6, 1.2, 2.4, 4.8]),
});
/** The declared reproduction tolerance of a held-out near-ground excess: within 5 Pa or 30 %, whichever is larger. */
export const DIP_TOLERANCE = Object.freeze({ absolutePa: 5, relative: 0.3 });
/**
 * The two-level metric (declared 2026-11-08, before any run on a log not yet seen): the on-ground excess and the airborne offset
 * apart, each judged by `DIP_TOLERANCE`, in place of one near-ground mean that weighs the step by how many samples fall in its
 * first centimetres. Rangefinder heights only: a GNSS height cannot resolve the ground band.
 */
export const DIP_TWO_LEVEL = Object.freeze({
  /** On-ground samples: within this of the motors-off reference height, m (the step seen at 0.03 to 0.06 m). */
  groundBandM: 0.06,
  /** Airborne samples: from this height, above the step, m. */
  airborneFromM: 0.15,
  /** to this one, the fit's own upper bound, m. */
  airborneToM: 2,
  /** A level needs at least this many samples, else it is null. */
  minSamples: 2,
});

const GAS_CONSTANT_DRY_AIR = 287.05, STANDARD_GRAVITY = 9.80665;

export interface DipAircraft {
  /** The owner's stated mass, kg; null when not stated, and then nothing is fitted. */
  readonly massKg: number | null;
  readonly rotorCount: number;
  /** Null when not stated; then, as without a mass, nothing is fitted. */
  readonly rotorRadiusM: number | null;
}
/** The height reference: the first GNSS receiver's altitude, or the first rangefinder's distance where its status is good (4). */
export type DipHeightSource = "gnss" | "rangefinder";
export interface DipSample { readonly timeS: number; readonly heightM: number; readonly deltaPa: number }
export interface DipProfileBin { readonly fromM: number; readonly toM: number | null; readonly meanPa: number | null; readonly samples: number }
export interface DipEvent {
  readonly kind: "takeoff" | "landing";
  /** The motor start or stop, s on the log's clock. */
  readonly motorTimeS: number;
  readonly referencePa: number;
  readonly referenceHeightM: number;
  /** The barometer's standard deviation over the motors-off window, Pa. */
  readonly noisePa: number;
  readonly referenceSamples: number;
  readonly samples: readonly DipSample[];
  /** Mean excess within `nearGroundM` of the reference height, Pa; null without such samples. */
  readonly nearGroundPa: number | null;
  readonly nearGroundSamples: number;
  readonly profile: readonly DipProfileBin[];
}
export interface SkippedDipEvent { readonly kind: "takeoff" | "landing"; readonly motorTimeS: number; readonly reason: string }
export interface DipMeasurement {
  /** q_i = m·g/(4A), Pa; null without a stated mass. */
  readonly inducedPressurePa: number | null;
  readonly events: readonly DipEvent[];
  readonly skipped: readonly SkippedDipEvent[];
}
export interface CushionFit {
  /** k_e of Δp = q_i·(k_e·exp(−h/(λR)) + c). */
  readonly gain: number;
  readonly decayRadii: number;
  readonly washCoefficient: number;
  readonly rmsPa: number;
  readonly samples: number;
}

interface Series { readonly timeS: Float64Array; readonly values: Float64Array }
const groupOf = (log: DataFlashLog, name: string): DataFlashGroup | null => log.groups.find(item => item.name === name && item.count > 0) ?? null;
const columnOf = (group: DataFlashGroup, name: string): DataFlashColumn | null => group.columns.find(item => item.name === name) ?? null;
const valueAt = (column: DataFlashColumn, row: number): number => Number(column.values[row]) * column.valueScale;

/** One column of a message, rows of the first instance where the message has one, in time order. */
function series(log: DataFlashLog, groupName: string, columnName: string): Series {
  const group = groupOf(log, groupName);
  if (!group) throw new Error(`The log has no ${groupName} messages`);
  const time = columnOf(group, "TimeUS"), value = columnOf(group, columnName), instance = columnOf(group, "I");
  if (!time || !value) throw new Error(`The log has no ${groupName}.${columnName}`);
  const times: number[] = [], values: number[] = [];
  for (let row = 0; row < group.count; row++) {
    if (instance && valueAt(instance, row) !== 0) continue;
    const t = Number(time.values[row]) * 1e-6, v = valueAt(value, row);
    if (Number.isFinite(t) && Number.isFinite(v)) { times.push(t); values.push(v); }
  }
  if (times.length < 2) throw new Error(`The log has fewer than two ${groupName}.${columnName} rows`);
  return { timeS: Float64Array.from(times), values: Float64Array.from(values) };
}
/** The first rangefinder's good readings (RFND.Stat 4), m. */
function rangefinderSeries(log: DataFlashLog): Series {
  const group = groupOf(log, "RFND");
  if (!group) throw new Error("The log has no RFND messages");
  const time = columnOf(group, "TimeUS"), distance = columnOf(group, "Dist"), status = columnOf(group, "Stat"), instance = columnOf(group, "Instance") ?? columnOf(group, "I");
  if (!time || !distance || !status) throw new Error("The log has no RFND.Dist and RFND.Stat");
  const times: number[] = [], values: number[] = [];
  for (let row = 0; row < group.count; row++) {
    if ((instance && valueAt(instance, row) !== 0) || valueAt(status, row) !== 4) continue;
    const t = Number(time.values[row]) * 1e-6, v = valueAt(distance, row);
    if (Number.isFinite(t) && Number.isFinite(v)) { times.push(t); values.push(v); }
  }
  if (times.length < 2) throw new Error("The log has fewer than two good RFND readings");
  return { timeS: Float64Array.from(times), values: Float64Array.from(values) };
}
/** Time from t to the nearest row of a series, s. */
function nearestGapS(s: Series, t: number): number {
  const i = upperIndex(s, t), a = Math.abs(t - s.timeS[i]!), next = s.timeS[i + 1];
  return next === undefined ? a : Math.min(a, Math.abs(next - t));
}
/** The series at time t, straight between its neighbours and held beyond its ends. */
function interpolate(s: Series, t: number): number {
  const times = s.timeS, last = times.length - 1;
  if (t <= times[0]!) return s.values[0]!;
  if (t >= times[last]!) return s.values[last]!;
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid]! <= t) lo = mid; else hi = mid; }
  const f = (t - times[lo]!) / (times[hi]! - times[lo]!);
  return s.values[lo]! + f * (s.values[hi]! - s.values[lo]!);
}
/**
 * The aircraft for a fit in pressure units (declared 2026-11-07): q_i 1 Pa and R 0.1 m, which only set the units of k_e (Pa) and
 * λ (0.1 m). For one aircraft and battery only, whose true q_i and R do not change between its flights.
 */
export function pressureUnitAircraft(rotorCount: number): DipAircraft {
  const rotorRadiusM = 0.1;
  return { massKg: 4 * rotorCount * Math.PI * rotorRadiusM ** 2 / STANDARD_GRAVITY, rotorCount, rotorRadiusM };
}
/** The stated geometry and mass a fit needs, or null. */
function fitted(aircraft: DipAircraft): { massKg: number; rotorRadiusM: number } | null {
  return aircraft.massKg === null || aircraft.rotorRadiusM === null ? null : { massKg: aircraft.massKg, rotorRadiusM: aircraft.rotorRadiusM };
}
const discAreaM2 = (aircraft: DipAircraft, radiusM: number) => aircraft.rotorCount * Math.PI * radiusM ** 2;
/** q_i = T/(4A) with T the weight. */
export function inducedPressurePa(aircraft: DipAircraft): number | null {
  const stated = fitted(aircraft);
  return stated ? stated.massKg * STANDARD_GRAVITY / (4 * discAreaM2(aircraft, stated.rotorRadiusM)) : null;
}

/** Every motor start and stop of a log with its measured excess pressure, or the reason it was skipped. */
export function measureBarometerDips(log: DataFlashLog, aircraft: DipAircraft, heightSource: DipHeightSource = "gnss"): DipMeasurement {
  if (!(aircraft.rotorCount >= 1) || (aircraft.rotorRadiusM !== null && !(aircraft.rotorRadiusM > 0)) || (aircraft.massKg !== null && !(aircraft.massKg > 0))) {
    throw new Error("The aircraft needs a positive rotor count, rotor radius and, when stated, mass");
  }
  const throttle = series(log, "CTUN", "ThO"), pressure = series(log, "BARO", "Press");
  const altitude = heightSource === "gnss" ? series(log, "GPS", "Alt") : rangefinderSeries(log);
  const label = heightSource === "gnss" ? "GNSS" : "rangefinder";
  // The height at t, or null for a rangefinder without a good reading within rangefinderGapS.
  const heightAt = (t: number): number | null =>
    heightSource === "rangefinder" && nearestGapS(altitude, t) > DIP_METHOD.rangefinderGapS ? null : interpolate(altitude, t);
  const on = DIP_METHOD.throttleOn, events: DipEvent[] = [], skipped: SkippedDipEvent[] = [];
  const isOn = (t: number) => throttle.values[upperIndex(throttle, t)]! > on;
  for (let i = 1; i < throttle.timeS.length; i++) {
    const before = throttle.values[i - 1]!, after = throttle.values[i]!;
    const kind = before <= on && after > on ? "takeoff" : before > on && after <= on ? "landing" : null;
    if (!kind) continue;
    const motorTimeS = kind === "takeoff" ? throttle.timeS[i]! : throttle.timeS[i - 1]!;
    const [r0, r1] = kind === "takeoff" ? DIP_METHOD.referenceBeforeS : DIP_METHOD.referenceAfterS;
    const from = motorTimeS + r0, to = motorTimeS + r1;
    let motorsOn = false;
    for (let k = 0; k < throttle.timeS.length; k++) {
      const t = throttle.timeS[k]!;
      if (t >= from && t <= to && throttle.values[k]! > on) { motorsOn = true; break; }
    }
    if (motorsOn) { skipped.push({ kind, motorTimeS, reason: "the motors run in the motors-off window" }); continue; }
    let sum = 0, sumSquares = 0, heightSum = 0, n = 0;
    for (let k = 0; k < pressure.timeS.length; k++) {
      const t = pressure.timeS[k]!;
      if (t < from || t > to) continue;
      const p = pressure.values[k]!, h = heightAt(t);
      if (h === null) continue;
      sum += p; sumSquares += p * p; heightSum += h; n++;
    }
    if (n < DIP_METHOD.minReferenceSamples) {
      skipped.push({ kind, motorTimeS, reason: `${n} barometer samples with a ${label} height in the motors-off window, fewer than ${DIP_METHOD.minReferenceSamples}` });
      continue;
    }
    const referencePa = sum / n, referenceHeightM = heightSum / n;
    const noisePa = Math.sqrt(Math.max(0, (sumSquares - n * referencePa * referencePa) / (n - 1)));
    const motorHeight = heightAt(motorTimeS), moment = kind === "takeoff" ? "start" : "stop";
    if (motorHeight === null) { skipped.push({ kind, motorTimeS, reason: `no good ${label} reading at the motor ${moment}` }); continue; }
    const atMotor = motorHeight - referenceHeightM;
    if (Math.abs(atMotor) > DIP_METHOD.groundToleranceM) {
      skipped.push({ kind, motorTimeS, reason: `the ${label} height at the motor ${moment} is ${atMotor.toFixed(2)} m from the motors-off reference, not on the ground` });
      continue;
    }
    const rhoG = referencePa / (GAS_CONSTANT_DRY_AIR * DIP_METHOD.airTemperatureK) * STANDARD_GRAVITY;
    const w0 = kind === "takeoff" ? motorTimeS : motorTimeS - DIP_METHOD.windowS;
    const w1 = kind === "takeoff" ? motorTimeS + DIP_METHOD.windowS : motorTimeS;
    const samples: DipSample[] = [];
    for (let k = 0; k < pressure.timeS.length; k++) {
      const t = pressure.timeS[k]!;
      if (t < w0 || t > w1 || !isOn(t)) continue;
      const h = heightAt(t);
      if (h === null) continue;
      const heightM = h - referenceHeightM;
      samples.push({ timeS: t, heightM, deltaPa: pressure.values[k]! - (referencePa - rhoG * heightM) });
    }
    const aloft = samples.filter(sample => sample.heightM >= DIP_METHOD.nearGroundM);
    const lowHover = aloft.length > 1 && aloft[aloft.length - 1]!.timeS - aloft[0]!.timeS >= DIP_METHOD.lowHoverS;
    if (!lowHover && !samples.some(sample => sample.heightM >= DIP_METHOD.minFlightHeightM)) {
      skipped.push({ kind, motorTimeS, reason: `the vehicle stayed below ${DIP_METHOD.minFlightHeightM} m within ${DIP_METHOD.windowS} s of the motor ${kind === "takeoff" ? "start" : "stop"}, nor ${DIP_METHOD.lowHoverS} s at ${DIP_METHOD.nearGroundM} m or more: a spin-up on the ground, not a flight` });
      continue;
    }
    const near = samples.filter(sample => sample.heightM < DIP_METHOD.nearGroundM);
    events.push({
      kind, motorTimeS, referencePa, referenceHeightM, noisePa, referenceSamples: n, samples,
      nearGroundPa: near.length ? near.reduce((s, x) => s + x.deltaPa, 0) / near.length : null, nearGroundSamples: near.length,
      profile: profileOf(samples),
    });
  }
  return { inducedPressurePa: inducedPressurePa(aircraft), events, skipped };
}
/** Index of the last row at or before t (0 before the first). */
function upperIndex(s: Series, t: number): number {
  let lo = 0, hi = s.timeS.length - 1;
  if (t < s.timeS[0]!) return 0;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s.timeS[mid]! <= t) lo = mid; else hi = mid - 1; }
  return lo;
}
function profileOf(samples: readonly DipSample[]): DipProfileBin[] {
  const bins = DIP_METHOD.profileBinsM;
  return bins.map((fromM, b) => {
    const toM = bins[b + 1] ?? null;
    const inside = samples.filter(s => (b === 0 || s.heightM >= fromM) && (toM === null || s.heightM < toM));
    return { fromM, toM, meanPa: inside.length ? inside.reduce((sum, s) => sum + s.deltaPa, 0) / inside.length : null, samples: inside.length };
  });
}

/** The ground cushion and prop wash fitted to landing samples within `fitMaxHeightM` of the landed position. */
export function fitGroundCushion(events: readonly DipEvent[], aircraft: DipAircraft): CushionFit {
  const q = inducedPressurePa(aircraft), stated = fitted(aircraft);
  if (q === null || stated === null) throw new Error("A fit needs the aircraft's stated mass and rotor radius");
  const points: { h: number; y: number }[] = [];
  for (const event of events) {
    if (event.kind !== "landing") continue;
    for (const s of event.samples) if (s.heightM <= DIP_METHOD.fitMaxHeightM) points.push({ h: Math.max(0, s.heightM), y: s.deltaPa / q });
  }
  if (points.length < 3) throw new Error(`A fit needs at least 3 landing samples within ${DIP_METHOD.fitMaxHeightM} m; there are ${points.length}`);
  const { min, max, count } = DIP_METHOD.decayGrid;
  let best: CushionFit | null = null;
  for (let g = 0; g < count; g++) {
    const decayRadii = min * (max / min) ** (g / (count - 1)), scale = decayRadii * stated.rotorRadiusM;
    // Least squares of y = k·e + c with e = exp(−h/scale): the 2×2 normal equations.
    let see = 0, se = 0, sy = 0, sey = 0;
    for (const p of points) { const e = Math.exp(-p.h / scale); see += e * e; se += e; sy += p.y; sey += e * p.y; }
    const n = points.length, det = see * n - se * se;
    if (!(Math.abs(det) > 1e-12 * see * n)) continue;
    const gain = (sey * n - se * sy) / det, washCoefficient = (see * sy - se * sey) / det;
    let squares = 0;
    for (const p of points) { const r = (gain * Math.exp(-p.h / scale) + washCoefficient - p.y) * q; squares += r * r; }
    const rmsPa = Math.sqrt(squares / n);
    if (!best || rmsPa < best.rmsPa) best = { gain, decayRadii, washCoefficient, rmsPa, samples: n };
  }
  if (!best) throw new Error("The landing samples do not determine a fit");
  return best;
}

/** The model's own near-ground excess for an event's measured heights: `BarometerErrors` with the fitted cushion and wash. */
export function predictNearGroundPa(event: DipEvent, fit: CushionFit, aircraft: DipAircraft): number | null {
  const stated = fitted(aircraft);
  if (stated === null) throw new Error("A prediction needs the aircraft's stated mass and rotor radius");
  const model = new BarometerErrors();
  model.set(BarometerEffect.GroundCushion, true, [fit.gain, fit.decayRadii]);
  model.set(BarometerEffect.PropWash, true, [fit.washCoefficient]);
  const x = model.input;
  x[BarometerInput.DensityKgM3] = 1.225;
  x[BarometerInput.ThrustN] = stated.massKg * STANDARD_GRAVITY;
  x[BarometerInput.DiscAreaM2] = discAreaM2(aircraft, stated.rotorRadiusM);
  x[BarometerInput.MeanRadiusM] = stated.rotorRadiusM;
  let sum = 0, n = 0;
  for (const s of event.samples) {
    if (s.heightM >= DIP_METHOD.nearGroundM) continue;
    x[BarometerInput.HeightM] = Math.max(0, s.heightM);
    x[BarometerInput.TimeS] = s.timeS;
    model.step();
    sum += model.errorPa; n++;
  }
  return n ? sum / n : null;
}

/** One event's two levels, Pa, null where a level has fewer than `minSamples` samples. */
export interface TwoLevels {
  readonly groundPa: number | null;
  readonly groundSamples: number;
  readonly airbornePa: number | null;
  readonly airborneSamples: number;
}
const inBand = (heightM: number, band: "ground" | "airborne") => band === "ground"
  ? heightM < DIP_TWO_LEVEL.groundBandM
  : heightM >= DIP_TWO_LEVEL.airborneFromM && heightM <= DIP_TWO_LEVEL.airborneToM;
function levels(event: DipEvent, value: (sample: DipSample) => number): TwoLevels {
  let g = 0, gn = 0, a = 0, an = 0;
  for (const s of event.samples) {
    if (inBand(s.heightM, "ground")) { g += value(s); gn++; } else if (inBand(s.heightM, "airborne")) { a += value(s); an++; }
  }
  const min = DIP_TWO_LEVEL.minSamples;
  return { groundPa: gn >= min ? g / gn : null, groundSamples: gn, airbornePa: an >= min ? a / an : null, airborneSamples: an };
}
/** The measured two levels of an event (rangefinder heights only; the caller knows its height source). */
export function measureTwoLevels(event: DipEvent): TwoLevels {
  return levels(event, s => s.deltaPa);
}
/** The model's two levels over the same samples, as `predictNearGroundPa` computes its excess. */
export function predictTwoLevels(event: DipEvent, fit: CushionFit, aircraft: DipAircraft): TwoLevels {
  const stated = fitted(aircraft);
  if (stated === null) throw new Error("A prediction needs the aircraft's stated mass and rotor radius");
  const model = new BarometerErrors();
  model.set(BarometerEffect.GroundCushion, true, [fit.gain, fit.decayRadii]);
  model.set(BarometerEffect.PropWash, true, [fit.washCoefficient]);
  const x = model.input;
  x[BarometerInput.DensityKgM3] = 1.225;
  x[BarometerInput.ThrustN] = stated.massKg * STANDARD_GRAVITY;
  x[BarometerInput.DiscAreaM2] = discAreaM2(aircraft, stated.rotorRadiusM);
  x[BarometerInput.MeanRadiusM] = stated.rotorRadiusM;
  return levels(event, s => {
    x[BarometerInput.HeightM] = Math.max(0, s.heightM);
    x[BarometerInput.TimeS] = s.timeS;
    model.step();
    return model.errorPa;
  });
}
/** Both levels measured and predicted, and each within `DIP_TOLERANCE`; false when a level is missing on either side. */
export function twoLevelsWithin(measured: TwoLevels, predicted: TwoLevels): boolean {
  const pair = (m: number | null, p: number | null) => m !== null && p !== null && withinDipTolerance(m, p);
  return pair(measured.groundPa, predicted.groundPa) && pair(measured.airbornePa, predicted.airbornePa);
}

/** Whether a predicted near-ground excess reproduces the measured one under the declared tolerance. */
export function withinDipTolerance(measuredPa: number, predictedPa: number): boolean {
  return Math.abs(predictedPa - measuredPa) <= Math.max(DIP_TOLERANCE.absolutePa, DIP_TOLERANCE.relative * Math.abs(measuredPa));
}
