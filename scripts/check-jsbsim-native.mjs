// Builds the actual pinned native bridge; native evidence cannot establish WASM parity.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCheckout, patchedJsbsimSource } from "./build-jsbsim.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
export function parseNativeReport(stdout) {
  const lines = stdout.trim().split("\n"),
    line = lines.findLast((x) => x.startsWith("{"));
  if (!line) throw new Error("Native check did not produce a report");
  const value = JSON.parse(line);
  if (
    value.schemaVersion !== 1 ||
    value.nativeTrimPassed !== true ||
    value.numericalPassed !== true ||
    value.steps !== 1000000 ||
    value.finite !== true ||
    value.allocatorInstrumented !== true ||
    ![
      value.maxVelocityErrorMps,
      value.maxAccelerationErrorMps2,
      value.maxSpecificForceErrorMps2,
      value.allocationCalls,
      value.allocationBytes,
    ].every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0) ||
    !Number.isSafeInteger(value.allocationCalls) ||
    !Number.isSafeInteger(value.allocationBytes) ||
    value.maxVelocityErrorMps >= 0.1 ||
    value.maxAccelerationErrorMps2 >= 0.1 ||
    value.maxSpecificForceErrorMps2 >= 0.05
  )
    throw new Error(
      "Native check failed its numerical/allocator evidence contract",
    );
  return value;
}
export function runNative() {
  const lock = JSON.parse(
      readFileSync(join(root, "native/jsbsim/source.lock.json")),
    ),
    source = process.env.JSBSIM_SOURCE_DIR ?? "/workspace/.cache/mirage-jsbsim";
  verifyCheckout(source, lock.commit);
  if (sha(readFileSync(join(source, "COPYING"))) !== lock.licenseSha256)
    throw new Error("JSBSim license checksum mismatch");
  const prepared = patchedJsbsimSource(
    source,
    process.argv.includes("--patched"),
  );
  const cmake =
      process.env.MIRAGE_CMAKE ??
      "/workspace/.cache/mirage-build-tools/cmake/data/bin/cmake",
    build =
      process.env.MIRAGE_JSBSIM_NATIVE_BUILD ??
      (prepared.patchSha256
        ? "/workspace/.cache/mirage-jsbsim-bridge-patched"
        : "/workspace/.cache/mirage-jsbsim-bridge");
  execFileSync(
    cmake,
    [
      "-S",
      join(root, "native/jsbsim"),
      "-B",
      build,
      `-DJSBSIM_SOURCE_DIR=${prepared.directory}`,
      "-DCMAKE_BUILD_TYPE=Release",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    cmake,
    ["--build", build, "--target", "mirage_jsbsim_checks", "--parallel", "2"],
    { stdio: "inherit" },
  );
  const result = spawnSync(
    join(build, "mirage_jsbsim_checks"),
    [source, "c172x"],
    { cwd: build, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 2)
    throw new Error(result.stderr || "Native execution failed");
  const native = parseNativeReport(result.stdout),
    status =
      native.allocationCalls === 0 && native.allocationBytes === 0
        ? "pass"
        : "blocked";
  if ((result.status === 0) !== (status === "pass"))
    throw new Error("Native process/report exit status mismatch");
  const report = {
    ...native,
    status,
    nativeAllocationStatus: status === "pass" ? "pass" : "failed",
    sourceCommit: lock.commit,
    enginePatchSha256: prepared.patchSha256,
    aircraftXmlSha256: sha(
      readFileSync(join(source, "aircraft/c172x/c172x.xml")),
    ),
    bridgeSha256: sha(readFileSync(join(root, "native/jsbsim/bridge.cpp"))),
    checksSha256: sha(
      readFileSync(join(root, "native/jsbsim/native_checks.cpp")),
    ),
    windowSteps: 4000,
    windows: 250,
    warmupStepsPerWindow: 400,
    modelDataRedistributed: false,
    wasmParityStatus: "unverified",
  };
  const output = join(
    root,
    `test-results/validation/jsbsim-native${prepared.patchSha256 ? "-patched" : ""}.json`,
  );
  mkdirSync(join(root, "test-results/validation"), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  return report;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = runNative();
    process.exitCode = report.status === "pass" ? 0 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
