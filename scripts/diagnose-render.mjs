// TASK-073 diagnostic (not acceptance evidence): attributes late frames to GPU
// work, main-thread work, or presentation pacing. Runs the same production
// build per configuration in fullscreen hardware Chromium and, from an init
// script (no app change), wraps each requestAnimationFrame callback in a
// WebGL2 EXT_disjoint_timer_query_webgl2 TIME_ELAPSED query on the app's
// context, plus the callback's CPU duration and Long Tasks.
//
//   node scripts/diagnose-render.mjs [--warmup 20] [--seconds 120] [--configs demo,terrain,g3] [--position 0,0]
//
// Configurations: demo = plain build (no terrain), default profile;
// terrain = terrain build, default view; g3 = terrain build, ?g3=1 production scene.
// Thresholds are not evaluated here; bench-render.mjs remains the only G3 gate.
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
const warmupS = Number(option("warmup", "20")), durationS = Number(option("seconds", "120"));
const configs = option("configs", "demo,terrain,g3").split(",");
const position = option("position", "0,0"), outDir = option("out", "test-results/render");
if (!Number.isFinite(warmupS) || warmupS < 1 || !Number.isFinite(durationS) || durationS < 1 || durationS > 1800) throw new Error("Invalid --warmup/--seconds");
if (!configs.every(c => ["demo", "terrain", "g3"].includes(c))) throw new Error("Unknown --configs entry");

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = join(root, "node_modules/vite/bin/vite.js");
const tilesDir = join(root, ".cache/render-tiles");
const builds = { plain: join(root, ".cache/render-diag/plain"), terrain: join(root, ".cache/render-diag/terrain") };
const PORT = 5178;
mkdirSync(outDir, { recursive: true });

function run(args, env = {}) { execFileSync(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } }); }

/** Installed before any page script: per-callback GPU timer queries on the app's WebGL2 context. */
function instrument() {
  const contexts = new Map();
  const state = { enabled: false, gl: null, ext: null, active: false, pending: [], records: [], longTasks: [], disjoint: 0, unsupported: null };
  Object.defineProperty(globalThis, "__renderDiag", { value: state });
  const getContext = globalThis.HTMLCanvasElement.prototype.getContext;
  globalThis.HTMLCanvasElement.prototype.getContext = function (type, attributes) {
    const context = getContext.call(this, type, attributes);
    if (type === "webgl2" && context) contexts.set(this, context);
    return context;
  };
  state.bind = () => {
    const canvas = globalThis.document.querySelector("canvas[data-render-backend]");
    const gl = canvas ? contexts.get(canvas) : null;
    if (!gl) { state.unsupported = "app WebGL2 context not found"; return false; }
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (!ext) { state.unsupported = "EXT_disjoint_timer_query_webgl2 unavailable"; return false; }
    state.gl = gl; state.ext = ext;
    return true;
  };
  const poll = () => {
    const gl = state.gl, ext = state.ext;
    if (!gl) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    while (state.pending.length) {
      const p = state.pending[0];
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) break;
      state.pending.shift();
      const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT);
      gl.deleteQuery(p.query);
      if (disjoint) { state.disjoint++; continue; }
      state.records.push({ frameMs: p.frameMs, gpuMs: ns / 1e6, cpuMs: p.cpuMs });
    }
  };
  state.poll = poll;
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = callback => raf(time => {
    if (!state.enabled || state.active || !state.gl) return callback(time);
    const gl = state.gl, query = gl.createQuery();
    state.active = true;
    gl.beginQuery(state.ext.TIME_ELAPSED_EXT, query);
    const start = globalThis.performance.now();
    try { return callback(time); } finally {
      const cpuMs = globalThis.performance.now() - start;
      gl.endQuery(state.ext.TIME_ELAPSED_EXT);
      state.active = false;
      state.pending.push({ query, frameMs: time, cpuMs });
      poll();
    }
  });
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) if (state.enabled) state.longTasks.push({ startMs: e.startTime, durationMs: e.duration }); })
      .observe({ type: "longtask", buffered: false });
  } catch { /* Long Tasks unsupported: recorded as an empty list */ }
}

function stats(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b), q = p => s[Math.max(0, Math.ceil(p * s.length) - 1)];
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.at(-1), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

async function measure(page, url) {
  await page.goto(url);
  await page.getByTestId("worker-status").filter({ hasText: "READY" }).waitFor({ timeout: 30000 });
  await page.locator("canvas[data-render-backend]").waitFor({ timeout: 30000 });
  // The ?g3=1 canvas covers the page, so press the control through the DOM.
  await page.getByRole("button", { name: "Start", exact: true }).evaluate(element => { if (element instanceof globalThis.HTMLButtonElement) element.click(); });
  return page.evaluate(async ({ warmupS, durationS }) => {
    const d = globalThis.__renderDiag;
    await new Promise(r => setTimeout(r, warmupS * 1000));
    if (!d.bind()) return { error: d.unsupported };
    const canvas = globalThis.document.querySelector("canvas[data-render-backend]");
    d.enabled = true;
    const frames = [];
    let hidden = globalThis.document.hidden;
    await new Promise(resolve => {
      let first;
      const frame = t => {
        if (first === undefined) first = t;
        frames.push(t);
        hidden ||= globalThis.document.hidden;
        if (t - first >= durationS * 1000) resolve(); else globalThis.requestAnimationFrame(frame);
      };
      globalThis.requestAnimationFrame(frame);
    });
    d.enabled = false;
    for (let i = 0; i < 20 && d.pending.length; i++) { await new Promise(r => setTimeout(r, 50)); d.poll(); }
    return { frames, records: d.records, longTasks: d.longTasks, disjoint: d.disjoint, unresolved: d.pending.length, hidden,
      g3Probe: canvas && "__mirageG3" in canvas ? JSON.parse(JSON.stringify(canvas.__mirageG3)) : null,
      canvasPx: canvas ? [canvas.width, canvas.height] : null, viewport: [globalThis.innerWidth, globalThis.innerHeight, globalThis.devicePixelRatio] };
  }, { warmupS, durationS });
}

function analyze(raw) {
  // Group per-callback records by frame timestamp (several rAF callbacks may share one frame).
  const byFrame = new Map();
  for (const r of raw.records) {
    const f = byFrame.get(r.frameMs) ?? { gpuMs: 0, cpuMs: 0 };
    f.gpuMs += r.gpuMs; f.cpuMs += r.cpuMs;
    byFrame.set(r.frameMs, f);
  }
  const intervals = [];
  for (let i = 1; i < raw.frames.length; i++) intervals.push({ at: raw.frames[i], prev: raw.frames[i - 1], ms: raw.frames[i] - raw.frames[i - 1] });
  const late = intervals.filter(i => i.ms > 25);
  const work = t => byFrame.get(t) ?? null;
  const longTaskIn = (a, b) => raw.longTasks.some(t => t.startMs < b && t.startMs + t.durationMs > a);
  let gpuBound = 0, cpuBound = 0, longTask = 0, unexplained = 0, noSample = 0;
  for (const i of late) {
    const w = work(i.prev);
    if (!w) { noSample++; continue; }
    const g = w.gpuMs > 16.67, c = w.cpuMs > 16.67, lt = longTaskIn(i.prev, i.at);
    if (g) gpuBound++;
    if (c) cpuBound++;
    if (lt) longTask++;
    if (!g && !c && !lt) unexplained++;
  }
  const lateWork = late.map(i => work(i.prev)).filter(Boolean);
  return {
    intervalMs: stats(intervals.map(i => i.ms)), lateIntervals: late.length,
    gpuMsPerFrame: stats([...byFrame.values()].map(f => f.gpuMs)), cpuMsPerFrame: stats([...byFrame.values()].map(f => f.cpuMs)),
    lateFrameGpuMs: stats(lateWork.map(w => w.gpuMs)), lateFrameCpuMs: stats(lateWork.map(w => w.cpuMs)),
    lateAttribution: { gpuOver16_67: gpuBound, cpuOver16_67: cpuBound, overlappingLongTask: longTask, noneOfThese: unexplained, noGpuSample: noSample },
    longTasks: stats(raw.longTasks.map(t => t.durationMs)), disjointDiscarded: raw.disjoint, unresolvedQueries: raw.unresolved,
  };
}

const result = { schemaVersion: 1, kind: "render-diagnosis", recordedAt: new Date().toISOString(), sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  warmupS, durationS, note: "Diagnostic only; not G3 evidence and no thresholds are evaluated.", configs: {} };
let server, browser;
try {
  if (!existsSync(join(tilesDir, "manifest.json"))) run([join(root, "scripts/generate-render-tileset.mjs"), "--out", tilesDir]);
  for (const [kind, dir] of Object.entries(builds)) {
    rmSync(dir, { recursive: true, force: true });
    run([vite, "build", "apps/web", "--outDir", dir, "--emptyOutDir", "--logLevel", "error"], kind === "terrain"
      ? { VITE_MIRAGE_TILESET_URL: "/render-tiles/tileset.json", VITE_MIRAGE_TILES_ORIGIN: "47.3769,8.5417,400", VITE_MIRAGE_TILES_ATTRIBUTION: "MirageSITL synthetic render stress tiles (CC0-1.0)" } : {});
    if (kind === "terrain") cpSync(tilesDir, join(dir, "render-tiles"), { recursive: true });
  }
  browser = await chromium.launch({ headless: false, executablePath: process.env.CHROMIUM_PATH, args: [`--window-position=${position}`, "--disable-features=Translate", "--lang=en-US", "--no-first-run"] });
  result.browser = browser.version();
  for (const config of configs) {
    const dir = config === "demo" ? builds.plain : builds.terrain;
    server = spawn(process.execPath, [vite, "preview", "apps/web", "--outDir", dir, "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
    let output = "";
    server.stdout.on("data", b => { output += b.toString(); });
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      try { ready = output.includes(`127.0.0.1:${PORT}`) && (await fetch(`http://127.0.0.1:${PORT}`)).ok; } catch { /* bounded startup polling */ }
      if (!ready) await new Promise(r => setTimeout(r, 200));
    }
    if (!ready) throw new Error(`Preview for ${config} did not start`);
    const context = await browser.newContext({ viewport: null });
    await context.addInitScript(instrument);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
    console.log(`${config}: ${warmupS}s warmup, ${durationS}s measurement`);
    const raw = await measure(page, `http://127.0.0.1:${PORT}/?renderer=webgl2${config === "g3" ? "&g3=1&flight=circuit" : ""}`);
    await context.close();
    server.kill(); server = null;
    if (raw.error) { result.configs[config] = { error: raw.error }; console.log(`${config}: ${raw.error}`); continue; }
    const summary = { hidden: raw.hidden, g3Probe: raw.g3Probe, canvasPx: raw.canvasPx, viewport: raw.viewport, ...analyze(raw) };
    result.configs[config] = summary;
    console.log(JSON.stringify({ config, interval: summary.intervalMs, gpu: summary.gpuMsPerFrame, cpu: summary.cpuMsPerFrame, late: summary.lateIntervals, attribution: summary.lateAttribution }));
  }
} finally {
  await browser?.close();
  server?.kill();
  writeFileSync(join(outDir, "diagnosis.json"), JSON.stringify(result, null, 2) + "\n");
}
