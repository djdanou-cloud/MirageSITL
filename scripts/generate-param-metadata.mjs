#!/usr/bin/env node
// Generates data/ardupilot/param-metadata.json (TASK-159) offline from a
// clean ArduPilot checkout at a supported commit, with ArduPilot's own
// generator: Tools/autotest/param_metadata/param_parse.py --vehicle ArduCopter
// --format json, run in a temporary directory so the checkout stays clean.
// Each supported commit is one entry of the file; regenerating a commit
// replaces its entry and keeps the others. Per parameter the file keeps the
// group, display name, description, units, range, increment, values,
// bitmask, reboot-required, read-only, volatile and user-level fields of the
// upstream record and drops `path` and `Calibration`, which no MirageSITL
// consumer reads. An upstream field this script does not know fails the run,
// so a new field is never dropped silently. A range whose low end is above its
// high end is not repaired: it is left out of the record and listed under
// `anomalies` with its upstream values.
//
//   node scripts/generate-param-metadata.mjs --source DIR [--python PATH] [--out FILE] [--check]
//
// --source  the ArduPilot checkout (default MIRAGE_ARDUPILOT_SOURCE); its HEAD
//           must be a commit in scripts/sitl.lock.json and its tracked files clean
// --python  the interpreter for param_parse.py (default MIRAGE_SITL_PYTHON, else python3)
// --check   regenerate and compare with the file instead of writing it; exit 1 on a difference
// Exit codes: 0 written or identical, 1 different or invalid upstream data, 2 missing source or Python.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const METADATA_SCHEMA_VERSION = 1;
export const VEHICLE = "ArduCopter";
export const TOOL_FILES = ["param_parse.py", "param.py", "emit.py", "jsonemit.py"].map(file => `Tools/autotest/param_metadata/${file}`);
const KEPT = { DisplayName: "displayName", Description: "description", Units: "units", Range: "range", Increment: "increment", Values: "values",
  Bitmask: "bitmask", RebootRequired: "rebootRequired", ReadOnly: "readOnly", Volatile: "volatile", User: "user" };
const DROPPED = new Set(["path", "Calibration"]);
const FLAGS = new Set(["RebootRequired", "ReadOnly", "Volatile"]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function number(text, where) {
  if (typeof text !== "string" || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text.trim())) throw new Error(`${where}: ${JSON.stringify(text)} is not a number`);
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`${where}: ${text} is not finite`);
  return value;
}
function labels(map, where, integer) {
  if (typeof map !== "object" || map === null || Array.isArray(map)) throw new Error(`${where}: an object of labels expected`);
  const entries = Object.entries(map).map(([key, label]) => {
    if (typeof label !== "string") throw new Error(`${where}.${key}: the label is not text`);
    const value = number(key, `${where}.${key}`);
    if (integer && (!Number.isInteger(value) || value < 0 || value > 63)) throw new Error(`${where}.${key}: not a bit number`);
    return [value, label];
  });
  return entries.sort((a, b) => a[0] - b[0]);
}

/** Converts param_parse.py's apm.pdef.json into the MirageSITL record of one commit. */
export function convert(raw, commit) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("apm.pdef.json is not an object");
  const parameters = {};
  const anomalies = [];
  for (const [group, members] of Object.entries(raw)) {
    if (group === "json") continue; // {"version": 0}, the emitter's format version
    if (typeof members !== "object" || members === null) throw new Error(`Group ${group} is not an object`);
    for (const [name, record] of Object.entries(members)) {
      if (!/^[\x21-\x7e]{1,16}$/.test(name)) throw new Error(`Parameter name ${JSON.stringify(name)} is not 1 to 16 printable characters`);
      if (Object.hasOwn(parameters, name)) throw new Error(`Parameter ${name} appears in two groups`);
      if (typeof record !== "object" || record === null) throw new Error(`${name} is not an object`);
      const out = { group };
      for (const [key, value] of Object.entries(record)) {
        const where = `${name}.${key}`;
        if (DROPPED.has(key)) continue;
        if (!Object.hasOwn(KEPT, key)) throw new Error(`${where}: unknown upstream field`);
        if (FLAGS.has(key)) {
          if (value !== "True") throw new Error(`${where}: ${JSON.stringify(value)} where only "True" is known`);
          out[KEPT[key]] = true;
        } else if (key === "Range") {
          if (typeof value !== "object" || value === null || Object.keys(value).sort().join() !== "high,low") throw new Error(`${where}: low and high expected`);
          const low = number(value.low, `${where}.low`), high = number(value.high, `${where}.high`);
          if (low > high) anomalies.push({ name, field: "Range", upstream: { low: value.low, high: value.high }, reason: "low is above high; the range is left out" });
          else out.range = [low, high];
        } else if (key === "Increment") {
          out.increment = number(value, where);
        } else if (key === "Values" || key === "Bitmask") {
          out[KEPT[key]] = labels(value, where, key === "Bitmask");
        } else if (key === "User") {
          if (value !== "Standard" && value !== "Advanced") throw new Error(`${where}: unknown user level ${JSON.stringify(value)}`);
          out.user = value;
        } else {
          if (typeof value !== "string") throw new Error(`${where}: text expected`);
          out[KEPT[key]] = value;
        }
      }
      if (typeof out.displayName !== "string" || typeof out.description !== "string") throw new Error(`${name}: no display name or description`);
      parameters[name] = out;
    }
  }
  const names = Object.keys(parameters).sort();
  return { commit, vehicle: VEHICLE, parameterCount: names.length, anomalies: anomalies.sort((a, b) => a.name < b.name ? -1 : 1),
    parameters: Object.fromEntries(names.map(name => [name, parameters[name]])) };
}

/** One parameter per line, so a regeneration diffs by parameter. */
export function serialize(file) {
  const lines = ["{", `"schemaVersion":${file.schemaVersion},`, `"generator":${JSON.stringify(file.generator)},`, `"license":${JSON.stringify(file.license)},`, `"versions":[`];
  file.versions.forEach((version, i) => {
    const { parameters, ...head } = version;
    lines.push(`${JSON.stringify(head).slice(0, -1)},"parameters":{`);
    const names = Object.keys(parameters);
    names.forEach((name, j) => lines.push(`${JSON.stringify(name)}:${JSON.stringify(parameters[name])}${j + 1 < names.length ? "," : ""}`));
    lines.push(`}}${i + 1 < file.versions.length ? "," : ""}`);
  });
  lines.push("]}");
  return `${lines.join("\n")}\n`;
}

function option(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

export function main(args) {
  const known = new Set(["--source", "--python", "--out", "--check"]);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`Unknown argument ${args[i]}`);
    if (args[i] !== "--check") i++;
  }
  const sourceOption = option(args, "--source") ?? process.env.MIRAGE_ARDUPILOT_SOURCE;
  const source = sourceOption === undefined ? undefined : resolve(sourceOption);
  const python = option(args, "--python") ?? process.env.MIRAGE_SITL_PYTHON ?? "python3";
  const out = resolve(option(args, "--out") ?? join(root, "data/ardupilot/param-metadata.json"));
  const check = args.includes("--check");
  if (!source || !existsSync(join(source, TOOL_FILES[0]))) {
    console.error("BLOCKED_EXTERNAL: no ArduPilot checkout with Tools/autotest/param_metadata (pass --source or MIRAGE_ARDUPILOT_SOURCE)");
    return 2;
  }
  const lock = JSON.parse(readFileSync(join(root, "scripts/sitl.lock.json"), "utf8"));
  const supported = [lock.commit];
  const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!supported.includes(commit)) throw new Error(`The checkout is at ${commit}, which scripts/sitl.lock.json does not support`);
  if (execFileSync("git", ["-C", source, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "") throw new Error("The checkout has modified tracked files");
  const work = mkdtempSync(join(tmpdir(), "mirage-param-metadata-"));
  let raw;
  try {
    // -E -s: no PYTHON* variables and no user site; the script's own directory stays on sys.path for its sibling modules.
    const run = spawnSync(python, ["-E", "-s", join(source, TOOL_FILES[0]), "--vehicle", VEHICLE, "--format", "json"], { cwd: work, encoding: "utf8", maxBuffer: 64 << 20 });
    if (run.error?.code === "ENOENT") { console.error(`BLOCKED_EXTERNAL: Python ${python} was not found`); return 2; }
    if (run.status !== 0) throw new Error(`param_parse.py exited ${run.status}: ${run.stderr.slice(-2000)}`);
    raw = readFileSync(join(work, "apm.pdef.json"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const version = convert(JSON.parse(raw.toString("utf8")), commit);
  version.upstreamSha256 = sha256(raw);
  version.toolSha256 = Object.fromEntries(TOOL_FILES.map(file => [file, sha256(readFileSync(join(source, file)))]));
  const previous = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  const others = (previous?.versions ?? []).filter(entry => entry.commit !== commit);
  const file = {
    schemaVersion: METADATA_SCHEMA_VERSION,
    generator: { script: "scripts/generate-param-metadata.mjs", tool: `${TOOL_FILES[0]} --vehicle ${VEHICLE} --format json` },
    license: "GPL-3.0-or-later: generated from the ArduPilot source (https://github.com/ArduPilot/ardupilot, COPYING.txt)",
    versions: [...others, version].sort((a, b) => a.commit < b.commit ? -1 : 1),
  };
  const text = serialize(file);
  const summary = `${commit}: ${version.parameterCount} parameters, ${version.anomalies.length} anomalies, upstream ${version.upstreamSha256}`;
  if (check) {
    const same = existsSync(out) && readFileSync(out, "utf8") === text;
    console.log(`${same ? "identical" : "DIFFERENT"} ${out} (${summary})`);
    return same ? 0 : 1;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out} (${summary}, ${Buffer.byteLength(text)} bytes)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
