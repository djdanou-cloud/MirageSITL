import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readNativeExecutable } from "../../../scripts/sitl/native-binary.ts";
import sitlLock from "../../../scripts/sitl.lock.json" with { type: "json" };

// Catalog of installed ArduPilot SITL builds (TASK-151). The launcher starts
// only an entry whose executable and default parameter file still have the
// recorded SHA-256, whose executable is a host-native Mach-O64/ELF64 image,
// and whose source commit is one MirageSITL supports. The catalog lives in
// the launcher home as catalog.json; installation (TASK-152) writes it.

/** Source commits whose SITL behaviour MirageSITL has verified (TASK-127/128). */
export const COMPATIBLE_COMMITS: readonly string[] = [sitlLock.commit];
export interface FirmwareEntry {
  /** Stable ID, chosen at installation. */
  readonly id: string;
  /** For example "ArduCopter V4.8.0-dev". */
  readonly firmwareVersion: string;
  readonly commit: string;
  readonly binaryPath: string;
  readonly binarySha256: string;
  /** ArduPilot's Tools/autotest/default_params/copter.parm of the same source. */
  readonly defaultParametersPath: string;
  readonly defaultParametersSha256: string;
}
export type FirmwareStatus =
  | { readonly entry: FirmwareEntry; readonly usable: true }
  | { readonly entry: FirmwareEntry; readonly usable: false; readonly reason: string };
/** Admits an executable or throws; the default is the native Mach-O64/ELF64 admission. */
export type ExecutableAdmission = (path: string) => Buffer;
export const nativeAdmission: ExecutableAdmission = path => readNativeExecutable(path).bytes;

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const CATALOG_KEYS = ["binaryPath", "binarySha256", "commit", "defaultParametersPath", "defaultParametersSha256", "firmwareVersion", "id"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Validates catalog.json from `unknown`. */
export function parseCatalog(input: unknown): FirmwareEntry[] {
  if (!isRecord(input) || input.schemaVersion !== 1 || !Array.isArray(input.firmware)) throw new Error("Invalid firmware catalog: schema 1 with a firmware list expected");
  const list: readonly unknown[] = input.firmware;
  const ids = new Set<string>();
  return list.map((item, index) => {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== CATALOG_KEYS.join(",")) throw new Error(`Invalid firmware catalog entry ${index + 1}`);
    const { id, firmwareVersion, commit, binaryPath, binarySha256, defaultParametersPath, defaultParametersSha256 } = item;
    if (typeof id !== "string" || !ID.test(id) || ids.has(id)) throw new Error(`Invalid or repeated firmware ID in entry ${index + 1}`);
    ids.add(id);
    if (typeof firmwareVersion !== "string" || firmwareVersion === "" || typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) ||
      typeof binaryPath !== "string" || !isAbsolute(binaryPath) || typeof defaultParametersPath !== "string" || !isAbsolute(defaultParametersPath) ||
      typeof binarySha256 !== "string" || !HEX64.test(binarySha256) || typeof defaultParametersSha256 !== "string" || !HEX64.test(defaultParametersSha256)) {
      throw new Error(`Invalid firmware catalog entry ${id}`);
    }
    return { id, firmwareVersion, commit, binaryPath, binarySha256, defaultParametersPath, defaultParametersSha256 };
  });
}

export function catalogPath(home: string): string {
  return join(home, "catalog.json");
}
/** The catalog of a launcher home; an absent file is an empty catalog. */
export function readCatalog(home: string): FirmwareEntry[] {
  const path = catalogPath(home);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseCatalog(parsed);
}
/** Adds or replaces one entry, writing atomically. Cold; used by installation. */
export function writeCatalogEntry(home: string, entry: FirmwareEntry): void {
  const entries = parseCatalog({ schemaVersion: 1, firmware: [...readCatalog(home).filter(item => item.id !== entry.id), entry] });
  const path = catalogPath(home), temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, firmware: entries }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Rechecks an entry: compatible commit, unchanged files, admitted executable. */
export function verifyEntry(entry: FirmwareEntry, admit: ExecutableAdmission = nativeAdmission): FirmwareStatus {
  if (!COMPATIBLE_COMMITS.includes(entry.commit)) return { entry, usable: false, reason: `Source commit ${entry.commit} is not a commit MirageSITL supports (${COMPATIBLE_COMMITS.join(", ")})` };
  let binary: Buffer;
  try {
    binary = admit(entry.binaryPath);
  } catch (error) {
    return { entry, usable: false, reason: `Executable not admitted: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (sha256(binary) !== entry.binarySha256) return { entry, usable: false, reason: "The executable changed since installation (SHA-256 mismatch)" };
  try {
    if (sha256(readFileSync(entry.defaultParametersPath)) !== entry.defaultParametersSha256) return { entry, usable: false, reason: "The default parameter file changed since installation (SHA-256 mismatch)" };
  } catch {
    return { entry, usable: false, reason: "The default parameter file is missing" };
  }
  return { entry, usable: true };
}
