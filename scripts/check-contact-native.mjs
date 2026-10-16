// Reproducible f64 Rapier allocator diagnostic, without the profiler feature.
// This diagnoses native core allocations; it does not certify a WASM artifact.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCheckout } from "./build-jsbsim.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  sha = (b) => createHash("sha256").update(b).digest("hex");
try {
  const pin = JSON.parse(
      readFileSync(join(root, "native/rapier/source.lock.json")),
    ),
    source =
      process.env.MIRAGE_RAPIER_SOURCE ?? "/workspace/.cache/mirage-rapier",
    build = resolve(
      process.env.MIRAGE_RAPIER_PROBE_BUILD ??
        "/workspace/.cache/mirage-contact-native-probe",
    );
  verifyCheckout(source, pin.commit);
  if (sha(readFileSync(join(source, "LICENSE"))) !== pin.licenseSha256)
    throw new Error("Rapier source license mismatch");
  let buildSource = source;
  const patchFile = join(
    root,
    "native/rapier/patches/reuse-step-buffers.patch",
  );
  const patchSha256 = process.argv.includes("--patched")
    ? sha(readFileSync(patchFile))
    : null;
  if (patchSha256) {
    buildSource = join(
      "/workspace/.cache",
      `mirage-rapier-patched-${pin.commit.slice(0, 12)}-${patchSha256.slice(0, 12)}`,
    );
    mkdirSync(buildSource, { recursive: true });
    const archive = execFileSync("git", ["archive", "HEAD"], {
      cwd: source,
      maxBuffer: 128 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", buildSource], { input: archive });
    execFileSync("git", ["apply", "--check", patchFile], { cwd: buildSource });
    execFileSync("git", ["apply", patchFile], { cwd: buildSource });
  }
  mkdirSync(join(build, "src"), { recursive: true });
  copyFileSync(
    join(root, "native/rapier/allocation_probe.rs"),
    join(build, "src/main.rs"),
  );
  copyFileSync(
    join(root, "native/rapier/Cargo.lock"),
    join(build, "Cargo.lock"),
  );
  writeFileSync(
    join(build, "Cargo.toml"),
    `[package]\nname="mirage-contact-probe"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nrapier3d-f64={path=${JSON.stringify(join(buildSource, "crates/rapier3d-f64"))},default-features=false,features=["dim3","f64","std","enhanced-determinism"]}\n`,
  );
  execFileSync(
    "cargo",
    [
      "build",
      "--manifest-path",
      join(build, "Cargo.toml"),
      "--locked",
      "--release",
    ],
    { stdio: "inherit" },
  );
  const execution = spawnSync(
    join(build, "target/release/mirage-contact-probe"),
    [],
    { encoding: "utf8" },
  );
  if (execution.error) throw execution.error;
  if (execution.status !== 0 && execution.status !== 2)
    throw new Error(execution.stderr || "Native contact probe failed");
  const value = JSON.parse(execution.stdout);
  if (
    value.steps !== 1000000 ||
    !Number.isFinite(value.finalDownM) ||
    !Number.isSafeInteger(value.allocationCalls) ||
    value.allocationCalls < 0 ||
    !Number.isSafeInteger(value.allocationBytes) ||
    value.allocationBytes < 0
  )
    throw new Error("Invalid native contact allocation evidence");
  const report = {
    ...value,
    sourceCommit: pin.commit,
    patchSha256,
    features: pin.features,
    profiler: false,
    probeSha256: sha(
      readFileSync(join(root, "native/rapier/allocation_probe.rs")),
    ),
    dependencyLockSha256: sha(
      readFileSync(join(root, "native/rapier/Cargo.lock")),
    ),
    status:
      value.allocationCalls === 0 && value.allocationBytes === 0
        ? "pass"
        : "failed",
    wasmParityStatus: "unverified",
  };
  mkdirSync(join(root, "test-results/bench"), { recursive: true });
  writeFileSync(
    join(
      root,
      `test-results/bench/contact-native${patchSha256 ? "-patched" : ""}.json`,
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  process.exitCode = report.status === "pass" ? 0 : 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
