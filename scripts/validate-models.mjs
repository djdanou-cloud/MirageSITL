// Numerical self-consistency is not experimental fidelity or a complete backend gate.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BetRigidBodyBackend,
  newBodyTruth,
} from "../packages/wasm-bet/src/backend.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (b) => createHash("sha256").update(b).digest("hex");
export function parseReference(bytes) {
  const v = JSON.parse(bytes);
  const finiteArray = (a, n) =>
    Array.isArray(a) &&
    a.length === n &&
    a.every((x) => typeof x === "number" && Number.isFinite(x));
  if (
    !v ||
    v.schemaVersion !== 1 ||
    v.kind !== "synthetic" ||
    v.durationS !== 10 ||
    v.referenceHz !== 4800 ||
    !finiteArray(v.testHz, 3) ||
    v.testHz.some((hz, i) => hz !== [400, 800, 1200][i]) ||
    v.positionToleranceM !== 0.1 ||
    v.attitudeToleranceRad !== Math.PI / 360 ||
    typeof v.provenance !== "string" ||
    !v.provenance.length ||
    !Array.isArray(v.measurements) ||
    v.measurements.length !== 0 ||
    !Array.isArray(v.cases) ||
    v.cases.length < 1 ||
    v.cases.length > 32
  )
    throw new Error(
      "Invalid pinned reference contract or unsupported measured dataset adapter",
    );
  const ids = new Set();
  for (const c of v.cases) {
    if (
      !c ||
      typeof c.id !== "string" ||
      !/^[A-Za-z0-9-]{1,64}$/.test(c.id) ||
      ids.has(c.id) ||
      !Number.isFinite(c.massKg) ||
      c.massKg <= 0 ||
      !finiteArray(c.inertia, 9) ||
      !finiteArray(c.wrench, 6)
    )
      throw new Error("Invalid reference case");
    ids.add(c.id);
  }
  if (!ids.has("ballistic"))
    throw new Error("Missing independent ballistic oracle");
  return v;
}
function diagnostic(relative, sourceFields, passField) {
  const path = join(root, relative);
  if (!existsSync(path))
    return { path: relative, status: "missing", reportSha256: null };
  try {
    const bytes = readFileSync(path),
      value = JSON.parse(bytes);
    const base = { path: relative, reportSha256: sha(bytes) };
    for (const [field, file] of sourceFields)
      if (value[field] !== sha(readFileSync(join(root, file))))
        return { ...base, status: "stale" };
    if (passField === "status") {
      if (!["pass", "blocked", "failed"].includes(value.status))
        return { ...base, status: "invalid" };
      return { ...base, status: value.status === "pass" ? "pass" : "failed" };
    }
    if (typeof value[passField] !== "boolean")
      return { ...base, status: "invalid" };
    return { ...base, status: value[passField] ? "pass" : "failed" };
  } catch {
    return { path: relative, status: "invalid", reportSha256: null };
  }
}
export async function validateModels() {
  const refBytes = readFileSync(
      join(root, "tests/fixtures/validation/reference-manifest.json"),
    ),
    reference = parseReference(refBytes);
  execFileSync(process.execPath, [join(root, "scripts/build-wasm.mjs")], {
    cwd: root,
    stdio: "pipe",
  });
  const bytes = {
    scalar: readFileSync(
      join(root, "packages/wasm-bet/dist/mirage_bet.scalar.wasm"),
    ),
    simd128: readFileSync(
      join(root, "packages/wasm-bet/dist/mirage_bet.simd128.wasm"),
    ),
  };
  async function trajectory(c, hz, variant) {
    const { instance } = await WebAssembly.instantiate(bytes[variant], {});
    const backend = new BetRigidBodyBackend(instance, c.massKg, c.inertia),
      out = newBodyTruth(),
      wrench = new Float64Array(c.wrench);
    for (let i = 0; i < hz * reference.durationS; i++)
      if (!backend.stepInto(wrench, 1 / hz, out))
        throw new Error("Body trajectory rejected");
    return out;
  }
  const cases = [];
  let passed = true;
  for (const c of reference.cases) {
    const truth = await trajectory(c, reference.referenceHz, "scalar");
    for (const hz of reference.testHz)
      for (const variant of ["scalar", "simd128"]) {
        const tested = await trajectory(c, hz, variant);
        let squared = 0,
          dot = 0;
        for (let i = 0; i < 3; i++)
          squared += (tested.positionNedM[i] - truth.positionNedM[i]) ** 2;
        for (let i = 0; i < 4; i++)
          dot += tested.quaternionBodyToNed[i] * truth.quaternionBodyToNed[i];
        const positionErrorM = Math.sqrt(squared),
          attitudeErrorRad = 2 * Math.acos(Math.min(1, Math.abs(dot)));
        const analyticErrorM =
          c.id === "ballistic"
            ? Math.abs(
                tested.positionNedM[2] -
                  0.5 * 9.80665 * reference.durationS ** 2,
              )
            : null;
        const ok =
          positionErrorM <= 0.1 &&
          attitudeErrorRad <= Math.PI / 360 &&
          (analyticErrorM === null || analyticErrorM < 1e-6);
        passed &&= ok;
        cases.push({
          id: c.id,
          hz,
          variant,
          positionErrorM,
          attitudeErrorRad,
          analyticErrorM,
          status: ok ? "pass" : "failed",
        });
      }
  }
  return {
    schemaVersion: 2,
    status: passed ? "blocked" : "failed",
    numericalStatus: passed ? "pass" : "failed",
    fidelityStatus: "blocked",
    referenceSha256: sha(refBytes),
    artifactSha256: { scalar: sha(bytes.scalar), simd128: sha(bytes.simd128) },
    cases,
    blockers: [
      "Measured airframe/rotor validation is not certified.",
      "Full BET polar/rotor-to-body backend is not connected.",
      "Production Rapier contact G1 is not certified; opt-in patched native evidence does not certify its JS/WASM binding.",
      "JSBSim WASM parity and contact coupling are not certified; patched native allocation/trim are separate evidence.",
    ],
    diagnostics: {
      contact: diagnostic(
        "test-results/bench/contact.json",
        [["adapterSha256", "packages/physics/src/ground-contact.ts"]],
        "jsAllocationPassed",
      ),
      jsbsimNative: diagnostic(
        "test-results/validation/jsbsim-native.json",
        [
          ["bridgeSha256", "native/jsbsim/bridge.cpp"],
          ["checksSha256", "native/jsbsim/native_checks.cpp"],
        ],
        "status",
      ),
      contactNativePatched: diagnostic(
        "test-results/bench/contact-native-patched.json",
        [
          ["probeSha256", "native/rapier/allocation_probe.rs"],
          ["dependencyLockSha256", "native/rapier/Cargo.lock"],
          ["patchSha256", "native/rapier/patches/reuse-step-buffers.patch"],
        ],
        "status",
      ),
      jsbsimNativePatched: diagnostic(
        "test-results/validation/jsbsim-native-patched.json",
        [
          ["bridgeSha256", "native/jsbsim/bridge.cpp"],
          ["checksSha256", "native/jsbsim/native_checks.cpp"],
          [
            "enginePatchSha256",
            "native/jsbsim/patches/reuse-history-and-property-paths.patch",
          ],
        ],
        "status",
      ),
    },
    positionToleranceM: 0.1,
    attitudeToleranceRad: Math.PI / 360,
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = await validateModels();
    const out = join(root, "test-results/validation/model-report.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
    console.log(
      `Model validation: numerical=${report.numericalStatus}; fidelity=${report.fidelityStatus}; status=${report.status}; ${report.cases.length} cases; ${out}`,
    );
    process.exitCode = report.status === "pass" ? 0 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
