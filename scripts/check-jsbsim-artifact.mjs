// Real Chromium Worker smoke. Aircraft data is read locally, never packaged.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { prerequisites } from "./build-jsbsim.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Runs in a module Worker with the actual Emscripten module and linear memory.
async function workerSmoke() {
  try {
    const { default: createModule } = await import("/engine.js");
    const module = await createModule({ locateFile: () => "/engine.wasm" });
    if (module._jsb_abi_version() !== 1) throw new Error("ABI version mismatch");
    const files = await (await fetch("/models.json")).json();
    module.FS.mkdirTree("/models");
    for (const file of files) {
      const target = `/models/${file.path}`;
      module.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
      module.FS.writeFile(target, new Uint8Array(file.bytes));
    }
    const text = (value) => {
      const bytes = new TextEncoder().encode(value + "\0");
      const pointer = module._malloc(bytes.length);
      module.HEAPU8.set(bytes, pointer);
      return pointer;
    };
    const root = text("/models"), model = text("c172x");
    const controls = module._malloc(32), output = module._malloc(176);
    const memory = module.HEAPU8.buffer;
    const heap = new Float64Array(memory);
    const results = [];
    for (const hz of [400, 800, 1200]) {
      const id = module._jsb_create(root, model, 1 / hz);
      if (!id) throw new Error(`Model initialization failed at ${hz} Hz`);
      heap.fill(0, controls / 8, controls / 8 + 4);
      if (module._jsb_step(id, controls, 3, output, 22) !== -1)
        throw new Error("Invalid control count accepted");
      heap[controls / 8] = NaN;
      if (module._jsb_step(id, controls, 4, output, 22) !== -2)
        throw new Error("Nonfinite control accepted");
      heap[controls / 8] = 0;
      for (let tick = 0; tick < hz; tick++) {
        if (module._jsb_step(id, controls, 4, output, 22) !== 0)
          throw new Error(`Step failed at ${hz} Hz, tick ${tick}`);
      }
      const state = Array.from(heap.subarray(output / 8, output / 8 + 22));
      if (!state.every(Number.isFinite)) throw new Error("Nonfinite state");
      // ABI time is an independent oracle: exactly hz fixed steps total 1 s.
      if (Math.abs(state[16] - 1) > 1e-10) throw new Error("Fixed-step time mismatch");
      if (Math.abs(Math.hypot(...state.slice(6, 10)) - 1) > 1e-10)
        throw new Error("Quaternion norm mismatch");
      if (module.HEAPU8.buffer !== memory || memory.byteLength !== 67108864)
        throw new Error("WASM memory changed");
      module._jsb_dispose(id);
      if (module._jsb_step(id, controls, 4, output, 22) !== -1)
        throw new Error("Disposed handle accepted");
      results.push({ hz, steps: hz, state });
    }
    const contactResults=[];
    if(module._jsb_contact_abi_version()===1){
      const ip=module._malloc(48),mp=module._malloc(80);
      for(const hz of [400,800,1200]){
        const id=module._jsb_create(root,model,1/hz);
        if(!id||module._jsb_trim(id,controls,4)!==0)throw Error("Worker trim failed");
        for(let i=0;i<hz;i++)if(module._jsb_step(id,controls,4,output,22)!==0)throw Error("Worker warmup failed");
        if(module._jsb_allocator_probe()!==1)throw Error("Worker allocator control failed");
        module._jsb_allocation_track(1);
        let momentumError=0;
        for(let i=0;i<10000;i++){
          if(module._jsb_step(id,controls,4,output,22)!==0)throw Error("Worker contact step failed");
          if(i===0){
            module._jsb_mass_properties(id,mp,10);
            const before=Array.from(heap.subarray(output/8,output/8+22));
            heap.set([1,-2,-3,.1,-.2,.3],ip/8);
            if(module._jsb_apply_contact(id,ip,6,output,22)!==0)throw Error("Worker impulse failed");
            for(let j=0;j<3;j++)momentumError=Math.max(momentumError,Math.abs((heap[output/8+3+j]-before[3+j])*heap[mp/8]-heap[ip/8+j]));
            if(heap[output/8+16]!==before[16]||module._jsb_apply_contact(id,ip,6,output,22)!==-1)throw Error("Worker repeated integration/contact");
          }
        }
        module._jsb_allocation_track(0);
        if(momentumError>1e-8||module._jsb_allocation_calls()!==0||module._jsb_allocation_bytes()!==0||module.HEAPU8.buffer!==memory)throw Error("Worker momentum/allocation gate failed");
        contactResults.push({hz,steps:10000,momentumError,allocationCalls:module._jsb_allocation_calls(),allocationBytes:module._jsb_allocation_bytes()});module._jsb_dispose(id);
      }
      module._free(ip);module._free(mp);
    }
    for (const pointer of [root, model, controls, output]) module._free(pointer);
    globalThis.postMessage({ status: "PASS", abiVersion: 1, memoryBytes: memory.byteLength, results,contactResults });
  } catch (error) {
    globalThis.postMessage({ status: "FAIL", reason: String(error) });
  }
}

async function main() {
  const { sourceDir } = prerequisites();
  const out = resolve(process.env.MIRAGE_JSBSIM_OUT ?? join(root, "packages/wasm-jsbsim/dist"));
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.abiVersion !== 1 ||
      manifest.sourceCommit !== "570e8115a102df8f877b11e0e59b964ea483e3c0" ||
      manifest.toolchainCommit !== "389a68bc35dcff7ebae4614e1615099dafda00d1" ||
      manifest.toolchainVersion !== "4.0.15" || manifest.modelDataIncluded !== false ||
      !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2)
    throw new Error("Artifact manifest mismatch");
  const expectedInputs = ["native/jsbsim/CMakeLists.txt", "native/jsbsim/bridge.cpp", "scripts/build-jsbsim.mjs", "native/jsbsim/allocation_probe.cpp"];
  if (!Array.isArray(manifest.buildInputs) || manifest.buildInputs.length !== expectedInputs.length)
    throw new Error("Missing build input identities");
  for (let i = 0; i < expectedInputs.length; i++) {
    const entry = manifest.buildInputs[i];
    if (entry.file !== expectedInputs[i] || sha(readFileSync(join(root, entry.file))) !== entry.sha256)
      throw new Error("Stale build input identity");
  }
  const artifacts = new Map();
  for (const entry of manifest.artifacts) {
    if (!/^build(?:-patched)?\/mirage_jsbsim\.(js|wasm)$/.test(entry.file))
      throw new Error("Unexpected artifact path");
    const bytes = readFileSync(join(out, entry.file));
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256)
      throw new Error("Artifact checksum mismatch");
    artifacts.set(entry.file.endsWith(".wasm") ? "/engine.wasm" : "/engine.js", bytes);
  }
  if (artifacts.size !== 2) throw new Error("Missing artifact");
  let independentRebuild = null;
  if (process.env.MIRAGE_JSBSIM_COMPARE) {
    const directory = resolve(process.env.MIRAGE_JSBSIM_COMPARE);
    const other = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    if (other.sourceCommit !== manifest.sourceCommit || other.toolchainCommit !== manifest.toolchainCommit ||
        other.enginePatchSha256 !== manifest.enginePatchSha256 ||
        JSON.stringify(other.buildInputs) !== JSON.stringify(manifest.buildInputs) ||
        !Array.isArray(other.artifacts) || other.artifacts.length !== 2)
      throw new Error("Independent rebuild provenance mismatch");
    for (let i = 0; i < 2; i++) {
      const a = manifest.artifacts[i], b = other.artifacts[i];
      if (b.file !== a.file || b.bytes !== a.bytes || b.sha256 !== a.sha256 ||
          sha(readFileSync(join(directory, a.file))) !== a.sha256)
        throw new Error("Independent rebuild artifact mismatch");
    }
    independentRebuild = { status: "PASS", artifacts: other.artifacts };
  }
  const modelPaths = ["aircraft/c172x/c172x.xml", "aircraft/c172x/c172ap.xml",
    "engine/eng_io320.xml", "engine/prop_75in2f.xml", "systems/GNCUtilities.xml", "systems/Autopilot.xml"];
  const models = modelPaths.map((path) => {
    const bytes = readFileSync(join(sourceDir, path));
    return { path, bytes: Array.from(bytes), sha256: sha(bytes) };
  });
  const routes = new Map([
    ["/", { type: "text/html", body: "<!doctype html><title>JSBSim artifact smoke</title>" }],
    ["/worker.js", { type: "text/javascript", body: `(${workerSmoke.toString()})();` }],
    ["/engine.js", { type: "text/javascript", body: artifacts.get("/engine.js") }],
    ["/engine.wasm", { type: "application/wasm", body: artifacts.get("/engine.wasm") }],
    ["/models.json", { type: "application/json", body: JSON.stringify(models) }],
  ]);
  const server = createServer((request, response) => {
    const route = routes.get(request.url);
    response.writeHead(route ? 200 : 404, {
      "Content-Type": route?.type ?? "text/plain",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    response.end(route?.body ?? "Not found");
  });
  let browser;
  try {
    await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    browser = await chromium.launch({ headless: true,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    const result = await page.evaluate(() => new Promise((accept, reject) => {
      const worker = new globalThis.Worker("/worker.js", { type: "module" });
      const timer = setTimeout(() => { worker.terminate(); reject(new Error("Worker timeout")); }, 30000);
      worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); accept(event.data); };
      worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
    }));
    const report = { schemaVersion: 1, status: result.status, timestamp: new Date().toISOString(),
      node: process.version, platform: process.platform, browser: browser.version(), manifest, independentRebuild,
      bridgeSha256: sha(readFileSync(join(root, "native/jsbsim/bridge.cpp"))),
      checkerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      modelFiles: models.map(({ path, sha256 }) => ({ path, sha256 })), result };
    mkdirSync(join(root, "test-results/validation"), { recursive: true });
    writeFileSync(join(root, "test-results/validation/jsbsim-artifact.json"), JSON.stringify(report, null, 2) + "\n");
    if (result.status !== "PASS") throw new Error(JSON.stringify(result));
    console.log(`JSBSim Worker PASS: 400/800/1200 Hz, Chromium ${browser.version()}`);
  } finally {
    await browser?.close();
    await new Promise((accept) => server.close(accept));
  }
}
main().catch((error) => {
  mkdirSync(join(root, "test-results/validation"), { recursive: true });
  writeFileSync(join(root, "test-results/validation/jsbsim-artifact.json"), JSON.stringify({
    schemaVersion: 1, status: "FAIL", timestamp: new Date().toISOString(), reason: String(error),
  }, null, 2) + "\n");
  console.error(error);
  process.exitCode = 1;
});
