// What one flown experiment did (TASK-177, S12), computed from its stored recording.
// The definitions, with their units, are in docs/SPECS_SIMULATION_ENGINES.md,
// "Experiment comparison". These describe, and no limit applies to any of them (SA-01).
// A signal the recording lacks reads as null, never as zero. Cold path, on a closed recording.
import { LIMIT_BATTERY_SUBJECT, LIMIT_CODE, LIMIT_QUANTITIES, LIMIT_ROW, limitKindOf, type LimitKind, type LimitQuantity } from '@mirage/physics/limit-monitor';
import type { FlightTaskDefinition } from '@mirage/scenarios/flight-tasks';
import { isManeuverType, maneuverResponse, type EdgeResponse } from '@mirage/scenarios/maneuvers';
import { channel, maneuverSeries, type RecordedRow, type RecordedRows } from './response-series.ts';

/** Above this height over where it stood, the aircraft counts as airborne: clear of the gear's compression and of ground handling. */
export const AIRBORNE_ABOVE_REST_M = 0.5;
/** The settling band the comparison reads a maneuver's response at, as a fraction of the change requested. */
export const COMPARISON_BAND = 0.05;

export interface FlightFacts {
  readonly liftedOff: boolean;
  /** The height the first recorded row stands at. */
  readonly restAltitudeM: number;
  readonly highestAboveRestM: number;
  /** The first and last moments above AIRBORNE_ABOVE_REST_M over the rest height; null if it never was. */
  readonly startS: number | null;
  readonly endS: number | null;
}
export interface Range { readonly mean: number; readonly max: number }
export interface WindowMetrics {
  readonly startS: number; readonly endS: number; readonly durationS: number;
  /** Rev/min: the mean over the motors, then over time; the max is any motor's. */
  readonly rpm: Range | null;
  /** The ESC command, 0 to 1, in the same way. */
  readonly command: Range | null;
  readonly current: Range | null;
  readonly power: Range | null;
  readonly voltage: { readonly min: number } | null;
  readonly energyWh: number | null;
  readonly chargeUsedAh: number | null;
}
export interface PackStart { readonly remainingAh: number; readonly capacityAh: number }
export interface PositionDifference {
  readonly samples: number;
  readonly horizontalRmsM: number | null; readonly horizontalMaxM: number | null;
  readonly altitudeRmsM: number | null; readonly altitudeMaxM: number | null;
}
export interface LimitEntry {
  readonly subject: number | 'battery';
  readonly quantity: LimitQuantity;
  readonly kind: LimitKind;
  readonly episodes: number;
  /** Time spent exceeding, up to the recording's last row for one still on. */
  readonly totalS: number;
  readonly firstS: number;
  /** The rating or modeled limit; null when the model states none. */
  readonly limit: number | null;
  /** Still on when the recording ended. */
  readonly open: boolean;
}
export interface LimitSummary {
  /** False for a recording made before limits were recorded: it cannot say whether there were any. */
  readonly recorded: boolean;
  readonly dropped: number;
  readonly entries: readonly LimitEntry[];
}
export interface ExperimentMetrics {
  readonly flight: FlightFacts | null;
  /** The task's measured part; null without a task, or before it began. */
  readonly task: WindowMetrics | null;
  /** From the first to the last moment airborne; null if it never was. */
  readonly wholeFlight: WindowMetrics | null;
  readonly pack: PackStart | null;
  /** Against what was requested over the measured part; null without a task, and for a maneuver, whose request jumps on purpose. */
  readonly position: PositionDifference | null;
  /** A maneuver's response to each change; null for any other run. */
  readonly response: readonly EdgeResponse[] | null;
  readonly limits: LimitSummary;
}

const BATTERY = { soc: 0, voltage: 1, current: 2, power: 3, remaining: 4 } as const;
const REQUEST = { stage: 0, measured: 1, north: 3, east: 4, altitude: 5 } as const;

const inWindow = (rows: readonly RecordedRow[], fromS: number, toS: number) => rows.filter(row => row.simTimeS >= fromS && row.simTimeS <= toS);

/** The time-weighted mean by trapezoids, and the largest and smallest; null with no value. */
function spread(rows: readonly RecordedRow[], valueOf: (row: RecordedRow) => number | null): { mean: number; max: number; min: number; area: number } | null {
  let area = 0, max = Number.NEGATIVE_INFINITY, min = Number.POSITIVE_INFINITY, first: number | null = null, last: number | null = null, lastValue = 0;
  for (const row of rows) {
    const value = valueOf(row);
    if (value === null) continue;
    if (last !== null) area += (value + lastValue) / 2 * (row.simTimeS - last);
    first ??= row.simTimeS;
    last = row.simTimeS;
    lastValue = value;
    max = Math.max(max, value);
    min = Math.min(min, value);
  }
  if (first === null || last === null) return null;
  return { mean: last > first ? area / (last - first) : lastValue, max, min, area };
}
/** Over the motors a row holds: their mean at each moment over time, and the largest any of them reached. */
function overMotors(rows: readonly RecordedRow[]): Range | null {
  const presentValues = (row: RecordedRow): number[] => (row.values ?? []).filter((_, i) => channel(row, i) !== null);
  const mean = spread(rows, row => { const values = presentValues(row); return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null; });
  if (!mean) return null;
  return { mean: mean.mean, max: rows.reduce((largest, row) => Math.max(largest, ...presentValues(row)), Number.NEGATIVE_INFINITY) };
}
function windowMetrics(rows: RecordedRows, startS: number, endS: number): WindowMetrics {
  const battery = inWindow(rows.get('battery') ?? [], startS, endS);
  const current = spread(battery, row => channel(row, BATTERY.current)), power = spread(battery, row => channel(row, BATTERY.power)), voltage = spread(battery, row => channel(row, BATTERY.voltage));
  const remaining = battery.flatMap(row => { const value = channel(row, BATTERY.remaining); return value === null ? [] : [value]; });
  const firstRemaining = remaining[0], lastRemaining = remaining[remaining.length - 1];
  return {
    startS, endS, durationS: endS - startS,
    rpm: overMotors(inWindow(rows.get('motors.speed') ?? [], startS, endS)), command: overMotors(inWindow(rows.get('motors.command') ?? [], startS, endS)),
    current: current && { mean: current.mean, max: current.max }, power: power && { mean: power.mean, max: power.max }, voltage: voltage && { min: voltage.min },
    energyWh: power && power.area / 3600, chargeUsedAh: firstRemaining !== undefined && lastRemaining !== undefined ? firstRemaining - lastRemaining : null,
  };
}
function flightFacts(rows: RecordedRows): FlightFacts | null {
  const heights = (rows.get('truth.position') ?? []).flatMap(row => { const down = row.values?.[2]; return down === undefined ? [] : [{ timeS: row.simTimeS, altitudeM: -down }]; });
  const first = heights[0];
  if (!first) return null;
  const above = heights.filter(height => height.altitudeM > first.altitudeM + AIRBORNE_ABOVE_REST_M);
  return {
    liftedOff: above.length > 0, restAltitudeM: first.altitudeM, highestAboveRestM: Math.max(...heights.map(height => height.altitudeM)) - first.altitudeM,
    startS: above[0]?.timeS ?? null, endS: above[above.length - 1]?.timeS ?? null,
  };
}
function positionDifference(measured: readonly RecordedRow[], truth: readonly RecordedRow[]): PositionDifference {
  // The first truth row at or after each request's tick: both come in tick order.
  let at = 0, samples = 0, horizontalSum = 0, horizontalMax: number | null = null, horizontalCount = 0, altitudeSum = 0, altitudeMax: number | null = null, altitudeCount = 0;
  for (const row of measured) {
    while ((truth[at]?.tick ?? Number.POSITIVE_INFINITY) < row.tick) at++;
    const [north, east, down] = truth[at]?.values ?? [];
    if (north === undefined || east === undefined || down === undefined) continue;
    samples++;
    const requestedNorth = channel(row, REQUEST.north), requestedEast = channel(row, REQUEST.east), requestedAltitude = channel(row, REQUEST.altitude);
    if (requestedNorth !== null && requestedEast !== null) {
      const difference = Math.hypot(north - requestedNorth, east - requestedEast);
      horizontalSum += difference * difference; horizontalCount++;
      horizontalMax = Math.max(horizontalMax ?? 0, difference);
    }
    if (requestedAltitude !== null) {
      const difference = Math.abs(-down - requestedAltitude);
      altitudeSum += difference * difference; altitudeCount++;
      altitudeMax = Math.max(altitudeMax ?? 0, difference);
    }
  }
  return { samples, horizontalRmsM: horizontalCount > 0 ? Math.sqrt(horizontalSum / horizontalCount) : null, horizontalMaxM: horizontalMax,
    altitudeRmsM: altitudeCount > 0 ? Math.sqrt(altitudeSum / altitudeCount) : null, altitudeMaxM: altitudeMax };
}
function limitSummary(rows: RecordedRows): LimitSummary {
  const events = rows.get('events.limit') ?? [];
  const recorded = events.some(row => channel(row, LIMIT_ROW.code) === LIMIT_CODE.monitor);
  const lastS = [...rows.values()].reduce((latest, list) => Math.max(latest, list[list.length - 1]?.simTimeS ?? latest), Number.NEGATIVE_INFINITY);
  interface Open { subject: number | 'battery'; quantity: LimitQuantity; kind: LimitKind; episodes: number; totalS: number; firstS: number; limit: number | null; onSinceS: number | null }
  const entries = new Map<string, Open>();
  let dropped = 0;
  for (const row of events) {
    const code = channel(row, LIMIT_ROW.code);
    if (code === LIMIT_CODE.dropped) dropped += channel(row, LIMIT_ROW.value) ?? 0;
    if (code !== LIMIT_CODE.event) continue;
    const quantity = LIMIT_QUANTITIES[channel(row, LIMIT_ROW.quantity) ?? -1], subjectCode = channel(row, LIMIT_ROW.subject);
    if (!quantity || subjectCode === null) continue;
    const key = `${subjectCode}/${quantity}`;
    const entry = entries.get(key) ?? { subject: subjectCode === LIMIT_BATTERY_SUBJECT ? 'battery' : subjectCode, quantity, kind: limitKindOf(quantity), episodes: 0, totalS: 0, firstS: row.simTimeS, limit: channel(row, LIMIT_ROW.limit), onSinceS: null };
    entries.set(key, entry);
    if (channel(row, LIMIT_ROW.edge) === 1) { entry.episodes++; entry.onSinceS = row.simTimeS; }
    else if (entry.onSinceS !== null) { entry.totalS += row.simTimeS - entry.onSinceS; entry.onSinceS = null; }
  }
  const rank = (entry: Open) => (entry.subject === 'battery' ? -1 : entry.subject);
  return { recorded, dropped, entries: [...entries.values()].sort((a, b) => rank(a) - rank(b) || a.quantity.localeCompare(b.quantity)).map(({ onSinceS, ...entry }) => ({
    ...entry, totalS: entry.totalS + (onSinceS === null ? 0 : lastS - onSinceS), open: onSinceS !== null,
  })) };
}
function packStart(rows: RecordedRows): PackStart | null {
  const first = rows.get('battery')?.[0];
  if (!first) return null;
  const soc = channel(first, BATTERY.soc), remainingAh = channel(first, BATTERY.remaining);
  return soc === null || remainingAh === null || soc <= 0 ? null : { remainingAh, capacityAh: remainingAh / soc };
}

/** What a recording says of one experiment; `task` is the definition it flew, or null. */
export function experimentMetrics(rows: RecordedRows, task: FlightTaskDefinition | null): ExperimentMetrics {
  const flight = flightFacts(rows);
  const requests = rows.get('events.flightTask') ?? [], measured = task ? requests.filter(row => channel(row, REQUEST.measured) === 1) : [];
  const first = measured[0], last = measured[measured.length - 1];
  const maneuver = task !== null && isManeuverType(task.type);
  let response: readonly EdgeResponse[] | null = null;
  if (task && maneuver) {
    const series = maneuverSeries(task, rows);
    if (series.kind === 'series') response = maneuverResponse(series.series.requested, series.series.actual, COMPARISON_BAND);
  }
  return {
    flight, pack: packStart(rows), limits: limitSummary(rows), response,
    task: first && last ? windowMetrics(rows, first.simTimeS, last.simTimeS) : null,
    wholeFlight: flight?.startS != null && flight.endS !== null ? windowMetrics(rows, flight.startS, flight.endS) : null,
    position: first && !maneuver ? positionDifference(measured, rows.get('truth.position') ?? []) : null,
  };
}

export interface DurationEstimate {
  readonly reservePercent: number;
  readonly meanCurrentA: number | null;
  /** The charge above the reserve at the start. */
  readonly usableAh: number;
  readonly minutes: number | null;
  /** Why there is no estimate; null when there is one. */
  readonly missing: string | null;
}
/**
 * The charge above a stated reserve, spent at a window's mean current: how long flying as that window flew would last, from the
 * charge the run started at. It holds the current constant, so it leaves out the voltage falling as the pack empties, and it is not
 * an endurance figure for a real aircraft.
 */
export function flightDurationEstimate(window: WindowMetrics, pack: PackStart, reservePercent: number): DurationEstimate {
  if (!(reservePercent >= 0 && reservePercent < 100)) throw new Error(`The reserve must be from 0 to below 100 percent, not ${String(reservePercent)}`);
  const usableAh = pack.remainingAh - pack.capacityAh * reservePercent / 100, meanCurrentA = window.current?.mean ?? null;
  const none = (missing: string): DurationEstimate => ({ reservePercent, meanCurrentA, usableAh, minutes: null, missing });
  if (meanCurrentA === null) return none('The recording holds no battery current over this part of the flight');
  if (meanCurrentA <= 0) return none('The battery gave no current over this part of the flight');
  if (usableAh <= 0) return none(`The run started at or below the ${reservePercent} % reserve`);
  return { reservePercent, meanCurrentA, usableAh, minutes: usableAh / meanCurrentA * 60, missing: null };
}
