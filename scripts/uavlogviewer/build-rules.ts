// Identity rules of the pinned UAVLogViewer source and of the TASK-179 offline
// build, shared by scripts/build-uavlogviewer.mjs, scripts/check-uavlogviewer.mjs
// and the tests (Node runs this file directly by stripping its types).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const LOCK_PATH = join(root, "third_party/uavlogviewer/source.lock.json");
export const PATCH_DIRECTORY = join(root, "third_party/uavlogviewer/patches");
export const BUILD_MANIFEST = "build-manifest.json";

export interface PatchIdentity { readonly file: string; readonly sha256: string }
export interface TreeFile { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface TreeDigest { readonly files: number; readonly bytes: number; readonly sha256: string }
export interface ViewerLock {
  readonly repository: string;
  readonly commit: string;
  readonly submodules: readonly { readonly path: string; readonly repository: string; readonly commit: string }[];
  readonly license: { readonly file: string; readonly sha256: string };
  readonly packageLockSha256: string;
  /** TASK-179: the patch series and output digest of the reproduced build, when recorded. */
  readonly patchedBuild: { readonly patches: readonly PatchIdentity[]; readonly outputs: TreeDigest } | null;
}

export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);
const hex = (value: unknown, length: number): value is string => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function parsePatches(value: unknown): PatchIdentity[] | null {
  if (!Array.isArray(value)) return null;
  const list: readonly unknown[] = value;
  const out: PatchIdentity[] = [];
  for (const entry of list) {
    const file = field(entry, "file"), digest = field(entry, "sha256");
    if (!text(file) || !hex(digest, 64)) return null;
    out.push({ file, sha256: digest });
  }
  return out;
}

export function parseTreeDigest(value: unknown): TreeDigest | null {
  const files = field(value, "files"), bytes = field(value, "bytes"), digest = field(value, "sha256");
  return count(files) && count(bytes) && hex(digest, 64) ? { files, bytes, sha256: digest } : null;
}

/** third_party/uavlogviewer/source.lock.json, validated. */
export function readLock(path = LOCK_PATH): ViewerLock {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const repository = field(raw, "repository"), commit = field(raw, "commit"), submodules = field(raw, "submodules");
  const licenseFile = field(field(raw, "license"), "file"), licenseHash = field(field(raw, "license"), "sha256");
  const packageLock = field(field(raw, "buildInputs"), "packageLockSha256");
  if (field(raw, "schemaVersion") !== 1 || !text(repository) || !hex(commit, 40) || !Array.isArray(submodules) ||
    !text(licenseFile) || !hex(licenseHash, 64) || !hex(packageLock, 64)) {
    throw new Error("third_party/uavlogviewer/source.lock.json is malformed");
  }
  const modules: readonly unknown[] = submodules;
  const parsedModules = modules.map(entry => {
    const path = field(entry, "path"), moduleRepository = field(entry, "repository"), moduleCommit = field(entry, "commit");
    if (!text(path) || !text(moduleRepository) || !hex(moduleCommit, 40)) throw new Error("third_party/uavlogviewer/source.lock.json has a malformed submodule");
    return { path, repository: moduleRepository, commit: moduleCommit };
  });
  const built = field(raw, "patchedBuild");
  let patchedBuild: ViewerLock["patchedBuild"] = null;
  if (built !== undefined) {
    const patches = parsePatches(field(built, "patches")), outputs = parseTreeDigest(field(built, "outputs"));
    if (!patches || !outputs) throw new Error("third_party/uavlogviewer/source.lock.json has a malformed patchedBuild");
    patchedBuild = { patches, outputs };
  }
  return { repository, commit, submodules: parsedModules, license: { file: licenseFile, sha256: licenseHash }, packageLockSha256: packageLock, patchedBuild };
}

const gitHead = (directory: string): string => execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

/** Source identity of a checkout against the lock; returns a list of mismatches. */
export function checkSource(lock: ViewerLock, source: string): string[] {
  const failures: string[] = [];
  if (gitHead(source) !== lock.commit) failures.push(`checkout is not at commit ${lock.commit}`);
  for (const module of lock.submodules) {
    const path = join(source, module.path);
    if (!existsSync(path) || gitHead(path) !== module.commit) failures.push(`submodule ${module.path} is not at ${module.commit}`);
  }
  if (sha256(readFileSync(join(source, lock.license.file))) !== lock.license.sha256) failures.push("LICENSE differs from the lock");
  if (sha256(readFileSync(join(source, "package-lock.json"))) !== lock.packageLockSha256) failures.push("package-lock.json differs from the lock");
  return failures;
}

/** The repository patch series in application order, with hashes. */
export function patchSeries(directory = PATCH_DIRECTORY): PatchIdentity[] {
  return readdirSync(directory).filter(name => /^\d{4}-[a-z0-9-]+\.patch$/.test(name)).sort()
    .map(name => ({ file: name, sha256: sha256(readFileSync(join(directory, name))) }));
}

/** Every file under a directory except the build manifest, sorted by path. */
export function treeFiles(directory: string): TreeFile[] {
  const out: TreeFile[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const file = relative(directory, full).split(sep).join("/");
        if (file !== BUILD_MANIFEST) out.push({ path: file, bytes: statSync(full).size, sha256: sha256(readFileSync(full)) });
      }
    }
  };
  walk(directory);
  return out;
}

/** SHA-256 of sorted `path<TAB>sha256<LF>` lines, the TASK-130 digest rule. */
export function treeDigest(files: readonly TreeFile[]): TreeDigest {
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), sha256: sha256(files.map(file => `${file.path}\t${file.sha256}\n`).join("")) };
}

export interface BuildCheck {
  readonly verdict: "PASS" | "FAIL";
  readonly failures: readonly string[];
  readonly patches: number;
  readonly matchesLockedBuild: boolean;
}

/** A TASK-179 build manifest against the lock, the repository patch series and the digest of the files on disk. */
export function checkBuildManifest(lock: ViewerLock, manifest: unknown, digest: TreeDigest, series: readonly PatchIdentity[] = patchSeries()): BuildCheck {
  const failures: string[] = [];
  if (field(manifest, "schemaVersion") !== 1 || field(manifest, "task") !== "TASK-179") failures.push("build-manifest.json is not a TASK-179 manifest");
  if (field(manifest, "commit") !== lock.commit) failures.push(`the build is not of commit ${lock.commit}`);
  const patches = parsePatches(field(manifest, "patches")) ?? [];
  const key = (list: readonly PatchIdentity[]) => list.map(patch => `${patch.file}:${patch.sha256}`).join(",");
  if (key(patches) !== key(series)) failures.push("the build's patches differ from third_party/uavlogviewer/patches");
  const outputs = parseTreeDigest(field(manifest, "outputs"));
  if (!outputs || outputs.sha256 !== digest.sha256 || outputs.files !== digest.files) failures.push("the files on disk differ from the build manifest");
  return { verdict: failures.length ? "FAIL" : "PASS", failures, patches: patches.length, matchesLockedBuild: lock.patchedBuild?.outputs.sha256 === digest.sha256 };
}
