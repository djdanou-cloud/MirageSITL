// Node allocation evidence for the real pinned Rapier adapter, including repeated impacts.
// JavaScript evidence alone cannot certify Rapier's internal Rust/WASM allocator.
import { spawnSync, execFileSync } from "node:child_process";
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
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}
const { GroundContact } = await import(
  "../packages/physics/src/ground-contact.ts"
);
const { newBodyTruth } = await import("../packages/wasm-bet/src/backend.ts");
const wheelCount=Number(process.argv[2]??0),hz=Number(process.argv[3]??400);
if(![0,3,8].includes(wheelCount)||![400,800,1200].includes(hz))throw Error("Expected wheel count 0/3/8 and rate 400/800/1200");
const mass=wheelCount?10:1;
const wheels=Array.from({length:wheelCount},(_,i)=>({
  anchorBodyM:[.4*Math.cos(2*Math.PI*i/wheelCount),.4*Math.sin(2*Math.PI*i/wheelCount),.4],
  unsprungMassKg:.2,tireRadiusM:.1,rimRadiusM:.05,strutTravelM:.15,
  suspension:{kind:"linear",stiffnessNpm:1000,preloadN:0,compressionDamping:30,reboundDamping:50,dampingLaw:"linear"},
  tireLoadCurve:[[0,0],[.05,1000]],tireDampingNsPm:10,rollingCoefficient:.02,lateralCoefficient:.5,brakingCoefficient:.7
}));
execFileSync(process.execPath,["scripts/build-contact.mjs"],{stdio:"inherit"});
await GroundContact.initialize(new Uint8Array(readFileSync("packages/physics/dist/contact/contact.wasm")), JSON.parse(readFileSync("packages/physics/dist/contact/manifest.json","utf8")));
const truth = newBodyTruth(),
  wrench = new Float64Array(6),
  impulse = {
    pointBody: new Float64Array(3),
    impulseNed: new Float64Array(3),
    dt: 0,
  };
truth.positionNedM[2] = -1;
const contact = await GroundContact.create(truth, mass, 0.1, 0.3, 0.7,wheelCount?{inertiaDiagonalKgM2:[1,1,1],wheels}:{}),
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
    wrench[2] = tick % (2*hz) < hz/4 ? -(mass+.2*wheelCount)*19.6133 : 0;
    tick++;
    if (!contact.stepInto(wrench, 1 / hz, truth))
      throw new Error("Invalid contact step");
    contact.impulseInto(impulse);
    const touching =
      truth.positionNedM[2] > (wheelCount?-0.5:-0.15) && impulse.impulseNed[2] < -0.001;
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
  const warmupSteps = 4000000;
  run(warmupSteps);
  // Exercise the measurement wrapper itself before the measured windows.
  // Otherwise its first optimized invocation is mixed into the hot-loop sample.
  await measure(run, 100000);
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
    version: "0.36.0",
    adapterSha256,
    hz,wheelCount,
    warmupSteps,
    samples,
    positiveControl,
    impacts,
    jsAllocationPassed,
    nativeAllocatorStatus: contact.allocationCalls===0 && contact.allocationBytes===0 ? "PASS":"FAIL",
    allocationCalls:contact.allocationCalls,allocationBytes:contact.allocationBytes,
    highRateCertified: contact.highRateCertified,
  };
  mkdirSync("test-results/bench", { recursive: true });
  writeFileSync(
    wheelCount||hz!==400?`test-results/bench/contact-${wheelCount}-${hz}.json`:"test-results/bench/contact.json",
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
