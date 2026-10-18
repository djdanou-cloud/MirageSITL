// Read-only review of the supplied TASK-033 sources; optional bounded turbine smoke.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sources = [
  { file: "PROPID-Ver53-120106-Full/bin/propid53-64bit.exe", sha256: "8d91d2cad3404e09fc738e1cd838c977efe2b224d1cc23429975c9897c5c0745", role: "Optional executable reference; turbine smoke only admitted" },
  { file: "PROPID-Ver53-120106-Full/doc/pdf/UserManual-531.pdf", sha256: "4329c2fa26b7b98f7a5546338a4850817cd89da238e179f3a2e92074e878ada6", role: "Sections 3.1-3.3: modes, Prandtl losses, swirl, units, midpoint geometry and polar format" },
  { file: "PROPID-Ver53-120106-Full/README.txt", sha256: "390e483d3119a98f6f6455e5fac9e972b75f70f237a83678d246aca8d0552df5", role: "Version, invocation, authorship and redistribution status" },
  { file: "DetersAnandaSelig-2014-AIAA-2014-2151.md", sha256: "b1d4efed0a7cc4cefa462d3da33af51404069d3dd5afcdd81f2d95202bf1d3ae", role: "AIAA 2014-2151: experiment, blade identities, geometry, coefficients and SDA1075 coordinates" },
  { file: "Robert_Deters.md", sha256: "a493695a924d7ab82cf31847d2e3583a90f63c89edbd07eeceb5a2a51be017d8", role: "Deters 2014 dissertation: sections 3.2, 4.2, 6.2, chapter 8 and Appendix A.2; geometry, induction, low-Re limitations and slipstream evidence" },
];
for (const source of sources) if (sha(readFileSync(join(root, source.file))) !== source.sha256) throw Error(`Changed source ${source.file}`);
const thesis = readFileSync(join(root, "Robert_Deters.md"), "utf8");
const start = thesis.indexOf("Table A.2: SDA1075 Coordinates");
const end = thesis.indexOf("Table A.3:", start);
if (start < 0 || end < start) throw Error("Missing SDA1075 coordinate table");
const upper = [], lower = [];
for (const line of thesis.slice(start, end).split(/\r?\n/)) {
  const columns = line.split("|").slice(1, -1).map((s) => s.trim());
  if (columns.length !== 4 || !/^-?\d+\.\d+$/.test(columns[0])) continue;
  upper.push(columns.slice(0, 2).map(Number));
  if (columns[2] !== "") lower.push(columns.slice(2).map(Number));
}
const coordinates = [...upper, ...lower];
const current = readFileSync(join(root, "tests/fixtures/rotors/uiuc/sda1075.dat"), "utf8").trim().split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/).map(Number));
if (coordinates.length !== 61 || current.length !== 61 || coordinates.some((p, i) => p.some((v, j) => v !== current[i][j]))) throw Error("Dissertation SDA1075 does not match existing transcription");
let smoke = { status: "not-run" };
let githubReview = null;
const github = join(root, ".cache/task-033/airfoil-research");
if (existsSync(join(github, ".git"))) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: github, encoding: "utf8" }).trim();
  if (commit !== "27c6eb2a37e4f157ae62bd485b3686949b103698") throw Error("Unreviewed airfoil-research revision");
  const measured = JSON.parse(readFileSync(join(root, "tests/fixtures/rotors/uiuc-propellers.json")));
  const matches = measured.propellers.map((propeller) => {
    const name = propeller.static.source.split("/").at(-1);
    const matches = sha(readFileSync(join(github, "data/uiuc_propdb", name))) === propeller.static.sha256;
    if (!matches) throw Error(`Changed upstream measured propeller data ${name}`);
    return { propeller: propeller.id, source: name, sha256: propeller.static.sha256, exactMatch: true };
  });
  const reviewed = ["LICENSE", "METHODS.md", "validate_bemt.py", "rotor_uncertainty.py", "data/bemt_validation.csv", "data/bemt_validation_xfoil.csv"];
  githubReview = { url: "https://github.com/neel542/airfoil-research", commit, softwareLicense: "MIT", executed: false,
    reviewedFiles: reviewed.map((file) => ({ file, sha256: sha(readFileSync(join(github, file))) })), staticDataMatches: matches,
    role: "Independent implementation/uncertainty reference; its propeller experiments reuse the same UIUC measurements, not new validation data",
    limitations: ["General airfoil benchmark starts at Re=60000; not measured SDA1075 coverage at Re=20000",
      "Propeller validation uses static points and a Re>=40000 summary window; not the full advancing-flow gate",
      "NeuralFoil and XFOIL outputs are predictions; the XFOIL adapter fills internal gaps and holds edges on Kulfan-fitted geometry, which is not our strict converged-only raw-coordinate polar policy",
      "Rotor solver has different loss-factor definitions, branch selection and no propeller angular-momentum swirl solve; CSV outputs are not interchangeable numerical goldens",
      "No confidence-based rescaling, error-fit coefficients or acceptance-window narrowing is imported into MirageSITL"] };
}
if (process.argv.includes("--run")) {
  const directory = join(root, ".cache/task-033/propid-check");
  mkdirSync(directory, { recursive: true });
  const runFiles = [];
  for (const name of readdirSync(join(root, "PROPID-Ver53-120106-Full/runs"))) {
    if (!/\.(in|pd)$/.test(name)) continue;
    const source = join(root, "PROPID-Ver53-120106-Full/runs", name);
    copyFileSync(source, join(directory, name));
    runFiles.push({ file: name, sha256: sha(readFileSync(source)) });
  }
  writeFileSync(join(directory, "propid.in"), "wt01a.in\n");
  const result = spawnSync(join(root, sources[0].file), [], { cwd: directory, encoding: "utf8", timeout: 20000, maxBuffer: 4 << 20, windowsHide: true });
  writeFileSync(join(directory, "stdout.log"), result.stdout ?? "");
  writeFileSync(join(directory, "stderr.log"), result.stderr ?? "");
  const passed = !result.error && result.status === 0 && /PROPID: Successful run/.test(result.stdout);
  smoke = { status: passed ? "pass" : "failed", exit: result.status, error: result.error?.message ?? null,
    scope: "Bundled wt01a wind-turbine example only; not propeller parity or measured fidelity",
    inputs: runFiles, stdoutSha256: sha(result.stdout ?? ""), stderrSha256: sha(result.stderr ?? ""),
    warnings: result.stdout?.match(/Warning \d+:[\s\S]*?\(endprog\.f\)/g) ?? [] };
}
const report = { schemaVersion: 1, task: "TASK-033", generatorSha256: sha(readFileSync(fileURLToPath(import.meta.url))), sources,
  sda1075Coordinates: { points: 61, exactMatch: true, source: "Dissertation Appendix A.2", reference: "tests/fixtures/rotors/uiuc/sda1075.dat" },
  findings: ["Use all three sources with different roles; none supplies a new raw measured SDA1075 polar",
    "Dissertation section 6.2 reports that its XFOIL Re=20000 polar gave predictions inconsistent with experiments; expanding computed coverage alone is not validation",
    "Dissertation distinguishes design geometry from scanned manufactured geometry; the current UIUC fixture already uses measured geometry, so no fitted extra pitch offset is applied",
    "Chapter 8 slipstream measurements are downstream, not rotor-plane induced velocities; wake contraction and station transforms are required before a numerical comparison",
    "Manual names MODE=2/INCV=1 for propellers but does not document that mode; the local synthetic trial did not establish correct velocity/sign conventions, so it is not admitted as parity"],
  propellerReferenceAdmitted: false, githubReview, smoke };
mkdirSync(join(root, "test-results/validation"), { recursive: true });
writeFileSync(join(root, "test-results/validation/propeller-source-review.json"), JSON.stringify(report, null, 2) + "\n");
console.log("Reviewed three sources; dissertation SDA1075 matches all 61 points; PROPID smoke:", smoke.status);
if (smoke.status === "failed") process.exitCode = 1;
