// Builds only from pinned, verified local checkouts. Never downloads or weakens TLS.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = JSON.parse(readFileSync(join(root, "native/jsbsim/source.lock.json"), "utf8"));
const toolchain = JSON.parse(readFileSync(join(root, "native/jsbsim/toolchain.lock.json"), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function verifyCheckout(directory, commit) {
    const actual = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
    }).trim();
    if (actual !== commit)
        throw new Error("Pinned source/toolchain commit mismatch");
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: directory, encoding: "utf8" }).trim();
    if (dirty)
        throw new Error("Pinned checkout has modified tracked files");
}
export function prerequisites() {
    const sourceDir = process.env.JSBSIM_SOURCE_DIR ?? "/workspace/.cache/mirage-jsbsim", emsdk = process.env.MIRAGE_EMSDK_DIR ?? "/workspace/.cache/mirage-emsdk";
    verifyCheckout(sourceDir, source.commit);
    verifyCheckout(emsdk, toolchain.commit);
    if (sha(readFileSync(join(sourceDir, "COPYING"))) !== source.licenseSha256 ||
        sha(readFileSync(join(emsdk, "emsdk_manifest.json"))) !==
            toolchain.sdkManifestSha256)
        throw new Error("Source/toolchain file checksum mismatch");
    return { sourceDir, emsdk };
}
export function patchedJsbsimSource(sourceDir, enabled = false, contact = false) {
    if (!enabled)
        return { directory: sourceDir, patchSha256: null };
    verifyCheckout(sourceDir, source.commit);
    const patch = join(root, "native/jsbsim/patches/reuse-history-and-property-paths.patch"), patchSha256 = sha(readFileSync(patch));
    const contactPatch = join(root, "native/jsbsim/patches/contact-impulse.patch");
    const contactSha256 = contact ? sha(readFileSync(contactPatch)) : null;
    const directory = join(join(root, ".cache"), `mirage-jsbsim-patched-${source.commit.slice(0, 12)}-${patchSha256.slice(0, 12)}${contactSha256 ? "-" + contactSha256.slice(0, 12) : ""}`);
    mkdirSync(directory, { recursive: true });
    const stampPath = join(directory, ".mirage-patched-source.json");
    if (existsSync(stampPath)) {
        const stamp = JSON.parse(readFileSync(stampPath));
        if (stamp.commit === source.commit && stamp.patch === patchSha256 && stamp.contact === contactSha256 &&
            stamp.files.every(f => existsSync(join(directory, f.path)) && sha(readFileSync(join(directory, f.path))) === f.sha256))
            return { directory, patchSha256, contactSha256 };
    }
    const archive = execFileSync("git", ["archive", "HEAD"], {
        cwd: sourceDir,
        maxBuffer: 128 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
    execFileSync("git", ["apply", "--check", patch], { cwd: directory });
    execFileSync("git", ["apply", patch], { cwd: directory });
    if (contact) {
        execFileSync("git", ["apply", "--check", contactPatch], { cwd: directory });
        execFileSync("git", ["apply", contactPatch], { cwd: directory });
    }
    const paths = execFileSync("git", ["ls-files"], { cwd: sourceDir, encoding: "utf8" }).trim().split("\n");
    writeFileSync(stampPath, JSON.stringify({ commit: source.commit, patch: patchSha256, contact: contactSha256, files: paths.map(path => ({ path, sha256: sha(readFileSync(join(directory, path))) })) }));
    return { directory, patchSha256, contactSha256 };
}
export function build() {
    const { sourceDir, emsdk } = prerequisites(), emcc = join(emsdk, "upstream/emscripten/emcc.py"), emcmake = join(emsdk, "upstream/emscripten/emcmake.py");
    if (!existsSync(emcc))
        throw new Error(`BLOCKED_EXTERNAL: Emscripten ${toolchain.version} is not installed; allow ${toolchain.requiredDownloadHost}, install the pinned SDK and rerun. No artifact was generated.`);
    // Invoke Python entry points directly: Windows batch wrappers require a shell.
    const python = process.env.MIRAGE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    // Upstream embeds __DATE__/__TIME__; pin them to the source commit timestamp.
    const sourceDateEpoch = execFileSync("git", ["show", "-s", "--format=%ct", source.commit], { cwd: sourceDir, encoding: "utf8" }).trim();
    if (!/^\d+$/.test(sourceDateEpoch))
        throw new Error("Invalid source timestamp");
    const env = { ...process.env, EM_CONFIG: join(emsdk, ".emscripten"), SOURCE_DATE_EPOCH: sourceDateEpoch };
    const version = execFileSync(python, [emcc, "--version"], { encoding: "utf8", env });
    if (/emcc .*? (\d+\.\d+\.\d+)\b/.exec(version)?.[1] !== toolchain.version)
        throw new Error("Emscripten version mismatch");
    const out = resolve(process.env.MIRAGE_JSBSIM_OUT ?? join(root, "packages/wasm-jsbsim/dist"));
    const prepared = patchedJsbsimSource(sourceDir, process.argv.includes("--patched") || process.argv.includes("--contact"), process.argv.includes("--contact"));
    const buildDir = join(out, prepared.patchSha256 ? "build-patched" : "build");
    mkdirSync(out, { recursive: true });
    const cmake = process.env.MIRAGE_CMAKE ?? "cmake";
    execFileSync(python, [
        emcmake,
        cmake,
        "-S",
        join(root, "native/jsbsim"),
        "-B",
        buildDir,
        `-DJSBSIM_SOURCE_DIR=${prepared.directory}`,
        `-DMIRAGE_SOURCE_DATE_EPOCH=${sourceDateEpoch}`,
        `-DMIRAGE_CONTACT_IMPULSE=${prepared.contactSha256 ? "ON" : "OFF"}`,
        "-DCMAKE_BUILD_TYPE=Release",
    ], { stdio: "inherit", env });
    execFileSync(cmake, ["--build", buildDir, "--target", "mirage_jsbsim", "--parallel", "2"], { stdio: "inherit", env });
    const files = ["mirage_jsbsim.js", "mirage_jsbsim.wasm"].map((file) => {
        const bytes = readFileSync(join(buildDir, file));
        return {
            file: `${prepared.patchSha256 ? "build-patched" : "build"}/${file}`,
            bytes: bytes.length,
            sha256: sha(bytes),
        };
    });
    writeFileSync(join(out, "manifest.json"), JSON.stringify({
        schemaVersion: 1,
        abiVersion: 1,
        sourceCommit: source.commit,
        enginePatchSha256: prepared.patchSha256,
        contactPatchSha256: prepared.contactSha256 ?? null,
        exceptionMode: prepared.contactSha256 ? "wasm" : "javascript",
        toolchainCommit: toolchain.commit,
        toolchainVersion: toolchain.version,
        compilerVersion: version.trim(),
        sourceDateEpoch,
        buildInputs: ["native/jsbsim/CMakeLists.txt", "native/jsbsim/bridge.cpp", "scripts/build-jsbsim.mjs", "native/jsbsim/allocation_probe.cpp"].map((file) => ({ file, sha256: sha(readFileSync(join(root, file))) })),
        sourceLicense: source.license,
        modelDataIncluded: false,
        artifacts: files,
    }, null, 2) + "\n");
}
if (process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        build();
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
