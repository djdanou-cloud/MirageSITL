import type { ExperimentPayload } from "@mirage/aircraft/experiment";
import { columnText, readDataFlash, type DataFlashLog } from "@mirage/dataflash/reader";
import { DataFlashWriter, type ParameterStatus } from "@mirage/dataflash/writer";
import { formatParameterValue } from "@mirage/autopilot/param-service";
import type { ParameterChange } from "../params/parameter-sets";

// What the Analysis tab shows beside a log (TASK-180, S14). An experiment knows its aircraft, its versions, its conditions and the
// parameter changes of its run; a log from elsewhere knows only what it holds. A field nobody knows reads as unknown, and a parameter
// history a source does not hold is never made up: a log's own PARM records are its only history, and they say nothing of what was
// requested or refused. The file for the viewer is the run's own DataFlash log when the launcher still has it; otherwise this adapter
// writes one from the stored recording with the TASK-178 writer, which holds MirageSITL's truth and no ArduPilot data, and says so.

/** How a change stands on the timeline. `logged` comes from a log's own records, which do not say who asked. */
export type TimelineStatus = "requested" | "confirmed" | "rejected" | "superseded" | "logged";
export interface TimelineEvent {
  readonly timeS: number;
  readonly name: string;
  /** What the plot and the table say. */
  readonly text: string;
  readonly status: TimelineStatus;
  /** The value before, and the value it was changed to; null when the source does not say. */
  readonly from: number | null;
  readonly to: number | null;
}
/** A value of the context, or null: unknown, which the panel says in those words. */
export interface ContextRow { readonly label: string; readonly value: string | null }
export interface ParameterDifference { readonly name: string; readonly from: number | null; readonly to: number | null }
export interface AnalysisContext {
  readonly source: "experiment" | "external";
  readonly title: string;
  readonly rows: readonly ContextRow[];
  /** The source of `events`, or null when it holds no parameter history at all. */
  readonly history: "run" | "log" | null;
  readonly events: readonly TimelineEvent[];
  /** What the run changed, from its first value to its last confirmed one; null when no history is known. */
  readonly differences: readonly ParameterDifference[] | null;
  /** What it differs from its parent in, if it is a repeat or a variant; null when it has none. */
  readonly lineage: string | null;
}

function statusOf(change: ParameterChange): TimelineStatus {
  switch (change.outcome.kind) {
    case "requested": return "requested";
    case "confirmed": return "confirmed";
    case "refused": case "timeout": return "rejected";
    case "stale": return "superseded";
    default: { const never: never = change.outcome; return never; }
  }
}
/** A value as ArduPilot holds it: the shortest decimal of its float32, so 0.39 and not 0.38999998569488525. */
export function parameterText(value: number | null): string {
  if (value === null) return "unknown";
  return Number.isFinite(value) ? formatParameterValue(Math.fround(value)) : String(value);
}
function changeText(change: ParameterChange, status: TimelineStatus): string {
  return `${change.name} ${parameterText(change.oldValue)} → ${parameterText(change.newValue)} (${status})`;
}

/** The differences a run's changes made: each parameter from the value it held before its first change to its last confirmed value. */
export function runDifferences(changes: readonly ParameterChange[]): readonly ParameterDifference[] {
  const first = new Map<string, number | null>(), last = new Map<string, number>();
  for (const change of changes) {
    if (!first.has(change.name)) first.set(change.name, change.oldValue);
    if (change.outcome.kind === "confirmed") last.set(change.name, change.newValue);
  }
  return [...last.entries()].filter(([name, to]) => first.get(name) !== to).map(([name, to]) => ({ name, from: first.get(name) ?? null, to })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The context of a stored experiment. `changes` is its parameter log, or null when none was stored: nothing is then said of its changes. */
export function experimentContext(name: string, payload: ExperimentPayload, changes: readonly ParameterChange[] | null): AnalysisContext {
  const { profile, session, sitl, lineage } = payload, [latitude, longitude, altitude, heading] = session.home;
  const firmware = sitl.ownership === "launcher" ? `${sitl.ardupilot.firmwareVersion}, commit ${sitl.ardupilot.commit}` : `${sitl.ardupilot.firmwareVersion}, a SITL started by hand`;
  const rows: ContextRow[] = [
    { label: "Aircraft profile", value: `${profile.name}, version ${profile.version}` },
    { label: "Profile SHA-256", value: profile.sha256 },
    // The profile's version pins its component cards: the profile names each card by its SHA-256.
    { label: "Component versions", value: `As pinned by profile version ${profile.version}` },
    { label: "ArduPilot", value: firmware },
    { label: "Physics rate", value: `${session.physicsHz} Hz` },
    { label: "Speed", value: session.speedup === null ? "Set by the SITL" : `${session.speedup}×` },
    { label: "Location", value: `${latitude}°, ${longitude}°, ${altitude} m, heading ${heading}°` },
    // This record holds no weather yet (TASK-167 stores it): the run may have had any.
    { label: "Wind and temperature", value: null },
    { label: "Initial parameters", value: String(payload.parameters.length) },
    { label: "Flight task", value: payload.flightTask ? payload.flightTask.name : "None" },
  ];
  const lineageText = lineage.kind === "original" ? null : lineage.kind === "repeat" ? "A repeat of its parent, with the same inputs." : `A variant of its parent: ${lineage.changes.join(", ")}.`;
  if (changes === null) return { source: "experiment", title: name, rows, history: null, events: [], differences: null, lineage: lineageText };
  const events = changes.map((change): TimelineEvent => {
    const status = statusOf(change);
    return { timeS: change.simTimeS, name: change.name, text: changeText(change, status), status, from: change.oldValue, to: change.newValue };
  });
  return { source: "experiment", title: name, rows, history: "run", events, differences: runDifferences(changes), lineage: lineageText };
}

/** What a DataFlash column holds, by name; null when it has no such column. */
const columnOf = (log: DataFlashLog, group: string, column: string) => log.groups.find(item => item.name === group)?.columns.find(item => item.name === column) ?? null;
/** The firmware as the log's VER or MSG records name it; null when they do not. */
function firmwareOf(log: DataFlashLog): string | null {
  const text = columnOf(log, "MSG", "Message");
  if (text) {
    const count = log.groups.find(item => item.name === "MSG")?.count ?? 0;
    for (let row = 0; row < count; row++) {
      const line = columnText(text, row);
      if (/^(ArduCopter|ArduPlane|ArduRover|ArduSub|APM:)/.test(line)) return line;
    }
  }
  const version = columnOf(log, "VER", "FWS");
  return version && (log.groups.find(item => item.name === "VER")?.count ?? 0) > 0 ? columnText(version, 0) : null;
}
/**
 * The context of a log from elsewhere. It says what the log holds and marks the rest unknown. A parameter's first PARM record is its
 * value at the start, not a change; each later record with another value is a change the log saw, with nothing on who asked for it.
 */
export function externalLogContext(name: string, bytes: Uint8Array): AnalysisContext {
  const log = readDataFlash(bytes), rows: ContextRow[] = [
    { label: "Log file", value: `${name}, ${bytes.length.toLocaleString("en-US")} bytes` },
    { label: "ArduPilot", value: firmwareOf(log) },
    { label: "Aircraft profile", value: null },
    { label: "Component versions", value: null },
    { label: "Physics rate", value: null },
    { label: "Location", value: null },
    { label: "Wind and temperature", value: null },
    { label: "Flight task", value: null },
  ];
  const parm = log.groups.find(item => item.name === "PARM"), names = columnOf(log, "PARM", "Name"), values = columnOf(log, "PARM", "Value"), times = columnOf(log, "PARM", "TimeUS");
  if (!parm || !names || !values || !times || parm.count === 0) return { source: "external", title: name, rows, history: null, events: [], differences: null, lineage: null };
  const held = new Map<string, number>(), events: TimelineEvent[] = [], first = new Map<string, number>();
  for (let row = 0; row < parm.count; row++) {
    const parameter = columnText(names, row), value = Number(values.values[row]) * values.valueScale, before = held.get(parameter);
    // The firmware's own counters change all through a flight; nobody changes them.
    if (parameter.startsWith("STAT_")) continue;
    if (before === undefined) first.set(parameter, value);
    // TimeUS, the log's own clock, which is the viewer's axis; the reader's timestamps become Unix time once GNSS has a week.
    else if (before !== value) events.push({ timeS: Number(times.values[row]) * 1e-6, name: parameter, text: `${parameter} ${parameterText(before)} → ${parameterText(value)} (in the log)`, status: "logged", from: before, to: value });
    held.set(parameter, value);
  }
  const differences = [...first.entries()].filter(([parameter, value]) => held.get(parameter) !== value).map(([parameter, from]) => ({ name: parameter, from, to: held.get(parameter) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { source: "external", title: name, rows, history: "log", events, differences, lineage: null };
}

/** The message the viewer draws on the plot's timeline (mirage.setEvents); its clock is the log's, in milliseconds. */
export const viewerEvents = (context: AnalysisContext) => context.events.map(event => ({ timeMs: event.timeS * 1000, text: event.text, status: event.status }));

// ---- a DataFlash file from a stored recording ------------------------------------------------------------------------------------

interface Row { readonly tick: number; readonly simTimeS: number; readonly values: ArrayLike<number> | null }
const WGS84_A = 6378137, WGS84_E2 = 6.69437999014e-3;
const degrees = (radians: number) => radians * 180 / Math.PI;
/** Latitude and longitude of a small NED offset from home, from the WGS84 radii of curvature there. */
function geodetic(latitudeDeg: number, longitudeDeg: number, altitudeM: number, north: number, east: number): { latitudeDeg: number; longitudeDeg: number } {
  const phi = latitudeDeg * Math.PI / 180, s = Math.sin(phi), w = Math.sqrt(1 - WGS84_E2 * s * s), meridional = WGS84_A * (1 - WGS84_E2) / (w * w * w), normal = WGS84_A / w;
  return { latitudeDeg: latitudeDeg + degrees(north / (meridional + altitudeM)), longitudeDeg: longitudeDeg + degrees(east / ((normal + altitudeM) * Math.cos(phi))) };
}
const writerStatus = (status: TimelineStatus): ParameterStatus => (status === "confirmed" ? "confirmed" : status === "rejected" ? "rejected" : "requested");
/**
 * A DataFlash file of MirageSITL's truth (MSTR) and the run's parameter changes (MSPC), for a run whose ArduPilot log is not at hand.
 * Rows of the four truth signals pair up by tick; a tick missing one of them is left out, never filled in. Null when no tick has all four.
 */
export function recordingDataflash(rows: ReadonlyMap<string, readonly Row[]>, home: readonly [number, number, number, number], changes: readonly ParameterChange[] | null): Uint8Array | null {
  const byTick = (signal: string) => new Map((rows.get(signal) ?? []).filter(row => row.values !== null).map(row => [row.tick, row]));
  const position = rows.get("truth.position") ?? [], velocity = byTick("truth.velocity"), attitude = byTick("truth.attitude"), rates = byTick("truth.bodyRates");
  const writer = new DataFlashWriter();
  let written = 0;
  for (const row of position) {
    const v = velocity.get(row.tick)?.values, q = attitude.get(row.tick)?.values, w = rates.get(row.tick)?.values, p = row.values;
    if (!p || !v || !q || !w) continue;
    const north = p[0] ?? NaN, east = p[1] ?? NaN, down = p[2] ?? NaN, qw = q[0] ?? NaN, qx = q[1] ?? NaN, qy = q[2] ?? NaN, qz = q[3] ?? NaN;
    const place = geodetic(home[0], home[1], home[2], north, east);
    writer.append({ kind: "truth", timeUs: Math.round(row.simTimeS * 1e6), ...place, altitudeM: home[2] - down, northM: north, eastM: east, downM: down,
      northMps: v[0] ?? NaN, eastMps: v[1] ?? NaN, downMps: v[2] ?? NaN,
      rollDeg: degrees(Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy))), pitchDeg: degrees(Math.asin(Math.max(-1, Math.min(1, 2 * (qw * qy - qz * qx))))),
      yawDeg: degrees(Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz))), rollRateDegS: degrees(w[0] ?? NaN), pitchRateDegS: degrees(w[1] ?? NaN), yawRateDegS: degrees(w[2] ?? NaN) });
    written++;
  }
  if (written === 0) return null;
  (changes ?? []).forEach((change, index) => {
    const status = statusOf(change);
    writer.append({ kind: "parameter", timeUs: Math.round(change.simTimeS * 1e6), sequence: index + 1, name: change.name.slice(0, 16), requestedValue: change.newValue, previousValue: change.oldValue,
      confirmedValue: change.outcome.kind === "confirmed" ? change.outcome.value : null, status: writerStatus(status) });
  });
  return writer.bytes();
}
