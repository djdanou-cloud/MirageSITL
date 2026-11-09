// TASK-104: the stakeholder's Pavo20 Pro II discharges (BAT.Volt and BAT.Curr) beside the battery v2 pack driven by the logged
// current (SPECS_SIMULATION_ENGINES "Battery v2", "Comparison with measured discharges"). Shown, not judged (SA-01): no limit
// applies. The logs are kept outside the repository; each one used is named by its SHA-256.
//
//   node scripts/check-battery-logs.mjs --dir DIRECTORY [--out DIR]
//
// Writes battery-logs.json to test-results/validation/ (or --out). Exit 0 REPORTED, 1 when the model's mirror below disagrees with
// the production WASM bus or a log cannot be read, 2 (BLOCKED_EXTERNAL) without the directory.
//
// The pack's equations are mirrored here, in plain arithmetic, so that the fit can run millions of held-current steps; before
// anything else the mirror is checked against the production WASM bus (`@mirage/wasm-bet/bus`, shared bus records v2) on a
// varying synthetic load, where the bus's own solved current is fed back: they must agree within 1e-9 V on every step.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TRANSFORM = "--experimental-transform-types";
if (!process.execArgv.includes(TRANSFORM)) {
  const child = spawnSync(process.execPath, [TRANSFORM, "--no-warnings", "--max-old-space-size=8192", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}
const { readDataFlash } = await import("../packages/dataflash/src/reader.ts");
const { openCircuitTableV } = await import("../packages/physics/src/battery-curves.ts");
const { BetBus } = await import("../packages/wasm-bet/src/bus.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dir = option("--dir"), out = option("--out") ?? join(ROOT, "test-results/validation");
if (!dir || !existsSync(dir)) { console.error("BLOCKED_EXTERNAL: --dir with the stakeholder's logs is required"); process.exit(2); }

// The Pavo card (tests/fixtures/components/pavo-battery-3s-850.json).
const card = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/components/pavo-battery-3s-850.json"), "utf8")).values;
const CELLS = card.cellsSeries, CAPACITY_C = card.capacityAh * 3600, CARD_R0 = card.internalResistanceOhm;
const TABLES = { linear: openCircuitTableV("linear", CELLS, card.cellEmptyV, card.cellFullV), "chen-2006": openCircuitTableV("chen-2006", CELLS, card.cellEmptyV, card.cellFullV) };
const FIT_LOG = "stakeholder-pavo-log_34_UnknownDate.bin";
const MIN_CELL_V = 3.0, MIN_CURRENT_A = 0.5, SUBSTEP_S = 1 / 400;

const openCircuit = (table, s) => {
  const x = Math.min(Math.max(s, 0), 1) * 20, i = Math.min(Math.floor(x), 19);
  return table[i] + (table[i + 1] - table[i]) * (x - i);
};
const chargeAt = (table, voltage) => {
  if (voltage >= table[20]) return 1;
  if (voltage <= table[0]) return 0;
  let low = 0, high = 1;
  for (let k = 0; k < 80; k++) { const mid = 0.5 * (low + high); if (openCircuit(table, mid) < voltage) low = mid; else high = mid; }
  return 0.5 * (low + high);
};
/** One held-current step of the pack at the reference temperature (no heat in this comparison: the logs hold no temperature). */
function step(model, state, current, dt) {
  let u = openCircuit(model.table, state.soc), r = model.r0;
  const decay = [1, 1];
  for (let k = 0; k < model.branches.length; k++) {
    const { r: rk, c: ck } = model.branches[k], a = Math.exp(-dt / (rk * ck));
    decay[k] = a; u -= a * state.v[k]; r += (1 - a) * rk;
  }
  const voltage = u - current * r;
  for (let k = 0; k < model.branches.length; k++) state.v[k] = decay[k] * state.v[k] + (1 - decay[k]) * model.branches[k].r * current;
  state.soc = Math.min(1, Math.max(0, state.soc - current * dt / CAPACITY_C));
  return voltage;
}

// The mirror against the production bus: a varying power demand; the bus solves its current, which the mirror is then given.
let mirrorCheck;
{
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { cwd: ROOT, stdio: "pipe" });
  const module = new WebAssembly.Module(readFileSync(join(ROOT, "packages/wasm-bet/dist/mirage_bet.scalar.wasm")));
  const model = { table: TABLES["chen-2006"], r0: 0.08, branches: [{ r: 0.03, c: 800 }, { r: 0.05, c: 6000 }] };
  const bus = new BetBus(module, { openCircuitFullV: model.table[20], openCircuitEmptyV: model.table[0], internalResistanceOhm: model.r0,
    capacityAh: card.capacityAh, currentLimitA: 200, dynamics: { openCircuitTableV: model.table, branches: model.branches.map(b => ({ resistanceOhm: b.r, capacitanceF: b.c })),
      activationK: 0, referenceK: 298.15, heatCapacityJPerK: 0, stillAirConductanceWPerK: 0, airflowConductanceWPerK: 0, entropicVPerK: 0, capacityRetention: 1, resistanceGrowth: 1 } }, 400);
  const state = { soc: 0.95, v: [0, 0] }, x = bus.input;
  x[0] = state.soc; x[3] = 0; x[4] = 0; x[5] = 298.15; x[6] = 298.15; x[7] = 0;
  let worst = 0;
  for (let n = 0; n < 40000; n++) {
    x[1] = 40 + 60 * (n % 1600 < 800 ? 1 : 0) + 10 * Math.sin(n / 37);
    if (!bus.stepFromInput()) { console.error(`The WASM bus refused step ${n}: ${bus.lastStatus}`); process.exit(1); }
    const mirrored = step(model, state, bus.output[2], 1 / 400);
    worst = Math.max(worst, Math.abs(mirrored - bus.output[1]));
    x[0] = bus.output[0]; x[3] = bus.output[7]; x[4] = bus.output[8]; x[5] = bus.output[9];
  }
  if (!(worst < 1e-9)) { console.error(`The mirror differs from the WASM bus by ${worst} V`); process.exit(1); }
  mirrorCheck = { steps: 40000, worstDifferenceV: worst };
}

/** A log's flight: held current and logged voltage from the first sample above 0.5 A to the last. */
function flightOf(file) {
  const bytes = readFileSync(join(dir, file)), log = readDataFlash(new Uint8Array(bytes));
  const bat = log.groups.find(g => g.name === "BAT");
  if (!bat) return null;
  const col = name => bat.columns.find(c => c.name === name);
  const value = (c, i) => Number(c.values[i * c.width]) * c.valueScale;
  const volt = col("Volt"), curr = col("Curr"), inst = col("Inst") ?? col("Instance");
  const rows = [];
  for (let i = 0; i < bat.count; i++) {
    if (inst && Number(inst.values[i * inst.width]) !== 0) continue;
    rows.push({ t: bat.timestampsS[i], v: value(volt, i), i: value(curr, i) });
  }
  const first = rows.findIndex(r => r.i > MIN_CURRENT_A);
  let last = -1;
  for (let k = rows.length - 1; k >= 0; k--) if (rows[k].i > MIN_CURRENT_A) { last = k; break; }
  if (first < 0 || last <= first) return { file, sha256: createHash("sha256").update(bytes).digest("hex"), rows: [] };
  let step = Infinity;
  const used = rows.slice(first, last + 1);
  for (let k = 1; k < used.length; k++) { const d = Math.abs(used[k].v - used[k - 1].v); if (d > 0) step = Math.min(step, d); }
  return { file, sha256: createHash("sha256").update(bytes).digest("hex"), rows: used, voltageStepV: step };
}

/** The model's voltage at every sample after the first, against the logged one; samples below 3.0 V per cell are left out. */
function compare(flight, model) {
  const rows = flight.rows;
  const state = { soc: chargeAt(model.table, rows[0].v + rows[0].i * model.r0), v: model.branches.map(() => 0) };
  let sum = 0, n = 0, excluded = 0, worst = 0;
  for (let k = 1; k < rows.length; k++) {
    const span = rows[k].t - rows[k - 1].t, count = Math.max(1, Math.ceil(span / SUBSTEP_S - 1e-9)), dt = span / count;
    let voltage = 0;
    for (let j = 0; j < count; j++) voltage = step(model, state, rows[k - 1].i, dt);
    if (rows[k].v < MIN_CELL_V * CELLS) { excluded++; continue; }
    const e = voltage - rows[k].v;
    sum += e * e; n++; worst = Math.max(worst, Math.abs(e));
  }
  return { samples: n, excluded, rmsV: Math.sqrt(sum / Math.max(1, n)), largestV: worst, startCharge: chargeAt(model.table, rows[0].v + rows[0].i * model.r0) };
}

const modelOf = (curve, [r0, r1, t1, r2, t2]) => ({ table: TABLES[curve], r0, branches: [{ r: r1, c: t1 / r1 }, { r: r2, c: t2 / r2 }] });
/** Nelder–Mead on the logarithms of R0, R1, τ1, R2, τ2, from the declared start, minimising the RMS error on the fit log alone. */
function fit(curve, flight) {
  const cost = x => compare(flight, modelOf(curve, x.map(Math.exp))).rmsV;
  const start = [0.0771, 0.02, 10, 0.02, 100].map(Math.log);
  let simplex = [start, ...start.map((_, d) => start.map((v, k) => (k === d ? v + 0.5 : v)))].map(x => ({ x, f: cost(x) }));
  let iterations = 0;
  for (; iterations < 2000; iterations++) {
    simplex.sort((a, b) => a.f - b.f);
    if (simplex[simplex.length - 1].f - simplex[0].f < 1e-7) break;
    const n = start.length, centroid = start.map((_, d) => simplex.slice(0, n).reduce((s, p) => s + p.x[d], 0) / n);
    const worst = simplex[n], along = (t) => centroid.map((c, d) => c + t * (worst.x[d] - c));
    const reflected = { x: along(-1) }; reflected.f = cost(reflected.x);
    if (reflected.f < simplex[0].f) {
      const expanded = { x: along(-2) }; expanded.f = cost(expanded.x);
      simplex[n] = expanded.f < reflected.f ? expanded : reflected;
    } else if (reflected.f < simplex[n - 1].f) simplex[n] = reflected;
    else {
      const contracted = { x: along(0.5) }; contracted.f = cost(contracted.x);
      if (contracted.f < worst.f) simplex[n] = contracted;
      else simplex = simplex.map((p, k) => (k === 0 ? p : { x: p.x.map((v, d) => simplex[0].x[d] + 0.5 * (v - simplex[0].x[d])) })).map(p => ({ x: p.x, f: p.f ?? cost(p.x) }));
    }
  }
  simplex.sort((a, b) => a.f - b.f);
  const [r0, r1, t1, r2, t2] = simplex[0].x.map(Math.exp);
  return { values: { r0Ohm: r0, r1Ohm: r1, tau1S: t1, r2Ohm: r2, tau2S: t2, c1F: t1 / r1, c2F: t2 / r2 }, fitRmsV: simplex[0].f, iterations };
}

const files = readdirSync(dir).filter(f => /^stakeholder-pavo-log_\d+_UnknownDate\.bin$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
if (!files.includes(FIT_LOG)) { console.error(`BLOCKED_EXTERNAL: ${FIT_LOG} is not in ${dir}`); process.exit(2); }
const flights = files.map(flightOf);
const fitFlight = flights.find(f => f.file === FIT_LOG);
const fittedLinear = fit("linear", fitFlight), fittedChen = fit("chen-2006", fitFlight);
const paper = { table: TABLES["chen-2006"], r0: CELLS * 0.07446, branches: [{ r: CELLS * 0.04669, c: 703.6 / CELLS }, { r: CELLS * 0.04984, c: 4475 / CELLS }] };
const v = fittedLinear.values, w = fittedChen.values;
const models = {
  A: { label: "TASK-092: linear curve, the card's 0.0771 ohm", model: { table: TABLES.linear, r0: CARD_R0, branches: [] } },
  B: { label: "linear curve, R0 R1 tau1 R2 tau2 fitted on log 34", model: modelOf("linear", [v.r0Ohm, v.r1Ohm, v.tau1S, v.r2Ohm, v.tau2S]) },
  C: { label: "chen-2006 curve, R0 R1 tau1 R2 tau2 fitted on log 34", model: modelOf("chen-2006", [w.r0Ohm, w.r1Ohm, w.tau1S, w.r2Ohm, w.tau2S]) },
  D: { label: "chen-2006 curve, the paper's own cell (eq. 3 to 7 at s >= 0.2), three in series", model: paper },
};
const logs = flights.map(f => ({
  file: f.file, sha256: f.sha256, fitted: f.file === FIT_LOG, samplesInFlight: f.rows.length,
  durationS: f.rows.length > 1 ? f.rows[f.rows.length - 1].t - f.rows[0].t : 0, voltageStepV: f.voltageStepV ?? null,
  models: f.rows.length > 1 ? Object.fromEntries(Object.entries(models).map(([key, m]) => [key, compare(f, m.model)])) : null,
}));
const report = {
  schema: "mirage-battery-logs/1", task: "TASK-104", status: "REPORTED", judged: false,
  declared: "SPECS_SIMULATION_ENGINES, Battery v2, Comparison with measured discharges (2026-11-09)",
  card: "tests/fixtures/components/pavo-battery-3s-850.json", cells: CELLS, capacityAh: card.capacityAh, cellWindowV: [card.cellEmptyV, card.cellFullV],
  mirrorCheck, fitLog: FIT_LOG, fits: { B: fittedLinear, C: fittedChen }, models: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, m.label])),
  method: { minimumCurrentA: MIN_CURRENT_A, minimumCellV: MIN_CELL_V, substepS: SUBSTEP_S, heat: "not compared: the logs hold no temperature" },
  logs,
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "battery-logs.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const l of logs) if (l.models) console.log(`${l.file.replace("stakeholder-pavo-", "").padEnd(24)} ${l.durationS.toFixed(0).padStart(4)} s  ` +
  Object.entries(l.models).map(([k, m]) => `${k} ${(m.rmsV * 1000).toFixed(0)}/${(m.largestV * 1000).toFixed(0)} mV`).join("  ") + (l.fitted ? "  (fit)" : ""));
console.log(`fits: B ${JSON.stringify(fittedLinear.values)} rms ${fittedLinear.fitRmsV}; C ${JSON.stringify(fittedChen.values)} rms ${fittedChen.fitRmsV}`);
