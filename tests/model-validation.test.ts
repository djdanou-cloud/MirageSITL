import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { expect, it } from "vitest";
import schema from "../docs/validation/model-report.schema.json";
it("writes numerical parity evidence but fails closed when fidelity prerequisites are missing", () => {
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
  expect(report).toMatchObject({
    status: "blocked",
    numericalStatus: "pass",
    fidelityStatus: "blocked",
  });
  expect(result.stdout).toContain("12 cases");
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
