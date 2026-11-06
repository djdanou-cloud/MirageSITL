import { channel, type RecordedRow, type RecordedRows } from "./response-series.ts";

// The physics truth against ArduPilot's estimate, from a stored recording (TASK-170, S09). The estimate is what the autopilot reports in
// GLOBAL_POSITION_INT, and the truth is read at the simulated time of each report, so both stand on one clock. Errors are estimate minus
// truth. This describes; no limit applies to them and none says what ArduPilot should have done. Cold path, on a closed recording.

/** ArduPilot's own Location arithmetic (LATLON_TO_M), so that the conversion adds no error of its own near home. */
const METRES_PER_DEGREE = 111318.84502145034;
/** Channels of autopilot.globalPosition. */
const LAT = 0, LON = 1, ALT_MSL = 2, V_NORTH = 4, V_EAST = 5, V_DOWN = 6;
export type EstimateAxis = "north" | "east" | "down";
export const ESTIMATE_AXES: readonly EstimateAxis[] = ["north", "east", "down"];
/** One line, ready to chart: `value[i]` at `timeS[i]`. */
export interface AxisSeries { readonly timeS: readonly number[]; readonly truth: readonly number[]; readonly estimate: readonly number[]; readonly error: readonly number[] }
export interface TruthVsEstimate {
  readonly startS: number;
  readonly endS: number;
  readonly position: Readonly<Record<EstimateAxis, AxisSeries>>;
  readonly velocity: Readonly<Record<EstimateAxis, AxisSeries>>;
  /** Autopilot reports per second, over the recording. */
  readonly estimateHz: number | null;
  /** Reports whose simulated time has no truth on both sides, left out. */
  readonly withoutTruth: number;
  /** Reports of all zeros, sent before ArduPilot has a position of its own, left out. */
  readonly beforePosition: number;
}
export type TruthVsEstimateResult = { readonly kind: "series"; readonly series: TruthVsEstimate } | { readonly kind: "missing"; readonly reason: string };

/** The three channels of a truth signal at `timeS`, straight between its neighbours, or null outside them. */
function truthAt(rows: readonly RecordedRow[], timeS: number, from: { index: number }): readonly [number, number, number] | null {
  let index = from.index;
  while (index + 1 < rows.length && (rows[index + 1]?.simTimeS ?? Infinity) <= timeS) index++;
  from.index = index;
  const a = rows[index], b = rows[index + 1];
  if (!a || a.simTimeS > timeS) return null;
  const read = (row: RecordedRow, at: number): number | null => channel(row, at);
  const out: number[] = [];
  for (let at = 0; at < 3; at++) {
    const left = read(a, at);
    if (left === null) return null;
    if (a.simTimeS === timeS) { out.push(left); continue; }
    const right = b ? read(b, at) : null;
    if (!b || right === null) return null;
    out.push(left + (right - left) * (timeS - a.simTimeS) / (b.simTimeS - a.simTimeS));
  }
  return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0];
}
const empty = (): { timeS: number[]; truth: number[]; estimate: number[]; error: number[] } => ({ timeS: [], truth: [], estimate: [], error: [] });

/** `home` is the session's: latitude and longitude in degrees, altitude in metres, as the experiment record holds it. */
export function truthVsEstimate(rows: RecordedRows, home: readonly [number, number, number, number]): TruthVsEstimateResult {
  const reports = rows.get("autopilot.globalPosition") ?? [], position = rows.get("truth.position") ?? [], velocity = rows.get("truth.velocity") ?? [];
  if (reports.length === 0) return { kind: "missing", reason: "The recording holds no estimate from the autopilot: record autopilot telemetry on the Logging tab." };
  if (position.length === 0 || velocity.length === 0) return { kind: "missing", reason: "The recording holds no truth: record the truth signals on the Logging tab." };
  const metresEast = METRES_PER_DEGREE * Math.cos(home[0] * Math.PI / 180);
  const out = { position: { north: empty(), east: empty(), down: empty() }, velocity: { north: empty(), east: empty(), down: empty() } };
  const atPosition = { index: 0 }, atVelocity = { index: 0 };
  let withoutTruth = 0, beforePosition = 0;
  const add = (series: ReturnType<typeof empty>, timeS: number, truth: number, estimate: number) => {
    series.timeS.push(timeS); series.truth.push(truth); series.estimate.push(estimate); series.error.push(estimate - truth);
  };
  for (const report of reports) {
    const lat = channel(report, LAT), lon = channel(report, LON), alt = channel(report, ALT_MSL), vn = channel(report, V_NORTH), ve = channel(report, V_EAST), vd = channel(report, V_DOWN);
    // Until the EKF has a position, ArduPilot sends this message with latitude, longitude and altitude all zero. Read as a place, that is
    // thousands of kilometres from home, and it would swamp every error in the chart.
    if (lat === 0 && lon === 0 && alt === 0) { beforePosition++; continue; }
    const p = truthAt(position, report.simTimeS, atPosition), v = truthAt(velocity, report.simTimeS, atVelocity);
    if (!p || !v) { withoutTruth++; continue; }
    if (lat === null || lon === null || alt === null || vn === null || ve === null || vd === null) continue;
    add(out.position.north, report.simTimeS, p[0], (lat - home[0]) * METRES_PER_DEGREE);
    add(out.position.east, report.simTimeS, p[1], (lon - home[1]) * metresEast);
    add(out.position.down, report.simTimeS, p[2], home[2] - alt);
    add(out.velocity.north, report.simTimeS, v[0], vn);
    add(out.velocity.east, report.simTimeS, v[1], ve);
    add(out.velocity.down, report.simTimeS, v[2], vd);
  }
  const times = out.position.north.timeS, first = times[0], last = times[times.length - 1];
  if (first === undefined || last === undefined) return { kind: "missing", reason: "No report of the estimate falls where the recording holds the truth." };
  return { kind: "series", series: { startS: first, endS: last, position: out.position, velocity: out.velocity, estimateHz: times.length > 1 && last > first ? (times.length - 1) / (last - first) : null, withoutTruth, beforePosition } };
}
