// TASK-086: load the UIUC-derived propeller definitions in the pinned native
// JSBSim v1.2.3 and check FGPropeller thrust/power against the measured rows.
// Exit 0 pass, 1 failed check, 2 BLOCKED_EXTERNAL (no verified checkout/toolchain).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCheckout } from "./build-jsbsim.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
/** ISA sea-level density 1.225 kg/m^3 in slug/ft^3 (1 slug/ft^3 = 515.3788183932 kg/m^3). */
export const ISA_SEA_LEVEL_SLUG_FT3 = 1.225 / 515.3788183932;
/** DoD: thrust within 1% of the measured CT; power is checked the same way. */
export const RELATIVE_TOLERANCE = 0.01;

/** Rows [J, coefficient] of one internal JSBSim table, as printed. */
export function parseTable(xml, name) {
  const match = new RegExp(
    `<table name="${name}" type="internal">\\s*<tableData>([\\s\\S]*?)</tableData>`,
  ).exec(xml);
  if (!match) throw new Error(`Missing table ${name}`);
  const rows = match[1]
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  if (
    rows.length < 2 ||
    rows.some((r) => r.length !== 2 || !r.every(Number.isFinite)) ||
    rows.some((r, i) => i > 0 && r[0] <= rows[i - 1][0])
  )
    throw new Error(`Invalid table ${name}`);
  return rows;
}
/** Linear interpolation, held at the ends (JSBSim FGTable 1-D behavior). */
export function interpolate(rows, j) {
  if (j <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++)
    if (j <= rows[i][0]) {
      const [j0, c0] = rows[i - 1],
        [j1, c1] = rows[i];
      return c0 + ((c1 - c0) * (j - j0)) / (j1 - j0);
    }
  return rows.at(-1)[1];
}
/**
 * Declared before running: the static row, the measured row whose CT is
 * closest to half the static CT, and the midpoint between that row and the next.
 */
export function selectAdvanceRatios(thrustRows) {
  const half = thrustRows[0][1] / 2;
  let k = 1;
  for (let i = 1; i < thrustRows.length - 1; i++)
    if (Math.abs(thrustRows[i][1] - half) < Math.abs(thrustRows[k][1] - half)) k = i;
  return [
    { kind: "static-row", advanceRatio: thrustRows[0][0] },
    { kind: "advancing-row", advanceRatio: thrustRows[k][0] },
    {
      kind: "interpolated",
      advanceRatio: (thrustRows[k][0] + thrustRows[k + 1][0]) / 2,
    },
  ];
}
/** Compares one probe point with the measured tables. */
export function evaluatePoint(point, thrustRows, powerRows, diameterFt) {
  const n = point.rpm / 60,
    rho = point.densitySlugFt3,
    ct = interpolate(thrustRows, point.requestedJ),
    cp = interpolate(powerRows, point.requestedJ),
    expectedThrustLbf = ct * rho * n * n * diameterFt ** 4,
    expectedPowerFtLbfPerS = cp * rho * n ** 3 * diameterFt ** 5,
    thrustError = Math.abs(point.thrustLbf - expectedThrustLbf) / Math.abs(expectedThrustLbf),
    powerError =
      Math.abs(point.powerFtLbfPerS - expectedPowerFtLbfPerS) / Math.abs(expectedPowerFtLbfPerS),
    densityError = Math.abs(rho - ISA_SEA_LEVEL_SLUG_FT3) / ISA_SEA_LEVEL_SLUG_FT3,
    advanceRatioError = Math.abs(point.advanceRatio - point.requestedJ);
  return {
    rpm: point.rpm,
    advanceRatio: point.requestedJ,
    measuredCt: ct,
    measuredCp: cp,
    thrustLbf: point.thrustLbf,
    expectedThrustLbf,
    thrustRelativeError: thrustError,
    powerRelativeError: powerError,
    densityRelativeError: densityError,
    advanceRatioError,
    passed:
      thrustError <= RELATIVE_TOLERANCE &&
      powerError <= RELATIVE_TOLERANCE &&
      densityError <= 1e-4 &&
      advanceRatioError <= 1e-9,
  };
}
const ENGINE = `<?xml version="1.0"?>
<!-- Probe-only electric engine; power is irrelevant: thrust is read before RPM integration. -->
<electric_engine name="probe_electric">
  <power unit="WATTS"> 1000.0 </power>
</electric_engine>
`;
function aircraft(name, propellerFile) {
  return `<?xml version="1.0"?>
<!-- TASK-086 load probe; not a flight model. -->
<fdm_config name="${name}" version="2.0" release="ALPHA">
  <metrics>
    <wingarea unit="FT2"> 1 </wingarea>
    <wingspan unit="FT"> 1 </wingspan>
    <chord unit="FT"> 1 </chord>
    <location name="AERORP" unit="IN"><x> 0 </x><y> 0 </y><z> 0 </z></location>
  </metrics>
  <mass_balance>
    <ixx unit="SLUG*FT2"> 1 </ixx>
    <iyy unit="SLUG*FT2"> 1 </iyy>
    <izz unit="SLUG*FT2"> 1 </izz>
    <emptywt unit="LBS"> 10 </emptywt>
    <location name="CG" unit="IN"><x> 0 </x><y> 0 </y><z> 0 </z></location>
  </mass_balance>
  <ground_reactions>
    <!-- Required by the loader; structural +Z is up, so this point never touches the ground. -->
    <contact type="BOGEY" name="UNUSED">
      <location unit="IN"><x> 0 </x><y> 0 </y><z> 1000 </z></location>
      <static_friction> 0 </static_friction>
      <dynamic_friction> 0 </dynamic_friction>
      <rolling_friction> 0 </rolling_friction>
      <spring_coeff unit="LBS/FT"> 1 </spring_coeff>
      <damping_coeff unit="LBS/FT/SEC"> 1 </damping_coeff>
      <max_steer unit="DEG"> 0 </max_steer>
      <brake_group> NONE </brake_group>
      <retractable> 0 </retractable>
    </contact>
  </ground_reactions>
  <propulsion>
    <engine file="probe_electric">
      <thruster file="${propellerFile}">
        <location unit="IN"><x> 0 </x><y> 0 </y><z> 0 </z></location>
        <orient unit="DEG"><roll> 0 </roll><pitch> 0 </pitch><yaw> 0 </yaw></orient>
      </thruster>
    </engine>
  </propulsion>
  <aerodynamics>
    <!-- Zero drag: the loader needs an axis; the probe isolates the propeller. -->
    <axis name="DRAG">
      <function name="aero/coefficient/CD">
        <product><property>aero/qbar-psf</property><property>metrics/Sw-sqft</property><value> 0 </value></product>
      </function>
    </axis>
  </aerodynamics>
</fdm_config>
`;
}
function blocked(reason) {
  console.error(`BLOCKED_EXTERNAL: ${reason}`);
  process.exitCode = 2;
}
export function run() {
  const lock = JSON.parse(readFileSync(join(root, "native/jsbsim/source.lock.json"), "utf8")),
    source = process.env.JSBSIM_SOURCE_DIR ?? "/workspace/.cache/mirage-jsbsim";
  if (!existsSync(join(source, "COPYING")))
    return blocked(`no JSBSim checkout at ${source} (set JSBSIM_SOURCE_DIR)`);
  verifyCheckout(source, lock.commit);
  if (sha(readFileSync(join(source, "COPYING"))) !== lock.licenseSha256)
    throw new Error("JSBSim license checksum mismatch");
  const cmake = process.env.MIRAGE_CMAKE ?? "cmake",
    build = process.env.MIRAGE_JSBSIM_PROPELLER_BUILD ?? join(dirname(source), "mirage-jsbsim-propeller");
  execFileSync(cmake, ["-S", join(root, "native/jsbsim"), "-B", build, `-DJSBSIM_SOURCE_DIR=${source}`, "-DCMAKE_BUILD_TYPE=Release"], { stdio: "inherit" });
  execFileSync(cmake, ["--build", build, "--target", "mirage_jsbsim_propeller_probe", "--parallel", "4"], { stdio: "inherit" });
  const probe = join(build, "mirage_jsbsim_propeller_probe"),
    manifestBytes = readFileSync(join(root, "data/jsbsim/engine/uiuc-propellers.manifest.json")),
    manifest = JSON.parse(manifestBytes.toString("utf8")),
    work = mkdtempSync(join(tmpdir(), "mirage-jsbsim-propellers-")),
    propellers = [];
  try {
    mkdirSync(join(work, "engine"));
    writeFileSync(join(work, "engine/probe_electric.xml"), ENGINE);
    for (const entry of manifest.propellers) {
      const file = join(root, entry.file),
        bytes = readFileSync(file);
      if (sha(bytes) !== entry.sha256) throw new Error(`Hash mismatch: ${entry.file}`);
      const stem = basename(file, ".xml"),
        name = `probe_${stem}`,
        xml = bytes.toString("utf8"),
        thrust = parseTable(xml, "C_THRUST"),
        power = parseTable(xml, "C_POWER");
      // The definition is copied byte for byte; JSBSim loads exactly the tracked file.
      copyFileSync(file, join(work, "engine", `${stem}.xml`));
      mkdirSync(join(work, "aircraft", name), { recursive: true });
      writeFileSync(join(work, "aircraft", name, `${name}.xml`), aircraft(name, stem));
      const ratios = selectAdvanceRatios(thrust),
        input = ratios.map((r) => `${entry.rpmGroup} ${r.advanceRatio}`).join("\n") + "\n",
        result = spawnSync(probe, [work, name], { input, encoding: "utf8" });
      const lines = result.stdout.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)),
        loaded = lines.find((l) => l.kind === "loaded"),
        points = lines.filter((l) => l.kind === "point");
      const diameterOk = loaded !== undefined && Math.abs(loaded.diameterFt - entry.diameterIn / 12) < 1e-12;
      const evaluated =
        result.status === 0 && loaded && points.length === ratios.length
          ? points.map((p, i) => ({ check: ratios[i].kind, ...evaluatePoint(p, thrust, power, loaded.diameterFt) }))
          : [];
      propellers.push({
        file: entry.file,
        sha256: entry.sha256,
        loaded: result.status === 0 && loaded !== undefined,
        diameterFt: loaded?.diameterFt ?? null,
        diameterMatchesManifest: diameterOk,
        ixxPresent: /<ixx\b/.test(xml),
        points: evaluated,
        passed: diameterOk && evaluated.length === ratios.length && evaluated.every((p) => p.passed),
        stderr: result.stderr.trim().slice(0, 2000),
      });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const report = {
    schemaVersion: 1,
    task: "TASK-086",
    jsbsimCommit: lock.commit,
    jsbsimTag: lock.tag,
    manifestSha256: sha(manifestBytes),
    probeSourceSha256: sha(readFileSync(join(root, "native/jsbsim/propeller_probe.cpp"))),
    relativeTolerance: RELATIVE_TOLERANCE,
    densityReferenceSlugFt3: ISA_SEA_LEVEL_SLUG_FT3,
    selectionRule: "static row; row with CT nearest half the static CT; midpoint to the next row (linear interpolation)",
    limitations: [
      "No <ixx>: JSBSim v1.2.3 assigns FGPropeller::Ixx only when the element exists, so a flight model must supply the rotating inertia before RPM integration.",
      "Thrust and power are read from FGPropeller::Calculate at a prescribed RPM; RPM dynamics and engine coupling are not exercised.",
    ],
    propellers,
    status: propellers.length > 0 && propellers.every((p) => p.passed) ? "pass" : "failed",
  };
  const out = join(root, "test-results/validation/jsbsim-propellers.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  const points = propellers.flatMap((p) => p.points);
  console.log(
    `JSBSim propellers: ${report.status}; ${propellers.filter((p) => p.passed).length}/${propellers.length} files; ` +
      `${points.filter((p) => p.passed).length}/${points.length} points; max thrust error ` +
      `${Math.max(...points.map((p) => p.thrustRelativeError)).toExponential(2)}; ${out}`,
  );
  process.exitCode = report.status === "pass" ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
