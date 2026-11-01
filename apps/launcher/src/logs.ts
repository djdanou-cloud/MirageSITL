import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

// Diagnostics and DataFlash logs of an experiment (TASK-151). SITL writes
// DataFlash logs to logs/ under its working directory; the launcher lists and
// serves them by name only, never by a path a request supplies.

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
