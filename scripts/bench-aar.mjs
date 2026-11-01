// Actual producer graph allocation probe. Recorder/IndexedDB I/O is outside physics.
// `node scripts/bench-aar.mjs HZ` probes the TASK-076 record; `node scripts/bench-aar.mjs HZ v2` probes the
// TASK-162 producer in its worst case: every physics signal at the physics rate, 16 motors and an IMU frame
// every tick (16 rows per tick), with the queue drained in the same step so no row is dropped.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import v8 from "node:v8";
import { PerformanceObserver } from "node:perf_hooks";
if (!globalThis.gc) {
  const child = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--max-semi-space-size=64",
      "--single-threaded",
      "--experimental-transform-types",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  process.exit(child.status ?? 1);
}
const { AarRecord } = await import("../packages/aar/src/record.ts");
const { createRecordingQueue, RecordingHandoff } = await import(
  "../packages/aar/src/handoff.ts"
);
const { newFlightStateV2, newSensorFrameV2, newActuatorFrameV2 } = await import(
  "../packages/protocol/src/index.ts"
);
const hz = Number(process.argv[2] ?? 400);
if (![400, 800, 1200].includes(hz)) throw new Error("Invalid Hz");
const v2 = process.argv[3] === "v2";
if (process.argv[3] !== undefined && !v2) throw new Error("The second argument is v2 or nothing");
const recorderV2 = await import("../packages/aar/src/recorder-v2.ts");
const { planRates } = await import("../packages/aar/src/signal-catalog.ts");
const record = new AarRecord(),
  state = newFlightStateV2(),
  pilot = new Float64Array([0.1, 0.2, 0.3, 0.4]),
  sensor = newSensorFrameV2(),
  actuator = newActuatorFrameV2();
state.epoch = sensor.epoch = actuator.epoch = 1;
sensor.kind = 1;
sensor.valueCount = 6;
actuator.actuatorCount = 4;
const queue = new RecordingHandoff(createRecordingQueue()),
  out = new Int32Array(128);
let errors = 0;
const v2Plan = planRates({ commonHz: 2000 }, { physicsHz: hz, telemetryHz: 10 });
const v2Queue = recorderV2.createRecordingQueueV2();
const v2Producer = new recorderV2.RecordingProducerV2(v2Queue, recorderV2.producerPlan(v2Plan));
const v2Reader = new recorderV2.RecordingQueueReaderV2(v2Queue);
const v2Slot = new Int32Array(recorderV2.SLOT_BYTES / 4);
const power = { motorCount: 16, motors: new Float64Array(80).fill(0.5), motorWarning: new Uint32Array(16), motorLimited: new Uint32Array(16),
  battery: new Float64Array([0.9, 22.2, 31.5, 699.3, 4.1, 5.0]), batteryMasks: new Uint32Array(2) };
actuator.actuatorCount = v2 ? 16 : 4;
const v2Sample = { state, pilot, actuator, sensor, power };
let v2Rows = 0;
function stepV2() {
  state.tickId.lo = (state.tickId.lo + 1) >>> 0;
  state.simTimeS = state.tickId.lo / hz;
  // Every recorded field carries a fractional value, as in flight, so a boxed double would show as allocation.
  const a = Math.sin(state.simTimeS), c = Math.cos(state.simTimeS);
  state.northM = a; state.vnMps = c; state.qw = c; state.qx = a; state.pRadS = a; state.anMps2 = c;
  state.specificForceZBodyMps2 = -9.80665 + a; state.trueAirspeedMps = c; state.groundClearanceM = 1 + a;
  pilot[3] = 0.5 + 0.1 * a;
  actuator.normalizedActuators[0] = c; actuator.normalizedActuators[15] = a;
  sensor.tickId.lo = state.tickId.lo;
  sensor.values[0] = a;
  power.motors[0] = 9000 + a; power.motors[79] = c; power.battery[1] = 22.2 + a;
  v2Producer.record(v2Sample);
  while (v2Reader.pop(v2Slot) > 0) v2Rows++;
}
function stepV1() {
  state.tickId.lo = (state.tickId.lo + 1) >>> 0;
  state.simTimeS = state.tickId.lo / hz;
  state.northM = Math.sin(state.simTimeS);
  sensor.values[0] = state.northM;
  actuator.normalizedActuators[0] = Math.cos(state.simTimeS);
  if (
    !record.encode(state, pilot, sensor, actuator, 0, 0, false) ||
    !queue.push(record.words) ||
    !queue.pop(out)
  )
    errors++;
}
const step = v2 ? stepV2 : stepV1;
const events = [];
const observer = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) events.push(e.startTime);
});
observer.observe({ entryTypes: ["gc"] });
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));
for (let i = 0; i < 4e6; i++) step();
const windows = [];
for (const n of [1e6, 2e6, 1e6, 2e6, 1e6, 2e6]) {
  globalThis.gc();
  await flush();

  const before = v8.getHeapStatistics().used_heap_size,
    start = performance.now();
  for (let i = 0; i < n; i++) step();
  const end = performance.now(),
    elapsedMs = end - start,
    after = v8.getHeapStatistics().used_heap_size;
  await flush();
  await flush();
  windows.push({
    steps: n,
    heapDelta: after - before,
    gcEvents: events.filter((t) => t >= start && t <= end).length,
    elapsedMs,
  });
}
globalThis.gc();
await flush();

const controlStart = performance.now();
let control = [];
for (let i = 0; i < 1e6; i++) {
  control.push({ value: i });
  if (control.length === 4096) control = [];
}
await flush();
await flush();
const controlGc = events.filter((t) => t >= controlStart).length;
const small = windows.filter((w) => w.steps === 1e6),
  large = windows.filter((w) => w.steps === 2e6);
const mean = (a) => a.reduce((sum, x) => sum + x.heapDelta, 0) / a.length;
const incrementalBytesPerStep = Math.max(0, (mean(large) - mean(small)) / 1e6);
const paths = [
  ...(v2 ? ["packages/aar/src/recorder-v2.ts", "packages/aar/src/format-v2.ts", "packages/aar/src/signal-catalog.ts"] : [
  "packages/aar/src/record.ts",
  "packages/aar/src/format.ts",
  "packages/aar/src/handoff.ts"]),
  "packages/protocol/src/state-v2.ts",
  "packages/protocol/src/sensor-frame.ts",
  "packages/protocol/src/actuator-frame.ts",
  "scripts/bench-aar.mjs",
];
const sourceHashes = Object.fromEntries(
  paths.map((p) => [
    p,
    createHash("sha256").update(readFileSync(p)).digest("hex"),
  ]),
);
const v2Lost = v2Reader.lost;
const totalSteps = 4e6 + windows.reduce((sum, w) => sum + w.steps, 0);
const passed =
  errors === 0 &&
  (!v2 || (v2Lost === 0 && v2Rows === totalSteps * 16)) &&
  windows.every((w) => w.gcEvents === 0) &&
  incrementalBytesPerStep <= 0.001 &&
  controlGc > 0;
const report = {
  schemaVersion: 1,
  hz,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  warmupSteps: 4e6,
  windows,
  incrementalBytesPerStep,
  errors,
  ...(v2 ? { producer: "TASK-162 RecordingProducerV2", rowsPerStep: 16, rows: v2Rows, lost: v2Lost } : {}),
  controlGc,
  sourceHashes,
  passed,
  limits:
    "Node synchronous producer graph only; allocation slope includes profiler/heap query overhead. No browser timing or full production Worker wiring claim.",
};
mkdirSync("test-results/bench", { recursive: true });
writeFileSync(
  `test-results/bench/aar-${v2 ? "v2-" : ""}${hz}.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
observer.disconnect();
process.exitCode = passed ? 0 : 1;
