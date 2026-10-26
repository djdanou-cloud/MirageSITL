// Builds native ArduCopter SITL with the MirageSITL firmware patches (TASK-089)
// on Linux or inside WSL, where scripts/run-sitl.mjs runs. MIRAGE_SITL_SOURCE is
// the clean checkout at the pinned commit with its SITL submodules; it is never
// modified: the script copies it into <out>/source and patches only the copy.
// MIRAGE_ARDUPILOT_VENV optionally names the Python environment that waf needs.
// Missing prerequisites exit 2 (BLOCKED_EXTERNAL); a failed build or check exits 1.
//
//   node scripts/build-ardupilot-sitl.mjs --out ~/mirage/build-sitl-patched
//
// The binary is <out>/build/sitl/bin/arducopter. <out>/manifest.json records the
// commit, the patch and patched-file hashes from the catalog, and the binary hash.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Patches applied in this order; each must be in tests/fixtures/sitl/ardupilot-catalog.json. */
export const SITL_PATCH_IDS = ["imu-noise-floor"];

class Blocked extends Error {}

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 1 << 26, ...options });

export function buildSitl(env, out) {
  if (process.platform === "win32") throw new Blocked("Run inside Linux or WSL, like scripts/run-sitl.mjs");
  const source = env.MIRAGE_SITL_SOURCE;
  if (!source || !out) throw new Blocked("MIRAGE_SITL_SOURCE and --out are required");
  if (!existsSync(join(source, "waf"))) throw new Blocked("MIRAGE_SITL_SOURCE is not an ArduPilot checkout");
  const lock = JSON.parse(readFileSync(join(root, "scripts/sitl.lock.json"), "utf8"));
  const catalog = JSON.parse(readFileSync(join(root, "tests/fixtures/sitl/ardupilot-catalog.json"), "utf8"));
  if (catalog.schemaVersion !== 2 || catalog.ardupilotCommit !== lock.commit) throw new Error("Catalog does not describe the pinned SITL commit");
  if (run("git", ["-C", source, "rev-parse", "HEAD"]).trim() !== lock.commit ||
      run("git", ["-C", source, "status", "--porcelain", "--untracked-files=no"]).trim()) {
    throw new Error("MIRAGE_SITL_SOURCE is not the clean pinned commit");
  }
  const patches = SITL_PATCH_IDS.map((id) => {
    const patch = catalog.patches.find((entry) => entry.id === id);
    if (!patch) throw new Error(`Patch ${id} is not in the catalog; regenerate tests/fixtures/sitl/ardupilot-catalog.json`);
    if (sha(readFileSync(join(root, patch.path))) !== patch.sha256) throw new Error(`${patch.path} differs from the cataloged patch`);
    for (const file of patch.files) {
      if (sha(readFileSync(join(source, file.path))) !== file.upstreamSha256) throw new Error(`Pinned upstream bytes changed: ${file.path}`);
    }
    return patch;
  });
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error("Build output is not empty; select a new directory");
  const copy = join(out, "source"), build = join(out, "build"), log = join(out, "build.log");
  run("mkdir", ["-p", copy]);
  // A literal "/." copies the checkout contents; path.join would drop it.
  run("cp", ["-a", "--reflink=auto", `${source}/.`, `${copy}/`]);
  for (const patch of patches) {
    run("git", ["-C", copy, "apply", "--check", join(root, patch.path)]);
    run("git", ["-C", copy, "apply", join(root, patch.path)]);
    for (const file of patch.files) {
      if (sha(readFileSync(join(copy, file.path))) !== file.patchedSha256) throw new Error(`Patched bytes differ from the catalog: ${file.path}`);
    }
  }
  const python = env.MIRAGE_ARDUPILOT_VENV ? `. '${env.MIRAGE_ARDUPILOT_VENV.replace(/'/g, "'\\''")}/bin/activate' && ` : "";
  try {
    writeFileSync(log, run("/bin/bash", ["-c", `set -eu; ${python}{ ./waf configure --board sitl --out "$1" && ./waf --out "$1" copter; } 2>&1`,
      "build", build], { cwd: copy, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    writeFileSync(log, `${error.stdout ?? ""}${error.stderr ?? ""}`);
    throw new Error(`SITL build failed; see ${log}`, { cause: error });
  }
  const binaryPath = join(build, "sitl/bin/arducopter"), binary = readFileSync(binaryPath);
  if (binary.subarray(0, 4).toString("hex") !== "7f454c46") throw new Error("The build did not produce an ELF binary");
  // Each added parameter name is stored in the parameter table as a C string.
  for (const patch of patches) for (const parameter of patch.addedParameters) {
    if (!binary.includes(Buffer.from(parameter.name.slice("SIM_".length) + "\0"))) throw new Error(`${parameter.name} is absent from the binary`);
  }
  if (run("git", ["-C", source, "status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("MIRAGE_SITL_SOURCE changed during the build");
  const manifest = {
    schemaVersion: 1,
    commit: lock.commit,
    patches: patches.map((patch) => ({ id: patch.id, path: patch.path, sha256: patch.sha256, files: patch.files,
      addedParameters: patch.addedParameters.map((parameter) => ({ name: parameter.name, default: parameter.default })) })),
    binary: { path: binaryPath, sha256: sha(binary), bytes: binary.length },
    toolchain: { cxx: run("c++", ["--version"]).split("\n")[0], node: process.version },
    script: { path: "scripts/build-ardupilot-sitl.mjs", sha256: sha(readFileSync(fileURLToPath(import.meta.url))) },
  };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const at = process.argv.indexOf("--out"), value = at > 0 ? process.argv[at + 1] : undefined;
    const manifest = buildSitl(process.env, value ? resolve(value) : undefined);
    console.log(`Patched SITL built: ${manifest.binary.path}`);
    console.log(`export MIRAGE_SITL_BINARY=${manifest.binary.path}`);
    console.log(`export MIRAGE_SITL_BINARY_SHA256=${manifest.binary.sha256}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof Blocked ? 2 : 1;
  }
}
