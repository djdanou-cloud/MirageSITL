import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
it.each([400, 800, 1200])(
  "measures actual protocol/EW paths at %i Hz with an allocating control",
  (hz) => {
    // Committed test-results/bench reports stay authoritative; this run writes elsewhere.
    const out = mkdtempSync(join(tmpdir(), "mirage-links-ew-"));
    onTestFinished(() => rmSync(out, { recursive: true, force: true }));
    const result = spawnSync(
      process.execPath,
      ["scripts/bench-links-ew.mjs", "all", String(hz), "--out", out],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const report: unknown = JSON.parse(
      readFileSync(join(out, `links-ew-all-${hz}.json`), "utf8"),
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
