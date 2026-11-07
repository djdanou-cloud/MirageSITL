import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";
import { COMPLETION } from "../../packages/scenarios/src/flight-tasks";

// TASK-172 (S10): the Flight tasks tab and its route editor, through the
// application alone. A route typed, reordered and saved reads back unchanged
// after a reload, and saving it again adds no version. Then a stored route with
// a ground start away from the pad is flown by native ArduCopter fb773567 from
// the Run tab: the recording's first truth rows hold the ground values, ArduPilot
// acknowledges the mission, requested and actual are shown side by side and
// recorded, the experiment record holds the definition, and Repeat flies the
// same task. The quad flies with the 40 Hz gyro filter of decision A-13, written
// through the Parameters tab.

type Store = typeof import("../../packages/project/src/store");
type Host = typeof import("../../packages/aar/src/recorder-v2-host");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  host: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";

const tasksPanel = (page: Page): Locator => page.getByRole("tabpanel", { name: "Flight tasks", exact: true });
async function openTasks(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: "Flight tasks", exact: true }).click();
  return tasksPanel(page);
}
/** Types the route's points, adding rows beyond the example's two. */
async function typeRoute(panel: Locator, points: readonly (readonly [string, string, string, string])[]): Promise<void> {
  for (const [i, point] of points.entries()) {
    if (i >= 2) await panel.getByRole("button", { name: "Add point", exact: true }).click();
    for (const [j, field] of ["north (m)", "east (m)", "altitude (m)", "speed (m/s)"].entries()) {
      await panel.getByLabel(`Point ${i + 1} ${field}`, { exact: true }).fill(point[j] ?? "");
    }
  }
}
async function storedTasks(page: Page, projectId: string): Promise<{ name: string; version: number; payload: unknown }[]> {
  return page.evaluate(async ({ urls, projectId }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const store = await ProjectStore.openIndexedDb();
    try {
      return (await store.listItems(projectId, "flight-task")).map(item => ({ name: item.record.name, version: item.record.version, payload: item.record.payload }));
    } finally { store.close(); }
  }, { urls, projectId });
}

test("the route editor round-trips, and every task type words its plan", async ({ page }) => {
  const { projectId } = await seedQuadProject(page, "Quad X tasks");
  const panel = await openTasks(page);
  const problems = panel.getByRole("list", { name: "Problems to fix before saving" });
  const save = panel.getByRole("button", { name: "Save flight task", exact: true });
  // A name is needed, and an example of each type is valid until it is changed.
  await expect(save).toBeDisabled();
  await panel.getByLabel("Task name", { exact: true }).fill("Square");
  for (const type of ["takeoff", "hover", "landing", "straight", "climb", "descent", "acceleration", "braking", "turn", "route"]) {
    await panel.getByLabel("Task type", { exact: true }).selectOption(type);
    await expect(problems).toHaveCount(0);
    await expect(panel.getByTestId("task-plan").locator('li[data-measured="true"]').first()).toBeVisible();
  }
  // A route's rows: an empty point is no zero.
  await panel.getByRole("button", { name: "Add point", exact: true }).click();
  await expect(problems).toContainText("Route point 3: north must be a number from -5000 to 5000");
  await expect(save).toBeDisabled();
  await panel.getByRole("button", { name: "Remove point 3", exact: true }).click();
  await typeRoute(panel, [["20.5", "0", "8", "4"], ["20.5", "30.25", "12", "6"], ["0", "30.25", "6.5", "3"]]);
  // Reordered: the third point becomes the second.
  await panel.getByRole("button", { name: "Move point 3 up", exact: true }).click();
  await panel.getByLabel("Start north of the pad (m)", { exact: true }).fill("10");
  await panel.getByLabel("Start east of the pad (m)", { exact: true }).fill("-5");
  await panel.getByLabel("Start heading (°)", { exact: true }).fill("90");
  await panel.getByLabel("Battery charge (%)", { exact: true }).fill("33.3");
  await expect(panel.getByLabel("Start in the air", { exact: true })).toBeDisabled();
  await save.click();
  await expect(panel.getByTestId("task-status")).toHaveText("Saved Square, version 1.");
  const expected = {
    schemaVersion: 1, type: "route", parameters: {},
    route: [{ northM: 20.5, eastM: 0, altitudeM: 8, speedMps: 4 }, { northM: 0, eastM: 30.25, altitudeM: 6.5, speedMps: 3 }, { northM: 20.5, eastM: 30.25, altitudeM: 12, speedMps: 6 }],
    initial: { ground: { northM: 10, eastM: -5, headingDeg: 90, stateOfCharge: 0.333 }, air: null }, finish: "land",
  };
  expect(await storedTasks(page, projectId)).toEqual([{ name: "Square", version: 1, payload: expected }]);

  // After a reload the tab shows what was typed.
  await page.reload();
  const again = await openTasks(page);
  await again.getByTestId("task-list").getByRole("button", { name: "Square", exact: true }).click();
  await expect(again.getByLabel("Task type", { exact: true })).toHaveValue("route");
  for (const [i, point] of [["20.5", "0", "8", "4"], ["0", "30.25", "6.5", "3"], ["20.5", "30.25", "12", "6"]].entries()) {
    for (const [j, field] of ["north (m)", "east (m)", "altitude (m)", "speed (m/s)"].entries()) {
      await expect(again.getByLabel(`Point ${i + 1} ${field}`, { exact: true })).toHaveValue(point[j] ?? "");
    }
  }
  await expect(again.getByLabel("Battery charge (%)", { exact: true })).toHaveValue("33.3");
  // Saving it unchanged adds no version; a change does.
  await again.getByRole("button", { name: "Save flight task", exact: true }).click();
  await expect(again.getByTestId("task-status")).toHaveText("Saved Square, version 1.");
  await again.getByLabel("Point 1 speed (m/s)", { exact: true }).fill("5");
  await again.getByRole("button", { name: "Save flight task", exact: true }).click();
  await expect(again.getByTestId("task-status")).toHaveText("Saved Square, version 2.");
  await expect(again.getByTestId("task-list")).toContainText("version 2");
  const [stored] = await storedTasks(page, projectId);
  expect(stored?.version).toBe(2);
});

// The flights of tests/integration/flight-tasks-sitl.test.ts drive the runner from Node. Here the Run tab drives it,
// on the status it gets from the Worker, through the Worker and the bridge: the timing a user's run really has. The
// recording holds what was requested and the physics truth, tick by tick, and the gaps come from those alone.
test("a climb and a braking flown from the Run tab stay on the smooth path they request", async ({ page }) => {
  test.setTimeout(900_000);
  test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-tasks-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  const evidence: Record<string, unknown> = {};
  try {
    await seedQuadProject(page, "Quad X smooth tasks");
    for (const [name, type, numbers] of [
      ["Climb", "climb", { "From altitude (m)": "5", "To altitude (m)": "15", "Vertical rate (m/s)": "2" }],
      ["Braking", "braking", { "Altitude (m)": "10", "Heading (°)": "45", "From speed (m/s)": "8", "To speed (m/s)": "0", "Speed change (m/s²)": "2" }],
    ] as const) {
      const panel = await openTasks(page);
      await panel.getByRole("button", { name: "New flight task", exact: true }).click();
      await panel.getByLabel("Task name", { exact: true }).fill(name);
      await panel.getByLabel("Task type", { exact: true }).selectOption(type);
      for (const [label, value] of Object.entries(numbers)) await panel.getByLabel(label, { exact: true }).fill(value);
      await expect(panel.getByTestId("task-plan-smooth")).toContainText("ArduPilot");
      await panel.getByRole("button", { name: "Save flight task", exact: true }).click();
      await expect(panel.getByTestId("task-status")).toHaveText(`Saved ${name}, version 1.`);
      
      const runTab = page.getByRole("tab", { name: "Run", exact: true });
      await runTab.click();
      await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
      const run = page.getByRole("region", { name: "ArduPilot SITL" });
      await run.getByLabel("Flight task", { exact: true }).selectOption({ label: `${name} (version 1)` });
      await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
      await run.getByLabel("Launcher token", { exact: true }).fill(token);
      await run.getByRole("button", { name: "List ArduPilot builds" }).click();
      await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
      await run.getByLabel("Speed").selectOption("4");
      await run.getByRole("button", { name: "Start SITL run" }).click();
      await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
      const record = (await run.getByTestId("sitl-record").textContent()) ?? "";

      await page.getByRole("tab", { name: "Parameters", exact: true }).click();
      const parameters = page.getByRole("tabpanel", { name: "Parameters", exact: true });
      await expect(parameters.getByTestId("parameters-status")).toHaveAttribute("data-download", "complete", { timeout: 120_000 });
      await parameters.getByLabel("Search parameters").fill("INS_GYRO_FILTER");
      await parameters.getByTestId("parameter-table").getByRole("button", { name: "INS_GYRO_FILTER", exact: true }).click();
      await parameters.getByLabel("New value of INS_GYRO_FILTER").fill("40");
      await parameters.getByRole("button", { name: "Write", exact: true }).click();
      await expect(parameters.getByTestId("parameter-history").locator('tr[data-name="INS_GYRO_FILTER"]').last()).toHaveAttribute("data-outcome", "confirmed", { timeout: 60_000 });
      await runTab.click();

      await run.getByRole("button", { name: "Run task", exact: true }).click();
      await expect(run.getByTestId("task-state")).toHaveAttribute("data-state", "done", { timeout: 600_000 });
      await run.getByRole("button", { name: "Stop run", exact: true }).click();
      await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30_000 });

      // Each measured request against the physics truth of its tick. Channels: stage, measured, task time, north, east, altitude, speed, heading, vertical speed.
      const gaps = await page.evaluate(async ({ urls, record }) => {
        const { reopenRecording } = await import(urls.host) as Host;
        const { ProjectStore } = await import(urls.store) as Store;
        const { readExperiment } = await import(urls.experiment) as Experiments;
        const store = await ProjectStore.openIndexedDb();
        try {
          const payload = readExperiment(await store.get(record));
          const opened = await reopenRecording(payload.recording?.recordId ?? "");
          const rows = (signal: string) => opened.rows.get(signal) ?? [];
          const positionRows = rows("truth.position"), velocityRows = rows("truth.velocity"), measured = rows("events.flightTask").filter(row => row.values?.[1] === 1);
          // The first truth row at or after a request's tick: the requests and each signal's rows come in tick order.
          let positionAt = 0, velocityAt = 0, largestAltitudeM = 0, largestSpeedMps = 0, peakAltitudeM = 0, peakSpeedMps = 0, compared = 0;
          for (const row of measured) {
            while ((positionRows[positionAt]?.tick ?? Number.POSITIVE_INFINITY) < row.tick) positionAt++;
            while ((velocityRows[velocityAt]?.tick ?? Number.POSITIVE_INFINITY) < row.tick) velocityAt++;
            const at = positionRows[positionAt]?.values, moving = velocityRows[velocityAt]?.values;
            if (!at || !moving) continue;
            compared++;
            const altitudeM = -(at[2] ?? 0), speedMps = Math.hypot(moving[0] ?? 0, moving[1] ?? 0);
            peakAltitudeM = Math.max(peakAltitudeM, altitudeM);
            peakSpeedMps = Math.max(peakSpeedMps, speedMps);
            if (row.presence & (1 << 5)) largestAltitudeM = Math.max(largestAltitudeM, Math.abs(altitudeM - (row.values?.[5] ?? 0)));
            if (row.presence & (1 << 6)) largestSpeedMps = Math.max(largestSpeedMps, Math.abs(speedMps - (row.values?.[6] ?? 0)));
          }
          return { largestAltitudeM, largestSpeedMps, peakAltitudeM, peakSpeedMps, compared, requests: measured.length, lost: opened.missingChunks.length + opened.corruptChunks.length,
            site: payload.parameters.find(parameter => parameter.name === "COMPASS_DEC")?.source ?? null };
        } finally { store.close(); }
      }, { urls, record });
      evidence[name] = gaps;
      expect(gaps.lost).toBe(0);
      expect(gaps.requests).toBeGreaterThan(50);
      // The last requests may come after the last row the run recorded before it stopped.
      expect(gaps.compared).toBeGreaterThan(50);
      // A run the launcher starts is told the declination at its home, as ArduPilot itself computes it.
      expect(gaps.site).toBe("site");
      const { largestAltitudeM, largestSpeedMps, peakAltitudeM } = gaps;
      // The operational tolerances the task declared, and no overshoot past them.
      if (type === "climb") {
        expect(largestAltitudeM, "altitude gap").toBeLessThanOrEqual(COMPLETION.altitudeM);
        expect(peakAltitudeM, "peak altitude").toBeLessThanOrEqual(15 + COMPLETION.altitudeM);
      } else {
        expect(largestSpeedMps, "speed gap").toBeLessThanOrEqual(1);
        expect(largestAltitudeM, "altitude gap").toBeLessThanOrEqual(COMPLETION.altitudeM);
      }
    }
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(ROOT, "test-results/validation"), { recursive: true });
    writeFileSync(join(ROOT, "test-results/validation/task-172-browser-flights.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
});

test("a stored route flies on native ArduCopter from another place, recorded and repeatable", async ({ page }) => {
  test.setTimeout(900_000);
  test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-tasks-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    await seedQuadProject(page, "Quad X task flight");
    const panel = await openTasks(page);
    await panel.getByLabel("Task name", { exact: true }).fill("Offset route");
    await panel.getByLabel("Task type", { exact: true }).selectOption("route");
    const points = [["20", "0", "8", "4"], ["20", "20", "10", "5"], ["0", "20", "6", "4"]] as const;
    await typeRoute(panel, points);
    await panel.getByLabel("Start north of the pad (m)", { exact: true }).fill("10");
    await panel.getByLabel("Start east of the pad (m)", { exact: true }).fill("-5");
    await panel.getByLabel("Start heading (°)", { exact: true }).fill("90");
    await panel.getByLabel("Battery charge (%)", { exact: true }).fill("80");
    await panel.getByRole("button", { name: "Save flight task", exact: true }).click();
    await expect(panel.getByTestId("task-status")).toHaveText("Saved Offset route, version 1.");

    const runTab = page.getByRole("tab", { name: "Run", exact: true });
    await runTab.click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Flight task", { exact: true }).selectOption({ label: "Offset route (version 1)" });
    // The flight view draws the chosen route.
    await expect.poll(async () => JSON.parse((await run.getByTestId("flight-view").getAttribute("data-probe")) || "{}") as { routePoints?: number }).toMatchObject({ routePoints: 3 });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    await expect(run.getByLabel("Flight task", { exact: true })).toBeDisabled();
    const record = (await run.getByTestId("sitl-record").textContent()) ?? "";
    await expect(run.getByTestId("task-state")).toHaveAttribute("data-state", "waiting");

    // The 40 Hz gyro filter of decision A-13, through the Parameters tab.
    await page.getByRole("tab", { name: "Parameters", exact: true }).click();
    const parameters = page.getByRole("tabpanel", { name: "Parameters", exact: true });
    await expect(parameters.getByTestId("parameters-status")).toHaveAttribute("data-download", "complete", { timeout: 120_000 });
    await parameters.getByLabel("Search parameters").fill("INS_GYRO_FILTER");
    await parameters.getByTestId("parameter-table").getByRole("button", { name: "INS_GYRO_FILTER", exact: true }).click();
    await parameters.getByLabel("New value of INS_GYRO_FILTER").fill("40");
    await parameters.getByRole("button", { name: "Write", exact: true }).click();
    await expect(parameters.getByTestId("parameter-history").locator('tr[data-name="INS_GYRO_FILTER"]').last()).toHaveAttribute("data-outcome", "confirmed", { timeout: 60_000 });
    await runTab.click();

    await run.getByRole("button", { name: "Run task", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "running");
    // On the way, the two columns side by side, and the route's point as the request.
    await expect(run.getByTestId("task-stage")).toHaveAttribute("data-stage", "mission", { timeout: 300_000 });
    await expect(run.getByTestId("task-requested-altitudeM")).toHaveText(/^(8|10|6)\.00$/);
    await expect(run.getByTestId("task-actual-altitudeM")).toHaveText(/^[0-9.]+$/);
    await expect(run.getByTestId("task-arrival-actual-altitudeM")).toHaveText(/^[0-9.]+$/);
    await expect(run.getByTestId("task-state")).toHaveAttribute("data-state", "done", { timeout: 600_000 });
    await expect(run.getByRole("button", { name: "Run task", exact: true })).toBeDisabled();
    await run.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30_000 });

    const result = await page.evaluate(async ({ urls, record }) => {
      const { reopenRecording } = await import(urls.host) as Host;
      const { ProjectStore } = await import(urls.store) as Store;
      const { readExperiment } = await import(urls.experiment) as Experiments;
      const store = await ProjectStore.openIndexedDb();
      try {
        const payload = readExperiment(await store.get(record));
        const opened = await reopenRecording(payload.recording?.recordId ?? "");
        const pick = (name: string) => (opened.rows.get(name) ?? []).map(row => ({ tick: row.tick, presence: row.presence, values: row.values }));
        return { flightTask: payload.flightTask, position: pick("truth.position").slice(0, 2), attitude: pick("truth.attitude").slice(0, 1), battery: pick("battery").slice(0, 1),
          requests: pick("events.flightTask"), lost: opened.missingChunks.length + opened.corruptChunks.length };
      } finally { store.close(); }
    }, { urls, record });
    // The experiment record holds the definition it flew.
    expect(result.flightTask?.name).toBe("Offset route");
    expect(result.flightTask?.definition.initial.ground).toEqual({ northM: 10, eastM: -5, headingDeg: 90, stateOfCharge: 0.8 });
    expect(result.flightTask?.definition.route).toHaveLength(3);
    // The ground values, in the truth of the first recorded ticks: position, and heading 90 as the yaw of the attitude.
    const [north, east] = result.position[0]?.values ?? [];
    expect(Math.abs((north ?? 0) - 10)).toBeLessThan(0.01);
    expect(Math.abs((east ?? 0) + 5)).toBeLessThan(0.01);
    const [qw = 0, qx = 0, qy = 0, qz = 0] = result.attitude[0]?.values ?? [];
    expect(Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)) * 180 / Math.PI).toBeCloseTo(90, 0);
    expect(Math.abs((result.battery[0]?.values?.[0] ?? 0) - 0.8)).toBeLessThan(0.001);
    // Requested values on the physics ticks, and each route point among them, with absent channels left out.
    expect(result.lost).toBe(0);
    expect(result.requests.length).toBeGreaterThan(100);
    expect(result.requests.every((row, i, all) => i === 0 || row.tick >= (all[i - 1]?.tick ?? 0))).toBe(true);
    const measured = result.requests.filter(row => row.values?.[1] === 1);
    expect(measured.length).toBeGreaterThan(50);
    expect(result.requests.some(row => (row.presence & 0b1000) === 0), "some stage requests no north").toBe(true);
    for (const [pointNorth, pointEast, altitude] of points) {
      expect(measured.some(row => row.values?.[3] === Number(pointNorth) && row.values[4] === Number(pointEast) && row.values[5] === Number(altitude)), `requested ${pointNorth},${pointEast}`).toBe(true);
    }

    // Repeat flies the same task: the Run tab loads it, locked, and the record names the parent.
    await page.getByRole("tab", { name: "Experiments", exact: true }).click();
    const experiments = page.getByRole("tabpanel", { name: "Experiments", exact: true });
    await experiments.locator(`tr[data-sha="${record}"]`).getByRole("button").click();
    await expect(experiments.getByTestId("experiment-flight-task")).toHaveText("Offset route (Route)");
    await experiments.getByRole("button", { name: "Repeat", exact: true }).click();
    await expect(run.getByTestId("sitl-plan")).toHaveAttribute("data-kind", "repeat");
    await expect(run.getByLabel("Flight task", { exact: true })).toBeDisabled();
    await expect(run.getByLabel("Flight task", { exact: true }).locator("option:checked")).toHaveText("Offset route (version 1)");
    await run.getByRole("button", { name: "Start repeat", exact: true }).click();
    // A new run shows "None" until its record is written, so this waits for a record that is not the parent's.
    await expect.poll(async () => { const shown = (await run.getByTestId("sitl-record").textContent()) ?? ""; return /^[0-9a-f]{64}$/.test(shown) && shown !== record; }, { timeout: 120_000 }).toBe(true);
    const repeat = (await run.getByTestId("sitl-record").textContent()) ?? "";
    await run.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
    const child = await page.evaluate(async ({ urls, repeat }) => {
      const { ProjectStore } = await import(urls.store) as Store;
      const { readExperiment } = await import(urls.experiment) as Experiments;
      const store = await ProjectStore.openIndexedDb();
      try { const payload = readExperiment(await store.get(repeat)); return { lineage: payload.lineage, flightTask: payload.flightTask }; } finally { store.close(); }
    }, { urls, repeat });
    expect(child.lineage).toEqual({ kind: "repeat", of: record });
    expect(child.flightTask).toEqual(result.flightTask);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
