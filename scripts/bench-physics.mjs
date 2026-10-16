// Physics hot-path benchmark (TASK-014). Writes a machine-readable report that
// validates against docs/benchmarks/schema.json.
//
//   node scripts/bench-physics.mjs [--steps N] [--hz 400|800|1200] [--realtime-seconds S] [--out PATH]
//
// Drives the real PhysicsSessionV2 (the Worker's step: pilot mailbox read, arm
// latch, control queue, demo dynamics, v2 state publication, header counters)
// with a deterministic clock, one step per pump. Separately reports:
//   allocation  young-generation bytes allocated over N warmed steps, with GC
//               events attributed to the window (method validated by controls)
//   compute     per-pump duration distribution (timer overhead reported apart)
//   realtime    wall-clock run: wakeup lateness and executed Hz
// The script re-executes itself with --expose-gc and a 64 MiB semi-space.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

// --single-threaded: V8 compiles and collects on the main thread only. With concurrent
// compilation, finished jobs are installed on the main thread mid-window and allocate
// 0-120 KB at times that depend on CPU contention (seen on Node 24 and 2-CPU CI runners),
// which no window arithmetic separates reliably from the loop. The measured code and its
// allocations are the same either way; only engine background work is serialized.
const FLAGS = ['--expose-gc', '--max-semi-space-size=64', '--single-threaded'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (typeof globalThis.gc !== 'function') {
  const child = spawnSync(process.execPath, [...FLAGS, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}
const steps = Number(option('steps', '1000000'));
const hz = Number(option('hz', '400'));
const realtimeSeconds = Number(option('realtime-seconds', '3'));
const out = resolve(root, option('out', 'test-results/bench/physics.json'));
if (!Number.isInteger(steps) || steps < 1000 || ![400, 800, 1200].includes(hz) || !(realtimeSeconds > 0)) {
  console.error('Invalid arguments'); process.exit(2);
}

const physics = await import(resolve(root, 'packages/physics/src/index.ts'));
const protocol = await import(resolve(root, 'packages/protocol/src/index.ts'));

// ---- allocation instrument -------------------------------------------------
const gcEvents = [];
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gcEvents.push([e.startTime, e.startTime + e.duration]); });
observer.observe({ entryTypes: ['gc'] });
function youngBytes() {
  for (const space of v8.getHeapSpaceStatistics()) if (space.space_name === 'new_space') return space.space_used_size;
  throw new Error('V8 new_space statistics unavailable');
}
/**
 * Runs `body(n)` twice (the first run warms the measured loop itself, including
 * on-stack replacement), forcing a full GC before the measured run.
 */
function allocationWindow(body, n) {
  body(n);
  globalThis.gc();
  const startMs = performance.now(), before = youngBytes();
  body(n);
  const after = youngBytes(), endMs = performance.now();
  return { startMs, endMs, bytes: after - before };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const gcCount = window => gcEvents.filter(([s, e]) => e >= window.startMs && s <= window.endMs).length;
/**
 * Windows of n and 2n steps. A true per-step allocation rate r makes every
 * GC-free window hold at least r*k bytes, so r <= min_k (bytes_k - empty_k) / k,
 * where empty_k is the identical window of an empty loop (probe overhead).
 * One-off engine allocations (code, feedback) only loosen the bound; any GC
 * in a window means it allocated and that window cannot bound anything.
 */
/**
 * Each size is measured WINDOW_REPEATS times. Residual engine activity can only add
 * bytes to a window, while a true per-step rate r adds r*k bytes to every repeat, so
 * the minimum over GC-free repeats is still an upper bound for each size.
 */
const WINDOW_REPEATS = 3;
function allocationWindows(body, n) {
  return [n, 2 * n].map(size => ({ steps: size, runs: Array.from({ length: WINDOW_REPEATS }, () => allocationWindow(body, size)) }));
}
/** Minimum bytes over GC-free repeats (Infinity when every repeat saw a GC), and the GC count. */
function summarizeSize(size) {
  let bytes = Infinity, gcs = 0;
  for (const run of size.runs) {
    const count = gcCount(run); gcs += count;
    if (count === 0) bytes = Math.min(bytes, run.bytes);
  }
  return { steps: size.steps, bytes, gcs };
}
/**
 * Steady state: V8 tiers code up concurrently (interpreter, Maglev, TurboFan)
 * and lower tiers box doubles. Repeat warm windows until one is GC-free
 * (at most MAX_WARMUP_WINDOWS) so the measurement sees installed optimized
 * code. The number of warm windows is reported; failing to settle is reported
 * as such, never hidden.
 */
const MAX_WARMUP_WINDOWS = 20;
async function warmToSteadyState(body, n) {
  for (let k = 1; k <= MAX_WARMUP_WINDOWS; k++) {
    const window = allocationWindow(body, n);
    await settle();
    if (gcCount(window) === 0) return { warmupWindows: k, steady: true };
  }
  return { warmupWindows: MAX_WARMUP_WINDOWS, steady: false };
}
function upperBound(sizes, emptySizes) {
  const windows = sizes.map(summarizeSize), empty = emptySizes?.map(summarizeSize);
  let bound = Infinity, gcEvents = 0;
  windows.forEach((window, i) => {
    gcEvents += window.gcs;
    if (Number.isFinite(window.bytes)) bound = Math.min(bound, Math.max(0, window.bytes - (empty?.[i]?.bytes ?? 0)) / window.steps);
  });
  // Incremental rate: the 2N window minus the N window cancels any fixed per-window cost
  // (the probe itself, about 3 KB, or any one-off engine work inside a window),
  // which the whole-window bound above charges to the steps. A true rate r adds r*N bytes.
  const [short, long] = windows, [emptyShort, emptyLong] = empty ?? [];
  const bothGcFree = short !== undefined && long !== undefined && Number.isFinite(short.bytes) && Number.isFinite(long.bytes) &&
    Number.isFinite(emptyShort?.bytes ?? 0) && Number.isFinite(emptyLong?.bytes ?? 0);
  const extraSteps = bothGcFree ? long.steps - short.steps : 0;
  const incremental = bothGcFree
    ? Math.max(0, (long.bytes - short.bytes) - ((emptyLong?.bytes ?? 0) - (emptyShort?.bytes ?? 0))) / extraSteps : Infinity;
  const fixedWindowBytes = bothGcFree ? Math.max(0, short.bytes - incremental * short.steps) : null;
  return { bytesPerStepUpperBound: bound, bytesPerStepIncremental: incremental, fixedWindowBytes, gcEvents,
    windowBytes: windows.map(window => window.bytes) };
}

// ---- session under test ------------------------------------------------------
function createSession(clockMode = 'interactive', clock) {
  const stateBuffer = protocol.createSharedMemoryV2(400);
  const session = new physics.PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer,
    sensorBuffer: protocol.createSpscQueue('sensor'), actuatorBuffer: protocol.createSpscQueue('actuator') }, clock);
  const reader = new protocol.StateReaderV2(stateBuffer), header = protocol.newHeaderSnapshotV2();
  let requestId = 0;
  const command = (type, extra = {}) => {
    reader.readHeader(header);
    session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
    session.drain(() => undefined);
  };
  if (hz !== 400) command('sim.configure', { hz, clockMode });
  const pilotWriter = new protocol.PilotWriterV2(stateBuffer), pilot = protocol.newPilotInputV2();
  const stick = throttle => {
    reader.readHeader(header);
    pilot.expectedEpoch = header.sessionEpoch; pilot.throttle = throttle;
    pilot.flags = protocol.PilotFlagV2.Connected | protocol.PilotFlagV2.Armed;
    pilot.sampledWallTimeMs = clock.wallMs();
    pilotWriter.publish(pilot);
  };
  command('sim.start');
  return { session, stick, reader };
}

// Deterministic clock: each pump advances exactly one step, so one pump = one integration.
const fake = { mono: 0 };
const fakeClock = { monotonicMs: () => fake.mono, wallMs: () => 1.79e12 + fake.mono };
const stepMs = 1000 / hz;
const { session, stick } = createSession('interactive', fakeClock);
stick(0);
for (let i = 0; i < 20; i++) { fake.mono += stepMs; session.pump(); }
stick(0.62); // armed climb: exercises the flying branch

/** The measured loop: Main refreshes the stick every 40 steps (100 ms at 400 Hz) as rAF would. */
function runSteps(n) {
  for (let i = 0; i < n; i++) {
    fake.mono += stepMs;
    if (i % 40 === 0) stick(0.62);
    session.pump();
  }
}
const sink = { x: 0, o: null };
const emptyLoop = n => { for (let i = 0; i < n; i++) sink.x += 0; };
await warmToSteadyState(emptyLoop, steps);
const emptyWindows = allocationWindows(emptyLoop, steps);
const allocatingWindows = allocationWindows(n => { for (let i = 0; i < n; i++) sink.o = { i }; }, steps);
const warmup = await warmToSteadyState(runSteps, steps);
const measuredWindows = allocationWindows(runSteps, steps);
await settle();
const measuredResult = upperBound(measuredWindows, emptyWindows);
const emptyResult = upperBound(emptyWindows), allocatingResult = upperBound(allocatingWindows, emptyWindows);
// Any allocation in every step costs >= 8 bytes per step; one 8-byte object every 800 steps is 0.01 B/step.
const BYTES_PER_STEP_THRESHOLD = 0.01;
// Verdict: every repeat GC-free (any GC means the loop allocated) and the incremental rate under threshold.
const allocation = {
  steps, method: 'v8 new_space space_used_size over warmed windows of N and 2N steps after a forced GC; per-step rate (min bytes_2N - min bytes_N - empty increment)/N over 3 GC-free repeats per size (verdict), whole-window bound min_k (bytes_k - empty_k)/k reported; gc PerformanceObserver events attributed by time',
  bytesPerStepUpperBound: measuredResult.bytesPerStepUpperBound,
  bytesPerStepIncremental: measuredResult.bytesPerStepIncremental, fixedWindowBytes: measuredResult.fixedWindowBytes,
  gcEventsInWindows: measuredResult.gcEvents,
  windowBytes: measuredResult.windowBytes, emptyLoopWindowBytes: emptyResult.windowBytes,
  thresholdBytesPerStep: BYTES_PER_STEP_THRESHOLD,
  warmupWindows: warmup.warmupWindows, reachedSteadyState: warmup.steady,
  zeroAllocation: warmup.steady && measuredResult.gcEvents === 0 && measuredResult.bytesPerStepIncremental <= BYTES_PER_STEP_THRESHOLD,
  controls: {
    emptyLoopGcEvents: emptyResult.gcEvents,
    allocatingLoop: { gcEvents: allocatingResult.gcEvents, detected: allocatingResult.gcEvents > 0 },
  },
  heapTotalBytesAfter: v8.getHeapStatistics().total_heap_size,
};

// ---- compute duration ----------------------------------------------------
const metrics = new physics.StepMetrics();
function timedSteps(n) {
  for (let i = 0; i < n; i++) {
    fake.mono += stepMs;
    if (i % 40 === 0) stick(0.62);
    const t0 = performance.now();
    session.pump();
    metrics.computeUs.record((performance.now() - t0) * 1000);
  }
}
timedSteps(Math.min(steps, 100_000)); metrics.reset(); // warm the timed loop
const timedStart = performance.now(); timedSteps(steps); const timedMs = performance.now() - timedStart;
const plainStart = performance.now(); runSteps(steps); const plainMs = performance.now() - plainStart;
const timerOverheadUs = Math.max(0, (timedMs - plainMs) * 1000 / steps);
const compute = { unit: 'us', ...physics.summarize(metrics.computeUs), timerOverheadPerStepUs: timerOverheadUs,
  untimedMeanUs: plainMs * 1000 / steps, note: 'per pump with one integration; distribution includes performance.now overhead' };

// ---- real-time pacing ------------------------------------------------------
const realClock = { monotonicMs: () => performance.now(), wallMs: () => performance.timeOrigin + performance.now() };
const live = createSession('interactive', realClock);
live.stick(0);
const realtime = await new Promise(resolve => {
  const runMetrics = new physics.StepMetrics(), header = protocol.newHeaderSnapshotV2(), state = protocol.newFlightStateV2();
  const endAt = performance.now() + realtimeSeconds * 1000;
  let scheduledAt = performance.now(), lastTick = 0;
  const wake = () => {
    const now = performance.now();
    live.stick(0);
    const t0 = performance.now();
    const delay = live.session.pump();
    const computeUs = (performance.now() - t0) * 1000;
    live.reader.latest(state);
    const tick = protocol.tickToNumber(state.tickId);
    live.reader.readHeader(header);
    runMetrics.recordWakeup(computeUs, Math.max(0, now - scheduledAt), tick - lastTick, 0, now);
    lastTick = tick;
    if (now >= endAt || delay < 0) {
      resolve({ durationS: realtimeSeconds, targetHz: hz, executedHz: runMetrics.executedHz, executedSteps: runMetrics.executedSteps,
        droppedSteps: header.droppedSteps, overruns: header.overruns,
        wakeupLatenessMs: physics.summarize(runMetrics.latenessMs), wakeupComputeUs: physics.summarize(runMetrics.computeUs),
        note: 'setTimeout-driven wakeups in Node; browser Worker timer behavior differs and is not measured here' });
      return;
    }
    scheduledAt = now + delay;
    setTimeout(wake, delay);
  };
  setTimeout(wake, 0);
});
observer.disconnect();

const cpus = os.cpus();
const report = {
  schemaVersion: 1, benchmark: 'physics-session-v2', generatedAt: new Date().toISOString(),
  environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    cpuModel: cpus[0]?.model ?? 'unknown', cpuCount: cpus.length, flags: FLAGS,
    commit: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })() },
  configuration: { hz, backend: 'demo', clockMode: 'interactive', steps, warmup: 'each window runs twice; the second run is measured' },
  allocation, compute, realtime,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`physics bench: zeroAllocation=${allocation.zeroAllocation} (${allocation.bytesPerStepIncremental.toFixed(5)} B/step incremental, fixed ${allocation.fixedWindowBytes} B/window, whole-window <= ${allocation.bytesPerStepUpperBound.toFixed(5)}, ${allocation.gcEventsInWindows} GC; ` +
  `controls: allocating detected=${allocation.controls.allocatingLoop.detected}); ` +
  `compute p50/p99/max=${compute.p50.toFixed(2)}/${compute.p99.toFixed(2)}/${compute.max.toFixed(2)} us; ` +
  `realtime ${realtime.executedHz.toFixed(1)} Hz, lateness p99=${realtime.wakeupLatenessMs.p99.toFixed(2)} ms; report ${out}`);
