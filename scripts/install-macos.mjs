// MirageSITL installation on macOS Apple Silicon (TASK-152, S01/S02).
//
//   node scripts/install-macos.mjs [--home DIR] [--jobs N] [--plan]
//
// Installs into the launcher home (default ~/Library/Application Support/
// MirageSITL/launcher), the folder `npm run start -w @mirage/launcher` uses:
//   1. host checks: macOS on Apple Silicon, Node.js 24, Xcode command line
//      tools, git and Python 3;
//   2. venv/: Python packages from scripts/install/requirements-macos.txt,
//      installed with --require-hashes, so only the pinned files install;
//   3. sources/ardupilot: ArduPilot at the commit in scripts/sitl.lock.json
//      with the submodules the SITL build needs (git checks every object's hash);
//   4. build/: native ArduCopter SITL built with waf, admitted as a host
//      Mach-O64 executable and recorded in catalog.json with its SHA-256;
//   5. sources/uavlogviewer: UAVLogViewer at the commit, parser submodule and
//      LICENSE hash of third_party/uavlogviewer/source.lock.json; the offline
//      bundle itself is built by TASK-179;
//   6. install-manifest.json: every installed item with its SHA-256, size and
//      license from config/offline-inventory.json.
// Every step is checked again on a rerun and skipped when already correct, so
// the installer resumes after an interruption. Only steps 2, 3 and 5 use the
// network; afterwards the launcher and SITL run offline. --plan prints the
// steps without changing anything. Exit 0 installed, 1 failed, 2 a missing
// host prerequisite (BLOCKED_EXTERNAL).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, cpus, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_NODE_MAJOR, hostChecks, manifestItem, parseInstallManifest } from "./install/install-rules.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const ARDUPILOT_REPOSITORY = "https://github.com/ArduPilot/ardupilot.git";
/** Submodules the SITL build initializes (TASK-127 build manifest); others stay uninitialized. */
export const ARDUPILOT_SUBMODULES = [
  "modules/DroneCAN/DSDL", "modules/DroneCAN/dronecan_dsdlc", "modules/DroneCAN/libcanard", "modules/DroneCAN/pydronecan",
  "modules/gsoap", "modules/gtest", "modules/littlefs", "modules/lwip", "modules/mavlink", "modules/waf",
];

class Blocked extends Error {}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileIdentity = (path) => ({ sha256: sha256(readFileSync(path)), bytes: statSync(path).size });

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"], ...options });
}
function probe(command, args) {
  try {
    return run(command, args).trim();
  } catch {
    return null;
  }
}
function log(message) {
  process.stdout.write(`${message}\n`);
}

function ensureCheckout(directory, repository, commit, submodules) {
  if (!existsSync(join(directory, ".git"))) {
    mkdirSync(directory, { recursive: true });
    run("git", ["init", "-q", directory]);
    run("git", ["-C", directory, "remote", "add", "origin", repository]);
  }
  if (probe("git", ["-C", directory, "rev-parse", "HEAD"]) !== commit) {
    log(`  fetching ${repository} at ${commit}`);
    run("git", ["-C", directory, "fetch", "-q", "--depth", "1", "origin", commit], { stdio: "inherit" });
    run("git", ["-C", directory, "checkout", "-q", "--detach", commit]);
  }
  if (submodules.length > 0) {
    log(`  submodules: ${submodules.length}`);
    run("git", ["-C", directory, "submodule", "update", "--init", "--recursive", "--depth", "1", "--", ...submodules], { stdio: "inherit" });
  }
  if (run("git", ["-C", directory, "rev-parse", "HEAD"]).trim() !== commit) throw new Error(`${directory} is not at ${commit}`);
  if (run("git", ["-C", directory, "status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error(`${directory} has local changes`);
}

export async function install({ home, jobs, plan }) {
  const lock = JSON.parse(readFileSync(join(root, "scripts/sitl.lock.json"), "utf8"));
  const viewerLock = JSON.parse(readFileSync(join(root, "third_party/uavlogviewer/source.lock.json"), "utf8"));
  const inventory = JSON.parse(readFileSync(join(root, "config/offline-inventory.json"), "utf8"));
  const requirements = join(root, "scripts/install/requirements-macos.txt");
  const paths = {
    venv: join(home, "venv"), python: join(home, "venv/bin/python"), ardupilot: join(home, "sources/ardupilot"),
    build: join(home, "build"), viewer: join(home, "sources/uavlogviewer"), manifest: join(home, "install-manifest.json"),
  };
  const steps = [
    `1. Check the host: macOS on Apple Silicon, Node.js ${REQUIRED_NODE_MAJOR}, Xcode command line tools, git, Python 3`,
    `2. Python environment ${paths.venv} with the hash-pinned packages of scripts/install/requirements-macos.txt`,
    `3. ArduPilot ${lock.commit} with ${ARDUPILOT_SUBMODULES.length} submodules in ${paths.ardupilot}`,
    `4. Build native ArduCopter SITL in ${paths.build} and record it in ${join(home, "catalog.json")}`,
    `5. UAVLogViewer ${viewerLock.commit} with its parser submodule in ${paths.viewer}`,
    `6. Write ${paths.manifest}`,
  ];
  if (plan) {
    for (const step of steps) log(step);
    return { status: "PLAN" };
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  log(steps[0]);
  const checks = hostChecks({ platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, probe });
  for (const check of checks) log(`  ${check.ok ? "ok" : "MISSING"} ${check.id}: ${check.detail}${check.ok ? "" : ` — ${check.fix}`}`);
  if (checks.some((check) => !check.ok)) throw new Blocked("Host prerequisites are missing");

  log(steps[1]);
  if (!existsSync(paths.python)) run("python3", ["-m", "venv", paths.venv]);
  run(paths.python, ["-I", "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-build-isolation", "--require-hashes", "-r", requirements], { stdio: "inherit" });
  const freeze = run(paths.python, ["-I", "-m", "pip", "freeze", "--all"]);
  const pymavlink = run(paths.python, ["-I", "-c", "import pymavlink; print(pymavlink.__version__)"]).trim();
  if (pymavlink !== "2.4.50") throw new Error(`pymavlink ${pymavlink} installed, 2.4.50 required`);

  log(steps[2]);
  ensureCheckout(paths.ardupilot, ARDUPILOT_REPOSITORY, lock.commit, ARDUPILOT_SUBMODULES);
  const submoduleStatus = run("git", ["-C", paths.ardupilot, "submodule", "status", "--recursive"]).trim().split("\n");

  log(steps[3]);
  const binary = join(paths.build, "sitl/bin/arducopter");
  const env = { ...process.env, PATH: `${join(paths.venv, "bin")}:${process.env.PATH}` };
  if (!existsSync(binary)) {
    run(paths.python, ["waf", "configure", "--board", "sitl", "--out", paths.build], { cwd: paths.ardupilot, env, stdio: "inherit" });
    run(paths.python, ["waf", "--out", paths.build, "copter", "-j", String(jobs)], { cwd: paths.ardupilot, env, stdio: "inherit" });
  }
  const { readNativeExecutable } = await import("./sitl/native-binary.ts");
  const { identity } = readNativeExecutable(binary);
  const { writeCatalogEntry } = await import("../apps/launcher/src/catalog.ts");
  const version = /#define THISFIRMWARE "([^"]+)"/.exec(readFileSync(join(paths.ardupilot, "ArduCopter/version.h"), "utf8"))?.[1];
  if (!version) throw new Error("ArduCopter/version.h has no THISFIRMWARE");
  const defaults = join(paths.ardupilot, "Tools/autotest/default_params/copter.parm");
  const binaryFile = fileIdentity(binary), defaultsFile = fileIdentity(defaults);
  const firmwareId = `arducopter-${lock.commit.slice(0, 8)}`;
  writeCatalogEntry(home, {
    id: firmwareId, firmwareVersion: version, commit: lock.commit, binaryPath: binary, binarySha256: binaryFile.sha256,
    defaultParametersPath: defaults, defaultParametersSha256: defaultsFile.sha256,
  });

  log(steps[4]);
  ensureCheckout(paths.viewer, viewerLock.repository.endsWith(".git") ? viewerLock.repository : `${viewerLock.repository}.git`, viewerLock.commit, viewerLock.submodules.map((entry) => entry.path));
  for (const submodule of viewerLock.submodules) {
    if (run("git", ["-C", join(paths.viewer, submodule.path), "rev-parse", "HEAD"]).trim() !== submodule.commit) throw new Error(`${submodule.path} is not at ${submodule.commit}`);
  }
  const viewerLicense = fileIdentity(join(paths.viewer, viewerLock.license.file));
  if (viewerLicense.sha256 !== viewerLock.license.sha256) throw new Error("UAVLogViewer LICENSE hash differs from its source lock");

  log(steps[5]);
  const repositoryCommit = probe("git", ["-C", root, "rev-parse", "HEAD"]);
  const items = [
    manifestItem(inventory, "web-application", { id: "mirage-sitl", version: repositoryCommit ?? "unknown", path: join(root, "package-lock.json"), ...fileIdentity(join(root, "package-lock.json")) }),
    manifestItem(inventory, "node-runtime", { id: "node", version: process.version, path: process.execPath, ...fileIdentity(process.execPath) }),
    manifestItem(inventory, "pymavlink", { id: "python-environment", version: `pymavlink ${pymavlink}`, path: requirements, ...fileIdentity(requirements), packages: freeze.trim().split("\n") }),
    manifestItem(inventory, "ardupilot-source", { id: "ardupilot-source", version: lock.commit, repository: ARDUPILOT_REPOSITORY, submodules: submoduleStatus }),
    manifestItem(inventory, "ardupilot-source", { id: firmwareId, version, path: binary, ...binaryFile, format: identity.format, architecture: identity.architecture }),
    manifestItem(inventory, "ardupilot-source", { id: "copter-default-parameters", version: lock.commit, path: defaults, ...defaultsFile }),
    manifestItem(inventory, "uavlogviewer", { id: "uavlogviewer-source", version: viewerLock.commit, path: join(paths.viewer, viewerLock.license.file), ...viewerLicense, bundle: "built by TASK-179" }),
  ];
  const manifest = parseInstallManifest({
    schemaVersion: 1, createdAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, osRelease: release(), macOS: probe("sw_vers", ["-productVersion"]), cpu: cpus()[0]?.model ?? "unknown" },
    items,
  });
  const temporary = `${paths.manifest}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.manifest);
  log(`Installed. Start the launcher with: npm run start -w @mirage/launcher (home ${home})`);
  return { status: "PASS", manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const home = resolve(value("--home") ?? process.env.MIRAGE_LAUNCHER_HOME ?? join(homedir(), "Library", "Application Support", "MirageSITL", "launcher"));
  const jobs = Number(value("--jobs") ?? Math.max(1, cpus().length));
  try {
    await install({ home, jobs, plan: args.includes("--plan") });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof Blocked ? 2 : 1;
  }
}
