// Checks the Phase 1 offline inventory (TASK-131). Every network origin named
// in the scanned repository files (and, with --dist, in a built bundle) must be
// listed with its use; every runtime npm package in the lockfile must carry a
// reviewed license; every inventoried file must still match its recorded bytes
// and SHA-256; and every terrain source must state its kind, resolution,
// coverage, readiness and license status. An unresolved or restricted license,
// a pending dependency and an unready terrain source must each name the
// decision or task that resolves it. The check reads local files only.
//
//   node scripts/check-offline.mjs [--root DIR] [--dist DIR]
//
// Prints a JSON summary. Exit 0 PASS; 1 FAIL (unlisted origin, unreviewed
// license, file mismatch, a missing bundle, or an invalid inventory).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = /\b(?:https?|wss?):\/\/[A-Za-z0-9.-]+(?::\d+)?/g;
const LISTED_ORIGIN = /^(?:https?|wss?):\/\/[a-z0-9.-]+(?::\d+)?$/;
const CATEGORIES = ["application", "native-artifact", "toolchain", "browser", "python", "metadata", "viewer", "reference-data"];
const LICENSE_STATUSES = ["reviewed", "unresolved", "restricted", "not-applicable"];
const ITEM_STATUSES = ["ready", "pending", "not-needed-phase1"];
const ORIGIN_USES = ["loopback", "identifier", "documentation-link", "install-time", "manual-data-preparation", "online-optional"];
const TERRAIN_KINDS = ["synthetic-surface", "land-cover", "elevation", "geoid", "imagery", "imagery-and-mesh", "vector-features", "test-fixture"];
const READINESS = ["ready", "ready-not-wired", "needs-data", "needs-keys-or-deployment", "test-only"];
const BUNDLE_EXTENSIONS = [".js", ".mjs", ".html", ".css", ".json"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "target", ".cache", ".git"]);
const INVENTORY = "config/offline-inventory.json";
const TERRAIN = "data/terrain/inventory.json";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = value => typeof value === "string" && value.trim() !== "";
const needsDecision = entry => entry.licenseStatus === "unresolved" || entry.licenseStatus === "restricted";

function argument(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
}

function walk(path, extensions, out) {
  if (!existsSync(path)) return;
  if (statSync(path).isFile()) {
    if (extensions.includes(extname(path))) out.push(path);
    return;
  }
  for (const name of readdirSync(path).sort()) {
    if (!SKIP_DIRECTORIES.has(name)) walk(join(path, name), extensions, out);
  }
}

/** Origins named in the given files: origin -> first file (relative to root) that names it. */
function findOrigins(files, root) {
  const found = new Map();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(ORIGIN)) {
      const origin = match[0].toLowerCase();
      if (!found.has(origin)) found.set(origin, relative(root, file));
    }
  }
  return found;
}

function validateFiles(where, files, failures) {
  if (files === undefined) return;
  if (!Array.isArray(files)) { failures.push(`${where}: files must be an array`); return; }
  for (const file of files) {
    if (!isObject(file) || !isText(file.path) || !/^[a-f0-9]{64}$/.test(String(file.sha256)) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      failures.push(`${where}: each file needs a path, a SHA-256 and a byte count`);
    }
  }
}

function validateInventory(inventory, failures) {
  if (!isObject(inventory) || inventory.schemaVersion !== 1) { failures.push("offline inventory: schemaVersion 1 required"); return; }
  if (!isObject(inventory.scan) || !Array.isArray(inventory.scan.roots) || !inventory.scan.roots.every(isText) ||
    !Array.isArray(inventory.scan.extensions) || !inventory.scan.extensions.every(isText)) {
    failures.push("offline inventory: scan.roots and scan.extensions required");
  }
  if (!isObject(inventory.npm) || !isText(inventory.npm.lockfile) || !Array.isArray(inventory.npm.allowedLicenses) ||
    !inventory.npm.allowedLicenses.every(isText)) {
    failures.push("offline inventory: npm.lockfile and npm.allowedLicenses required");
  }
  if (!Array.isArray(inventory.networkOrigins)) failures.push("offline inventory: networkOrigins array required");
  const origins = new Set();
  for (const entry of inventory.networkOrigins ?? []) {
    if (!isObject(entry) || typeof entry.origin !== "string" || !LISTED_ORIGIN.test(entry.origin) || origins.has(entry.origin)) {
      failures.push(`network origin ${String(entry?.origin)}: a unique lower-case scheme://host[:port] required`);
      continue;
    }
    origins.add(entry.origin);
    if (!ORIGIN_USES.includes(entry.use) || !isText(entry.reason)) failures.push(`network origin ${entry.origin}: use and reason required`);
  }
  if (!Array.isArray(inventory.items)) { failures.push("offline inventory: items array required"); return; }
  const ids = new Set();
  for (const item of inventory.items) {
    const where = `item ${String(item?.id)}`;
    if (!isObject(item) || !isText(item.id) || ids.has(item.id)) { failures.push(`${where}: missing or duplicate id`); continue; }
    ids.add(item.id);
    if (!CATEGORIES.includes(item.category)) failures.push(`${where}: unknown category ${String(item.category)}`);
    for (const field of ["item", "version", "source", "license", "neededFor"]) {
      if (!isText(item[field])) failures.push(`${where}: ${field} required`);
    }
    if (!LICENSE_STATUSES.includes(item.licenseStatus)) failures.push(`${where}: unknown license status`);
    if (!ITEM_STATUSES.includes(item.status)) failures.push(`${where}: unknown status`);
    if (typeof item.installDownload !== "boolean") failures.push(`${where}: installDownload must be a boolean`);
    if ((needsDecision(item) || item.status === "pending") && !isText(item.decision)) {
      failures.push(`${where}: an unresolved or restricted license and a pending item name the decision or task that resolves them`);
    }
    validateFiles(where, item.files, failures);
  }
}

function validateTerrain(terrain, failures) {
  if (!isObject(terrain) || terrain.schemaVersion !== 1 || !Array.isArray(terrain.sources)) {
    failures.push("terrain inventory: schemaVersion 1 and sources required");
    return;
  }
  const ids = new Set();
  for (const source of terrain.sources) {
    const where = `terrain source ${String(source?.id)}`;
    if (!isObject(source) || !isText(source.id) || ids.has(source.id)) { failures.push(`${where}: missing or duplicate id`); continue; }
    ids.add(source.id);
    if (!TERRAIN_KINDS.includes(source.kind)) failures.push(`${where}: unknown kind ${String(source.kind)}`);
    if (!READINESS.includes(source.readiness)) failures.push(`${where}: unknown readiness ${String(source.readiness)}`);
    for (const field of ["name", "source", "license", "coverage", "resolution"]) {
      if (!isText(source[field])) failures.push(`${where}: ${field} required`);
    }
    if (!LICENSE_STATUSES.includes(source.licenseStatus)) failures.push(`${where}: unknown license status`);
    const unready = source.readiness === "needs-data" || source.readiness === "needs-keys-or-deployment" || source.readiness === "ready-not-wired";
    if ((needsDecision(source) || unready) && !isText(source.decision)) {
      failures.push(`${where}: an unresolved or restricted license and an unready source name the decision or task that resolves them`);
    }
    validateFiles(where, source.files, failures);
  }
  if (!Array.isArray(terrain.gaps) || !terrain.gaps.every(isText)) failures.push("terrain inventory: gaps list required");
}

function checkFiles(root, records, failures) {
  let checked = 0;
  for (const record of records) {
    for (const file of record.files ?? []) {
      const where = `${record.id}: ${file.path}`;
      const path = resolve(root, file.path);
      if (!existsSync(path)) { failures.push(`${where}: file missing`); continue; }
      const bytes = readFileSync(path);
      if (bytes.length !== file.bytes) failures.push(`${where}: ${bytes.length} bytes, the inventory records ${file.bytes}`);
      else if (sha256(bytes) !== file.sha256) failures.push(`${where}: SHA-256 differs from the inventory`);
      checked++;
    }
  }
  return checked;
}

/** Non-development packages of an npm v3 lockfile with their declared licenses. */
function runtimePackages(lock) {
  const out = [];
  for (const [key, entry] of Object.entries(isObject(lock?.packages) ? lock.packages : {})) {
    if (!key.includes("node_modules/") || !isObject(entry) || entry.dev === true || entry.link === true) continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    out.push({ name, version: String(entry.version), license: typeof entry.license === "string" ? entry.license : null });
  }
  return out;
}

function readJson(root, path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

export function checkOffline(root, distDirectory) {
  const failures = [];
  const inventory = readJson(root, INVENTORY);
  const terrain = readJson(root, TERRAIN);
  validateInventory(inventory, failures);
  validateTerrain(terrain, failures);
  if (failures.length) return { verdict: "FAIL", failures };

  // The inventory names every listed origin itself, so it is not scanned.
  const inventoryPath = resolve(root, INVENTORY);
  const walked = [];
  for (const directory of inventory.scan.roots) walk(resolve(root, directory), inventory.scan.extensions, walked);
  const files = walked.filter(file => file !== inventoryPath);
  const scannedFiles = files.length;
  let bundleFiles = 0;
  if (distDirectory !== undefined) {
    const dist = resolve(root, distDirectory);
    if (!existsSync(dist)) failures.push(`bundle directory ${distDirectory} is missing; run npm run build first`);
    else {
      // walk() skips directories named dist below its start, not the start itself.
      const bundle = [];
      walk(dist, BUNDLE_EXTENSIONS, bundle);
      bundleFiles = bundle.length;
      files.push(...bundle);
    }
  }
  const listed = new Map(inventory.networkOrigins.map(entry => [entry.origin, entry.use]));
  const found = findOrigins(files, root);
  for (const [origin, file] of found) {
    if (!listed.has(origin)) failures.push(`unlisted network origin ${origin} in ${file}`);
  }

  const packages = runtimePackages(readJson(root, inventory.npm.lockfile));
  const allowed = new Set(inventory.npm.allowedLicenses);
  const licenses = {};
  for (const entry of packages) {
    const license = entry.license ?? "NONE";
    licenses[license] = (licenses[license] ?? 0) + 1;
    if (!allowed.has(license)) failures.push(`npm runtime package ${entry.name}@${entry.version} has unreviewed license ${license}`);
  }
  const hashedFiles = checkFiles(root, inventory.items, failures) + checkFiles(root, terrain.sources, failures);
  const records = [...inventory.items, ...terrain.sources];
  return {
    verdict: failures.length ? "FAIL" : "PASS",
    failures,
    scannedFiles,
    bundleFiles,
    origins: [...found.keys()].sort().map(origin => ({ origin, use: listed.get(origin) ?? "UNLISTED" })),
    // Listed origins named nowhere in this scan; bundled-library origins appear only with --dist.
    unusedOrigins: [...listed.keys()].filter(origin => !found.has(origin)).sort(),
    npmRuntimePackages: packages.length,
    npmLicenses: licenses,
    hashedFiles,
    items: inventory.items.length,
    pendingItems: inventory.items.filter(item => item.status === "pending").map(item => item.id),
    terrainSources: terrain.sources.map(source => ({ id: source.id, kind: source.kind, readiness: source.readiness })),
    openLicenses: records.filter(needsDecision).map(entry => ({ id: entry.id, licenseStatus: entry.licenseStatus, decision: entry.decision })),
    gaps: terrain.gaps.length,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(argument("--root") ?? fileURLToPath(new URL("../", import.meta.url)));
  let report;
  try {
    report = checkOffline(root, argument("--dist"));
  } catch (error) {
    report = { verdict: "FAIL", failures: [error instanceof Error ? error.message : String(error)] };
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.verdict === "PASS" ? 0 : 1;
}
