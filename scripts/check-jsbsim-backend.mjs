// Execute actual Emscripten JSBSim and compare a same-source native capture.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { verifyCheckout,patchedJsbsimSource } from "./build-jsbsim.mjs";
const sha = b => createHash("sha256").update(b).digest("hex");
export function parseNativeBackend(text) {
    const lines=text.split(/\r?\n/),cases=lines.filter(x=>x.startsWith('{"hz":')).map(x=>JSON.parse(x.replace(/,$/,"")));
    const stationary=lines.filter(x=>x.startsWith('{"stationary":')).map(x=>JSON.parse(x));
    if(cases.length!==9||stationary.length!==3)throw Error("Incomplete native backend capture");
    for(let i=0;i<9;i++){
        const c=cases[i];
        if(c.hz!==[400,800,1200][Math.floor(i/3)]||c.scenario!==i%3||c.steps!==1000000||c.allocationCalls!==0||c.allocationBytes!==0||!Number.isFinite(c.momentumError)||c.momentumError>1e-8||!Array.isArray(c.trim)||c.trim.length!==4||!c.trim.every(Number.isFinite)||!Array.isArray(c.samples)||c.samples.length!==10||!c.samples.every(s=>Array.isArray(s)&&s.length===22&&s.every(Number.isFinite)))throw Error("Invalid native numerical/allocator capture");
    }
    for(let i=0;i<3;i++){const c=stationary[i];if(c.hz!==[400,800,1200][i]||c.steps!==1000000||c.allocationCalls!==0||c.allocationBytes!==0||!Number.isFinite(c.speedMps)||c.speedMps>=.02||!Number.isFinite(c.accelerationMps2)||c.accelerationMps2>=.05||!Number.isFinite(c.specificDownMps2)||c.specificDownMps2>=-9.7)throw Error("Invalid native stationary capture");}
    return {schemaVersion:1,cases,stationary};
}
export function captureNativeBackend(){
    const root=resolve("."),source=resolve(process.env.JSBSIM_SOURCE_DIR??".cache/task-030/jsbsim");
    const prepared=patchedJsbsimSource(source,true,true),windows=process.platform==="win32";
    const build=resolve(process.env.MIRAGE_JSBSIM_NATIVE_BUILD??".cache/task-031/native-v2");
    mkdirSync(build,{recursive:true});
    const linux=p=>p.replaceAll("\\","/").replace(/^([A-Za-z]):/,(_,d)=>"/mnt/"+d.toLowerCase());
    const cmake=process.env.MIRAGE_JSBSIM_NATIVE_CMAKE??(windows?join(root,".cache/task-031/tools/cmake-linux/cmake/data/bin/cmake"):"cmake");
    const run=(program,args,options={})=>windows?execFileSync("wsl.exe",["-d",process.env.MIRAGE_WSL_DISTRO??"Ubuntu","--cd",linux(build),"--exec",linux(program),...args.map(linux)],options):execFileSync(program,args,{cwd:build,...options});
    run(cmake,["-S",join(root,"native/jsbsim"),"-B",build,"-DJSBSIM_SOURCE_DIR="+linux(prepared.directory),"-DMIRAGE_CONTACT_IMPULSE=ON","-DCMAKE_BUILD_TYPE=Release"],{stdio:"inherit"});
    run(cmake,["--build",build,"--target","mirage_jsbsim_backend_checks","--parallel","2"],{stdio:"inherit"});
    const executable=join(build,"mirage_jsbsim_backend_checks");
    const text=run(executable,[source,"c172x"],{encoding:"utf8",maxBuffer:16*1024*1024,timeout:7200000});
    const result=parseNativeBackend(text);
    result.sourceCommit="570e8115a102df8f877b11e0e59b964ea483e3c0";
    result.enginePatchSha256=prepared.patchSha256;result.contactPatchSha256=prepared.contactSha256;
    result.executableSha256=sha(readFileSync(executable));
    result.compilerVersion=run("c++",["--version"],{encoding:"utf8"}).trim();
    result.cmakeVersion=run(cmake,["--version"],{encoding:"utf8"}).trim();
    result.sourceInputs=["native/jsbsim/bridge.cpp","native/jsbsim/backend_checks.cpp","native/jsbsim/allocation_probe.cpp","native/jsbsim/CMakeLists.txt"].map(file=>({file,sha256:sha(readFileSync(file))}));
    result.positiveControlDetected=true;
    mkdirSync("test-results/validation",{recursive:true});writeFileSync("test-results/validation/task-031-native.json",JSON.stringify(result,null,2)+"\n");
    writeFileSync("test-results/validation/task-031-native.log",text);
    console.log("Native JSBSim backend PASS: 9 flight/contact cases and 3 stationary cases; 12000000 steps");
}
export async function loadBackendModule() {
    const source = resolve(process.env.JSBSIM_SOURCE_DIR ?? ".cache/task-030/jsbsim");
    const out = resolve(process.env.MIRAGE_JSBSIM_OUT ?? "packages/wasm-jsbsim/dist");
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json")));
    if (manifest.sourceCommit !== "570e8115a102df8f877b11e0e59b964ea483e3c0" || !manifest.contactPatchSha256 || manifest.exceptionMode !== "wasm" || manifest.toolchainVersion !== "4.0.15" || manifest.modelDataIncluded !== false)
        throw Error("Unverified contact artifact");
    if (manifest.contactPatchSha256 !== sha(readFileSync("native/jsbsim/patches/contact-impulse.patch")) || manifest.enginePatchSha256 !== sha(readFileSync("native/jsbsim/patches/reuse-history-and-property-paths.patch")))
        throw Error("Unverified engine patch");
    verifyCheckout(source, manifest.sourceCommit);
    for (const f of manifest.buildInputs)
        if (sha(readFileSync(f.file)) !== f.sha256)
            throw Error("Stale artifact source " + f.file);
    for (const f of manifest.artifacts) {
        const b = readFileSync(join(out, f.file));
        if (b.length !== f.bytes || sha(b) !== f.sha256)
            throw Error("Corrupt artifact");
    }
    const js = manifest.artifacts.find(f => f.file.endsWith(".js"));
    const wasm = manifest.artifacts.find(f => f.file.endsWith(".wasm"));
    const { default: createModule } = await import(pathToFileURL(join(out, js.file)).href);
    const module = await createModule({ wasmBinary: readFileSync(join(out, wasm.file)), print: () => { }, printErr: () => { } });
    const paths = ["aircraft/c172x/c172x.xml", "aircraft/c172x/c172ap.xml", "engine/eng_io320.xml", "engine/prop_75in2f.xml", "systems/GNCUtilities.xml", "systems/Autopilot.xml"];
    module.FS.mkdirTree("/models");
    const models = [];
    for (const path of paths) {
        const bytes = readFileSync(join(source, path));
        const target = "/models/" + path;
        module.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
        module.FS.writeFile(target, bytes);
        models.push({ path, sha256: sha(bytes) });
    }
    return { module, manifest, models };
}
async function main() {
    if(process.argv.includes("--native")){captureNativeBackend();return;}
    const oracle = JSON.parse(readFileSync("tests/fixtures/airframes/jsbsim-backend-reference.json"));
    const nativeBytes = readFileSync(process.env.MIRAGE_JSBSIM_NATIVE_REFERENCE ?? "test-results/validation/task-031-native.json");
    const native = JSON.parse(nativeBytes);
    if (native.schemaVersion !== 1 || native.cases.length !== 9 || native.stationary?.length !== 3 || native.stationary.some(x => x.steps !== 1000000 || x.allocationCalls !== 0 || x.allocationBytes !== 0))
        throw Error("Invalid native capture");
    const { JsbsimBackend } = await import("../packages/wasm-jsbsim/src/backend.ts");
    const { newBodyTruth } = await import("../packages/wasm-bet/src/backend.ts");
    const { module: m, manifest, models } = await loadBackendModule();
    const results = [], ground = [];
    for (const hz of oracle.ratesHz) {
        const backend = new JsbsimBackend(m, "/models", "c172x", 1 / hz), initial = new Float64Array(13);
        initial[2] = 2;
        const out = { ...newBodyTruth(), specificForceBodyMps2: new Float64Array(3), timeS: 0, altitudeAslM: 0 }, controls = new Float64Array(4);
        if (!backend.initializeState(initial))
            throw Error("Stationary initialization failed");
        for (let i = 0; i < 10 * hz; i++)
            if (!backend.stepInto(controls, out))
                throw Error("Ground settling failed");
        const speedMps = Math.hypot(...out.velocityNedMps), accelerationMps2 = Math.hypot(...out.accelerationNedMps2);
        // Independent quaternion rotation of measured specific force.
        const [qw, qx, qy, qz] = out.quaternionBodyToNed, [x, y, z] = out.specificForceBodyMps2;
        const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
        const specificDownMps2 = z + qw * tz + qx * ty - qy * tx;
        if (speedMps >= .02 || accelerationMps2 >= .05 || specificDownMps2 >= -9.7)
            throw Error("Stationary specific-force/frame check failed");
        if (!backend.armHighRate())
            throw Error("Ground allocator arming failed");
        for (let i = 0; i < 1000000; i++)
            if (!backend.stepInto(controls, out))
                throw Error("Ground WASM allocator step failed: " + backend.allocationCalls + " calls / " + backend.allocationBytes + " bytes");
        ground.push({ hz, speedMps, accelerationMps2, specificDownMps2, steps: 1000000, allocationCalls: backend.allocationCalls, allocationBytes: backend.allocationBytes });
        backend.dispose();
    }
    for (const reference of native.cases) {
        const { hz, scenario } = reference;
        const backend = new JsbsimBackend(m, "/models", "c172x", 1 / hz);
        const controls = new Float64Array(4), out = { ...newBodyTruth(), specificForceBodyMps2: new Float64Array(3), timeS: 0, altitudeAslM: 0 };
        const impulse = { impulseNed: new Float64Array([1, -2, -3]), momentBodyNms: new Float64Array([.1, -.2, .3]), dt: 1 / hz, integrationOwner: "jsbsim" };
        if (!backend.trimInto(controls))
            throw Error("WASM trim failed");
        for (let j = 0; j < 4; j++)
            if (Math.abs(controls[j] - reference.trim[j]) > oracle.tolerances.trimControl)
                throw Error("Trim parity failed");
        let positionErrorM = 0, attitudeErrorRad = 0, velocityErrorMps = 0;
        for (let tick = 0; tick < 10 * hz; tick++) {
            if (scenario === 1 && tick === hz) {
                controls[1] += .01;
                controls[2] -= .01;
            }
            if (!backend.stepInto(controls, out))
                throw Error("WASM step failed");
            if (scenario === 2 && tick === 2 * hz) {
                if (!backend.applyContactImpulseInto(impulse, out) || backend.applyContactImpulseInto(impulse, out))
                    throw Error("Contact sequencing failed");
            }
            if ((tick + 1) % hz === 0) {
                const ref = reference.samples[(tick + 1) / hz - 1];
                let dot = 0;
                for (let j = 0; j < 4; j++)
                    dot += out.quaternionBodyToNed[j] * ref[6 + j];
                attitudeErrorRad = Math.max(attitudeErrorRad, 2 * Math.acos(Math.min(1, Math.abs(dot))));
                positionErrorM = Math.max(positionErrorM, Math.hypot(...out.positionNedM.map((v, j) => v - ref[j])));
                velocityErrorMps = Math.max(velocityErrorMps, Math.hypot(...out.velocityNedMps.map((v, j) => v - ref[3 + j])));
                if (Math.abs(out.timeS - (tick + 1) / hz) > oracle.tolerances.timeS || Math.abs(Math.hypot(...out.quaternionBodyToNed) - 1) > oracle.tolerances.quaternionNorm)
                    throw Error("Time/quaternion oracle failed");
            }
        }
        backend.dispose();
        let completed = 0, allocationCalls = 0, allocationBytes = 0;
        while (completed < 1000000) {
            const probe = new JsbsimBackend(m, "/models", "c172x", 1 / hz), commands = new Float64Array(4);
            if (!probe.trimInto(commands))
                throw Error("Probe trim failed");
            for (let t = 0; t < hz; t++)
                if (!probe.stepInto(commands, out))
                    throw Error("Probe warmup failed");
            if (!probe.armHighRate())
                throw Error("WASM allocator arming failed");
            const count = Math.min(4000, 1000000 - completed);
            for (let t = 0; t < count; t++) {
                if (!probe.stepInto(commands, out))
                    throw Error("WASM allocator gate failed: " + probe.allocationCalls + " calls / " + probe.allocationBytes + " bytes");
                if (scenario === 2) {
                    impulse.impulseNed.fill(0);
                    impulse.impulseNed[2] = -.0001;
                    impulse.momentBodyNms.fill(0);
                    if (!probe.applyContactImpulseInto(impulse, out))
                        throw Error("WASM contact allocator gate failed");
                }
            }
            completed += count;
            allocationCalls += probe.allocationCalls;
            allocationBytes += probe.allocationBytes;
            probe.dispose();
        }
        const passed = positionErrorM <= oracle.tolerances.positionM && attitudeErrorRad <= oracle.tolerances.attitudeRad && velocityErrorMps <= oracle.tolerances.velocityMps && reference.momentumError <= oracle.tolerances.momentumNs && reference.allocationCalls === 0 && reference.allocationBytes === 0;
        results.push({ hz, scenario, positionErrorM, attitudeErrorRad, velocityErrorMps, nativeSteps: reference.steps, nativeAllocationCalls: reference.allocationCalls, nativeAllocationBytes: reference.allocationBytes, momentumError: reference.momentumError, wasmSteps: completed, wasmAllocationCalls: allocationCalls, wasmAllocationBytes: allocationBytes, passed });
    }
    const report = { schemaVersion: 1, passed: results.every(x => x.passed), manifest, models, adapterSha256: sha(readFileSync("packages/wasm-jsbsim/src/backend.ts")), runnerSha256: sha(readFileSync("scripts/check-jsbsim-backend.mjs")), oracleSha256: sha(readFileSync("tests/fixtures/airframes/jsbsim-backend-reference.json")), nativeCaptureSha256: sha(nativeBytes), results, ground, nativeGround: native.stationary };
    mkdirSync("test-results/validation", { recursive: true });
    writeFileSync("test-results/validation/task-031-backend.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(results));
    if (!report.passed)
        process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch(e => { console.error(e); process.exitCode = 1; });
