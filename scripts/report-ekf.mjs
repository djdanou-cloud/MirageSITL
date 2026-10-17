import { readFileSync } from "node:fs";
import { cli, exact, provenance, finite, report, hash } from "./validation/evidence.mjs";
export const EW_CASES = ["control", "jamming", "position-step", "velocity-drift", "magnetic", "motor-loss"];
/** Records actual EKF/mode responses; there is no promised forced mode transition. */
export function assessEkf(v, frozen = JSON.parse(readFileSync(new URL("../tests/fixtures/scenarios/ew-matrix.json", import.meta.url)))) {
  exact(v, ["schemaVersion", "provenance", "parameterSha256", "cases"]);
  if (v.schemaVersion !== 1 || !hash(v.parameterSha256) || !Array.isArray(v.cases) || v.cases.length !== EW_CASES.length) throw new Error("Incomplete EW control/fault matrix");
  provenance(v.provenance, "native-sitl");
  const metrics = {}; let passed = true;
  for (let i = 0; i < EW_CASES.length; i++) {
    const c = v.cases[i]; exact(c, ["id", "samples", "envelope"]);
    if (c.id !== EW_CASES[i] || !Array.isArray(c.samples) || c.samples.length < 2 || c.samples.length > 100000) throw new Error("Missing ordered EW case");
    exact(c.envelope, ["maxPositionErrorM", "maxInnovationRatio"]);
    finite(c.envelope.maxPositionErrorM, 0, 10000); finite(c.envelope.maxInnovationRatio, 0, 10000);
    let previous = -1, changed = false, error = 0, innovation = 0;
    for (const s of c.samples) {
      exact(s, ["timeS", "truthSha256", "baselineTruthSha256", "observedChanged", "positionErrorM", "innovationRatio", "mode", "ekfFlags"]);
      finite(s.timeS, 0); finite(s.positionErrorM, 0); finite(s.innovationRatio, 0); finite(s.mode, 0, 0xffffffff); finite(s.ekfFlags, 0, 0xffffffff);
      if (s.timeS <= previous || !hash(s.truthSha256) || s.truthSha256 !== s.baselineTruthSha256 || typeof s.observedChanged !== "boolean") throw new Error("EW trace altered truth or reversed time");
      previous = s.timeS; changed ||= s.observedChanged;
      error = Math.max(error, s.positionErrorM); innovation = Math.max(innovation, s.innovationRatio);
    }
    const ok = changed === (c.id !== "control") && error <= c.envelope.maxPositionErrorM && innovation <= c.envelope.maxInnovationRatio;
    passed &&= ok; metrics[c.id] = { maxPositionErrorM: error, maxInnovationRatio: innovation, changedObservations: changed };
  }
  if (!frozen.envelopes || frozen.firmwareSha256 !== v.provenance.firmwareSha256 || frozen.parameterSha256 !== v.parameterSha256)
    return report("ekf-report", "BLOCKED_EXTERNAL", ["Missing independently frozen firmware/parameter-specific response envelopes"], metrics);
  for (const c of v.cases) {
    const e = frozen.envelopes[c.id];
    if (!e || e.maxPositionErrorM !== c.envelope.maxPositionErrorM || e.maxInnovationRatio !== c.envelope.maxInnovationRatio) throw new Error("EW response envelope differs from frozen baseline");
  }
  // Envelopes are version-specific operator evidence, never rewritten to force a PASS.
  return report("ekf-report", passed ? "PASS" : "FAIL", passed ? [] : ["Observation isolation or frozen response envelope failed"], metrics);
}
cli(import.meta.url, "ekf-report", assessEkf);
