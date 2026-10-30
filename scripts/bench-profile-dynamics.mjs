// TASK-144: 16-rotor profile dynamics compute and allocation benchmark (Node/V8 evidence, not browser or
// target-hardware timing). The S19 sixteen-motor fixture flies on the example component cards: the
// physics step is BetFlightDynamics with the TASK-092 drive on all 16 rotors. The rotors spin up from
// rest to 80% of each one's hover-trim duty (about 64% of hover thrust), so the vehicle stays on the
// synthetic pad, every rotor runs at flight speed and the run stays bounded for a million steps.
//
//   node scripts/bench-profile-dynamics.mjs [--steps N] [--timing-steps N] [--out PATH]
//
// Reports, per rate (400, 800, 1200 Hz), the per-step compute distribution against the step period
// (decisions A-04 and A-05 of docs/decisions/phase1-acceptance.md), and at 400 Hz the young-generation
// bytes and GC events over N warmed steps (G1), with an allocating positive control.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
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
const out = resolve(root, option('out', 'test-results/bench/profile-dynamics-16.json'));
if (!Number.isInteger(steps) || steps < 1000 || !Number.isInteger(timingSteps) || timingSteps < 1000) { console.error('Invalid arguments'); process.exit(2); }

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
mkdirSync(resolve(root, '.cache/bench-profile'), { recursive: true });
const bundle = resolve(root, '.cache/bench-profile/entry.mjs');
const bundled = await build({ stdin: { contents: `
export { validateAircraftProfile, withPropellerPolars } from './packages/aircraft/src/profile.ts';
export { validateComponentCard } from './packages/aircraft/src/components.ts';
export { resolveComponents } from './packages/aircraft/src/resolve-components.ts';
export { deriveVehicleManifest } from './packages/aircraft/src/derive-manifest.ts';
export { buildProfileDynamics } from './packages/physics/src/profile-dynamics.ts';
export { BetFlightDynamics } from './packages/physics/src/bet-dynamics.ts';
export { trimHover } from './tests/support/hover-trim.ts';
export { newActuatorFrameV2, newInput, ActuatorFlagV2 } from './packages/protocol/src/index.ts';`, resolveDir: root, sourcefile: 'bench-entry.ts', loader: 'ts' },
bundle: true, platform: 'node', format: 'esm', outfile: bundle, metafile: true });
const M = await import(pathToFileURL(bundle).href);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(resolve(root, path));
const json = path => JSON.parse(read(path).toString('utf8'));

// ---- the 16-motor S19 fixture on the example cards ---------------------------
const ids = { motor: '11'.repeat(32), propeller: '22'.repeat(32), esc: '33'.repeat(32), battery: '44'.repeat(32) };
const fixture = M.validateAircraftProfile(json('tests/fixtures/aircraft/octa-coaxial-16.json'));
const profile = M.withPropellerPolars(M.validateAircraftProfile({ ...fixture, battery: { card: ids.battery },
  motors: fixture.motors.map(motor => ({ ...motor, components: { motor: ids.motor, propeller: ids.propeller, esc: ids.esc } })) }),
[{ card: ids.propeller, polar: 'naca6409-neuralfoil-v1' }]);
const cards = new Map(Object.entries(ids).map(([type, id]) => [id, M.validateComponentCard(json(`tests/fixtures/components/${type}-example.json`))]));
const resolved = M.resolveComponents(profile, cards);
if (!resolved.components) { console.error(`Missing: ${resolved.missing.join('; ')}`); process.exit(1); }
const derived = await M.deriveVehicleManifest(profile, resolved.components, { modelId: 144 });
const { configuration } = M.buildProfileDynamics(derived.manifest);
// The BET WASM comes from scripts/build-wasm.mjs (packages/wasm-bet/dist is not tracked).
const wasmBytes = read('packages/wasm-bet/dist/mirage_bet.scalar.wasm');
const module = new WebAssembly.Module(wasmBytes);
const trim = M.trimHover(module, configuration);

function vehicle(hz) {
  const d = new M.BetFlightDynamics(module, configuration, hz);
  const frame = M.newActuatorFrameV2(), pilot = M.newInput();
  frame.motorMapId = configuration.motorMapId; frame.actuatorFlags = M.ActuatorFlagV2.Armed; frame.actuatorCount = 16;
  derived.manifest.rotors.forEach((rotor, i) => { frame.normalizedActuators[rotor.motorChannel] = 0.8 * trim.duty[i]; });
  let tick = 0;
  const run = n => {
    for (let i = 0; i < n; i++) {
      d.useActuators(frame); d.nowMs = ++tick * 1000 / hz; d.stepNow(pilot);
      if (d.fault !== '' || d.state.down !== 0) throw new Error(`Bench step failed: ${d.fault || 'left the pad'}`);
    }
  };
  return { d, run };
}

// ---- compute distribution per rate -------------------------------------------
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const timing = [];
for (const hz of [400, 800, 1200]) {
  const { d, run } = vehicle(hz);
  run(20000);
  const samples = new Float64Array(timingSteps);
  for (let i = 0; i < timingSteps; i++) { const start = performance.now(); run(1); samples[i] = performance.now() - start; }
  const sorted = Array.from(samples).sort((a, b) => a - b), periodMs = 1000 / hz;
  const meanMs = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  // A-05 judges the average: a real-time run must keep at least 0.99 of simulated time per wall-clock second.
  const row = { hz, steps: timingSteps, warmupSteps: 20000, periodMs, meanMs, p50Ms: quantile(sorted, 0.5), p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99), maxMs: sorted[sorted.length - 1], p99WithinPeriod: quantile(sorted, 0.99) <= periodMs,
    realtimeRatioAtMean: periodMs / meanMs, meanMeetsA05: periodMs / meanMs >= 0.99, realtimeRatioAtP50: periodMs / quantile(sorted, 0.5) };
  timing.push(row); d.dispose();
  console.log(`16 rotors at ${hz} Hz: mean ${meanMs.toFixed(3)} ms, p50 ${row.p50Ms.toFixed(3)} ms, p99 ${row.p99Ms.toFixed(3)} ms against a ${periodMs.toFixed(3)} ms period`);
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
const g1 = vehicle(400);
const memoryBytes = g1.d.escEngine.memoryBytes;
g1.run(100000); await measure(g1.run, 10000);
const allocation = { ...await measure(g1.run, steps), warmupSteps: 110000, memoryStable: g1.d.escEngine.memoryStable && g1.d.escEngine.memoryBytes === memoryBytes };
g1.d.dispose();
const sink = { value: null };
const positive = await measure(n => { for (let i = 0; i < n; i++) sink.value = { i }; }, 1000000);
const controlDetected = positive.gcEvents > 0 || positive.bytes > 1000000;
observer.disconnect();
const passed = allocation.gcEvents === 0 && allocation.bytesPerStep < 0.01 && allocation.memoryStable && controlDetected;
console.log(`G1 at 400 Hz: ${allocation.steps} steps, ${allocation.bytesPerStep.toFixed(6)} B/step, ${allocation.gcEvents} GC events; control detected ${controlDetected}`);

const sources = Object.keys(bundled.metafile.inputs).filter(p => p !== 'bench-entry.ts').map(p => p.replaceAll('\\', '/')).sort();
const report = {
  schemaVersion: 1, task: 'TASK-144', status: passed ? 'pass' : 'failed',
  vehicle: { fixture: 'octa-coaxial-16', rotors: derived.manifest.rotorCount, manifestSha256: derived.sha256, cards: 'tests/fixtures/components/*-example.json',
    polar: 'naca6409-neuralfoil-v1', load: 'synthetic pad at 0.8 x hover-trim duty, spun up from rest', trimDuty: trim.duty, trimRpm: trim.omegaRadS.map(w => w * 30 / Math.PI) },
  budget: 'Step period 1/hz (A-04: 400 Hz for every configuration; A-05: real-time ratio at least 0.99)',
  timing, allocation: { ...allocation, positiveControl: positive, controlDetected },
  identity: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown', cpus: os.cpus().length,
    wasmSha256: sha(wasmBytes), sourceInputs: sources.map(file => ({ file, sha256: sha(read(file)) })) },
  scope: 'Node/V8 single-threaded compute of BetFlightDynamics alone; not browser Worker, session or target-hardware timing',
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(out);
if (!passed) process.exitCode = 1;
