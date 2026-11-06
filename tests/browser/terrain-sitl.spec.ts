import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-186 (S17) on the reference Mac: native ArduCopter 8ab6afde flies a real-terrain run chosen through the Weather and location
// tab, and the run pauses where its loaded terrain ends. Declared before the first run:
//  - with a 256 m radius the lattice is the four chunks around the home, so its ground ends 512 m north; with the 8 m readiness radius
//    the first tick whose position is 504 m or more north pauses the run: the reported north lies in [504, 504.02] m (a tick's travel
//    at under 16 m/s and 800 Hz) and its east within 8 m of the straight path;
//  - the run is paused with reason terrain, Resume is refused with its reason, and ArduPilot's simulated time stands still over 3 s
//    of wall time while it waits in lockstep;
//  - the recording's last truth position is at most 504.02 m north, and the experiment record holds the terrain: four chunks, none
//    missing, level 14, the served layer's and manifest's SHA-256;
//  - with MIRAGE_GEODATA_DIR serving the local FABDEM output, a hover at the area of operation runs on it without a pause.
// The first test serves the sloped quantized-mesh fixture at /geodata/terrain/ (as the dev server serves MIRAGE_GEODATA_DIR), with the
// home inside it. Needs the TASK-152 installation; it skips everywhere else.

type Host = typeof import("../../packages/aar/src/recorder-v2-host");
type Store = typeof import("../../packages/project/src/store");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
const urls = {
  host: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";
const FIXTURE = new URL("../fixtures/terrain-qm-slope/", import.meta.url);
const EVIDENCE = join(ROOT, "test-results/browser/task-186-terrain-sitl.json");
const FABDEM_EVIDENCE = join(ROOT, "test-results/browser/task-186-fabdem-sitl.json");
/** The terrain ends 512 m north; the run pauses once the 8 m square around the vehicle crosses it. */
const EDGE_M = 512 - 8, TICK_TRAVEL_M = 16 / 800;
const GEODATA = process.env.MIRAGE_GEODATA_DIR;

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

async function serveFixture(page: Page): Promise<void> {
  await page.route("**/geodata/terrain/**", async route => {
    const name = new URL(route.request().url()).pathname.replace("/geodata/terrain/", "");
    try {
      await route.fulfill({ status: 200, body: readFileSync(new URL(name, FIXTURE)), contentType: name.endsWith(".json") ? "application/json" : "application/vnd.quantized-mesh" });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
}
async function locate(page: Page, latitudeDeg: number, longitudeDeg: number, groundElevationMslM: number, radiusM: number): Promise<void> {
  await page.getByRole("tab", { name: "Weather and location", exact: true }).click();
  const tab = page.getByRole("tabpanel", { name: "Weather and location", exact: true }), form = tab.getByTestId("location-picker");
  await form.getByLabel("Site", { exact: true }).selectOption("coordinates");
  await form.getByLabel("Latitude (°)", { exact: true }).fill(String(latitudeDeg));
  await form.getByLabel("Longitude (°)", { exact: true }).fill(String(longitudeDeg));
  await form.getByLabel("Ground elevation above mean sea level (m)", { exact: true }).fill(String(groundElevationMslM));
  await form.getByRole("button", { name: "Save location", exact: true }).click();
  await expect(form.getByTestId("location-status")).toHaveText(/^Saved\./);
  const terrain = tab.getByTestId("terrain-source");
  await expect(terrain.getByTestId("terrain-source-fabdem-elevation")).toHaveAttribute("data-readiness", "ready", { timeout: 30_000 });
  await terrain.getByRole("radio", { name: /^FABDEM/ }).check();
  await terrain.getByLabel(/^Terrain radius around the home/).fill(String(radiusM));
  await terrain.getByRole("button", { name: "Save the terrain choice" }).click();
  await expect(terrain.getByTestId("terrain-status")).toHaveText(/^Saved\. The next run loads the local terrain/);
  // TASK-187: the aircraft stands on this terrain, so the location's elevation is the terrain's there, through the tab.
  await terrain.getByRole("button", { name: "Use the terrain height as the ground elevation" }).click();
  await expect(form.getByLabel("Ground elevation above mean sea level (m)", { exact: true })).not.toHaveValue(String(groundElevationMslM));
}
async function launch(page: Page, port: number, token: string, task: string | null) {
  await page.getByRole("tab", { name: "Run", exact: true }).click();
  await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
  const run = page.getByRole("region", { name: "ArduPilot SITL" });
  if (task) await run.getByLabel("Flight task", { exact: true }).selectOption({ label: `${task} (version 1)` });
  await run.getByLabel("Launcher port", { exact: true }).fill(String(port));
  await run.getByLabel("Launcher token", { exact: true }).fill(token);
  await run.getByRole("button", { name: "List ArduPilot builds" }).click();
  await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
  await run.getByLabel("Speed").selectOption("4");
  await run.getByRole("button", { name: "Start SITL run" }).click();
  await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
  expect(await page.evaluate(() => location.href)).not.toContain(token);
  return run;
}
/** The project's experiment record and the last truth position of its recording. */
async function readback(page: Page, projectId: string) {
  return page.evaluate(async ({ urls, projectId }) => {
    const { listRecordings, reopenRecording } = await import(urls.host) as Host;
    const { ProjectStore } = await import(urls.store) as Store;
    const { readExperiment } = await import(urls.experiment) as Experiments;
    const store = await ProjectStore.openIndexedDb();
    try {
      const [stored] = await store.listItems(projectId, "experiment");
      if (!stored) throw new Error("No experiment record");
      const payload = readExperiment(stored), recordId = payload.recording?.recordId ?? "";
      for (let i = 0; i < 100; i++) {
        if ((await listRecordings()).find(entry => entry.recordId === recordId)?.status === "closed") break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const opened = await reopenRecording(recordId), positions = opened.rows.get("truth.position") ?? [];
      const last = positions.at(-1);
      return { sha256: stored.sha256, terrain: payload.terrain, lastNorthM: last?.values?.[0] ?? Number.NaN, lastEastM: last?.values?.[1] ?? Number.NaN,
        maxNorthM: positions.reduce((max, row) => Math.max(max, row.values?.[0] ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY) };
    } finally {
      store.close();
    }
  }, { urls, projectId });
}
async function withLauncher<T>(body: (port: number, token: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "mirage-terrain-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try { return await body(launcher.port, token); } finally { await launcher.close(); rmSync(home, { recursive: true, force: true }); }
}
const simTime = async (run: ReturnType<Page["getByRole"]>) => Number.parseFloat((await run.getByTestId("sitl-sim-time").textContent()) ?? "NaN");

test("a straight flight off the loaded terrain pauses the run where the terrain ends, and it cannot resume", async ({ page }) => {
  test.setTimeout(900_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  await serveFixture(page);
  await withLauncher(async (port, token) => {
    const seeded = await seedQuadProject(page, "Quad X on terrain");
    await locate(page, 32.19, 34.8596, 90, 256);
    // A straight flight 700 m north at 10 m and 8 m/s: beyond the 512 m the terrain holds.
    await page.getByRole("tab", { name: "Flight tasks", exact: true }).click();
    const tasks = page.getByRole("tabpanel", { name: "Flight tasks", exact: true });
    await tasks.getByRole("button", { name: "New flight task", exact: true }).click();
    await tasks.getByLabel("Task name", { exact: true }).fill("North 700 m");
    await tasks.getByLabel("Task type", { exact: true }).selectOption("straight");
    for (const [label, value] of [["Altitude (m)", "10"], ["Heading (°)", "0"], ["Speed (m/s)", "8"], ["Distance (m)", "700"]] as const) {
      await tasks.getByLabel(label, { exact: true }).fill(value);
    }
    await tasks.getByRole("button", { name: "Save flight task", exact: true }).click();
    await expect(tasks.getByTestId("task-status")).toHaveText("Saved North 700 m, version 1.");

    const run = await launch(page, port, token, "North 700 m");
    await run.getByRole("button", { name: "Run task", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "paused", { timeout: 600_000 });
    await expect(run.getByTestId("sitl-pause-hint")).toContainText("no terrain is loaded under the aircraft");
    const where = (await run.getByTestId("sitl-terrain-missing").textContent()) ?? "";
    const [, northText, eastText] = /ended at ([-\d.]+) m north and ([-\d.]+) m east/.exec(where) ?? [];
    const northM = Number(northText), eastM = Number(eastText);
    expect(northM).toBeGreaterThanOrEqual(EDGE_M - 0.05);
    expect(northM).toBeLessThanOrEqual(EDGE_M + TICK_TRAVEL_M + 0.05);
    expect(Math.abs(eastM)).toBeLessThan(8);
    // Resume is refused, and ArduPilot's simulated time waits with the physics.
    const before = await simTime(run);
    await run.getByRole("button", { name: "Resume", exact: true }).click();
    await page.waitForTimeout(3000);
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "paused");
    expect(await simTime(run)).toBe(before);
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30_000 });

    const read = await readback(page, seeded.projectId);
    const sha = (name: string) => createHash("sha256").update(readFileSync(new URL(name, FIXTURE))).digest("hex");
    expect(read.terrain).toMatchObject({ sourceId: "fabdem-elevation", radiusM: 256, chunks: 4, missingChunks: 0, level: 14,
      layerSha256: sha("layer.json"), manifestSha256: sha("terrain-manifest.json") });
    expect(read.maxNorthM).toBeLessThanOrEqual(EDGE_M + TICK_TRAVEL_M + 0.05);
    mkdirSync(dirname(EVIDENCE), { recursive: true });
    writeFileSync(EVIDENCE, `${JSON.stringify({ task: "TASK-186", firmware: FIRMWARE_ID, record: read.sha256, terrain: read.terrain, pausedAt: { northM, eastM },
      recordedMaxNorthM: read.maxNorthM, lastNorthM: read.lastNorthM, lastEastM: read.lastEastM, simTimeHeldS: before }, null, 2)}\n`);
  });
});

test("with the local FABDEM output served, a hover at the area of operation stands on it without a pause", async ({ page }) => {
  test.skip(!GEODATA || !existsSync(join(GEODATA, "terrain", "layer.json")), "Needs MIRAGE_GEODATA_DIR with terrain/ from scripts/geodata/build_terrain.py, set before the dev server starts");
  test.setTimeout(900_000);
  const config = JSON.parse(readFileSync("config/geodata.json", "utf8")) as { area: { centerLatDeg: number; centerLonDeg: number } };
  await withLauncher(async (port, token) => {
    const seeded = await seedQuadProject(page, "Quad X on FABDEM");
    // Rounded to the location's six decimals; `locate` takes the elevation from the terrain itself, through the tab.
    await locate(page, Number(config.area.centerLatDeg.toFixed(6)), Number(config.area.centerLonDeg.toFixed(6)), 50, 1000);
    const run = await launch(page, port, token, null);
    await run.getByLabel("Take-off altitude, m").fill("5");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect.poll(async () => Number.parseFloat((await run.getByTestId("sitl-altitude").textContent()) ?? "NaN"), { timeout: 120_000 }).toBeGreaterThan(4.5);
    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 180_000 });
    await expect(run.getByTestId("sitl-terrain-missing")).toHaveCount(0);
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
    const read = await readback(page, seeded.projectId);
    expect(read.terrain?.sourceId).toBe("fabdem-elevation");
    expect(read.terrain?.chunks).toBeGreaterThan(0);
    expect(read.terrain?.homeHeightM).not.toBeNull();
    const served = (name: string) => createHash("sha256").update(readFileSync(join(GEODATA ?? "", "terrain", name))).digest("hex");
    mkdirSync(dirname(FABDEM_EVIDENCE), { recursive: true });
    writeFileSync(FABDEM_EVIDENCE, `${JSON.stringify({ task: "TASK-186", firmware: FIRMWARE_ID, record: read.sha256, terrain: read.terrain, area: config.area,
      layerSha256: served("layer.json"), manifestSha256: served("terrain-manifest.json"), lastNorthM: read.lastNorthM, lastEastM: read.lastEastM }, null, 2)}\n`);
  });
});
