// Numerical comparison of the same frozen f64 source on native and WASM.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
execFileSync(process.execPath, ["scripts/build-contact.mjs", "--native"], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "inherit" });
const executable = ".cache/task-029/binding/target/release/contact-probe" + (process.platform === "win32" ? ".exe" : "");
const native = JSON.parse(execFileSync(executable, [], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
const bytes = readFileSync("packages/physics/dist/contact/contact.wasm");
const module = await WebAssembly.compile(bytes);
const results = [];
// Predeclared cross-target budget: 0.1 m, 0.5 degrees; quaternion sign invariant.
for (const c of native.cases) {
    const instance = await WebAssembly.instantiate(module, {}), x = instance.exports;
    const heap = new Float64Array(x.memory.buffer), cp = x.contact_config_ptr() / 8, ip = x.contact_input_ptr() / 8, op = x.contact_output_ptr() / 8;
    heap.set(c.config, cp);
    if (x.contact_initialize() !== 0)
        throw Error("Contact init failed");
    heap[ip + 14] = 1 / c.hz;
    let positionErrorM = 0, angleErrorRad = 0;
    for (let i = 0; i < 2 * c.hz; i++) {
        heap[ip + 2] = i % (2 * c.hz) < c.hz / 4 ? -(c.config[2] + .2 * c.wheels) * 19.6133 : 0;
        if (x.contact_step() !== 0)
            throw Error("WASM contact failed");
        if (i + 1 === c.hz || i + 1 === 2 * c.hz) {
            const ref = c.samples[(i + 1) / c.hz - 1];
            positionErrorM = Math.max(positionErrorM, Math.hypot(heap[op] - ref[0], heap[op + 1] - ref[1], heap[op + 2] - ref[2]));
            let dot = 0;
            for (let j = 0; j < 4; j++)
                dot += heap[op + 6 + j] * ref[6 + j];
            angleErrorRad = Math.max(angleErrorRad, 2 * Math.acos(Math.min(1, Math.abs(dot))));
        }
    }
    const passed = positionErrorM <= .1 && angleErrorRad <= Math.PI / 360 && c.allocationCalls === 0 && c.allocationBytes === 0 && x.contact_allocation_calls() === 0 && x.contact_allocation_bytes() === 0;
    results.push({ hz: c.hz, wheels: c.wheels, nativeSteps: c.steps, positionErrorM, angleErrorRad, allocationCalls: c.allocationCalls, allocationBytes: c.allocationBytes, passed });
    x.contact_dispose();
}
const report = { schemaVersion: 1, wasmSha256: createHash("sha256").update(bytes).digest("hex"), manifest: JSON.parse(readFileSync("packages/physics/dist/contact/manifest.json", "utf8")), cases: results, passed: results.every(x => x.passed), scope: "Synthetic numerical and allocation verification; NASA measured fidelity deferred by user." };
mkdirSync("test-results/validation", { recursive: true });
writeFileSync("test-results/validation/task-029-binding.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(results));
if (!report.passed)
    process.exitCode = 1;
