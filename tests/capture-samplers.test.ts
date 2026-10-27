import { it } from "vitest";
import { nodeCheck } from "./support/node-evidence";

// TASK-073: the capture side channels parse real tool output formats; none of them feed the G3 analyzer.
it("parses typeperf GPU memory rows, nvidia-smi clock summaries and PresentMon CSV", () => nodeCheck(`
import {clockSamplerFor,csvCells,gpuMemoryRow,isNvidiaRenderer,presentMonDisplayedTimes,summarizeClocks,summarizePresentMon} from './scripts/capture-samplers.mjs';
// nvidia-smi is only queried for an NVIDIA GPU (its queries delayed an integrated-GPU display's vertical blank).
assert.equal(isNvidiaRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11)'),true);
assert.equal(isNvidiaRenderer('ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11)'),false);
assert.equal(isNvidiaRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)'),false);
let started=0;
const intel=clockSamplerFor('ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11)',()=>{started++;return {available:true};});
assert.equal(started,0); assert.equal(intel.available,false); assert.match(intel.reason,/not NVIDIA .*Intel/); assert.deepEqual(intel.samples,[]);
assert.equal(clockSamplerFor('ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11)',()=>{started++;return {available:true};}).available,true);
assert.equal(started,1);
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
  assert.equal(p.frames,4); assert.equal(p.displayed,3); assert.equal(p.notDisplayed,1); assert.equal(p.displayedMs.p50Ms,16.7); assert.equal(p.displayedMs.maxMs,33.4);
  const v2=join(dir,'pm2.csv');
  writeFileSync(v2,'Application,PresentMode,GPUBusy,DisplayedTime\\nchrome.exe,Hardware Composed: Independent Flip,3.0,16.69\\nchrome.exe,Hardware Composed: Independent Flip,4.0,16.64\\nchrome.exe,Composed: Flip,5.0,NA\\n');
  const q=summarizePresentMon(v2);
  assert.equal(q.column,'DisplayedTime'); assert.equal(q.displayed,2); assert.equal(q.notDisplayed,1);
  assert.equal(q.displayedMs.maxMs,16.69); assert.equal(q.gpuBusyMs.p50Ms,4); assert.deepEqual(q.presentModes,{'Hardware Composed: Independent Flip':2,'Composed: Flip':1});
  const timed=join(dir,'pm3.csv');
  writeFileSync(timed,'Application,CPUStartQPCTime,DisplayedTime\\nchrome.exe,1000.0,40.0\\nchrome.exe,1016.7,16.7\\nchrome.exe,1033.3,16.6\\nchrome.exe,1050.0,50.0\\n');
  const w=summarizePresentMon(timed,{startMs:1010,endMs:1040});
  assert.equal(w.frames,2); assert.equal(w.framesInTrace,4); assert.equal(w.displayedMs.maxMs,16.7);
  assert.throws(()=>summarizePresentMon(v2,{startMs:0,endMs:1}));
  // Displayed-frame gate input: every displayed present in the window, in order (BOM tolerated, NA skipped).
  const bom=join(dir,'pm4.csv');
  writeFileSync(bom,'\\uFEFFApplication,CPUStartQPCTime,DisplayedTime\\nchrome.exe,1000.0,40.0\\nchrome.exe,1016.7,16.7\\nchrome.exe,1025.0,NA\\nchrome.exe,1033.3,33.4\\nchrome.exe,1050.0,50.0\\n');
  assert.deepEqual(presentMonDisplayedTimes(bom,{startMs:1010,endMs:1040}),[16.7,33.4]);
  assert.throws(()=>presentMonDisplayedTimes(v2,{startMs:0,endMs:1}));
} finally { rmSync(dir,{recursive:true,force:true}); }
`));
