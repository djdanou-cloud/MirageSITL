// A flown maneuver's series, from its stored recording (TASK-173): what was
// requested and what the physics truth did, both on the run's own simulated clock.
// Everything the Experiments tab shows of a response comes from here, so the chart
// and the metrics read the same numbers. Cold path, on a closed recording.
import { planFlightTask, type FlightTaskDefinition } from "@mirage/scenarios/flight-tasks";
import { MANEUVER_TYPES, eulerDegOf, isManeuverType, unwrapDeg, type ManeuverAxis, type ResponseSeries } from "@mirage/scenarios/maneuvers";

/** What this needs of a decoded recording row. */
export interface RecordedRow { readonly tick: number; readonly simTimeS: number; readonly presence: number; readonly values: readonly number[] | null }
export type RecordedRows = ReadonlyMap<string, readonly RecordedRow[]>;

export interface ManeuverSeries {
  readonly axis: ManeuverAxis;
  readonly label: string;
  readonly unit: string;
  readonly requested: ResponseSeries;
  readonly actual: ResponseSeries;
  /** Where the maneuver's own record starts and ends; a chart counts its time from `startS`. */
  readonly startS: number;
  readonly endS: number;
  /** How often the recording holds the actual value; null with fewer than two values. */
  readonly actualHz: number | null;
}
export type SeriesResult = { readonly kind: "series"; readonly series: ManeuverSeries } | { readonly kind: "missing"; readonly reason: string };

/** Channels of events.flightTask (packages/aar/src/signal-catalog.ts): the stage, and the requests of a maneuver. */
const STAGE = 0, ALTITUDE = 5, HEADING = 7;
/** Channels of events.flightTaskAttitude. */
const ROLL = 0, PITCH = 1;
/** Actual values from this long before the first request, so its first change has a value to start from. */
const LEAD_S = 1;
const AXES: Readonly<Record<ManeuverAxis, { readonly label: string; readonly unit: string }>> = {
  roll: { label: "Roll", unit: "°" }, pitch: { label: "Pitch", unit: "°" }, heading: { label: "Heading", unit: "°" }, altitude: { label: "Altitude", unit: "m" },
};

/** A channel of a row, null where the row's presence mask says it is absent. */
export function channel(row: RecordedRow, index: number): number | null {
  const value = row.values?.[index];
  return value !== undefined && (row.presence & (1 << index)) !== 0 ? value : null;
}

/** The requested and actual series of a task's maneuver, or what the recording lacks. */
export function maneuverSeries(task: FlightTaskDefinition, rows: RecordedRows): SeriesResult {
  if (!isManeuverType(task.type)) return { kind: "missing", reason: "This task is not a tuning maneuver" };
  const { axis } = MANEUVER_TYPES[task.type];
  const stageIndex = planFlightTask(task).findIndex(planned => planned.stage.kind === "maneuver");
  const stageRows = (rows.get("events.flightTask") ?? []).filter(row => channel(row, STAGE) === stageIndex);
  const first = stageRows[0], last = stageRows[stageRows.length - 1];
  if (!first || !last) return { kind: "missing", reason: "The recording holds no requests of the maneuver: the run may have ended before it began" };

  const requestedRows = (): { timeS: number[]; value: number[] } => {
    const timeS: number[] = [], value: number[] = [];
    const add = (row: RecordedRow, index: number) => {
      const requested = channel(row, index);
      if (requested !== null) { timeS.push(row.simTimeS); value.push(requested); }
    };
    switch (axis) {
      case "roll": case "pitch":
        for (const row of rows.get("events.flightTaskAttitude") ?? []) if (row.tick >= first.tick && row.tick <= last.tick) add(row, axis === "roll" ? ROLL : PITCH);
        break;
      case "heading": for (const row of stageRows) add(row, HEADING); break;
      case "altitude": for (const row of stageRows) add(row, ALTITUDE); break;
      default: { const never: never = axis; throw new Error(`Unhandled maneuver axis ${String(never)}`); }
    }
    return { timeS, value };
  };
  const requested = requestedRows();
  if (requested.value.length === 0) return { kind: "missing", reason: `The recording holds no ${AXES[axis].label.toLowerCase()} requests of the maneuver` };

  const fromS = first.simTimeS - LEAD_S, toS = last.simTimeS;
  const truthSignal = axis === "altitude" ? "truth.position" : "truth.attitude";
  const timeS: number[] = [], value: number[] = [];
  for (const row of rows.get(truthSignal) ?? []) {
    if (row.simTimeS < fromS || row.simTimeS > toS || !row.values) continue;
    const [a, b, c, d] = row.values;
    if (a === undefined || b === undefined || c === undefined) continue;
    if (axis === "altitude") { timeS.push(row.simTimeS); value.push(-c); continue; }
    if (d === undefined) continue;
    const { rollDeg, pitchDeg, yawDeg } = eulerDegOf(a, b, c, d);
    timeS.push(row.simTimeS);
    value.push(axis === "roll" ? rollDeg : axis === "pitch" ? pitchDeg : yawDeg);
  }
  if (timeS.length === 0) return { kind: "missing", reason: `The recording holds no ${truthSignal} around the maneuver. It is chosen on the Logging tab, before the run` };

  // A heading is continuous through north, and the actual one counts the same turns as the request.
  let requestedValue = requested.value, actualValue = value;
  if (axis === "heading") {
    requestedValue = unwrapDeg(requested.value);
    const unwrapped = unwrapDeg(value), turns = Math.round(((requestedValue[0] ?? 0) - (unwrapped[0] ?? 0)) / 360);
    actualValue = unwrapped.map(heading => heading + turns * 360);
  }
  const firstActualS = timeS[0] ?? 0, lastActualS = timeS[timeS.length - 1] ?? 0;
  return { kind: "series", series: {
    axis, ...AXES[axis], requested: { timeS: requested.timeS, value: requestedValue }, actual: { timeS, value: actualValue },
    startS: first.simTimeS, endS: last.simTimeS, actualHz: timeS.length > 1 && lastActualS > firstActualS ? (timeS.length - 1) / (lastActualS - firstActualS) : null,
  } };
}

/** The last value of a series at or before a moment; null before its first. */
export function valueAt(series: ResponseSeries, timeS: number): number | null {
  let low = 0, high = series.timeS.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((series.timeS[middle] ?? Number.POSITIVE_INFINITY) <= timeS) low = middle + 1; else high = middle;
  }
  return series.value[low - 1] ?? null;
}
