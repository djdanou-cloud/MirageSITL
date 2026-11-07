// TASK-116: the barometer's logged takeoff and landing dips in the real ArduCopter logs of data/flight-logs/inventory.json, the
// ground-cushion fit to each configuration's landings, and the model's own prediction for held-out logs of the same configuration
// (SPECS_SIMULATION_ENGINES "Logged dips"). The logs are kept outside the repository; every file is checked against its SHA-256.
//
//   node scripts/check-baro-dips.mjs --dir DIRECTORY [--out DIR]
//
// Writes logged-baro-dips.json to test-results/validation/ (or --out). Exit 0 when every held-out landing is reproduced within the
// declared tolerance, 1 when one is not or a file is missing or differs, 2 (BLOCKED_EXTERNAL) without the directory.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The packages it reads use TypeScript syntax that plain type stripping refuses.
const TRANSFORM = "--experimental-transform-types";
if (!process.execArgv.includes(TRANSFORM)) {
  const child = spawnSync(process.execPath, [TRANSFORM, "--no-warnings", "--max-old-space-size=8192", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}
const { DIP_METHOD, DIP_TOLERANCE, fitGroundCushion, measureBarometerDips, predictNearGroundPa, withinDipTolerance } =
  await import("../packages/analysis/src/barometer-dips.ts");
const { readDataFlash } = await import("../packages/dataflash/src/reader.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INCH = 0.0254;
/** The stated configuration of each log: mass and rotors from the owner's posts (inventory `stated`); null mass is not stated. */
const CONFIGURATIONS = {
  "mn7005-kv230-24in-7.2kg": { massKg: 7.2, rotorCount: 4, rotorRadiusM: 12 * INCH },
  "tmotor-230kv-24in-6kg": { massKg: 6, rotorCount: 4, rotorRadiusM: 12 * INCH },
  "tmotor-7005-230kv-24in-7kg": { massKg: 7, rotorCount: 4, rotorRadiusM: 12 * INCH },
  "mn7005-kv115-24in-12s": { massKg: null, rotorCount: 4, rotorRadiusM: 12 * INCH },
  "p80iii-kv100-30in-16kg": { massKg: 16, rotorCount: 4, rotorRadiusM: 15 * INCH },
  // 00000011 flew 32.4-inch foldable propellers, before the flight controller was remounted.
  "p80iii-kv100-32in-16kg-first-mount": { massKg: 16, rotorCount: 4, rotorRadiusM: 16.2 * INCH },
};
/** Fit groups: one configuration each, with the logs fitted and the logs held out (declared in the specification). */
const GROUPS = [
  { id: "mn7005-kv230-24in-7.2kg", configuration: "mn7005-kv230-24in-7.2kg", fit: ["topic-144558-00000205.BIN"], holdOut: [] },
  { id: "tmotor-230kv-24in-6kg", configuration: "tmotor-230kv-24in-6kg", fit: ["topic-131210-00000148.BIN"], holdOut: ["topic-131210-00000280.BIN"] },
  { id: "tmotor-7005-230kv-24in-7kg", configuration: "tmotor-7005-230kv-24in-7kg", fit: ["topic-140620-00000218.BIN"], holdOut: [] },
  { id: "mn7005-kv115-24in-12s", configuration: "mn7005-kv115-24in-12s", fit: [], holdOut: [], measured: ["topic-145394-11-41-15.BIN"] },
  { id: "p80iii-kv100-30in-16kg-first-mount", configuration: "p80iii-kv100-32in-16kg-first-mount", fit: ["topic-134119-00000011.BIN"], holdOut: [] },
  { id: "p80iii-kv100-30in-16kg-remounted", configuration: "p80iii-kv100-30in-16kg",
    fit: ["topic-134119-00000014.BIN", "topic-134119-00000016.BIN"],
    holdOut: ["topic-134119-00000017.BIN", "topic-134119-00000023.BIN", "topic-134119-00000025.BIN"] },
];

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1] ?? null; };
const dir = option("--dir"), out = option("--out") ?? join(ROOT, "test-results/validation");
const write = result => {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "logged-baro-dips.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, reasons: result.reasons }, null, 2));
};
if (!dir || !existsSync(dir)) {
  write({ schemaVersion: 1, kind: "logged-baro-dips", status: "BLOCKED_EXTERNAL", reasons: ["Pass the directory of the inventory's logs with --dir DIRECTORY"] });
  process.exit(2);
}
const inventory = JSON.parse(readFileSync(join(ROOT, "data/flight-logs/inventory.json"), "utf8"));
const inventoryHash = createHash("sha256").update(readFileSync(join(ROOT, "data/flight-logs/inventory.json"))).digest("hex");
const reasons = [];
const round = (v, digits = 3) => (v === null ? null : Number(v.toFixed(digits)));
function load(file) {
  const entry = inventory.logs.find(item => item.file === file);
  if (!entry) throw new Error(`${file} is not in the inventory`);
  const path = join(dir, file);
  if (!existsSync(path)) { reasons.push(`${file} is missing from ${dir}`); return null; }
  const bytes = readFileSync(path), sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== entry.sha256) { reasons.push(`${file} has SHA-256 ${sha256}, not the inventory's ${entry.sha256}`); return null; }
  return { entry, log: readDataFlash(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)) };
}
const summary = event => ({
  kind: event.kind, motorTimeS: round(event.motorTimeS, 2), referencePa: round(event.referencePa, 1), noisePa: round(event.noisePa, 2),
  referenceSamples: event.referenceSamples, samples: event.samples.length, nearGroundPa: round(event.nearGroundPa, 2),
  nearGroundSamples: event.nearGroundSamples,
  profile: event.profile.map(bin => ({ fromM: bin.fromM, toM: bin.toM, meanPa: round(bin.meanPa, 2), samples: bin.samples })),
});

const groups = [];
let missed = 0;
for (const group of GROUPS) {
  const aircraft = CONFIGURATIONS[group.configuration];
  const measure = file => {
    const loaded = load(file);
    if (!loaded) return null;
    const m = measureBarometerDips(loaded.log, aircraft);
    return { file, sha256: loaded.entry.sha256, measurement: m };
  };
  const fitted = group.fit.map(measure).filter(Boolean), held = group.holdOut.map(measure).filter(Boolean), other = (group.measured ?? []).map(measure).filter(Boolean);
  let fit = null, fitError = null;
  if (aircraft.massKg !== null && fitted.length) {
    try { fit = fitGroundCushion(fitted.flatMap(item => item.measurement.events), aircraft); } catch (error) { fitError = error.message; }
  }
  const holdOuts = [];
  for (const item of held) {
    for (const event of item.measurement.events) {
      if (event.kind !== "landing" || event.nearGroundPa === null || !fit) continue;
      const predictedPa = predictNearGroundPa(event, fit, aircraft);
      const within = predictedPa !== null && withinDipTolerance(event.nearGroundPa, predictedPa);
      if (!within) { missed++; reasons.push(`${item.file} landing at ${event.motorTimeS.toFixed(1)} s: measured ${event.nearGroundPa.toFixed(2)} Pa, predicted ${predictedPa?.toFixed(2)} Pa`); }
      holdOuts.push({ file: item.file, motorTimeS: round(event.motorTimeS, 2), measuredPa: round(event.nearGroundPa, 2), predictedPa: round(predictedPa, 2), within });
    }
  }
  const logs = [...fitted.map(x => ({ ...x, role: "fit" })), ...held.map(x => ({ ...x, role: "hold-out" })), ...other.map(x => ({ ...x, role: "measured" }))];
  groups.push({
    id: group.id, aircraft: { configuration: group.configuration, ...aircraft },
    inducedPressurePa: round(logs[0]?.measurement.inducedPressurePa ?? null, 2),
    fit: fit ? { gain: round(fit.gain, 3), decayRadii: round(fit.decayRadii, 3), washCoefficient: round(fit.washCoefficient, 3), rmsPa: round(fit.rmsPa, 2), samples: fit.samples } : null,
    fitError: fitError ?? (aircraft.massKg === null ? "no stated mass" : fit ? null : "no fitted log"),
    logs: logs.map(item => ({ file: item.file, sha256: item.sha256, role: item.role, events: item.measurement.events.map(summary), skipped: item.measurement.skipped.map(s => ({ ...s, motorTimeS: round(s.motorTimeS, 2) })) })),
    holdOuts,
  });
}
const failedFiles = reasons.some(reason => !reason.includes(" landing at "));
write({
  schemaVersion: 1, kind: "logged-baro-dips", status: failedFiles || missed ? "FAIL" : "REPORTED", reasons,
  inventorySha256: inventoryHash, method: DIP_METHOD, tolerance: DIP_TOLERANCE, groups,
});
process.exit(failedFiles || missed ? 1 : 0);
