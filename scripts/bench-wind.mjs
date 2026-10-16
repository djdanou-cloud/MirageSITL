// Synthetic gust allocation probe. Node/V8 evidence, not browser timing evidence.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';
import { Wind } from '../packages/physics/src/wind.ts';
if (!globalThis.gc) {
  const child = spawnSync(process.execPath, ['--expose-gc', '--max-semi-space-size=64', '--single-threaded', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}
const wind = new Wind({ meanNedMps: [1, 2, 3], gustRmsMps: 2, bandwidthHz: 2, hz: 400 }, 123);
const out = new Float64Array(3), events = [], sink = { value: null };
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) events.push(e.startTime); });
observer.observe({ entryTypes: ['gc'] });
function young() { return v8.getHeapSpaceStatistics().find(s => s.space_name === 'new_space').space_used_size; }
function run(n) { for (let i = 0; i < n; i++) wind.stepInto(out); }
function control(n) { for (let i = 0; i < n; i++) sink.value = { i }; }
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
async function window(body, n) {
  body(n); globalThis.gc(); await settle();
  const start = performance.now(), before = young();
  body(n);
  const bytes = young() - before, end = performance.now();
  await settle();
  return { steps: n, bytes, gcEvents: events.filter(time => time >= start && time <= end).length };
}
const samples = [];
for (let i = 0; i < 3; i++) {
  samples.push(await window(run, 1000000), await window(run, 2000000));
}
const positiveControl = await window(control, 2000000);
const short = Math.min(...samples.filter(s => s.steps === 1000000).map(s => s.bytes));
const long = Math.min(...samples.filter(s => s.steps === 2000000).map(s => s.bytes));
const bytesPerStep = Math.max(0, long - short) / 1000000;
const zeroAllocation = samples.every(s => s.gcEvents === 0) && bytesPerStep < 0.01;
const controlDetected = positiveControl.gcEvents > 0 || positiveControl.bytes > 1000000;
const report = { seed: 123, hz: 400, method: 'warmed V8 new-space N/2N windows, GC observation, positive allocating control', samples, positiveControl, bytesPerStep, zeroAllocation, controlDetected, lastWindNedMps: Array.from(out) };
mkdirSync('test-results/bench', { recursive: true });
writeFileSync('test-results/bench/wind.json', JSON.stringify(report, null, 2) + '\n');
observer.disconnect(); console.log(JSON.stringify(report));
if (!zeroAllocation || !controlDetected) process.exitCode = 1;
