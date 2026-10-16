// Builds only from pinned, verified local checkouts. Never downloads or weakens TLS.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = JSON.parse(
  readFileSync(join(root, "native/jsbsim/source.lock.json"), "utf8"),
);
const toolchain = JSON.parse(
  readFileSync(join(root, "native/jsbsim/toolchain.lock.json"), "utf8"),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function verifyCheckout(directory, commit) {
  const actual = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
  if (actual !== commit)
    throw new Error("Pinned source/toolchain commit mismatch");
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: directory, encoding: "utf8" },
  ).trim();
  if (dirty) throw new Error("Pinned checkout has modified tracked files");
}
export function prerequisites() {
  const sourceDir =
      process.env.JSBSIM_SOURCE_DIR ?? "/workspace/.cache/mirage-jsbsim",
    emsdk = process.env.MIRAGE_EMSDK_DIR ?? "/workspace/.cache/mirage-emsdk";
  verifyCheckout(sourceDir, source.commit);
  verifyCheckout(emsdk, toolchain.commit);
  if (
    sha(readFileSync(join(sourceDir, "COPYING"))) !== source.licenseSha256 ||
    sha(readFileSync(join(emsdk, "emsdk_manifest.json"))) !==
      toolchain.sdkManifestSha256
  )
    throw new Error("Source/toolchain file checksum mismatch");
  return { sourceDir, emsdk };
}
export function patchedJsbsimSource(sourceDir, enabled = false) {
  if (!enabled) return { directory: sourceDir, patchSha256: null };
  verifyCheckout(sourceDir, source.commit);
  const patch = join(
      root,
      "native/jsbsim/patches/reuse-history-and-property-paths.patch",
    ),
    patchSha256 = sha(readFileSync(patch));
  const directory = join(
    "/workspace/.cache",
    `mirage-jsbsim-patched-${source.commit.slice(0, 12)}-${patchSha256.slice(0, 12)}`,
  );
  mkdirSync(directory, { recursive: true });
  const archive = execFileSync("git", ["archive", "HEAD"], {
    cwd: sourceDir,
    maxBuffer: 128 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive });
  execFileSync("git", ["apply", "--check", patch], { cwd: directory });
  execFileSync("git", ["apply", patch], { cwd: directory });
  return { directory, patchSha256 };
}
export function build() {
  const { sourceDir, emsdk } = prerequisites(),
    emcc = join(emsdk, "upstream/emscripten/emcc"),
    emcmake = join(emsdk, "upstream/emscripten/emcmake");
  if (!existsSync(emcc))
    throw new Error(
      `BLOCKED_EXTERNAL: Emscripten ${toolchain.version} is not installed; allow ${toolchain.requiredDownloadHost}, install the pinned SDK and rerun. No artifact was generated.`,
    );
  const version = execFileSync(emcc, ["--version"], { encoding: "utf8" });
  if (!version.includes(toolchain.version))
    throw new Error("Emscripten version mismatch");
  const out = resolve(
    process.env.MIRAGE_JSBSIM_OUT ?? join(root, "packages/wasm-jsbsim/dist"),
  );
  const prepared = patchedJsbsimSource(
    sourceDir,
    process.argv.includes("--patched"),
  );
  const buildDir = join(out, prepared.patchSha256 ? "build-patched" : "build");
  mkdirSync(out, { recursive: true });
  const cmake = process.env.MIRAGE_CMAKE ?? "cmake";
  execFileSync(
    emcmake,
    [
      cmake,
      "-S",
      join(root, "native/jsbsim"),
      "-B",
      buildDir,
      `-DJSBSIM_SOURCE_DIR=${prepared.directory}`,
      "-DCMAKE_BUILD_TYPE=Release",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    cmake,
    ["--build", buildDir, "--target", "mirage_jsbsim", "--parallel", "2"],
    { stdio: "inherit" },
  );
  const files = ["mirage_jsbsim.js", "mirage_jsbsim.wasm"].map((file) => {
    const bytes = readFileSync(join(buildDir, file));
    return {
      file: `${prepared.patchSha256 ? "build-patched" : "build"}/${file}`,
      bytes: bytes.length,
      sha256: sha(bytes),
    };
  });
  writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        abiVersion: 1,
        sourceCommit: source.commit,
        enginePatchSha256: prepared.patchSha256,
        toolchainVersion: toolchain.version,
        sourceLicense: source.license,
        modelDataIncluded: false,
        artifacts: files,
      },
      null,
      2,
    ) + "\n",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    build();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
