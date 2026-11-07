import { columnText, type DataFlashColumn, type DataFlashGroup, type DataFlashLog } from "@mirage/dataflash/reader";
import { fftInPlace, timeDomainMetrics } from "@mirage/physics/fidelity-metrics";
import { MIRAGE_MESSAGES } from "@mirage/dataflash/writer";
import { flightTrack, pathDifference, type PathDifference } from "./resimulate.ts";

// Fidelity assessment (TASK-184, S15; SPECS_SIMULATION_ENGINES "Fidelity assessment: TASK-184"): a real flight log beside the log of a
// simulated run of one aircraft profile version, quantity by quantity and regime by regime, with the TASK-090 time-domain metrics.
// MirageSITL sets no fidelity limit and gives no verdict (SA-01, F-05): every number is shown and the user judges. What a log lacks is
// shown as missing, never filled in. Both logs are ArduPilot DataFlash logs, read the same way. Cold path.

export const FIDELITY_REGIMES = ["ground", "hover", "climb", "descent", "forward"] as const;
export type FidelityRegime = typeof FIDELITY_REGIMES[number];
/** Regime bounds, from the real log's EKF velocity and height: an engineering default that only sorts samples. */
export const REGIME_BOUNDS = Object.freeze({ groundHeightM: 0.5, verticalSpeedMps: 0.5, horizontalSpeedMps: 1 });
/** A step of the desired attitude at least this large has its overshoot measured, deg. */
export const OVERSHOOT_STEP_DEG = 5;

const TIME_SCALE = 1e-6;
const groupOf = (log: DataFlashLog, name: string): DataFlashGroup | null => log.groups.find(item => item.name === name && item.count > 0) ?? null;
const columnOf = (group: DataFlashGroup, name: string): DataFlashColumn | null => group.columns.find(item => item.name === name) ?? null;
const valueAt = (column: DataFlashColumn, row: number): number => Number(column.values[row]) * column.valueScale;

const MIRAGE_MESSAGE_NAMES: ReadonlySet<string> = new Set(MIRAGE_MESSAGES.map(message => message.name));
/** Where a log comes from: a real aircraft, or a simulation (SITL settings or MirageSITL's own messages in it). */
export function logOrigin(log: DataFlashLog): { readonly kind: "real" | "simulated"; readonly reason: string } {
  const parameters = groupOf(log, "PARM"), names = parameters ? columnOf(parameters, "Name") : null;
  if (names && parameters) {
    for (let row = 0; row < parameters.count; row++) {
      const name = columnText(names, row);
      if (name.startsWith("SIM_")) return { kind: "simulated", reason: `It sets the SITL parameter ${name}` };
    }
  }
  // MirageSITL's own messages by name: ArduPilot's MSG, which every real log holds, also begins with "MS".
  const own = log.groups.find(group => group.count > 0 && MIRAGE_MESSAGE_NAMES.has(group.name));
  if (own) return { kind: "simulated", reason: `It holds MirageSITL's ${own.name} messages` };
  return { kind: "real", reason: "It holds no SITL parameter and no MirageSITL message" };
}
/** One series of a log: its times, s, and values, in rows of an instance filter. */
interface Series { readonly timeS: number[]; readonly values: number[] }
interface SeriesSource {
  readonly id: string; readonly label: string; readonly unit: string; readonly group: string; readonly column: string;
  readonly scale?: number; readonly angle?: boolean;
  /** Instance column and value of the rows read: the EKF's first core, the first battery. */
  readonly instance?: { readonly column: string; readonly value: number };
}
export const FIDELITY_SERIES: readonly SeriesSource[] = Object.freeze([
  { id: "roll", label: "Roll", unit: "deg", group: "ATT", column: "Roll" },
  { id: "pitch", label: "Pitch", unit: "deg", group: "ATT", column: "Pitch" },
  { id: "yaw", label: "Heading", unit: "deg", group: "ATT", column: "Yaw", angle: true },
  { id: "rollRate", label: "Roll rate", unit: "deg/s", group: "RATE", column: "R" },
  { id: "pitchRate", label: "Pitch rate", unit: "deg/s", group: "RATE", column: "P" },
  { id: "yawRate", label: "Yaw rate", unit: "deg/s", group: "RATE", column: "Y" },
  { id: "altitude", label: "Height above the origin", unit: "m", group: "XKF1", column: "PD", scale: -1, instance: { column: "C", value: 0 } },
  { id: "verticalSpeed", label: "Climb rate", unit: "m/s", group: "XKF1", column: "VD", scale: -1, instance: { column: "C", value: 0 } },
  { id: "batteryVoltage", label: "Battery voltage", unit: "V", group: "BAT", column: "Volt", instance: { column: "Inst", value: 0 } },
  { id: "batteryCurrent", label: "Battery current", unit: "A", group: "BAT", column: "Curr", instance: { column: "Inst", value: 0 } },
  { id: "motorOutput", label: "Motor output 1", unit: "us", group: "RCOU", column: "C1" },
]);

function readSeries(log: DataFlashLog, source: Pick<SeriesSource, "group" | "column" | "scale" | "angle" | "instance">): Series | string {
  const group = groupOf(log, source.group);
  if (!group) return `no ${source.group} messages`;
  const time = columnOf(group, "TimeUS"), value = columnOf(group, source.column), instance = source.instance ? columnOf(group, source.instance.column) : null;
  if (!time || !value) return `no ${source.group}.${source.column}`;
  const series: Series = { timeS: [], values: [] };
  let previous = Number.NaN, turns = 0;
  for (let row = 0; row < group.count; row++) {
    if (instance && source.instance && valueAt(instance, row) !== source.instance.value) continue;
    const t = Number(time.values[row]) * TIME_SCALE;
    let v = valueAt(value, row) * (source.scale ?? 1);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    // A heading is unwrapped, so a turn through north is not a 360° error.
    if (source.angle) {
      if (Number.isFinite(previous)) { const jump = v + 360 * turns - previous; if (jump > 180) turns--; else if (jump < -180) turns++; }
      v += 360 * turns; previous = v;
    }
    series.timeS.push(t); series.values.push(v);
  }
  return series.timeS.length >= 2 ? series : `fewer than two ${source.group}.${source.column} rows`;
}
/** The value of a series at a time, straight between its neighbours; NaN outside it. */
function valueAtTime(series: Series, timeS: number, cursor: { at: number }): number {
  const times = series.timeS;
  if (timeS < (times[0] ?? Infinity) || timeS > (times[times.length - 1] ?? -Infinity)) return Number.NaN;
  while (cursor.at + 1 < times.length && (times[cursor.at + 1] ?? Infinity) <= timeS) cursor.at++;
  const a = times[cursor.at] ?? NaN, b = times[cursor.at + 1];
  if (b === undefined || b === a) return series.values[cursor.at] ?? NaN;
  return (series.values[cursor.at] ?? NaN) + ((series.values[cursor.at + 1] ?? NaN) - (series.values[cursor.at] ?? NaN)) * (timeS - a) / (b - a);
}

/** The real log's interval, and the offset of the simulated log: simulated time = real time + offset. */
export interface FidelityInterval { readonly fromS: number; readonly toS: number; readonly simulatedOffsetS: number }
export interface SeriesSummary { readonly mean: number; readonly min: number; readonly max: number }
export interface FidelityRow {
  readonly quantity: string; readonly label: string; readonly unit: string;
  readonly regime: FidelityRegime | "all";
  readonly status: "compared" | "missing";
  /** Why a row is missing. */
  readonly reason: string | null;
  readonly samples: number;
  /** TASK-090: RMS and bias of simulated minus real, the Theil coefficient, and the largest difference. */
  readonly rms: number | null; readonly bias: number | null; readonly theil: number | null; readonly maxAbs: number | null;
  readonly real: SeriesSummary | null; readonly simulated: SeriesSummary | null;
}
/** A quantity of each log as one number, side by side. */
export interface FidelityScalar {
  readonly quantity: string; readonly label: string; readonly unit: string;
  readonly real: number | null; readonly simulated: number | null; readonly reason: string | null;
}
export interface FidelityAssessment {
  readonly interval: FidelityInterval;
  /** Seconds of the real interval in each regime. */
  readonly regimes: readonly { readonly regime: FidelityRegime; readonly seconds: number }[];
  readonly rows: readonly FidelityRow[];
  readonly scalars: readonly FidelityScalar[];
  /** The two paths, the EKF's north, east and height each from its own origin, compared at the real instants; null with the reason. */
  readonly path: PathDifference | null;
  readonly pathReason: string | null;
}

/** The regime of each real-log instant, from its EKF height and velocity at the latest XKF1 row at or before it. */
function regimeReader(real: DataFlashLog): ((timeS: number) => FidelityRegime | null) | string {
  const core = { column: "C", value: 0 };
  const height = readSeries(real, { group: "XKF1", column: "PD", scale: -1, instance: core }), vn = readSeries(real, { group: "XKF1", column: "VN", instance: core });
  const ve = readSeries(real, { group: "XKF1", column: "VE", instance: core }), vd = readSeries(real, { group: "XKF1", column: "VD", instance: core });
  if (typeof height === "string" || typeof vn === "string" || typeof ve === "string" || typeof vd === "string") return "The real log has no EKF height and velocity (XKF1), so no regime can be told";
  const start = height.values[0] ?? 0, times = height.timeS;
  const regimes = times.map((_, i): FidelityRegime => {
    const h = (height.values[i] ?? 0) - start, n = vn.values[i] ?? 0, e = ve.values[i] ?? 0, d = vd.values[i] ?? 0;
    if (h < REGIME_BOUNDS.groundHeightM) return "ground";
    if (Math.hypot(n, e) >= REGIME_BOUNDS.horizontalSpeedMps) return "forward";
    if (-d >= REGIME_BOUNDS.verticalSpeedMps) return "climb";
    if (d >= REGIME_BOUNDS.verticalSpeedMps) return "descent";
    return "hover";
  });
  return timeS => {
    if (!(timeS >= (times[0] ?? Infinity))) return null;
    let lo = 0, hi = times.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((times[mid] ?? Infinity) <= timeS) lo = mid; else hi = mid - 1; }
    return regimes[lo] ?? null;
  };
}
const summary = (values: readonly number[]): SeriesSummary => ({ mean: values.reduce((s, v) => s + v, 0) / values.length, min: Math.min(...values), max: Math.max(...values) });
function missingRow(source: Pick<SeriesSource, "id" | "label" | "unit">, regime: FidelityRow["regime"], reason: string): FidelityRow {
  return { quantity: source.id, label: source.label, unit: source.unit, regime, status: "missing", reason, samples: 0, rms: null, bias: null, theil: null, maxAbs: null, real: null, simulated: null };
}
function comparedRow(source: Pick<SeriesSource, "id" | "label" | "unit">, regime: FidelityRow["regime"], real: number[], simulated: number[]): FidelityRow {
  if (real.length < 2) return missingRow(source, regime, regime === "all" ? "fewer than two samples overlap in time" : `fewer than two samples in ${regime}`);
  let metrics: { rms: number; bias: number; theil: number | null };
  try { const m = timeDomainMetrics(real, simulated); metrics = { rms: m.rms, bias: m.bias, theil: m.theil }; }
  catch { metrics = { rms: 0, bias: 0, theil: null }; }
  const maxAbs = real.reduce((max, value, i) => Math.max(max, Math.abs((simulated[i] ?? NaN) - value)), 0);
  return { quantity: source.id, label: source.label, unit: source.unit, regime, status: "compared", reason: null, samples: real.length, ...metrics, maxAbs,
    real: summary(real), simulated: summary(simulated) };
}

/** The real series of a quantity over the interval beside the simulated one at the same instants, for charts and the metrics. */
export function pairedSeries(real: DataFlashLog, simulated: DataFlashLog, interval: FidelityInterval, quantity: string):
  { readonly timeS: number[]; readonly real: number[]; readonly simulated: number[] } | string {
  const source = FIDELITY_SERIES.find(item => item.id === quantity);
  if (!source) return `unknown quantity ${quantity}`;
  const a = readSeries(real, source), b = readSeries(simulated, source);
  if (typeof a === "string") return `The real log has ${a}`;
  if (typeof b === "string") return `The simulated log has ${b}`;
  const out = { timeS: [] as number[], real: [] as number[], simulated: [] as number[] }, cursor = { at: 0 };
  // A heading is compared modulo whole turns: the simulated one is moved by the turns that bring its start nearest the real start.
  let shift = 0;
  a.timeS.forEach((timeS, i) => {
    if (timeS < interval.fromS || timeS > interval.toS) return;
    const s = valueAtTime(b, timeS + interval.simulatedOffsetS, cursor);
    if (!Number.isFinite(s)) return;
    if (source.angle && out.timeS.length === 0) shift = 360 * Math.round(((a.values[i] ?? 0) - s) / 360);
    out.timeS.push(timeS); out.real.push(a.values[i] ?? NaN); out.simulated.push(s + shift);
  });
  return out;
}

/** Overshoot of the largest step of a desired attitude, %, or why there is none. */
function overshootOf(log: DataFlashLog, axis: "Roll" | "Pitch", fromS: number, toS: number): number | string {
  const desired = readSeries(log, { group: "ATT", column: `Des${axis}` }), actual = readSeries(log, { group: "ATT", column: axis });
  if (typeof desired === "string") return desired;
  if (typeof actual === "string") return actual;
  let best = -1, size = 0;
  for (let i = 1; i < desired.timeS.length; i++) {
    const t = desired.timeS[i] ?? NaN;
    if (t < fromS || t > toS) continue;
    const step = (desired.values[i] ?? 0) - (desired.values[i - 1] ?? 0);
    if (Math.abs(step) > Math.abs(size)) { size = step; best = i; }
  }
  if (best < 0 || Math.abs(size) < OVERSHOOT_STEP_DEG) return `no step of the desired ${axis.toLowerCase()} of ${OVERSHOOT_STEP_DEG}° or more`;
  const t0 = desired.timeS[best] ?? NaN, target = desired.values[best] ?? NaN, before = desired.values[best - 1] ?? NaN;
  // The response until the desired value moves again, or the interval ends.
  let end = toS;
  for (let i = best + 1; i < desired.timeS.length; i++) if (Math.abs((desired.values[i] ?? 0) - target) > 0.5) { end = desired.timeS[i] ?? end; break; }
  let peak = 0;
  for (let i = 0; i < actual.timeS.length; i++) {
    const t = actual.timeS[i] ?? NaN;
    if (t < t0 || t > end) continue;
    peak = Math.max(peak, ((actual.values[i] ?? 0) - before) / (target - before));
  }
  return Math.max(0, (peak - 1) * 100);
}
/** Spread and dominant frequency of a body rate about its mean over the interval: the oscillation the log holds. */
function oscillationOf(log: DataFlashLog, column: "R" | "P" | "Y", fromS: number, toS: number): { readonly std: number; readonly frequencyHz: number } | string {
  const series = readSeries(log, { group: "RATE", column });
  if (typeof series === "string") return series;
  const values: number[] = [], times: number[] = [];
  series.timeS.forEach((t, i) => { if (t >= fromS && t <= toS) { times.push(t); values.push(series.values[i] ?? 0); } });
  if (values.length < 16) return "fewer than 16 RATE rows in the interval";
  const mean = values.reduce((s, v) => s + v, 0) / values.length, std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  const n = 2 ** Math.floor(Math.log2(values.length)), rate = (n - 1) / ((times[n - 1] ?? 0) - (times[0] ?? 0));
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = ((values[i] ?? 0) - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
  fftInPlace(re, im);
  let peak = 1, power = 0;
  for (let k = 1; k < n / 2; k++) { const p = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2; if (p > power) { power = p; peak = k; } }
  return { std, frequencyHz: peak * rate / n };
}

/**
 * Compares a real flight log with the log of a simulated run over the real log's interval, the simulated log shifted by the offset.
 * Every quantity is compared over the whole interval and in each regime the real log holds; nothing is judged.
 */
export function assessFidelity(real: DataFlashLog, simulated: DataFlashLog, interval: FidelityInterval): FidelityAssessment {
  if (![interval.fromS, interval.toS, interval.simulatedOffsetS].every(Number.isFinite) || !(interval.toS > interval.fromS)) throw new Error("The interval must be finite, with its end after its start");
  const regimeAt = regimeReader(real);
  const regimeSeconds = new Map<FidelityRegime, number>(FIDELITY_REGIMES.map(regime => [regime, 0]));
  const rows: FidelityRow[] = [];
  for (const source of FIDELITY_SERIES) {
    const paired = pairedSeries(real, simulated, interval, source.id);
    if (typeof paired === "string") { rows.push(missingRow(source, "all", paired)); continue; }
    rows.push(comparedRow(source, "all", paired.real, paired.simulated));
    if (typeof regimeAt === "string") { rows.push(missingRow(source, "hover", regimeAt)); continue; }
    const byRegime = new Map<FidelityRegime, { real: number[]; simulated: number[] }>();
    paired.timeS.forEach((timeS, i) => {
      const regime = regimeAt(timeS);
      if (!regime) return;
      const bucket = byRegime.get(regime) ?? { real: [], simulated: [] };
      bucket.real.push(paired.real[i] ?? NaN); bucket.simulated.push(paired.simulated[i] ?? NaN); byRegime.set(regime, bucket);
    });
    for (const regime of FIDELITY_REGIMES) {
      const bucket = byRegime.get(regime);
      rows.push(bucket ? comparedRow(source, regime, bucket.real, bucket.simulated) : missingRow(source, regime, `the real log holds no ${regime} in the interval`));
    }
  }
  if (typeof regimeAt !== "string") {
    const height = readSeries(real, { group: "XKF1", column: "PD", scale: -1, instance: { column: "C", value: 0 } });
    if (typeof height !== "string") {
      for (let i = 1; i < height.timeS.length; i++) {
        const t = height.timeS[i] ?? NaN, dt = t - (height.timeS[i - 1] ?? NaN);
        if (t < interval.fromS || t > interval.toS || !(dt > 0)) continue;
        const regime = regimeAt(t);
        if (regime) regimeSeconds.set(regime, (regimeSeconds.get(regime) ?? 0) + dt);
      }
    }
  }
  const a = flightTrack(real, { fromS: interval.fromS, toS: interval.toS }), b = flightTrack(simulated);
  const path = a && b ? pathDifference(a, b, -interval.simulatedOffsetS) : null;
  const pathReason = path ? null : !a ? "The real log holds no position over the interval" : !b ? "The simulated log holds no position" : "The two paths do not overlap in time";
  return { interval, regimes: FIDELITY_REGIMES.map(regime => ({ regime, seconds: regimeSeconds.get(regime) ?? 0 })), rows, scalars: scalarsOf(real, simulated, interval), path, pathReason };
}

function scalarsOf(real: DataFlashLog, simulated: DataFlashLog, interval: FidelityInterval): FidelityScalar[] {
  const scalars: FidelityScalar[] = [];
  const both = (quantity: string, label: string, unit: string, read: (log: DataFlashLog, fromS: number, toS: number) => number | string) => {
    const a = read(real, interval.fromS, interval.toS), b = read(simulated, interval.fromS + interval.simulatedOffsetS, interval.toS + interval.simulatedOffsetS);
    scalars.push({ quantity, label, unit, real: typeof a === "number" ? a : null, simulated: typeof b === "number" ? b : null,
      reason: typeof a === "string" ? `The real log has ${a}` : typeof b === "string" ? `The simulated log has ${b}` : null });
  };
  const energy = (log: DataFlashLog, fromS: number, toS: number): number | string => {
    const series = readSeries(log, { group: "BAT", column: "EnrgTot", instance: { column: "Inst", value: 0 } });
    if (typeof series === "string") return series;
    const c = { at: 0 }, a = valueAtTime(series, fromS, c), b = valueAtTime(series, toS, c);
    return Number.isFinite(a) && Number.isFinite(b) ? b - a : "no BAT.EnrgTot across the whole interval";
  };
  both("energyUsed", "Energy used", "Wh", energy);
  for (const axis of ["Roll", "Pitch"] as const) both(`${axis.toLowerCase()}Overshoot`, `${axis} overshoot of the largest desired step`, "%", (log, from, to) => overshootOf(log, axis, from, to));
  for (const [column, name] of [["R", "Roll"], ["P", "Pitch"], ["Y", "Yaw"]] as const) {
    both(`${name.toLowerCase()}RateSpread`, `${name} rate spread about its mean`, "deg/s", (log, from, to) => { const o = oscillationOf(log, column, from, to); return typeof o === "string" ? o : o.std; });
    both(`${name.toLowerCase()}RateFrequency`, `${name} rate dominant frequency`, "Hz", (log, from, to) => { const o = oscillationOf(log, column, from, to); return typeof o === "string" ? o : o.frequencyHz; });
  }
  return scalars;
}
