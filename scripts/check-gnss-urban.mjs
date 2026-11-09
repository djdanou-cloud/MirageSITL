// TASK-117: smartLoc's four urban scenarios (a u-blox EVK-M8T's own fixes against a NovAtel SPAN reference) beside the GNSS v2 model at
// the same place and time of week (SPECS_SIMULATION_ENGINES "Logged urban position errors: smartLoc"). Shown, not judged (SA-01). The
// data are kept outside the repository and checked by SHA-256; no position is written out, only statistics.
//
//   node scripts/check-gnss-urban.mjs --dir DIRECTORY [--out DIR]
//
// DIRECTORY holds zips/ (the four archives) and data/<scenario>/ (each archive extracted). Writes gnss-urban.json to
// test-results/validation/ (or --out). Exit 0 REPORTED, 1 when an archive differs, 2 (BLOCKED_EXTERNAL) without the data.
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
const { URBAN_MODEL, measuredStatistics, modelStatistics, nonLineOfSightShare, parseNavPosllh } = await import("../packages/analysis/src/gnss-urban.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dir = option("--dir"), out = option("--out") ?? join(ROOT, "test-results/validation");
if (!dir || !existsSync(join(dir, "zips"))) { console.error("BLOCKED_EXTERNAL: --dir with smartLoc's zips/ and data/ is required"); process.exit(2); }

/** The archives as declared, by SHA-256. */
const SCENARIOS = [
  ["berlin1_potsdamer_platz", "49dcdad2d99871a07c40c2a387426d58ad4ddc0a236490f060cbc745abc9abbb"],
  ["berlin2_gendarmenmarkt", "6379d886a3c21eaa951c43b9c1a0ee6e200de93f9bd0c62a0fe163352a9748d1"],
  ["frankfurt1_maintower", "3cfa14cf8d236fa2dd8d63c849a27ac2f2bbd5f77b5ea6b839414c330fccf0ab"],
  ["frankfurt2_westendtower", "46d5685908e9f6b61175845e4615659e6d6639d8f23a2ebdbec3c15e86c82860"],
];
const round = (x, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
const brief = p => ({ p50: round(p.p50), p95: round(p.p95), samples: p.samples });
const scenarios = [];
for (const [name, sha256] of SCENARIOS) {
  const zip = join(dir, "zips", `${name}.zip`);
  if (!existsSync(zip)) { console.error(`BLOCKED_EXTERNAL: ${zip} is missing`); process.exit(2); }
  const actual = createHash("sha256").update(readFileSync(zip)).digest("hex");
  if (actual !== sha256) { console.error(`${name}.zip has SHA-256 ${actual}, not ${sha256}`); process.exit(1); }
  const epochs = parseNavPosllh(readFileSync(join(dir, "data", name, "NAV-POSLLH.csv"), "utf8"));
  const nlos = nonLineOfSightShare(readFileSync(join(dir, "data", name, "RXM-RAWX.csv"), "utf8"));
  const measured = measuredStatistics(epochs);
  const first = epochs[0], durationS = epochs[epochs.length - 1].secondsOfWeek - first.secondsOfWeek;
  const model = modelStatistics(first.reference, first.secondsOfWeek, durationS);
  const ratio = (m, d) => round(m / d, 4);
  scenarios.push({
    scenario: name, archiveSha256: sha256, gpsWeek: first.week, startSecondsOfWeek: first.secondsOfWeek, durationS: round(durationS, 1), epochs: epochs.length,
    nonLineOfSight: { labelled: nlos.labelled, share: round(nlos.share, 4) },
    measured: { horizontalM: brief(measured.horizontalM), verticalAbsM: brief(measured.verticalAbsM), reportedAccuracyM: brief(measured.accuracyM) },
    model: { samples: model.samples, fixes: model.fixes, horizontalM: brief(model.horizontalM), verticalAbsM: brief(model.verticalAbsM), reportedAccuracyM: brief(model.accuracyM) },
    modelOverMeasured: { horizontalP50: ratio(model.horizontalM.p50, measured.horizontalM.p50), horizontalP95: ratio(model.horizontalM.p95, measured.horizontalM.p95),
      verticalP50: ratio(model.verticalAbsM.p50, measured.verticalAbsM.p50), verticalP95: ratio(model.verticalAbsM.p95, measured.verticalAbsM.p95),
      reportedAccuracyP50: ratio(model.accuracyM.p50, measured.accuracyM.p50) },
  });
  const s = scenarios[scenarios.length - 1];
  console.log(`${name.padEnd(24)} NLOS ${(s.nonLineOfSight.share * 100).toFixed(0)} %  horizontal p50/p95 measured ${s.measured.horizontalM.p50}/${s.measured.horizontalM.p95} m, model ` +
    `${s.model.horizontalM.p50}/${s.model.horizontalM.p95} m; vertical ${s.measured.verticalAbsM.p50}/${s.measured.verticalAbsM.p95} m against ${s.model.verticalAbsM.p50}/${s.model.verticalAbsM.p95} m; ` +
    `hAcc p50 ${s.measured.reportedAccuracyM.p50} m against ${s.model.reportedAccuracyM.p50} m`);
}
const report = { schema: "mirage-gnss-urban/1", task: "TASK-117", status: "REPORTED", judged: false,
  declared: "SPECS_SIMULATION_ENGINES, Logged urban position errors: smartLoc (2026-11-09)",
  dataset: { name: "smartLoc GNSS dataset, TU Chemnitz (Reisdorf et al. 2016)", license: "CC BY-NC-SA 4.0", receiver: "u-blox EVK-M8T", reference: "NovAtel SPAN, RTK and IMU" },
  model: URBAN_MODEL, scenarios };
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "gnss-urban.json"), `${JSON.stringify(report, null, 2)}\n`);
