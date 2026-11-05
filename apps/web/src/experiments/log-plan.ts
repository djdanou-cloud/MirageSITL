import type { ExtractionField, LogExtraction, LogParameter, SkippedParameter } from "@mirage/analysis/log-to-experiment";
import { canonicalBytes, type StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";

// What a run started from a log keeps of that log (TASK-182). The record says where the experiment came from and, field by field, what
// the log gave, what the user supplied and what was missing, so the Experiments tab can show it for as long as the experiment exists.

export const LOG_EXTRACTION_SCHEMA_VERSION = 1;
/** A run the wizard asked the Run tab to start. */
export interface LogPlan {
  readonly logSha256: string;
  readonly extraction: LogExtraction;
  /** The aircraft the user chose: a log never holds one. */
  readonly profileSha256: string;
  /** TASK-183: parameters the user changed for this run, on top of the log's. */
  readonly changes: readonly { readonly name: string; readonly value: number }[];
}
export interface LogExtractionRecord {
  readonly schemaVersion: typeof LOG_EXTRACTION_SCHEMA_VERSION;
  /** The run this log started; the record depends on it. */
  readonly experimentSha256: string;
  readonly log: { readonly name: string; readonly bytes: number; readonly sha256: string };
  readonly interval: { readonly fromS: number; readonly toS: number };
  readonly fields: readonly ExtractionField[];
  readonly parameters: readonly LogParameter[];
  readonly skipped: readonly SkippedParameter[];
  /** TASK-183: what the user changed for this run; absent from a record made before that. */
  readonly changes?: readonly { readonly name: string; readonly value: number }[];
}

const STATUSES: readonly string[] = ["extracted", "user-supplied", "missing"];
const GROUPS: readonly string[] = ["initial conditions", "parameters", "task and control", "weather", "aircraft"];
const fail = (message: string): never => { throw new Error(`Invalid log extraction: ${message}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (value: unknown, name: string): string => (typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : fail(`${name} is not a SHA-256`));
const text = (value: unknown, name: string): string => (typeof value === "string" && value.length <= 4096 ? value : fail(`${name} is not text`));
const finite = (value: unknown, name: string): number => (typeof value === "number" && Number.isFinite(value) ? value : fail(`${name} is not a finite number`));

export function validateLogExtraction(value: unknown): LogExtractionRecord {
  if (!isRecord(value) || value.schemaVersion !== LOG_EXTRACTION_SCHEMA_VERSION) return fail("schemaVersion must be 1");
  const { log, interval, fields, parameters, skipped } = value;
  if (!isRecord(log) || !isRecord(interval) || !Array.isArray(fields) || !Array.isArray(parameters) || !Array.isArray(skipped)) return fail("a section is missing");
  return {
    schemaVersion: LOG_EXTRACTION_SCHEMA_VERSION, experimentSha256: hash(value.experimentSha256, "experimentSha256"),
    log: { name: text(log.name, "log.name"), bytes: finite(log.bytes, "log.bytes"), sha256: hash(log.sha256, "log.sha256") },
    interval: { fromS: finite(interval.fromS, "interval.fromS"), toS: finite(interval.toS, "interval.toS") },
    fields: (fields as unknown[]).map((item, index): ExtractionField => {
      if (!isRecord(item) || !STATUSES.includes(String(item.status)) || !GROUPS.includes(String(item.group))) return fail(`fields[${index}]`);
      const value2 = item.value === null ? null : text(item.value, "value"), source = item.source === null ? null : text(item.source, "source");
      if ((item.status === "missing") !== (value2 === null) || (item.status === "missing") !== (source === null)) return fail(`fields[${index}] says ${String(item.status)} with value ${String(value2)}`);
      return { key: text(item.key, "key"), label: text(item.label, "label"), group: item.group as ExtractionField["group"], status: item.status as ExtractionField["status"], value: value2, source,
        ...(item.note === undefined ? {} : { note: text(item.note, "note") }) };
    }),
    parameters: (parameters as unknown[]).map((item, index): LogParameter => {
      if (!isRecord(item)) return fail(`parameters[${index}]`);
      return { name: text(item.name, "name"), value: finite(item.value, "value"), defaultValue: item.defaultValue === null ? null : finite(item.defaultValue, "defaultValue") };
    }),
    skipped: (skipped as unknown[]).map((item, index): SkippedParameter => {
      if (!isRecord(item)) return fail(`skipped[${index}]`);
      return { name: text(item.name, "name"), value: finite(item.value, "value"), why: text(item.why, "why") };
    }),
    ...(value.changes === undefined ? {} : { changes: (Array.isArray(value.changes) ? value.changes as unknown[] : fail("changes must be a list")).map((item, index) => {
      if (!isRecord(item)) return fail(`changes[${index}]`);
      return { name: text(item.name, "name"), value: finite(item.value, "value") };
    }) }),
  };
}
export const readLogExtraction = (stored: StoredVersion): LogExtractionRecord => validateLogExtraction(stored.record.payload);
/** What the Run tab says before it starts: the build it will fly is not chosen yet, so the settings it takes are at most these. */
export function logPlanText(extraction: LogExtraction, changes = 0): string {
  const place = extraction.home ? "its home" : "the Run tab's home, because the log does not give one";
  const changed = changes === 0 ? "" : `, with ${changes} ${changes === 1 ? "parameter" : "parameters"} you changed`;
  return `From ${extraction.name}: ${place} and up to ${extraction.parameters.length} of its settings${changed}, on the aircraft you chose. Your aircraft keeps its own settings, and the build you choose may lack some of the log's. It starts on the ground and its path is computed afresh, so this is an experiment like that flight and not a replay. List the builds, then start it.`;
}
const NOT_TAKEN = "The aircraft profile sets it for this run, or the chosen build has no such setting to write";
/** The record of a run the wizard started: `taken` names the settings the run really booted with, and the rest say why they did not go. */
export function logExtractionRecord(plan: LogPlan, experimentSha256: string, taken: ReadonlySet<string>): LogExtractionRecord {
  const { extraction } = plan;
  return { schemaVersion: LOG_EXTRACTION_SCHEMA_VERSION, experimentSha256, log: { name: extraction.name, bytes: extraction.bytes, sha256: plan.logSha256 }, interval: extraction.interval,
    fields: extraction.fields, parameters: extraction.parameters.filter(parameter => taken.has(parameter.name)), changes: plan.changes,
    skipped: [...extraction.skipped, ...extraction.parameters.filter(parameter => !taken.has(parameter.name)).map(parameter => ({ name: parameter.name, value: parameter.value, why: NOT_TAKEN }))] };
}
export function saveLogExtraction(store: ProjectStore, projectId: string, plan: LogPlan, experimentSha256: string, taken: ReadonlySet<string>): Promise<StoredVersion> {
  const { extraction } = plan;
  const payload = logExtractionRecord(plan, experimentSha256, taken);
  return store.createItem(projectId, "log-extraction", { name: `From ${extraction.name}`, payload: validateLogExtraction(JSON.parse(new TextDecoder().decode(canonicalBytes(payload))) as unknown), dependencies: [experimentSha256] });
}
