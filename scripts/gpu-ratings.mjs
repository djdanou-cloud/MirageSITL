// TASK-073 device ratings registry and gate decision (user decision 2026-10-23).
//
//   node scripts/gpu-ratings.mjs add RUN_RECORD.json   append a harness run record
//   node scripts/gpu-ratings.mjs decide                TASK-073 (G3 gpu-report) verdict from the registry
//   node scripts/gpu-ratings.mjs table                 Markdown rows for docs/DEVICE_RATINGS.md
//
// Every machine + screen + GPU combination is rated; only gate-eligible runs
// (integrated GPU, 1920 x 1080 canvas at 1x, 60 FPS) decide. Among all tested
// integrated GPUs, the least performant one (lowest mean rating over its
// gate-eligible WebGL2 and WebGPU runs; ties go to the worse p99) is the gate
// device, and TASK-073 passes only when both of its backends PASS. An
// integrated GPU without gate-eligible runs on both backends leaves the
// decision BLOCKED_EXTERNAL, because the least performant one is then unknown.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ratingBand } from "./gpu-trace.mjs";
import { report } from "./validation/evidence.mjs";

export const REGISTRY_PATH = fileURLToPath(new URL("../docs/benchmarks/device-results.json", import.meta.url));
const BACKENDS = ["webgl2", "webgpu"];

/** Physical screen description from the page's screen size and DPR. */
export function screenLabel(screen, refreshHz) {
  const w = Math.round(screen.screenWidth * screen.dpr), h = Math.round(screen.screenHeight * screen.dpr);
  return `${w} x ${h} @ ${refreshHz.toFixed(2)} Hz, ${screen.dpr}x scale`;
}

/** The registry entry for one harness run (summary only; the trace stays beside the run). */
export function buildRunRecord({ trace, result, labels, screen, terrain, view, traceSha256, recordedAt }) {
  const m = result.metrics ?? {};
  return {
    schemaVersion: 1, source: "harness", recordedAt,
    machine: { label: labels.machine || trace.hostModel, hostModel: trace.hostModel, os: trace.os },
    screen: { label: labels.screen || screenLabel(screen, trace.refreshHz), refreshHz: trace.refreshHz,
      widthPx: Math.round(screen.screenWidth * screen.dpr), heightPx: Math.round(screen.screenHeight * screen.dpr), scale: screen.dpr },
    gpu: { renderer: trace.gpu, kind: m.gpuKind ?? "unknown" },
    browser: trace.browser, powerMode: trace.powerMode, terrain, view, backend: trace.backend, fps: trace.fps,
    canvas: { width: trace.width, height: trace.height, dpr: trace.dpr, displayScale: trace.scale },
    status: result.status, reasons: result.reasons,
    metrics: m.p50FrameMs === undefined ? null : {
      frames: m.frames, measuredS: m.measuredS, p50FrameMs: m.p50FrameMs, p99FrameMs: m.p99FrameMs, maxFrameMs: m.maxFrameMs,
      missedRefreshes: m.missedRefreshes, featuresHeld: m.featuresHeld, airborne: m.airborne, gpuBytes: m.gpuBytes, cpuBytes: m.cpuBytes,
    },
    rating: m.rating ?? null, traceSha256,
  };
}

function validRecord(r) {
  return r !== null && typeof r === "object" && r.schemaVersion === 1 && ["harness", "historical"].includes(r.source) &&
    typeof r.machine?.label === "string" && typeof r.screen?.label === "string" && typeof r.gpu?.renderer === "string" &&
    ["integrated", "discrete", "unknown"].includes(r.gpu?.kind) && BACKENDS.includes(r.backend) && [60, 120].includes(r.fps) &&
    ["PASS", "FAIL", "INFO", "BLOCKED_EXTERNAL"].includes(r.status);
}

export function loadRegistry(path = REGISTRY_PATH) {
  const registry = JSON.parse(readFileSync(path, "utf8"));
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.runs) || !registry.runs.every(validRecord)) throw new Error("Invalid device results registry");
  return registry;
}

export function addRun(registry, record) {
  if (!validRecord(record) || record.source !== "harness") throw new Error("Not a harness run record");
  if (registry.runs.some(r => r.traceSha256 && r.traceSha256 === record.traceSha256)) throw new Error("Run already recorded");
  return { ...registry, runs: [...registry.runs, record] };
}

const gpuKey = r => `${r.machine.label} | ${r.gpu.renderer}`;

/** TASK-073 verdict: the least performant tested integrated GPU must PASS on both backends. */
export function decideTask073(runs) {
  const integrated = new Map();
  for (const r of runs) if (r.gpu.kind === "integrated") {
    if (!integrated.has(gpuKey(r))) integrated.set(gpuKey(r), []);
    integrated.get(gpuKey(r)).push(r);
  }
  if (integrated.size === 0) return report("gpu-report", "BLOCKED_EXTERNAL", ["No integrated GPU has been tested"]);
  const devices = [], missing = [];
  for (const [key, list] of integrated) {
    const latest = {};
    for (const backend of BACKENDS) {
      const eligible = list.filter(r => r.source === "harness" && r.backend === backend && (r.status === "PASS" || r.status === "FAIL"));
      eligible.sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
      latest[backend] = eligible.at(-1);
    }
    const absent = BACKENDS.filter(b => !latest[b]);
    if (absent.length) { missing.push(`${key}: no gate-eligible ${absent.join(" or ")} run (1920 x 1080 canvas at 1x, 60 FPS)`); continue; }
    const pair = BACKENDS.map(b => latest[b]);
    devices.push({ key, pair, meanRating: pair.reduce((s, r) => s + r.rating.score, 0) / pair.length,
      worstP99Ms: Math.max(...pair.map(r => r.metrics.p99FrameMs)) });
  }
  if (missing.length) return report("gpu-report", "BLOCKED_EXTERNAL", ["The least performant integrated GPU is unknown until every tested integrated GPU has gate-eligible runs", ...missing],
    { integratedGpus: [...integrated.keys()] });
  devices.sort((a, b) => a.meanRating - b.meanRating || b.worstP99Ms - a.worstP99Ms);
  const gate = devices[0];
  const failed = gate.pair.filter(r => r.status !== "PASS");
  return report("gpu-report", failed.length ? "FAIL" : "PASS", failed.map(r => `${gate.key} ${r.backend}: ${r.reasons.join("; ")}`), {
    gateDevice: gate.key, meanRating: gate.meanRating,
    runs: gate.pair.map(r => ({ backend: r.backend, status: r.status, rating: r.rating.score, p50FrameMs: r.metrics.p50FrameMs, p99FrameMs: r.metrics.p99FrameMs })),
    ranking: devices.map(d => ({ gpu: d.key, meanRating: d.meanRating, worstP99Ms: d.worstP99Ms })),
  });
}

const fmt = (x, digits = 3) => (typeof x === "number" ? x.toFixed(digits) : "n/a");
function ratingCell(r) {
  if (!r.rating) return "not rated";
  const p = r.rating.provisional;
  return p ? `${r.rating.score}-${p.upperBound} (provisional: ${p.unknown.join(", ")} not recorded)` : `${r.rating.score} (${r.rating.band})`;
}

const comboKey = r => `${r.machine.label} | ${r.screen.label} | ${r.gpu.renderer}`;

/**
 * One rating per machine + screen + GPU: the mean of the latest rated 60 FPS
 * WebGL2 and WebGPU runs (or the one that exists); 120 FPS is reported apart.
 * A provisional run makes the combo provisional, with the mean of upper bounds.
 */
export function comboRatings(runs) {
  const combos = new Map();
  for (const r of runs) {
    if (!r.rating) continue;
    if (!combos.has(comboKey(r))) combos.set(comboKey(r), { machine: r.machine.label, screen: r.screen.label, gpu: `${r.gpu.renderer} (${r.gpu.kind})`, terrain: new Set(), latest: {} });
    const c = combos.get(comboKey(r));
    c.terrain.add(r.terrain);
    const slot = `${r.backend}-${r.fps}`;
    if (!c.latest[slot] || String(c.latest[slot].recordedAt) < String(r.recordedAt)) c.latest[slot] = r;
  }
  const summarize = list => {
    if (!list.length) return null;
    const mean = xs => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    const score = mean(list.map(r => r.rating.score));
    const provisional = list.some(r => r.rating.provisional);
    return { score, upperBound: provisional ? mean(list.map(r => r.rating.provisional?.upperBound ?? r.rating.score)) : score, provisional };
  };
  return [...combos.values()].map(c => ({
    machine: c.machine, screen: c.screen, gpu: c.gpu, terrain: [...c.terrain].join(", "),
    rating60: summarize(BACKENDS.map(b => c.latest[`${b}-60`]).filter(Boolean)),
    rating120: summarize(BACKENDS.map(b => c.latest[`${b}-120`]).filter(Boolean)),
  }));
}

const comboCell = r => (!r ? "not run" : r.provisional ? `${r.score}-${r.upperBound} (provisional)` : `${r.score} (${ratingBand(r.score)})`);

/** Markdown summary, one row per machine + screen + GPU. */
export function markdownCombos(runs) {
  const rows = ["| Machine | Screen | GPU (class) | Terrain | Rating, 60 FPS | Rating, 120 FPS |", "| --- | --- | --- | --- | --- | --- |"];
  for (const c of comboRatings(runs)) rows.push(`| ${c.machine} | ${c.screen} | ${c.gpu} | ${c.terrain} | ${comboCell(c.rating60)} | ${comboCell(c.rating120)} |`);
  return rows.join("\n");
}

/** Markdown rows, one per run: combo, profile, timing, status and rating. */
export function markdownRows(runs) {
  const rows = ["| Machine | Screen | GPU (class) | Backend / profile | Canvas | Terrain | Median / p99 ms | Missed | Gate | Rating |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const r of runs) {
    const m = r.metrics;
    rows.push(`| ${r.machine.label} | ${r.screen.label} | ${r.gpu.renderer} (${r.gpu.kind}) | ${r.backend} ${r.fps} FPS | ${r.canvas.width} x ${r.canvas.height} at ${r.canvas.dpr}x | ${r.terrain} | ` +
      `${m ? `${fmt(m.p50FrameMs)} / ${fmt(m.p99FrameMs)}` : "n/a"} | ${m && typeof m.missedRefreshes === "number" ? m.missedRefreshes : "n/a"} | ${r.status} | ${ratingCell(r)} |`);
  }
  return rows.join("\n");
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  const [command, input] = process.argv.slice(2);
  try {
    if (command === "add" && input) {
      const registry = addRun(loadRegistry(), JSON.parse(readFileSync(input, "utf8")));
      writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
      console.log(`Recorded run ${registry.runs.length} in docs/benchmarks/device-results.json; update docs/DEVICE_RATINGS.md and its Russian mirror.`);
    } else if (command === "decide") {
      const result = decideTask073(loadRegistry().runs);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
    } else if (command === "table") {
      const { runs } = loadRegistry();
      console.log(`${markdownCombos(runs)}\n\n${markdownRows(runs)}`);
    } else {
      console.error("Expected: add RUN_RECORD.json | decide | table");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
