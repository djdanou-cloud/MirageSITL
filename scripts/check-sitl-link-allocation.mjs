// TASK-153 G1: allocation of the integrated lockstep step in Node/V8 (not
// browser or target-hardware evidence). One step is what the physics Worker
// does per servo record: SitlJsonLink.receive copies the record and writes the
// actuator frame for the next tick, PhysicsSessionV2.pump runs that tick of the
// S19 quad X profile (BET rotors on the TASK-092 drive), and SitlJsonLink.poll
// encodes the JSON state record. The WebSocket send is I/O and excluded. The
// servo record is preallocated; only its frame count changes between steps.
// The PWM keeps the quad on the synthetic pad with its rotors spinning, so a
// million steps stay bounded. After warmup it reports young-generation bytes
// and GC events over N steps, with an allocating positive control.
//
//   node scripts/check-sitl-link-allocation.mjs [--steps N] [--out PATH]
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
const steps = Number(option('steps', '1000000'));
const out = resolve(root, option('out', 'test-results/bench/sitl-link-allocation.json'));
if (!Number.isInteger(steps) || steps < 1000) { console.error('Invalid --steps'); process.exit(2); }

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
mkdirSync(resolve(root, '.cache/sitl-link'), { recursive: true });
const bundle = resolve(root, '.cache/sitl-link/entry.mjs');
await build({ stdin: { contents: `
export { quadProfile } from './tests/support/quad-profile.ts';
export { VehicleRegistry } from './packages/physics/src/vehicle-manifest.ts';
export { profileModelPort } from './packages/physics/src/profile-dynamics.ts';
export { PhysicsSessionV2 } from './packages/physics/src/session-v2.ts';
export { SitlJsonLink } from './packages/autopilot/src/sitl-link.ts';
export { StateReaderV2, createSharedMemoryV2, createSpscQueue, newHeaderSnapshotV2 } from './packages/protocol/src/index.ts';`,
resolveDir: root, sourcefile: 'sitl-link-entry.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle });
const M = await import(pathToFileURL(bundle).href);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const wasmBytes = readFileSync(resolve(root, 'packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
const module = new WebAssembly.Module(wasmBytes);

const HZ = 400, EPOCH = 1, PWM_US = 1300;
const { derived } = await M.quadProfile();
const registry = new M.VehicleRegistry();
await registry.register(derived.bytes, derived.sha256);
const stateBuffer = M.createSharedMemoryV2(), actuatorBuffer = M.createSpscQueue('actuator');
// The clock is an object field, as in scripts/bench-physics.mjs: a captured `let` double is boxed on every write.
const fake = { now: 0 };
const session = new M.PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: M.createSpscQueue('sensor'), actuatorBuffer },
  { monotonicMs: () => fake.now, wallMs: () => 1_790_000_000_000 + fake.now }, undefined, null, M.profileModelPort(registry, () => module));
const reader = new M.StateReaderV2(stateBuffer), header = M.newHeaderSnapshotV2();
let requestId = 0;
for (const [type, extra] of [['sim.configure', { hz: HZ, clockMode: 'sitl-lockstep' }],
  ['model.load', { modelId: derived.manifest.modelId, manifestSha256: derived.sha256 }], ['sim.start', {}]]) {
  reader.readHeader(header);
  session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
  await session.settled();
  let status = '';
  session.drain(result => { status = result.status ?? result.type; });
  if (status !== 'applied') { console.error(`${type} was not applied: ${status}`); process.exit(1); }
}
const link = new M.SitlJsonLink(stateBuffer, actuatorBuffer, {
  bridgeEpoch: EPOCH, motorChannels: derived.manifest.rotors.map(rotor => rotor.motorChannel + 1), motorMapId: derived.manifest.modelId });

// One preallocated channel 3 record: header, then a 16-channel servo packet.
const record = new Uint8Array(16 + 40), view = new DataView(record.buffer);
view.setUint8(0, 1); view.setUint8(1, 3); view.setUint32(4, EPOCH, true); view.setUint32(12, 40, true);
view.setUint16(16, 18458, true); view.setUint16(18, HZ, true);
for (let i = 0; i < 4; i++) view.setUint16(24 + 2 * i, PWM_US, true);
let frame = 0, sent = 0;
const run = n => {
  for (let i = 0; i < n; i++) {
    view.setUint32(20, frame, true); view.setUint32(8, frame, true); frame++;
    fake.now += 2.5;
    if (link.receive(record) !== 'step') throw new Error(`Frame ${frame - 1} did not step`);
    session.pump();
    const length = link.poll();
    if (length === 0) throw new Error(`No reply for frame ${frame - 1}: ${session.fault}`);
    sent += length;
  }
};

const events = [], observer = new PerformanceObserver(list => { for (const e of list.getEntries()) events.push(e.startTime); });
observer.observe({ entryTypes: ['gc'] });
const settle = () => new Promise(done => setTimeout(done, 50));
const young = () => v8.getHeapSpaceStatistics().find(s => s.space_name === 'new_space').space_used_size;
async function measure(fn, n) {
  globalThis.gc(); await settle();
  const before = young(), start = performance.now(); fn(n); const end = performance.now(), bytes = young() - before; await settle();
  return { steps: n, bytes, bytesPerStep: bytes / n, gcEvents: events.filter(t => t >= start && t <= end).length, elapsedMs: end - start };
}
run(100000); await measure(run, 10000);
// The link's own state object: a second FlightStateV2 here would make the state decoder polymorphic.
const onPad = link.state.downM === 0;
const allocation = await measure(run, steps);
const stillOnPad = link.state.downM === 0;
const sink = { value: null };
const positive = await measure(n => { for (let i = 0; i < n; i++) sink.value = { i }; }, 1000000);
observer.disconnect();
const controlDetected = positive.gcEvents > 0 || positive.bytes > 1000000;
const counts = { ...link.lockstepStats, replies: link.stats.replies, held: link.stats.held, queueFull: link.stats.queueFull };
const passed = allocation.gcEvents === 0 && allocation.bytesPerStep < 0.01 && controlDetected && onPad && stillOnPad &&
  counts.steps === frame && counts.duplicates === 0 && counts.gaps === 0 && session.fault === '';
console.log(`G1 lockstep at ${HZ} Hz: ${allocation.steps} steps, ${allocation.bytesPerStep.toFixed(6)} B/step, ${allocation.gcEvents} GC events; ` +
  `control detected ${controlDetected}; on the pad ${onPad && stillOnPad}`);
const report = {
  schemaVersion: 1, task: 'TASK-153', status: passed ? 'pass' : 'failed', generatedAt: new Date().toISOString(),
  scope: 'SitlJsonLink.receive + PhysicsSessionV2.pump + SitlJsonLink.poll per servo record, S19 quad X profile on the example cards; WebSocket I/O excluded; Node/V8, not browser or target-hardware evidence',
  hz: HZ, pwmUs: PWM_US, warmupSteps: 110000, allocation: { ...allocation, positiveControl: positive, controlDetected },
  counts, replyBytes: sent,
  identity: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, wasmSha256: sha(wasmBytes),
    manifestSha256: derived.sha256 },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`Report: ${out}`);
process.exit(passed ? 0 : 1);
