import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { MAX_ROUTE_POINTS } from "../../packages/scenarios/src/flight-tasks";
import { ENDURANCE_CRITERIA, ENDURANCE_FIXTURE } from "../../scripts/phase1/endurance-rules";
import { seedProfiles } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-082: the multi-hour integrated soak, on the reference Mac (stakeholder request of 2026-11-09: about two hours). The whole
// application runs as a user would leave it: the 16-motor configuration in Chrome flying a circuit with wind and repeatable gusts
// against native ArduCopter, in lockstep at 800 Hz and at REAL TIME (not as fast as possible, unlike the TASK-189 hour), recording
// every signal at 50 Hz, with the flight view on screen, for MIRAGE_SOAK_MINUTES (default 120) of wall and simulated time.
// Opt-in, since it holds the Mac for hours:
//
//   MIRAGE_SOAK=1 [MIRAGE_SOAK_MINUTES=120] [MIRAGE_SOAK_SCREENSHOTS=DIR] CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     npx --no-install playwright test tests/browser/system-soak.spec.ts
//
// Declared before the first run (2026-11-09). PASS needs all of:
//  - the run never fails or pauses and is still flying the circuit at the end;
//  - real time: the run's average ratio of simulated to wall time within 1 ± 0.005, and at most one dropped interval per
//    10 minutes (an engineering choice from the acceptance runs, which drop about one per run of two minutes' start-up);
//  - lockstep: 0 frames lost and 0 resent;
//  - the recording closed with no dropped chunk, dropped row or lost producer sample, and at most A-08's 2 GB per simulated hour;
//  - the application's memory (its process tree, resident sizes) at most A-12's 8 GB at every sample;
//  - every in-flight altitude sample after the climb within the TASK-189 band (20 ± 10 m) and at least 5 % charge left.
// Reported, not judged: memory per process every 30 s and its slope over the run after the first 10 minutes, the flight
// view's frame times over 10 s windows every 10 minutes, and the real-time ratio over every 5 s sample.
// The battery's 300 Ah is a test input, so the flight lasts two hours (the TASK-189 hour used 64 % of 120 Ah); the mass stays the
// profile's. This is not a measured pack.

type Host = typeof import("../../packages/aar/src/recorder-v2-host");
const HOST_URL = viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url));
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";
const MINUTES = Number(process.env.MIRAGE_SOAK_MINUTES ?? "120");
const SHOTS = process.env.MIRAGE_SOAK_SCREENSHOTS;
// 2026-11-10: the sides were 500 m, which needs 96 points for 120 minutes, but a flight task's route holds at most MAX_ROUTE_POINTS (50),
// so both real soaks stopped at the 51st "Add point" (the 3-minute smoke needed 12). The circuit, not a pass rule, changed: 1200 m sides.
const SIDE_M = 1200, SPEED_MPS = 6, ALTITUDE_M = 20, CAPACITY_AH = 300;
const WIND_MPS = 3, WIND_FROM_DEG = 270, GUST_RMS_MPS = 1, GUST_BANDWIDTH_HZ = 1, GUST_SEED = 187;
/** A lap is four sides at 6 m/s (800 s at 1200 m): enough laps for the soak and two to spare, 44 points for 120 minutes. */
const LAP_S = (4 * SIDE_M) / SPEED_MPS;
const LAPS = Math.ceil((MINUTES * 60) / LAP_S) + 2;
if (4 * LAPS > MAX_ROUTE_POINTS) throw new Error(`A ${MINUTES}-minute soak needs ${4 * LAPS} route points; a flight task holds at most ${MAX_ROUTE_POINTS}`);
export const SOAK_CRITERIA = Object.freeze({
  ratioTolerance: 0.005, droppedPerTenMinutes: 1, lost: 0, resent: 0,
  bytesPerSimHour: ENDURANCE_CRITERIA.bytesPerSimHour, memoryBytes: ENDURANCE_CRITERIA.memoryBytes,
  altitudeM: ENDURANCE_CRITERIA.altitudeM, altitudeToleranceM: ENDURANCE_CRITERIA.altitudeToleranceM, climbS: ENDURANCE_CRITERIA.climbS,
  minimumStateOfCharge: ENDURANCE_CRITERIA.minimumStateOfCharge,
});

test.skip(process.env.MIRAGE_SOAK !== "1", "A multi-hour soak: MIRAGE_SOAK=1");
test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
// A step that cannot find its control fails after two minutes with the control's name, instead of waiting out the hours-long test timeout.
test.use({ trace: "off", screenshot: "off", video: "off", actionTimeout: 120_000 });

/** Resident bytes of this run's process tree, grouped by kind: Chrome's renderer, GPU and other helpers, ArduPilot, Node, Python. */
function memoryByProcess(): Record<string, number> {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" }).split("\n").map(line => line.trim()).filter(Boolean)
    .map(line => { const [pid = "0", ppid = "0", rss = "0", ...comm] = line.split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss) * 1024, comm: comm.join(" ") }; });
  const children = new Map<number, typeof rows>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const kind = (comm: string) => /Renderer/.test(comm) ? "chromeRenderer" : /\(GPU\)/.test(comm) ? "chromeGpu" : /Chrome|Chromium/.test(comm) ? "chromeOther"
    : /arducopter/i.test(comm) ? "ardupilot" : /node/.test(comm) ? "node" : /python/i.test(comm) ? "python" : "other";
  const root = rows.find(row => row.pid === process.ppid), out: Record<string, number> = {};
  const seen = new Set<number>(), stack = root ? [root] : [];
  while (stack.length > 0) {
    const row = stack.pop();
    if (!row || seen.has(row.pid)) continue;
    seen.add(row.pid);
    out[kind(row.comm)] = (out[kind(row.comm)] ?? 0) + row.rss;
    stack.push(...(children.get(row.pid) ?? []));
  }
  return out;
}
const total = (byProcess: Record<string, number>) => Object.values(byProcess).reduce((sum, bytes) => sum + bytes, 0);
const simTime = async (run: Locator): Promise<number> => Number.parseFloat((await run.getByTestId("sitl-sim-time").textContent()) ?? "NaN");
async function typeCircuit(panel: Locator): Promise<number> {
  const corners = [[SIDE_M, 0], [SIDE_M, SIDE_M], [0, SIDE_M], [0, 0]] as const;
  const points = Array.from({ length: LAPS }, () => corners).flat();
  for (const [i, [north, east]] of points.entries()) {
    if (i >= 2) await panel.getByRole("button", { name: "Add point", exact: true }).click();
    for (const [label, value] of [["north (m)", north], ["east (m)", east], ["altitude (m)", ALTITUDE_M], ["speed (m/s)", SPEED_MPS]] as const) {
      await panel.getByLabel(`Point ${i + 1} ${label}`, { exact: true }).fill(String(value));
    }
  }
  return points.length;
}
async function schedule(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Weather and location", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Weather and location", exact: true }).getByTestId("weather-panel");
  await panel.getByLabel("Onset, s after arming", { exact: true }).fill("0");
  await panel.getByLabel("Duration, s (empty: until the run ends)", { exact: true }).fill("");
  await panel.getByLabel("Speed, m/s", { exact: true }).fill(String(WIND_MPS));
  await panel.getByLabel("From, ° (bearing)", { exact: true }).fill(String(WIND_FROM_DEG));
  await panel.getByRole("button", { name: "Add the steady wind to the schedule" }).click();
  await panel.getByLabel("RMS per axis, m/s", { exact: true }).fill(String(GUST_RMS_MPS));
  await panel.getByLabel("Bandwidth, Hz", { exact: true }).fill(String(GUST_BANDWIDTH_HZ));
  await panel.getByLabel("Gust seed", { exact: true }).fill(String(GUST_SEED));
  await panel.getByRole("button", { name: "Add the synthetic gust to the schedule" }).click();
  await expect(panel.getByTestId("weather-schedule").locator("tbody tr")).toHaveCount(2);
}
/** The flight view's frame intervals over `seconds`, from requestAnimationFrame timestamps in the page. */
async function frameWindow(page: Page, seconds: number): Promise<{ count: number; medianMs: number; p99Ms: number; maxMs: number }> {
  return page.evaluate(async seconds => {
    const intervals: number[] = [];
    await new Promise<void>(resolve => {
      let previous: number | null = null, start: number | null = null;
      const frame = (now: number) => {
        if (previous !== null) intervals.push(now - previous);
        previous = now; start ??= now;
        if (now - start >= seconds * 1000) resolve(); else globalThis.requestAnimationFrame(frame);
      };
      globalThis.requestAnimationFrame(frame);
      // A hidden or occluded page draws no frames: end the window anyway, and the short count shows it.
      globalThis.setTimeout(resolve, seconds * 1000 + 5_000);
    });
    const sorted = [...intervals].sort((a, b) => a - b), at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
    return { count: sorted.length, medianMs: at(0.5), p99Ms: at(0.99), maxMs: sorted.at(-1) ?? Number.NaN };
  }, seconds);
}

test("the whole application flies the 16-motor circuit at real time for hours without failing, leaking or losing data", async ({ page, browser }) => {
  test.setTimeout((MINUTES + 60) * 60_000);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  // Bounded: a build waiting on another build's lock fails after ten minutes instead of hanging the soak.
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe", timeout: 600_000 });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe", timeout: 600_000 });
  const startedAt = new Date().toISOString();
  const home = mkdtempSync(join(tmpdir(), "mirage-soak-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const seeded = await seedProfiles(page, [ENDURANCE_FIXTURE], { batteryCapacityAh: CAPACITY_AH });
    await schedule(page);
    await page.getByRole("tab", { name: "Flight tasks", exact: true }).click();
    const tasks = page.getByRole("tabpanel", { name: "Flight tasks", exact: true });
    await tasks.getByRole("button", { name: "New flight task", exact: true }).click();
    await tasks.getByLabel("Task name", { exact: true }).fill("Soak circuit");
    await tasks.getByLabel("Task type", { exact: true }).selectOption("route");
    const routePoints = await typeCircuit(tasks);
    await tasks.getByRole("button", { name: "Save flight task", exact: true }).click();
    await expect(tasks.getByTestId("task-status")).toHaveText("Saved Soak circuit, version 1.");

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Flight task", { exact: true }).selectOption({ label: "Soak circuit (version 1)" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption({ label: "Real time" });
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    const experimentSha256 = (await run.getByTestId("sitl-record").textContent()) ?? "";
    await run.getByRole("button", { name: "Run task", exact: true }).click();

    const stage = run.getByTestId("sitl-stage"), speed = run.getByTestId("sitl-speed");
    const samples: { wall: string; simS: number; state: string; ratio5s: number | null; dropped: number; memory: Record<string, number>; altitudeM: number; armed: boolean; stateOfCharge: number }[] = [];
    const frames: { simS: number; count: number; medianMs: number; p99Ms: number; maxMs: number }[] = [];
    let state = "running", failure: string | null = null, armedAtS: number | null = null, nextDetailS = 0;
    const flight = { samples: 0, minimumAltitudeM: Number.POSITIVE_INFINITY, maximumAltitudeM: Number.NEGATIVE_INFINITY, stateOfCharge: Number.NaN, taskState: "" };
    for (;;) {
      await page.waitForTimeout(30_000);
      state = (await stage.getAttribute("data-state")) ?? "unknown";
      if (state === "failed") { failure = (await run.getByTestId("sitl-failure").textContent()) ?? "failed"; break; }
      if (state === "paused" || state === "idle") break;
      const now = await simTime(run), speedText = (await speed.textContent()) ?? "";
      const altitude = Number.parseFloat((await run.getByTestId("sitl-altitude").textContent()) ?? "NaN");
      const armed = (await run.getByTestId("sitl-armed").textContent()) === "Armed";
      const stateOfCharge = Number(/\(([\d.]+) %\)/.exec((await run.getByTestId("power-battery").textContent()) ?? "")?.[1] ?? Number.NaN) / 100;
      flight.taskState = (await run.getByTestId("task-state").getAttribute("data-state")) ?? "";
      flight.stateOfCharge = stateOfCharge;
      if (armed && armedAtS === null) armedAtS = now;
      if (armedAtS !== null && now - armedAtS >= SOAK_CRITERIA.climbS) {
        flight.samples++; flight.minimumAltitudeM = Math.min(flight.minimumAltitudeM, altitude); flight.maximumAltitudeM = Math.max(flight.maximumAltitudeM, altitude);
      }
      const memory = memoryByProcess();
      samples.push({ wall: new Date().toISOString(), simS: now, state, ratio5s: Number(/([\d.]+)× over the last 5 s/.exec(speedText)?.[1] ?? Number.NaN), dropped: await run.getByTestId("sitl-dropped").count(),
        memory, altitudeM: altitude, armed, stateOfCharge });
      if (now >= nextDetailS) {
        frames.push({ simS: now, ...(await frameWindow(page, 10)) });
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `soak-${String(Math.round(now)).padStart(5, "0")}s.png`), fullPage: true }).catch(() => undefined);
        nextDetailS = now + 600;
      }
      console.log(`SOAK ${new Date().toISOString()} ${now.toFixed(0)} s, ${(total(memory) / 1e9).toFixed(2)} GB, ${state}, ${speedText}`.slice(0, 220));
      if (now >= MINUTES * 60) break;
    }
    const frameText = (await run.getByTestId("sitl-frames").textContent()) ?? "", counts = /(\d+) stepped, (\d+) lost, (\d+) resent, (\d+) held/.exec(frameText) ?? [];
    const rate = { mode: (await speed.getAttribute("data-mode")) ?? "", averageRatio: Number(await speed.getAttribute("data-average")), simElapsedS: Number(await speed.getAttribute("data-sim-elapsed")),
      runningWallS: Number(await speed.getAttribute("data-running-wall")), droppedIntervals: await run.getByTestId("sitl-dropped").count(),
      steps: Number(counts[1]), lost: Number(counts[2]), resent: Number(counts[3]), held: Number(counts[4]) };
    const endSimS = await simTime(run), pauses = await run.getByTestId("sitl-pauses").locator("li").count(), accidents = await run.getByTestId("sitl-accidents").locator("li").count();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "soak-end.png"), fullPage: true }).catch(() => undefined);
    if (state !== "failed") {
      await run.getByRole("button", { name: "Stop run" }).click();
      await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 300_000 });
    }
    const found = await page.evaluate(async url => {
      const { listRecordings } = await import(url) as Host;
      for (let i = 0; i < 300; i++) {
        const last = (await listRecordings()).at(-1);
        if (last?.status === "closed") return last;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return (await listRecordings()).at(-1) ?? null;
    }, HOST_URL);
    if (!found) throw new Error("The run has no recording");

    // Memory slope after the first 10 minutes, bytes per hour, per process kind and in total: a least-squares line through the samples.
    const settled = samples.filter(sample => sample.simS >= 600);
    const slope = (pick: (sample: (typeof samples)[number]) => number) => {
      const n = settled.length;
      if (n < 3) return null;
      const mx = settled.reduce((s, x) => s + x.simS, 0) / n, my = settled.reduce((s, x) => s + pick(x), 0) / n;
      const sxx = settled.reduce((s, x) => s + (x.simS - mx) ** 2, 0), sxy = settled.reduce((s, x) => s + (x.simS - mx) * (pick(x) - my), 0);
      return sxx > 0 ? (sxy / sxx) * 3600 : null;
    };
    const kinds = [...new Set(samples.flatMap(sample => Object.keys(sample.memory)))].sort();
    const memorySlopeBytesPerHour = Object.fromEntries([...kinds.map(kind => [kind, slope(sample => sample.memory[kind] ?? 0)] as const), ["total", slope(sample => total(sample.memory))] as const]);
    const peakBytes = Math.max(0, ...samples.map(sample => total(sample.memory)));

    const checks = {
      noFailure: failure === null && state === "running" && pauses === 0 && accidents === 0 && flight.taskState === "running",
      duration: endSimS >= MINUTES * 60,
      realTime: Math.abs(rate.averageRatio - 1) <= SOAK_CRITERIA.ratioTolerance,
      dropped: rate.droppedIntervals <= Math.max(1, Math.ceil(endSimS / 600)) * SOAK_CRITERIA.droppedPerTenMinutes,
      lockstep: rate.lost === SOAK_CRITERIA.lost && rate.resent === SOAK_CRITERIA.resent,
      recording: found.status === "closed" && found.droppedChunks === 0 && found.droppedRows === 0 && found.producerLost === 0 && found.bytes <= SOAK_CRITERIA.bytesPerSimHour * (endSimS / 3600),
      memory: peakBytes <= SOAK_CRITERIA.memoryBytes,
      altitude: flight.samples > 0 && Math.abs(flight.minimumAltitudeM - SOAK_CRITERIA.altitudeM) <= SOAK_CRITERIA.altitudeToleranceM && Math.abs(flight.maximumAltitudeM - SOAK_CRITERIA.altitudeM) <= SOAK_CRITERIA.altitudeToleranceM,
      charge: flight.stateOfCharge >= SOAK_CRITERIA.minimumStateOfCharge,
    };
    const status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
    const out = {
      schema: "mirage-system-soak/1", task: "TASK-082", status, checks, criteria: SOAK_CRITERIA, minutes: MINUTES, startedAt, finishedAt: new Date().toISOString(), chrome: browser.version(),
      configuration: ENDURANCE_FIXTURE, profileSha256: Object.values(seeded.profiles)[0] ?? "", experimentSha256, physicsHz: found.header.physicsHz,
      workload: { routePoints, sideM: SIDE_M, speedMps: SPEED_MPS, altitudeM: ALTITUDE_M, batteryCapacityAh: CAPACITY_AH, speed: "real time",
        weather: [`Mean wind: ${WIND_MPS} m/s from ${WIND_FROM_DEG}°`, `Synthetic gust: ${GUST_RMS_MPS} m/s RMS, ${GUST_BANDWIDTH_HZ} Hz, seed ${GUST_SEED}`] },
      rate, failure, pauses, accidents, endSimS, flight,
      recording: { status: found.status, bytes: found.bytes, chunks: found.chunks, droppedChunks: found.droppedChunks, droppedRows: found.droppedRows, producerLost: found.producerLost, rows: found.rows },
      memory: { peakBytes, slopeBytesPerHour: memorySlopeBytesPerHour, samples: samples.map(sample => ({ simS: sample.simS, wall: sample.wall, bytes: sample.memory })) },
      ratio5s: samples.map(sample => sample.ratio5s), frames,
    };
    mkdirSync(join(ROOT, "test-results/validation"), { recursive: true });
    writeFileSync(join(ROOT, "test-results/validation/system-soak.json"), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`SOAK result ${JSON.stringify({ status, checks, rate, peakBytes, memorySlopeBytesPerHour, recordingBytes: found.bytes })}`);
    expect(checks, "every soak check").toEqual(Object.fromEntries(Object.keys(checks).map(key => [key, true])));
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
