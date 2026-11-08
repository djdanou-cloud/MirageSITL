import type { DataFlashColumn, DataFlashGroup, DataFlashLog } from "@mirage/dataflash/reader";
import { gnssSolution } from "@mirage/sensors/gnss";
import { GPS_ALMANAC, GPS_ALMANAC_SOURCE } from "@mirage/sensors/gps-almanac";

// Logged GNSS statistics (TASK-117; SPECS_SIMULATION_ENGINES "Logged receiver statistics"): what a real ArduCopter log's first GNSS
// receiver reported (fix type, satellites, HDOP and its own accuracy estimates) beside what the GNSS v2 model's satellite geometry
// gives at the same place and GPS time. A log holds the receiver's reports, not its position error: without a reference position the
// error itself is not in it. Cold path.

export interface Percentiles { readonly p5: number; readonly p50: number; readonly p95: number; readonly samples: number }
export interface GnssLogStatistics {
  readonly epochs: number;
  readonly durationS: number;
  readonly rateHz: number;
  /** GPS.Status values (3 3-D fix, 4 DGPS or SBAS, 5 RTK float, 6 RTK fixed) and their epoch counts. */
  readonly status: Readonly<Record<string, number>>;
  readonly satellites: Percentiles;
  readonly hdop: Percentiles;
  /** GPA's horizontal, vertical and speed accuracy, m and m/s; null without GPA. */
  readonly horizontalAccuracyM: Percentiles | null;
  readonly verticalAccuracyM: Percentiles | null;
  readonly speedAccuracyMps: Percentiles | null;
  /** The GNSS v2 model's geometry at the log's positions and GPS times, one solution per `MODEL_STEP_S`. */
  /**
   * The model's geometry: the real GPS almanac of week 2444 propagated to each epoch's own GPS time, and how many weeks lay between
   * the almanac and the log's first and last epochs (its orbital planes and slots are real, its positions that far away are not).
   */
  readonly model: {
    readonly visible: Percentiles; readonly hdop: Percentiles; readonly accuracyM: Percentiles; readonly solutions: number;
    readonly almanacWeek: number; readonly weeksFromAlmanac: readonly [number, number];
  };
}
/** The model's settings: the `gnss.constellation` effect's defaults (mask 10°, σ 1.5 m). */
export const MODEL_SETTINGS = Object.freeze({ maskDeg: 10, uereM: 1.5, stepS: 10 });

const groupOf = (log: DataFlashLog, name: string): DataFlashGroup | null => log.groups.find(item => item.name === name && item.count > 0) ?? null;
const columnOf = (group: DataFlashGroup, name: string): DataFlashColumn | null => group.columns.find(item => item.name === name) ?? null;
const valueAt = (column: DataFlashColumn, row: number): number => Number(column.values[row]) * column.valueScale;

/** Nearest-rank percentiles. */
export function percentiles(values: readonly number[]): Percentiles {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) throw new Error("No values for percentiles");
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
  return { p5: at(0.05), p50: at(0.5), p95: at(0.95), samples: sorted.length };
}
function rowsOf(group: DataFlashGroup, names: readonly string[]): number[][] {
  const columns = names.map(name => { const c = columnOf(group, name); if (!c) throw new Error(`The log has no ${group.name}.${name}`); return c; });
  const instance = columnOf(group, "I"), rows: number[][] = [];
  for (let row = 0; row < group.count; row++) {
    if (instance && valueAt(instance, row) !== 0) continue;
    // Times stay in their stored units (TimeUS µs, GMS ms) whatever FMTU scales them to, as fidelity.ts reads them.
    rows.push(columns.map(c => (c.name === "TimeUS" || c.name === "GMS" ? Number(c.values[row]) : valueAt(c, row))));
  }
  return rows;
}

/** The first receiver's reports with a 3-D fix or better, and the model's geometry at the same places and times. */
export function gnssLogStatistics(log: DataFlashLog): GnssLogStatistics {
  const gps = groupOf(log, "GPS");
  if (!gps) throw new Error("The log has no GPS messages");
  const all = rowsOf(gps, ["TimeUS", "Status", "NSats", "HDop", "GWk", "GMS", "Lat", "Lng", "Alt"]);
  const status: Record<string, number> = {};
  for (const r of all) status[String(r[1])] = (status[String(r[1])] ?? 0) + 1;
  const fixed = all.filter(r => r[1]! >= 3);
  if (fixed.length < 2) throw new Error("The log has fewer than two GPS epochs with a 3-D fix");
  const durationS = (fixed[fixed.length - 1]![0]! - fixed[0]![0]!) * 1e-6;
  const gpa = groupOf(log, "GPA");
  let accuracy: number[][] = [];
  if (gpa) accuracy = rowsOf(gpa, ["HAcc", "VAcc", "SAcc"]);
  const column = (k: number) => percentiles(accuracy.map(r => r[k]!));
  const visible: number[] = [], hdop: number[] = [], accuracyM: number[] = [];
  const effects = { constellation: { maskRad: MODEL_SETTINGS.maskDeg * Math.PI / 180, uereM: MODEL_SETTINGS.uereM }, atmosphere: null, terrain: null, jamming: null };
  let next = -Infinity;
  for (const r of fixed) {
    const t = r[0]! * 1e-6;
    if (t < next) continue;
    next = t + MODEL_SETTINGS.stepS;
    const week = r[4]!;
    const solution = gnssSolution(GPS_ALMANAC, { latRad: r[6]! * Math.PI / 180, lonRad: r[7]! * Math.PI / 180, heightM: r[8]!, eastM: 0, northM: 0 },
      week, r[5]! / 1000, effects);
    visible.push(solution.visible);
    if (solution.dilution) hdop.push(solution.dilution.hdop);
    if (solution.accuracyM !== null) accuracyM.push(solution.accuracyM);
  }
  return {
    epochs: fixed.length, durationS, rateHz: (fixed.length - 1) / durationS, status,
    satellites: percentiles(fixed.map(r => r[2]!)), hdop: percentiles(fixed.map(r => r[3]!)),
    horizontalAccuracyM: accuracy.length ? column(0) : null, verticalAccuracyM: accuracy.length ? column(1) : null,
    speedAccuracyMps: accuracy.length ? column(2) : null,
    model: { visible: percentiles(visible), hdop: percentiles(hdop), accuracyM: percentiles(accuracyM), solutions: visible.length,
      almanacWeek: GPS_ALMANAC_SOURCE.week, weeksFromAlmanac: [fixed[0]![4]! - GPS_ALMANAC_SOURCE.week, fixed[fixed.length - 1]![4]! - GPS_ALMANAC_SOURCE.week] },
  };
}
