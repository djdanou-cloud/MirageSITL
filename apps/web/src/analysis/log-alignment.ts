import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";

// Aligning two logs (TASK-181, S14): two flights, or two intervals of one flight. Each log has its own clock, so comparing means saying which of its moments
// lines up with which, as a shift of the second. Pure arithmetic; the viewer draws what this says, and a comparison stores it. Cold path.

export const LOG_COMPARISON_SCHEMA_VERSION = 1;
export type CompareMode = "overlay" | "side-by-side";
/** A span of a log's own time, s. */
export interface LogInterval { readonly fromS: number; readonly toS: number }
export interface LogAlignment {
  readonly mode: CompareMode;
  /** What is shown of each log; null shows all of it. */
  readonly first: LogInterval | null;
  readonly second: LogInterval | null;
  /** Added to the second log's times, s. */
  readonly secondOffsetS: number;
}
export const NO_ALIGNMENT: LogAlignment = Object.freeze({ mode: "overlay", first: null, second: null, secondOffsetS: 0 });
/** What a saved comparison names of each log: a stored experiment, or a file by its name and hash. */
export interface ComparedLog { readonly name: string; readonly sha256: string; readonly experimentSha256: string | null }
export interface LogComparison {
  readonly schemaVersion: typeof LOG_COMPARISON_SCHEMA_VERSION;
  readonly first: ComparedLog;
  readonly second: ComparedLog;
  readonly alignment: LogAlignment;
}

/** The interval a form gives, or the reason it cannot be one; both fields empty is the whole log. */
export function intervalOf(fromText: string, toText: string): LogInterval | null | string {
  if (fromText.trim() === "" && toText.trim() === "") return null;
  const fromS = Number(fromText), toS = Number(toText);
  if (fromText.trim() === "" || toText.trim() === "" || !Number.isFinite(fromS) || !Number.isFinite(toS)) return "An interval needs both its start and its end, in seconds, or neither.";
  if (!(fromS < toS)) return "An interval must start before it ends.";
  return { fromS, toS };
}
/** The shift that starts the second interval where the first starts. Without an interval, a log starts at its own zero. */
export function alignStarts(first: LogInterval | null, second: LogInterval | null): number {
  return (first?.fromS ?? 0) - (second?.fromS ?? 0);
}
/** A second-log time on the plot, and a plot time back on the second log. */
export const plottedS = (alignment: LogAlignment, secondS: number): number => secondS + alignment.secondOffsetS;
export const secondS = (alignment: LogAlignment, plotted: number): number => plotted - alignment.secondOffsetS;
/** Where the second interval lies on the plot, and how much of it overlaps the first; null without both. */
export function overlapS(alignment: LogAlignment): number | null {
  const { first, second } = alignment;
  if (!first || !second) return null;
  return Math.max(0, Math.min(first.toS, plottedS(alignment, second.toS)) - Math.max(first.fromS, plottedS(alignment, second.fromS)));
}
/** The viewer's own form of an alignment, in milliseconds (patch 0004). */
export function viewerAlignment(alignment: LogAlignment) {
  const ms = (interval: LogInterval | null) => (interval ? [interval.fromS * 1000, interval.toS * 1000] : null);
  return { mode: alignment.mode, first: ms(alignment.first), second: ms(alignment.second), secondOffsetMs: alignment.secondOffsetS * 1000 };
}

const fail = (message: string): never => { throw new Error(`Invalid log comparison: ${message}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (value: unknown, label: string): string => (typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : fail(`${label} is not a SHA-256`));
function comparedLog(value: unknown, label: string): ComparedLog {
  if (!isRecord(value)) return fail(`${label} must be an object`);
  const { name, sha256, experimentSha256 } = value;
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return fail(`${label}.name must be text`);
  return { name, sha256: hash(sha256, `${label}.sha256`), experimentSha256: experimentSha256 === null ? null : hash(experimentSha256, `${label}.experimentSha256`) };
}
function interval(value: unknown, label: string): LogInterval | null {
  if (value === null) return null;
  if (!isRecord(value)) return fail(`${label} must be an interval or null`);
  const { fromS, toS } = value;
  if (typeof fromS !== "number" || typeof toS !== "number" || !Number.isFinite(fromS) || !Number.isFinite(toS) || !(fromS < toS)) return fail(`${label} must start before it ends`);
  return { fromS, toS };
}
export function validateLogComparison(value: unknown): LogComparison {
  if (!isRecord(value) || value.schemaVersion !== LOG_COMPARISON_SCHEMA_VERSION) return fail(`schemaVersion must be ${LOG_COMPARISON_SCHEMA_VERSION}`);
  const { alignment } = value;
  if (!isRecord(alignment)) return fail("alignment must be an object");
  const { mode, secondOffsetS } = alignment;
  if (mode !== "overlay" && mode !== "side-by-side") return fail("mode must be overlay or side-by-side");
  if (typeof secondOffsetS !== "number" || !Number.isFinite(secondOffsetS)) return fail("secondOffsetS must be a number");
  return { schemaVersion: LOG_COMPARISON_SCHEMA_VERSION, first: comparedLog(value.first, "first"), second: comparedLog(value.second, "second"),
    alignment: { mode, first: interval(alignment.first, "first interval"), second: interval(alignment.second, "second interval"), secondOffsetS } };
}
export const readLogComparison = (stored: StoredVersion): LogComparison => validateLogComparison(stored.record.payload);
/** A comparison as a project item, with the experiments it names as its dependencies; a new version keeps its name's item. */
export function saveLogComparison(store: ProjectStore, projectId: string, comparison: LogComparison): Promise<StoredVersion> {
  const payload = validateLogComparison(comparison);
  const dependencies = [...new Set([payload.first.experimentSha256, payload.second.experimentSha256].flatMap(sha => (sha === null ? [] : [sha])))].sort();
  return store.createItem(projectId, "log-comparison", { name: `${payload.first.name} and ${payload.second.name}`.slice(0, 128), payload, dependencies });
}
