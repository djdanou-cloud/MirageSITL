import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-160 (S11): the Parameters tab against native ArduCopter 8ab6afde,
// through the application alone. A write before flight is confirmed and
// applied; one whose metadata needs a restart is stored but never called
// applied; a value its integer type cannot carry is refused before sending;
// a read-only parameter is refused by ArduPilot, which keeps its value. A
// write in flight is confirmed. While the run is paused a write stays
// requested, a newer write of the same parameter makes it no longer current,
// and the paused SITL answers the newer one after Resume. A saved set is
// compared with the running SITL and sent back, an earlier value is sent back
// from the history, and the history is still there after a reload, read from
// the run's parameter log. A timeout cannot be provoked from a real ArduPilot,
// which answers every listed parameter; tests/run-controller.test.ts covers it.

type Store = typeof import("../../packages/project/src/store");
type Sets = typeof import("../../apps/web/src/params/parameter-sets");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  sets: viteFileUrl(new URL("../../apps/web/src/params/parameter-sets.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

/** The kinds of the stored parameter log of the project's run: [name, outcome] per change. */
async function storedLog(page: Page, projectId: string): Promise<[string, string][]> {
  return page.evaluate(async ({ urls, projectId }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { readParameterLog } = await import(urls.sets) as Sets;
    const store = await ProjectStore.openIndexedDb();
    try {
      const [stored] = await store.listItems(projectId, "parameter-log");
      if (!stored) return [];
      return readParameterLog(stored).changes.map((change): [string, string] => [change.name, change.outcome.kind]);
    } finally {
      store.close();
    }
  }, { urls, projectId });
}

test("the Parameters tab writes, refuses, waits while paused, keeps a history and restores a set against native SITL", async ({ page }) => {
  test.setTimeout(900_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-parameters-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const { projectId } = await seedQuadProject(page, "Quad X parameters");
    const runTab = page.getByRole("tab", { name: "Run" }), paramsTab = page.getByRole("tab", { name: "Parameters" });
    const panel = page.getByRole("tabpanel", { name: "Parameters" });
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 180000 });

    await paramsTab.click();
    const status = panel.getByTestId("parameters-status");
    await expect(status).toHaveAttribute("data-download", "complete");
    await expect(status).toContainText(/^\d+ parameters of ArduPilot 8ab6afde in run /);
    console.log(`EVID list ${(await status.textContent()) ?? ""}`);
    const history = panel.getByTestId("parameter-history");
    const rows = (name: string): Locator => history.locator(`tr[data-name="${name}"]`);
    const write = async (name: string, value: string) => {
      await panel.getByLabel("Search parameters").fill(name);
      await panel.getByTestId("parameter-table").getByRole("button", { name, exact: true }).click();
      await panel.getByLabel(`New value of ${name}`).fill(value);
      await panel.getByRole("button", { name: "Write", exact: true }).click();
    };
    const value = (name: string): Locator => panel.getByTestId("parameter-table").locator(`tr[data-name="${name}"]`).getByTestId("parameter-value");

    // Before flight: confirmed and applied; stored but needing a restart; refused by the service; refused by ArduPilot.
    await write("RTL_ALT_M", "20");
    await expect(rows("RTL_ALT_M").last()).toHaveAttribute("data-outcome", "confirmed");
    await expect(rows("RTL_ALT_M").last()).toHaveAttribute("data-reboot", "false");
    await expect(rows("RTL_ALT_M").last()).toContainText("Confirmed and applied");
    await expect(value("RTL_ALT_M")).toHaveText("20");
    await write("GPS1_DELAY_MS", "10");
    await expect(rows("GPS1_DELAY_MS").last()).toHaveAttribute("data-reboot", "true");
    await expect(rows("GPS1_DELAY_MS").last()).toContainText("Stored, not applied: ArduPilot uses it only after SITL restarts");
    await expect(rows("GPS1_DELAY_MS").last()).not.toContainText("Confirmed and applied");
    await expect(panel.getByTestId("parameters-reboot-pending")).toContainText("GPS1_DELAY_MS");
    await write("GPS1_DELAY_MS", "10.5");
    await expect(rows("GPS1_DELAY_MS").last()).toHaveAttribute("data-outcome", "refused");
    await expect(rows("GPS1_DELAY_MS").last()).toContainText("Refused before sending: an integer from -32768 to 32767 is required");
    await write("BARO1_DEVID", "1");
    await expect(rows("BARO1_DEVID").last()).toHaveAttribute("data-outcome", "refused", { timeout: 30000 });
    await expect(rows("BARO1_DEVID").last()).toContainText(/Refused by ArduPilot: the autopilot kept \d+ \(read-only in ArduPilot's metadata\)/);
    console.log(`EVID refused ${(await rows("BARO1_DEVID").last().textContent()) ?? ""}`);

    // A set of the values before flight.
    await panel.getByLabel("Set name").fill("Before flight");
    await panel.getByRole("button", { name: "Save as parameter set" }).click();
    await expect(panel.getByTestId("parameters-notice")).toContainText('Saved set "Before flight"');

    // In flight.
    await runTab.click();
    await run.getByLabel("Take-off altitude, m").fill("5");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveText("Flying", { timeout: 120000 });
    await paramsTab.click();
    await write("RTL_ALT_M", "25");
    await expect(rows("RTL_ALT_M").last()).toHaveAttribute("data-outcome", "confirmed");
    await expect(rows("RTL_ALT_M").last()).toContainText("Confirmed and applied");

    // While paused: the write waits, a newer one replaces it, and the SITL answers after Resume.
    await runTab.click();
    await run.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "paused");
    await paramsTab.click();
    await expect(panel.getByTestId("parameters-paused")).toBeVisible();
    await write("RTL_ALT_M", "30");
    await expect(rows("RTL_ALT_M").last()).toContainText("Requested while paused");
    await page.waitForTimeout(5000);
    await expect(rows("RTL_ALT_M").last()).toHaveAttribute("data-outcome", "requested");
    await write("RTL_ALT_M", "35");
    await expect(rows("RTL_ALT_M").nth(-2)).toHaveAttribute("data-outcome", "stale");
    await expect(rows("RTL_ALT_M").nth(-2)).toContainText("No longer current: write");
    await expect(rows("RTL_ALT_M").last()).toHaveAttribute("data-outcome", "requested");
    await runTab.click();
    await run.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveText("Flying", { timeout: 30000 });
    await paramsTab.click();
    await expect(rows("RTL_ALT_M").last()).toHaveAttribute("data-outcome", "confirmed", { timeout: 30000 });
    await expect(value("RTL_ALT_M")).toHaveText("35");

    // The set against the running SITL, then sent back.
    await expect(panel.getByTestId("parameter-comparison").locator('tr[data-name="RTL_ALT_M"]')).toHaveText(/RTL_ALT_M\s*20\s*35/);
    await panel.getByRole("button", { name: "Send the set's values to the running SITL" }).click();
    await expect(panel.getByTestId("parameter-restore")).toContainText(/Sent \d+ writes?/);
    await expect(rows("RTL_ALT_M").last()).toHaveAttribute("data-outcome", "confirmed", { timeout: 30000 });
    await expect(value("RTL_ALT_M")).toHaveText("20");
    console.log(`EVID restore ${(await panel.getByTestId("parameter-restore").textContent()) ?? ""}`);
    // An earlier value back from the history: GPS1_DELAY_MS's 0 before its first write.
    await rows("GPS1_DELAY_MS").first().getByRole("button", { name: "Send back 0" }).click();
    await expect(rows("GPS1_DELAY_MS").last()).toHaveAttribute("data-outcome", "confirmed");
    await panel.getByLabel("Search parameters").fill("GPS1_DELAY_MS");
    await expect(value("GPS1_DELAY_MS")).toHaveText("0");

    await runTab.click();
    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 120000 });
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30000 });

    // The history persists with the run's experiment: its stored log holds every change with its final outcome.
    await paramsTab.click();
    const shown = await history.locator("tr[data-name]").evaluateAll(items => items.map(item => [item.getAttribute("data-name") ?? "", item.getAttribute("data-outcome") ?? ""]));
    await expect.poll(() => storedLog(page, projectId), { timeout: 30000 }).toEqual(shown);
    console.log(`EVID history ${JSON.stringify(shown)}`);
    await page.reload();
    await page.getByRole("tab", { name: "Parameters" }).click();
    const earlier = page.getByRole("tabpanel", { name: "Parameters" }).getByTestId("parameter-history-earlier");
    await expect(earlier.locator("details")).toHaveCount(1);
    await earlier.locator("summary").click();
    await expect(earlier.getByTestId("parameter-history-stored").locator("tr[data-name]")).toHaveCount(shown.length);
    expect(shown.map(([, outcome]) => outcome)).toEqual(expect.arrayContaining(["confirmed", "refused", "stale"]));
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// TASK-089 (S08): with Ideal sensors this run switches ArduPilot's barometer noise off, and the experiment record says so. A write of
// that parameter would add an error the record says is not there, so it is refused before sending, with the reason, and ArduPilot keeps
// its 0. A parameter that sets no error is confirmed as usual. Terms MirageSITL itself applies are refused at the start of a Run tab run
// (run-panel.spec.ts), so tests/error-ownership.test.ts covers that branch of the same check.
test("the Parameters tab refuses a parameter of an error this run has switched off, against native SITL", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-parameters-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    await seedQuadProject(page, "Quad X ideal sensors", { idealSensors: true });
    const panel = page.getByRole("tabpanel", { name: "Parameters" });
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 180000 });
    await page.getByRole("tab", { name: "Parameters" }).click();
    await expect(panel.getByTestId("parameters-status")).toHaveAttribute("data-download", "complete");
    const rows = (name: string): Locator => panel.getByTestId("parameter-history").locator(`tr[data-name="${name}"]`);
    const value = (name: string): Locator => panel.getByTestId("parameter-table").locator(`tr[data-name="${name}"]`).getByTestId("parameter-value");
    const write = async (name: string, text: string) => {
      await panel.getByLabel("Search parameters").fill(name);
      await panel.getByTestId("parameter-table").getByRole("button", { name, exact: true }).click();
      await panel.getByLabel(`New value of ${name}`).fill(text);
      await panel.getByRole("button", { name: "Write", exact: true }).click();
    };

    await write("SIM_BARO_RND", "0.25");
    await expect(rows("SIM_BARO_RND").last()).toHaveAttribute("data-outcome", "refused");
    await expect(rows("SIM_BARO_RND").last()).toContainText("Refused before sending: it sets barometer noise, which this run switches off, so writing it would add an error the experiment record says is not there; change it on the Sensors tab");
    await expect(value("SIM_BARO_RND")).toHaveText("0");
    console.log(`EVID refused ${(await rows("SIM_BARO_RND").last().textContent()) ?? ""}`);

    await write("RTL_ALT_M", "20");
    await expect(rows("RTL_ALT_M").last()).toHaveAttribute("data-outcome", "confirmed", { timeout: 30000 });
    await expect(value("RTL_ALT_M")).toHaveText("20");

    await page.getByRole("tab", { name: "Run" }).click();
    await run.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30000 });
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
