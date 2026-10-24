// TASK-073 diagnostic (not acceptance evidence): analyzes a vblank-probe.ps1
// capture and, optionally, page rAF timestamps recorded over the same window.
//
//   node scripts/analyze-vblank.mjs PROBE.json --vactive LINES [--raf RAF.json]
//
// --vactive is the display's active line count in its current timing (the
// panel's native lines, not the desktop height; the 2026-10 CSOT panel of the
// RTX 4050 laptop: 1200). Each wake's scan line gives the time since that
// vertical blank started, so the blanks themselves are reconstructed on a
// fitted refresh grid; the report says how late the probe woke after each
// blank. RAF.json ({ timeOrigin, raf: [timestamp ms] }, as written by
// diagnose-pacing.mjs --vblank) is aligned with the probe through the probe's
// QPC / system-time pair (page time = performance.timeOrigin + timestamp), and
// each rAF timestamp is compared with the blank it belongs to: when Chrome's
// frame clock and the probe are late on the same refresh, the delay is in the
// kernel's delivery of the vertical-blank event, not in Chrome.
import { readFileSync } from "node:fs";

const FILETIME_UNIX_EPOCH = 116444736000000000; // 100 ns ticks from 1601 to 1970
const LATE_MS = 1; // a wake or timestamp this long after its blank counts as late

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}
const quantile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : NaN;
};
const fmt = v => (Number.isFinite(v) ? v.toFixed(3) : "n/a");
const spread = values => `p50 ${fmt(quantile(values, 0.5))} p90 ${fmt(quantile(values, 0.9))} p99 ${fmt(quantile(values, 0.99))} max ${fmt(Math.max(...values.filter(Number.isFinite)))}`;

/** Probe wakes on the wall clock, their delay after the blank, and the fitted blank grid. */
function analyzeProbe(probe, vactive) {
  if (probe?.schemaVersion !== 1 || !Array.isArray(probe.wakeQpc) || !Array.isArray(probe.line) || probe.wakeQpc.length < 10) throw new Error("Not a vblank-probe capture");
  const syncWall = (probe.syncFileTime - FILETIME_UNIX_EPOCH) / 1e4;
  const wall = probe.wakeQpc.map(q => syncWall + ((q - probe.syncQpc) * 1000) / probe.qpcFrequency);
  const intervals = wall.slice(1).map((t, i) => t - wall[i]);
  const median = quantile(intervals, 0.5);
  const vtotal = probe.maxScanLine + 1;
  if (!(vactive > 0 && vactive < vtotal)) throw new Error(`--vactive must lie below the vertical total ${vtotal}`);
  const lineMs = median / vtotal;
  // Time since the blank started: lines past vactive (wrapping into the next frame's active area).
  const lateMs = probe.line.map(l => (l < 0 ? NaN : ((((l - vactive) % vtotal) + vtotal) % vtotal) * lineMs));
  const blanks = wall.map((t, i) => t - lateMs[i]).filter(Number.isFinite);
  // Least-squares grid through the reconstructed blank starts. Refresh indices are counted step by step
  // (each gap rounded to whole refreshes), so a small error in the median does not accumulate over a run.
  const t0 = blanks[0];
  let sk = 0, st = 0, skk = 0, skt = 0, k = 0;
  blanks.forEach((b, i) => {
    if (i > 0) k += Math.max(1, Math.round((b - blanks[i - 1]) / median));
    sk += k; st += b - t0; skk += k * k; skt += k * (b - t0);
  });
  const n = blanks.length, period = (n * skt - sk * st) / (n * skk - sk * sk), phase = t0 + (st - period * sk) / n;
  return { wall, intervals, lateMs, period, phase, vtotal };
}

const probePath = process.argv[2];
const vactive = Number(option("vactive"));
if (!probePath || !Number.isFinite(vactive)) {
  console.error("Usage: node scripts/analyze-vblank.mjs PROBE.json --vactive LINES [--raf RAF.json]");
  process.exitCode = 1;
} else {
  const probe = analyzeProbe(JSON.parse(readFileSync(probePath, "utf8")), vactive);
  const { intervals, lateMs, period, phase } = probe;
  const over = intervals.filter(v => v > 1.06 * period).length;
  console.log(`vblank probe: ${probe.wall.length} wakes, fitted refresh ${period.toFixed(4)} ms (${(1000 / period).toFixed(3)} Hz), vertical total ${probe.vtotal} lines`);
  console.log(`  wake after blank (ms): ${spread(lateMs)}; > ${LATE_MS} ms late: ${lateMs.filter(v => v > LATE_MS).length}`);
  console.log(`  wake intervals (ms): ${spread(intervals)}; > 1.06 refreshes: ${over} (${((100 * over) / intervals.length).toFixed(2)}%)`);
  const rafPath = option("raf");
  if (rafPath) {
    const page = JSON.parse(readFileSync(rafPath, "utf8"));
    if (!Number.isFinite(page?.timeOrigin) || !Array.isArray(page?.raf)) throw new Error("RAF.json needs timeOrigin and raf");
    const blankOf = t => phase + Math.round((t - phase) / period) * period;
    const stamps = page.raf.map(ts => page.timeOrigin + ts).filter(t => t > probe.wall[0] && t < probe.wall.at(-1));
    // A stamp belongs to the nearest blank; the page and probe clocks agree to well under a refresh.
    const rafLate = stamps.map(t => t - blankOf(t));
    const probeByBlank = new Map();
    probe.wall.forEach((t, i) => { if (Number.isFinite(lateMs[i])) probeByBlank.set(Math.round((t - lateMs[i] - phase) / period), lateMs[i]); });
    let both = 0, rafOnly = 0, probeOnly = 0, matched = 0;
    stamps.forEach((t, i) => {
      const probeLate = probeByBlank.get(Math.round((blankOf(t) - phase) / period));
      if (probeLate === undefined) return;
      matched++;
      const a = rafLate[i] > LATE_MS, b = probeLate > LATE_MS;
      if (a && b) both++; else if (a) rafOnly++; else if (b) probeOnly++;
    });
    const rafIntervals = page.raf.slice(1).map((t, i) => t - page.raf[i]);
    const overLimit = rafIntervals.filter(v => v > 17.665).length;
    console.log(`page rAF: ${page.raf.length} timestamps, ${stamps.length} inside the probe window`);
    console.log(`  intervals (ms): ${spread(rafIntervals)}; > 17.665 ms: ${overLimit} (${((100 * overLimit) / rafIntervals.length).toFixed(2)}%)`);
    console.log(`  timestamp after blank (ms): p1 ${fmt(quantile(rafLate, 0.01))} ${spread(rafLate)}`);
    console.log(`  refreshes late (> ${LATE_MS} ms) for both: ${both}; rAF only: ${rafOnly}; probe only: ${probeOnly}; of ${matched} matched`);
  }
}
