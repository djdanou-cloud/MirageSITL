import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { expect, it } from "vitest";
import schema from "../docs/validation/model-report.schema.json";
it("writes numerical parity, NASA drop and UIUC propeller evidence and fails closed on missing or failed fidelity", () => {
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
  // Airframe data are absent (blocked); the NASA drop and UIUC propeller comparisons run and fail.
  expect(report).toMatchObject({
    schemaVersion: 4,
    status: "failed",
    numericalStatus: "pass",
    fidelityStatus: "blocked",
    contactFidelityStatus: "failed",
    propellerFidelityStatus: "failed",
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
    measuredValidation: [
      {
        id: "nasa-tm-x-3561-drop",
        datasetId: "NASA-TM-X-3561-DropTest",
        referenceUrl: "https://ntrs.nasa.gov/citations/19780003109",
        license: "Public-Domain-US-Gov",
        consistencyStatus: "pass",
        status: "failed",
      },
    ],
  });
  expect(result.stdout).toContain("12 cases; 3 measured");
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
