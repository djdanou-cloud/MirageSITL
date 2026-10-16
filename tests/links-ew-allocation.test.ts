import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it.each([400, 800, 1200])(
  "measures actual protocol/EW paths at %i Hz with an allocating control",
  (hz) => {
    const result = spawnSync(
      process.execPath,
      ["scripts/bench-links-ew.mjs", "all", String(hz)],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const report: unknown = JSON.parse(
      readFileSync(`test-results/bench/links-ew-all-${hz}.json`, "utf8"),
    );
    expect(report).toMatchObject({
      schemaVersion: 1,
      component: "all",
      zeroAllocation: true,
      controlDetected: true,
    });
  },
  300000,
);
