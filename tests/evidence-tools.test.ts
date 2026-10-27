import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, onTestFinished } from "vitest";
it("all missing-input CLIs produce distinct blocked verdicts and never succeed silently", () => {
  // The CLIs write cwd-relative test-results/validation/<kind>.json and several stamp `git rev-parse HEAD`,
  // so they run from a scratch directory inside the ignored test-results/ tree of this checkout.
  const cwd = mkdtempSync(resolve("test-results/evidence-cli-"));
  onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  for (const file of ["run-sitl", "probe-ardupilot-wasm", "bench-hitl", "bench-render", "check-gpu-perf", "report-ekf", "validate-release", "release-manifest"]) {
    const r = spawnSync(process.execPath, [resolve(`scripts/${file}.mjs`)], { cwd, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(2); expect(r.stdout).toContain("BLOCKED_EXTERNAL");
  }
  // check-gpu-perf prints its verdict without writing a report when no profile is selected.
  for (const kind of ["sitl-report", "ardupilot-wasm-feasibility", "hitl-report", "gpu-report", "ekf-report", "system-report", "release-manifest"]) {
    const report: unknown = JSON.parse(readFileSync(join(cwd, "test-results/validation", `${kind}.json`), "utf8"));
    expect(report).toMatchObject({ kind, status: "BLOCKED_EXTERNAL" });
  }
});

it("bounds evidence before allocation and rejects stale bytes", async () => {
  const { nodeCheck } = await import("./support/node-evidence");
  nodeCheck(`
    import {mkdtempSync,writeFileSync,truncateSync,rmSync} from 'node:fs';
    import {tmpdir} from 'node:os';import {join} from 'node:path';
    import {loadJson,sha256} from './scripts/validation/evidence.mjs';
    const root=mkdtempSync(join(tmpdir(),'mirage-evidence-'));const file=join(root,'trace.json');
    try{writeFileSync(file,'{}');assert.deepEqual(loadJson(file,sha256(Buffer.from('{}'))),{});
    assert.throws(()=>loadJson(file,'0'.repeat(64)),/mismatch/);
    truncateSync(file,32*1024*1024+1);assert.throws(()=>loadJson(file,'0'.repeat(64)),/budget/);
    }finally{rmSync(root,{recursive:true,force:true})}
  `);
});
