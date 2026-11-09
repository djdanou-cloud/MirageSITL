// TASK-090: the committed report of a Pavo SystemId comparison (test-results/validation/pavo-systemid-logN.json) from the
// three files tests/sitl-systemid-pavo.test.ts writes to MIRAGE_SYSTEMID_OUT for log N: pavo-systemid-logN-run.json,
// -capture.json and -fidelity.json. The swept axis's frequency response is recomputed from the capture with the Welch
// response and cost of packages/physics/src/fidelity-metrics.ts and listed point by point (gain in dB, phase in degrees,
// coherence); the other axes keep their cost and point counts only. Nothing is judged (SA-01).
// Run: node --experimental-transform-types --no-warnings scripts/pavo/assemble-systemid.mjs --in RUN_DIR --out OUT_DIR [LOG...]
// LOG defaults to 33 34 35 36; OUT_DIR is normally test-results/validation.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { welchFrequencyResponse, frequencyResponseCost } = await import("../../packages/physics/src/fidelity-metrics.ts");
const ROOT = new URL("../../", import.meta.url).pathname;
/** The axis each log's SID_AXIS sweeps (data/flight-logs/inventory.json): 4 recovery roll, 5 recovery pitch, 6 recovery yaw. */
const SWEPT = { 33: "roll-rate-response", 34: "roll-rate-response", 35: "pitch-rate-response", 36: "yaw-rate-response" };
const NOTE = "The real log is the stakeholder's flight; the simulated log is native ArduCopter V4.7.2 SITL flying the Pavo profile, simulated data. Metrics are REPORTED with no limit and no verdict (SA-01). Only the swept axis compares like with like; the other axes and the time-domain rows compare two flights with different pilots.";

const args = process.argv.slice(2), logs = [];
let input = "", output = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--in") input = args[++i] ?? "";
  else if (args[i] === "--out") output = args[++i] ?? "";
  else logs.push(args[i]);
}
if (input === "" || output === "") {
  console.error("Usage: assemble-systemid.mjs --in RUN_DIR --out OUT_DIR [LOG...]");
  process.exit(2);
}
if (logs.length === 0) logs.push("33", "34", "35", "36");

const json = path => JSON.parse(readFileSync(path, "utf8"));
const inventory = json(join(ROOT, "data/flight-logs/inventory.json"));
const gainDb = (re, im) => 20 * Math.log10(Math.hypot(re, im)), phaseDeg = (re, im) => Math.atan2(im, re) * 180 / Math.PI;

for (const n of logs) {
  const axis = SWEPT[n];
  if (!axis) { console.error(`No swept axis is known for log ${n}`); process.exit(2); }
  const run = json(join(input, `pavo-systemid-log${n}-run.json`));
  const capture = json(join(input, `pavo-systemid-log${n}-capture.json`));
  const fidelity = json(join(input, `pavo-systemid-log${n}-fidelity.json`));
  const responses = {};
  for (const s of capture.frequencyResponse) {
    const m = welchFrequencyResponse(s.measuredInput, s.measuredOutput, s.sampleRateHz, s.segmentLength, s.overlap, s.window);
    const q = welchFrequencyResponse(s.simulatedInput, s.simulatedOutput, s.sampleRateHz, s.segmentLength, s.overlap, s.window);
    const fit = frequencyResponseCost(m, q, { bandHz: s.bandHz, points: s.points, minCoherence: s.minCoherence });
    const rows = fit.frequencyHz.map(f => {
      const k = m.frequencyHz.findIndex(x => Math.abs(x - f) < 1e-9);
      return { f: +f.toFixed(3), measuredDb: +gainDb(m.real[k], m.imag[k]).toFixed(2), simDb: +gainDb(q.real[k], q.imag[k]).toFixed(2),
        measuredDeg: +phaseDeg(m.real[k], m.imag[k]).toFixed(1), simDeg: +phaseDeg(q.real[k], q.imag[k]).toFixed(1),
        coh: +m.coherence[k].toFixed(3), simCoh: +q.coherence[k].toFixed(3) };
    });
    responses[s.id] = { cost: fit.cost, points: fit.points, excluded: fit.excludedPoints, rows };
  }
  if (!responses[axis]) { console.error(`Log ${n}: the capture has no ${axis}`); process.exit(1); }
  // The capture script's stdout, less the path it wrote to, which names the run's own directory.
  const summary = JSON.parse(run.captureStdout);
  delete summary.out;
  const real = inventory.logs.find(item => item.file === run.realFile);
  if (!real || real.sha256 !== run.realSha256) { console.error(`Log ${n}: ${run.realFile} does not match the inventory`); process.exit(1); }
  const report = {
    schemaVersion: 1, kind: "pavo-systemid-comparison", task: "TASK-090", note: NOTE,
    real: { file: run.realFile, sha256: run.realSha256, firmware: real.firmware, sweep: run.realSweep },
    simulated: { sha256: run.simulatedSha256, firmware: run.firmware, manifestSha256: run.manifestSha256, hz: run.hz, speedup: run.speedup,
      sweep: run.simulatedSweep, heightDuringSweepM: [run.minSweepM, run.maxSweepM], wallS: run.wallS, lockstep: run.lockstep },
    parameters: run.parameters,
    capture: { sha256: run.captureSha256, summary },
    fidelity,
    sweptAxis: axis,
    sweptResponse: responses[axis],
    otherResponses: Object.fromEntries(Object.entries(responses).filter(([id]) => id !== axis)
      .map(([id, r]) => [id, { cost: r.cost, points: r.points, excluded: r.excluded }])),
  };
  const path = join(output, `pavo-systemid-log${n}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${path}: ${axis} J ${report.sweptResponse.cost.toFixed(1)}`);
}
