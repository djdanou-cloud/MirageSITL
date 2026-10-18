// Real JS adapter + WASM allocation/GC evidence under a passive six-DOF
// support constraint. No second pose/time integrator; no aircraft calibration.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PerformanceObserver, performance } from "node:perf_hooks";
import v8 from "node:v8";
import { loadBackendModule } from "./check-jsbsim-backend.mjs";
if (!globalThis.gc) {
    const r = spawnSync(process.execPath, ["--expose-gc", "--single-threaded", "--max-semi-space-size=64", "--experimental-transform-types", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(r.status ?? 1);
}
const { JsbsimBackend } = await import("../packages/wasm-jsbsim/src/backend.ts");
const { newBodyTruth } = await import("../packages/wasm-bet/src/backend.ts");
const { module, manifest } = await loadBackendModule();
const hz = Number(process.argv[2] ?? 400);
if (![400, 800, 1200].includes(hz))
    throw Error("Invalid rate");
const backend = new JsbsimBackend(module, "/models", "c172x", 1 / hz), controls = new Float64Array(4), mass = new Float64Array(10);
const out = { ...newBodyTruth(), specificForceBodyMps2: new Float64Array(3), timeS: 0, altitudeAslM: 0 };
const initial = new Float64Array(13);
initial[2] = 10000;
if (!backend.initializeState(initial))
    throw Error("Support fixture setup failed");
const impulse = { integrationOwner: "jsbsim", dt: 1 / hz, impulseNed: new Float64Array(3), momentBodyNms: new Float64Array(3) };
let tick = 0;
function run(n) {
    for (let i = 0; i < n; i++) {
        controls[1] = ((tick++ % 800) < 400 ? .01 : -.01);
        if (!backend.stepInto(controls, out) || !backend.massPropertiesInto(mass))
            throw Error("JSBSim support step failed");
        for (let j = 0; j < 3; j++) {
            impulse.impulseNed[j] = -mass[0] * out.velocityNedMps[j];
            impulse.momentBodyNms[j] = -(mass[1 + 3 * j] * out.angularVelocityBodyRadS[0] + mass[2 + 3 * j] * out.angularVelocityBodyRadS[1] + mass[3 + 3 * j] * out.angularVelocityBodyRadS[2]);
        }
        if (!backend.applyContactImpulseInto(impulse, out))
            throw Error("Support impulse failed");
    }
}
const events = [], observer = new PerformanceObserver(list => { for (const e of list.getEntries())
    events.push(e.startTime); });
observer.observe({ entryTypes: ["gc"] });
const settle = () => new Promise(r => setTimeout(r, 30));
const young = () => v8.getHeapSpaceStatistics().find(x => x.space_name === "new_space").space_used_size;
async function measure(fn, n) { globalThis.gc(); await settle(); const before = young(), start = performance.now(); fn(n); const end = performance.now(), bytes = young() - before; await settle(); return { steps: n, bytes, gcEvents: events.filter(t => t >= start && t <= end).length }; }
const sink = { value: null };
function control(n) { for (let i = 0; i < n; i++)
    sink.value = { i }; }
try {
    run(400);
    if (!backend.armHighRate())
        throw Error("Allocator arming failed");
    const warmupSteps = 4000000;
    run(warmupSteps);
    await measure(run, 100000);
    const samples = [];
    for (let i = 0; i < 3; i++)
        samples.push(await measure(run, 1000000));
    const positiveControl = await measure(control, 1000000);
    const controlDetected = positiveControl.gcEvents > 0 || positiveControl.bytes > 1000000;
    const passed = samples.every(x => x.gcEvents === 0 && x.bytes / x.steps < .01) && controlDetected && backend.allocationCalls === 0 && backend.allocationBytes === 0;
    const sha = p => createHash("sha256").update(readFileSync(p)).digest("hex");
    const report = { schemaVersion: 1, hz, passed, warmupSteps, samples, positiveControl, controlDetected, allocationCalls: backend.allocationCalls, allocationBytes: backend.allocationBytes, manifest, adapterSha256: sha("packages/wasm-jsbsim/src/backend.ts"), scriptSha256: sha("scripts/bench-jsbsim.mjs"), scope: "Passive six-DOF support impulse removes velocity without integrating pose/time; synthetic allocation stress, no measured fidelity or real-time hardware claim" };
    mkdirSync("test-results/bench", { recursive: true });
    writeFileSync(`test-results/bench/jsbsim-${hz}.json`, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ hz, passed, samples, positiveControl, calls: backend.allocationCalls, bytes: backend.allocationBytes }));
    if (!passed)
        process.exitCode = 1;
}
finally {
    backend.dispose();
    observer.disconnect();
}
