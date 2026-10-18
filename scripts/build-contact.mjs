// Pinned direct f64 Rapier ABI; storage-reuse patch, no wasm-bindgen wrappers.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCheckout } from "./build-jsbsim.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const sha = b => createHash("sha256").update(b).digest("hex");
const pin = JSON.parse(readFileSync(join(root, "native/rapier/source.lock.json")));
const cache = join(root, ".cache/task-029");
mkdirSync(cache, { recursive: true });
const lock = join(cache, "build-lock");
let held = false;
try {
    for (let i = 0; i < 1800; i++) {
        try {
            mkdirSync(lock);
            held = true;
            break;
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
            await new Promise(r => setTimeout(r, 100));
        }
    }
    if (!held)
        throw new Error("Contact build lock timeout");
    const source = process.env.MIRAGE_RAPIER_SOURCE ?? join(cache, "rapier");
    if (!existsSync(source)) {
        execFileSync("git", ["clone", "--no-checkout", pin.repository, source], { stdio: "inherit" });
        execFileSync("git", ["checkout", "--detach", pin.commit], { cwd: source, stdio: "inherit" });
    }
    verifyCheckout(source, pin.commit);
    // Git on Windows may materialize CRLF; verify the pinned license text as LF.
    if (sha(readFileSync(join(source, "LICENSE"), "utf8").replaceAll("\r\n", "\n")) !== pin.licenseSha256)
        throw new Error("Rapier license hash mismatch");
    const patch = join(root, "native/rapier/patches/reuse-step-buffers.patch");
    const files = ["native/bet/Cargo.toml", "native/bet/src/lib.rs", "native/bet/src/frame.rs", "native/bet/src/math.rs", "native/rust-toolchain.toml", "native/contact/src/lib.rs", "native/contact/src/contact.rs", "native/contact/Cargo.lock", "native/rapier/source.lock.json", "native/rapier/patches/reuse-step-buffers.patch", "native/bet/src/landing_gear.rs", "scripts/build-contact.mjs"];
    const inputs = files.filter(f => existsSync(join(root, f))).map(file => ({ file, sha256: sha(readFileSync(join(root, file))) }));
    const out = join(root, "packages/physics/dist/contact");
    const manifestPath = join(out, "manifest.json");
    if (existsSync(manifestPath) && !process.argv.includes("--native") && !process.argv.includes("--trace")) {
        const previous = JSON.parse(readFileSync(manifestPath));
        if (previous.toolchain === "1.97.0" && JSON.stringify(previous.inputs) === JSON.stringify(inputs) && existsSync(join(out, "contact.wasm")) && sha(readFileSync(join(out, "contact.wasm"))) === previous.sha256 && existsSync(join(out,"LICENSE.rapier.txt")) && sha(readFileSync(join(out,"LICENSE.rapier.txt"))) === pin.licenseSha256) {
            console.log("Contact artifact verified and current");
            process.exitCode = 0;
        }
        else
            await build();
    }
    else
        await build();
    async function build() {
        const prepared = join(cache, "rapier-patched");
        mkdirSync(prepared, { recursive: true });
        const stampPath = join(prepared, ".mirage-source.json");
        let preparedValid = false;
        if (existsSync(stampPath)) {
            const stamp = JSON.parse(readFileSync(stampPath));
            preparedValid = stamp.commit === pin.commit && stamp.patch === sha(readFileSync(patch)) && stamp.files.every(f => existsSync(join(prepared, f.path)) && sha(readFileSync(join(prepared, f.path))) === f.sha256);
        }
        if (!preparedValid) {
            const archive = execFileSync("git", ["archive", pin.commit], { cwd: source, maxBuffer: 128 * 1024 * 1024 });
            execFileSync("tar", ["-xf", "-", "-C", prepared], { input: archive });
            execFileSync("git", ["apply", "--check", patch], { cwd: prepared });
            execFileSync("git", ["apply", patch], { cwd: prepared });
            const paths = execFileSync("git", ["ls-files"], { cwd: source, encoding: "utf8" }).trim().split("\n");
            writeFileSync(stampPath, JSON.stringify({ commit: pin.commit, patch: sha(readFileSync(patch)), files: paths.map(path => ({ path, sha256: sha(readFileSync(join(prepared, path))) })) }));
        }
        const build = join(cache, "binding");
        mkdirSync(build, { recursive: true });
        const manifest = `[package]\nname="mirage-contact"\nversion="0.1.0"\nedition="2021"\nrust-version="1.97"\n[lib]\npath=${JSON.stringify(join(root, "native/contact/src/lib.rs").replaceAll("\\", "/"))}\ncrate-type=["cdylib","rlib"]\n[dependencies]\nrapier3d-f64={path=${JSON.stringify(join(prepared, "crates/rapier3d-f64").replaceAll("\\", "/"))},default-features=false,features=["dim3","f64","std","enhanced-determinism"]}\nmirage-bet={path=${JSON.stringify(join(root, "native/bet").replaceAll("\\", "/"))}}\n[profile.release]\nlto=true\ncodegen-units=1\npanic="abort"\nstrip=true\n`;
        const extra = `\n[[bin]]\nname="contact-probe"\npath=${JSON.stringify(join(root, "native/contact/src/probe.rs").replaceAll("\\", "/"))}\n[[test]]\nname="contract"\npath=${JSON.stringify(join(root, "native/contact/tests/contact.rs").replaceAll("\\", "/"))}\n`;
        writeFileSync(join(build, "Cargo.toml"), manifest.replace("mirage-bet={path=", 'mirage-bet={features=["embedded-kernels"],path=') + extra);
        const committed = join(root, "native/contact/Cargo.lock");
        if (!existsSync(committed))
            throw new Error("Missing frozen contact dependency lockfile");
        copyFileSync(committed, join(build, "Cargo.lock"));
        const args = ["build", "--manifest-path", join(build, "Cargo.toml"), "--release"];
        if (process.argv.includes("--test-native")) {
            args[0] = "test";
            // Cargo emits both abort/unwind cdylibs for integration tests;
            // serialize their linker outputs on Windows.
            args.push("--test", "contract", "--jobs", "1");
        }
        args.push("--locked");
        if (!process.argv.includes("--native"))
            args.push("--target", "wasm32-unknown-unknown", "--lib");
        const trace = process.argv.includes("--trace");
        if (trace)
            args.push("--config", "profile.release.strip=false", "--config", "profile.release.debug=1");
        execFileSync("cargo", ["+1.97.0", ...args], { cwd: join(root, "native"), stdio: "inherit", env: { ...process.env, MIRAGE_CONTACT_TRACE: trace ? "1" : "", RUSTFLAGS: process.argv.includes("--native") ? "" : "-C link-arg=--initial-memory=16777216 -C link-arg=--max-memory=16777216" } });
        if (process.argv.includes("--native"))
            return;
        const bytes = readFileSync(join(build, "target/wasm32-unknown-unknown/release/mirage_contact.wasm"));
        if (trace) {
            writeFileSync(join(cache, "trace.wasm"), bytes);
            return;
        }
        const { instance } = await WebAssembly.instantiate(bytes, {});
        if (instance.exports.contact_abi_version() !== 1)
            throw new Error("Contact ABI mismatch");
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "contact.wasm"), bytes);
        writeFileSync(join(out,"LICENSE.rapier.txt"),readFileSync(join(source,"LICENSE"),"utf8").replaceAll("\r\n","\n"));
        const finalInputs = files.map(file => ({ file, sha256: sha(readFileSync(join(root, file))) }));
        writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, abiVersion: 1, toolchain: "1.97.0", sourceCommit: pin.commit, patchSha256: sha(readFileSync(patch)), engineVersion: pin.nativeVersion, precision: "f64", memoryBytes: 16777216, bytes: bytes.length, sha256: sha(bytes), inputs: finalInputs }, null, 2) + "\n");
    }
}
catch (error) {
    console.error(error);
    process.exitCode = 1;
}
finally {
    if (held)
        rmdirSync(lock);
}
