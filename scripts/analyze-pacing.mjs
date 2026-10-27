// TASK-073 diagnostic: attributes missed refreshes in a diagnose-pacing.mjs
// trace. A miss is a gap of more than 1.5 refreshes between successive
// DXGI presents on Chrome's GPU main thread. For every miss, and for the same
// number of on-time frames as a control, it reports what happened in the
// preceding frame: the renderer main thread's BeginMainFrame and rAF callback
// time, V8 GC, the GPU main thread's non-present work (WebGL command
// execution), the time spent blocked in Present, and the nvidia-smi clock
// state. Not acceptance evidence.
//
//   node --max-old-space-size=8192 scripts/analyze-pacing.mjs test-results/pacing/pacing-webgl2.json
import { readFileSync } from "node:fs";

const meta = JSON.parse(readFileSync(process.argv[2], "utf8"));
const data = JSON.parse(readFileSync(meta.traceFile, "utf8"));
const events = Array.isArray(data) ? data : data.traceEvents;
const threadName = new Map(), procName = new Map();
for (const e of events) {
  if (e.ph !== "M") continue;
  if (e.name === "thread_name") threadName.set(`${e.pid}:${e.tid}`, e.args.name);
  if (e.name === "process_name") procName.set(e.pid, e.args.name);
}
const on = (e, proc, thread) => procName.get(e.pid) === proc && threadName.get(`${e.pid}:${e.tid}`) === thread;
const complete = events.filter(e => e.ph === "X" && typeof e.dur === "number");

// The page's renderer is the one whose main thread fires animation frames most.
const rafByPid = new Map();
for (const e of complete) if (e.name === "FireAnimationFrame") rafByPid.set(e.pid, (rafByPid.get(e.pid) ?? 0) + 1);
const pagePid = [...rafByPid.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
const isPageMain = e => e.pid === pagePid && threadName.get(`${e.pid}:${e.tid}`) === "CrRendererMain";

const presents = complete.filter(e => e.name === "DXGISwapChainImageBacking::Present" && on(e, "GPU Process", "CrGpuMain")).sort((a, b) => a.ts - b.ts);
const gpuMainTop = complete.filter(e => on(e, "GPU Process", "CrGpuMain") && e.name === "ThreadControllerImpl::RunTask").sort((a, b) => a.ts - b.ts);
const beginMain = complete.filter(e => isPageMain(e) && e.name === "ProxyMain::BeginMainFrame").sort((a, b) => a.ts - b.ts);
const rafCalls = complete.filter(e => isPageMain(e) && e.name === "FireAnimationFrame");
const gc = complete.filter(e => e.pid === pagePid && /^(MinorGC|MajorGC|V8\.GC_(SCAVENGER|MARK_COMPACTOR|MC_)|V8\.GCScavenger|V8\.GCCompactor|BlinkGC)/.test(e.name));
const presentEnds = presents.map(p => p.ts + p.dur);
const intervals = [];
for (let i = 1; i < presents.length; i++) intervals.push((presentEnds[i] - presentEnds[i - 1]) / 1000);
const sorted = intervals.slice().sort((a, b) => a - b);
const refresh = sorted[Math.floor(sorted.length / 2)];

const sumIn = (list, from, to, pick = () => true) => {
  let total = 0;
  for (const e of list) {
    if (!pick(e)) continue;
    const a = Math.max(from, e.ts), b = Math.min(to, e.ts + e.dur);
    if (b > a) total += b - a;
  }
  return total / 1000;
};
// Host QPC alignment: trace timestamps are microseconds on the same monotonic clock family as
// performance.now(); map clock samples by their offset within the window instead.
const windowUs = presentEnds.length ? presentEnds[presentEnds.length - 1] - presentEnds[0] : 0;
const clockAt = fraction => {
  const s = meta.clocks.filter(c => c.qpcMs >= meta.windowStartQpc && c.qpcMs <= meta.windowEndQpc);
  if (s.length === 0) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.round(fraction * (s.length - 1))))];
};

function describe(i) {
  // Frame i ends at presentEnds[i]; its work happened between the previous present's end and this present's start.
  const from = presentEnds[i - 1], start = presents[i].ts;
  const prevStart = presents[i - 1].ts;
  const bmf = beginMain.filter(e => e.ts >= from - refresh * 2000 && e.ts < start);
  const clock = clockAt((presentEnds[i] - presentEnds[0]) / Math.max(1, windowUs));
  return {
    intervalMs: intervals[i - 1],
    presentBlockedMs: presents[i].dur / 1000,
    prevPresentBlockedMs: presents[i - 1].dur / 1000,
    gpuMainWorkMs: sumIn(gpuMainTop, from, start) ,
    gpuMainWorkPrevMs: sumIn(gpuMainTop, presentEnds[i - 2] ?? prevStart, prevStart),
    beginMainFrameMs: bmf.length ? Math.max(...bmf.map(e => e.dur / 1000)) : 0,
    rafMs: sumIn(rafCalls, from - refresh * 1000, start),
    gcMs: sumIn(gc, from - refresh * 1000, start),
    pstate: clock?.pstate ?? "?", clockMHz: clock?.clockMHz ?? NaN, util: clock?.utilizationPct ?? NaN,
  };
}

const misses = [], ontime = [];
for (let i = 2; i < presents.length; i++) (intervals[i - 1] > refresh * 1.5 ? misses : ontime).push(i);
const step = Math.max(1, Math.floor(ontime.length / Math.max(1, misses.length)));
const control = ontime.filter((_, k) => k % step === 0).slice(0, misses.length);
const stats = (rows, key) => {
  const v = rows.map(r => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return "-";
  const q = p => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return `p50 ${q(0.5).toFixed(2)} p90 ${q(0.9).toFixed(2)} max ${v[v.length - 1].toFixed(2)}`;
};
const missRows = misses.map(describe), ctlRows = control.map(describe);
console.log(`backend ${meta.backend}; presents ${presents.length}; refresh ${refresh.toFixed(3)} ms; misses ${misses.length} (${(100 * misses.length / Math.max(1, intervals.length)).toFixed(2)}%)`);
console.log(`page renderer pid ${pagePid}; GC events in page ${gc.length}; rAF intervals in page ${meta.raf.length}`);
for (const key of ["intervalMs", "presentBlockedMs", "prevPresentBlockedMs", "gpuMainWorkMs", "gpuMainWorkPrevMs", "beginMainFrameMs", "rafMs", "gcMs", "clockMHz", "util"]) {
  console.log(`${key.padEnd(22)} misses: ${stats(missRows, key).padEnd(40)} on-time: ${stats(ctlRows, key)}`);
}
const pst = rows => rows.reduce((m, r) => (m[r.pstate] = (m[r.pstate] ?? 0) + 1, m), {});
console.log("pstate at misses", JSON.stringify(pst(missRows)), "on-time", JSON.stringify(pst(ctlRows)));
console.log("first misses:", JSON.stringify(missRows.slice(0, 6).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? Number(v.toFixed(2)) : v])))));
