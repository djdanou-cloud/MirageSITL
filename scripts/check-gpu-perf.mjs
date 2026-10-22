// TASK-073 producer. A missing device, a software GPU, WebGPU, or a short window
// exits BLOCKED_EXTERNAL. Frame-time and residency misses exit FAIL. The 60 FPS
// limits are the user-accepted median 16.680 ms and p99 17.665 ms. The 120 FPS
// p99 limit remains 8.33 ms. A 59.88 Hz panel is an accepted 60 FPS refresh.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { assertDisplaySurface, decideGpuAcceptance, displayRefreshHz, profileFitsDisplay } from "./gpu-trace.mjs";
import { report } from "./validation/evidence.mjs";
import { captureDisplay, gpuProcessMemorySampler, nowQpcMs, nvidiaSmiSampler, presentMonCapture, summarizeClocks, summarizePresentMon } from "./capture-samplers.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
function hostModel() {
  if (process.platform === "darwin") return execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim();
  return os.cpus()[0]?.model ?? "unknown";
}
function osLabel() {
  if (process.platform === "darwin") return `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()}`;
  return `${os.platform()} ${os.release()}`;
}
function powerMode() {
  if (process.platform !== "darwin") return "unreported";
  const text = execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" });
  if (text.includes("AC Power")) return "AC";
  if (text.includes("Battery Power")) return "battery";
  return "unreported";
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked && process.argv.length === 2) {
  const result = report("gpu-report", "BLOCKED_EXTERNAL", ["Provide --backend webgl2|webgpu --fps 60|120; WebGPU passes are not implemented and a run still needs M4 or RTX 4050 hardware"]);
  console.log(`gpu-report: ${result.status}; ${result.reasons[0]}`);
  process.exitCode = 2;
} else if (invoked) {
  const backend = option("backend", "");
  const fps = Number(option("fps", ""));
  const warmupS = Number(option("warmup", "60"));
  const durationS = Number(option("seconds", "600"));
  const directory = option("out", "test-results/gpu");
  // Top-left corner of the display that shows the capture; the window goes fullscreen there.
  const position = option("position", "0,0");
  // Generated terrain/buildings (scripts/geodata): a folder with terrain/ and/or buildings/.
  const geodata = option("geodata", null);
  if (!/^-?\d+,-?\d+$/.test(position) || !["webgl2", "webgpu"].includes(backend) || ![60, 120].includes(fps) || !Number.isFinite(warmupS) || warmupS < 1 || warmupS > 600 || !Number.isFinite(durationS) || durationS < 1 || durationS > 3600) {
    console.error("Expected --backend webgl2|webgpu --fps 60|120");
    process.exitCode = 1;
  } else {
    if (backend === "webgpu") {
      mkdirSync(directory, { recursive: true });
      const early = report("gpu-report", "BLOCKED_EXTERNAL", ["WebGPU fisheye and thermal passes are not implemented"]);
      writeFileSync(`${directory}/gpu-report.json`, JSON.stringify(early, null, 2) + "\n");
      console.log(`gpu-report: ${early.status}; ${early.reasons[0]}`);
      process.exitCode = 2;
    } else {
      void admitDisplay(fps, position).then(refreshHz => {
        if (!profileFitsDisplay(refreshHz, fps)) {
          mkdirSync(directory, { recursive: true });
          const early = report("gpu-report", "BLOCKED_EXTERNAL", [`Display refresh ${refreshHz.toFixed(2)} Hz does not support the ${fps} FPS profile`]);
          writeFileSync(`${directory}/gpu-report.json`, JSON.stringify(early, null, 2) + "\n");
          console.log(`gpu-report: ${early.status}; ${early.reasons[0]}`);
          process.exitCode = 2;
          return;
        }
        return measure(backend, fps, warmupS, durationS, directory, position, geodata);
      }).catch(error => {
        const result = report("gpu-report", "BLOCKED_EXTERNAL", [error instanceof Error ? error.message : String(error)]);
        mkdirSync(directory, { recursive: true });
        writeFileSync(`${directory}/gpu-report.json`, JSON.stringify(result, null, 2) + "\n");
        console.error(result.reasons[0]);
        process.exitCode = 2;
      });
    }
  }
}

async function admitDisplay(fps, position) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: false, executablePath: process.env.CHROMIUM_PATH, args: ["--window-size=800,600", `--window-position=${position}`] });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.bringToFront();
    const sample = await page.evaluate(() => new Promise(resolve => {
      const frameMs = [];
      let previous;
      const frame = timestamp => {
        if (previous !== undefined) frameMs.push(timestamp - previous);
        previous = timestamp;
        if (frameMs.length >= 90) resolve({
          frameMs, innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight,
          screenWidth: globalThis.screen.width, screenHeight: globalThis.screen.height, dpr: globalThis.devicePixelRatio,
        });
        else globalThis.requestAnimationFrame(frame);
      };
      globalThis.requestAnimationFrame(frame);
    }));
    assertDisplaySurface(sample);
    const refreshHz = displayRefreshHz(sample.frameMs);
    console.log(`Visible display refresh ${refreshHz.toFixed(2)} Hz for the ${fps} FPS profile.`);
    return refreshHz;
  } finally {
    await browser.close();
  }
}

/**
 * Build-time terrain settings. With --geodata the app loads the generated
 * quantized-mesh terrain and 3D Tiles buildings served from that folder, placed
 * at the area origin the terrain build recorded; otherwise the CC0 fixture.
 */
function terrainEnv(geodata) {
  if (geodata === null) {
    return { VITE_MIRAGE_TILESET_URL: "/fixtures/tiles/tileset.json", VITE_MIRAGE_TILES_ORIGIN: "47.3769,8.5417,400",
      VITE_MIRAGE_TILES_ATTRIBUTION: "MirageSITL synthetic test tiles (CC0-1.0)" };
  }
  const root = resolvePath(geodata);
  const terrainManifest = join(root, "terrain", "terrain-manifest.json");
  if (!existsSync(terrainManifest)) throw new Error(`No terrain manifest at ${terrainManifest}`);
  const manifest = JSON.parse(readFileSync(terrainManifest, "utf8"));
  const origin = manifest.areaOrigin;
  if (!origin || ![origin.latDeg, origin.lonDeg, origin.heightM].every(Number.isFinite)) throw new Error("Terrain manifest has no areaOrigin");
  const env = { MIRAGE_GEODATA_DIR: root, VITE_MIRAGE_TERRAIN_URL: "/geodata/terrain/layer.json",
    VITE_MIRAGE_TILES_ORIGIN: `${origin.latDeg},${origin.lonDeg},${origin.heightM}`,
    VITE_MIRAGE_TILES_ATTRIBUTION: "FABDEM V1-2 (CC BY-NC-SA 4.0, contains modified Copernicus DEM); buildings (c) Overture Maps Foundation, OpenStreetMap contributors",
    VITE_MIRAGE_TILESET_URL: "" };
  if (Number.isFinite(manifest.areaRadiusM)) env.VITE_MIRAGE_AREA_RADIUS_M = String(manifest.areaRadiusM);
  if (existsSync(join(root, "buildings", "tileset.json"))) env.VITE_MIRAGE_TILESET_URL = "/geodata/buildings/tileset.json";
  return env;
}

async function measure(backend, fps, warmupS, durationS, directory, position, geodata) {
  const { chromium } = await import("@playwright/test");
  mkdirSync(directory, { recursive: true });
  const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
  const env = { ...process.env, ...terrainEnv(geodata) };
  execFileSync(process.execPath, [vite, "build", "apps/web"], { env, stdio: "inherit" });
  // NO_COLOR keeps Vite's banner plain, so the owned-URL readiness check matches on every terminal.
  const server = spawn(process.execPath, [vite, "preview", "apps/web", "--host", "127.0.0.1", "--port", "5175", "--strictPort"], { env: { ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let serverOutput = "";
  const output = bytes => { serverOutput = (serverOutput + bytes.toString()).slice(-32768); };
  server.stdout.on("data", output);
  server.stderr.on("data", output);
  let browser;
  let page;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error("Owned preview server exited before readiness");
      try { if (serverOutput.includes("http://127.0.0.1:5175") && (await fetch("http://127.0.0.1:5175")).ok) { ready = true; break; } } catch { /* bounded startup polling */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error("Preview startup deadline");
    // No viewport emulation: the window goes fullscreen on the physical display at
    // `position`, so the measured canvas is what that display presents.
    browser = await chromium.launch({ headless: false, executablePath: process.env.CHROMIUM_PATH, args: [`--window-position=${position}`, "--disable-features=Translate", "--lang=en-US", "--no-first-run"] });
    const context = await browser.newContext({ viewport: null });
    page = await context.newPage();
    const pageCdp = await context.newCDPSession(page);
    const { windowId } = await pageCdp.send("Browser.getWindowForTarget");
    await pageCdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:5175/?renderer=${backend}&g3=1&view=chase&flight=circuit`);
    await page.getByTestId("worker-status").filter({ hasText: "READY" }).waitFor({ timeout: 30000 });
    await page.bringToFront();
    try {
      await page.locator("canvas[data-g3='1']").waitFor({ timeout: 30000 });
    } catch (error) {
      const detail = errors.length ? errors.join("; ") : "no page error";
      throw new Error(`${error instanceof Error ? error.message.split("\n")[0] : String(error)}; ${detail}`, { cause: error });
    }
    const features = await page.waitForFunction(() => {
      const canvas = globalThis.document.querySelector("canvas");
      const probe = canvas && canvas.__mirageG3;
      return probe && probe.terrain === true && probe.fpv === true && probe.thermal === true ? probe : undefined;
    }, null, { timeout: 45000 }).then(handle => handle.jsonValue()).catch(() => null);
    const identity = await page.evaluate(() => {
      const canvas = globalThis.document.createElement("canvas");
      const gl = canvas.getContext("webgl2", { powerPreference: "high-performance" });
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      const renderer = gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      const shown = globalThis.document.querySelector("canvas");
      return { renderer: String(renderer), backend: shown?.getAttribute("data-render-backend") ?? "", fallback: shown?.getAttribute("data-render-fallback") ?? "" };
    });
    // Side-channel samplers start before the flight: opening PresentMon's ETW
    // session stalled the browser for ~300 ms in a test run.
    const browserCdp = await browser.newBrowserCDPSession();
    const gpuProcess = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo.find(info => info.type === "GPU");
    const memorySampler = gpuProcess ? gpuProcessMemorySampler(gpuProcess.id) : null;
    const clockSampler = nvidiaSmiSampler();
    const presentMonCsv = fileURLToPath(new URL(`../${directory}/presentmon-${backend}-${fps}.csv`, import.meta.url));
    const presentMon = gpuProcess ? presentMonCapture(gpuProcess.id, presentMonCsv, warmupS + durationS + 30)
      : Promise.resolve({ kind: "presentmon", available: false, reason: "no browser GPU process" });
    await new Promise(resolve => setTimeout(resolve, 3000));
    // Start only after the feature wait, the identity probe and the samplers: a
    // main-thread stall above the 250 ms input timeout during flight blocks the
    // worker's arming latch until the arm request is withdrawn (the drone falls).
    await page.bringToFront();
    const started = await page.getByRole("button", { name: "Start", exact: true }).evaluate(element => {
      if (!(element instanceof globalThis.HTMLButtonElement) || element.disabled) return false;
      element.click();
      return true;
    });
    if (!started) throw new Error("Start control was not ready");
    if (!features) {
      const probe = await page.evaluate(() => globalThis.document.querySelector("canvas")?.__mirageG3 ?? null);
      throw new Error(`Terrain, FPV, and thermal did not all become active (${JSON.stringify({ probe, identity, errors })})`);
    }
    console.log(`Visible ${backend} production scene: ${warmupS}s warmup then ${durationS}s.`);
    const measurement = await page.evaluate(async ({ warmupS, durationS }) => {
      const read = () => {
        const probe = globalThis.document.querySelector("canvas")?.__mirageG3;
        return probe && typeof probe === "object" ? probe : null;
      };
      // Scripted-flight evidence: HUD altitude, position and arm state once per second (DOM reads at 1 Hz only).
      const flight = [];
      const started = globalThis.performance.now();
      let lastFrameMs = globalThis.performance.now(), maxGapMs = 0;
      const gapProbe = now => { maxGapMs = Math.max(maxGapMs, now - lastFrameMs); lastFrameMs = now; if (flightTimer !== 0) globalThis.requestAnimationFrame(gapProbe); };
      let flightTimer = 0;
      flightTimer = setInterval(() => {
        const text = selector => globalThis.document.querySelector(selector)?.textContent?.trim() ?? "";
        flight.push({ s: Math.round((globalThis.performance.now() - started) / 1000), altitude: text("[data-testid=altitude]"), position: text(".coordinates"),
          simTime: text("[data-testid=sim-time]"), physicsHz: text("[data-testid=physics-hz]"),
          inputFailsafe: (globalThis.document.body.textContent ?? "").includes("DISARMED / STALE"),
          armed: Array.from(globalThis.document.querySelectorAll("button")).some(button => button.textContent?.includes("Disarm motors")), maxFrameGapMs: Math.round(maxGapMs) });
        maxGapMs = 0;
      }, 1000);
      globalThis.requestAnimationFrame(gapProbe);
      await new Promise(resolve => setTimeout(resolve, warmupS * 1000));
      const frameMs = [];
      let gpuBytes = 0, cpuBytes = 0, held = true, samples = 0, width = 0, height = 0, dpr = 0, sizeOk = true, hidden = globalThis.document.hidden;
      const onVis = () => { if (globalThis.document.hidden) hidden = true; };
      globalThis.document.addEventListener("visibilitychange", onVis);
      try {
        await new Promise(resolve => {
          let previous, sum = 0, started = false;
          const frame = timestamp => {
            const probe = read();
            if (probe) {
              samples += 1;
              if (probe.gpuBytes > gpuBytes) gpuBytes = probe.gpuBytes;
              if (probe.cpuBytes > cpuBytes) cpuBytes = probe.cpuBytes;
              if (probe.terrain !== true || probe.fpv !== true || probe.thermal !== true) held = false;
              if (probe.width !== 1920 || probe.height !== 1080 || probe.dpr !== 1) sizeOk = false;
              width = probe.width; height = probe.height; dpr = probe.dpr;
            } else held = false;
            if (!started) { previous = timestamp; started = true; }
            else {
              const dt = timestamp - previous;
              frameMs.push(dt);
              sum += dt;
              previous = timestamp;
            }
            if (sum >= durationS * 1000 + 50) resolve();
            else globalThis.requestAnimationFrame(frame);
          };
          globalThis.requestAnimationFrame(frame);
        });
      } finally { globalThis.document.removeEventListener("visibilitychange", onVis); clearInterval(flightTimer); flightTimer = 0; }
      return { frameMs, gpuBytes, cpuBytes, featuresHeld: held && samples > 0, width: sizeOk ? width : 0, height: sizeOk ? height : 0, dpr, hidden, flight };
    }, { warmupS, durationS });
    const measuredEndQpcMs = nowQpcMs();
    const screen = await page.evaluate(() => ({ screenX: globalThis.screenX, screenY: globalThis.screenY, innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight,
      screenWidth: globalThis.screen.width, screenHeight: globalThis.screen.height, dpr: globalThis.devicePixelRatio }));
    let display;
    try { display = captureDisplay(screen.screenX + 1, screen.screenY + 1, fileURLToPath(new URL(`../${directory}/display-${backend}-${fps}.png`, import.meta.url))); }
    catch (error) { display = { available: false, reason: error instanceof Error ? error.message : String(error) }; }
    memorySampler?.stop();
    clockSampler.stop();
    let total = 0;
    for (const ms of measurement.frameMs) total += ms;
    // The measurement window on the shared QPC clock: it ended when page.evaluate returned.
    const presentMonRun = await presentMon;
    let presentMonResult = presentMonRun;
    if (presentMonRun.available) {
      try { presentMonResult = { ...presentMonRun, ...summarizePresentMon(presentMonCsv, { startMs: measuredEndQpcMs - total, endMs: measuredEndQpcMs }) }; }
      catch (error) { presentMonResult = { ...presentMonRun, available: false, reason: error instanceof Error ? error.message : String(error) }; }
    }
    const result = decideGpuAcceptance({
      gpu: identity.renderer, hostModel: hostModel(), os: osLabel(), browser: browser.version(), powerMode: powerMode(), backend,
      fps, warmupS, measuredS: total / 1000, durationS: total / 1000, featuresHeld: measurement.featuresHeld && errors.length === 0 && identity.backend === backend,
      visible: !measurement.hidden, width: measurement.width, height: measurement.height, dpr: measurement.dpr,
      frameMs: measurement.frameMs, gpuBytes: measurement.gpuBytes, cpuBytes: measurement.cpuBytes,
    });
    const tracePath = `${directory}/gpu-${backend}-${fps}.json`;
    const framesBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, backend, fps, warmupS, frameMs: measurement.frameMs }) + "\n");
    writeFileSync(`${directory}/gpu-${backend}-${fps}.frames.json`, framesBytes);
    const memory = memorySampler?.samples ?? [];
    const side = {
      position, screen, display,
      framesSha256: createHash("sha256").update(framesBytes).digest("hex"),
      gpuProcessMemory: memorySampler ? { available: memorySampler.available, samples: memory.length,
        dedicatedPeakBytes: memory.reduce((m, s) => Math.max(m, s.dedicatedBytes), 0), sharedPeakBytes: memory.reduce((m, s) => Math.max(m, s.sharedBytes), 0) }
        : { available: false, reason: "no browser GPU process" },
      clocks: clockSampler.available ? summarizeClocks(clockSampler.samples) : { available: false, reason: clockSampler.reason },
      presentMon: presentMonResult,
    };
    writeFileSync(tracePath, JSON.stringify({ identity, errors, measurement: { ...measurement, frameMs: measurement.frameMs.length, flight: measurement.flight.length }, side, report: result }, null, 2) + "\n");
    writeFileSync(`${directory}/flight-${backend}-${fps}.json`, JSON.stringify(measurement.flight, null, 1) + "\n");
    writeFileSync(`${directory}/clocks-${backend}-${fps}.json`, JSON.stringify(clockSampler.samples) + "\n");
    writeFileSync(`${directory}/gpu-report.json`, JSON.stringify(result, null, 2) + "\n");
    console.log(`gpu-report: ${result.status}; frames=${measurement.frameMs.length}; p99=${result.metrics?.p99FrameMs ?? "n/a"}`);
    if (result.reasons?.length) console.log(result.reasons.join("; "));
    process.exitCode = result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
  } finally {
    if (page) await page.screenshot({ path: `${directory}/g3-${backend}-${fps}.png` }).catch(() => undefined);
    await browser?.close();
    server.kill();
  }
}
