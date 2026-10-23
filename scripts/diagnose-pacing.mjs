// TASK-073 diagnostic (not acceptance evidence): per-frame attribution of late
// G3 frames. Runs the current production build (geodata) fullscreen like
// check-gpu-perf.mjs, flies the scripted circuit, and over one window records
// a Chrome trace (frame pipeline reports, renderer main thread, V8 GC, GPU
// process), PresentMon (per-present display times) and nvidia-smi clocks at
// 10 Hz. analyze-pacing.mjs turns the output folder into a per-frame report.
//
//   node scripts/diagnose-pacing.mjs --geodata DIR [--backend webgl2|webgpu] [--warmup 30] [--seconds 45] [--position 0,0] [--out test-results/pacing]
//        [--chrome-args "--flag1 --flag2"]   (extra browser switches for presentation experiments)
//
// Uses the existing apps/web/dist (build it with check-gpu-perf.mjs or vite and the geodata settings first).
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { isNvidiaRenderer, nowQpcMs, presentMonCapture } from "./capture-samplers.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
const geodata = option("geodata", null), backend = option("backend", "webgl2");
const warmupS = Number(option("warmup", "30")), seconds = Number(option("seconds", "45"));
const position = option("position", "0,0"), out = resolvePath(option("out", "test-results/pacing"));
const chromeArgs = (option("chrome-args", "") ?? "").split(/\s+/).filter(Boolean);
if (!geodata || !["webgl2", "webgpu"].includes(backend) || !(warmupS >= 5) || !(seconds >= 5 && seconds <= 300)) {
  throw new Error("Expected --geodata DIR [--backend webgl2|webgpu] [--warmup >=5] [--seconds 5-300]");
}
mkdirSync(out, { recursive: true });
const root = fileURLToPath(new URL("..", import.meta.url));
const PORT = 5179;
const server = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "preview", "apps/web", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  { cwd: root, env: { ...process.env, MIRAGE_GEODATA_DIR: resolvePath(geodata), NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
await new Promise(r => setTimeout(r, 4000));

/** nvidia-smi at 10 Hz with host QPC timestamps (ms) for alignment with PresentMon. */
function fastClocks() {
  const samples = [];
  const child = spawn("nvidia-smi", ["--query-gpu=pstate,clocks.gr,utilization.gpu,power.draw,clocks_event_reasons.active", "--format=csv,noheader,nounits", "-lms", "100"], { windowsHide: true });
  let buffer = "";
  child.stdout.on("data", bytes => {
    buffer += bytes.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    const at = nowQpcMs();
    for (const line of lines) {
      const [pstate, clockMHz, utilizationPct, powerW, reasons] = line.split(",").map(v => v.trim());
      if (pstate) samples.push({ qpcMs: at, pstate, clockMHz: Number(clockMHz), utilizationPct: Number(utilizationPct), powerW: Number(powerW), reasons });
    }
  });
  child.on("error", () => undefined);
  return { samples, stop: () => child.kill() };
}

const browser = await chromium.launch({ headless: false, executablePath: process.env.CHROMIUM_PATH,
  args: [`--window-position=${position}`, "--disable-features=Translate", "--lang=en-US", "--no-first-run", ...chromeArgs] });
try {
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  const pageCdp = await context.newCDPSession(page);
  const { windowId } = await pageCdp.send("Browser.getWindowForTarget");
  await pageCdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
  await new Promise(r => setTimeout(r, 1000));
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?renderer=${backend}&g3=1&view=chase&flight=circuit`);
  await page.getByTestId("worker-status").filter({ hasText: "READY" }).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => {
    const p = globalThis.document.querySelector("canvas")?.__mirageG3;
    return p && p.terrain && p.fpv && p.thermal;
  }, null, { timeout: 60000 });
  const browserCdp = await browser.newBrowserCDPSession();
  const gpuProcess = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo.find(info => info.type === "GPU");
  // PresentMon and the clocks start before the flight (opening the ETW session can stall the page).
  const presentCsv = join(out, `presentmon-${backend}.csv`);
  const presentMon = gpuProcess ? presentMonCapture(gpuProcess.id, presentCsv, warmupS + seconds + 15) : Promise.resolve({ available: false, reason: "no GPU process" });
  // nvidia-smi only for an NVIDIA GPU: its queries delay an integrated-GPU display's vertical blank.
  const renderer = await page.evaluate(() => {
    const gl = globalThis.document.createElement("canvas").getContext("webgl2", { powerPreference: "high-performance" });
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    const name = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  });
  const clocks = isNvidiaRenderer(renderer) ? { ...fastClocks(), available: true, reason: "" }
    : { samples: [], stop() {}, available: false, reason: `Not sampled: the measured GPU is not NVIDIA (${renderer || "unknown"})` };
  await new Promise(r => setTimeout(r, 3000));
  await page.bringToFront();
  await page.getByRole("button", { name: "Start", exact: true }).evaluate(element => { element.click(); });
  await new Promise(r => setTimeout(r, warmupS * 1000));
  // Page rAF timestamps for the window, with the page's time origin in host QPC for alignment.
  await page.evaluate(() => {
    const store = { t: [] };
    Reflect.set(globalThis, "__pacing", store);
    const tick = ts => { store.t.push(ts); if (!store.stop) globalThis.requestAnimationFrame(tick); };
    globalThis.requestAnimationFrame(tick);
  });
  const traceFile = join(out, `trace-${backend}.json`);
  const categories = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "v8.gc", "blink.user_timing",
    "toplevel", "benchmark", "viz", "gpu", "cc", "latencyInfo"].join(",");
  const done = new Promise(resolve => browserCdp.once("Tracing.tracingComplete", resolve));
  const windowStartQpc = nowQpcMs();
  await browserCdp.send("Tracing.start", { traceConfig: { includedCategories: categories.split(","), recordMode: "recordContinuously" }, transferMode: "ReturnAsStream" });
  await new Promise(r => setTimeout(r, seconds * 1000));
  await browserCdp.send("Tracing.end");
  const windowEndQpc = nowQpcMs();
  const { stream } = await done;
  const file = createWriteStream(traceFile);
  for (;;) {
    const chunk = await browserCdp.send("IO.read", { handle: stream, size: 8 * 1024 * 1024 });
    file.write(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
    if (chunk.eof) break;
  }
  await new Promise(r => file.end(r));
  await browserCdp.send("IO.close", { handle: stream });
  const raf = await page.evaluate(() => { const s = Reflect.get(globalThis, "__pacing"); s.stop = true; return s.t; });
  const probe = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.document.querySelector("canvas")?.__mirageG3 ?? null)));
  clocks.stop();
  const pm = await presentMon;
  writeFileSync(join(out, `pacing-${backend}.json`), JSON.stringify({ backend, warmupS, seconds, position, chromeArgs, windowStartQpc, windowEndQpc, raf, probe, errors,
    renderer, clocks: clocks.samples, clocksStatus: { available: clocks.available, reason: clocks.reason }, presentMon: pm, traceFile }, null, 1) + "\n");
  console.log(`pacing: ${raf.length} rAF intervals, ${clocks.samples.length} clock samples, PresentMon ${pm.available ? "ok" : pm.reason}, trace ${traceFile}`);
} finally {
  await browser.close();
  server.kill();
}
