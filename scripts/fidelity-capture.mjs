// TASK-090: a fidelity capture schema 2 from two DataFlash logs, a flight and the simulation of it, for scripts/check-fidelity.mjs.
//
//   node scripts/fidelity-capture.mjs --real REAL.bin --simulated RUN.bin --firmware-sha256 HEX --model-sha256 HEX --operator NAME
//     --recorded-at 2026-11-06T12:00:00Z --out CAPTURE.json [--from S] [--to S] [--simulated-offset S] [--bench BENCH.csv --predicted ROWS.json]
//
// `tests/browser/fidelity-report.spec.ts` and TASK-183 make the simulated log: a run of the same profile, or a re-simulation of the flight.
// The source comes from the real log itself (`logOrigin`): a log with SITL settings or MirageSITL's messages is `synthetic`, whatever the
// file is called, so it can never be reported as a flight. A quantity a log lacks or that cannot be computed is left out and listed, never
// given a number. This writes no limit and no verdict (SA-01). Exit 0 with the capture written, 1 for invalid input, 2 for missing input.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The packages it reads use TypeScript syntax that plain type stripping refuses.
const TRANSFORM = "--experimental-transform-types";
if (!process.execArgv.includes(TRANSFORM)) {
  const child = spawnSync(process.execPath, [TRANSFORM, "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}
const { FIDELITY_SERIES, logOrigin, pairedSeries } = await import("../packages/analysis/src/fidelity.ts");
const { readDataFlash } = await import("../packages/dataflash/src/reader.ts");
const { COHERENCE_GUIDELINE, frequencyResponseCost, timeDomainMetrics, welchFrequencyResponse } = await import("../packages/physics/src/fidelity-metrics.ts");

const REQUIRED = ["real", "simulated", "firmware-sha256", "model-sha256", "operator", "recorded-at", "out"];
const OPTIONAL = ["from", "to", "simulated-offset", "bench", "predicted"];
/** Requested and actual rate columns of ArduPilot's RATE message. */
const RATE_AXES = [["roll", "RDes", "R"], ["pitch", "PDes", "P"], ["yaw", "YDes", "Y"]];
const POINTS = 20, OVERLAP_SHARE = 2, MIN_SEGMENT = 16, MAX_SEGMENT = 1024, MAX_SERIES_SAMPLES = 1 << 20;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const kebab = id => id.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
function argumentsOf(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.startsWith("--") ? argv[i].slice(2) : null;
    if (!name || ![...REQUIRED, ...OPTIONAL].includes(name) || argv[i + 1] === undefined) throw new Error(`Unexpected argument ${argv[i]}`);
    values.set(name, argv[i + 1]);
  }
  return values;
}
const number = (text, name) => {
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
};
function column(log, group, name) {
  const found = log.groups.find(item => item.name === group && item.count > 0);
  const values = found?.columns.find(item => item.name === name), time = found?.columns.find(item => item.name === "TimeUS");
  if (!found || !values || !time) return null;
  const timeS = [], out = [];
  for (let row = 0; row < found.count; row++) { timeS.push(Number(time.values[row]) * 1e-6); out.push(Number(values.values[row]) * values.valueScale); }
  return { timeS, values: out };
}
/** `series` at each of `times`, straight between its rows; null when a time falls outside it. */
function resampled(series, times, offsetS) {
  const out = [];
  let at = 0;
  for (const time of times) {
    const t = time + offsetS;
    while (at + 1 < series.timeS.length && series.timeS[at + 1] <= t) at++;
    const a = series.timeS[at], b = series.timeS[at + 1];
    if (!(a <= t) || (b === undefined && a !== t)) return null;
    out.push(b === undefined ? series.values[at] : series.values[at] + (series.values[at + 1] - series.values[at]) * (t - a) / (b - a));
  }
  return out;
}
function medianStep(timeS) {
  const steps = [];
  for (let i = 1; i < timeS.length; i++) if (timeS[i] > timeS[i - 1]) steps.push(timeS[i] - timeS[i - 1]);
  steps.sort((a, b) => a - b);
  return steps[steps.length >> 1];
}
function frequencySections(real, simulated, fromS, toS, offsetS, skipped) {
  const sections = [];
  for (const [axis, requested, actual] of RATE_AXES) {
    const id = `${axis}-rate-response`;
    const realIn = column(real, "RATE", requested), realOut = column(real, "RATE", actual), simIn = column(simulated, "RATE", requested), simOut = column(simulated, "RATE", actual);
    if (!realIn || !realOut || !simIn || !simOut) { skipped.push({ id, reason: "A log has no RATE messages with these columns" }); continue; }
    const step = medianStep(realIn.timeS);
    if (!step) { skipped.push({ id, reason: "The real log's RATE rows have no time step" }); continue; }
    const sampleRateHz = Math.round(1 / step), count = Math.min(MAX_SERIES_SAMPLES, Math.floor((toS - fromS) * sampleRateHz) + 1);
    const times = Array.from({ length: count }, (_, i) => fromS + i / sampleRateHz);
    const measuredInput = resampled(realIn, times, 0), measuredOutput = resampled(realOut, times, 0);
    const simulatedInput = resampled(simIn, times, offsetS), simulatedOutput = resampled(simOut, times, offsetS);
    if (!measuredInput || !measuredOutput || !simulatedInput || !simulatedOutput) { skipped.push({ id, reason: "The interval runs past a log's RATE rows" }); continue; }
    let segmentLength = MIN_SEGMENT;
    while (segmentLength * 2 <= MAX_SEGMENT && segmentLength * 4 <= count) segmentLength *= 2;
    const overlap = segmentLength / OVERLAP_SHARE, bandHz = [2 * sampleRateHz / segmentLength, Math.min(20, 0.4 * sampleRateHz)];
    const item = { id, sampleRateHz, segmentLength, overlap, window: "hann", bandHz, points: POINTS, minCoherence: COHERENCE_GUIDELINE, measuredInput, measuredOutput, simulatedInput, simulatedOutput };
    try {
      const measured = welchFrequencyResponse(measuredInput, measuredOutput, sampleRateHz, segmentLength, overlap, "hann");
      const model = welchFrequencyResponse(simulatedInput, simulatedOutput, sampleRateHz, segmentLength, overlap, "hann");
      frequencyResponseCost(measured, model, { bandHz, points: POINTS, minCoherence: COHERENCE_GUIDELINE });
      sections.push(item);
    } catch (cause) {
      skipped.push({ id, reason: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return sections;
}

function main() {
  const argv = process.argv.slice(2), args = argumentsOf(argv);
  const missing = REQUIRED.filter(name => !args.has(name));
  if (missing.length > 0) {
    console.error(`Missing ${missing.map(name => `--${name}`).join(", ")}. A flight log and its simulated run are the inputs: see the file's header.`);
    return 2;
  }
  if (args.has("bench") !== args.has("predicted")) throw new Error("--bench and --predicted go together");
  const realBytes = readFileSync(args.get("real")), simulatedBytes = readFileSync(args.get("simulated"));
  const real = readDataFlash(new Uint8Array(realBytes)), simulated = readDataFlash(new Uint8Array(simulatedBytes));
  const attitude = column(real, "ATT", "Roll");
  if (!attitude) throw new Error("The real log has no ATT messages");
  const fromS = args.has("from") ? number(args.get("from"), "from") : attitude.timeS[0], toS = args.has("to") ? number(args.get("to"), "to") : attitude.timeS[attitude.timeS.length - 1];
  const offsetS = args.has("simulated-offset") ? number(args.get("simulated-offset"), "simulated-offset") : 0;
  if (!(toS > fromS)) throw new Error("--to must be after --from");
  const interval = { fromS, toS, simulatedOffsetS: offsetS }, skipped = [], timeDomain = [];
  for (const source of FIDELITY_SERIES) {
    const id = kebab(source.id), paired = pairedSeries(real, simulated, interval, source.id);
    if (typeof paired === "string") { skipped.push({ id, reason: paired }); continue; }
    if (paired.real.length < 2) { skipped.push({ id, reason: "Fewer than two samples in the interval" }); continue; }
    if (paired.real.length > MAX_SERIES_SAMPLES) { skipped.push({ id, reason: `More than ${MAX_SERIES_SAMPLES} samples in the interval` }); continue; }
    try { timeDomainMetrics(paired.real, paired.simulated); } catch (cause) { skipped.push({ id, reason: cause instanceof Error ? cause.message : String(cause) }); continue; }
    timeDomain.push({ id, unit: source.unit, sampleRateHz: Math.round(1 / medianStep(paired.timeS)), measured: paired.real, simulated: paired.simulated });
  }
  const frequencyResponse = frequencySections(real, simulated, fromS, toS, offsetS, skipped);
  const origin = logOrigin(real);
  let bench = null;
  if (args.has("bench")) {
    const csv = readFileSync(args.get("bench"), "utf8");
    bench = { csv, csvSha256: sha256(csv), predicted: JSON.parse(readFileSync(args.get("predicted"), "utf8")) };
  }
  const capture = { schemaVersion: 2, kind: "mirage-fidelity-capture",
    provenance: { source: origin.kind === "real" ? "flight-test" : "synthetic", operator: args.get("operator"), recordedAt: args.get("recorded-at"),
      firmwareSha256: args.get("firmware-sha256"), modelSha256: args.get("model-sha256"), logs: { realSha256: sha256(realBytes), simulatedSha256: sha256(simulatedBytes) } },
    timeDomain, frequencyResponse, bench };
  const text = `${JSON.stringify(capture)}\n`;
  writeFileSync(args.get("out"), text);
  console.log(JSON.stringify({ out: args.get("out"), sha256: sha256(text), source: capture.provenance.source, origin: origin.reason,
    timeDomain: timeDomain.map(item => item.id), frequencyResponse: frequencyResponse.map(item => item.id), skipped }, null, 2));
  return 0;
}
try {
  process.exitCode = main();
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
