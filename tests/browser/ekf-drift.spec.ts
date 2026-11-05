import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { ekfDriftEndS, ekfDriftEntries, ekfDriftPeakM } from "../../packages/scenarios/src/ekf-drift";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-170 (S09): an EKF drift set up through the UI flies on native ArduCopter 8ab6afde, and the experiment shows the truth against ArduPilot's estimate. The
// chart's numbers are held to an independent computation from the recording's own rows, in this file. What ArduPilot did about the drift is shown and not asserted.

const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const PROFILE = { schemaVersion: 1, directionDeg: 0, growthMps2: 0.2, topSpeedMps: 1, onsetS: 8, durationS: 8, removal: "gradual" } as const;
/** ArduPilot's own Location arithmetic, written out here apart from the module. */
const METRES_PER_DEGREE = 111318.84502145034;
type Host = typeof import("../../packages/aar/src/recorder-v2-host");
type Store = typeof import("../../packages/project/src/store");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
const urls = {
  host: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
};

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

test("an EKF drift set up in the tab flies, and its charts hold the recording's own numbers", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-drift-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const seeded = await seedQuadProject(page, "Quad X drift");
    await page.getByRole("tab", { name: "Faults and interference", exact: true }).click();
    const panel = page.getByTestId("faults-tab");
    // What the model cannot do is refused before it is scheduled, and the preview says so.
    await panel.getByLabel("Growth rate, m/s² (up to 0.3)").fill("0.5");
    await expect(panel.getByTestId("drift-preview")).toContainText("growth rate");
    await panel.getByRole("button", { name: "Put EKF drift on the schedule", exact: true }).click();
    await expect(panel.getByTestId("fault-refusal")).toContainText("growth rate");
    await panel.getByLabel("Direction, ° from north").fill(String(PROFILE.directionDeg));
    await panel.getByLabel("Growth rate, m/s² (up to 0.3)").fill(String(PROFILE.growthMps2));
    await panel.getByLabel("Top speed, m/s (up to 20)").fill(String(PROFILE.topSpeedMps));
    await panel.getByLabel("Drift onset, s after arming").fill(String(PROFILE.onsetS));
    await panel.getByLabel("Grows for, s").fill(String(PROFILE.durationS));
    await panel.getByLabel("Removal").selectOption(PROFILE.removal);
    await expect(panel.getByTestId("drift-preview")).toContainText(`reaches ${ekfDriftPeakM(PROFILE).toFixed(1)} m from the truth, and is gone ${ekfDriftEndS(PROFILE).toFixed(1)} s after arming`);
    await panel.getByRole("button", { name: "Put EKF drift on the schedule", exact: true }).click();
    await expect(panel.getByTestId("drift-scheduled")).toContainText("removed gradually");

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    await run.getByLabel("Take-off altitude, m").fill("10");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveText("Flying", { timeout: 180_000 });

    // Every stretch of the drift goes on and off by itself, each on its exact tick.
    await page.getByRole("tab", { name: "Faults and interference", exact: true }).click();
    const rows = panel.getByTestId("fault-ledger").locator('tr[data-effect="ew.velocity-drift"][data-origin="schedule"]');
    const stretches = ekfDriftEntries(PROFILE).length;
    await expect(rows).toHaveCount(stretches * 2, { timeout: 180_000 });
    await expect(panel.getByTestId("fault-ledger").locator('tr[data-effect="ew.velocity-drift"][data-status="applied"]')).toHaveCount(stretches * 2, { timeout: 60_000 });
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 60_000 });

    await page.getByRole("tab", { name: "Experiments", exact: true }).click();
    const experiments = page.getByRole("tabpanel", { name: "Experiments", exact: true });
    await experiments.getByTestId("experiment-list").locator("tbody tr").first().getByRole("button").click();
    const charts = experiments.getByTestId("truth-estimate");
    await expect(charts.getByTestId("truth-estimate-chart").locator("path.response-line")).toHaveCount(2, { timeout: 60_000 });
    // The error chart also draws what was added to the input, along north.
    await expect(charts.getByTestId("truth-estimate-error").locator('path[data-line="Added to its GNSS input"]')).toBeVisible();

    // The table against the recording's own rows, by arithmetic written out here: estimate minus truth, the truth read straight between its neighbours.
    const raw = await page.evaluate(async ({ urls, projectId }) => {
      const { reopenRecording } = await import(urls.host) as Host;
      const { ProjectStore } = await import(urls.store) as Store;
      const { readExperiment } = await import(urls.experiment) as Experiments;
      const store = await ProjectStore.openIndexedDb();
      try {
        const items = await store.listItems(projectId, "experiment"), last = items.at(-1);
        if (!last) throw new Error("No experiment");
        const payload = readExperiment(last), opened = await reopenRecording(payload.recording?.recordId ?? "");
        const pick = (name: string) => (opened.rows.get(name) ?? []).map(row => ({ t: row.simTimeS, values: row.values === null ? null : [...row.values] }));
        return { home: payload.session.home, faults: payload.faults, position: pick("truth.position"), reports: pick("autopilot.globalPosition") };
      } finally { store.close(); }
    }, { urls, projectId: seeded.projectId });
    expect(raw.faults?.ekfDrift).toEqual(PROFILE);
    const truthNorthAt = (t: number): number => {
      const after = raw.position.findIndex(row => row.t >= t), b = raw.position[after], a = raw.position[after - 1];
      if (!a || !b || !a.values || !b.values) throw new Error(`No truth at ${t}`);
      return (a.values[0] ?? 0) + ((b.values[0] ?? 0) - (a.values[0] ?? 0)) * (t - a.t) / (b.t - a.t);
    };
    await charts.getByText("The values as a table").click();
    const table = charts.getByTestId("truth-estimate-values").locator("tbody tr");
    const shown = await table.count();
    expect(shown).toBeGreaterThan(20);
    for (let index = 0; index < shown; index += 5) {
      const cells = await table.nth(index).locator("th, td").allTextContents();
      const atS = Number(cells[0]), report = raw.reports.find(row => row.t.toFixed(2) === cells[0]);
      if (!report?.values) throw new Error(`No report at ${atS}`);
      const estimate = ((report.values[0] ?? 0) - raw.home[0]) * METRES_PER_DEGREE, truth = truthNorthAt(report.t);
      expect(Number(cells[1]), `truth at ${atS}`).toBeCloseTo(truth, 2);
      expect(Number(cells[2]), `estimate at ${atS}`).toBeCloseTo(estimate, 2);
      expect(Number(cells[3]), `error at ${atS}`).toBeCloseTo(estimate - truth, 2);
    }
    await charts.getByLabel("Quantity").selectOption("velocity");
    await expect(charts.getByTestId("truth-estimate-chart").locator("figcaption")).toContainText("North velocity");
    mkdirSync("test-results/browser", { recursive: true });
    await page.screenshot({ path: "test-results/browser/task-170-truth-estimate.png", fullPage: true });
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
