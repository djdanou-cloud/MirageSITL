import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assessDataflash, confirmLogging, firmwareMatches, type LoggingConfirmation, type LoggingParameter, type LogStatus } from "../../../packages/autopilot/src/dataflash-logging.ts";

// Diagnostics and DataFlash logs of an experiment (TASK-151). SITL writes
// DataFlash logs to logs/ under its working directory; the launcher lists and
// serves them by name only, never by a path a request supplies. TASK-164: the
// launcher lists logs/ before each run, and when the run ends it attaches the
// files the run wrote (new or grown) to the experiment in dataflash.json:
// name, size, SHA-256, the classification of its bytes, the firmware its VER
// record names and the logging parameters its PARM records hold. A run that
// wrote no file is attached as missing; nothing is ever synthesized.

/** ArduPilot SITL DataFlash file names: logs/00000001.BIN and so on. */
export const DATAFLASH_NAME = /^[0-9]{1,8}\.BIN$/;
/** Largest diagnostic tail returned in one response. */
export const MAX_TAIL_BYTES = 64 * 1024;
/** Bytes read from the end of a log to find its last line for an exit reason. */
export const MAX_LAST_LINE_BYTES = 4 * 1024;

export interface DataflashFile {
  readonly name: string;
  readonly bytes: number;
}

/** The last `limit` bytes of a run's stdout or stderr, as text; "" when absent. */
export function tail(path: string, limit = MAX_TAIL_BYTES): string {
  if (!existsSync(path)) return "";
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size, length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The last non-empty line of a log, trimmed, from at most `limit` bytes at
 * its end; null when the file is absent or holds only blank lines. A line
 * longer than `limit` comes back as its final `limit` bytes.
 */
export function lastLine(path: string, limit = MAX_LAST_LINE_BYTES): string | null {
  const lines = tail(path, limit).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim() ?? "";
    if (line !== "") return line;
  }
  return null;
}

export function listDataflash(workDirectory: string): DataflashFile[] {
  const directory = join(workDirectory, "logs");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => DATAFLASH_NAME.test(name))
    .sort()
    .map(name => ({ name, bytes: statSync(join(directory, name)).size }));
}

/** The path of a listed DataFlash file, or null for any other name. */
export function dataflashPath(workDirectory: string, name: string): string | null {
  if (!DATAFLASH_NAME.test(name)) return null;
  const path = join(workDirectory, "logs", name);
  return existsSync(path) && statSync(path).isFile() ? path : null;
}

/** Size and modification time of one DataFlash file before a run. */
export interface DataflashStamp { readonly bytes: number; readonly modifiedMs: number }
/** Every DataFlash file in logs/ with its size and modification time, taken before a run starts. */
export function snapshotDataflash(workDirectory: string): ReadonlyMap<string, DataflashStamp> {
  return new Map(listDataflash(workDirectory).map(file => [file.name, { bytes: file.bytes, modifiedMs: statSync(join(workDirectory, "logs", file.name)).mtimeMs }]));
}

/** What the run was started with: the build's identity and the LOG_* parameters it was given. */
export interface ExpectedLogging {
  readonly firmwareVersion: string;
  readonly commit: string;
  readonly logging: readonly LoggingParameter[];
}
export interface DataflashAttachment {
  readonly run: number;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly status: LogStatus;
  readonly records: number;
  readonly truncatedBytes: number;
  readonly damaged: readonly { readonly start: number; readonly end: number; readonly kind: string }[];
  /** The firmware the log's VER record names, and whether its git hash is the build's commit; null without a VER record. */
  readonly firmware: { readonly version: string; readonly gitHash: string; readonly matchesBuild: boolean } | null;
  /** The configured LOG_* parameters against the values the log's PARM records hold. */
  readonly logging: LoggingConfirmation;
}
export interface MissingDataflash {
  readonly run: number;
  readonly name: null;
  readonly status: "missing";
  readonly reason: string;
}
export type DataflashCapture = DataflashAttachment | MissingDataflash;
export const DATAFLASH_MANIFEST = "dataflash.json";

/**
 * Attaches the DataFlash files run `run` wrote: those new since `before`, or
 * changed in size or modification time. Cold; reads and hashes each file.
 */
export function captureDataflash(workDirectory: string, run: number, before: ReadonlyMap<string, DataflashStamp>, expected: ExpectedLogging): DataflashCapture[] {
  const written = listDataflash(workDirectory).filter(file => {
    const stamp = before.get(file.name);
    return stamp === undefined || stamp.bytes !== file.bytes || stamp.modifiedMs !== statSync(join(workDirectory, "logs", file.name)).mtimeMs;
  });
  if (written.length === 0) return [{ run, name: null, status: "missing", reason: "The run wrote no DataFlash file to logs/" }];
  return written.map((file): DataflashCapture => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(workDirectory, "logs", file.name));
    } catch (error) {
      return { run, name: null, status: "missing", reason: `${file.name} could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    const assessment = assessDataflash(bytes);
    return {
      run, name: file.name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), status: assessment.status,
      records: assessment.records, truncatedBytes: assessment.truncatedBytes, damaged: assessment.damaged,
      firmware: assessment.firmware ? { ...assessment.firmware, matchesBuild: firmwareMatches(assessment, expected.commit) } : null,
      logging: confirmLogging(assessment, expected.logging),
    };
  });
}

export interface DataflashManifest {
  readonly schemaVersion: 1;
  readonly experimentId: string;
  readonly firmwareVersion: string;
  readonly commit: string;
  readonly captures: readonly DataflashCapture[];
}
/**
 * Writes the experiment's attachments, every run so far, to dataflash.json
 * through a temporary file and a rename, so a reader never sees half a file.
 */
export function writeDataflashManifest(workDirectory: string, experimentId: string, expected: ExpectedLogging, captures: readonly DataflashCapture[]): DataflashManifest {
  const manifest: DataflashManifest = { schemaVersion: 1, experimentId, firmwareVersion: expected.firmwareVersion, commit: expected.commit, captures };
  const path = join(workDirectory, DATAFLASH_MANIFEST), temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return manifest;
}
