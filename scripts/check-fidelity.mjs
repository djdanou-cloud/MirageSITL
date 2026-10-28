// Score a fidelity capture v1 (TASK-090) against measured flight and bench data.
// Usage: node scripts/check-fidelity.mjs --input CAPTURE.json --sha256 HEX
// Exit 0 PASS, 1 FAIL or invalid evidence, 2 BLOCKED_EXTERNAL (no input, or
// synthetic provenance: metrics are computed but never establish fidelity).
import { createHash } from "node:crypto";
import { cli, exact, finite, hash, object, report, text } from "./validation/evidence.mjs";
import { COHERENCE_GUIDELINE, COST_GUIDELINE, frequencyResponseCost, timeDomainMetrics, welchFrequencyResponse } from "../packages/physics/src/fidelity-metrics.ts";
import { importBenchCsv } from "../packages/physics/src/bench-import.ts";

const MAX_SERIES_SAMPLES = 1 << 20, MAX_SECTIONS = 32;
const SOURCES = new Set(["flight-test", "synthetic"]);
function identifier(v) {
  if (typeof v !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v)) throw new Error("Invalid section identifier");
  return v;
}
function series(v, label) {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_SERIES_SAMPLES) throw new Error(`${label} must hold 2..${MAX_SERIES_SAMPLES} samples`);
  for (const value of v) finite(value);
  return v;
}
function sections(v, label) {
  if (!Array.isArray(v) || v.length > MAX_SECTIONS) throw new Error(`${label} must be an array of at most ${MAX_SECTIONS} sections`);
  const ids = v.map(item => identifier(object(item) ? item.id : undefined));
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} identifier`);
  return v;
}
function scoreTimeDomain(item) {
  exact(item, ["id", "unit", "sampleRateHz", "measured", "simulated", "limits"]);
  text(item.unit); finite(item.sampleRateHz, Number.MIN_VALUE);
  exact(item.limits, ["maxRms", "maxAbsBias", "maxTheil"]);
  const maxRms = finite(item.limits.maxRms, 0), maxAbsBias = finite(item.limits.maxAbsBias, 0), maxTheil = finite(item.limits.maxTheil, 0, 1);
  const m = timeDomainMetrics(series(item.measured, "Measured series"), series(item.simulated, "Simulated series"));
  const passed = m.rms <= maxRms && Math.abs(m.bias) <= maxAbsBias && m.theil <= maxTheil;
  return { passed, metrics: { samples: m.samples, rms: m.rms, bias: m.bias, theil: m.theil, limits: item.limits, passed } };
}
function scoreFrequencyResponse(item) {
  exact(item, ["id", "sampleRateHz", "segmentLength", "overlap", "window", "bandHz", "points", "minCoherence", "maxCost",
    "measuredInput", "measuredOutput", "simulatedInput", "simulatedOutput"]);
  if (item.window !== "hann" && item.window !== "rectangular") throw new Error("Unsupported spectral window");
  if (!Array.isArray(item.bandHz) || item.bandHz.length !== 2) throw new Error("Frequency band must be [lowHz, highHz]");
  // The declared limits may be stricter than the published guidelines, never looser.
  const maxCost = finite(item.maxCost, Number.MIN_VALUE, COST_GUIDELINE), minCoherence = finite(item.minCoherence, COHERENCE_GUIDELINE, 1);
  const measured = welchFrequencyResponse(series(item.measuredInput, "Measured input"), series(item.measuredOutput, "Measured output"),
    item.sampleRateHz, item.segmentLength, item.overlap, item.window);
  const simulated = welchFrequencyResponse(series(item.simulatedInput, "Simulated input"), series(item.simulatedOutput, "Simulated output"),
    item.sampleRateHz, item.segmentLength, item.overlap, item.window);
  const fit = frequencyResponseCost(measured, simulated, { bandHz: [finite(item.bandHz[0]), finite(item.bandHz[1])], points: item.points, minCoherence });
  const passed = fit.cost <= maxCost;
  return { passed, metrics: { cost: fit.cost, maxCost, points: fit.points, excludedPoints: fit.excludedPoints,
    measuredSegments: measured.segments, simulatedSegments: simulated.segments, passed } };
}
function scoreBench(v) {
  exact(v, ["csv", "csvSha256", "predicted", "limits"]);
  if (typeof v.csv !== "string" || !hash(v.csvSha256) || createHash("sha256").update(v.csv, "utf8").digest("hex") !== v.csvSha256) {
    throw new Error("Bench CSV text does not match its SHA-256");
  }
  exact(v.limits, ["maxCtRelativeError", "maxCpRelativeError"]);
  const maxCt = finite(v.limits.maxCtRelativeError, Number.MIN_VALUE, 1), maxCp = finite(v.limits.maxCpRelativeError, Number.MIN_VALUE, 1);
  const bench = importBenchCsv(v.csv);
  if (!Array.isArray(v.predicted) || v.predicted.length !== bench.points.length) throw new Error("Bench predictions must match every measured row");
  let ctError = 0, cpError = 0, flaggedRows = 0;
  for (let i = 0; i < bench.points.length; i++) {
    const point = bench.points[i], predicted = v.predicted[i];
    exact(predicted, ["rpm", "ct", "cp"]);
    if (finite(predicted.rpm) !== point.rpm) throw new Error("Bench prediction rpm differs from the measured row");
    if (point.flags.length > 0 || !(point.ct > 0) || !(point.cp > 0)) { flaggedRows++; continue; }
    ctError = Math.max(ctError, Math.abs(finite(predicted.ct) - point.ct) / point.ct);
    cpError = Math.max(cpError, Math.abs(finite(predicted.cp) - point.cp) / point.cp);
  }
  // A physically inconsistent measured row cannot support a passing comparison.
  const passed = flaggedRows === 0 && ctError <= maxCt && cpError <= maxCp;
  return { passed, metrics: { rows: bench.points.length, flaggedRows, maxCtRelativeError: ctError, maxCpRelativeError: cpError, limits: v.limits, passed } };
}

/** Pure assessment of a parsed capture; `cli` handles hashing, budgets and exit codes. */
export function assessFidelity(v) {
  exact(v, ["schemaVersion", "kind", "provenance", "timeDomain", "frequencyResponse", "bench"]);
  if (v.schemaVersion !== 1 || v.kind !== "mirage-fidelity-capture") throw new Error("Unsupported fidelity capture");
  exact(v.provenance, ["source", "operator", "recordedAt", "firmwareSha256", "modelSha256"]);
  const { source, recordedAt, firmwareSha256, modelSha256 } = v.provenance;
  if (!SOURCES.has(source)) throw new Error("Capture source must be flight-test or synthetic");
  text(v.provenance.operator);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text(recordedAt)) || !Number.isFinite(Date.parse(recordedAt))) throw new Error("Invalid acquisition timestamp");
  if (!hash(firmwareSha256) || !hash(modelSha256)) throw new Error("Firmware and model SHA-256 are required");
  if (source === "flight-test" && (/^0+$/.test(firmwareSha256) || /^0+$/.test(modelSha256))) throw new Error("A flight-test capture needs real firmware and model hashes");
  const metrics = { source, timeDomain: {}, frequencyResponse: {}, bench: null };
  const failed = [];
  for (const item of sections(v.timeDomain, "time-domain")) {
    const scored = scoreTimeDomain(item); metrics.timeDomain[item.id] = scored.metrics;
    if (!scored.passed) failed.push(`time-domain ${item.id}`);
  }
  for (const item of sections(v.frequencyResponse, "frequency-response")) {
    const scored = scoreFrequencyResponse(item); metrics.frequencyResponse[item.id] = scored.metrics;
    if (!scored.passed) failed.push(`frequency-response ${item.id}`);
  }
  if (v.bench !== null) {
    const scored = scoreBench(v.bench); metrics.bench = scored.metrics;
    if (!scored.passed) failed.push("bench");
  }
  if (v.timeDomain.length + v.frequencyResponse.length === 0 && v.bench === null) throw new Error("Capture has no section to score");
  metrics.limitsMet = failed.length === 0;
  if (source === "synthetic") {
    return report("fidelity", "BLOCKED_EXTERNAL", ["Synthetic capture: metrics are computed, but only measured flight and bench data can pass"], metrics);
  }
  return report("fidelity", failed.length === 0 ? "PASS" : "FAIL", failed.map(id => `${id} exceeds its declared limit`), metrics);
}

cli(import.meta.url, "fidelity", assessFidelity);
