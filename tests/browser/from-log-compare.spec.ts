import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { readExperimentRecords, seedQuadProject } from "../support/run-tab";

// TASK-183 (S15): a log gives a run its place and settings, one parameter changed, and native ArduCopter fb773567 flies it: its path is computed afresh, so it can and here does
// go elsewhere than the recording, which sat still on the ground. The comparison opens with metrics, and in the viewer on aligned timelines.

const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";
const REFERENCE = join(ROOT, "tests/fixtures/dataflash/sitl-copter.bin");
const TAKEOFF_M = 5;

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
test.skip(process.env.MIRAGE_UAVLOGVIEWER_DIR === undefined, "Needs MIRAGE_UAVLOGVIEWER_DIR, the build of scripts/build-uavlogviewer.mjs");

async function traces(page: Page): Promise<readonly { readonly name: string; readonly x: readonly number[]; readonly yaxis: string | undefined; readonly dash: string | undefined }[]> {
  const frame = page.frames().find(item => item.url().includes("/uavlogviewer/"));
  if (!frame) throw new Error("No viewer frame");
  return frame.evaluate(() => {
    const figure = document.getElementById("line") as unknown as { data?: readonly { name: string; x: readonly number[]; yaxis?: string; line?: { dash?: string } }[] } | null;
    return (figure?.data ?? []).map(trace => ({ name: trace.name, x: [...trace.x], yaxis: trace.yaxis, dash: trace.line?.dash }));
  });
}

test("a run from a log with a changed parameter computes its own path, and its comparison opens with metrics and aligned timelines", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-resim-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const seeded = await seedQuadProject(page, "Quad X resimulation");
    await page.getByRole("tab", { name: "Experiments", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Experiments", exact: true }), wizard = panel.getByTestId("from-log");
    await wizard.getByLabel("DataFlash log (.bin)").setInputFiles(REFERENCE);
    await expect(wizard.getByTestId("from-log-interval")).toContainText("sitl-copter.bin runs from");
    await wizard.getByRole("button", { name: "Read the log", exact: true }).click();
    await wizard.getByLabel("Aircraft for the new run").selectOption({ label: "Quad X resimulation (version 1)" });
    // What cannot be read is refused with its line.
    await wizard.getByLabel(/Change parameters for this run/).fill("not a line at all");
    await wizard.getByRole("button", { name: "Load into the Run tab", exact: true }).click();
    await expect(wizard.getByTestId("from-log-refused")).toContainText("Line 1");
    await wizard.getByLabel(/Change parameters for this run/).fill("PSC_NE_POS_P,0.9");
    await wizard.getByRole("button", { name: "Load into the Run tab", exact: true }).click();

    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await expect(run.getByTestId("sitl-plan")).toContainText("1 parameter you changed");
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    await run.getByLabel("Take-off altitude, m").fill(String(TAKEOFF_M));
    await run.getByRole("button", { name: "Take off" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveText("Flying", { timeout: 180_000 });
    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 180_000 });
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 60_000 });

    // The change went in, and the log's own settings beside it.
    const records = await readExperimentRecords(page, seeded), flown = records.experiments.at(-1);
    const set = flown?.parameters.filter(parameter => parameter.source === "set") ?? [];
    expect(set.find(parameter => parameter.name === "PSC_NE_POS_P")?.value).toBeCloseTo(0.9, 5);
    expect(set.length).toBeGreaterThan(1);

    await page.getByRole("tab", { name: "Experiments", exact: true }).click();
    await panel.getByTestId("experiment-list").locator("tbody tr").first().getByRole("button").click();
    const compare = panel.getByTestId("from-log-compare");
    // Only the log it came from.
    const other = join(home, "other.bin");
    copyFileSync(join(ROOT, "package.json"), other);
    await compare.getByLabel(/Compare with the original log/).setInputFiles(other);
    await expect(compare.getByTestId("from-log-compare-refused")).toContainText("is not the log this run came from");
    await compare.getByLabel(/Compare with the original log/).setInputFiles(REFERENCE);
    const height = compare.getByTestId("from-log-metrics").locator('tr[data-metric="maxHeightM"]');
    await expect(height).toBeVisible({ timeout: 60_000 });
    // The recording sat on the ground and this run took off: its path was computed and went elsewhere.
    expect(Number(await height.locator('[data-column="original"]').textContent())).toBeLessThan(0.5);
    expect(Number(await height.locator('[data-column="run"]').textContent())).toBeGreaterThan(TAKEOFF_M - 1);
    // The reference log holds 0.4 s, so that is at most what the two share in time; the metrics say how far apart the whole flights went.
    await expect(compare.getByTestId("from-log-difference")).toContainText(/over the 0\.\d s they share/);
    await expect(compare.getByTestId("from-log-difference")).toContainText("never fed from the log");

    await compare.getByRole("button", { name: "Compare both in Analysis", exact: true }).click();
    const analysis = page.getByRole("tabpanel", { name: "Analysis", exact: true }), side = analysis.getByTestId("compare-logs");
    await expect(page.getByRole("tab", { name: "Analysis", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(analysis.getByRole("status").first()).toContainText(/Opened .*\.BIN: \d{2,} message types\./, { timeout: 120_000 });
    await expect(side.getByTestId("compare-second")).toHaveText("Comparing with sitl-copter.bin.", { timeout: 120_000 });
    const offset = Number(await side.getByTestId("compare-offset").getAttribute("data-offset-s"));
    const viewer = page.frameLocator("iframe[title=UAVLogViewer]");
    await viewer.getByText("Plot Individual Field").click();
    await viewer.locator("li.type a.section", { hasText: /^\s*ATT\b/ }).first().click();
    await viewer.locator("#typeATT li.field", { hasText: /^\s*Roll\b/ }).first().click();
    await expect.poll(async () => (await traces(page)).length, { timeout: 60_000 }).toBe(2);
    const [first, second] = await traces(page);
    if (!first || !second) throw new Error("No curves");
    expect(second.dash).toBe("dash");
    expect(second.yaxis).toBe(first.yaxis);
    // Aligned: the original's interval starts where the run's log starts.
    expect(Math.abs((second.x[0] ?? 0) - (first.x[0] ?? 0))).toBeLessThan(200);
    expect(offset).toBeGreaterThan(0);
    await expect(side.getByLabel("Second log from, s")).not.toHaveValue("");
    mkdirSync("test-results/browser", { recursive: true });
    await page.screenshot({ path: "test-results/browser/task-183-compare.png" });
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
