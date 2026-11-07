// TASK-117: what the first GNSS receiver of each real ArduCopter log in data/flight-logs/inventory.json reported (fix type,
// satellites, HDOP, its own accuracy estimates), beside the GNSS v2 model's satellite geometry at the same place and GPS time
// (SPECS_SIMULATION_ENGINES "Logged receiver statistics"). The logs are kept outside the repository and checked by SHA-256. No
// position is written out. No limit applies: the logs hold the receivers' reports, not their position errors.
//
//   node scripts/check-gnss-stats.mjs --dir DIRECTORY [--out DIR]
//
// Writes logged-gnss.json to test-results/validation/ (or --out). Exit 0 REPORTED, 1 when a file is missing or differs, 2
// (BLOCKED_EXTERNAL) without the directory.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TRANSFORM = "--experimental-transform-types";
if (!process.execArgv.includes(TRANSFORM)) {
  const child = spawnSync(process.execPath, [TRANSFORM, "--no-warnings", "--max-old-space-size=8192", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}
const { gnssLogStatistics, MODEL_SETTINGS } = await import("../packages/analysis/src/gnss-statistics.ts");
const { readDataFlash } = await import("../packages/dataflash/src/reader.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1] ?? null; };
const dir = option("--dir"), out = option("--out") ?? join(ROOT, "test-results/validation");
const write = result => {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "logged-gnss.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, reasons: result.reasons }, null, 2));
};
if (!dir || !existsSync(dir)) {
  write({ schemaVersion: 1, kind: "logged-gnss", status: "BLOCKED_EXTERNAL", reasons: ["Pass the directory of the inventory's logs with --dir DIRECTORY"] });
  process.exit(2);
}
const inventoryBytes = readFileSync(join(ROOT, "data/flight-logs/inventory.json"));
const inventory = JSON.parse(inventoryBytes.toString("utf8"));
const round = (v, digits) => Number(v.toFixed(digits));
const pct = (p, digits = 2) => (p === null ? null : { p5: round(p.p5, digits), p50: round(p.p50, digits), p95: round(p.p95, digits), samples: p.samples });
const reasons = [], logs = [];
for (const entry of inventory.logs) {
  const path = join(dir, entry.file);
  if (!existsSync(path)) { reasons.push(`${entry.file} is missing from ${dir}`); continue; }
  const bytes = readFileSync(path), sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== entry.sha256) { reasons.push(`${entry.file} has SHA-256 ${sha256}, not the inventory's ${entry.sha256}`); continue; }
  const aircraft = inventory.aircraft.find(item => item.id === entry.aircraft);
  const s = gnssLogStatistics(readDataFlash(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
  logs.push({
    file: entry.file, sha256, aircraft: entry.aircraft, receiver: aircraft?.stated.gnss?.value ?? "not stated",
    epochs: s.epochs, durationS: round(s.durationS, 1), rateHz: round(s.rateHz, 2), status: s.status,
    satellites: pct(s.satellites, 1), hdop: pct(s.hdop), horizontalAccuracyM: pct(s.horizontalAccuracyM), verticalAccuracyM: pct(s.verticalAccuracyM),
    speedAccuracyMps: pct(s.speedAccuracyMps, 3),
    model: { visible: pct(s.model.visible, 1), hdop: pct(s.model.hdop), accuracyM: pct(s.model.accuracyM), solutions: s.model.solutions },
  });
}
const status = reasons.length ? "FAIL" : "REPORTED";
write({
  schemaVersion: 1, kind: "logged-gnss", status, reasons, inventorySha256: createHash("sha256").update(inventoryBytes).digest("hex"),
  model: { constellation: "synthetic Walker 24/6/1", ...MODEL_SETTINGS }, logs,
});
process.exit(reasons.length ? 1 : 0);
