// TASK-150 G1: real pack/encode/parser/decode, warmed N/2N windows and allocating control.
// node scripts/check-mavlink-allocation.mjs --out /path/report.json
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import v8 from "node:v8";
import { cpus, release } from "node:os";
if (!globalThis.gc) {
  const result = spawnSync(process.execPath, ["--expose-gc", "--single-threaded",
    "--max-semi-space-size=64", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const { MessagePayload } = await import("../packages/mavlink/src/messages.ts");
const { MavParser, encodeInto } = await import("../packages/mavlink/src/codec.ts");
const golden = JSON.parse(readFileSync(new URL("../tests/fixtures/mavlink/golden.json", import.meta.url), "utf8"));
// Telemetry used for Phase 1 state, power, command outcomes and guidance response.
const ids = [0, 1, 24, 27, 30, 32, 33, 36, 74, 77, 83, 85, 87, 105, 147, 193];
const cases = ids.map((id) => {
  const input = new MessagePayload(id);
  const output = new MessagePayload(id);
  const fixture = golden.frames.find((frame) => frame.id === id && frame.variant === "distinct");
  for (const field of input.definition.fields) input.field(field.name).set(fixture.values[field.name]);
  const float = input.definition.fields.find((field) => field.type === "float");
  const changing = float ? input.field(float.name) : input.field(input.definition.fields[0].name);
  return { id, input, output, observed: output.field(float ? float.name : input.definition.fields[0].name), changing, floating: Boolean(float) };
});
const byId = new Map(cases.map((entry) => [entry.id, entry]));
const checksum = new Float64Array(1);
let received = 0;
const parser = new MavParser((frame) => {
  const entry = byId.get(frame.id);
  if (!entry.output.decode(frame)) throw new Error("Decode failed");
  received++;
});
const wire = new Uint8Array(280);
let tick = 0;
function run(steps) {
  for (let i = 0; i < steps; i++) {
    const entry = cases[tick % cases.length];
    entry.changing[0] = entry.floating ? (tick % 10000) * 0.0013 : tick % 100;
    if (!entry.input.pack()) throw new Error("Pack failed");
    const size = encodeInto(entry.id, entry.input.payload, tick & 255, 42, 7, wire);
    if (!size) throw new Error("Encode failed");
    for (let j = 0; j < size; j++) parser.pushByte(wire[j]);
    checksum[0] += entry.observed[0];
    tick++;
  }
}
const events = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) events.push(entry.startTime);
});
observer.observe({ entryTypes: ["gc"] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const young = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === "new_space").space_used_size;
async function measure(body, steps) {
  globalThis.gc();
  await settle();
  const before = young();
  const start = performance.now();
  body(steps);
  const end = performance.now();
  const bytes = young() - before;
  await settle();
  return { steps, bytes, durationMs: end - start, gcEvents: events.filter((time) => time >= start && time <= end).length };
}
run(4000000);
const samples = [];
for (let i = 0; i < 3; i++) {
  samples.push(await measure(run, 1000000), await measure(run, 2000000));
}
const sink = { value: null };
const control = await measure((n) => { for (let i = 0; i < n; i++) sink.value = { i }; }, 2000000);
const short = Math.min(...samples.filter((s) => s.steps === 1000000).map((s) => s.bytes));
const long = Math.min(...samples.filter((s) => s.steps === 2000000).map((s) => s.bytes));
const bytesPerStep = Math.max(0, long - short) / 1000000;
const files = ["packages/mavlink/src/codec.ts", "packages/mavlink/src/messages.ts", "packages/mavlink/dialect.lock.json", "scripts/check-mavlink-allocation.mjs"];
const report = { schemaVersion: 1, node: process.version, platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model,
  ids, warmupSteps: 4000000, samples, bytesPerStep, received, checksum: checksum[0],
  method: "Warmed real pack/encode/parser/decode; N/2N new-space slope and GC observation; I/O excluded",
  zeroAllocation: samples.every((sample) => sample.gcEvents === 0) && bytesPerStep < 0.01,
  controlDetected: control.gcEvents > 0 || control.bytes > 1000000, positiveControl: control,
  sourceSha256: Object.fromEntries(files.map((path) => [path, createHash("sha256").update(readFileSync(new URL(`../${path}`, import.meta.url))).digest("hex")])) };
const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1) writeFileSync(process.argv[outIndex + 1], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
observer.disconnect();
if (!report.zeroAllocation || !report.controlDetected || parser.badCrc || received !== tick) process.exitCode = 1;
