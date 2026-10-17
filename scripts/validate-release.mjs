import { readFileSync } from "node:fs";
import { cli, exact, report, sha256, loadJson } from "./validation/evidence.mjs";
export const SYSTEM_REQUIREMENTS = {
  demo: ["G0-unit", "G0-browser", "G0-build", "G1-physics", "G2-model", "G3-gpu"],
  "external-sitl": ["G0-unit", "G0-browser", "G0-build", "G1-physics", "G2-model", "G3-gpu", "G4-sitl", "G4-ekf"],
  "wasm-sitl": ["G0-unit", "G0-browser", "G0-build", "G1-physics", "G2-model", "G3-gpu", "G4-wasm-parity", "G4-ekf"],
  hitl: ["G0-unit", "G0-browser", "G0-build", "G1-physics", "G2-model", "G3-gpu", "G4-hitl", "G4-ekf"],
};
/** Explicit evidence matrix: unknown, absent, blocked and failed never become PASS. */
export function assessSystem(v, readEvidence = loadJson) {
  exact(v, ["schemaVersion", "sourceRevision", "requirements"]);
  if (v.schemaVersion !== 1 || typeof v.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(v.sourceRevision) || !Array.isArray(v.requirements)) throw new Error("Invalid system evidence header");
  const ids = [...new Set(Object.values(SYSTEM_REQUIREMENTS).flat())];
  const found = new Map();
  for (const e of v.requirements) {
    exact(e, ["id", "status", "evidenceSha256", "evidencePath", "reason", "sourceRevision", "source"]);
    if (!ids.includes(e.id) || found.has(e.id) || !["PASS", "FAIL", "BLOCKED_EXTERNAL", "NOT_RUN"].includes(e.status) || typeof e.reason !== "string" || e.sourceRevision !== v.sourceRevision) throw new Error("Unknown, duplicate or stale system evidence");
    if (e.status === "PASS" && (!/^[a-f0-9]{64}$/.test(e.evidenceSha256) || e.source !== "observed")) throw new Error("PASS requires hash-bound observed evidence");
    if (e.status === "PASS") {
      const names = { "G0-unit": "unit-report", "G0-browser": "browser-report", "G0-build": "build-report", "G1-physics": "physics-report", "G2-model": "model-report", "G3-gpu": "gpu-report", "G4-sitl": "sitl-report", "G4-ekf": "ekf-report", "G4-hitl": "hitl-report", "G4-wasm-parity": "autopilot-parity" };
      const name = names[e.id];
      if (e.evidencePath !== `test-results/validation/${name}.json`) throw new Error("Unexpected system evidence path");
      const raw = readEvidence(e.evidencePath, e.evidenceSha256);
      if (raw.kind !== name || raw.status !== "PASS" || raw.sourceRevision !== v.sourceRevision) throw new Error("Unverified/stale/nonpassing underlying evidence");
    }
    if (e.status !== "PASS" && !e.reason.trim()) throw new Error("Nonpassing evidence must explain the limitation");
    found.set(e.id, e);
  }
  const modes = {};
  for (const [mode, requirements] of Object.entries(SYSTEM_REQUIREMENTS)) {
    const gates = requirements.map(id => found.get(id) ?? { id, status: "NOT_RUN", reason: "No execution evidence supplied" });
    modes[mode] = { status: gates.some(g => g.status === "FAIL") ? "FAIL" : gates.every(g => g.status === "PASS") ? "PASS" : "BLOCKED_EXTERNAL", gates };
  }
  const values = Object.values(modes);
  return report("system-report", values.some(v => v.status === "FAIL") ? "FAIL" : values.every(v => v.status === "PASS") ? "PASS" : "BLOCKED_EXTERNAL", ["Matrix entries are operator evidence declarations; verify referenced report bytes before release"], { modes });
}
export function defaultSystemMatrix() {
  const bytes = readFileSync(new URL("../docs/validation/system-matrix.json", import.meta.url));
  return { sha256: sha256(bytes), value: JSON.parse(bytes) };
}
cli(import.meta.url, "system-report", assessSystem);
