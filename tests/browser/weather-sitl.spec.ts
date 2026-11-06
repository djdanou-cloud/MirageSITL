import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-167 (S07) on the reference Mac: wind set by hand on a running native ArduCopter 8ab6afde session through the Weather and
// location tab alone, observed and removed, and a scheduled discrete gust that lands on its tick. Declared before the first run:
//  - a steady wind of 6 m/s from the west, applied while the aircraft holds its hover, raises the recorded true airspeed to within
//    1.5 m/s of 6 m/s while the ground speed stays below 1.5 m/s, averaged over 10 s that start 10 s after it was applied; turned off,
//    the airspeed falls back below 1.5 m/s over the same kind of window;
//  - the discrete gust scheduled 25 s after arming is applied on the tick of arming + 25 s (the ledger's applied time equals its meant
//    time), and within its 2 s the recorded airspeed rises by more than 2 m/s over the 1 s before it;
//  - the experiment keeps the schedule, its seeds and streams, and the effect log keeps each change with its values.
// Needs the TASK-152 installation; it skips everywhere else.

type Host = typeof import("../../packages/aar/src/recorder-v2-host");
type Store = typeof import("../../packages/project/src/store");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
type EffectLogs = typeof import("../../apps/web/src/faults/effect-log");
const urls = {
  host: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
  effectLog: viteFileUrl(new URL("../../apps/web/src/faults/effect-log.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";
const EVIDENCE = join(ROOT, "test-results/browser/task-167-weather-sitl.json");

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

interface Readback {
  readonly weather: unknown;
  readonly logParameters: { effect: string; enabled: boolean; parameters: unknown }[];
  readonly air: { simTimeS: number; airspeed: number }[];
  readonly ground: { simTimeS: number; speed: number }[];
}
async function readback(page: Page, projectId: string): Promise<Readback> {
  return page.evaluate(async ({ urls, projectId }) => {
    const { listRecordings, reopenRecording } = await import(urls.host) as Host;
    const { ProjectStore } = await import(urls.store) as Store;
    const { readExperiment } = await import(urls.experiment) as Experiments;
    const { readEffectLog } = await import(urls.effectLog) as EffectLogs;
    const store = await ProjectStore.openIndexedDb();
    try {
      const [stored] = await store.listItems(projectId, "experiment");
      if (!stored) throw new Error("No experiment record");
      const payload = readExperiment(stored), recordId = payload.recording?.recordId ?? "";
      for (let i = 0; i < 100; i++) {
        if ((await listRecordings()).find(entry => entry.recordId === recordId)?.status === "closed") break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const [log] = await store.listItems(projectId, "effect-log");
      const opened = await reopenRecording(recordId);
      return {
        weather: JSON.parse(JSON.stringify(payload.weather)) as unknown,
        logParameters: log ? readEffectLog(log).entries.map(entry => ({ effect: entry.effect, enabled: entry.enabled, parameters: entry.parameters })) : [],
        air: (opened.rows.get("truth.air") ?? []).map(row => ({ simTimeS: row.simTimeS, airspeed: row.values?.[0] ?? Number.NaN })),
        ground: (opened.rows.get("truth.velocity") ?? []).map(row => ({ simTimeS: row.simTimeS, speed: Math.hypot(row.values?.[0] ?? Number.NaN, row.values?.[1] ?? Number.NaN) })),
      };
    } finally {
      store.close();
    }
  }, { urls, projectId });
}
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const window_ = <T extends { simTimeS: number }>(rows: readonly T[], fromS: number, toS: number) => rows.filter(row => row.simTimeS >= fromS && row.simTimeS < toS);

test("wind set by hand on a running SITL session is felt and removed, and a scheduled discrete gust lands on its tick", async ({ page }) => {
  test.setTimeout(900_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-weather-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const { projectId } = await seedQuadProject(page, "Quad X in the wind");
    // The schedule: a discrete gust from the north, 25 s after arming.
    await page.getByRole("tab", { name: "Weather and location", exact: true }).click();
    const weather = page.getByRole("tabpanel", { name: "Weather and location", exact: true }).getByTestId("weather-panel");
    await weather.getByLabel("Amplitude, m/s", { exact: true }).fill("6");
    await weather.getByLabel("Duration, s", { exact: true }).fill("2");
    await weather.getByLabel("Gust from, ° (bearing)", { exact: true }).fill("0");
    await weather.getByLabel("Onset, s after arming", { exact: true }).fill("25");
    await weather.getByLabel("Duration, s (empty: until the run ends)", { exact: true }).fill("2");
    await weather.getByRole("button", { name: "Add the discrete gust to the schedule" }).click();
    await expect(weather.getByTestId("weather-schedule").locator("tbody tr")).toHaveCount(1);

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    await run.getByLabel("Take-off altitude, m").fill("10");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveText("Flying", { timeout: 180_000 });

    // By hand, on the run going now: a steady wind of 6 m/s from the west.
    await page.getByRole("tab", { name: "Weather and location", exact: true }).click();
    await weather.getByLabel("Speed, m/s", { exact: true }).fill("6");
    await weather.getByLabel("From, ° (bearing)", { exact: true }).fill("270");
    await weather.getByRole("button", { name: "Apply the steady wind now" }).click();
    const ledger = weather.getByTestId("weather-ledger");
    const row = (effect: string, on: boolean, origin: string) => ledger.locator(`tr[data-effect="${effect}"][data-enabled="${on}"][data-origin="${origin}"]`);
    await expect(row("wind.mean", true, "manual")).toHaveAttribute("data-status", "applied", { timeout: 30_000 });
    await expect(weather.getByTestId("weather-now").locator('li[data-effect="wind.mean"]')).toHaveText("Mean wind: 6.0 m/s from 270°");
    const onAt = Number(await row("wind.mean", true, "manual").locator("td").nth(3).textContent());
    // The scheduled gust lands on its tick: applied at the time it was meant for.
    await expect(row("wind.discrete-gust", true, "schedule")).toHaveAttribute("data-status", "applied", { timeout: 180_000 });
    const gustMeant = Number(await row("wind.discrete-gust", true, "schedule").locator("td").nth(2).textContent());
    const gustAt = Number(await row("wind.discrete-gust", true, "schedule").locator("td").nth(3).textContent());
    expect(gustAt).toBe(gustMeant);
    // Hold the wind for 25 s of simulated time, then take it away.
    await expect.poll(async () => Number.parseFloat((await run.getByTestId("sitl-sim-time").textContent()) ?? "NaN"), { timeout: 120_000 }).toBeGreaterThan(onAt + 25);
    await weather.getByRole("button", { name: "Turn the steady wind off" }).click();
    await expect(row("wind.mean", false, "manual")).toHaveAttribute("data-status", "applied", { timeout: 30_000 });
    const offAt = Number(await row("wind.mean", false, "manual").locator("td").nth(3).textContent());
    await expect(weather.getByTestId("weather-now").locator('li[data-effect="wind.mean"]')).toHaveText("Steady wind: off");
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await expect.poll(async () => Number.parseFloat((await run.getByTestId("sitl-sim-time").textContent()) ?? "NaN"), { timeout: 120_000 }).toBeGreaterThan(offAt + 21);
    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 180_000 });
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 60_000 });

    const read = await readback(page, projectId);
    const airIn = (from: number, to: number) => mean(window_(read.air, from, to).map(row => row.airspeed));
    const groundIn = (from: number, to: number) => mean(window_(read.ground, from, to).map(row => row.speed));
    const windy = airIn(onAt + 10, onAt + 20), windyGround = groundIn(onAt + 10, onAt + 20), calm = airIn(offAt + 10, offAt + 20);
    expect(Math.abs(windy - 6)).toBeLessThan(1.5);
    expect(windyGround).toBeLessThan(1.5);
    expect(calm).toBeLessThan(1.5);
    const beforeGust = airIn(gustAt - 1, gustAt), gustPeak = Math.max(...window_(read.air, gustAt, gustAt + 2).map(row => row.airspeed));
    expect(gustPeak - beforeGust).toBeGreaterThan(2);
    // The record keeps the schedule with its streams; the log keeps each change with its values.
    expect(read.weather).toMatchObject({ schemaVersion: 1, streams: { gust: [0, 1, 2] }, entries: [{ onsetS: 25, durationS: 2, control: { effect: "wind.discrete-gust",
      parameters: { amplitudeMps: 6, durationS: 2, fromDeg: 0, upwardDeg: 0 } } }] });
    expect(read.logParameters.filter(entry => entry.effect === "wind.mean")).toEqual([
      { effect: "wind.mean", enabled: true, parameters: { windNedMps: [expect.closeTo(0, 9), 6, 0] } },
      { effect: "wind.mean", enabled: false, parameters: { windNedMps: [expect.closeTo(0, 9), 6, 0] } }]);

    mkdirSync(join(ROOT, "test-results/browser"), { recursive: true });
    writeFileSync(EVIDENCE, `${JSON.stringify({ task: "TASK-167", windOnAtS: onAt, windOffAtS: offAt, windyAirspeedMps: windy, windyGroundSpeedMps: windyGround, calmAirspeedMps: calm,
      gustMeantS: gustMeant, gustAppliedS: gustAt, gustRiseMps: gustPeak - beforeGust }, null, 2)}\n`);
    console.log(`EVID ${readFileSync(EVIDENCE, "utf8")}`);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
