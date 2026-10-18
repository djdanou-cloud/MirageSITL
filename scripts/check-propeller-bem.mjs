// Offline source-backed TASK-033 sensitivity diagnostic; never a fidelity override.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { verifyFixture } from "../packages/test-support/src/fixtures.ts";
import { parseUiucPropellerFixture, parseXfoilPolar, evaluateUiucPropellers } from "../packages/physics/src/uiuc-propeller.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => readFileSync(join(root, path));
const registry = JSON.parse(read("tests/fixtures/registry.json"));
async function fixture(path) {
  const entry = registry.fixtures.find((item) => `tests/fixtures/${item.path}` === path);
  if (!entry) throw Error(`Unregistered fixture ${path}`);
  const bytes = read(path);
  await verifyFixture(entry.manifest, bytes);
  return { value: JSON.parse(bytes), sha256: sha(bytes) };
}
const measured = await fixture("tests/fixtures/rotors/uiuc-propellers.json");
const polar = await fixture("tests/fixtures/polars/sda1075-xfoil.json");
const input = parseUiucPropellerFixture(measured.value);
const choice = parseXfoilPolar(polar.value, polar.sha256);
const native = join(root, "native");
execFileSync("cargo", ["build", "--locked", "-p", "mirage-bet", "--example", "propeller_points"], { cwd: native, stdio: "pipe" });
const executable = join(native, "target/debug/examples/propeller_points" + (process.platform === "win32" ? ".exe" : ""));
const variants = [
  { id: "uniform-original", arguments: [] },
  { id: "annular-no-loss", arguments: ["--annular", "--no-tip-loss", "--no-hub-loss"] },
  { id: "annular-tip-hub-swirl", arguments: ["--annular"] },
  { id: "annular-tip-hub-no-swirl", arguments: ["--annular", "--no-swirl"] },
];
const results = [];
for (const variant of variants) {
  let coverage = [];
  const evaluation = evaluateUiucPropellers(input, (request) => {
    const run = spawnSync(executable, variant.arguments, { input: request, encoding: "utf8", timeout: 120000, maxBuffer: 8 << 20, windowsHide: true });
    if (run.error || run.status !== 0) throw Error(run.error?.message ?? run.stderr);
    coverage = run.stderr.split(/\r?\n/).filter((line) => line.startsWith("bem ")).map((line) => {
      if (line === "bem error") return { error: true };
      const v = line.slice(4).split(" ").map(Number);
      if (v.length !== 12 || !v.every(Number.isFinite) || ![0, 1].includes(v[0]) || ![0, 1].includes(v[1])) throw Error("Invalid BEM diagnostic line");
      return { converged: v[0] === 1, outsideMomentum: v[1] === 1, polarFlags: v[2], relativeResidual: v[3], minAlphaRad: v[4], maxAlphaRad: v[5], minReynolds: v[6], maxReynolds: v[7], meanInducedMps: v[8], meanSwirlMps: v[9], ct: v[10], cp: v[11] };
    });
    if (variant.arguments.length && coverage.length !== request.split("\n").filter((line) => line.startsWith("point ")).length) throw Error("Missing BEM diagnostics");
    return run.stdout;
  }, choice);
  results.push({ ...variant, ...evaluation, numerical: { diagnosticCases: coverage.length,
    convergedCases: coverage.filter((point) => point.converged).length,
    maximumRelativeResidual: Math.max(0, ...coverage.filter((point) => !point.error).map((point) => point.relativeResidual)) }, coverage });
  console.log(variant.id, JSON.stringify(evaluation.totals));
}
const sourceFiles = ["native/Cargo.lock", "native/rust-toolchain.toml", "native/bet/Cargo.toml", "native/bet/src/lib.rs", "native/bet/src/math.rs", "native/bet/src/quadrature.rs", "native/bet/src/propeller_bem.rs", "native/bet/src/propeller.rs", "native/bet/src/blade.rs", "native/bet/src/polar.rs", "native/bet/examples/propeller_points.rs", "packages/physics/src/uiuc-propeller.ts", "scripts/check-propeller-bem.mjs"];
const report = { schemaVersion: 1, task: "TASK-033", status: "diagnostic-only", rust: execFileSync("rustc", ["--version"], { cwd: native, encoding: "utf8" }).trim(),
  executableSha256: sha(readFileSync(executable)), measuredSha256: measured.sha256, polarSha256: polar.sha256,
  sourceInputs: sourceFiles.map((file) => ({ file, sha256: sha(read(file)) })),
  assumptions: "Steady annular momentum on V+u>=V/2; original Prandtl tip/hub factors; optional rotor-plane swirl; positive integrated thrust and shaft power required; no stall-delay fitting or polar extrapolation; nonconvergence is error, never PASS",
  limitations: ["Existing narrow XFOIL polar and unmeasured operating regions remain", "Integrated windmilling and high-induction braking are not certified", "Not production backend, transient inflow or high-rate admission", "Sensitivity to model choice does not establish cause or fidelity"],
  pairedComparison: results.slice(1).map((candidate) => {
    const counts = { commonCompared: 0, baselinePassed: 0, candidatePassed: 0, gained: 0, lost: 0 };
    for (let i = 0; i < candidate.points.length; i++) {
      const a = results[0].points[i], b = candidate.points[i];
      if (a.propellerId !== b.propellerId || a.source !== b.source || a.rpm !== b.rpm || a.advanceRatio !== b.advanceRatio) throw Error("Mismatched paired operating points");
      if (["pass", "failed"].includes(a.result) && ["pass", "failed"].includes(b.result)) {
        counts.commonCompared++;
        counts.baselinePassed += Number(a.result === "pass"); counts.candidatePassed += Number(b.result === "pass");
        counts.gained += Number(a.result !== "pass" && b.result === "pass"); counts.lost += Number(a.result === "pass" && b.result !== "pass");
      }
    }
    return { id: candidate.id, ...counts };
  }), results };
mkdirSync(join(root, "test-results/validation"), { recursive: true });
writeFileSync(join(root, "test-results/validation/propeller-bem.json"), JSON.stringify(report, null, 2) + "\n");
// A successful diagnostic execution does not claim measured acceptance.
