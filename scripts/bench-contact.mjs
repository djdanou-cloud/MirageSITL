// Node allocation evidence for the real pinned Rapier adapter, including repeated impacts.
// JavaScript evidence alone cannot certify Rapier's internal Rust/WASM allocator.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PerformanceObserver, performance } from "node:perf_hooks";
import v8 from "node:v8";
if (!globalThis.gc) {
  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--max-semi-space-size=64",
      "--single-threaded",
      "--experimental-transform-types",
      fileURLToPath(import.meta.url),
    ],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}
const { GroundContact } = await import(
  "../packages/physics/src/ground-contact.ts"
);
const { newBodyTruth } = await import("../packages/wasm-bet/src/backend.ts");
const truth = newBodyTruth(),
  wrench = new Float64Array(6),
  impulse = {
    pointBody: new Float64Array(3),
    impulseNed: new Float64Array(3),
    dt: 0,
  };
truth.positionNedM[2] = -1;
const contact = await GroundContact.create(truth, 1, 0.1, 0.3, 0.7),
  events = [];
const observer = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) events.push(e.startTime);
});
observer.observe({ entryTypes: ["gc"] });
let tick = 0,
  impacts = 0,
  wasTouching = false;
const sink = { value: null };
function run(n) {
  for (let i = 0; i < n; i++) {
    wrench[2] = tick % 800 < 100 ? -19.6133 : 0;
    tick++;
    if (!contact.stepInto(wrench, 1 / 400, truth))
      throw new Error("Invalid contact step");
    contact.impulseInto(impulse);
    const touching =
      truth.positionNedM[2] > -0.15 && impulse.impulseNed[2] < -0.001;
    if (touching && !wasTouching) impacts++;
    wasTouching = touching;
  }
}
function control(n) {
  for (let i = 0; i < n; i++) sink.value = { i };
}
function young() {
  return v8.getHeapSpaceStatistics().find((s) => s.space_name === "new_space")
    .space_used_size;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
async function measure(fn, n) {
  globalThis.gc();
  await settle();
  const start = performance.now(),
    before = young();
  fn(n);
  const bytes = young() - before,
    end = performance.now();
  await settle();
  return {
    steps: n,
    bytes,
    gcEvents: events.filter((t) => t >= start && t <= end).length,
  };
}
try {
  const warmupSteps = 1000000;
  run(warmupSteps);
  const samples = [];
  for (let i = 0; i < 3; i++) samples.push(await measure(run, 1000000));
  const positiveControl = await measure(control, 1000000);
  const jsAllocationPassed = samples.every(
    (s) => s.gcEvents === 0 && s.bytes / s.steps < 0.01,
  );
  const adapterSha256 = createHash("sha256")
    .update(
      readFileSync(
        new URL("../packages/physics/src/ground-contact.ts", import.meta.url),
      ),
    )
    .digest("hex");
  const report = {
    schemaVersion: 1,
    engine: "rapier",
    version: "0.21.0",
    adapterSha256,
    hz: 400,
    warmupSteps,
    samples,
    positiveControl,
    impacts,
    jsAllocationPassed,
    nativeAllocatorStatus: "not-instrumented",
    highRateCertified: contact.highRateCertified,
  };
  mkdirSync("test-results/bench", { recursive: true });
  writeFileSync(
    "test-results/bench/contact.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (
    !jsAllocationPassed ||
    impacts < 100 ||
    !(positiveControl.gcEvents > 0 || positiveControl.bytes > 1000000)
  )
    process.exitCode = 1;
} finally {
  contact.dispose();
  observer.disconnect();
}
