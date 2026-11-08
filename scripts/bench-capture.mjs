// TASK-090, the bench half: writes the two bench-test captures (capture schema 3) and their model descriptions, as declared in
// SPECS_SIMULATION_ENGINES "Capture schema 3 and the bench-test captures":
//  - T-Motor's datasheet table for MN7005 KV230 with P24*7.2 (manufacturer static-stand data) beside the forum quad's uncalibrated
//    BET rotor, bound as BetFlightDynamics binds it in flight, solved statically on the scalar BET module;
//  - the UIUC DA4002/DA4022 static tests (laboratory static-stand data) beside the uiuc-propeller-bet-inflow-v1 path of
//    scripts/validate-models.mjs, the native steady runner with the flight model's dynamic inflow.
// Cold evidence tooling: it builds the BET module and the native runner, and never runs in a physics step.
//
//   node scripts/bench-capture.mjs [--out DIR]
//
// Writes <name>-capture.json and <name>-model.json for both captures into test-results/validation/ (or DIR) and prints their
// SHA-256. Each capture's modelSha256 is the SHA-256 of its model description's bytes. Exit 0 when written, 1 on any error.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { outputDirectory } from "./validation/evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const read = path => readFileSync(join(root, path));
const json = path => JSON.parse(read(path).toString("utf8"));
const NO_FIRMWARE = "0".repeat(64);
const TMOTOR = {
  name: "bench-tmotor-mn7005-p24x72", section: "mn7005-kv230-p24x72",
  benchCsv: "tests/fixtures/components/tmotor-mn7005-kv230-p24x72.csv",
  profile: "tests/fixtures/aircraft/tmotor-mn7005-quad.json",
  cards: { motor: "tests/fixtures/components/tmotor-mn7005-kv230.json", propeller: "tests/fixtures/components/tmotor-p24x72.json",
    esc: "tests/fixtures/components/tmotor-alpha-40a.json", battery: "tests/fixtures/components/battery-6s-42ah-forum-144558.json" },
  polar: "naca6409-neuralfoil-v1", modelId: 145, densityKgM3: 1.225,
  operator: "T-Motor (manufacturer datasheet)", recordedAt: "2026-07-28T00:00:00Z",
};
const UIUC = {
  name: "bench-uiuc-da4002-da4022-static", fixture: "tests/fixtures/rotors/uiuc-propellers.json", inventory: "data/uiuc-propdb/inventory.json",
  extendedPolar: "tests/fixtures/polars/sda1075-extended.json", xfoilPolar: "tests/fixtures/polars/sda1075-xfoil.json",
  runner: ["run", "-q", "--release", "--locked", "-p", "mirage-bet", "--example", "propeller_points", "--", "--dynamic-inflow"],
  operator: "UIUC Applied Aerodynamics Group (Brandt, Deters, Ananda, Dantsker, Selig)", recordedAt: "2022-06-27T00:00:00Z",
};
/** Rotor flags word bits (native/bet/src/abi.rs, polar.rs, bound.rs) and their model-flag names; informational bits are refused here. */
const ROTOR_FLAG_NAMES = [[2, "outside-polar"], [4, "low-confidence-polar"], [8, "outside-inflow-validity"]];

function flagNames(word, outsideInflow = false) {
  let rest = word;
  const names = [];
  for (const [bit, name] of ROTOR_FLAG_NAMES) if ((rest & bit) !== 0) { names.push(name); rest &= ~bit; }
  if (rest !== 0 || !Number.isInteger(word) || word < 0) throw new Error(`Unexpected rotor flags word ${word}`);
  if (outsideInflow && !names.includes("outside-inflow-validity")) names.push("outside-inflow-validity");
  return names;
}
/** The shortest decimal that reads back to the same float64; bench CSV v1 takes no exponent. */
function decimal(value) {
  const text = String(value);
  if (!Number.isFinite(value) || /e/i.test(text) || Number(text) !== value) throw new Error(`Cannot print ${value} as a bench CSV decimal`);
  return text;
}
const capture = (provenance, sections) => ({ schemaVersion: 3, kind: "mirage-fidelity-capture", provenance, timeDomain: [], frequencyResponse: [], bench: sections });
const text = value => `${JSON.stringify(value, null, 1)}\n`;

async function modules() {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
  const outfile = join(root, ".cache/bench-capture/entry.mjs");
  mkdirSync(dirname(outfile), { recursive: true });
  await build({ stdin: { contents: `
export { validateAircraftProfile, withPropellerPolars } from './packages/aircraft/src/profile.ts';
export { validateComponentCard } from './packages/aircraft/src/components.ts';
export { resolveComponents } from './packages/aircraft/src/resolve-components.ts';
export { deriveVehicleManifest } from './packages/aircraft/src/derive-manifest.ts';
export { derivePropellerGeometry } from './packages/aircraft/src/propeller-geometry.ts';
export { buildProfileDynamics, profileRotorDefinition } from './packages/physics/src/profile-dynamics.ts';
export { importBenchCsv, importBenchMeasurements } from './packages/physics/src/bench-import.ts';
export { staticLoads } from './packages/physics/src/propulsion-calibration.ts';
export { isaTroposphere } from './packages/physics/src/atmosphere.ts';
export { parseUiucPropellerFixture, extendedChoice, betRequest, parseBetResponse } from './packages/physics/src/uiuc-propeller.ts';
export { parseNeuralFoilPolar } from './packages/wasm-bet/src/rotor.ts';`, resolveDir: root, sourcefile: "bench-capture-entry.ts", loader: "ts" },
  bundle: true, platform: "node", format: "esm", outfile, logLevel: "error" });
  return import(pathToFileURL(outfile).href);
}

/** Bench CSV v1 from the v2 file: its diameter, each row's rpm, thrust and torque as text, and its stated density in every row. */
function tmotorCsv(M) {
  const v2 = read(TMOTOR.benchCsv).toString("utf8");
  const measured = M.importBenchMeasurements(v2);
  if (measured.airDensityKgM3 !== TMOTOR.densityKgM3) throw new Error("The T-Motor file's density is not the declared 1.225 kg/m³");
  const lines = v2.split(/\r?\n/).filter(line => line.length > 0);
  const header = lines.findIndex(line => line.startsWith("rpm,"));
  const columns = lines[header].split(",");
  const at = name => { const i = columns.indexOf(name); if (i < 0) throw new Error(`The T-Motor file has no ${name} column`); return i; };
  const diameter = lines.find(line => line.startsWith("diameterM,"))?.split(",")[1];
  const density = lines.find(line => line.startsWith("airDensityKgM3,"))?.split(",")[1];
  if (!diameter || !density) throw new Error("The T-Motor file lacks its diameter or density");
  const rows = lines.slice(header + 1).map(line => { const f = line.split(","); return [f[at("rpm")], f[at("thrustN")], f[at("torqueNm")], density].join(","); });
  if (rows.length !== measured.points.length) throw new Error("The T-Motor rows do not match the v2 import");
  return { csv: `mirage-bench-csv,1\ndiameterM,${diameter}\nrpm,thrustN,torqueNm,airDensityKgM3\n${rows.join("\n")}\n`, diameterM: Number(diameter) };
}

async function tmotor(M, wasm) {
  const files = { benchCsv: TMOTOR.benchCsv, profile: TMOTOR.profile, ...TMOTOR.cards };
  // Card keys stand in for store hashes, as tests/tmotor-bench-fit.test.ts does; the cards themselves are hashed below.
  const keys = { motor: "11".repeat(32), propeller: "22".repeat(32), esc: "33".repeat(32), battery: "44".repeat(32) };
  const cards = new Map(Object.entries(TMOTOR.cards).map(([kind, path]) => [keys[kind], M.validateComponentCard(json(path))]));
  const fixture = M.validateAircraftProfile(json(TMOTOR.profile));
  const profile = M.withPropellerPolars(M.validateAircraftProfile({ ...fixture, battery: { card: keys.battery },
    motors: fixture.motors.map(item => ({ ...item, components: { motor: keys.motor, propeller: keys.propeller, esc: keys.esc } })) }),
  [{ card: keys.propeller, polar: TMOTOR.polar }]);
  const resolved = M.resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`The T-Motor profile lacks: ${resolved.missing.join("; ")}`);
  const derived = await M.deriveVehicleManifest(profile, resolved.components, { modelId: TMOTOR.modelId });
  const built = M.buildProfileDynamics(derived.manifest, { syntheticPad: true });
  const { configuration } = built;
  // The rotor as BetFlightDynamics binds rotor 0 in flight (flightRotorDefinition in bet-dynamics.ts), which TASK-145 also fits since 2026-11-08.
  const rotor = M.profileRotorDefinition(configuration, 0);
  if (!rotor.dynamicInflow) throw new Error("The profile build does not fly dynamic inflow");
  const isa = M.isaTroposphere(0);
  const air = { densityKgM3: TMOTOR.densityKgM3, viscosityPaS: isa.dynamicViscosityPaS, soundMps: isa.speedOfSoundMps };
  const { csv, diameterM } = tmotorCsv(M);
  const points = M.importBenchCsv(csv).points;
  const loads = M.staticLoads(new WebAssembly.Module(wasm.bytes), rotor, air, points.map(point => point.rpm));
  const predicted = points.map((point, i) => {
    const n = point.rpm / 60, q = air.densityKgM3 * n * n;
    return { rpm: point.rpm, ct: loads.thrustN[i] / (q * diameterM ** 4), cp: 2 * Math.PI * loads.torqueNm[i] / (q * diameterM ** 5),
      modelFlags: flagNames(loads.flags[i]) };
  });
  const geometry = M.derivePropellerGeometry(json(TMOTOR.cards.propeller));
  const model = {
    schemaVersion: 1, kind: "mirage-bench-model", capture: `${TMOTOR.name}-capture.json`, task: "TASK-090",
    method: "The forum quad profile's rotor 0, uncalibrated, bound as BetFlightDynamics binds it in flight, solved statically by staticLoads (packages/physics/src/propulsion-calibration.ts: 400 steps at 800 Hz on a 1e6 kg·m² shaft) at each measured rpm; CT = T/(ρn²D⁴), CP = 2πQ/(ρn²D⁵). Not the TASK-145 calibration, which is fitted on this same table.",
    // The module's bytes differ between hosts built from the same sources (macOS and the Linux CI runner, 2026-11-08), so the
    // host-independent identity of the code is the sources digest; sha256 is the module this host built and ran.
    betModule: { file: "packages/wasm-bet/dist/mirage_bet.scalar.wasm", sha256: wasm.sha256, toolchain: wasm.toolchain, sources: nativeDigest(),
      hashNote: "sha256 is the module built on the recording host; WASM builds of the same sources differ between hosts, so sources identifies the code" },
    vehicleManifestSha256: derived.sha256, modelId: TMOTOR.modelId, rotorIndex: 0, polar: TMOTOR.polar,
    rotor: { dynamicInflow: rotor.dynamicInflow, vortexRingSeed: rotor.vortexRingSeed ?? null, minimumConfidence: rotor.minimumConfidence,
      definitionSha256: sha256(JSON.stringify(rotor)) },
    air, diameterM,
    geometryAssumptions: geometry.assumptions.map(note => note.id), geometryFlags: geometry.flags.map(note => note.id),
    inflowNote: "Since 2026-11-08 profileRotorDefinition returns the flight's own binding (flightRotorDefinition), so this capture and TASK-145's static solve bind the rotor with dynamic inflow, as flight does; before, TASK-145 bound it without.",
    inputs: Object.fromEntries(Object.entries(files).map(([kind, path]) => [kind, { path, sha256: sha256(read(path)) }])),
  };
  const modelText = text(model);
  const provenance = { source: "bench-test", operator: TMOTOR.operator, recordedAt: TMOTOR.recordedAt, firmwareSha256: NO_FIRMWARE, modelSha256: sha256(modelText) };
  return { name: TMOTOR.name, modelText, captureText: text(capture(provenance, [{ id: TMOTOR.section, csv, csvSha256: sha256(csv), predicted }])) };
}

/** SHA-256 of the sorted "path TAB sha256 LF" lines of the native sources the runner builds. */
function nativeDigest() {
  const paths = execFileSync("git", ["ls-files", "native/bet", "native/Cargo.toml", "native/Cargo.lock", "native/rust-toolchain.toml"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(path => path.length > 0).sort();
  if (paths.length === 0) throw new Error("No native sources are tracked");
  return { files: paths.length, sha256: sha256(paths.map(path => `${path}\t${sha256(read(path))}\n`).join("")) };
}

function uiuc(M) {
  const fixtureBytes = read(UIUC.fixture), payload = JSON.parse(fixtureBytes.toString("utf8"));
  const fixture = M.parseUiucPropellerFixture(payload), inventoryBytes = read(UIUC.inventory), inventory = JSON.parse(inventoryBytes.toString("utf8"));
  if (inventory.dataSha256 !== payload.archive?.dataSha256 || inventory.datasetId !== fixture.datasetId) throw new Error("The UIUC fixture does not match its inventory");
  const tableBytes = read(UIUC.extendedPolar), table = JSON.parse(tableBytes.toString("utf8")), xfoilSha256 = sha256(read(UIUC.xfoilPolar));
  if (table.source?.sha256 !== xfoilSha256) throw new Error("The extended polar does not match its XFOIL source");
  // validate-models passes the registry's source hash of the table; that is the SHA-256 of its bytes.
  const choice = M.extendedChoice(M.parseNeuralFoilPolar(table), xfoilSha256, sha256(tableBytes), true);
  const propellers = fixture.propellers.filter(p => p.static !== null);
  if (propellers.length !== fixture.propellers.length) throw new Error("A UIUC propeller has no static table");
  // Only the static points: the request builder queues each propeller's runs before its static table.
  const request = M.betRequest({ ...fixture, propellers: propellers.map(p => ({ ...p, runs: [] })) }, choice.table);
  const count = propellers.reduce((sum, p) => sum + p.static.points.length, 0);
  const results = M.parseBetResponse(execFileSync("cargo", UIUC.runner, { cwd: join(root, "native"), input: request, encoding: "utf8", maxBuffer: 1 << 26 }), count);
  const { densityKgM3, viscosityPaS, soundSpeedMps } = fixture.comparison;
  let k = 0;
  const sections = propellers.map(p => {
    const D = p.diameterM, rows = [], predicted = [];
    for (const [rpm, ct, cp] of p.static.points) {
      const result = results[k++];
      if (!result?.ok) throw new Error(`The runner did not solve ${p.id} at ${rpm} rpm`);
      const n = rpm / 60, q = densityKgM3 * n * n;
      rows.push([decimal(rpm), decimal(ct * q * D ** 4), decimal(cp / (2 * Math.PI) * q * D ** 5), decimal(densityKgM3)].join(","));
      predicted.push({ rpm, ct: result.ct, cp: result.cp, modelFlags: flagNames(result.polarFlags, result.outsideMomentumValidity) });
    }
    const csv = `mirage-bench-csv,1\ndiameterM,${decimal(D)}\nrpm,thrustN,torqueNm,airDensityKgM3\n${rows.join("\n")}\n`;
    const imported = M.importBenchCsv(csv).points;
    imported.forEach((point, i) => { if (point.rpm !== predicted[i].rpm) throw new Error(`The CSV rpm of ${p.id} row ${i + 1} does not read back`); });
    return { id: p.id.replaceAll(".", "p"), csv, csvSha256: sha256(csv), predicted };
  });
  const model = {
    schemaVersion: 1, kind: "mirage-bench-model", capture: `${UIUC.name}-capture.json`, task: "TASK-090",
    method: "Adapter uiuc-propeller-bet-inflow-v1 of scripts/validate-models.mjs on the static tables only: the blade from r/R 0.3 (28 strips of the measured chord and twist, 8 azimuth samples), the extended SDA1075 polar with rotational augmentation, and the flight model's dynamic inflow marched to a steady state at J = 0.",
    runner: { cwd: "native", command: ["cargo", ...UIUC.runner].join(" "), sources: nativeDigest() },
    requestSha256: sha256(request), points: count, polar: choice.report,
    air: { densityKgM3, viscosityPaS, soundMps: soundSpeedMps },
    csvConversion: "T = CT·ρn²D⁴ and Q = CP/(2π)·ρn²D⁵ with ρ = 1.225 kg/m³ and the fixture's D; importBenchCsv divides by the same ρ and D, so the density cancels.",
    sections: propellers.map(p => ({ id: p.id.replaceAll(".", "p"), propeller: p.id, diameterM: p.diameterM, source: p.static.source, sha256: p.static.sha256 })),
    inputs: { fixture: { path: UIUC.fixture, sha256: sha256(fixtureBytes) }, inventory: { path: UIUC.inventory, sha256: sha256(inventoryBytes) },
      extendedPolar: { path: UIUC.extendedPolar, sha256: sha256(tableBytes) }, xfoilPolar: { path: UIUC.xfoilPolar, sha256: xfoilSha256 } },
  };
  const modelText = text(model);
  const provenance = { source: "bench-test", operator: UIUC.operator, recordedAt: UIUC.recordedAt, firmwareSha256: NO_FIRMWARE, modelSha256: sha256(modelText) };
  return { name: UIUC.name, modelText, captureText: text(capture(provenance, sections)) };
}

async function main() {
  const out = resolve(root, outputDirectory("test-results/validation"));
  execFileSync(process.execPath, [join(root, "scripts/build-wasm.mjs")], { cwd: root, stdio: "pipe" });
  const manifest = json("packages/wasm-bet/dist/manifest.json"), scalar = manifest.artifacts.find(item => item.variant === "scalar");
  const bytes = read("packages/wasm-bet/dist/mirage_bet.scalar.wasm");
  if (!scalar || scalar.sha256 !== sha256(bytes)) throw new Error("The scalar BET module does not match its manifest");
  const M = await modules();
  const written = [await tmotor(M, { bytes, sha256: scalar.sha256, toolchain: manifest.toolchain }), uiuc(M)];
  mkdirSync(out, { recursive: true });
  const summary = [];
  for (const item of written) {
    for (const [suffix, body] of [["model", item.modelText], ["capture", item.captureText]]) {
      const path = join(out, `${item.name}-${suffix}.json`);
      writeFileSync(path, body);
      summary.push({ path, sha256: sha256(body) });
    }
  }
  console.log(JSON.stringify(summary, null, 1));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
