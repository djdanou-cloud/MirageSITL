import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-169 (S09): the Faults and interference tab against native ArduCopter fb773567. A schedule built through the UI holds one effect of
// each class, the run applies it by itself from the first arming, one more is applied by hand, and a vertical step and an effect without
// a run are refused where they show. Every outcome is on the tab and in the stored experiment. Nothing here says what ArduPilot does about
// them, which tests/sitl-fault-effects.test.ts records.

const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

async function vector(panel: Locator, label: string, values: readonly [number, number, number], axes: readonly [string, string, string]): Promise<void> {
  for (let index = 0; index < 3; index++) await panel.getByLabel(`${label} ${axes[index]}`, { exact: true }).fill(String(values[index]));
}
const NED = ["north", "east", "down"] as const, RPY = ["roll", "pitch", "yaw"] as const, FRD = ["forward", "right", "down"] as const;
type Store = typeof import("../../packages/project/src/store");
const STORE_URL = viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url));
/** How many entries the store holds for the project's fault schedule, as a reload would read them. */
async function storedEntries(page: Page, projectId: string): Promise<number> {
  return page.evaluate(async ({ url, key }) => {
    const { ProjectStore } = await import(url) as Store;
    const store = await ProjectStore.openIndexedDb();
    try {
      const stored = await store.readSetting(key) as { readonly entries?: readonly unknown[] } | undefined;
      return stored?.entries?.length ?? 0;
    } finally {
      store.close();
    }
  }, { url: STORE_URL, key: `fault-schedule.p${projectId.replaceAll("-", "").slice(0, 31)}` });
}

test("a schedule of each class flies by itself, one more goes by hand, what cannot be delivered is refused, and all of it is recorded", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-faults-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const { projectId } = await seedQuadProject(page, "Quad X faults");
    await page.getByRole("tab", { name: "Faults and interference", exact: true }).click();
    const panel = page.getByTestId("faults-tab");
    await expect(panel.getByTestId("fault-schedule-empty")).toBeVisible();
    await expect(panel.getByTestId("fault-no-run")).toBeVisible();
    const effect = panel.getByLabel("Effect", { exact: true });
    const add = async (label: string, onsetS: number, durationS: number | null) => {
      await panel.getByLabel("Onset, s after arming", { exact: true }).fill(String(onsetS));
      await panel.getByLabel("Duration, s (empty: until the run ends)").fill(durationS === null ? "" : String(durationS));
      await panel.getByRole("button", { name: "Add to the schedule", exact: true }).click();
      await expect(panel.getByTestId("fault-schedule").locator("tbody tr", { hasText: label }).last()).toBeVisible();
    };

    // A vertical step cannot reach ArduPilot alone, and the form says why.
    await effect.selectOption({ label: "GNSS position step" });
    await expect(panel.getByTestId("fault-effect-path")).toContainText("state line");
    await vector(panel, "Offset", [3, 0, 2], NED);
    await panel.getByRole("button", { name: "Add to the schedule", exact: true }).click();
    await expect(panel.getByTestId("fault-refusal")).toContainText("barometer");
    await expect(panel.getByTestId("fault-schedule-empty")).toBeVisible();

    // One of each class S09 lists. Times leave each room to end before the next.
    await vector(panel, "Offset", [3, 0, 0], NED);
    await add("GNSS position step", 8, 2);
    await effect.selectOption({ label: "GNSS velocity drift" });
    await vector(panel, "Acceleration", [0.2, 0, 0], NED);
    await add("GNSS velocity drift", 11, 2);
    await effect.selectOption({ label: "Magnetic interference" });
    await vector(panel, "Rotation", [0, 0, 0.05], RPY);
    await vector(panel, "Bias", [0.02, 0, 0], FRD);
    await add("Magnetic interference", 14, 2);
    await effect.selectOption({ label: "GNSS jamming" });
    await panel.getByLabel("Severity").fill("0.3");
    await add("GNSS jamming", 17, 2);
    await effect.selectOption({ label: "Motor loss" });
    await panel.getByLabel("Remaining thrust").fill("0.95");
    await add("Motor loss", 20, 2);
    await effect.selectOption({ label: "Barometer frozen" });
    await add("Barometer frozen", 23, 2);
    await effect.selectOption({ label: "Magnetometer frozen" });
    await add("Magnetometer frozen", 26, 2);
    await effect.selectOption({ label: "Ground-station link lost" });
    await add("Ground-station link lost", 29, 2);
    // One effect at once of one kind.
    await panel.getByLabel("Onset, s after arming", { exact: true }).fill("30");
    await panel.getByRole("button", { name: "Add to the schedule", exact: true }).click();
    await expect(panel.getByTestId("fault-refusal")).toContainText("overlaps");
    await effect.selectOption({ label: "GNSS missing" });
    await add("GNSS missing", 33, 2);
    await expect(panel.getByTestId("fault-schedule").locator("tbody tr")).toHaveCount(9);

    // It survives a reload, as the tab's draft. A row shows before its save has finished, so the reload waits for the store to hold all nine.
    await expect.poll(() => storedEntries(page, projectId), { timeout: 10_000 }).toBe(9);
    await page.reload();
    await page.getByRole("tab", { name: "Faults and interference", exact: true }).click();
    await expect(panel.getByTestId("fault-schedule").locator("tbody tr")).toHaveCount(9);

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await expect(run.getByTestId("sitl-fault-plan")).toContainText("9 effects");
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });

    // Before arming the schedule waits.
    await page.getByRole("tab", { name: "Faults and interference", exact: true }).click();
    await expect(panel.getByTestId("fault-armed")).toContainText("starts counting");
    await expect(panel.getByTestId("fault-waiting").locator("li")).toHaveCount(18);

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await run.getByLabel("Take-off altitude, m").fill("10");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveText("Flying", { timeout: 180_000 });

    // By hand, on the run going now.
    await page.getByRole("tab", { name: "Faults and interference", exact: true }).click();
    await expect(panel.getByTestId("fault-armed")).toContainText("Armed at");
    await effect.selectOption({ label: "Pilot control lost" });
    await panel.getByRole("button", { name: "Apply now", exact: true }).click();
    const ledger = panel.getByTestId("fault-ledger");
    const row = (name: string, on: boolean, origin: "manual" | "schedule") => ledger.locator(`tr[data-effect="${name}"][data-enabled="${on}"][data-origin="${origin}"]`);
    await expect(row("link.pilot", true, "manual")).toHaveAttribute("data-status", "applied", { timeout: 30_000 });
    await panel.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(row("link.pilot", false, "manual")).toHaveAttribute("data-status", "applied", { timeout: 30_000 });
    await effect.selectOption({ label: "GNSS position step" });
    await vector(panel, "Offset", [3, 0, 2], NED);
    await panel.getByRole("button", { name: "Apply now", exact: true }).click();
    await expect(panel.getByTestId("fault-refusal")).toContainText("barometer");
    await expect(row("ew.position-step", true, "manual")).toHaveAttribute("data-status", "rejected");

    // Each scheduled effect goes on and off by itself; a session effect lands on its exact tick of arming + onset.
    const names = ["ew.position-step", "ew.velocity-drift", "ew.magnetic", "ew.gnss-jamming", "motor.loss", "sensor.baro.frozen", "sensor.mag.frozen", "link.gcs", "sensor.gnss.missing"];
    for (const name of names) {
      await expect(row(name, true, "schedule"), name).toHaveAttribute("data-status", "applied", { timeout: 120_000 });
      await expect(row(name, false, "schedule"), name).toHaveAttribute("data-status", "applied", { timeout: 120_000 });
    }
    const cell = async (name: string, on: boolean, column: number) => Number(await row(name, on, "schedule").locator("td").nth(column).textContent());
    expect(await cell("ew.position-step", true, 3)).toBe(await cell("ew.position-step", true, 2));
    expect(await cell("ew.position-step", false, 3)).toBe(await cell("ew.position-step", false, 2));
    // A parameter's read-back comes a little after it was meant.
    expect(await cell("sensor.gnss.missing", true, 3)).toBeGreaterThanOrEqual(await cell("sensor.gnss.missing", true, 2));
    await expect(panel.getByTestId("fault-waiting")).toHaveCount(0);
    mkdirSync("test-results/browser", { recursive: true });
    await page.screenshot({ path: "test-results/browser/task-169-faults.png", fullPage: true });

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 60_000 });

    // The stored experiment keeps the schedule and every outcome.
    await page.getByRole("tab", { name: "Experiments", exact: true }).click();
    const experiments = page.getByRole("tabpanel", { name: "Experiments", exact: true });
    await experiments.getByTestId("experiment-list").locator("tbody tr").first().getByRole("button").click();
    await expect(experiments.getByTestId("experiment-effects-schedule")).toContainText("GNSS position step at 8 s for 2 s");
    const stored = experiments.getByTestId("experiment-effects-log").locator("tbody tr");
    await expect(stored).toHaveCount(21, { timeout: 30_000 });
    await expect(experiments.getByTestId("experiment-effects-log").locator('tr[data-status="rejected"]')).toHaveCount(1);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
