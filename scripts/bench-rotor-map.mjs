#!/usr/bin/env node
// TASK-103: what a 16-rotor tick costs on the table rotor, against the declared 31.25 µs, and on the full BET for comparison. Node/V8
// evidence on this host, not browser or target-hardware timing.
//
//   node scripts/bench-rotor-map.mjs [--ticks N] [--out PATH]
//
// Each tick steps all 16 rotors of one engine in scalar WASM through step interface v2. Every rotor's query lies off the table's nodes,
// with its own speed and air. Reports the wall time of single ticks, the timer's own overhead measured apart, and the mean of an untimed
// run, with the host's load, because other work on this Mac moves these numbers.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const ticks = Number(option('ticks', '200000')), out = resolve(root, option('out', 'test-results/bench/rotor-map.json'));
if (!Number.isInteger(ticks) || ticks < 1000) { console.error('Invalid --ticks'); process.exit(2); }
const LIMIT_US = 31.25, ROTORS = 16, HZ = 800;

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
mkdirSync(resolve(root, '.cache/bench-rotor-map'), { recursive: true });
const bundle = resolve(root, '.cache/bench-rotor-map/entry.mjs');
await build({ stdin: { contents: `
export { BetRotorEngineV2, BOUND_V2_INPUT_DOUBLES } from './packages/wasm-bet/src/rotor-v2.ts';
export { readRotorMap } from './packages/wasm-bet/src/rotor-map.ts';
export { mapRotorDefinition } from './scripts/rotor-map/generate.ts';`, resolveDir: root, sourcefile: 'bench-rotor-map-entry.ts', loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle });
const { BetRotorEngineV2, BOUND_V2_INPUT_DOUBLES, readRotorMap, mapRotorDefinition } = await import(pathToFileURL(bundle).href);

const wasm = readFileSync(resolve(root, 'packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
const fixture = readFileSync(resolve(root, 'tests/fixtures/rotors/rotor-map-synthetic.json'));
const module = new WebAssembly.Module(wasm);
const table = await readRotorMap(JSON.parse(fixture.toString('utf8')));
const bet = mapRotorDefinition();

function engineOf(definition) {
  const definitions = Array.from({ length: ROTORS }, (_, i) => ({ ...definition, initialOmegaRadS: 230 + 25 * i,
    geometry: { ...definition.geometry, shaftInertiaKgM2: 1e9, bearingViscousNmPerRadS: 0 } }));
  const engine = new BetRotorEngineV2(module, definitions, HZ);
  for (let i = 0; i < ROTORS; i++) {
    const row = i * BOUND_V2_INPUT_DOUBLES, angle = i * 0.39, speed = 1.3 + 0.7 * i;
    engine.input.set([1.1, 1.75e-5, 335, speed * Math.cos(angle), speed * Math.sin(angle), -0.4 * i, 0, 0, 0, 0], row);
  }
  return engine;
}
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
function measure(name, definition, count) {
  const engine = engineOf(definition);
  const step = () => { if (!engine.stepInto()) throw new Error(`${name}: status ${engine.lastStatus}`); };
  for (let i = 0; i < Math.min(count, 20000); i++) step();
  const started = performance.now();
  for (let i = 0; i < count; i++) step();
  const meanUs = (performance.now() - started) * 1000 / count;
  // Single ticks; the clock's granularity and cost are measured the same way, with no tick between the two reads.
  const samples = new Float64Array(Math.min(count, 20000)), overhead = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) { const a = performance.now(); step(); samples[i] = (performance.now() - a) * 1000; }
  for (let i = 0; i < overhead.length; i++) { const a = performance.now(); overhead[i] = (performance.now() - a) * 1000; }
  samples.sort(); overhead.sort();
  const memoryBytes = engine.memoryBytes;
  engine.dispose();
  return { name, ticks: count, meanUs, tickUs: { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), p99: percentile(samples, 0.99), max: samples[samples.length - 1] },
    timerOverheadUs: { p50: percentile(overhead, 0.5), p99: percentile(overhead, 0.99) }, memoryBytes };
}
const load = () => os.loadavg().map(value => Number(value.toFixed(2)));
const before = load();
const map = measure('table', { ...bet, rotorModel: 'map', rotorMap: table }, ticks);
// The full BET is far slower, so a tenth of the ticks gives the comparison.
const full = measure('full BET with dynamic inflow', bet, Math.max(1000, Math.floor(ticks / 10)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { schemaVersion: 1, status: map.meanUs <= LIMIT_US ? 'pass' : 'fail', limitUs: LIMIT_US, limitOn: 'mean over the untimed run',
  rotors: ROTORS, hz: HZ, realtimeFactorAtMean: 1e6 / HZ / map.meanUs, table: map, fullBet: full, tableSpeedupOverBet: full.meanUs / map.meanUs,
  host: { cpu: os.cpus()[0]?.model ?? 'unknown', logicalCpus: os.cpus().length, platform: process.platform, arch: process.arch, node: process.version, loadAverageBefore: before, loadAverageAfter: load() },
  artifactSha256: sha(wasm), fixtureSha256: sha(fixture), scope: 'Node/V8 on this host; one thread; not browser or target-hardware evidence.' };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'pass') process.exitCode = 1;
