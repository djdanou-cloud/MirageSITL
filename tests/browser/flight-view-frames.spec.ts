import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";

// TASK-185 frame times against A-06 (docs/decisions/phase1-acceptance.md):
// 60 frames per second on the M5's built-in display with the Chrome window
// filling the screen, median frame time at most 16.680 ms and p99 at most
// 17.665 ms; on macOS, which has no displayed-frame timing source, the p99 of
// the frame clock is reported and the run passes with the median within the
// limit and no interval above 25 ms, so no frame was skipped (amendment of
// 2026-11-01). Opt-in (MIRAGE_FRAME_TIME=1), because it opens a visible,
// full-screen Google Chrome on the real GPU and must not be disturbed:
//
//   MIRAGE_FRAME_TIME=1 CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     npx --no-install playwright test tests/browser/flight-view-frames.spec.ts
//
// The workload is the Run tab during an ArduPilot SITL hover of the S19 quad
// X: the physics Worker steps at 800 Hz in lockstep while the flight view, its
// trajectory and the panels update. Frame times are the intervals between
// requestAnimationFrame callbacks, which Chrome paces to the display, over
// 60 s of the external view and then 30 s of the onboard view, after 5 s of
// warmup each. The report (browser, GPU, screen, scale, counts, median, p95,
// p99, max) is written to test-results/browser/frame-times/, which holds no
// tracked files.
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const MEDIAN_LIMIT_MS = 16.680, P99_LIMIT_MS = 17.665;
/** macOS: no interval may exceed 1.5 refresh intervals at 60 Hz, i.e. no frame was skipped (A-06 amendment of 2026-11-01). */
const MAC_MAX_INTERVAL_MS = 25;

test.skip(process.env.MIRAGE_FRAME_TIME !== "1", "Opt-in: MIRAGE_FRAME_TIME=1 opens a visible full-screen Chrome on the real GPU");
test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
// The window fills the screen; no software GL and no fixed viewport.
test.use({
  headless: false,
  launchOptions: { ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--start-fullscreen"] },
});

/**
 * The built-in display as macOS reports it: its size in points, its scale
 * factor and refresh rate. Playwright applies the project's scale factor of 1
 * to every context, so the test sets the display's own size and scale.
 */
function builtInDisplay(): { width: number; height: number; scale: number; refreshHz: number; gpu: string } {
  const report: unknown = JSON.parse(execFileSync("system_profiler", ["SPDisplaysDataType", "-json"], { encoding: "utf8" }));
  const gpus: unknown = typeof report === "object" && report !== null ? Reflect.get(report, "SPDisplaysDataType") : null;
  for (const gpu of Array.isArray(gpus) ? (gpus as readonly unknown[]) : []) {
    const displays: unknown = typeof gpu === "object" && gpu !== null ? Reflect.get(gpu, "spdisplays_ndrvs") : null;
    for (const display of Array.isArray(displays) ? (displays as readonly unknown[]) : []) {
      if (typeof display !== "object" || display === null || Reflect.get(display, "spdisplays_connection_type") !== "spdisplays_internal") continue;
      const points = /^(\d+) x (\d+) @ ([\d.]+)Hz$/.exec(String(Reflect.get(display, "_spdisplays_resolution")));
      const pixels = /^(\d+) x (\d+)$/.exec(String(Reflect.get(display, "_spdisplays_pixels")));
      if (!points || !pixels) continue;
      const model: unknown = typeof gpu === "object" && gpu !== null ? Reflect.get(gpu, "sppci_model") : null;
      const cores: unknown = typeof gpu === "object" && gpu !== null ? Reflect.get(gpu, "sppci_cores") : null;
      return { width: Number(points[1]), height: Number(points[2]), refreshHz: Number(points[3]), scale: Number(pixels[1]) / Number(points[1]),
        gpu: `${String(model)}, ${String(cores)} GPU cores` };
    }
  }
  throw new Error("No built-in display found");
}

interface Frames { count: number; medianMs: number; p95Ms: number; p99Ms: number; maxMs: number }
function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
}

test("the flight view holds 60 FPS on the M5's built-in display during an ArduPilot SITL hover", async ({ browser, baseURL }) => {
  test.setTimeout(900000);
  // Its own context: the built-in display's size and scale factor, not the project's fixed 1920 x 1080 at 1x.
  const display = builtInDisplay();
  const context = await browser.newContext({ viewport: { width: display.width, height: display.height }, deviceScaleFactor: display.scale, baseURL });
  const page = await context.newPage();
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-frame-times-"));
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  chmodSync(join(home, "token"), 0o600);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    await seedQuadProject(page, "Quad X SITL");
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const panel = page.getByRole("region", { name: "ArduPilot SITL" });
    await panel.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await panel.getByLabel("Launcher token", { exact: true }).fill(token);
    await panel.getByRole("button", { name: "List ArduPilot builds" }).click();
    await panel.getByLabel("Speed").selectOption("1");
    await panel.getByRole("button", { name: "Start SITL run" }).click();
    await expect(panel.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300000 });
    await panel.getByLabel("Take-off altitude, m").fill("5");
    await panel.getByRole("button", { name: "Take off" }).click();
    await expect(panel.getByTestId("sitl-stage")).toHaveText("Flying", { timeout: 180000 });
    await panel.getByTestId("flight-view").scrollIntoViewIfNeeded();

    const measure = (seconds: number) => page.evaluate(async (seconds: number) => {
      const intervals: number[] = [];
      await new Promise<void>(done => {
        let last = -1, warm = -1;
        const frame = (now: number) => {
          if (warm < 0) warm = now;
          if (now - warm >= 5000) {
            if (last >= 0) intervals.push(now - last);
            last = now;
          }
          if (last < 0 || intervals.reduce((a, b) => a + b, 0) < seconds * 1000) requestAnimationFrame(frame); else done();
        };
        requestAnimationFrame(frame);
      });
      return { intervals, hidden: document.hidden };
    }, seconds);
    const summarize = (intervals: number[]): Frames => {
      const sorted = [...intervals].sort((a, b) => a - b);
      return { count: sorted.length, medianMs: quantile(sorted, 0.5), p95Ms: quantile(sorted, 0.95), p99Ms: quantile(sorted, 0.99), maxMs: sorted.at(-1) ?? Number.NaN };
    };
    const external = await measure(60);
    await panel.getByRole("radio", { name: "Onboard" }).check();
    const onboard = await measure(30);
    expect(external.hidden || onboard.hidden).toBe(false);
    // The aircraft was still flying throughout.
    await expect(panel.getByTestId("sitl-stage")).toHaveText("Flying");

    const environment = await page.evaluate(() => {
      const canvas = document.createElement("canvas"), gl = canvas.getContext("webgl2");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      return { userAgent: navigator.userAgent, gpu: info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown",
        screen: [screen.width, screen.height], window: [innerWidth, innerHeight], devicePixelRatio, fullScreen: innerHeight === screen.height };
    });
    const mac = process.platform === "darwin";
    const report = { schema: "mirage-frame-times/1", criterion: "A-06",
      limits: mac ? { medianMs: MEDIAN_LIMIT_MS, maxMs: MAC_MAX_INTERVAL_MS, p99Ms: "reported" } : { medianMs: MEDIAN_LIMIT_MS, p99Ms: P99_LIMIT_MS },
      browser: browser.version(), host: execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf8" }).trim(), display, ...environment,
      external: summarize(external.intervals), onboard: summarize(onboard.intervals) };
    const directory = join(ROOT, "test-results/browser/frame-times");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `flight-view-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.info(`Frame times: ${JSON.stringify({ external: report.external, onboard: report.onboard, gpu: report.gpu, screen: report.screen,
      window: report.window, dpr: report.devicePixelRatio })} -> ${path}`);
    expect(readFileSync(path, "utf8")).toContain("A-06");
    for (const [view, frames] of [["external", report.external], ["onboard", report.onboard]] as const) {
      expect(frames.medianMs, `${view} median`).toBeLessThanOrEqual(MEDIAN_LIMIT_MS);
      if (mac) expect(frames.maxMs, `${view} longest interval`).toBeLessThanOrEqual(MAC_MAX_INTERVAL_MS);
      else expect(frames.p99Ms, `${view} p99`).toBeLessThanOrEqual(P99_LIMIT_MS);
    }
    await panel.getByRole("button", { name: "Land" }).click();
    await panel.getByRole("button", { name: "Stop run" }).click({ timeout: 180000 });
  } finally {
    await context.close();
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
