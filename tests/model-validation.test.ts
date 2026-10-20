import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { expect, it } from "vitest";
import { record } from "@mirage/wasm-bet/rotor";
import schema from "../docs/validation/model-report.schema.json";
it("writes numerical and UIUC evidence, retains the deferred NASA failure, and fails closed on missing or failed fidelity", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-models.mjs"], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(2);
  const report: unknown = JSON.parse(
    readFileSync("test-results/validation/model-report.json", "utf8"),
  );
  expect(
    new Ajv({ strict: true, allowUnionTypes: true }).compile(schema)(report),
  ).toBe(true);
  if (typeof report !== "object" || report === null) throw Error("Invalid model report");
  const validate = new Ajv({ strict: true, allowUnionTypes: true }).compile(schema);
  expect(validate({ ...report, schemaVersion: 5 })).toBe(false);
  expect(validate({ ...report, schemaVersion: 6 })).toBe(false);
  expect(validate({ ...report, schemaVersion: 7 })).toBe(false);
  expect(validate({ ...report, runtimeStatus: undefined })).toBe(false);
  expect(validate({ ...report, surrogateValidation: [] })).toBe(false);
  const mislabeled: unknown = JSON.parse(JSON.stringify(report).replace('"unvalidated"', '"pass"'));
  expect(validate(mislabeled)).toBe(false);
  // Airframe data are absent; NASA is explicitly deferred with its failure retained.
  expect(report).toMatchObject({
    schemaVersion: 8,
    status: "failed",
    numericalStatus: "pass",
    fidelityStatus: "blocked",
    contactFidelityStatus: "blocked",
    propellerFidelityStatus: "failed",
    surrogateValidation: [
      { configurationId: "baseline-two-blade", airfoil: "NACA6409", provenance: "neural-surrogate",
        numericalStatus: "pass", measuredFidelity: "unvalidated", cases: 24,
        reportPath: "test-results/validation/rotor-bet.json" },
      { configurationId: "tapered-three-blade", airfoil: "NACA6409", numericalStatus: "pass", cases: 24 },
      { configurationId: "symmetric-four-blade", airfoil: "NACA0012", numericalStatus: "pass", cases: 24 },
    ],
    propellerValidation: [
      {
        id: "uiuc-da4002-da4022-propellers",
        datasetId: "UIUC-Propeller-Database-Vols-1-4",
        referenceUrl: "https://m-selig.ae.illinois.edu/props/propDB.html",
        consistencyStatus: "pass",
        status: "failed",
        audit: { points: 716, etaInconsistent: 0, aboveFroudeBound: 0 },
        polar: { kind: "thin-airfoil-laminar-friction", airfoil: "SDA1075" },
        tolerance: { ctRelative: 0.1, ctAbsolute: 0.005, cpRelative: 0.1, cpAbsolute: 0.003 },
      },
      {
        id: "uiuc-da4002-da4022-propellers-xfoil",
        consistencyStatus: "pass",
        status: "failed",
        polar: { kind: "xfoil", airfoil: "SDA1075", solverVersion: "6.99", ncrit: 9 },
        tolerance: { ctRelative: 0.1, ctAbsolute: 0.005, cpRelative: 0.1, cpAbsolute: 0.003 },
      },
    ],
    measuredValidation: [],
    deferredMeasurements: [
      {
        id: "nasa-tm-x-3561-drop",
        historicalStatus: "failed",
        archivePath: "test-results/validation/nasa-drop-legacy.json",
        reason: "NASA measured fidelity deferred by explicit user instruction on 2026-10-18; preserve the historical failed comparison",
      },
    ],
    diagnostics: { jsbsimBackend: { status: "pass" }, jsbsimJsAllocation: { status: "pass" } },
  });
  // Runtime reports are optional local acceptance outputs. Fresh checkouts must
  // stay blocked until the two real acceptance CLIs have produced current proof.
  if (!record(report) || !record(report.diagnostics)) throw Error("Missing runtime diagnostics");
  const rotor = report.diagnostics.betRuntime, allocation = report.diagnostics.betRuntimeAllocation;
  if (!record(rotor) || !record(allocation)) throw Error("Invalid runtime diagnostics");
  expect(rotor.status).toMatch(/^(pass|missing|stale|invalid)$/);
  expect(allocation.status).toMatch(/^(pass|missing|stale|invalid)$/);
  expect(report.runtimeStatus).toBe(rotor.status === "pass" && allocation.status === "pass" ? "pass" : "blocked");
  expect(result.stdout).toContain("12 cases; 2 measured");
}, 300000);
it("retains pinned reference rate and rejects a missing JSBSim source", () => {
  expect(() =>
    execFileSync(process.execPath, ["scripts/build-jsbsim.mjs"], {
      env: { ...process.env, JSBSIM_SOURCE_DIR: "/missing-reference" },
      stdio: "pipe",
    }),
  ).toThrow();
});

it("rejects empty/misordered rates and unsupported measurements before building", () => {
  const reference: unknown = JSON.parse(
    readFileSync("tests/fixtures/validation/reference-manifest.json", "utf8"),
  );
  if (typeof reference !== "object" || reference === null)
    throw new Error("Invalid test reference");
  const code =
    "import {parseReference} from './scripts/validate-models.mjs';let input='';for await(const chunk of process.stdin)input+=chunk;parseReference(input);";
  for (const change of [
    { schemaVersion: 1 },
    { deferredMeasurements: [{}] },
    { testHz: [] },
    { testHz: [1200, 800, 400] },
    { measurements: [{}] },
    {
      measurements: [
        {
          id: "x",
          adapter: "unknown-adapter",
          fixture: "tests/fixtures/contact/nasa-drop.json",
          registryId: "nasa-tm-x-3561-drop-v1",
          sourceSha256: "0".repeat(64),
          datasetId: "x",
          referenceUrl: "https://ntrs.nasa.gov/",
        },
      ],
    },
    {
      measurements: [
        {
          id: "x",
          adapter: "nasa-drop-contact-v1",
          fixture: "tests/fixtures/../../secret.json",
          registryId: "nasa-tm-x-3561-drop-v1",
          sourceSha256: "0".repeat(64),
          datasetId: "x",
          referenceUrl: "https://ntrs.nasa.gov/",
        },
      ],
    },
    { cases: [] },
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", code],
      { input: JSON.stringify({ ...reference, ...change }), encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid pinned reference");
  }
});

it("rejects modified deferred evidence without rerunning the obsolete NASA model", () => {
  const code = "import {verifyDeferredMeasurement} from './scripts/validate-models.mjs';import {readFileSync} from 'node:fs';const r=JSON.parse(readFileSync('tests/fixtures/validation/reference-manifest.json'));await verifyDeferredMeasurement({...r.deferredMeasurements[0],archiveSha256:'0'.repeat(64)});";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("archive hash mismatch");
});
