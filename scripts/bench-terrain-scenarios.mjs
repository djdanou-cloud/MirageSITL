// Terrain queries and scenario polling allocation probe; triangulation/staging are cold.
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
const { CollisionChunks } = await import("../packages/terrain/src/collision-chunks.ts");
const { TerrainContactCoupler } = await import("../packages/physics/src/terrain-contact.ts");
const { parseScenario } = await import("../packages/scenarios/src/schema.ts");
const { ScenarioRunner } = await import("../packages/scenarios/src/runner.ts");
const hz = Number(process.argv[2] ?? 400);
if (![400, 800, 1200].includes(hz)) throw new Error("Invalid Hz");
const fixture = JSON.parse(readFileSync("tests/fixtures/scenarios/pilot-basics.json"));
const scenario = parseScenario({ ...fixture, hz });
const runner = new ScenarioRunner(scenario, scenario.modelSha256, scenario.firmwareSha256, scenario.seed, hz);
const chunks = new CollisionChunks(1, 3, 1, 4);
for (let n = 0; n < 2; n++) for (let e = 0; e < 2; e++) chunks.stage({ version: 1, epoch: 1, revision: 0, northIndex: n, eastIndex: e, resolution: 3, spacingM: 1, downM: new Float64Array(9) });
chunks.publishAtTick(1, 0);
const query = new Float64Array([1, 1, .1]), out = new Float64Array(1), plane = new Float64Array(4);
// TASK-065 coupler JS path; a stub stands in for the WASM contact step, whose
// allocations the contact ABI gate counts separately.
const stubContact = { wheelCount: 3, stepInto: () => true };
const coupler = new TerrainContactCoupler(stubContact, chunks, [[0.4, 0, 0.4], [-0.2, 0.3, 0.4], [-0.2, -0.3, 0.4]], 0.6);
const truth = { positionNedM: new Float64Array([1, 1, -1]), quaternionBodyToNed: new Float64Array([1, 0, 0, 0]) }, wrench = new Float64Array(6);
let errors = 0, tick = 0;
function step() {
  query[0] = 1 + Math.sin(tick / hz) * .2;
  query[1] = 1 + Math.cos(tick / hz) * .2;
  chunks.sampleInto(query, out);
  chunks.planeInto(query, plane);
  truth.positionNedM[0] = query[0]; truth.positionNedM[1] = query[1];
  if (!chunks.readyFrom(query) || out[0] !== 0 || plane[2] !== -1 || plane[3] !== 0 ||
    coupler.stepInto(truth, wrench, 1 / hz) !== 0 || runner.nextEventIndex(tick, false) === -2) errors++;
  tick++;
  if (tick > 12000) { tick = 0; runner.reset(); }
}
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
const paths = ["packages/terrain/src/collision-chunks.ts", "packages/terrain/src/collision-build.ts", "packages/scenarios/src/runner.ts", "packages/scenarios/src/schema.ts", "scripts/bench-terrain-scenarios.mjs"];
const sourceHashes = Object.fromEntries(
  paths.map((p) => [
    p,
    createHash("sha256").update(readFileSync(p)).digest("hex"),
  ]),
);
const passed =
  errors === 0 &&
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
  controlGc,
  sourceHashes,
  passed,
  limits:
    "Node terrain-query/scenario graph only; allocation slope includes profiler/heap query overhead. No browser timing or full production Worker wiring claim.",
};
mkdirSync("test-results/bench", { recursive: true });
writeFileSync(
  `test-results/bench/terrain-scenarios-${hz}.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
observer.disconnect();
process.exitCode = passed ? 0 : 1;
