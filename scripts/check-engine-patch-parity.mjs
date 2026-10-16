// Exact same-toolchain native trajectory comparison; not WASM or measured fidelity.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function compareEvidence(baseline, patched) {
  if (
    !baseline ||
    !patched ||
    baseline.steps !== 1000000 ||
    patched.steps !== baseline.steps ||
    !/^[a-f0-9]{16}$/.test(baseline.trajectoryHash) ||
    !/^[a-f0-9]{16}$/.test(patched.trajectoryHash) ||
    baseline.sourceCommit !== patched.sourceCommit ||
    !/^[a-f0-9]{40}$/.test(baseline.sourceCommit) ||
    !Number.isSafeInteger(baseline.allocationCalls) ||
    !Number.isSafeInteger(baseline.allocationBytes) ||
    baseline.allocationCalls <= 0 ||
    baseline.allocationBytes <= 0 ||
    patched.allocationCalls !== 0 ||
    patched.allocationBytes !== 0
  )
    throw new Error(
      "Incomplete original/patched allocator or trajectory evidence",
    );
  if (baseline.trajectoryHash !== patched.trajectoryHash)
    throw new Error("Original/patched native trajectories differ");
  return {
    status: "pass",
    steps: patched.steps,
    trajectoryHash: patched.trajectoryHash,
  };
}
export function checkParity() {
  const cases = [];
  for (const [engine, directory, stem, sources, patchField, patchPath] of [
    [
      "rapier",
      "bench",
      "contact-native",
      [
        ["probeSha256", "native/rapier/allocation_probe.rs"],
        ["dependencyLockSha256", "native/rapier/Cargo.lock"],
      ],
      "patchSha256",
      "native/rapier/patches/reuse-step-buffers.patch",
    ],
    [
      "jsbsim",
      "validation",
      "jsbsim-native",
      [
        ["bridgeSha256", "native/jsbsim/bridge.cpp"],
        ["checksSha256", "native/jsbsim/native_checks.cpp"],
      ],
      "enginePatchSha256",
      "native/jsbsim/patches/reuse-history-and-property-paths.patch",
    ],
  ]) {
    const paths = [stem, `${stem}-patched`].map(
      (name) => `test-results/${directory}/${name}.json`,
    );
    const bytes = paths.map((path) => readFileSync(join(root, path)));
    const [baseline, patched] = bytes.map((b) => JSON.parse(b));
    const pin = JSON.parse(
      readFileSync(join(root, `native/${engine}/source.lock.json`)),
    );
    if (
      baseline.sourceCommit !== pin.commit ||
      patched.sourceCommit !== pin.commit
    )
      throw new Error(`Stale ${engine} source pin`);
    for (const [field, file] of sources)
      if (
        baseline[field] !== sha(readFileSync(join(root, file))) ||
        baseline[field] !== patched[field]
      )
        throw new Error(`Stale ${engine} source evidence: ${field}`);
    if (
      baseline[patchField] !== null ||
      patched[patchField] !== sha(readFileSync(join(root, patchPath)))
    )
      throw new Error(`Stale ${engine} patch evidence`);
    cases.push({
      engine,
      ...compareEvidence(baseline, patched),
      paths,
      reportSha256: bytes.map(sha),
      patchSha256: patched[patchField],
    });
  }
  const report = {
    schemaVersion: 1,
    status: "pass",
    comparison:
      "FNV-1a-64 of every finite output double, encoded little endian; exact checksum equality",
    wasmParityStatus: "unverified",
    cases,
  };
  mkdirSync(join(root, "test-results/validation"), { recursive: true });
  writeFileSync(
    join(root, "test-results/validation/engine-patch-parity.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  return report;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(checkParity()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
