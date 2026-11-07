import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-187 (S18) on the reference Mac: native ArduCopter fb773567 stands, takes off, flies and lands on real-terrain ground that slopes,
// chosen through the Weather and location tab, with the contact loads and events in its recording. The terrain is the TASK-186 sloped
// fixture with every height scaled about its base by STEEPER, which only changes each tile's height range in its header: 0.95 degrees
// becomes 7.55 degrees, falling to the north and rising to the east. Declared before the first run:
//  - on the ground, before take-off and after landing, the aircraft's tilt is the slope's within 1 degree;
//  - it lands where the task ends: height above the ground under 0.5 m, and the ground's height differs from the home's as the plane says within 0.5 m;
//  - the recording's `truth.contact` holds a load on every support of the quad; at rest they sum to m g cos(slope) within 5 %;
//  - `events.contact` holds a lift-off and then a touchdown, with a descent speed under 3 m/s;
//  - no accident pauses the run. No landing-gear fidelity is claimed.
// Needs the TASK-152 installation; it skips everywhere else.

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
const FIRMWARE_ID = "arducopter-fb773567";
const FIXTURE = new URL("../fixtures/terrain-qm-slope/", import.meta.url);
const EVIDENCE = join(ROOT, "test-results/browser/task-187-terrain-contact.json");
const BASE_M = 120, STEEPER = 8;
/** The fixture's plane scaled: rise per metre north and east at the home's latitude. */
const LATITUDE_DEG = 32.19, LONGITUDE_DEG = 34.8596;
const RISE_NORTH = STEEPER * -1500 / 110900, RISE_EAST = STEEPER * 900 / (111320 * Math.cos(LATITUDE_DEG * Math.PI / 180));
const SLOPE_DEG = Math.atan(Math.hypot(RISE_NORTH, RISE_EAST)) * 180 / Math.PI;
const NORTH_M = 60;
/** The seeded quad's mass and the normal gravity at this latitude, m/s² (WGS84, to the digits a 5 % check needs). */
const MASS_KG = 1.5, GRAVITY_MPS2 = 9.7945;

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

/** Serves the fixture, its tiles' height range scaled about the base: a quantized-mesh height is min + h (max - min) / 32767. */
async function serveSteeper(page: Page): Promise<void> {
  await page.route("**/geodata/terrain/**", async route => {
    const name = new URL(route.request().url()).pathname.replace("/geodata/terrain/", "");
    try {
      const body = readFileSync(new URL(name, FIXTURE));
      if (name.endsWith(".terrain")) {
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength), min = view.getFloat32(24, true), max = view.getFloat32(28, true);
        view.setFloat32(24, BASE_M + STEEPER * (min - BASE_M), true);
        view.setFloat32(28, BASE_M + STEEPER * (max - BASE_M), true);
      }
      await route.fulfill({ status: 200, body, contentType: name.endsWith(".json") ? "application/json" : "application/vnd.quantized-mesh" });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
}
const tiltDeg = (q: readonly number[]): number => {
  const [, x = 0, y = 0] = q;
  return Math.acos(Math.min(1, 1 - 2 * (x * x + y * y))) * 180 / Math.PI;
};

test("a run stands, takes off, flies and lands on sloped real terrain, with its contact loads and events recorded", async ({ page }) => {
  test.setTimeout(900_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  await serveSteeper(page);
  const home = mkdtempSync(join(tmpdir(), "mirage-slope-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const { projectId } = await seedQuadProject(page, "Quad X on a slope");
    await page.getByRole("tab", { name: "Weather and location", exact: true }).click();
    const tab = page.getByRole("tabpanel", { name: "Weather and location", exact: true }), form = tab.getByTestId("location-picker");
    await form.getByLabel("Site", { exact: true }).selectOption("coordinates");
    await form.getByLabel("Latitude (°)", { exact: true }).fill(String(LATITUDE_DEG));
    await form.getByLabel("Longitude (°)", { exact: true }).fill(String(LONGITUDE_DEG));
    await form.getByLabel("Ground elevation above mean sea level (m)", { exact: true }).fill("90");
    await form.getByRole("button", { name: "Save location", exact: true }).click();
    await expect(form.getByTestId("location-status")).toHaveText(/^Saved\./);
    const terrain = tab.getByTestId("terrain-source");
    await expect(terrain.getByTestId("terrain-source-fabdem-elevation")).toHaveAttribute("data-readiness", "ready", { timeout: 30_000 });
    await terrain.getByRole("radio", { name: /^FABDEM/ }).check();
    await terrain.getByLabel(/^Terrain radius around the home/).fill("256");
    await terrain.getByRole("button", { name: "Save the terrain choice" }).click();
    await expect(terrain.getByTestId("terrain-status")).toHaveText(/^Saved\. The next run loads the local terrain/);
    await terrain.getByRole("button", { name: "Use the terrain height as the ground elevation" }).click();
    await expect(form.getByLabel("Ground elevation above mean sea level (m)", { exact: true })).not.toHaveValue("90");

    await page.getByRole("tab", { name: "Flight tasks", exact: true }).click();
    const tasks = page.getByRole("tabpanel", { name: "Flight tasks", exact: true });
    await tasks.getByRole("button", { name: "New flight task", exact: true }).click();
    await tasks.getByLabel("Task name", { exact: true }).fill("Down the slope");
    await tasks.getByLabel("Task type", { exact: true }).selectOption("straight");
    for (const [label, value] of [["Altitude (m)", "12"], ["Heading (°)", "0"], ["Speed (m/s)", "4"], ["Distance (m)", String(NORTH_M)]] as const) {
      await tasks.getByLabel(label, { exact: true }).fill(value);
    }
    await tasks.getByRole("button", { name: "Save flight task", exact: true }).click();
    await expect(tasks.getByTestId("task-status")).toHaveText("Saved Down the slope, version 1.");

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Flight task", { exact: true }).selectOption({ label: "Down the slope (version 1)" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    await run.getByRole("button", { name: "Run task", exact: true }).click();
    await expect(run.getByTestId("task-state")).toHaveAttribute("data-state", "done", { timeout: 600_000 });
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 180_000 });
    await expect(run.getByTestId("sitl-stage")).not.toHaveAttribute("data-state", "paused");
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 60_000 });

    const read = await page.evaluate(async ({ urls, projectId }) => {
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
        const opened = await reopenRecording(recordId);
        const pick = (name: string) => (opened.rows.get(name) ?? []).map(row => ({ t: row.simTimeS, values: row.values === null ? [] : [...row.values] }));
        return { terrain: payload.terrain, attitude: pick("truth.attitude"), position: pick("truth.position"), air: pick("truth.air"), contact: pick("truth.contact"),
          contactEvents: pick("events.contact"), accidents: pick("events.accident") };
      } finally {
        store.close();
      }
    }, { urls, projectId });

    expect(read.accidents).toEqual([]);
    // On the ground before take-off and after landing.
    const firstAttitude = read.attitude[Math.min(50, read.attitude.length - 1)], lastAttitude = read.attitude.at(-1);
    const startTilt = tiltDeg(firstAttitude?.values ?? []), endTilt = tiltDeg(lastAttitude?.values ?? []);
    const lastPosition = read.position.at(-1)?.values ?? [], lastAir = read.air.at(-1)?.values ?? [];
    const [northM = Number.NaN, eastM = Number.NaN, downM = Number.NaN] = lastPosition;
    const expectedDown = -(RISE_NORTH * northM + RISE_EAST * eastM);
    const lastLoads = read.contact.at(-1)?.values ?? [], total = lastLoads.reduce((sum, x) => sum + x, 0);
    const peakLoad = Math.max(...read.contact.map(row => row.values.reduce((sum, x) => sum + x, 0)));
    const expectedLoad = MASS_KG * GRAVITY_MPS2 * Math.cos(SLOPE_DEG * Math.PI / 180);
    const codes = read.contactEvents.map(row => row.values[0]);
    const liftOff = codes.indexOf(2), touchdown = codes.lastIndexOf(1);
    const descent = read.contactEvents[touchdown]?.values[1] ?? Number.NaN;
    // The evidence goes first, so that a run that misses a limit keeps its numbers.
    mkdirSync(join(ROOT, "test-results/browser"), { recursive: true });
    writeFileSync(EVIDENCE, `${JSON.stringify({ task: "TASK-187", firmware: FIRMWARE_ID, slopeDeg: SLOPE_DEG, startTiltDeg: startTilt, endTiltDeg: endTilt,
      landedAt: { northM, eastM, downM, expectedDownM: expectedDown, heightAboveGroundM: lastAir[2] }, restingLoadsN: lastLoads, restingTotalN: total, peakTotalN: peakLoad,
      expectedRestingN: expectedLoad, contactRows: read.contact.length, events: read.contactEvents.map(row => ({ t: row.t, code: row.values[0], value: row.values[1] })),
      path: read.position.filter((_, i) => i % 100 === 0).map(row => [row.t, ...row.values]) }, null, 2)}\n`);
    expect(read.terrain).toMatchObject({ sourceId: "fabdem-elevation", missingChunks: 0 });
    expect(Math.abs(startTilt - SLOPE_DEG), "tilt before take-off").toBeLessThan(1);
    expect(Math.abs(endTilt - SLOPE_DEG), "tilt after landing").toBeLessThan(1);
    // It landed where the task ended, on the ground there.
    // The task ends after its 60 m with ArduPilot braking from 4 m/s, which is no part of this check; the ground under the landing is.
    expect(northM, "past the task's distance").toBeGreaterThan(NORTH_M);
    expect(northM, "within its braking").toBeLessThan(NORTH_M + 30);
    expect(lastAir[2] ?? Number.NaN, "height above the ground").toBeLessThan(0.5);
    expect(Math.abs(downM - expectedDown), "ground under the landing").toBeLessThan(0.5);
    // The loads: all four supports carry it at rest, m g cos(slope).
    expect(lastLoads.slice(0, 4).every(load => load > 0), "every support carries a load").toBe(true);
    expect(Math.abs(total - expectedLoad) / expectedLoad, "the load at rest").toBeLessThan(0.05);
    // The events: lifted off, then touched down at a gentle speed.
    // What it stands on at the start is no touchdown: the first event is the lift-off.
    expect(liftOff, "the first event a lift-off").toBe(0);
    expect(touchdown, "a touchdown after it").toBeGreaterThan(liftOff);
    expect(descent).toBeGreaterThan(0);
    expect(descent).toBeLessThan(3);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
