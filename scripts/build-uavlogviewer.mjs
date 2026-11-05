// TASK-179 offline UAVLogViewer bundle (S14).
//
//   node scripts/build-uavlogviewer.mjs [--source DIR] [--out DIR] [--work DIR]
//
// 1. Checks that --source (default <launcher home>/sources/uavlogviewer, the
//    TASK-152 checkout) is the commit, parser submodule, LICENSE and lockfile of
//    third_party/uavlogviewer/source.lock.json.
// 2. Copies it into --work (default <launcher home>/work/uavlogviewer, recreated
//    on every run) and applies third_party/uavlogviewer/patches/*.patch in order.
// 3. Installs the locked npm dependencies (npm verifies every integrity hash),
//    applies the upstream postinstall patches and builds with an empty Cesium
//    token, the upstream commit and SOURCE_DATE_EPOCH set to the commit time, so
//    a rebuild of the same inputs gives the same files.
// 4. Writes the build to --out (default <launcher home>/uavlogviewer) with
//    licenses/ (the GPL-3.0 texts, the patches and the notices of every
//    production npm package) and build-manifest.json (inputs, patch hashes,
//    toolchain and the output digest).
//
// Only step 3 uses the network (the npm registry). The built viewer runs offline.
// Exit 0 built, 1 failed, 2 missing input (BLOCKED_EXTERNAL).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_MANIFEST, PATCH_DIRECTORY, checkSource, patchSeries, readLock, treeDigest, treeFiles } from "./uavlogviewer/build-rules.ts";

class Blocked extends Error {}
const git = (directory, ...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

/** Notices of every production package in the installed tree (dev-only packages are not bundled). */
function thirdPartyNotices(work) {
  const lock = JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8"));
  const entries = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "" || entry.dev === true || entry.extraneous === true || !path.startsWith("node_modules/")) continue;
    const directory = join(work, path);
    if (!existsSync(directory)) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const licenseFile = readdirSync(directory).find((file) => /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i.test(file));
    let declared = entry.license ?? null;
    if (declared === null) {
      try { declared = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).license ?? null; } catch { declared = null; }
    }
    entries.push({ name, version: entry.version ?? null, license: typeof declared === "string" ? declared : null,
      text: licenseFile ? readFileSync(join(directory, licenseFile), "utf8") : null });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  const text = entries.map((entry) => [
    `${"=".repeat(78)}\n${entry.name} ${entry.version ?? ""}\nDeclared license: ${entry.license ?? "none declared"}\n${"-".repeat(78)}`,
    entry.text ?? "(the package ships no license file)",
  ].join("\n")).join("\n\n") + "\n";
  return { text, list: entries.map(({ name, version, license, text: body }) => ({ name, version, license, licenseFile: body !== null })) };
}

export function build({ source, out, work }) {
  const lock = readLock();
  if (!existsSync(join(source, ".git"))) throw new Blocked(`No UAVLogViewer checkout at ${source}; run node scripts/install-macos.mjs first`);
  const failures = checkSource(lock, source);
  if (failures.length) throw new Error(`The checkout differs from the source lock: ${failures.join("; ")}`);
  const patches = patchSeries();
  if (patches.length === 0) throw new Error("No patches in third_party/uavlogviewer/patches");
  const commitEpoch = git(source, "log", "-1", "--format=%ct");

  process.stdout.write(`Staging ${lock.commit} in ${work}\n`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  cpSync(source, work, { recursive: true, filter: (path) => !/(^|[\\/])(\.git|node_modules|dist)$/.test(path) });
  // The work copy becomes its own repository, so `git apply` patches it and no enclosing checkout.
  run("git", ["init", "-q", work]);
  for (const patch of patches) {
    process.stdout.write(`Applying ${patch.file}\n`);
    run("git", ["-C", work, "apply", "--whitespace=nowarn", join(PATCH_DIRECTORY, patch.file)]);
  }

  const env = { ...process.env, VUE_APP_CESIUM_TOKEN: "", UAVLOGVIEWER_COMMIT: lock.commit, SOURCE_DATE_EPOCH: commitEpoch };
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, env });
  run("npx", ["--no-install", "patch-package"], { cwd: work, env });
  run("npm", ["run", "build"], { cwd: work, env });

  const staged = `${out}.tmp`;
  rmSync(staged, { recursive: true, force: true });
  cpSync(join(work, "dist"), staged, { recursive: true });
  const licenses = join(staged, "licenses");
  mkdirSync(join(licenses, "patches"), { recursive: true });
  cpSync(join(work, lock.license.file), join(licenses, "UAVLogViewer-LICENSE.txt"));
  for (const module of lock.submodules) cpSync(join(work, module.path, "LICENSE"), join(licenses, `${basename(module.path)}-LICENSE.txt`));
  for (const patch of patches) cpSync(join(PATCH_DIRECTORY, patch.file), join(licenses, "patches", patch.file));
  const notices = thirdPartyNotices(work);
  writeFileSync(join(licenses, "THIRD-PARTY-NOTICES.txt"), notices.text);
  writeFileSync(join(licenses, "README.txt"), [
    "UAVLogViewer, built by MirageSITL for offline use.",
    `Upstream: ${lock.repository} at ${lock.commit}, licensed under the GNU General Public License version 3`,
    "(UAVLogViewer-LICENSE.txt). The MirageSITL changes are the patches in patches/, applied in name order;",
    "together with the upstream commit they are the complete corresponding source of this build.",
    "THIRD-PARTY-NOTICES.txt holds the license of every production npm package installed for the build.",
    "",
  ].join("\n"));

  const files = treeFiles(staged);
  const manifest = {
    schemaVersion: 1,
    task: "TASK-179",
    repository: lock.repository,
    commit: lock.commit,
    submodules: lock.submodules,
    license: lock.license,
    packageLockSha256: lock.packageLockSha256,
    patches,
    sourceDateEpoch: Number(commitEpoch),
    toolchain: { node: process.version, npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(), platform: process.platform, arch: process.arch },
    thirdPartyPackages: notices.list.length,
    outputs: treeDigest(files),
  };
  writeFileSync(join(staged, BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(out, { recursive: true, force: true });
  renameSync(staged, out);
  process.stdout.write(`Built ${manifest.outputs.files} files, ${manifest.outputs.bytes} bytes, digest ${manifest.outputs.sha256} in ${out}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const home = resolve(process.env.MIRAGE_LAUNCHER_HOME ?? join(homedir(), "Library", "Application Support", "MirageSITL", "launcher"));
  try {
    build({
      source: resolve(value("--source") ?? join(home, "sources", "uavlogviewer")),
      out: resolve(value("--out") ?? join(home, "uavlogviewer")),
      work: resolve(value("--work") ?? join(home, "work", "uavlogviewer")),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof Blocked ? 2 : 1;
  }
}
