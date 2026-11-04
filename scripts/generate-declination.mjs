#!/usr/bin/env node
// Generates data/ardupilot/declination.json offline (TASK-172) from a clean
// ArduPilot checkout at a supported commit: the declination table of
// libraries/AP_Declination/tables.cpp, in degrees, as that file holds it. It is
// the table ArduPilot itself reads once it knows where it is, and the one its
// simulated compass is built from, so a value interpolated from it is the value
// ArduPilot will arrive at.
//
//   node scripts/generate-declination.mjs --source DIR [--out FILE] [--check]
//
// --source  the ArduPilot checkout (default MIRAGE_ARDUPILOT_SOURCE); its HEAD
//           must be a commit in scripts/sitl.lock.json and its tables.cpp clean
// --check   regenerate and compare with the file instead of writing it; exit 1 on a difference
// Exit codes: 0 written or identical, 1 different or invalid upstream data, 2 missing source.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const TABLE_PATH = "libraries/AP_Declination/tables.cpp";
const LATITUDE_ROWS = 19, LONGITUDE_COLUMNS = 37;

/** The table of tables.cpp and its grid; throws when the file does not read as this script expects. */
export function declinationTable(source) {
  const constant = name => {
    const match = new RegExp(`AP_Declination::${name}\\s*=\\s*(-?\\d+)\\s*;`).exec(source);
    if (!match?.[1]) throw new Error(`tables.cpp has no ${name}`);
    return Number(match[1]);
  };
  const body = /AP_Declination::declination_table\[LAT_TABLE_SIZE\]\[LON_TABLE_SIZE\]\s*=\s*\{([\s\S]*?)\n\};/.exec(source);
  if (!body?.[1]) throw new Error("tables.cpp has no declination table");
  const rows = [...body[1].matchAll(/\{([^{}]*)\}/g)].map(row => (row[1] ?? "").split(",").map(cell => cell.trim()).filter(cell => cell !== "").map(cell => {
    const text = /^(-?\d+\.\d+)f$/.exec(cell)?.[1];
    if (text === undefined) throw new Error(`tables.cpp holds ${cell} in its declination table`);
    return Number(text);
  }));
  if (rows.length !== LATITUDE_ROWS || rows.some(row => row.length !== LONGITUDE_COLUMNS)) throw new Error(`The declination table is not ${LATITUDE_ROWS} by ${LONGITUDE_COLUMNS}`);
  const grid = { resolutionDeg: constant("SAMPLING_RES"), minLatitudeDeg: constant("SAMPLING_MIN_LAT"), maxLatitudeDeg: constant("SAMPLING_MAX_LAT"), minLongitudeDeg: constant("SAMPLING_MIN_LON"), maxLongitudeDeg: constant("SAMPLING_MAX_LON") };
  if (grid.minLatitudeDeg + (LATITUDE_ROWS - 1) * grid.resolutionDeg !== grid.maxLatitudeDeg || grid.minLongitudeDeg + (LONGITUDE_COLUMNS - 1) * grid.resolutionDeg !== grid.maxLongitudeDeg) throw new Error("The declination grid does not span its table");
  return { ...grid, rowsDeg: rows };
}

function main(argv) {
  const value = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const sourceDir = value("--source") ?? process.env.MIRAGE_ARDUPILOT_SOURCE, out = resolve(value("--out") ?? join(root, "data/ardupilot/declination.json")), check = argv.includes("--check");
  if (!sourceDir || !existsSync(join(sourceDir, TABLE_PATH))) { console.error(`BLOCKED_EXTERNAL: no ArduPilot checkout with ${TABLE_PATH}; pass --source DIR`); return 2; }
  const git = (...args) => execFileSync("git", ["-C", sourceDir, ...args], { encoding: "utf8" }).trim();
  const commit = git("rev-parse", "HEAD");
  const lock = readFileSync(join(root, "scripts/sitl.lock.json"), "utf8");
  if (!lock.includes(commit)) { console.error(`${commit} is not a commit in scripts/sitl.lock.json`); return 1; }
  if (git("status", "--porcelain", "--", TABLE_PATH) !== "") { console.error(`${TABLE_PATH} is not clean`); return 1; }
  const bytes = readFileSync(join(sourceDir, TABLE_PATH));
  const table = { schemaVersion: 1, commit, sourcePath: TABLE_PATH, sourceSha256: createHash("sha256").update(bytes).digest("hex"), ...declinationTable(bytes.toString("utf8")) };
  const rows = table.rowsDeg.map(row => `    ${JSON.stringify(row)}`).join(",\n");
  const text = `${JSON.stringify({ ...table, rowsDeg: [] }, null, 2).replace('"rowsDeg": []', `"rowsDeg": [\n${rows}\n  ]`)}\n`;
  if (check) {
    if (!existsSync(out) || readFileSync(out, "utf8") !== text) { console.error(`${out} differs from what ${commit} generates`); return 1; }
    console.log(`${out} is what ${commit} generates`);
    return 0;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`Wrote ${out} from ${commit}`);
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
