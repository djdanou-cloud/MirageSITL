import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
it("all missing-input CLIs produce distinct blocked verdicts and never succeed silently", () => {
  for (const file of ["run-sitl", "probe-ardupilot-wasm", "bench-hitl", "bench-render", "check-gpu-perf", "report-ekf", "validate-release", "release-manifest"]) {
    const r = spawnSync(process.execPath, [`scripts/${file}.mjs`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(2); expect(r.stdout).toContain("BLOCKED_EXTERNAL");
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
