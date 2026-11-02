import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { planOf, DEFAULT_LOGGING } from "../../apps/web/src/logging/logging-settings";
import { estimatedBytes, estimateRecording, megabytes, RUN_TAB_SOURCES } from "../../apps/web/src/logging/size-estimate";
import { createProject } from "../support/aircraft-ui";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-163 (S13): the Logging tab through the UI alone. The estimate it shows
// is the size estimate of its plan, computed here in Node from the same
// modules; a low quota is the browser's storage estimate replaced before the
// page loads. With the TASK-152 installation a Run-tab flight with native
// ArduCopter records with the tab's settings, and its stored record is
// compared with the estimate within a tolerance declared here: every physics
// signal's row count is exact for the recorded ticks, and the stored bytes
// are within 10 % of the estimate for the recorded simulated time plus the
// parameter snapshot, since autopilot telemetry arrives at most at its rate.

type Host = typeof import("../../packages/aar/src/recorder-v2-host");
type Store = typeof import("../../packages/project/src/store");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
const urls = {
  host: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
};
const TOLERANCE = 0.1;
const tab = (page: Page) => page.getByRole("tabpanel", { name: "Logging", exact: true });

async function openLogging(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Logging", exact: true }).click();
  await expect(tab(page).getByLabel("Common rate (Hz)", { exact: true })).toHaveValue("50");
}

test("the Logging tab plans every signal at 50 Hz, refuses unsupported rates with a reason, saves overrides and warns of a low quota", async ({ page }) => {
  // Low quota: 600 MB, 50 MB of it used, so the 500 MB reserve leaves 50 MB.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "estimate", { value: () => Promise.resolve({ quota: 600e6, usage: 50e6 }) });
  });
  await page.goto("/");
  await createProject(page, "Logging checks");
  await openLogging(page);
  const panel = tab(page);
  const estimate = estimateRecording(planOf(DEFAULT_LOGGING, 800), RUN_TAB_SOURCES);
  await expect(panel.getByTestId("logging-per-hour")).toHaveText(`${megabytes(estimate.bytesPerSimHour)} at most`);
  await expect(panel.getByTestId("logging-total")).toHaveText(`${megabytes(estimatedBytes(estimate, 3600))} at most`);
  await expect(panel.getByTestId("effective-truth.position")).toHaveText("50 Hz");
  await expect(panel.getByTestId("effective-autopilot.attitude")).toHaveText("10 Hz (limited to the source's 10 Hz)");
  await expect(panel.getByTestId("effective-sensors.imu")).toHaveText("50 Hz (not produced in a Run-tab run)");
  // The hour needs more than the 50 MB beyond the reserve: warned before any run.
  await expect(panel.getByTestId("logging-free")).toHaveText(`${megabytes(550e6)} of ${megabytes(600e6)}`);
  await expect(panel.getByRole("list", { name: "Storage warnings" })).toContainText(
    `needs about ${megabytes(estimatedBytes(estimate, 3600))}, but only ${megabytes(50e6)} is free beyond the ${megabytes(500e6)} reserve`);

  // Unsupported rates are refused with the reason, and nothing can be saved.
  const save = panel.getByRole("button", { name: "Save logging settings", exact: true });
  const motors = panel.getByLabel("Motors (Hz)", { exact: true }), problems = panel.getByRole("list", { name: "Rates that cannot be recorded" });
  await motors.fill("2500");
  await expect(problems).toContainText("groups.motors: a rate is 0 or a whole number of hertz from 1 to 2000");
  await expect(save).toBeDisabled();
  await motors.fill("1.5");
  await expect(problems).toContainText('Motors rate: "1.5" is not a whole number of hertz');
  await expect(save).toBeDisabled();
  // 2 kHz is offered, and a source that produces less records at its own rate.
  await motors.fill("2000");
  await expect(problems).toHaveCount(0);
  await expect(panel.getByTestId("effective-motors.speed")).toHaveText("800 Hz (limited to the source's 800 Hz)");
  await panel.getByLabel("truth.position override (Hz)", { exact: true }).fill("800");
  await panel.getByLabel("Run length (simulated minutes)", { exact: true }).fill("10");
  const planned = estimateRecording(planOf({ ...DEFAULT_LOGGING, groups: { motors: 2000 }, signals: { "truth.position": 800 }, durationMin: 10 }, 800), RUN_TAB_SOURCES);
  await expect(panel.getByTestId("logging-per-hour")).toHaveText(`${megabytes(planned.bytesPerSimHour)} at most`);
  await save.click();
  await expect(panel.getByTestId("logging-status")).toHaveText("Saved. The next run records with these rates.");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".logging-panel").analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 900 });

  // After a reload the saved settings come back.
  await page.reload();
  await openLogging(page);
  await expect(tab(page).getByLabel("Motors (Hz)", { exact: true })).toHaveValue("2000");
  await expect(tab(page).getByLabel("truth.position override (Hz)", { exact: true })).toHaveValue("800");
  await expect(tab(page).getByLabel("Run length (simulated minutes)", { exact: true })).toHaveValue("10");
});

const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";

test("a Run-tab run records with the Logging tab's settings, shows its growth, and its record matches the estimate", async ({ page }) => {
  test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
  test.setTimeout(600000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-logging-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const seeded = await seedQuadProject(page, "Quad X recorded");
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 180000 });

    // The Logging tab shows the recording growing, with no gap.
    await openLogging(page);
    const live = tab(page).getByTestId("logging-live");
    await expect(live).toHaveAttribute("data-state", "recording");
    await expect(tab(page).getByTestId("logging-growth")).toContainText("per simulated hour", { timeout: 30000 });
    await expect(tab(page).getByTestId("logging-growth")).toContainText("per real second");
    await expect(tab(page).getByTestId("logging-gaps")).toHaveText("None");
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30000 });
    await openLogging(page);
    await expect(live).toHaveAttribute("data-state", "closed", { timeout: 30000 });

    const result = await page.evaluate(async ({ urls, projectId }) => {
      const { listRecordings, reopenRecording } = await import(urls.host) as Host;
      const { ProjectStore } = await import(urls.store) as Store;
      const { readExperiment } = await import(urls.experiment) as Experiments;
      const store = await ProjectStore.openIndexedDb();
      try {
        const [stored] = await store.listItems(projectId, "experiment");
        if (!stored) throw new Error("No experiment record");
        const payload = readExperiment(stored);
        const recordId = payload.recording?.recordId ?? "";
        const entry = (await listRecordings()).find(item => item.recordId === recordId);
        const opened = await reopenRecording(recordId);
        const rows = Object.fromEntries([...opened.rows.entries()].map(([name, list]) => [name, list.length]));
        const lastTick = Math.max(...[...opened.rows.values()].flat().map(row => row.tick));
        const firstTime = Math.min(...(opened.rows.get("truth.position") ?? []).map(row => row.simTimeS));
        const lastTime = Math.max(...(opened.rows.get("truth.position") ?? []).map(row => row.simTimeS));
        return { recording: payload.recording, launcherId: payload.sitl.ownership === "launcher" ? payload.sitl.experimentId : null,
          header: { experimentId: opened.header.experimentId, physicsHz: opened.header.physicsHz }, status: entry?.status ?? null, bytes: entry?.bytes ?? 0,
          producerLost: entry?.producerLost ?? -1, rows, lastTick, firstTime, lastTime, parameters: payload.parameters.length,
          missing: opened.missingChunks.length, corrupt: opened.corruptChunks.length };
      } finally {
        store.close();
      }
    }, { urls, projectId: seeded.projectId });
    // The experiment record names its recording and the Logging tab's settings; the recording names the run.
    expect(result.recording).toEqual({ recordId: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown, commonHz: 50, groups: {}, signals: {}, durationMin: 60, reserveMb: 500 });
    expect(result.header).toEqual({ experimentId: result.launcherId, physicsHz: 800 });
    expect([result.status, result.producerLost, result.missing, result.corrupt]).toEqual(["closed", 0, 0, 0]);
    // Every physics signal kept exactly floor(ticks · 50 / 800) samples of the ticks recorded from the first.
    const kept = Math.floor(result.lastTick * 50 / 800);
    for (const name of ["truth.position", "truth.attitude", "pilot", "actuators", "motors.speed", "battery"]) {
      expect([name, result.rows[name]]).toEqual([name, kept]);
    }
    expect(result.rows["events.parameter"]).toBe(result.parameters);
    expect(result.rows["autopilot.ekf"] ?? 0).toBeGreaterThan(0);
    expect(result.rows["sensors.imu"]).toBeUndefined();
    const estimate = estimateRecording(planOf(DEFAULT_LOGGING, 800), RUN_TAB_SOURCES);
    const expected = estimatedBytes(estimate, result.lastTick / 800) + result.parameters * 64;
    expect(Math.abs(result.bytes - expected) / expected).toBeLessThan(TOLERANCE);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
