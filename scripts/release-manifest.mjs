import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { cli, exact, hash, sha256, report } from "./validation/evidence.mjs";
/** Read-only inventory of declared build outputs; never publishes, tags or deploys. */
export function buildReleaseManifest(v, root = process.cwd()) {
  exact(v, ["schemaVersion", "artifacts", "systemReportPath", "systemReportSha256"]);
  if (v.schemaVersion !== 1 || !Array.isArray(v.artifacts) || v.artifacts.length < 1 || v.artifacts.length > 4096 || !hash(v.systemReportSha256)) throw new Error("Invalid release inventory");
  const base = realpathSync(root), names = new Set(); let totalBytes = 0;
  function owned(path) {
    if (typeof path !== "string" || isAbsolute(path) || path.includes("\\") || path.split("/").includes("..") || !/^(apps\/web\/dist\/|packages\/wasm-bet\/dist\/|test-results\/validation\/)/.test(path)) throw new Error("Release path outside generated output roots");
    const full = realpathSync(resolve(base, path)), rel = relative(base, full);
    if (!/^(apps\/web\/dist\/|packages\/wasm-bet\/dist\/|test-results\/validation\/)/.test(rel) || rel.startsWith("..") || isAbsolute(rel) || !statSync(full).isFile() || statSync(full).size > 64 * 1024 ** 2) throw new Error("Release file escapes root or byte budget");
    return full;
  }
  const artifacts = [];
  for (const item of v.artifacts) {
    exact(item, ["path", "sha256", "license"]);
    if (names.has(item.path) || !hash(item.sha256) || typeof item.license !== "string" || !item.license.trim()) throw new Error("Duplicate/unlicensed release artifact");
    const bytes = readFileSync(owned(item.path)); totalBytes += bytes.length;
    if (totalBytes > 512 * 1024 ** 2 || sha256(bytes) !== item.sha256) throw new Error("Release artifact hash or total byte budget mismatch");
    names.add(item.path); artifacts.push({ path: item.path, sha256: item.sha256, bytes: bytes.length, license: item.license });
  }
  const systemBytes = readFileSync(owned(v.systemReportPath));
  if (sha256(systemBytes) !== v.systemReportSha256) throw new Error("System report hash mismatch");
  const system = JSON.parse(systemBytes);
  if (system.schemaVersion !== 1 || system.kind !== "system-report" || !["PASS", "FAIL", "BLOCKED_EXTERNAL"].includes(system.status)) throw new Error("Invalid system report");
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: base, encoding: "utf8" }).trim().length > 0;
  // A matrix summary alone is insufficient to certify G0..G4. Raw report bindings
  // and clean-machine/hardware execution remain required for a publishable release.
  const result = report("release-manifest", system.status === "FAIL" ? "FAIL" : "BLOCKED_EXTERNAL", ["Clean-machine and raw G0..G4 evidence review required before release"]);
  return { ...result, sourceRevision, dirty, artifacts, totalBytes, systemReportSha256: v.systemReportSha256,
    packageLockSha256: sha256(readFileSync(resolve(base, "package-lock.json"))),
    datasetRegistrySha256: existsSync(resolve(base, "tests/fixtures/registry.json")) ? sha256(readFileSync(resolve(base, "tests/fixtures/registry.json"))) : null,
    toolchain: { node: process.version }, supportedModes: system.metrics?.modes ?? {} };
}
cli(import.meta.url, "release-manifest", buildReleaseManifest);
