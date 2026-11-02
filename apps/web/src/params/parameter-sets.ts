// Parameter sets and the parameter change log (TASK-160, S11). A parameter set
// is a versioned `parameter-set` record of the project store: the values of
// ArduPilot parameters with their source, the run whose SITL reported them,
// and a dependency on that run's experiment record. The change log is one
// `parameter-log` item per run whose versions each hold every parameter change
// of the run so far, so the history persists with the experiment record it
// depends on. Payloads start as unknown and become these types only here.
// Values are the float32 numbers of the MAVLink wire, stored exactly.
// Configuration-time code only.
import type { ParameterMetadataSet } from "@mirage/autopilot/param-metadata";
import type { ParameterValue, WriteState } from "@mirage/autopilot/param-service";
import { SHA256_HEX, TIMESTAMP, type StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";

export const PARAMETER_SET_SCHEMA_VERSION = 1;
export const PARAMETER_LOG_SCHEMA_VERSION = 1;
/** An ArduPilot parameter name: 1 to 16 printable ASCII characters without a space (AP_MAX_NAME_SIZE). */
const PARAMETER_NAME = /^[\x21-\x7e]{1,16}$/;
/** Entries of one set: ArduCopter 8ab6afde lists about 1,400, its metadata 5,799. */
export const MAX_SET_PARAMETERS = 8192;
/** Changes in one log version; each is a few hundred canonical JSON bytes, well inside a 1 MiB record. */
export const MAX_LOG_CHANGES = 2000;

export interface ParameterEntry { readonly name: string; readonly value: number }
/** Where a set's values come from: the parameters a run's SITL reported at one tick. */
export interface RunSource {
  readonly kind: "run";
  /** The launcher experiment or connection ID. */
  readonly experimentId: string;
  /** The run's experiment record, on which the set depends. */
  readonly experimentSha256: string;
  /** The ArduPilot source commit the run's SITL was built from. */
  readonly firmwareCommit: string;
  readonly tick: number;
  readonly simTimeS: number;
}
export interface ParameterSet {
  readonly schemaVersion: 1;
  readonly source: RunSource;
  /** Sorted by name, unique. */
  readonly parameters: readonly ParameterEntry[];
}

/** One parameter change of a run: what was asked of which parameter, when, and how it ended. */
export interface ParameterChange {
  /** The parameter service's write ID, unique within the run. */
  readonly writeId: number;
  readonly name: string;
  /** The value the autopilot reported before the write; null when it had reported none. */
  readonly oldValue: number | null;
  /** The requested value. */
  readonly newValue: number;
  /** Wall time of the request, UTC. */
  readonly requestedAt: string;
  /** The session's tick and simulated time when the request was sent. */
  readonly tick: number;
  readonly simTimeS: number;
  /** The launcher experiment or connection ID. */
  readonly experimentId: string;
  /** Sent while the run was paused: a paused lockstep SITL answers only after Resume (TASK-129). */
  readonly whilePaused: boolean;
  /** The write's latest state (TASK-159). */
  readonly outcome: WriteState;
}
export interface ParameterLog {
  readonly schemaVersion: 1;
  readonly experimentId: string;
  /** The run's experiment record, on which the log depends. */
  readonly experimentSha256: string;
  /** Oldest first. */
  readonly changes: readonly ParameterChange[];
}

function fail(message: string): never {
  throw new Error(message);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length > 0) fail(`${where} has unknown field ${extra.join(", ")}`);
  for (const key of allowed) if (!(key in value)) fail(`${where} needs ${key}`);
}
function float32(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.fround(value) !== value) fail(`${where} must be a finite float32`);
  return value;
}
function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail(`${where} must be a whole number of at least 0`);
  return value;
}
function finite(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${where} must be a finite number`);
  return value;
}
function text(value: unknown, where: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || (pattern && !pattern.test(value))) fail(`${where} is not valid`);
  return value;
}
function name(value: unknown, where: string): string {
  return text(value, where, PARAMETER_NAME);
}

function validateSource(value: unknown): RunSource {
  if (!isObject(value)) return fail("source must be an object");
  keys(value, ["kind", "experimentId", "experimentSha256", "firmwareCommit", "tick", "simTimeS"], "source");
  if (value.kind !== "run") fail("source.kind must be run");
  return { kind: "run", experimentId: text(value.experimentId, "source.experimentId"), experimentSha256: text(value.experimentSha256, "source.experimentSha256", SHA256_HEX),
    firmwareCommit: text(value.firmwareCommit, "source.firmwareCommit", /^[0-9a-f]{40}$/), tick: count(value.tick, "source.tick"), simTimeS: finite(value.simTimeS, "source.simTimeS") };
}

/** Validates a `parameter-set` payload from unknown; throws with the first reason. */
export function validateParameterSet(payload: unknown): ParameterSet {
  if (!isObject(payload)) return fail("a parameter set must be an object");
  keys(payload, ["schemaVersion", "source", "parameters"], "the parameter set");
  if (payload.schemaVersion !== PARAMETER_SET_SCHEMA_VERSION) fail(`schemaVersion must be ${PARAMETER_SET_SCHEMA_VERSION}`);
  const list = payload.parameters;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_SET_PARAMETERS) fail(`parameters must hold 1 to ${MAX_SET_PARAMETERS} entries`);
  const entries: readonly unknown[] = list;
  const parameters = entries.map((entry, index): ParameterEntry => {
    if (!isObject(entry)) return fail(`parameters[${index}] must be an object`);
    keys(entry, ["name", "value"], `parameters[${index}]`);
    return { name: name(entry.name, `parameters[${index}].name`), value: float32(entry.value, `parameters[${index}].value`) };
  });
  for (let i = 1; i < parameters.length; i++) {
    if ((parameters[i - 1]?.name ?? "") >= (parameters[i]?.name ?? "")) fail("parameters must be sorted by name without duplicates");
  }
  return { schemaVersion: PARAMETER_SET_SCHEMA_VERSION, source: validateSource(payload.source), parameters };
}

const WRITE_FIELDS: { readonly [kind in WriteState["kind"]]: readonly string[] } = {
  requested: ["attempts"],
  confirmed: ["value", "rebootRequired", "outsideRange"],
  refused: ["by", "reason", "reported"],
  timeout: ["attempts"],
  stale: ["reason", "reported"],
};
function nullableBoolean(value: unknown, where: string): boolean | null {
  if (value !== null && typeof value !== "boolean") fail(`${where} must be true, false or null`);
  return value;
}
function nullableFloat32(value: unknown, where: string): number | null {
  return value === null ? null : float32(value, where);
}
function validateOutcome(value: unknown, where: string): WriteState {
  if (!isObject(value)) return fail(`${where} must be an object`);
  const kind = value.kind;
  if (kind !== "requested" && kind !== "confirmed" && kind !== "refused" && kind !== "timeout" && kind !== "stale") return fail(`${where}.kind is not a write state`);
  keys(value, ["kind", "id", "name", "requested", ...WRITE_FIELDS[kind]], where);
  const base = { id: count(value.id, `${where}.id`), name: name(value.name, `${where}.name`), requested: float32(value.requested, `${where}.requested`) };
  switch (kind) {
    case "requested": case "timeout": return { ...base, kind, attempts: count(value.attempts, `${where}.attempts`) };
    case "confirmed":
      return { ...base, kind, value: float32(value.value, `${where}.value`), rebootRequired: nullableBoolean(value.rebootRequired, `${where}.rebootRequired`),
        outsideRange: nullableBoolean(value.outsideRange, `${where}.outsideRange`) };
    case "refused":
      if (value.by !== "service" && value.by !== "autopilot") fail(`${where}.by must be service or autopilot`);
      return { ...base, kind, by: value.by, reason: text(value.reason, `${where}.reason`), reported: nullableFloat32(value.reported, `${where}.reported`) };
    case "stale": return { ...base, kind, reason: text(value.reason, `${where}.reason`), reported: nullableFloat32(value.reported, `${where}.reported`) };
    default: { const never: never = kind; return never; }
  }
}

/** Validates a `parameter-log` payload from unknown; throws with the first reason. */
export function validateParameterLog(payload: unknown): ParameterLog {
  if (!isObject(payload)) return fail("a parameter log must be an object");
  keys(payload, ["schemaVersion", "experimentId", "experimentSha256", "changes"], "the parameter log");
  if (payload.schemaVersion !== PARAMETER_LOG_SCHEMA_VERSION) fail(`schemaVersion must be ${PARAMETER_LOG_SCHEMA_VERSION}`);
  const experimentId = text(payload.experimentId, "experimentId");
  const list = payload.changes;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_LOG_CHANGES) fail(`changes must hold 1 to ${MAX_LOG_CHANGES} entries`);
  const entries: readonly unknown[] = list;
  const changes = entries.map((entry, index): ParameterChange => {
    const where = `changes[${index}]`;
    if (!isObject(entry)) return fail(`${where} must be an object`);
    keys(entry, ["writeId", "name", "oldValue", "newValue", "requestedAt", "tick", "simTimeS", "experimentId", "whilePaused", "outcome"], where);
    const requestedAt = text(entry.requestedAt, `${where}.requestedAt`, TIMESTAMP);
    if (new Date(Date.parse(requestedAt)).toISOString() !== requestedAt) fail(`${where}.requestedAt is not an existing UTC time`);
    if (typeof entry.whilePaused !== "boolean") fail(`${where}.whilePaused must be true or false`);
    const change: ParameterChange = { writeId: count(entry.writeId, `${where}.writeId`), name: name(entry.name, `${where}.name`),
      oldValue: nullableFloat32(entry.oldValue, `${where}.oldValue`), newValue: float32(entry.newValue, `${where}.newValue`), requestedAt,
      tick: count(entry.tick, `${where}.tick`), simTimeS: finite(entry.simTimeS, `${where}.simTimeS`), experimentId: text(entry.experimentId, `${where}.experimentId`),
      whilePaused: entry.whilePaused, outcome: validateOutcome(entry.outcome, `${where}.outcome`) };
    if (change.experimentId !== experimentId) fail(`${where} belongs to another experiment`);
    if (change.outcome.id !== change.writeId || change.outcome.name !== change.name || change.outcome.requested !== change.newValue) {
      fail(`${where}.outcome is not the outcome of this change`);
    }
    return change;
  });
  for (let i = 1; i < changes.length; i++) if ((changes[i - 1]?.writeId ?? 0) >= (changes[i]?.writeId ?? 0)) fail("changes must be in write order");
  return { schemaVersion: PARAMETER_LOG_SCHEMA_VERSION, experimentId, experimentSha256: text(payload.experimentSha256, "experimentSha256", SHA256_HEX), changes };
}

export function readParameterSet(stored: StoredVersion): ParameterSet {
  if (stored.record.kind !== "parameter-set") fail(`record ${stored.sha256} is not a parameter set`);
  return validateParameterSet(stored.record.payload);
}
export function readParameterLog(stored: StoredVersion): ParameterLog {
  if (stored.record.kind !== "parameter-log") fail(`record ${stored.sha256} is not a parameter log`);
  return validateParameterLog(stored.record.payload);
}

/** The values of a downloaded list, by name. */
export function snapshotOf(list: readonly ParameterValue[]): ParameterEntry[] {
  return list.map(({ name: entry, value }) => ({ name: entry, value })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Stores a new parameter set, or a new version of `previous` (its item ID and head). */
export async function saveParameterSet(store: ProjectStore, projectId: string, setName: string, set: ParameterSet,
  previous: { readonly id: string; readonly head: string } | null = null): Promise<StoredVersion> {
  const payload = validateParameterSet(set);
  const draft = { name: setName, payload, dependencies: [payload.source.experimentSha256] };
  return previous ? store.saveVersion(previous.id, previous.head, draft) : store.createItem(projectId, "parameter-set", draft);
}
/** Stores the change log of a run: its first version, or the next one after `previous`. */
export async function saveParameterLog(store: ProjectStore, projectId: string, log: ParameterLog,
  previous: { readonly id: string; readonly head: string } | null): Promise<StoredVersion> {
  const payload = validateParameterLog(log);
  const draft = { name: `Parameter changes of ${payload.experimentId}`, payload, dependencies: [payload.experimentSha256] };
  return previous ? store.saveVersion(previous.id, previous.head, draft) : store.createItem(projectId, "parameter-log", draft);
}

/** One parameter whose values differ between two lists; null where a list lacks it. */
export interface ParameterDifference { readonly name: string; readonly a: number | null; readonly b: number | null }
/** Every parameter whose value differs between `a` and `b`, or that only one holds, by name. */
export function compareParameters(a: readonly ParameterEntry[], b: readonly ParameterEntry[]): ParameterDifference[] {
  const left = new Map(a.map(entry => [entry.name, entry.value])), right = new Map(b.map(entry => [entry.name, entry.value]));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  return names.flatMap(entry => {
    const x = left.get(entry) ?? null, y = right.get(entry) ?? null;
    return x === y ? [] : [{ name: entry, a: x, b: y }];
  });
}

/** What sending a set's values back to the running SITL writes, and what it leaves out with the reason. */
export interface RestorePlan {
  readonly writes: readonly ParameterEntry[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}
/**
 * The writes that give the running SITL the set's values: one per parameter
 * whose live value differs. Parameters the SITL does not list, and those
 * ArduPilot's metadata marks read-only or changed by the autopilot itself,
 * are skipped with the reason; parameters the set does not hold are left alone.
 */
export function restorePlan(set: readonly ParameterEntry[], live: readonly ParameterValue[], metadata: ParameterMetadataSet | null): RestorePlan {
  const current = new Map(live.map(entry => [entry.name, entry.value]));
  const writes: ParameterEntry[] = [], skipped: { name: string; reason: string }[] = [];
  for (const entry of set) {
    const value = current.get(entry.name);
    if (value === undefined) { skipped.push({ name: entry.name, reason: "the running SITL has no parameter of this name" }); continue; }
    if (value === entry.value) continue;
    const facts = metadata?.get(entry.name);
    if (facts?.readOnly) skipped.push({ name: entry.name, reason: "read-only in ArduPilot's metadata" });
    else if (facts?.volatile) skipped.push({ name: entry.name, reason: "ArduPilot changes it itself" });
    else writes.push(entry);
  }
  return { writes, skipped };
}
