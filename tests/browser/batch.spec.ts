import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-176 (S12): a batch of three parameter sets typed on the Experiments tab, flown by native ArduCopter fb773567 one after another
// with nobody touching the Run tab. The middle set cannot boot, which must not take the third with it. ArduPilot's own parameter
// report in each recording is what shows a set took effect, and the two experiments must differ in their initial parameters and nothing else.

type Store = typeof import("../../packages/project/src/store");
type Host = typeof import("../../packages/aar/src/recorder-v2-host");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
type Series = typeof import("../../packages/analysis/src/response-series");
type Maneuvers = typeof import("../../packages/scenarios/src/maneuvers");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  host: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
  series: viteFileUrl(new URL("../../packages/analysis/src/response-series.ts", import.meta.url)),
  maneuvers: viteFileUrl(new URL("../../packages/scenarios/src/maneuvers.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";

/** What the records and the recording of a run say. */
async function readRun(page: Page, record: string) {
  return page.evaluate(async ({ urls, record }) => {
    const { reopenRecording } = await import(urls.host) as Host;
    const { ProjectStore } = await import(urls.store) as Store;
    const { readExperiment } = await import(urls.experiment) as Experiments;
    const store = await ProjectStore.openIndexedDb();
    try {
      const payload = readExperiment(await store.get(record));
      const opened = await reopenRecording(payload.recording?.recordId ?? "");
      // The snapshot the recording took of what the autopilot reported.
      const reported = Object.fromEntries((opened.rows.get("events.parameter") ?? []).flatMap(row => (row.parameter ? [[row.parameter.name, row.parameter.value]] : [])));
      // Up, from the truth, against where the aircraft first stood: shown as evidence of what "Highest" counts from.
      const heights = (opened.rows.get("truth.position") ?? []).flatMap(row => { const down = row.values?.[2]; return down === undefined ? [] : [{ timeS: row.simTimeS, upM: -down }]; });
      const liftoff = heights.findIndex(height => height.upM > (heights[0]?.upM ?? 0) + 0.5);
      const { maneuverSeries } = await import(urls.series) as Series;
      const { maneuverResponse } = await import(urls.maneuvers) as Maneuvers;
      const series = payload.flightTask ? maneuverSeries(payload.flightTask.definition, opened.rows) : null;
      const response = series?.kind === "series" ? maneuverResponse(series.series.requested, series.series.actual, 0.05).map(edge => ({ from: edge.from, to: edge.to, riseS: edge.riseTimeS, overshootPercent: edge.overshootPercent, settlingS: edge.settlingTimeS, endError: edge.endError })) : null;
      return {
        set: payload.parameters.filter(parameter => parameter.source === "set"), lineage: payload.lineage,
        reported: { rate: reported.ATC_ANG_RLL_P ?? null, filter: reported.INS_GYRO_FILTER ?? null },
        heights: { first: heights.slice(0, 3), beforeLiftoff: liftoff > 0 ? heights[liftoff - 1] ?? null : null, highestUpM: heights.length > 0 ? Math.max(...heights.map(height => height.upM)) : null, last: heights[heights.length - 1] ?? null, samples: heights.length },
        response,
      };
    } finally { store.close(); }
  }, { urls, record });
}
async function changesBetween(page: Page, a: string, b: string): Promise<readonly string[]> {
  return page.evaluate(async ({ urls, a, b }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { experimentChanges, readExperiment } = await import(urls.experiment) as Experiments;
    const store = await ProjectStore.openIndexedDb();
    try { return experimentChanges(readExperiment(await store.get(a)), readExperiment(await store.get(b))); } finally { store.close(); }
  }, { urls, a, b });
}

test("a batch of typed parameter sets flies each in turn, records its failure, and collects the results", async ({ page }) => {
  test.setTimeout(900_000);
  test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-batch-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  const evidence: Record<string, unknown> = {};
  try {
    await seedQuadProject(page, "Quad X batch");
    await page.getByRole("tab", { name: "Flight tasks", exact: true }).click();
    const tasks = page.getByRole("tabpanel", { name: "Flight tasks", exact: true });
    await tasks.getByLabel("Task name", { exact: true }).fill("Roll doublet");
    await tasks.getByLabel("Task type", { exact: true }).selectOption("roll-doublet");
    for (const [label, value] of Object.entries({ "Altitude (m)": "5", "Heading (°)": "0", "Amplitude (°, + rolls right)": "10", "Hold each value for (s)": "2" })) await tasks.getByLabel(label, { exact: true }).fill(value);
    await tasks.getByRole("button", { name: "Save flight task", exact: true }).click();
    await expect(tasks.getByTestId("task-status")).toHaveText("Saved Roll doublet, version 1.");

    // The scenario is what the Run tab has chosen.
    const experimentsTab = page.getByRole("tab", { name: "Experiments", exact: true }), runTab = page.getByRole("tab", { name: "Run", exact: true });
    const panel = page.getByRole("tabpanel", { name: "Experiments", exact: true }).getByTestId("batch-panel");
    await experimentsTab.click();
    await expect(panel.getByTestId("batch-scenario")).toContainText("Open the Run tab");
    await expect(panel.getByRole("button", { name: "Run the batch", exact: true })).toBeDisabled();
    await runTab.click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await experimentsTab.click();
    await expect(panel.getByTestId("batch-scenario")).toContainText("Choose a flight task");
    await runTab.click();
    await run.getByLabel("Flight task", { exact: true }).selectOption({ label: "Roll doublet (version 1)" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await experimentsTab.click();
    await expect(panel.getByTestId("batch-scenario")).toContainText("Quad X batch, Roll doublet, arducopter-fb773567, 4×");

    // A set may not name what the aircraft profile sets; the reason names it, and the batch cannot start.
    await panel.getByLabel("Set 1 parameters", { exact: true }).fill("FRAME_CLASS,2\n");
    await expect(panel.getByTestId("batch-problems")).toContainText("FRAME_CLASS");
    await expect(panel.getByRole("button", { name: "Run the batch", exact: true })).toBeDisabled();

    // Three sets. The second names a parameter this ArduPilot does not have, so ArduPilot cannot confirm it.
    await panel.getByRole("button", { name: "Add a set", exact: true }).click();
    await panel.getByLabel("Set 1 name", { exact: true }).fill("Roll 3");
    await panel.getByLabel("Set 1 parameters", { exact: true }).fill("INS_GYRO_FILTER,40\nATC_ANG_RLL_P,3\n");
    await panel.getByLabel("Set 2 name", { exact: true }).fill("Not a parameter");
    await panel.getByLabel("Set 2 parameters", { exact: true }).fill("INS_GYRO_FILTER,40\nNO_SUCH_PARAM,1\n");
    await panel.getByLabel("Set 3 name", { exact: true }).fill("Roll 6");
    await panel.getByLabel("Set 3 parameters", { exact: true }).fill("# as in a parameter file\nINS_GYRO_FILTER,40\nATC_ANG_RLL_P,6\n");
    await expect(panel.getByTestId("batch-problems")).toHaveCount(0);
    await panel.getByRole("button", { name: "Run the batch", exact: true }).click();

    const result = panel.getByTestId("batch-result");
    await expect(result).toHaveAttribute("data-phase", /starting|flying|stopping/);
    // The batch owns the Run tab's starts while it runs.
    await runTab.click();
    await expect(run.getByRole("button", { name: /Start/ }).first()).toBeDisabled();
    await experimentsTab.click();
    await expect(result).toHaveAttribute("data-phase", "finished", { timeout: 600_000 });
    await expect(result.getByTestId("batch-stopped")).toHaveCount(0);

    const rows = result.getByTestId("batch-runs").locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute("data-state", "done");
    await expect(rows.nth(1)).toHaveAttribute("data-state", "failed");
    await expect(rows.nth(1)).toContainText("Failed:");
    await expect(rows.nth(2)).toHaveAttribute("data-state", "done");
    evidence.failedReason = await rows.nth(1).textContent();

    const first = (await rows.nth(0).getAttribute("data-experiment")) ?? "", third = (await rows.nth(2).getAttribute("data-experiment")) ?? "";
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(third).toMatch(/^[0-9a-f]{64}$/);
    // Identical but for the set: what the batch promises.
    expect(await changesBetween(page, first, third)).toEqual(["initial parameters"]);
    const runA = await readRun(page, first), runC = await readRun(page, third);
    evidence.runA = runA; evidence.runC = runC;
    expect(runA.set).toEqual([{ name: "ATC_ANG_RLL_P", value: 3, source: "set" }, { name: "INS_GYRO_FILTER", value: 40, source: "set" }]);
    expect(runC.set).toEqual([{ name: "ATC_ANG_RLL_P", value: 6, source: "set" }, { name: "INS_GYRO_FILTER", value: 40, source: "set" }]);
    // ArduPilot itself reports each set's value, as a run boots with it.
    expect(runA.reported).toEqual({ rate: 3, filter: 40 });
    expect(runC.reported).toEqual({ rate: 6, filter: 40 });
    // The results collect, and nothing picks a winner.
    await expect(rows.nth(0).locator("td").nth(1)).not.toHaveText("missing", { timeout: 30_000 });
    for (const row of [rows.nth(0), rows.nth(2)]) await expect(row.locator("td").nth(2)).toHaveText(/^\d+\.\d+$/, { timeout: 30_000 });
    // On a maneuver the table holds what a set is there to change: each run's answer to each change, read from its recording.
    const response = result.getByTestId("batch-response");
    await expect(response.locator("tbody tr")).toHaveCount((runA.response?.length ?? 0) + (runC.response?.length ?? 0));
    for (const [setIndex, flown] of [[0, runA], [2, runC]] as const) {
      expect(flown.response).toHaveLength(3);
      for (const [edge, expected] of (flown.response ?? []).entries()) {
        const cells = response.locator(`tr[data-set="${setIndex}"][data-edge="${edge}"] td`);
        await expect(cells.nth(1)).toHaveText(expected.riseS === null ? "missing" : expected.riseS.toFixed(3));
        await expect(cells.nth(2)).toHaveText(expected.overshootPercent === null ? "missing" : expected.overshootPercent.toFixed(1));
        await expect(cells.nth(3)).toHaveText(expected.settlingS === null ? "missing" : expected.settlingS.toFixed(3));
      }
    }
    await expect(result.getByRole("columnheader", { name: "Altitude RMS, m" })).toHaveCount(0);
    await expect(panel).not.toContainText(/\bbest\b|\brecommended\b|fit to fly/i);

    // A run of a set is repeatable: its set is one of its inputs.
    mkdirSync(join(ROOT, "test-results/browser"), { recursive: true });
    await panel.screenshot({ path: join(ROOT, "test-results/browser/task-176-batch.png") });
    const experiments = page.getByRole("tabpanel", { name: "Experiments", exact: true });
    await experiments.locator(`tr[data-sha="${third}"]`).getByRole("button").click();
    await experiments.getByRole("button", { name: "Repeat", exact: true }).click();
    await expect(run.getByTestId("sitl-plan")).toHaveAttribute("data-kind", "repeat");
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await run.getByRole("button", { name: "Start repeat", exact: true }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    const repeated = (await run.getByTestId("sitl-record").textContent()) ?? "";
    await run.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
    const repeat = await readRun(page, repeated);
    expect(repeat.lineage).toEqual({ kind: "repeat", of: third });
    expect(repeat.set).toEqual(runC.set);
    expect(repeat.reported).toEqual({ rate: 6, filter: 40 });

    // The batch is stored: after a reload it opens with its runs and the reason of the failed one.
    await page.reload();
    await page.getByRole("tab", { name: "Experiments", exact: true }).click();
    const reopened = page.getByRole("tabpanel", { name: "Experiments", exact: true }).getByTestId("batch-panel");
    await reopened.getByTestId("batch-list").getByRole("button").first().click();
    const again = reopened.getByTestId("batch-runs").locator("tbody tr");
    await expect(again).toHaveCount(3);
    await expect(again.nth(1)).toHaveAttribute("data-state", "failed");
    await expect(again.nth(2)).toHaveAttribute("data-experiment", third);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(ROOT, "test-results/validation"), { recursive: true });
    writeFileSync(join(ROOT, "test-results/validation/task-176-batch.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
});
