// TASK-117 (SPECS_SIMULATION_ENGINES "Multi-GNSS broadcast sky"): the Galileo, GLONASS and BeiDou sky of the IGS merged broadcast
// navigation file of 2026-11-07 (RINEX 3.04, mixed). Cold: it checks the file's SHA-256, unpacks it, selects one healthy record per
// satellite (the one whose reference time is nearest the reference epoch) and writes the data file and the TS module from the same
// values. Beside them it writes the checks' truth: the same satellites' records nearest the reference epoch ± 3, 6, 9 and 12 h, and
// the GPS records the YUMA almanac is checked against, each evaluated at its own reference time by the implementation below, which
// is separate from packages/sensors/src/gnss.ts. The file itself (10.8 MB unpacked) stays outside the repository.
//
//   node scripts/gnss-broadcast-elements.mjs --input BRDC00IGS_R_20263110000_01D_MN.rnx.gz [--check]
//
// --check regenerates both files and compares them byte for byte with the stored ones. Exit 0 written or equal, 1 a different file
// or stored output, 2 (BLOCKED_EXTERNAL) without the input.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = Object.freeze({
  file: "BRDC00IGS_R_20263110000_01D_MN.rnx.gz",
  bytes: 1246410,
  sha256: "3d67b94184459700c2b969e7f791b769d925fb3eefbb1f9d78f4f3d2586b8fa3",
  url: "https://igs.bkg.bund.de/root_ftp/IGS/BRDC/2026/311/BRDC00IGS_R_20263110000_01D_MN.rnx.gz",
  provider: "International GNSS Service (IGS), merged broadcast navigation data (BRDC), from the BKG data centre; freely available, IGS asks to be cited",
  format: "RINEX 3.04 mixed navigation",
  day: "2026-11-07 (day 311, GPS week 2443)",
});
const DATA_FILE = "data/gnss/broadcast-2026-311.json", MODULE_FILE = "packages/sensors/src/gnss-broadcast.ts";
const WEEK_S = 604800, HOUR_S = 3600;
/** The reference epoch: 2026-11-07 12:00:00 GPS time. */
const REFERENCE = Object.freeze({ gpsWeek: 2443, secondsOfWeek: 561600, gpsTime: "2026-11-07T12:00:00 GPST" });
const REFERENCE_S = REFERENCE.gpsWeek * WEEK_S + REFERENCE.secondsOfWeek;
const SELECTION = "For each Galileo, GLONASS and BeiDou satellite, the healthy record (Galileo: SV health 0 in an I/NAV record, data source bit 0 or 2; GLONASS: health Bn 0; BeiDou: SatH1 0) whose reference time (toe, or tb, in GPS time) is nearest the reference epoch, the earlier on a tie. Checks: each satellite's records of the same kind nearest the reference epoch +/- 3, 6, 9 and 12 h, within 1 h of the mark and at least 1 h from the selected record; for GPS (health 0) the records nearest the reference epoch and +/- 3, 6, 9 and 12 h.";

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1] ?? null; };
const input = option("--input"), check = argv.includes("--check");
if (!input || !existsSync(input)) {
  console.log(JSON.stringify({ status: "BLOCKED_EXTERNAL", reasons: [`Pass the approved file ${SOURCE.file} with --input PATH`] }, null, 2));
  process.exit(2);
}
const packed = readFileSync(input), sha256 = createHash("sha256").update(packed).digest("hex");
if (sha256 !== SOURCE.sha256 || packed.length !== SOURCE.bytes) {
  console.log(JSON.stringify({ status: "FAIL", reasons: [`${input} has SHA-256 ${sha256} and ${packed.length} bytes, not ${SOURCE.sha256} and ${SOURCE.bytes}`] }, null, 2));
  process.exit(1);
}
const lines = gunzipSync(packed).toString("ascii").split(/\r?\n/);

// The header: its version and leap seconds.
const headerEnd = lines.findIndex(line => line.slice(60).startsWith("END OF HEADER"));
if (headerEnd < 0 || !lines[0].startsWith("     3.04")) throw new Error("Not a RINEX 3.04 navigation file");
const leapLine = lines.slice(0, headerEnd).find(line => line.slice(60).startsWith("LEAP SECONDS"));
const LEAP_S = leapLine ? Number(leapLine.slice(0, 6)) : Number.NaN;
if (!Number.isInteger(LEAP_S)) throw new Error("The header has no LEAP SECONDS");

const number = text => { const t = text.trim(); return t === "" ? Number.NaN : Number(t.replace(/[dD]/, "E")); };
/** The 19-character fields of a record line from column `first` to column 80; a blank field is NaN. */
const fieldsOf = (line, first) => { const out = []; for (let c = first; c < 80; c += 19) out.push(number(line.slice(c, c + 19))); return out; };
const ORBIT_LINES = { G: 7, E: 7, C: 7, R: 3, J: 7, I: 7, S: 3 };

/** Every record of G, E, R and C as { system, prn, epoch: [y, m, d, h, mi, s], values: [...] }. */
const records = [];
for (let i = headerEnd + 1; i < lines.length;) {
  const line = lines[i];
  if (line.trim() === "") { i++; continue; }
  const system = line[0], count = ORBIT_LINES[system];
  if (count === undefined) throw new Error(`Line ${i + 1}: unknown system ${system}`);
  const epoch = line.slice(4, 23).trim().split(/\s+/).map(Number);
  const values = fieldsOf(line, 23).slice(0, 3);
  for (let k = 1; k <= count; k++) values.push(...fieldsOf(lines[i + k] ?? "", 4).slice(0, 4));
  if ("GERC".includes(system)) records.push({ system, prn: Number(line.slice(1, 3)), epoch, values });
  i += count + 1;
}

/** GPS seconds since the GPS epoch of a UTC calendar time. */
const gpsSecondsOfUtc = ([y, m, d, h, mi, s]) => (Date.UTC(y, m - 1, d, h, mi, 0) - Date.UTC(1980, 0, 6)) / 1000 + s + LEAP_S;
// Kepler records: values [af0, af1, af2, IODE, Crs, Δn, M0, Cuc, e, Cus, √A, toe, Cic, Ω0, Cis, i0, Crc, ω, Ω̇, IDOT, codes or data
// sources, week, flag, accuracy, health, TGD, TGD2, transmission time, fit or AODC].
const keplerOf = r => {
  const v = r.values;
  const week = v[21], toeS = v[11];
  const beidou = r.system === "C";
  const gpsS = (week + (beidou ? 1356 : 0)) * WEEK_S + toeS + (beidou ? 14 : 0);
  return {
    gpsS, health: v[24], source: v[20],
    element: {
      system: r.system, prn: r.prn, health: v[24], geo: beidou && (r.prn <= 5 || r.prn >= 59), week, toeS,
      sqrtA: v[10], eccentricity: v[8], inclinationRad: v[15], inclinationRateRadS: v[19], rightAscensionRad: v[13],
      rateOfRightAscensionRadS: v[18], argumentOfPerigeeRad: v[17], meanAnomalyRad: v[6], meanMotionDifferenceRadS: v[5],
      cuc: v[7], cus: v[9], crc: v[16], crs: v[4], cic: v[12], cis: v[14],
    },
  };
};
// GLONASS records: values [−τn, γn, message frame time, X, Ẋ, Ẍ, health, Y, Ẏ, Ÿ, channel, Z, Ż, Z̈, age], km, km/s, km/s².
const glonassOf = r => {
  const v = r.values, gpsS = gpsSecondsOfUtc(r.epoch);
  return {
    gpsS, health: v[6], source: 0,
    element: {
      system: "R", prn: r.prn, health: v[6], frequencyChannel: v[10], week: Math.floor(gpsS / WEEK_S), tbS: gpsS - Math.floor(gpsS / WEEK_S) * WEEK_S,
      positionM: [v[3] * 1000, v[7] * 1000, v[11] * 1000], velocityMps: [v[4] * 1000, v[8] * 1000, v[12] * 1000],
    },
  };
};
const usable = (system, c) => {
  if (c.health !== 0) return false;
  // Galileo: I/NAV records only (data source bit 0, E1-B, or bit 2, E5b-I).
  return system !== "E" || (c.source & 5) !== 0;
};
const candidates = new Map();
for (const r of records) {
  const c = r.system === "R" ? glonassOf(r) : keplerOf(r);
  for (const [k, x] of Object.entries(c.element)) if (typeof x === "number" && !Number.isFinite(x)) throw new Error(`${r.system}${r.prn} at ${r.epoch.join(" ")} has no ${k}`);
  if (!usable(r.system, c)) continue;
  const key = `${r.system}${String(r.prn).padStart(2, "0")}`;
  if (!candidates.has(key)) candidates.set(key, []);
  candidates.get(key).push(c);
}
const nearest = (list, t, within = Infinity, except = null) => {
  let best = null;
  for (const c of list) {
    if (Math.abs(c.gpsS - t) > within || (except !== null && Math.abs(c.gpsS - except) < HOUR_S)) continue;
    if (!best || Math.abs(c.gpsS - t) < Math.abs(best.gpsS - t) || (Math.abs(c.gpsS - t) === Math.abs(best.gpsS - t) && c.gpsS < best.gpsS)) best = c;
  }
  return best;
};

// A separate implementation of the broadcast Keplerian position at the record's own reference time (tk = 0): IS-GPS-200 for GPS,
// the Galileo OS SIS ICD, BDS-SIS-ICD-B1I-3.0 (with its GEO rotation by −5° about x), written as matrix products.
const CONSTANTS = { G: [3.986005e14, 7.2921151467e-5], E: [3.986004418e14, 7.2921151467e-5], C: [3.986004418e14, 7.292115e-5] };
const multiply = (m, v) => m.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
function keplerAtReference(el) {
  const [, earthRate] = CONSTANTS[el.system];
  const a = el.sqrtA ** 2, e = el.eccentricity;
  let E = el.meanAnomalyRad;
  for (let k = 0; k < 50; k++) E = el.meanAnomalyRad + e * Math.sin(E);
  const nu = 2 * Math.atan(Math.sqrt((1 + e) / (1 - e)) * Math.tan(E / 2));
  const phi = nu + el.argumentOfPerigeeRad;
  const u = phi + el.cuc * Math.cos(2 * phi) + el.cus * Math.sin(2 * phi);
  const r = a * (1 - e * Math.cos(E)) + el.crc * Math.cos(2 * phi) + el.crs * Math.sin(2 * phi);
  const i = el.inclinationRad + el.cic * Math.cos(2 * phi) + el.cis * Math.sin(2 * phi);
  const node = el.rightAscensionRad - earthRate * el.toeS;
  const rz = t => [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
  const rx = t => [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]];
  let position = multiply(rz(node), multiply(rx(i), [r * Math.cos(u), r * Math.sin(u), 0]));
  // A GEO orbit's frame into CGCS2000 by the ICD's matrix R_X(φ) = [[1, 0, 0], [0, cos φ, sin φ], [0, −sin φ, cos φ]], φ = −5°
  // (R_Z(Ω̇e·tk) is the identity at tk = 0).
  if (el.geo) { const f = -5 * Math.PI / 180; position = multiply([[1, 0, 0], [0, Math.cos(f), Math.sin(f)], [0, -Math.sin(f), Math.cos(f)]], position); }
  return position;
}

const ORDER = { E: 0, R: 1, C: 2, G: 3 };
const keys = [...candidates.keys()].sort((a, b) => ORDER[a[0]] - ORDER[b[0]] || a.localeCompare(b));
const satellites = [], checks = [];
const truthOf = c => (c.element.system === "R" ? c.element.positionM : keplerAtReference(c.element));
const checkOf = c => ({ system: c.element.system, prn: c.element.prn, gpsWeek: Math.floor(c.gpsS / WEEK_S), secondsOfWeek: c.gpsS - Math.floor(c.gpsS / WEEK_S) * WEEK_S, ecefM: truthOf(c) });
for (const key of keys) {
  const list = candidates.get(key);
  if (key[0] === "G") {
    for (const k of [-4, -3, -2, -1, 0, 1, 2, 3, 4]) { const c = nearest(list, REFERENCE_S + 3 * HOUR_S * k, HOUR_S); if (c) checks.push(checkOf(c)); }
    continue;
  }
  const selected = nearest(list, REFERENCE_S);
  satellites.push(selected.element);
  for (const k of [-4, -3, -2, -1, 1, 2, 3, 4]) {
    const c = nearest(list, REFERENCE_S + 3 * HOUR_S * k, HOUR_S, selected.gpsS);
    if (c) checks.push(checkOf(c));
  }
}
for (const s of satellites) if (s.system === "C" && s.geo !== (s.inclinationRad < 10 * Math.PI / 180)) throw new Error(`C${s.prn}: its PRN and its inclination disagree on GEO`);

const count = system => satellites.filter(s => s.system === system).length;
const data = { schemaVersion: 1, kind: "gnss-broadcast-sky", task: "TASK-117", source: { ...SOURCE, leapSeconds: LEAP_S }, referenceEpoch: REFERENCE, selection: SELECTION, satellites, checks };
// One satellite or check per line, so a regenerated file diffs by record.
const json = `{\n${Object.entries(data).map(([k, v]) => (Array.isArray(v)
  ? `  ${JSON.stringify(k)}: [\n${v.map(item => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`
  : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)).join(",\n")}\n}\n`;
const literal = item => `  { ${Object.entries(item).map(([k, v]) => `${k}: ${JSON.stringify(v).replaceAll(",", ", ")}`).join(", ")} },`;
const module = `import type { GlonassEphemeris, KeplerEphemeris } from "./gnss.ts";

// TASK-117 (SPECS_SIMULATION_ENGINES "Multi-GNSS broadcast sky"): generated by scripts/gnss-broadcast-elements.mjs from the IGS merged
// broadcast navigation file of 2026-11-07, with ${DATA_FILE} from the same values; do not edit by hand. One healthy record per
// Galileo, GLONASS and BeiDou satellite, the one nearest the reference epoch 2026-11-07 12:00:00 GPS time. Galileo and BeiDou weeks
// and toe are the systems' own; GLONASS tb is GPS time, its state in metres and metres per second.
// tests/gnss-broadcast.test.ts requires this module equal to the data file, and the data file's SHA-256 equal to the inventory's.

/** Where the records came from, and the reference epoch they were selected at. */
export const GNSS_BROADCAST_SOURCE = Object.freeze({
  file: ${JSON.stringify(SOURCE.file)},
  url: ${JSON.stringify(SOURCE.url)},
  sha256: ${JSON.stringify(SOURCE.sha256)},
  bytes: ${SOURCE.bytes},
  dataFile: ${JSON.stringify(DATA_FILE)},
  referenceWeek: ${REFERENCE.gpsWeek},
  referenceSecondsOfWeek: ${REFERENCE.secondsOfWeek},
});

const SATELLITES: (KeplerEphemeris | GlonassEphemeris)[] = [
${satellites.map(literal).join("\n")}
];
/** ${count("E")} Galileo, ${count("R")} GLONASS and ${count("C")} BeiDou satellites. */
export const GNSS_BROADCAST: readonly (KeplerEphemeris | GlonassEphemeris)[] = Object.freeze(SATELLITES.map(satellite => Object.freeze(satellite)));
`;
const outputs = [[DATA_FILE, json], [MODULE_FILE, module]];
const summary = { satellites: { E: count("E"), R: count("R"), C: count("C"), geo: satellites.filter(s => s.geo).length }, checks: checks.length, leapSeconds: LEAP_S };
if (check) {
  const differ = outputs.filter(([path, text]) => !existsSync(join(ROOT, path)) || readFileSync(join(ROOT, path), "utf8") !== text).map(([path]) => path);
  console.log(JSON.stringify({ status: differ.length ? "FAIL" : "EQUAL", differ, ...summary }, null, 2));
  process.exit(differ.length ? 1 : 0);
}
for (const [path, text] of outputs) writeFileSync(join(ROOT, path), text);
console.log(JSON.stringify({ status: "WRITTEN", files: outputs.map(([path]) => path), ...summary }, null, 2));
