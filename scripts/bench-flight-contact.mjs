// TASK-095: flight dynamics on compliant contact, compute and allocation benchmark (Node/V8 evidence,
// not browser or target-hardware timing). The synthetic four-rotor fixture of tests/bet-runtime-fixture.ts
// stands on four short legs (tests/flight-contact.test.ts) and repeats a 7 s cycle on a vertical-speed
// loop: climb toward 1 m/s for 1 s, descend toward 1 m/s for 5 s (it lands on its legs, then sits on them),
// rest with the motors cut for 1 s. Every cycle touches down; the report counts the touchdowns. Rapier
// (GroundContact) integrates the body every step.
//
//   node scripts/bench-flight-contact.mjs [--steps N] [--timing-steps N] [--out PATH]
//
// Reports, per rate (400, 800, 1200 Hz), the per-step compute distribution against the step period, and
// at 400 Hz the young-generation bytes and GC events over N warmed steps (G1), with an allocating
// positive control, plus the native contact allocator counters.
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import v8 from 'node:v8';

const FLAGS = ['--expose-gc', '--max-semi-space-size=64', '--single-threaded'];
if (typeof globalThis.gc !== 'function') {
  const child = spawnSync(process.execPath, [...FLAGS, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}
const steps = Number(option('steps', '1000000')), timingSteps = Number(option('timing-steps', '20000'));
const out = resolve(root, option('out', 'test-results/bench/flight-contact.json'));
if (!Number.isInteger(steps) || steps < 1000 || !Number.isInteger(timingSteps) || timingSteps < 1000) { console.error('Invalid arguments'); process.exit(2); }

for (const script of ['scripts/build-wasm.mjs', 'scripts/build-contact.mjs'])
  execFileSync(process.execPath, [resolve(root, script)], { stdio: 'pipe' });
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
mkdirSync(resolve(root, '.cache/bench-flight-contact'), { recursive: true });
const bundle = resolve(root, '.cache/bench-flight-contact/entry.mjs');
const bundled = await build({ stdin: { contents: `
export { BetFlightDynamics } from './packages/physics/src/bet-dynamics.ts';
export { GroundContact } from './packages/physics/src/ground-contact.ts';
export { flightConfiguration } from './tests/bet-runtime-fixture.ts';
export { newInput, ControlFlag } from './packages/protocol/src/index.ts';`, resolveDir: root, sourcefile: 'bench-entry.ts', loader: 'ts' },
bundle: true, platform: 'node', format: 'esm', outfile: bundle, metafile: true });
const M = await import(pathToFileURL(bundle).href);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(resolve(root, path));

const wasmBytes = read('packages/wasm-bet/dist/mirage_bet.scalar.wasm'), contactBytes = read('packages/physics/dist/contact/contact.wasm');
const module = new WebAssembly.Module(wasmBytes);
await M.GroundContact.initialize(new Uint8Array(contactBytes), JSON.parse(read('packages/physics/dist/contact/manifest.json').toString('utf8')));
const TOUCH_DOWN_M = -0.17;
const legs = [[0.2, 0.2], [0.2, -0.2], [-0.2, -0.2], [-0.2, 0.2]].map(([x, y]) => ({ anchorBodyM: [x, y, 0.15], unsprungMassKg: 0.02,
  tireRadiusM: 0.02, rimRadiusM: 0.01, strutTravelM: 0.05,
  suspension: { kind: 'linear', stiffnessNpm: 2000, preloadN: 0, compressionDamping: 40, reboundDamping: 40, dampingLaw: 'linear' },
  tireLoadCurve: [[0, 0], [0.01, 200]], tireDampingNsPm: 5, rollingCoefficient: 0.6, lateralCoefficient: 0.6, brakingCoefficient: 0.6 }));

async function vehicle(hz) {
  const c = M.flightConfiguration();
  c.initialOmegaRadS = [0, 0, 0, 0]; c.motorMaxTorqueNm = [0.6, 0.6, 0.6, 0.6];
  c.initialBody.positionNedM[2] = TOUCH_DOWN_M - 0.001;
  c.contact = await M.GroundContact.forVehicle(c.initialBody, c.manifest, { wheels: legs, hullRadiusM: 0.05 });
  const d = new M.BetFlightDynamics(module, c, hz), pilot = M.newInput(), cycle = 7 * hz;
  let tick = 0, airborne = 0, touchdowns = 0, aloft = false;
  const run = n => {
    for (let i = 0; i < n; i++) {
      const phase = tick % cycle, resting = phase >= 6 * hz, target = phase < hz ? -1 : 1;
      pilot.flags = resting ? M.ControlFlag.Connected : M.ControlFlag.Connected | M.ControlFlag.Armed;
      pilot.throttle = resting ? 0 : Math.max(0, Math.min(0.4, 0.2 + 0.2 * (d.state.vd - target)));
      d.nowMs = pilot.wallTimeMs = (tick + 0.5) * 1000 / hz; tick++;
      d.stepNow(pilot);
      if (d.state.down < TOUCH_DOWN_M - 0.05) { airborne++; aloft = true; }
      else if (aloft && d.state.down >= TOUCH_DOWN_M) { touchdowns++; aloft = false; }
      if (d.fault !== '') throw new Error(`Bench step failed: ${d.fault}`);
    }
  };
  return { d, run, contact: c.contact, airborne: () => airborne, touchdowns: () => touchdowns };
}

// ---- compute distribution per rate -------------------------------------------
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const timing = [];
for (const hz of [400, 800, 1200]) {
  const { d, run } = await vehicle(hz);
  run(20000);
  const samples = new Float64Array(timingSteps);
  for (let i = 0; i < timingSteps; i++) { const start = performance.now(); run(1); samples[i] = performance.now() - start; }
  const sorted = Array.from(samples).sort((a, b) => a - b), periodMs = 1000 / hz;
  const meanMs = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  const row = { hz, steps: timingSteps, warmupSteps: 20000, periodMs, meanMs, p50Ms: quantile(sorted, 0.5), p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99), maxMs: sorted[sorted.length - 1], p99WithinPeriod: quantile(sorted, 0.99) <= periodMs,
    realtimeRatioAtMean: periodMs / meanMs };
  timing.push(row); d.dispose();
  console.log(`4 rotors on contact at ${hz} Hz: mean ${meanMs.toFixed(4)} ms, p99 ${row.p99Ms.toFixed(4)} ms against a ${periodMs.toFixed(3)} ms period`);
}

// ---- G1: allocation over N warmed steps at 400 Hz ------------------------------
const events = [], observer = new PerformanceObserver(list => { for (const e of list.getEntries()) events.push(e.startTime); });
observer.observe({ entryTypes: ['gc'] });
const settle = () => new Promise(r => setTimeout(r, 30));
const young = () => v8.getHeapSpaceStatistics().find(s => s.space_name === 'new_space').space_used_size;
async function measure(fn, n) {
  globalThis.gc(); await settle();
  const before = young(), start = performance.now(); fn(n); const end = performance.now(), bytes = young() - before; await settle();
  return { steps: n, bytes, bytesPerStep: bytes / n, gcEvents: events.filter(t => t >= start && t <= end).length, elapsedMs: end - start };
}
const g1 = await vehicle(400);
g1.run(100000); await measure(g1.run, 10000);
const before = g1.touchdowns(), measured = await measure(g1.run, steps);
const allocation = { ...measured, warmupSteps: 110000, airborneSteps: g1.airborne(), touchdowns: g1.touchdowns() - before,
  cycles: Math.floor(steps / (7 * 400)),
  nativeAllocationCalls: g1.contact.allocationCalls, nativeAllocationBytes: g1.contact.allocationBytes };
g1.d.dispose();
const sink = { value: null };
const positive = await measure(n => { for (let i = 0; i < n; i++) sink.value = { i }; }, 1000000);
const controlDetected = positive.gcEvents > 0 || positive.bytes > 1000000;
observer.disconnect();
// Every measured cycle must have taken off and landed again.
const flew = allocation.touchdowns >= allocation.cycles;
const passed = allocation.gcEvents === 0 && allocation.bytesPerStep < 0.01 && controlDetected && flew &&
  allocation.nativeAllocationCalls === 0 && allocation.nativeAllocationBytes === 0;
console.log(`G1 at 400 Hz: ${allocation.steps} steps, ${allocation.bytesPerStep.toFixed(6)} B/step, ${allocation.gcEvents} GC events, ` +
  `native ${allocation.nativeAllocationCalls} calls; ${allocation.touchdowns} touchdowns in ${allocation.cycles} cycles; control detected ${controlDetected}`);

const sources = Object.keys(bundled.metafile.inputs).filter(p => p !== 'bench-entry.ts').map(p => p.replaceAll('\\', '/')).sort();
const report = {
  schemaVersion: 1, task: 'TASK-095', status: passed ? 'pass' : 'failed',
  vehicle: { fixture: 'tests/bet-runtime-fixture.ts flightConfiguration() with 0.6 N m motors on four legs (tests/flight-contact.test.ts)',
    load: 'repeated 7 s cycle on a vertical-speed loop: climb toward 1 m/s for 1 s, descend toward 1 m/s for 5 s onto the legs, rest 1 s with the motors cut' },
  budget: 'Step period 1/hz', timing, allocation: { ...allocation, positiveControl: positive, controlDetected },
  identity: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown', cpus: os.cpus().length,
    wasmSha256: sha(wasmBytes), contactSha256: sha(contactBytes), sourceInputs: sources.map(file => ({ file, sha256: sha(read(file)) })) },
  scope: 'Node/V8 single-threaded compute of BetFlightDynamics with GroundContact as its body integrator; not browser Worker, session or target-hardware timing',
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(out);
if (!passed) process.exitCode = 1;
