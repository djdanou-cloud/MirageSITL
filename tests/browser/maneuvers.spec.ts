import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";
import { edgesOf, maneuverResponse, eulerDegOf, type ResponseSeries } from "../../packages/scenarios/src/maneuvers";

// TASK-173 (S10): tuning maneuvers through the application alone. A maneuver is defined on
// the Flight tasks tab, flown from the Run tab by native ArduCopter fb773567 through the Worker
// and the bridge, and read on the Experiments tab. The chart's lines are read back from the page
// and compared with the rows the recording holds, so a line drawn at the wrong time fails here.
// The quad flies with the 40 Hz gyro filter of decision A-13, written through the Parameters tab.

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

async function openTasks(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: "Flight tasks", exact: true }).click();
  return page.getByRole("tabpanel", { name: "Flight tasks", exact: true });
}

test("a maneuver is defined on the Flight tasks tab, says what it will request, and reopens unchanged", async ({ page }) => {
  const { projectId } = await seedQuadProject(page, "Quad X maneuvers");
  const panel = await openTasks(page);
  const problems = panel.getByRole("list", { name: "Problems to fix before saving" });
  const save = panel.getByRole("button", { name: "Save flight task", exact: true });
  const type = panel.getByLabel("Task type", { exact: true });
  for (const option of ["roll-step", "roll-doublet", "pitch-step", "pitch-doublet", "heading-step", "heading-doublet", "altitude-step", "altitude-doublet"]) {
    await type.selectOption(option);
    await expect(problems).toHaveCount(0);
    await expect(panel.getByTestId("task-plan").locator('li[data-measured="true"]')).toHaveCount(1);
    await expect(panel.getByTestId("maneuver-panel")).toBeVisible();
  }
  // A flight of another type asks for no sudden change.
  await type.selectOption("hover");
  await expect(panel.getByTestId("maneuver-panel")).toHaveCount(0);

  // The sign's meaning is on the field, and each change is listed before anything flies.
  await type.selectOption("pitch-doublet");
  await panel.getByLabel("Task name", { exact: true }).fill("Pitch doublet");
  await panel.getByLabel("Amplitude (°, + pitches nose up)", { exact: true }).fill("-8");
  await panel.getByLabel("Hold each value for (s)", { exact: true }).fill("3");
  await expect(panel.getByTestId("maneuver-edge")).toHaveText(["2from 0° to -8°", "5from -8° to 8°", "8from 8° to 0°"]);
  // Out of range: said in the words of the field, and it cannot be saved.
  await panel.getByLabel("Amplitude (°, + pitches nose up)", { exact: true }).fill("31");
  await expect(problems).toContainText("Amplitude (°) must be a number from -30 to 30");
  await expect(save).toBeDisabled();
  await panel.getByLabel("Amplitude (°, + pitches nose up)", { exact: true }).fill("0");
  await expect(problems).toContainText("A maneuver must change something");
  await expect(save).toBeDisabled();
  await panel.getByLabel("Amplitude (°, + pitches nose up)", { exact: true }).fill("-8");
  await save.click();
  await expect(panel.getByTestId("task-status")).toHaveText("Saved Pitch doublet, version 1.");

  const stored = await page.evaluate(async ({ urls, projectId }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const store = await ProjectStore.openIndexedDb();
    try { return (await store.listItems(projectId, "flight-task")).map(item => item.record.payload); } finally { store.close(); }
  }, { urls, projectId });
  expect(stored).toEqual([{ schemaVersion: 2, type: "pitch-doublet", parameters: { altitudeM: 10, headingDeg: 0, amplitudeDeg: -8, holdS: 3 }, route: null,
    initial: { ground: { northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 1 }, air: null }, finish: "land" }]);

  await page.reload();
  const again = await openTasks(page);
  await again.getByTestId("task-list").getByRole("button", { name: "Pitch doublet", exact: true }).click();
  await expect(again.getByLabel("Task type", { exact: true })).toHaveValue("pitch-doublet");
  await expect(again.getByLabel("Amplitude (°, + pitches nose up)", { exact: true })).toHaveValue("-8");
  await again.getByRole("button", { name: "Save flight task", exact: true }).click();
  await expect(again.getByTestId("task-status")).toHaveText("Saved Pitch doublet, version 1.");
});

/** What the page's chart draws, as times and values: the corners of the request, and the actual line. */
async function drawn(page: Page): Promise<{ startS: number; endS: number; left: number; right: number; requested: string; actual: string }> {
  const plot = page.getByTestId("response-plot").locator("svg");
  const number = async (name: string) => Number(await plot.getAttribute(name));
  return { startS: await number("data-start-s"), endS: await number("data-end-s"), left: await number("data-left"), right: await number("data-right"),
    requested: (await plot.getByTestId("response-requested").getAttribute("d")) ?? "", actual: (await plot.getByTestId("response-actual").getAttribute("d")) ?? "" };
}

test("a roll doublet and an altitude step flown from the Run tab read back on one time base", async ({ page }) => {
  test.setTimeout(900_000);
  test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-maneuvers-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  const evidence: Record<string, unknown> = {};
  try {
    await seedQuadProject(page, "Quad X maneuver flights");
    for (const [name, type, numbers, edgeCount] of [
      ["Roll doublet", "roll-doublet", { "Altitude (m)": "10", "Heading (°)": "30", "Amplitude (°, + rolls right)": "10", "Hold each value for (s)": "2" }, 3],
      ["Altitude step", "altitude-step", { "Altitude (m)": "10", "Amplitude (m, + climbs)": "3", "Hold each value for (s)": "8" }, 1],
    ] as const) {
      const panel = await openTasks(page);
      await panel.getByRole("button", { name: "New flight task", exact: true }).click();
      await panel.getByLabel("Task name", { exact: true }).fill(name);
      await panel.getByLabel("Task type", { exact: true }).selectOption(type);
      for (const [label, value] of Object.entries(numbers)) await panel.getByLabel(label, { exact: true }).fill(value);
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
      await expect(run.getByTestId("task-response-hint")).toBeVisible();
      await run.getByRole("button", { name: "Stop run", exact: true }).click();
      await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30_000 });

      // The rows the recording holds, for this test to compute from on its own.
      const raw = await page.evaluate(async ({ urls, record }) => {
        const { reopenRecording } = await import(urls.host) as Host;
        const { ProjectStore } = await import(urls.store) as Store;
        const { readExperiment } = await import(urls.experiment) as Experiments;
        const store = await ProjectStore.openIndexedDb();
        try {
          const payload = readExperiment(await store.get(record));
          const opened = await reopenRecording(payload.recording?.recordId ?? "");
          const pick = (signal: string) => (opened.rows.get(signal) ?? []).map(row => ({ simTimeS: row.simTimeS, tick: row.tick, presence: row.presence, values: row.values }));
          return { task: pick("events.flightTask"), attitude: pick("events.flightTaskAttitude"), truthAttitude: pick("truth.attitude"), truthPosition: pick("truth.position"),
            lost: opened.missingChunks.length + opened.corruptChunks.length, gaps: opened.gaps.length, name: payload.flightTask?.name ?? "" };
        } finally { store.close(); }
      }, { urls, record });
      expect(raw.name).toBe(name);
      expect(raw.lost).toBe(0);
      expect(raw.gaps).toBe(0);

      // The requests of the maneuver's own stage: on a roll, arm, take-off, heading, then the maneuver; on an altitude step, arm, take-off, then the maneuver.
      const stage = type === "roll-doublet" ? 3 : 2;
      const stageRows = raw.task.filter(row => row.values?.[0] === stage);
      const firstTick = stageRows[0]?.tick ?? 0, lastTick = stageRows.at(-1)?.tick ?? 0, startS = stageRows[0]?.simTimeS ?? 0, endS = stageRows.at(-1)?.simTimeS ?? 0;
      const requested: ResponseSeries = type === "roll-doublet"
        ? { timeS: raw.attitude.filter(row => row.tick >= firstTick && row.tick <= lastTick).map(row => row.simTimeS), value: raw.attitude.filter(row => row.tick >= firstTick && row.tick <= lastTick).map(row => row.values?.[0] ?? Number.NaN) }
        : { timeS: stageRows.map(row => row.simTimeS), value: stageRows.map(row => row.values?.[5] ?? Number.NaN) };
      const truth = (type === "roll-doublet" ? raw.truthAttitude : raw.truthPosition).filter(row => row.simTimeS >= startS - 1 && row.simTimeS <= endS);
      const actual: ResponseSeries = { timeS: truth.map(row => row.simTimeS), value: truth.map(row => {
        const [a = 0, b = 0, c = 0, d = 0] = row.values ?? [];
        return type === "roll-doublet" ? eulerDegOf(a, b, c, d).rollDeg : -c;
      }) };
      const edges = edgesOf(requested);
      expect(edges, "a change of the request per edge").toHaveLength(edgeCount);

      // On the Experiments tab: chosen by name, the most recent first.
      await page.getByRole("tab", { name: "Experiments", exact: true }).click();
      const experiments = page.getByRole("tabpanel", { name: "Experiments", exact: true });
      await experiments.locator(`tr[data-sha="${record}"]`).getByRole("button").click();
      const response = experiments.getByTestId("response-panel");
      await expect(response.getByTestId("response-metrics")).toBeVisible({ timeout: 30_000 });
      await expect(response.getByTestId("response-still-recording")).toHaveCount(0);
      await expect(response.getByTestId("response-lost")).toHaveCount(0);

      // The numbers shown are the ones the recorded rows give.
      const expected = maneuverResponse(requested, actual, 0.05);
      for (const [i, edge] of expected.entries()) {
        const row = response.getByTestId(`response-edge-${i}`);
        await expect(row).toHaveAttribute("data-edge-s", String(edge.edgeTimeS));
        await expect(row.getByTestId(`response-rise-${i}`)).toHaveText(edge.riseTimeS === null ? "not reached" : edge.riseTimeS.toFixed(3));
        await expect(row.getByTestId(`response-overshoot-${i}`)).toHaveText((edge.overshootPercent ?? Number.NaN).toFixed(1));
        await expect(row.getByTestId(`response-settling-${i}`)).toHaveText(edge.settlingTimeS === null ? "did not settle" : edge.settlingTimeS.toFixed(3));
        expect(edge.missing, "nothing missing").toBeNull();
      }
      await expect(response.getByTestId("response-metrics").locator("tbody tr")).toHaveCount(edgeCount);

      // A tighter band can only take as long or longer, and the page recomputes it from the same rows.
      const tight = maneuverResponse(requested, actual, 0.02)[0];
      await response.getByLabel("Settled within", { exact: true }).selectOption("2");
      await expect(response.getByTestId("response-settling-0")).toHaveText(tight?.settlingTimeS == null ? "did not settle" : tight.settlingTimeS.toFixed(3));
      await response.getByLabel("Settled within", { exact: true }).selectOption("5");

      // The chart draws those same moments. One time scale, from the svg's own numbers back to seconds.
      const chart = await drawn(page);
      expect(chart.startS).toBe(startS);
      expect(chart.endS).toBe(endS);
      const secondsOfX = (x: number) => chart.startS + (x - chart.left) / (chart.right - chart.left) * (chart.endS - chart.startS);
      // At 2 decimals of a pixel, on about 656 px, plus the spacing of the request's own rows.
      const pixelS = (chart.endS - chart.startS) / (chart.right - chart.left);
      const corners = [...chart.requested.matchAll(/H([\d.]+)V([\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
      const changes: { x: number; y: number }[] = [];
      let lastY = Number(/^M[\d.]+ ([\d.]+)/.exec(chart.requested)?.[1]);
      const firstY = lastY;
      for (const corner of corners) { if (corner.y !== lastY) changes.push(corner); lastY = corner.y; }
      expect(changes, "the chart's corners").toHaveLength(edgeCount);
      for (const [i, change] of changes.entries()) {
        expect(Math.abs(secondsOfX(change.x) - (edges[i]?.timeS ?? Number.NaN)), `corner ${i} of the request`).toBeLessThanOrEqual(pixelS);
      }
      // The actual line crosses halfway to the first request where the recorded truth does.
      const toY = changes[0]?.y ?? Number.NaN, halfwayY = (firstY + toY) / 2, rising = toY < firstY;
      const line = [...chart.actual.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) })).filter(point => secondsOfX(point.x) >= (edges[0]?.timeS ?? 0));
      const crossed = line.find(point => (rising ? point.y <= halfwayY : point.y >= halfwayY));
      const first = edges[0], halfway = first ? (first.from + first.to) / 2 : Number.NaN;
      const up = (first?.to ?? 0) > (first?.from ?? 0);
      const recordedAt = actual.timeS.find((t, i) => t >= (first?.timeS ?? 0) && (up ? (actual.value[i] ?? 0) >= halfway : (actual.value[i] ?? 0) <= halfway));
      const sampleS = (actual.timeS.at(-1)! - actual.timeS[0]!) / (actual.timeS.length - 1);
      expect(Math.abs(secondsOfX(crossed?.x ?? Number.NaN) - (recordedAt ?? Number.NaN)), "the actual line").toBeLessThanOrEqual(sampleS + 3 * pixelS);

      // Hovering reads both lines at one moment.
      const svg = response.getByTestId("response-plot").locator("svg");
      await svg.scrollIntoViewIfNeeded();
      const box = await svg.boundingBox();
      if (!box) throw new Error("The chart has no box");
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await expect(response.getByTestId("response-tooltip")).toContainText("Requested");
      await expect(response.getByTestId("response-tooltip")).toContainText("Actual");
      mkdirSync(join(ROOT, "test-results/browser"), { recursive: true });
      await response.screenshot({ path: join(ROOT, `test-results/browser/task-173-response-${type}.png`) });
      await page.mouse.move(0, 0);
      await expect(response.getByTestId("response-tooltip")).toHaveCount(0);

      if (type === "roll-doublet") await expect(response.getByTestId("response-estimate-note")).toContainText("SIM_DRIFT_SPEED");
      else await expect(response.getByTestId("response-estimate-note")).toHaveCount(0);

      evidence[name] = { edges: expected.map(edge => ({ ...edge, at: edge.edgeTimeS - startS })), requestRows: requested.timeS.length, actualRows: actual.timeS.length, spanS: endS - startS, actualHz: 1 / sampleS };
      // Next flight: a new experiment, from a run that is stopped.
      await runTab.click();
      await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle");
    }
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(ROOT, "test-results/validation"), { recursive: true });
    writeFileSync(join(ROOT, "test-results/validation/task-173-browser-flights.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
});
