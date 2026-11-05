import { readDataFlash, type DataFlashColumn, type DataFlashGroup, type DataFlashLog } from "@mirage/dataflash/reader";
import { logSpan, type LogExtraction, type LogParameter } from "./log-to-experiment.ts";

// Re-simulation against the flight a log came from (TASK-183, S15). A run started from a log takes its place and its settings and nothing of its path: resimulationInputs is all
// the Run tab reads of the log, so the physics integrates its own trajectory from the ground and can go anywhere. The comparison reads both logs the same way and describes
// the difference; no limit applies to it (SA-01). Cold path.

const TIME_SCALE = 1e-6;
/** What a re-simulation takes of a log: where it stands and what it is set to, with the user's changes on top. No position, attitude or command of the flight. */
export interface ResimulationInputs {
  readonly home: LogExtraction["home"];
  readonly parameters: readonly { readonly name: string; readonly value: number }[];
}
export function resimulationInputs(extraction: Pick<LogExtraction, "home" | "parameters">, changes: readonly { readonly name: string; readonly value: number }[]): ResimulationInputs {
  const changed = new Set(changes.map(change => change.name));
  return { home: extraction.home, parameters: [...extraction.parameters.filter((parameter: LogParameter) => !changed.has(parameter.name)).map(({ name, value }) => ({ name, value })), ...changes] };
}

/** A flight's position over time, from the EKF's first core or, in a log MirageSITL wrote from its recording, the truth: north, east and height from the log's origin. */
export interface FlightTrack {
  readonly source: "XKF1" | "MSTR";
  readonly timeS: readonly number[];
  readonly northM: readonly number[];
  readonly eastM: readonly number[];
  readonly heightM: readonly number[];
}
const group = (log: DataFlashLog, name: string): DataFlashGroup | null => log.groups.find(item => item.name === name && item.count > 0) ?? null;
const column = (from: DataFlashGroup, name: string): DataFlashColumn | null => from.columns.find(item => item.name === name) ?? null;
const valueAt = (item: DataFlashColumn | null, row: number): number => (item ? Number(item.values[row]) * item.valueScale : Number.NaN);

export function flightTrack(log: DataFlashLog, interval: { readonly fromS: number; readonly toS: number } | null = null): FlightTrack | null {
  const source: FlightTrack["source"] | null = group(log, "XKF1") ? "XKF1" : group(log, "MSTR") ? "MSTR" : null;
  const rows = source ? group(log, source) : null;
  if (!source || !rows) return null;
  const time = column(rows, "TimeUS"), core = column(rows, "C"), pn = column(rows, "PN"), pe = column(rows, "PE"), pd = column(rows, "PD");
  const track = { source, timeS: [] as number[], northM: [] as number[], eastM: [] as number[], heightM: [] as number[] };
  for (let row = 0; row < rows.count; row++) {
    if (core && Number(core.values[row]) !== 0) continue;
    const at = Number(time?.values[row]) * TIME_SCALE;
    if (!Number.isFinite(at) || (interval && (at < interval.fromS || at > interval.toS))) continue;
    track.timeS.push(at); track.northM.push(valueAt(pn, row)); track.eastM.push(valueAt(pe, row)); track.heightM.push(-valueAt(pd, row));
  }
  return track.timeS.length > 0 ? track : null;
}

export interface FlightMetrics {
  readonly durationS: number;
  readonly maxHeightM: number;
  /** The farthest from where the track starts, on the ground plane. */
  readonly horizontalRangeM: number;
  readonly pathLengthM: number;
}
export function flightMetrics(track: FlightTrack): FlightMetrics {
  const north = track.northM[0] ?? 0, east = track.eastM[0] ?? 0;
  let maxHeightM = Number.NEGATIVE_INFINITY, horizontalRangeM = 0, pathLengthM = 0;
  track.timeS.forEach((_, index) => {
    const n = track.northM[index] ?? 0, e = track.eastM[index] ?? 0, h = track.heightM[index] ?? 0;
    maxHeightM = Math.max(maxHeightM, h);
    horizontalRangeM = Math.max(horizontalRangeM, Math.hypot(n - north, e - east));
    if (index > 0) pathLengthM += Math.hypot(n - (track.northM[index - 1] ?? 0), e - (track.eastM[index - 1] ?? 0), h - (track.heightM[index - 1] ?? 0));
  });
  return { durationS: (track.timeS[track.timeS.length - 1] ?? 0) - (track.timeS[0] ?? 0), maxHeightM, horizontalRangeM, pathLengthM };
}

export interface PathDifference {
  /** How long the two overlap once aligned, s, and the samples compared. */
  readonly comparedS: number;
  readonly samples: number;
  readonly horizontalRmsM: number;
  readonly horizontalMaxM: number;
  readonly heightRmsM: number;
  readonly heightMaxM: number;
}
/** The second track, shifted by `secondOffsetS`, read at the first's times, straight between its neighbours; null when they do not overlap. */
export function pathDifference(first: FlightTrack, second: FlightTrack, secondOffsetS: number): PathDifference | null {
  let at = 0, samples = 0, horizontal = 0, height = 0, horizontalMaxM = 0, heightMaxM = 0, firstS = Number.NaN, lastS = Number.NaN;
  first.timeS.forEach((timeS, index) => {
    const target = timeS - secondOffsetS;
    while (at + 1 < second.timeS.length && (second.timeS[at + 1] ?? Number.POSITIVE_INFINITY) <= target) at++;
    const a = second.timeS[at], b = second.timeS[at + 1];
    if (a === undefined || target < a || (b === undefined && target !== a)) return;
    const share = b === undefined || b === a ? 0 : (target - a) / (b - a);
    const read = (values: readonly number[]) => (values[at] ?? 0) + ((values[at + 1] ?? values[at] ?? 0) - (values[at] ?? 0)) * share;
    const horizontalGap = Math.hypot((first.northM[index] ?? 0) - read(second.northM), (first.eastM[index] ?? 0) - read(second.eastM)), heightGap = Math.abs((first.heightM[index] ?? 0) - read(second.heightM));
    horizontal += horizontalGap * horizontalGap; height += heightGap * heightGap;
    horizontalMaxM = Math.max(horizontalMaxM, horizontalGap); heightMaxM = Math.max(heightMaxM, heightGap);
    samples++;
    if (Number.isNaN(firstS)) firstS = timeS;
    lastS = timeS;
  });
  if (samples === 0) return null;
  return { comparedS: lastS - firstS, samples, horizontalRmsM: Math.sqrt(horizontal / samples), horizontalMaxM, heightRmsM: Math.sqrt(height / samples), heightMaxM };
}

export interface ResimulationComparison {
  /** A metric of what the log shows over its interval, and of the run. */
  readonly original: FlightMetrics;
  readonly run: FlightMetrics;
  readonly originalSource: FlightTrack["source"];
  readonly runSource: FlightTrack["source"];
  /** Added to the original log's times, so the interval's start falls on the start of the run's log. */
  readonly secondOffsetS: number;
  readonly difference: PathDifference | null;
}
export type ComparisonResult = { readonly kind: "compared"; readonly comparison: ResimulationComparison } | { readonly kind: "missing"; readonly reason: string };
export function compareToOriginal(runBytes: Uint8Array, originalBytes: Uint8Array, interval: { readonly fromS: number; readonly toS: number }): ComparisonResult {
  const runLog = readDataFlash(runBytes), originalLog = readDataFlash(originalBytes), run = flightTrack(runLog), original = flightTrack(originalLog, interval), span = logSpan(runLog);
  if (!original) return { kind: "missing", reason: "The original log holds no position over its interval: neither XKF1 nor MSTR." };
  if (!run || !span) return { kind: "missing", reason: "The run's log holds no position: neither XKF1 nor MSTR." };
  const secondOffsetS = span.fromS - interval.fromS;
  return { kind: "compared", comparison: { original: flightMetrics(original), run: flightMetrics(run), originalSource: original.source, runSource: run.source, secondOffsetS, difference: pathDifference(run, original, secondOffsetS) } };
}
