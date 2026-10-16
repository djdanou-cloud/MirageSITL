// Ideal sensor/noise/scheduler/latency allocation probe. Node/V8 evidence, not browser timing evidence.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { PerformanceObserver, performance } from "node:perf_hooks";
import v8 from "node:v8";
import { fileURLToPath } from "node:url";
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
const { IdealSensors } = await import("../packages/sensors/src/ideal.ts");
const { SensorNoise } = await import("../packages/sensors/src/noise.ts");
const { SensorScheduler } = await import(
  "../packages/sensors/src/scheduler.ts"
);
const { LatencyQueue } = await import("../packages/sensors/src/latency.ts");
const { newBodyTruth, BetRigidBodyBackend } = await import(
  "../packages/wasm-bet/src/backend.ts"
);
const { newSensorFrameV2 } = await import("../packages/protocol/src/index.ts");
const ideal = new IdealSensors([0.2, 0, 0.4]),
  noise = new SensorNoise(123, 7, 200, 0.01, 20),
  scheduler = new SensorScheduler(400, 200),
  latency = new LatencyQueue(512);
const truth = {
  ...newBodyTruth(),
  epoch: 1,
  tickId: { lo: 0, hi: 0 },
  sampleTimeUs: { lo: 0, hi: 0 },
  windNedMps: new Float64Array(3),
};
const frame = newSensorFrameV2(),
  out = new Float64Array(2),
  events = [],
  sink = { value: null };
let tick = 0;
const noiseOutput = new Float64Array(1),
  noiseInput = new Float64Array(1);
const observer = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) events.push(e.startTime);
});
observer.observe({ entryTypes: ["gc"] });
function young() {
  return v8.getHeapSpaceStatistics().find((s) => s.space_name === "new_space")
    .space_used_size;
}
const component = process.argv[2] ?? "all";
if (!["all", "ideal", "noise", "metadata", "body"].includes(component))
  throw new Error("Unknown allocation probe component");
let bodyBackend = null;
const wrench = new Float64Array([0, 0, -9.80665, 0, 0, 0]);
if (component === "body") {
  const build = spawnSync(process.execPath, ["scripts/build-wasm.mjs"], {
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const { instance } = await WebAssembly.instantiate(
    readFileSync("packages/wasm-bet/dist/mirage_bet.scalar.wasm"),
    {},
  );
  bodyBackend = new BetRigidBodyBackend(
    instance,
    1,
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
  );
}
function run(n) {
  for (let i = 0; i < n; i++) {
    if (bodyBackend && !bodyBackend.stepInto(wrench, 1 / 400, truth))
      throw new Error("Invalid body step");
    if (component === "noise") {
      noise.sampleInto(noiseInput, out);
      continue;
    }
    if (component === "ideal") {
      ideal.sampleInto(1, truth, frame);
      ideal.sampleInto(3, truth, frame);
      ideal.sampleInto(4, truth, frame);
      ideal.sampleInto(5, truth, frame);
      continue;
    }
    if (component === "metadata") {
      tick++;
      const now = tick * 2500;
      truth.sampleTimeUs.lo = now >>> 0;
      frame.sampleTimeUs.lo = truth.sampleTimeUs.lo;
      continue;
    }
    tick++;
    const now = tick * 2500;
    truth.tickId.lo = tick >>> 0;
    truth.sampleTimeUs.lo = now >>> 0;
    truth.sampleTimeUs.hi = Math.floor(now / 4294967296) >>> 0;
    if (scheduler.advance()) {
      if (!ideal.sampleInto(1, truth, frame))
        throw new Error("Invalid sensor frame");
      noise.sampleInto(frame.values, noiseOutput);
      latency.push(now, 5000, noiseOutput[0]);
    }
    latency.pollInto(now, out);
  }
}
function control(n) {
  for (let i = 0; i < n; i++) sink.value = { i };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
async function window(body, n) {
  body(n);
  globalThis.gc();
  await settle();
  const start = performance.now(),
    before = young();
  body(n);
  const bytes = young() - before,
    end = performance.now();
  await settle();
  return {
    steps: n,
    bytes,
    gcEvents: events.filter((time) => time >= start && time <= end).length,
  };
}
// Cross 32-bit timestamp rollover and finish V8 representation transitions before measurement.
const warmupSteps = 4000000;
run(warmupSteps);
const samples = [];
for (let i = 0; i < 3; i++) {
  samples.push(await window(run, 1000000), await window(run, 2000000));
}
const positiveControl = await window(control, 2000000);
const short = Math.min(
  ...samples.filter((s) => s.steps === 1000000).map((s) => s.bytes),
);
const long = Math.min(
  ...samples.filter((s) => s.steps === 2000000).map((s) => s.bytes),
);
const bytesPerStep = Math.max(0, long - short) / 1000000;
const zeroAllocation =
  samples.every((s) => s.gcEvents === 0) && bytesPerStep < 0.01;
const controlDetected =
  positiveControl.gcEvents > 0 || positiveControl.bytes > 1000000;
const report = {
  warmupSteps,
  component,
  seed: 123,
  hz: 400,
  method:
    "warmed V8 new-space N/2N windows, GC observation, positive allocating control",
  samples,
  positiveControl,
  bytesPerStep,
  zeroAllocation,
  controlDetected,
  lastDelayedSample: Array.from(out),
  dropped: latency.dropped,
};
mkdirSync("test-results/bench", { recursive: true });
writeFileSync(
  `test-results/bench/sensors-${component}.json`,
  JSON.stringify(report, null, 2) + "\n",
);
observer.disconnect();
console.log(JSON.stringify(report));
if (!zeroAllocation || !controlDetected) process.exitCode = 1;
