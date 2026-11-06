import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { ENDURANCE_CONFIGURATION, ENDURANCE_CRITERIA, ENDURANCE_FIXTURE, ENDURANCE_RUN_SCHEMA, type EnduranceRun } from "../../scripts/phase1/endurance-rules";
import { seedProfiles } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-189 (S19) on the reference Mac: one continuous simulated hour of the 16-motor configuration in Chrome, with native ArduCopter
// 8ab6afde, under decision A-07: a repeated flight circuit with wind and repeatable gusts on, recording every available signal at the
// default 50 Hz. It runs as fast as this computer goes, since an hour of simulated time need not be an hour of wall time (A-05), and it
// reports the rate it reached. This only writes what it saw: scripts/phase1/endurance.mjs starts it, judges the run file by
// scripts/phase1/endurance-rules.ts and writes the matrix. Not part of a normal browser run.
//
// The battery's 120 Ah is a test input, so that the flight lasts the hour: the example card's 5 Ah would empty in minutes. The mass stays
// the profile's. This is not a measured pack.

type Host = typeof import("../../packages/aar/src/recorder-v2-host");
const HOST_URL = viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url));
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";
const OUT = process.env.MIRAGE_PHASE1_OUT;
const SIDE_M = 500, SPEED_MPS = 6, ALTITUDE_M = 20, LAPS = 12, CAPACITY_AH = 120;
const WIND_MPS = 3, WIND_FROM_DEG = 270, GUST_RMS_MPS = 1, GUST_BANDWIDTH_HZ = 1, GUST_SEED = 187;
/** Past the hour, so that the recording's own start and stop leave a whole hour in it. */
const MARGIN_S = 10;

test.skip(process.env.MIRAGE_PHASE1_ENDURANCE !== "1", "An hour-long acceptance run: node scripts/phase1/endurance.mjs");
test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
test.use({ trace: "off", screenshot: "off", video: "off" });

/** The application's memory, bytes: this run's process tree (the dev server, the launcher, Chrome and its helpers, ArduPilot) as resident sizes, which count shared pages each time, so an upper bound. */
function applicationMemoryBytes(): number {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }).split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 3);
  const children = new Map<number, [number, number][]>();
  for (const [pid = 0, ppid = 0, rss = 0] of rows) children.set(ppid, [...(children.get(ppid) ?? []), [pid, rss]]);
  const root = process.ppid, seen = new Set<number>([root]);
  let total = (rows.find(row => row[0] === root)?.[2] ?? 0) * 1024;
  const stack = [root];
  while (stack.length > 0) {
    for (const [pid, rss] of children.get(stack.pop() ?? -1) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid); stack.push(pid); total += rss * 1024;
    }
  }
  return total;
}
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

test("the 16-motor configuration flies a circuit for one simulated hour, with wind, gusts and a complete recording", async ({ page, browser }) => {
  test.setTimeout(6 * 3600_000);
  if (!OUT) throw new Error("MIRAGE_PHASE1_OUT names where the run file goes");
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const startedAt = new Date().toISOString();
  const home = mkdtempSync(join(tmpdir(), "mirage-endurance-"));
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
    await tasks.getByLabel("Task name", { exact: true }).fill("Circuit");
    await tasks.getByLabel("Task type", { exact: true }).selectOption("route");
    const routePoints = await typeCircuit(tasks);
    await tasks.getByRole("button", { name: "Save flight task", exact: true }).click();
    await expect(tasks.getByTestId("task-status")).toHaveText("Saved Circuit, version 1.");

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Flight task", { exact: true }).selectOption({ label: "Circuit (version 1)" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption({ label: "As fast as possible" });
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    const experimentSha256 = (await run.getByTestId("sitl-record").textContent()) ?? "";
    await run.getByRole("button", { name: "Run task", exact: true }).click();

    // Watch it fly: a failure or a pause ends the watch, and the run file says so.
    const stage = run.getByTestId("sitl-stage"), memory = { samples: 0, peakBytes: 0, lastBytes: 0 };
    const flight = { samples: 0, minimumAltitudeM: Number.POSITIVE_INFINITY, maximumAltitudeM: Number.NEGATIVE_INFINITY, taskState: "", armed: false, stateOfCharge: Number.NaN };
    let state = "running", failure: string | null = null, armedAtS: number | null = null;
    for (;;) {
      await page.waitForTimeout(15_000);
      const bytes = applicationMemoryBytes();
      memory.samples++; memory.lastBytes = bytes; memory.peakBytes = Math.max(memory.peakBytes, bytes);
      state = (await stage.getAttribute("data-state")) ?? "unknown";
      if (state === "failed") { failure = (await run.getByTestId("sitl-failure").textContent()) ?? "failed"; break; }
      if (state === "paused" || state === "idle") break;
      const now = await simTime(run);
      // Past the climb, the aircraft is in the circuit: an early landing shows here, whatever the stage says.
      flight.taskState = (await run.getByTestId("task-state").getAttribute("data-state")) ?? "";
      flight.armed = (await run.getByTestId("sitl-armed").textContent()) === "Armed";
      flight.stateOfCharge = Number(/\(([\d.]+) %\)/.exec((await run.getByTestId("power-battery").textContent()) ?? "")?.[1] ?? Number.NaN) / 100;
      if (flight.armed && armedAtS === null) armedAtS = now;
      if (armedAtS !== null && now - armedAtS >= ENDURANCE_CRITERIA.climbS) {
        const altitude = Number.parseFloat((await run.getByTestId("sitl-altitude").textContent()) ?? "NaN");
        flight.samples++;
        flight.minimumAltitudeM = Math.min(flight.minimumAltitudeM, altitude);
        flight.maximumAltitudeM = Math.max(flight.maximumAltitudeM, altitude);
      }
      console.log(`EVID ${new Date().toISOString()} ${now.toFixed(0)} s simulated, ${(bytes / 1e9).toFixed(2)} GB, ${state}, ${(await run.getByTestId("sitl-speed").textContent()) ?? ""}`.slice(0, 200));
      if (now >= ENDURANCE_CRITERIA.simulatedS + MARGIN_S) break;
    }
    // The meter and counters as the hour ended, before the stop changes them.
    const speed = run.getByTestId("sitl-speed");
    const frames = /(\d+) stepped, (\d+) lost, (\d+) resent, (\d+) held/.exec((await run.getByTestId("sitl-frames").textContent()) ?? "") ?? [];
    const simElapsedS = Number(await speed.getAttribute("data-sim-elapsed")), runningWallS = Number(await speed.getAttribute("data-running-wall"));
    const endSimS = await simTime(run), steps = Number(frames[1]);
    const rate = { mode: (await speed.getAttribute("data-mode")) ?? "", averageRatio: Number(await speed.getAttribute("data-average")), simElapsedS, runningWallS,
      executedHz: runningWallS > 0 ? steps / runningWallS : 0, droppedIntervals: await run.getByTestId("sitl-dropped").count(), steps, lost: Number(frames[2]), resent: Number(frames[3]), held: Number(frames[4]) };
    const pauses = await run.getByTestId("sitl-pauses").locator("li").count(), accidents = await run.getByTestId("sitl-accidents").locator("li").count();
    if (state !== "failed") {
      await run.getByRole("button", { name: "Stop run" }).click();
      await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 300_000 });
    }

    const entry = await page.evaluate(async ({ url, experimentSha256 }) => {
      const { listRecordings } = await import(url) as Host;
      for (let i = 0; i < 300; i++) {
        const all = await listRecordings(), found = all.at(-1);
        if (found?.status === "closed") return { found, experimentSha256 };
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return { found: (await listRecordings()).at(-1) ?? null, experimentSha256 };
    }, { url: HOST_URL, experimentSha256 });
    const found = entry.found;
    if (!found) throw new Error("The run has no recording");
    // Periodic physics signals, at the rate the plan gives them and with a source in this run: what the rows are counted against.
    const rates = Object.fromEntries(found.header.signals.filter(signal => signal.source === "physics" && (signal.effectiveHz ?? 0) > 0 && (found.absent[signal.name] ?? 0) === 0).map(signal => [signal.name, signal.effectiveHz ?? 0]));
    const out: EnduranceRun = {
      schema: ENDURANCE_RUN_SCHEMA, configuration: ENDURANCE_CONFIGURATION, startedAt, finishedAt: new Date().toISOString(), chrome: browser.version(),
      profileSha256: Object.values(seeded.profiles)[0] ?? "", experimentSha256, physicsHz: found.header.physicsHz,
      workload: { routePoints, sideM: SIDE_M, speedMps: SPEED_MPS, altitudeM: ALTITUDE_M, batteryCapacityAh: CAPACITY_AH,
        weather: [`Mean wind: ${WIND_MPS} m/s from ${WIND_FROM_DEG}°`, `Synthetic gust: ${GUST_RMS_MPS} m/s RMS, ${GUST_BANDWIDTH_HZ} Hz, seed ${GUST_SEED}`] },
      rate, stage: state, failure, pauses, accidents,
      recording: { status: found.status, bytes: found.bytes, chunks: found.chunks, droppedChunks: found.droppedChunks, droppedRows: found.droppedRows, producerLost: found.producerLost,
        durationS: endSimS, rows: found.rows, rates },
      memory, flight,
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${ENDURANCE_CONFIGURATION}.json`), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`EVID hour ${JSON.stringify({ stage: state, failure, rate, bytes: found.bytes, peakBytes: memory.peakBytes, flight })}`);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
