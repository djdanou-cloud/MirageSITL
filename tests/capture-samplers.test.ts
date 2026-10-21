import { it } from "vitest";
import { nodeCheck } from "./support/node-evidence";

// TASK-073: the capture side channels parse real tool output formats; none of them feed the G3 analyzer.
it("parses typeperf GPU memory rows, nvidia-smi clock summaries and PresentMon CSV", () => nodeCheck(`
import {csvCells,gpuMemoryRow,summarizeClocks,summarizePresentMon} from './scripts/capture-samplers.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const header=csvCells('"(PDH-CSV 4.0)","\\\\\\\\HOST\\\\GPU Process Memory(pid_42_luid_0x0_0x1_phys_0)\\\\Dedicated Usage","\\\\\\\\HOST\\\\GPU Process Memory(pid_42_luid_0x0_0x2_phys_0)\\\\Dedicated Usage","\\\\\\\\HOST\\\\GPU Process Memory(pid_7_luid_0x0_0x1_phys_0)\\\\Dedicated Usage","\\\\\\\\HOST\\\\GPU Process Memory(pid_42_luid_0x0_0x1_phys_0)\\\\Shared Usage"');
const row=csvCells('"10/22/2026 10:00:00.000","1000.000000","24.000000","999999.000000","5.000000"');
assert.deepEqual(gpuMemoryRow(header,row,42),{at:'10/22/2026 10:00:00.000',dedicatedBytes:1024,sharedBytes:5});
assert.equal(gpuMemoryRow(header,row,8),null);
assert.equal(csvCells('not csv'),null);
const s=summarizeClocks([{pstate:'P8',clockMHz:210,temperatureC:50},{pstate:'P5',clockMHz:450,temperatureC:55},{pstate:'P8',clockMHz:300,temperatureC:54}]);
assert.deepEqual(s,{samples:3,pstates:{P8:2,P5:1},pstateChanges:2,minClockMHz:210,maxClockMHz:450,maxTemperatureC:55});
assert.equal(summarizeClocks([]),null);
const dir=mkdtempSync(join(tmpdir(),'pm-'));
try {
  const csv=join(dir,'pm.csv');
  writeFileSync(csv,'Application,ProcessID,MsBetweenDisplayChange\\nchrome.exe,1,16.6\\nchrome.exe,1,16.7\\nchrome.exe,1,33.4\\nchrome.exe,1,NA\\n');
  const p=summarizePresentMon(csv);
  assert.equal(p.frames,4); assert.equal(p.displayChanges,3); assert.equal(p.p50Ms,16.7); assert.equal(p.maxMs,33.4);
} finally { rmSync(dir,{recursive:true,force:true}); }
`));
