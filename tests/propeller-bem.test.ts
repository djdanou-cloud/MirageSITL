import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("runs independent annular momentum cases against unchanged measured UIUC tolerances without hiding nonconvergence", () => {
  const run = spawnSync(process.execPath, ["scripts/check-propeller-bem.mjs"], { encoding: "utf8", timeout: 180000 });
  expect(run.status, run.stderr).toBe(0);
  const report: unknown = JSON.parse(readFileSync("test-results/validation/propeller-bem.json", "utf8"));
  expect(report).toMatchObject({
    schemaVersion: 1, status: "diagnostic-only",
    results: [
      { id: "uniform-original", totals: { points: 958, compared: 165, passed: 26, errors: 0 } },
      { id: "annular-no-loss", totals: { points: 958, errors: 0 }, numerical: { diagnosticCases: 958, convergedCases: 958 } },
      { id: "annular-tip-hub-swirl", status: "failed", totals: { points: 958, errors: 0 }, numerical: { diagnosticCases: 958, convergedCases: 958 } },
      { id: "annular-tip-hub-no-swirl", totals: { points: 958, errors: 0 }, numerical: { diagnosticCases: 958, convergedCases: 958 } },
    ],
  });
  if (typeof report !== "object" || report === null || !("results" in report) || !Array.isArray(report.results)) throw Error("Malformed report");
  for (const value of report.results.slice(1) as unknown[]) {
    if (typeof value !== "object" || value === null || !("numerical" in value) || typeof value.numerical !== "object" || value.numerical === null || !("maximumRelativeResidual" in value.numerical)) throw Error("Missing convergence diagnostics");
    const residual = value.numerical.maximumRelativeResidual;
    expect(typeof residual === "number" && Number.isFinite(residual) && residual < 1e-9).toBe(true);
    expect(value).toMatchObject({ tolerance: { ctRelative: 0.1, ctAbsolute: 0.005, cpRelative: 0.1, cpAbsolute: 0.003 } });
  }
  expect(run.stdout).toContain("uniform-original");
}, 240000);
