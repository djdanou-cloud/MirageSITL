// Compute the fidelity metrics of a capture schema 2 (TASK-090, TASK-184) of measured flight and bench data against the simulation.
// Usage: node scripts/check-fidelity.mjs --input CAPTURE.json --sha256 HEX
// MirageSITL sets no fidelity limit and gives no verdict (SA-01): a flight-test capture's metrics are REPORTED (exit 0) for the user
// to judge. Exit 1 for invalid evidence, a capture schema 1 among it, whose declared limits are no longer applied; exit 2
// BLOCKED_EXTERNAL without input or for synthetic provenance, whose metrics are computed but compare MirageSITL with no aircraft.
import { createHash } from "node:crypto";
import { cli, exact, finite, hash, object, report, text } from "./validation/evidence.mjs";
import { COHERENCE_GUIDELINE, frequencyResponseCost, timeDomainMetrics, welchFrequencyResponse } from "../packages/physics/src/fidelity-metrics.ts";
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
function timeDomain(item) {
  exact(item, ["id", "unit", "sampleRateHz", "measured", "simulated"]);
  text(item.unit); finite(item.sampleRateHz, Number.MIN_VALUE);
  const m = timeDomainMetrics(series(item.measured, "Measured series"), series(item.simulated, "Simulated series"));
  return { unit: item.unit, samples: m.samples, rms: m.rms, bias: m.bias, theil: m.theil };
}
function frequencyResponse(item) {
  exact(item, ["id", "sampleRateHz", "segmentLength", "overlap", "window", "bandHz", "points", "minCoherence",
    "measuredInput", "measuredOutput", "simulatedInput", "simulatedOutput"]);
  if (item.window !== "hann" && item.window !== "rectangular") throw new Error("Unsupported spectral window");
  if (!Array.isArray(item.bandHz) || item.bandHz.length !== 2) throw new Error("Frequency band must be [lowHz, highHz]");
  // The coherence below which a frequency point is unusable is part of the method, not a fidelity limit: never below the guideline.
  const minCoherence = finite(item.minCoherence, COHERENCE_GUIDELINE, 1);
  const measured = welchFrequencyResponse(series(item.measuredInput, "Measured input"), series(item.measuredOutput, "Measured output"),
    item.sampleRateHz, item.segmentLength, item.overlap, item.window);
  const simulated = welchFrequencyResponse(series(item.simulatedInput, "Simulated input"), series(item.simulatedOutput, "Simulated output"),
    item.sampleRateHz, item.segmentLength, item.overlap, item.window);
  const fit = frequencyResponseCost(measured, simulated, { bandHz: [finite(item.bandHz[0]), finite(item.bandHz[1])], points: item.points, minCoherence });
  return { cost: fit.cost, minCoherence, points: fit.points, excludedPoints: fit.excludedPoints,
    measuredSegments: measured.segments, simulatedSegments: simulated.segments };
}
function bench(v) {
  exact(v, ["csv", "csvSha256", "predicted"]);
  if (typeof v.csv !== "string" || !hash(v.csvSha256) || createHash("sha256").update(v.csv, "utf8").digest("hex") !== v.csvSha256) {
    throw new Error("Bench CSV text does not match its SHA-256");
  }
  const data = importBenchCsv(v.csv);
  if (!Array.isArray(v.predicted) || v.predicted.length !== data.points.length) throw new Error("Bench predictions must match every measured row");
  let ctError = 0, cpError = 0, compared = 0;
  const flagged = [];
  for (let i = 0; i < data.points.length; i++) {
    const point = data.points[i], predicted = v.predicted[i];
    exact(predicted, ["rpm", "ct", "cp"]);
    if (finite(predicted.rpm) !== point.rpm) throw new Error("Bench prediction rpm differs from the measured row");
    // A physically inconsistent measured row is listed and left out of the errors: it compares the model with nothing.
    if (point.flags.length > 0 || !(point.ct > 0) || !(point.cp > 0)) { flagged.push({ row: i + 1, rpm: point.rpm, flags: [...point.flags] }); continue; }
    compared++;
    ctError = Math.max(ctError, Math.abs(finite(predicted.ct) - point.ct) / point.ct);
    cpError = Math.max(cpError, Math.abs(finite(predicted.cp) - point.cp) / point.cp);
  }
  return { rows: data.points.length, comparedRows: compared, flaggedRows: flagged.length, flagged,
    largestCtRelativeError: compared > 0 ? ctError : null, largestCpRelativeError: compared > 0 ? cpError : null };
}

/** Pure assessment of a parsed capture; `cli` handles hashing, budgets and exit codes. */
export function assessFidelity(v) {
  if (object(v) && v.kind === "mirage-fidelity-capture" && v.schemaVersion === 1) {
    throw new Error("Capture schema 1 declares limits, which MirageSITL no longer applies (SA-01, TASK-184): write capture schema 2 without them");
  }
  exact(v, ["schemaVersion", "kind", "provenance", "timeDomain", "frequencyResponse", "bench"]);
  if (v.schemaVersion !== 2 || v.kind !== "mirage-fidelity-capture") throw new Error("Unsupported fidelity capture");
  exact(v.provenance, ["source", "operator", "recordedAt", "firmwareSha256", "modelSha256"]);
  const { source, recordedAt, firmwareSha256, modelSha256 } = v.provenance;
  if (!SOURCES.has(source)) throw new Error("Capture source must be flight-test or synthetic");
  text(v.provenance.operator);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text(recordedAt)) || !Number.isFinite(Date.parse(recordedAt))) throw new Error("Invalid acquisition timestamp");
  if (!hash(firmwareSha256) || !hash(modelSha256)) throw new Error("Firmware and model SHA-256 are required");
  if (source === "flight-test" && (/^0+$/.test(firmwareSha256) || /^0+$/.test(modelSha256))) throw new Error("A flight-test capture needs real firmware and model hashes");
  const metrics = { source, timeDomain: {}, frequencyResponse: {}, bench: null };
  for (const item of sections(v.timeDomain, "time-domain")) metrics.timeDomain[item.id] = timeDomain(item);
  for (const item of sections(v.frequencyResponse, "frequency-response")) metrics.frequencyResponse[item.id] = frequencyResponse(item);
  if (v.bench !== null) metrics.bench = bench(v.bench);
  if (v.timeDomain.length + v.frequencyResponse.length === 0 && v.bench === null) throw new Error("Capture has no section to compute");
  if (source === "synthetic") {
    return report("fidelity", "BLOCKED_EXTERNAL", ["Synthetic capture: the metrics are computed, but only measured flight and bench data compare MirageSITL with an aircraft"], metrics);
  }
  const reasons = ["The metrics are reported without a limit or a verdict (SA-01); the user judges them"];
  if (metrics.bench && metrics.bench.flaggedRows > 0) reasons.push(`${metrics.bench.flaggedRows} bench rows are physically inconsistent and left out of the bench errors`);
  return report("fidelity", "REPORTED", reasons, metrics);
}

cli(import.meta.url, "fidelity", assessFidelity);
