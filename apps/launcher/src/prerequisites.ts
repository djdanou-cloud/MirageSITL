import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statfsSync } from "node:fs";
import { join, sep } from "node:path";
import { verifyEntry, readCatalog, type ExecutableAdmission, nativeAdmission } from "./catalog.ts";

// First-run and status prerequisite checks (TASK-151; the installation check is TASK-152).
// Each check returns a structured result with a fix instruction; none of
// them reaches the network or changes the machine.

export type CheckStatus = "ok" | "missing" | "failed";
export interface PrerequisiteResult {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What the user does to fix it; empty when ok. */
  readonly fix: string;
}
export interface PrerequisiteOptions {
  readonly home: string;
  /** Python of the installed environment with pymavlink. */
  readonly python: string;
  readonly admit?: ExecutableAdmission;
  readonly platform?: string;
  readonly architecture?: string;
  readonly nodeVersion?: string;
}
/** Phase 1 pins (PROJECT_SCOPE.md, TASK-127, TASK-042). */
export const REQUIRED_NODE_MAJOR = 24;
export const REQUIRED_PYMAVLINK = "2.4.50";
/** Free space below this cannot hold a long experiment's logs. */
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

function result(id: string, title: string, status: CheckStatus, detail: string, fix = ""): PrerequisiteResult {
  return { id, title, status, detail, fix: status === "ok" ? "" : fix };
}

export function checkPrerequisites(options: PrerequisiteOptions): PrerequisiteResult[] {
  const platform = options.platform ?? process.platform, architecture = options.architecture ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const checks: PrerequisiteResult[] = [];
  checks.push(platform === "darwin" && architecture === "arm64"
    ? result("platform", "macOS on Apple Silicon", "ok", `${platform} ${architecture}`)
    : result("platform", "macOS on Apple Silicon", "failed", `This machine is ${platform} ${architecture}`, "Phase 1 runs on macOS with an Apple Silicon processor."));
  const major = Number(nodeVersion.split(".")[0]);
  checks.push(major === REQUIRED_NODE_MAJOR
    ? result("node", `Node.js ${REQUIRED_NODE_MAJOR}`, "ok", `Node.js ${nodeVersion}`)
    : result("node", `Node.js ${REQUIRED_NODE_MAJOR}`, "failed", `Node.js ${nodeVersion}`, `Install Node.js ${REQUIRED_NODE_MAJOR} LTS (the repository's .nvmrc) and start the launcher with it.`));
  try {
    accessSync(options.home, constants.W_OK);
    const stats = statfsSync(options.home);
    const free = stats.bavail * stats.bsize;
    checks.push(free >= MIN_FREE_BYTES
      ? result("storage", "Writable launcher folder with free space", "ok", `${(free / 1024 ** 3).toFixed(1)} GiB free`)
      : result("storage", "Writable launcher folder with free space", "failed", `${(free / 1024 ** 3).toFixed(2)} GiB free`, `Free at least ${MIN_FREE_BYTES / 1024 ** 3} GiB on the disk that holds the launcher folder.`));
  } catch {
    checks.push(result("storage", "Writable launcher folder with free space", "missing", "The launcher folder cannot be written", "Create the launcher folder or set MIRAGE_LAUNCHER_HOME to a writable folder."));
  }
  const probe = spawnSync(options.python, ["-I", "-c", "import pymavlink; print(pymavlink.__version__)"], { encoding: "utf8", timeout: 20000 });
  const version = probe.status === 0 ? probe.stdout.trim() : null;
  checks.push(version === REQUIRED_PYMAVLINK
    ? result("pymavlink", `Python with pymavlink ${REQUIRED_PYMAVLINK}`, "ok", `pymavlink ${version}`)
    : result("pymavlink", `Python with pymavlink ${REQUIRED_PYMAVLINK}`, version === null ? "missing" : "failed",
      version === null ? "The Python environment or pymavlink is not installed" : `pymavlink ${version}`,
      `Run node scripts/install-macos.mjs, which creates the Python environment with pymavlink ${REQUIRED_PYMAVLINK}.`));
  checks.push(installationCheck(options.home));
  let entries;
  try {
    entries = readCatalog(options.home);
  } catch (error) {
    checks.push(result("firmware", "A compatible ArduPilot SITL build", "failed", error instanceof Error ? error.message : String(error), "Repair the catalog by running node scripts/install-macos.mjs again."));
    return checks;
  }
  const statuses = entries.map(entry => verifyEntry(entry, options.admit ?? nativeAdmission));
  const usable = statuses.filter(status => status.usable);
  if (usable.length > 0) {
    checks.push(result("firmware", "A compatible ArduPilot SITL build", "ok", usable.map(status => `${status.entry.id} (${status.entry.firmwareVersion})`).join(", ")));
  } else {
    const reasons = statuses.map(status => (status.usable ? "" : `${status.entry.id}: ${status.reason}`)).filter(Boolean);
    checks.push(result("firmware", "A compatible ArduPilot SITL build", entries.length === 0 ? "missing" : "failed",
      entries.length === 0 ? "No ArduPilot SITL build is installed" : reasons.join("; "),
      "Run node scripts/install-macos.mjs, which builds ArduPilot SITL at the supported commit and records it."));
  }
  return checks;
}

/** The install manifest exists and every file it recorded inside the launcher folder still has its SHA-256. */
function installationCheck(home: string): PrerequisiteResult {
  const title = "MirageSITL installation";
  const path = join(home, "install-manifest.json");
  const fix = "Run node scripts/install-macos.mjs with this launcher folder (docs/operations/install-macos.md).";
  if (!existsSync(path)) return result("installation", title, "missing", "This launcher folder has no installation", fix);
  let items: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    items = typeof parsed === "object" && parsed !== null && Reflect.get(parsed, "schemaVersion") === 1 ? Reflect.get(parsed, "items") : null;
  } catch {
    items = null;
  }
  if (!Array.isArray(items)) return result("installation", title, "failed", "install-manifest.json is damaged", fix);
  const list: readonly unknown[] = items;
  const changed: string[] = [];
  for (const item of list) {
    const id: unknown = typeof item === "object" && item !== null ? Reflect.get(item, "id") : null;
    const file: unknown = typeof item === "object" && item !== null ? Reflect.get(item, "path") : null;
    const sha: unknown = typeof item === "object" && item !== null ? Reflect.get(item, "sha256") : null;
    // Files outside the launcher folder (Node.js, the repository) change with ordinary updates; they are recorded, not checked.
    if (typeof file !== "string" || !file.startsWith(home + sep)) continue;
    if (!existsSync(file) || createHash("sha256").update(readFileSync(file)).digest("hex") !== sha) changed.push(String(id));
  }
  return changed.length === 0
    ? result("installation", title, "ok", `${list.length} items recorded`)
    : result("installation", title, "failed", `Changed or missing since installation: ${changed.join(", ")}`, fix);
}
