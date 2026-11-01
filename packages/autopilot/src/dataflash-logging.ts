// ArduPilot DataFlash logging of an experiment (TASK-164). Before SITL starts,
// the experiment's LOG_* parameters are checked against the metadata of the
// firmware's exact commit (TASK-159) and against what SITL and the launcher
// can do. After a run, each DataFlash file is classified from its own bytes,
// and the logging it actually ran with is read back from its PARM records
// and its firmware from its VER record, never assumed from the request.
// Cold path: launcher and tooling only.
import { columnText, readDataFlash, type DataFlashGroup, type DataFlashLog } from "@mirage/dataflash/reader";
import type { ParameterMetadataSet } from "./param-metadata.ts";

/** ArduPilot's logging parameters; LOG_BITMASK is ArduCopter's own and also starts with LOG_. */
export const LOGGING_PARAMETER = /^LOG_[A-Z0-9_]+$/;
/** LOG_BACKEND_TYPE bits (AP_Logger): File writes logs/NNNNNNNN.BIN, MAVLink streams to a ground station, Block needs flash SITL lacks. */
export const BackendBit = { File: 0, MAVLink: 1, Block: 2 } as const;

export interface LoggingParameter { readonly name: string; readonly value: number }

/**
 * Every reason the logging parameters of an experiment cannot be used, in the
 * given order; empty when they can. Parameters whose names are not LOG_* are ignored.
 */
export function checkLoggingParameters(parameters: readonly LoggingParameter[], metadata: ParameterMetadataSet | null): string[] {
  const logging = parameters.filter(parameter => LOGGING_PARAMETER.test(parameter.name));
  if (logging.length === 0) return [];
  if (!metadata) return ["MirageSITL has no parameter metadata for this firmware's commit, so its logging parameters cannot be checked"];
  const reasons: string[] = [];
  for (const { name, value } of logging) {
    const meta = metadata.get(name);
    if (!meta) { reasons.push(`${name} is not a parameter of ArduPilot ${metadata.commit.slice(0, 8)}`); continue; }
    if (!Number.isFinite(value)) { reasons.push(`${name} must be a finite number`); continue; }
    if (meta.values) {
      if (!meta.values.some(([allowed]) => allowed === value)) reasons.push(`${name} ${value} is not one of its values (${meta.values.map(([v, label]) => `${v} ${label}`).join(", ")})`);
    } else if (meta.bitmask) {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) { reasons.push(`${name} must be a whole bitmask`); continue; }
      const declared = new Set(meta.bitmask.map(([bit]) => bit));
      const extra: number[] = [];
      for (let bit = 0; bit < 32; bit++) if (Math.floor(value / 2 ** bit) % 2 === 1 && !declared.has(bit)) extra.push(bit);
      if (extra.length > 0) reasons.push(`${name} sets bits ${extra.join(", ")}, which ArduPilot does not declare`);
    }
    if (meta.range && (value < meta.range[0] || value > meta.range[1])) reasons.push(`${name} ${value} is outside its range ${meta.range[0]} to ${meta.range[1]}`);
    if (name === "LOG_BACKEND_TYPE" && Number.isInteger(value) && value >= 0) {
      if (Math.floor(value / 2 ** BackendBit.File) % 2 !== 1) reasons.push("LOG_BACKEND_TYPE must include the File backend (bit 0): the launcher collects the logs SITL writes to logs/");
      if (Math.floor(value / 2 ** BackendBit.Block) % 2 === 1) reasons.push("LOG_BACKEND_TYPE requests the Block backend (bit 2), which SITL does not have");
    }
  }
  return reasons;
}

export type LogStatus = "complete" | "truncated" | "damaged" | "empty";
export interface LogAssessment {
  readonly status: LogStatus;
  readonly records: number;
  /** Bytes after the last whole record when the status is truncated; 0 otherwise. */
  readonly truncatedBytes: number;
  /** Damaged ranges inside the file (skipped or bad-format), as [start, end) byte offsets. */
  readonly damaged: readonly { readonly start: number; readonly end: number; readonly kind: string }[];
  /** Firmware as the log's VER record states it, or null without one. */
  readonly firmware: { readonly version: string; readonly gitHash: string } | null;
  /** The last value each parameter had in the log's PARM records, as float32. */
  readonly parameters: ReadonlyMap<string, number>;
}

function group(log: DataFlashLog, name: string): DataFlashGroup | undefined {
  return log.groups.find(item => item.name === name && item.count > 0);
}
function column(group: DataFlashGroup, name: string) {
  return group.columns.find(item => item.name === name);
}

/** Classifies a DataFlash file from its bytes and reads its VER and PARM records. */
export function assessDataflash(bytes: Uint8Array): LogAssessment {
  if (bytes.length === 0) return { status: "empty", records: 0, truncatedBytes: 0, damaged: [], firmware: null, parameters: new Map() };
  const log = readDataFlash(bytes);
  const inside = log.damaged.filter(range => range.kind !== "truncated").map(range => ({ start: range.start, end: range.end, kind: range.kind }));
  const tail = log.damaged.find(range => range.kind === "truncated");
  const status: LogStatus = inside.length > 0 ? "damaged" : tail ? "truncated" : log.records === 0 ? "empty" : "complete";
  const parameters = new Map<string, number>();
  const parm = group(log, "PARM");
  const name = parm && column(parm, "Name"), value = parm && column(parm, "Value");
  if (parm && name && value) for (let row = 0; row < parm.count; row++) parameters.set(columnText(name, row), Number(value.values[row]));
  let firmware: LogAssessment["firmware"] = null;
  const ver = group(log, "VER");
  const fws = ver && column(ver, "FWS"), gh = ver && column(ver, "GH");
  if (ver && fws && gh) firmware = { version: columnText(fws, 0), gitHash: Number(gh.values[0]).toString(16).padStart(8, "0") };
  return { status, records: log.records, truncatedBytes: tail ? tail.end - tail.start : 0, damaged: inside, firmware, parameters };
}

export interface LoggingConfirmation {
  /** Every configured LOG_* parameter holds its float32 value in the log. */
  readonly confirmed: boolean;
  readonly checked: readonly { readonly name: string; readonly configured: number; readonly logged: number | null }[];
}
/** Compares the configured LOG_* parameters with the values the log recorded. */
export function confirmLogging(assessment: LogAssessment, configured: readonly LoggingParameter[]): LoggingConfirmation {
  const checked = configured.filter(parameter => LOGGING_PARAMETER.test(parameter.name))
    .map(parameter => ({ name: parameter.name, configured: parameter.value, logged: assessment.parameters.get(parameter.name) ?? null }));
  return { confirmed: checked.every(item => item.logged !== null && item.logged === Math.fround(item.configured)), checked };
}

/** True when a log's VER git hash is the first eight hex digits of `commit`. */
export function firmwareMatches(assessment: LogAssessment, commit: string): boolean {
  return assessment.firmware !== null && commit.startsWith(assessment.firmware.gitHash);
}
