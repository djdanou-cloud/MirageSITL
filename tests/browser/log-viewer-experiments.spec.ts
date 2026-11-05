import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";

// TASK-180 (S14): a real run of native ArduCopter 8ab6afde opens in the Analysis tab, with ArduPilot's own log in the offline viewer,
// its parameter changes on the plot's timeline and in the panel beside it, requested, confirmed and rejected told apart. A log from
// elsewhere shows what it holds and marks the rest unknown. The viewer is the build of scripts/build-uavlogviewer.mjs, served from
// MIRAGE_UAVLOGVIEWER_DIR.

const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
test.skip(process.env.MIRAGE_UAVLOGVIEWER_DIR === undefined, "Needs MIRAGE_UAVLOGVIEWER_DIR, the build of scripts/build-uavlogviewer.mjs");

async function writeParameter(panel: Locator, name: string, value: string): Promise<void> {
  await panel.getByLabel("Search parameters").fill(name);
  await panel.getByTestId("parameter-table").getByRole("button", { name, exact: true }).click();
  await panel.getByLabel(`New value of ${name}`).fill(value);
  await panel.getByRole("button", { name: "Write", exact: true }).click();
  await expect(panel.getByTestId("parameter-history").locator(`tr[data-name="${name}"]`).last()).not.toHaveAttribute("data-outcome", "requested", { timeout: 60_000 });
}

test("a stored run opens in the viewer with its log, events and context, and a log from elsewhere shows its unknowns", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-analysis-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    await seedQuadProject(page, "Quad X analysis");
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });

    // A flight: a run that never arms writes no log. In the air, one confirmed change, and one ArduPilot's list type refuses before it is sent.
    await run.getByLabel("Take-off altitude, m").fill("2");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveText("Flying", { timeout: 180_000 });
    await page.getByRole("tab", { name: "Parameters", exact: true }).click();
    const parameters = page.getByRole("tabpanel", { name: "Parameters", exact: true });
    await expect(parameters.getByTestId("parameters-status")).toHaveAttribute("data-download", "complete", { timeout: 120_000 });
    await writeParameter(parameters, "RTL_ALT_FINAL_M", "1");
    await writeParameter(parameters, "FS_GCS_ENABLE", "1.5");
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 180_000 });
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 60_000 });

    await page.getByRole("tab", { name: "Experiments", exact: true }).click();
    const experiments = page.getByRole("tabpanel", { name: "Experiments", exact: true });
    await experiments.getByTestId("experiment-list").locator("tbody tr").first().getByRole("button").click();
    await experiments.getByRole("button", { name: "Open in Analysis", exact: true }).click();

    const analysis = page.getByRole("tabpanel", { name: "Analysis", exact: true }), context = analysis.getByTestId("analysis-context");
    await expect(page.getByRole("tab", { name: "Analysis", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(analysis.getByTestId("analysis-file-note")).toContainText("ArduPilot's own log", { timeout: 60_000 });
    await expect(analysis.getByRole("status")).toContainText(/Opened .*\.BIN: \d{2,} message types\./, { timeout: 120_000 });
    // Its context: known from the record, and the one thing the record does not hold.
    await expect(context).toHaveAttribute("data-source", "experiment");
    const row = (label: string) => context.locator(`[data-testid="analysis-context-row"][data-label="${label}"]`);
    await expect(row("Aircraft profile")).toContainText("version 1");
    await expect(row("ArduPilot")).toContainText("8ab6afde");
    await expect(row("Wind and temperature")).toHaveAttribute("data-unknown", "true");
    // Its events, told apart.
    const events = context.getByTestId("analysis-events").locator("tbody tr");
    await expect(events.filter({ hasText: "RTL_ALT_FINAL_M" })).toHaveAttribute("data-status", "confirmed");
    await expect(events.filter({ hasText: "FS_GCS_ENABLE" })).toHaveAttribute("data-status", "rejected");
    await expect(context.getByTestId("analysis-differences")).toContainText("RTL_ALT_FINAL_M");
    await expect(context.getByTestId("analysis-differences")).not.toContainText("FS_GCS_ENABLE");

    // And on the plot's timeline, in the colour of their outcome.
    const viewer = page.frameLocator("iframe[title=UAVLogViewer]");
    await viewer.getByText("Plot Individual Field").click();
    await viewer.locator("li.type a.section", { hasText: /^\s*ATT\b/ }).first().click();
    await viewer.locator("#typeATT li.field", { hasText: /^\s*Roll\b/ }).first().click();
    await expect(viewer.locator(".annotation-text", { hasText: "RTL_ALT_FINAL_M" })).toBeAttached({ timeout: 60_000 });
    await expect(viewer.locator(".annotation-text", { hasText: "FS_GCS_ENABLE" })).toBeAttached();
    mkdirSync("test-results/browser", { recursive: true });
    await page.screenshot({ path: "test-results/browser/task-180-analysis.png" });

    // A log from elsewhere says what it holds: its firmware, from its own records, and the rest unknown. No history is made up.
    await analysis.getByLabel("Open DataFlash log (.bin)").setInputFiles(join(ROOT, "tests/fixtures/dataflash/sitl-copter.bin"));
    await expect(analysis.getByRole("status")).toContainText(/Opened sitl-copter\.bin: \d{2,} message types\./, { timeout: 120_000 });
    await expect(context).toHaveAttribute("data-source", "external");
    await expect(row("ArduPilot")).toContainText("ArduCopter");
    for (const label of ["Aircraft profile", "Component versions", "Physics rate", "Location", "Wind and temperature", "Flight task"]) {
      await expect(row(label)).toHaveAttribute("data-unknown", "true");
      await expect(row(label)).toContainText("Unknown");
    }
    await expect(context.getByTestId("analysis-no-events")).toContainText("never change");
    await expect(context.getByTestId("analysis-events")).toHaveCount(0);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
