// TASK-091: BET kernel compute benchmark (Node/V8 and native host evidence, not browser,
// Worker or target-hardware timing).
//
//   node scripts/bench-bet.mjs [--steps N] [--out PATH] [--baseline PATH] [--fixtures a,b] [--variants a,b] [--rates a,b]
//
// WASM: BetFlightDynamics with the TASK-092 drive for the S19 quad X (4 rotors), octa X
// (8 rotors) and sixteen-motor (16 rotors) fixtures on the example component cards and
// NACA6409, in the scalar and SIMD128 builds, at 400, 800 and 1200 Hz. The rotors spin up
// from rest to 0.8 of their hover-trim duty, so each vehicle stays on the synthetic pad
// with every rotor near flight speed. Native: the bound-rotor step of one sixteen-motor
// rotor (`native/bet/examples/bench_bound.rs`, release build). With --baseline, every row
// is compared with the same row of a baseline report from the same CPU model.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}
const steps = Number(option('steps', '20000'));
const out = resolve(root, option('out', 'test-results/bench/bet.json'));
const baselinePath = option('baseline', null);
if (!Number.isInteger(steps) || steps < 1000) { console.error('Invalid --steps'); process.exit(2); }
// Filters for quick partial runs; a partial report says which rows it holds.
const list = (name, all) => { const value = option(name, null); return value === null ? all : value.split(',').filter(x => all.includes(x)); };
const fixtures = list('fixtures', ['quad-x', 'octa-x', 'octa-coaxial-16']);
const variantNames = list('variants', ['scalar', 'simd128']);
const rates = list('rates', ['400', '800', '1200']).map(Number);

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
mkdirSync(resolve(root, '.cache/bench-bet'), { recursive: true });
const bundle = resolve(root, '.cache/bench-bet/entry.mjs');
const bundled = await build({ stdin: { contents: `
export { validateAircraftProfile, withPropellerPolars } from './packages/aircraft/src/profile.ts';
export { validateComponentCard } from './packages/aircraft/src/components.ts';
export { resolveComponents } from './packages/aircraft/src/resolve-components.ts';
export { deriveVehicleManifest } from './packages/aircraft/src/derive-manifest.ts';
export { buildProfileDynamics } from './packages/physics/src/profile-dynamics.ts';
export { BetFlightDynamics } from './packages/physics/src/bet-dynamics.ts';
export { encodeBoundRotor } from './packages/wasm-bet/src/rotor.ts';
export { trimHover } from './tests/support/hover-trim.ts';
export { newActuatorFrameV2, newInput, ActuatorFlagV2 } from './packages/protocol/src/index.ts';`, resolveDir: root, sourcefile: 'bench-bet-entry.ts', loader: 'ts' },
bundle: true, platform: 'node', format: 'esm', outfile: bundle, metafile: true });
const M = await import(pathToFileURL(bundle).href);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(resolve(root, path));
const json = path => JSON.parse(read(path).toString('utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// ---- vehicles: S19 fixtures on the example cards ------------------------------------
const ids = { motor: '11'.repeat(32), propeller: '22'.repeat(32), esc: '33'.repeat(32), battery: '44'.repeat(32) };
const cards = new Map(Object.entries(ids).map(([type, id]) => [id, M.validateComponentCard(json(`tests/fixtures/components/${type}-example.json`))]));
async function vehicleOf(fixture) {
  const base = M.validateAircraftProfile(json(`tests/fixtures/aircraft/${fixture}.json`));
  const profile = M.withPropellerPolars(M.validateAircraftProfile({ ...base, battery: { card: ids.battery },
    motors: base.motors.map(motor => ({ ...motor, components: { motor: ids.motor, propeller: ids.propeller, esc: ids.esc } })) }),
  [{ card: ids.propeller, polar: 'naca6409-neuralfoil-v1' }]);
  const resolved = M.resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  const derived = await M.deriveVehicleManifest(profile, resolved.components, { modelId: 91 });
  return { fixture, derived, configuration: M.buildProfileDynamics(derived.manifest).configuration };
}
const vehicles = [];
for (const fixture of fixtures) vehicles.push(await vehicleOf(fixture));
const variants = variantNames.map(name => {
  const bytes = read(`packages/wasm-bet/dist/mirage_bet.${name}.wasm`);
  return { name, bytes, module: new WebAssembly.Module(bytes) };
});
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
function summary(samples, periodMs) {
  const sorted = Array.from(samples).sort((a, b) => a - b), meanMs = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  return { meanMs, p50Ms: quantile(sorted, 0.5), p95Ms: quantile(sorted, 0.95), p99Ms: quantile(sorted, 0.99), maxMs: sorted[sorted.length - 1],
    realtimeRatioAtMean: periodMs / meanMs };
}

// ---- WASM flight steps -----------------------------------------------------------------
const wasm = [];
for (const variant of variants) {
  for (const v of vehicles) {
    const trim = M.trimHover(variant.module, v.configuration);
    for (const hz of rates) {
      const d = new M.BetFlightDynamics(variant.module, v.configuration, hz);
      const frame = M.newActuatorFrameV2(), pilot = M.newInput();
      frame.motorMapId = v.configuration.motorMapId; frame.actuatorFlags = M.ActuatorFlagV2.Armed; frame.actuatorCount = v.derived.manifest.rotorCount;
      v.derived.manifest.rotors.forEach((rotor, i) => { frame.normalizedActuators[rotor.motorChannel] = 0.8 * trim.duty[i]; });
      let tick = 0;
      const step = () => {
        d.useActuators(frame); d.nowMs = ++tick * 1000 / hz; d.stepNow(pilot);
        if (d.fault !== '' || d.state.down !== 0) throw new Error(`${v.fixture} step failed: ${d.fault || 'left the pad'}`);
      };
      for (let i = 0; i < 20000; i++) step();
      const samples = new Float64Array(steps);
      for (let i = 0; i < steps; i++) { const start = performance.now(); step(); samples[i] = performance.now() - start; }
      d.dispose();
      const row = { variant: variant.name, fixture: v.fixture, rotors: v.derived.manifest.rotorCount, hz, steps, warmupSteps: 20000, periodMs: 1000 / hz,
        ...summary(samples, 1000 / hz) };
      wasm.push(row);
      console.log(`${variant.name} ${v.fixture} ${hz} Hz: mean ${row.meanMs.toFixed(4)} ms, p50 ${row.p50Ms.toFixed(4)} ms, p99 ${row.p99Ms.toFixed(4)} ms`);
    }
  }
}

// ---- native bound-rotor steps ---------------------------------------------------------------
const sixteen = (await vehicleOf('octa-coaxial-16')).configuration, rotor = sixteen.manifest.rotors[0];
const definition = { geometry: rotor, polar: sixteen.polars.get(rotor.polarId), initialOmegaRadS: 500, inflowTauS: 0.1, inflowLimitMps: 500, minimumConfidence: 0.9 };
const nativeDir = resolve(root, 'native');
execFileSync('cargo', ['build', '--release', '--locked', '-p', 'mirage-bet', '--example', 'bench_bound'], { cwd: nativeDir, stdio: 'pipe' });
const binary = resolve(nativeDir, 'target/release/examples/bench_bound');
const native = [];
for (const hz of rates) {
  const configPath = resolve(root, `.cache/bench-bet/rotor-${hz}.bin`);
  writeFileSync(configPath, M.encodeBoundRotor(definition, 1 / hz));
  const row = JSON.parse(execFileSync(binary, [configPath, String(hz), String(Math.max(steps, 100000))], { encoding: 'utf8' }));
  // The baseline example printed one kernel; since TASK-091 it times the production and the reference step.
  const production = row.production ?? row;
  native.push({ hz, steps: row.steps, warmupSteps: row.warmupSteps, production, reference: row.reference ?? null, configSha256: sha(readFileSync(configPath)) });
  console.log(`native rotor step ${hz} Hz: production p50 ${production.p50Us.toFixed(2)} us, p99 ${production.p99Us.toFixed(2)} us` +
    (row.reference ? `; reference p50 ${row.reference.p50Us.toFixed(2)} us, p99 ${row.reference.p99Us.toFixed(2)} us` : ''));
}
const rustc = execFileSync('rustc', ['--version'], { cwd: nativeDir, encoding: 'utf8' }).trim();

// ---- comparison with a baseline report ------------------------------------------------------
const cpu = os.cpus()[0]?.model ?? 'unknown';
let comparison = null;
if (baselinePath) {
  const baseline = JSON.parse(readFileSync(resolve(root, baselinePath), 'utf8'));
  if (baseline.identity?.cpu !== cpu) throw new Error(`Baseline CPU ${baseline.identity?.cpu} differs from ${cpu}; speed-ups need one machine`);
  const key = r => `${r.variant}/${r.fixture}/${r.hz}`;
  const before = new Map(baseline.wasm.map(r => [key(r), r]));
  comparison = { baseline: baselinePath, baselineCommit: baseline.identity.commit,
    wasm: wasm.map(r => { const b = before.get(key(r)); return b ? { variant: r.variant, fixture: r.fixture, hz: r.hz,
      meanSpeedup: b.meanMs / r.meanMs, p50Speedup: b.p50Ms / r.p50Ms, p99Speedup: b.p99Ms / r.p99Ms } : null; }).filter(Boolean),
    native: native.map(r => { const n = baseline.native.find(x => x.hz === r.hz), b = n && (n.production ?? n); return b ? { hz: r.hz,
      meanSpeedup: b.meanUs / r.production.meanUs, p50Speedup: b.p50Us / r.production.p50Us, p99Speedup: b.p99Us / r.production.p99Us } : null; }).filter(Boolean) };
  for (const c of comparison.wasm) console.log(`speed-up ${c.variant} ${c.fixture} ${c.hz} Hz: mean ${c.meanSpeedup.toFixed(2)}x, p99 ${c.p99Speedup.toFixed(2)}x`);
  for (const c of comparison.native) console.log(`speed-up native ${c.hz} Hz: mean ${c.meanSpeedup.toFixed(2)}x, p50 ${c.p50Speedup.toFixed(2)}x`);
}

const sources = Object.keys(bundled.metafile.inputs).filter(p => p !== 'bench-bet-entry.ts').map(p => p.replaceAll('\\', '/'));
sources.push('scripts/bench-bet.mjs', 'native/bet/examples/bench_bound.rs', 'native/Cargo.lock', 'native/rust-toolchain.toml');
const report = {
  schemaVersion: 1, benchmark: 'bet-kernel', task: 'TASK-091', generatedAt: new Date().toISOString(),
  vehicles: vehicles.map(v => ({ fixture: v.fixture, rotors: v.derived.manifest.rotorCount, manifestSha256: v.derived.sha256 })),
  load: 'synthetic pad at 0.8 x hover-trim duty, spun up from rest; cards tests/fixtures/components/*-example.json; polar naca6409-neuralfoil-v1',
  budget: 'Step period 1/hz; A-05 judges the mean real-time ratio (at least 0.99); the G3 compute limit is 0.4167 ms at 1200 Hz',
  rows: { fixtures, variants: variantNames, rates }, wasm, native, comparison,
  identity: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'native/bet/src', 'packages') !== '',
    node: process.version, platform: process.platform, arch: process.arch, cpu, cpus: os.cpus().length, rustc,
    wasmSha256: Object.fromEntries(variants.map(v => [v.name, sha(v.bytes)])),
    sourceInputs: [...new Set(sources)].sort().map(file => ({ file, sha256: sha(read(file)) })) },
  scope: 'Node/V8 single-threaded compute of BetFlightDynamics, and native compute of one bound-rotor step; not browser Worker, session or target-hardware timing',
};
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(out);
