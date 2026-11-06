import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, exact, hash, sha256, report } from "./validation/evidence.mjs";
/** Read-only inventory of declared build outputs; never publishes, tags or deploys. */
export function buildReleaseManifest(v, root = process.cwd()) {
  exact(v, ["schemaVersion", "artifacts", "systemReportPath", "systemReportSha256"]);
  if (v.schemaVersion !== 1 || !Array.isArray(v.artifacts) || v.artifacts.length < 1 || v.artifacts.length > 4096 || !hash(v.systemReportSha256)) throw new Error("Invalid release inventory");
  const base = realpathSync(root), names = new Set(); let totalBytes = 0;
  function owned(path) {
    if (typeof path !== "string" || isAbsolute(path) || path.includes("\\") || path.split("/").includes("..") || !/^(apps\/web\/dist\/|packages\/wasm-bet\/dist\/|test-results\/validation\/)/.test(path)) throw new Error("Release path outside generated output roots");
    const full = realpathSync(resolve(base, path)), rel = relative(base, full).replaceAll("\\", "/");
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

// TASK-190: the delivery manifest of Phase 1, read from the checkout and its inventories: what it is made from, what was built, the
// datasets and their licenses, and what the installer put in the launcher folder. It only reads and writes this one file: nothing here
// publishes, tags or deploys. An inventory row whose license is not settled blocks delivery as BLOCKED_DECISION, naming it.
const BUILT_ROOTS = ["apps/web/dist", "packages/wasm-bet/dist", "packages/physics/dist/contact"];
const SOURCE_LOCKS = ["package-lock.json", "scripts/sitl.lock.json", "third_party/uavlogviewer/source.lock.json", "native/rapier/source.lock.json", "native/Cargo.lock", "scripts/install/requirements-macos.txt"];
const SETTLED_LICENSES = new Set(["reviewed", "not-applicable"]);
function filesUnder(directory) {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
/**
 * What the inventory rows leave open for delivery: a license nobody reviewed, or a restricted item the delivery needs whose decision is
 * still pending. A restricted item that Phase 1 does not use is listed and blocks nothing, and neither does one with its decision taken.
 */
export function deliveryOpenItems(items) {
  const blockers = [], restricted = [];
  for (const item of items) {
    if (item.status === "not-needed-phase1") { if (item.licenseStatus === "restricted") restricted.push({ id: item.id, used: false, decision: item.decision ?? null }); continue; }
    if (item.licenseStatus === "restricted") {
      restricted.push({ id: item.id, used: true, decision: item.decision ?? null });
      if (item.status === "pending") blockers.push(`${item.id}: restricted, and waiting for a decision: ${item.decision ?? "none named"}`);
    } else if (!SETTLED_LICENSES.has(item.licenseStatus)) blockers.push(`${item.id}: license ${item.licenseStatus}`);
  }
  return { blockers, restricted };
}
export function buildDeliveryManifest(root = process.cwd(), { home = null } = {}) {
  const base = realpathSync(root), git = args => execFileSync("git", args, { cwd: base, encoding: "utf8" }).trim();
  const inventory = JSON.parse(readFileSync(resolve(base, "config/offline-inventory.json"), "utf8"));
  const licenseOf = id => inventory.items.find(item => item.id === id)?.license ?? "not inventoried";
  const reasons = [], built = { "apps/web/dist": "web-application", "packages/wasm-bet/dist": "wasm-bet-artifacts", "packages/physics/dist/contact": "contact-wasm" };
  const artifacts = [];
  for (const directory of BUILT_ROOTS) {
    const full = resolve(base, directory);
    if (!existsSync(full)) { reasons.push(`${directory} is not built: run npm run build, node scripts/build-wasm.mjs and node scripts/build-contact.mjs`); continue; }
    for (const file of filesUnder(full).sort()) {
      const bytes = readFileSync(file);
      artifacts.push({ path: relative(base, file).replaceAll("\\", "/"), sha256: sha256(bytes), bytes: bytes.length, license: licenseOf(built[directory]) });
    }
  }
  const { blockers, restricted } = deliveryOpenItems(inventory.items);
  const dirty = git(["status", "--porcelain"]).length > 0;
  if (dirty) reasons.push("The checkout has uncommitted changes, so this manifest describes no commit");
  let installed = null;
  if (home !== null) {
    const path = resolve(home, "install-manifest.json");
    if (!existsSync(path)) reasons.push(`${home} has no installation: run node scripts/install-macos.mjs`);
    else {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      installed = { createdAt: manifest.createdAt, items: manifest.items.map(item => ({ id: item.id, version: item.version, sha256: item.sha256, bytes: item.bytes, license: item.license })) };
    }
  }
  const status = blockers.length > 0 ? "BLOCKED_DECISION" : reasons.length > 0 ? "BLOCKED_EXTERNAL" : "PASS";
  return { ...report("delivery-manifest", status, [...blockers, ...reasons]),
    sources: { commit: git(["rev-parse", "HEAD"]), dirty, node: process.version,
      locks: Object.fromEntries(SOURCE_LOCKS.filter(path => existsSync(resolve(base, path))).map(path => [path, sha256(readFileSync(resolve(base, path)))])) },
    artifacts, totalBytes: artifacts.reduce((sum, item) => sum + item.bytes, 0), restricted,
    datasets: inventory.items.map(item => ({ id: item.id, category: item.category, version: item.version, license: item.license, licenseStatus: item.licenseStatus, status: item.status,
      ...(item.files ? { files: item.files } : {}) })),
    installed };
}
function deliveryCli() {
  const value = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] ?? null : null; };
  const out = value("--out") ?? "test-results/validation/delivery-manifest.json";
  const manifest = buildDeliveryManifest(process.cwd(), { home: value("--home") });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`delivery-manifest: ${manifest.status}; ${out}${manifest.reasons.length > 0 ? `\n${manifest.reasons.join("\n")}` : ""}`);
  process.exitCode = manifest.status === "PASS" ? 0 : 2;
}
if (process.argv.includes("--delivery") && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) deliveryCli();
else cli(import.meta.url, "release-manifest", buildReleaseManifest);
