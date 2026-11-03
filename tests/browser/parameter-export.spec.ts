import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Download, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { parseParamFile, type ParameterEntry } from "../../packages/autopilot/src/param-file";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-161 (S11): parameter file export from the Parameters tab against
// native ArduCopter 8ab6afde, through the application alone. With a write
// pending while the run is paused, the file of all parameters holds
// ArduPilot's confirmed value and the preview names the pending one; the
// file of changes against a stored set and the file of chosen parameters and
// groups match oracles computed here from the all-parameters file and the
// set; the context header names the aircraft, the firmware and the
// experiment; an experiment record exports its generated parameters; and the
// simulator settings are a project archive of the profile and its cards
// only. Loading a file back into SITL is checked natively by
// scripts/check-param-file-sitl.mjs.

type Archive = typeof import("../../packages/project/src/archive");
type Store = typeof import("../../packages/project/src/store");
type Sets = typeof import("../../apps/web/src/params/parameter-sets");
const urls = {
  archive: viteFileUrl(new URL("../../packages/project/src/archive.ts", import.meta.url)),
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  sets: viteFileUrl(new URL("../../apps/web/src/params/parameter-sets.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

async function saved(page: Page, button: Locator): Promise<{ name: string; bytes: Buffer }> {
  const [file]: [Download, void] = await Promise.all([page.waitForEvent("download"), button.click()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), bytes: readFileSync(path) };
}
const byName = (entries: readonly ParameterEntry[]) => new Map(entries.map(e => [e.name, e.value]));

test("the Parameters tab exports parameter files and simulator settings against native SITL", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-export-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const { projectId } = await seedQuadProject(page, "Quad X export");
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
    const record = (await run.getByTestId("sitl-record").textContent()) ?? "";
    expect(record).toMatch(/^[0-9a-f]{64}$/);

    await paramsTab.click();
    await expect(panel.getByTestId("parameters-status")).toHaveAttribute("data-download", "complete");
    const rows = (name: string): Locator => panel.getByTestId("parameter-history").locator(`tr[data-name="${name}"]`);
    const write = async (name: string, value: string) => {
      await panel.getByLabel("Search parameters").fill(name);
      await panel.getByTestId("parameter-table").getByRole("button", { name, exact: true }).click();
      await panel.getByLabel(`New value of ${name}`).fill(value);
      await panel.getByRole("button", { name: "Write", exact: true }).click();
    };
    await panel.getByLabel("Set name").fill("Baseline");
    await panel.getByRole("button", { name: "Save as parameter set" }).click();
    await expect(panel.getByTestId("parameters-notice")).toContainText('Saved set "Baseline"');
    await write("RTL_ALT_M", "20.25");
    await expect(rows("RTL_ALT_M").last()).toHaveAttribute("data-outcome", "confirmed");
    await write("GPS1_DELAY_MS", "10");
    await expect(rows("GPS1_DELAY_MS").last()).toHaveAttribute("data-outcome", "confirmed");
    // A write the paused SITL has not answered yet.
    await runTab.click();
    await run.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "paused");
    await paramsTab.click();
    await write("LAND_SPD_MS", "0.75");
    await expect(rows("LAND_SPD_MS").last()).toHaveAttribute("data-outcome", "requested");

    // All parameters: the confirmed read-back, with the pending write named in the preview only.
    const exportSection = panel.getByRole("region", { name: "Export a parameter file" });
    await expect(exportSection.getByTestId("parameter-export-summary")).toContainText(/^(\d+) of \1 parameters from the running SITL's read-back; aircraft Quad X export/);
    const total = Number(/^(\d+) of/.exec((await exportSection.getByTestId("parameter-export-summary").textContent()) ?? "")?.[1]);
    await expect(exportSection.getByTestId("parameter-export-preview").locator("tbody tr").first()).toHaveAttribute("data-source", "sitl");
    const all = await saved(page, exportSection.getByRole("button", { name: "Save the parameter file" }));
    expect(all.name).toMatch(/^Quad-X-export-.*\.param$/);
    const allText = all.bytes.toString("utf8"), allEntries = parseParamFile(allText), values = byName(allEntries);
    expect(allEntries).toHaveLength(total);
    expect(values.get("RTL_ALT_M")).toBe(20.25);
    expect(values.get("GPS1_DELAY_MS")).toBe(10);
    expect(values.get("LAND_SPD_MS")).not.toBe(0.75);
    const header = allText.split("\n").filter(line => line.startsWith("#"));
    expect(header).toEqual(expect.arrayContaining([
      expect.stringMatching(/^# Aircraft profile: Quad X export, version 1, [0-9a-f]{64}$/),
      expect.stringMatching(/^# ArduPilot: .*, commit 8ab6afde107a91df1b5f60ade8f333cb8a61b190$/),
      expect.stringMatching(new RegExp(`^# Experiment: \\d{17}-[0-9a-f]{8}, record ${record}$`)),
      `# Parameters: ${total}`,
    ]));
    // Search narrows the preview to the pending parameter, whose note says so.
    await exportSection.getByRole("radio", { name: "Chosen parameters and groups" }).check();
    await exportSection.getByLabel("Parameters (names, comma-separated)").fill("LAND_SPD_MS");
    await expect(exportSection.getByTestId("parameter-export-preview").locator('tr[data-name="LAND_SPD_MS"]'))
      .toContainText(/A write of 0\.75 is pending; the file holds ArduPilot's confirmed value/);

    // Chosen parameters and groups, against the oracle from the all-parameters file.
    await exportSection.getByLabel("Parameters (names, comma-separated)").fill("GPS1_DELAY_MS, atc_rat_rll_p");
    await exportSection.getByLabel(/^Groups/).fill("RTL");
    const chosen = parseParamFile((await saved(page, exportSection.getByRole("button", { name: "Save the parameter file" }))).bytes.toString("utf8"));
    const chosenOracle = allEntries.filter(e => e.name === "GPS1_DELAY_MS" || e.name === "ATC_RAT_RLL_P" || e.name === "RTL" || e.name.startsWith("RTL_"));
    expect(chosen).toEqual(chosenOracle);
    expect(chosen.length).toBeGreaterThan(5);

    // Changes against the stored set, against the oracle from the set as stored and the all-parameters file.
    await exportSection.getByRole("radio", { name: "Changes against a parameter set" }).check();
    const changes = parseParamFile((await saved(page, exportSection.getByRole("button", { name: "Save the parameter file" }))).bytes.toString("utf8"));
    const baseline = await page.evaluate(async ({ urls, projectId }) => {
      const { ProjectStore } = await import(urls.store) as Store;
      const { readParameterSet } = await import(urls.sets) as Sets;
      const store = await ProjectStore.openIndexedDb();
      try {
        const [set] = await store.listItems(projectId, "parameter-set");
        if (!set) throw new Error("No parameter set");
        return readParameterSet(set).parameters.map(p => [p.name, p.value] as [string, number]);
      } finally { store.close(); }
    }, { urls, projectId });
    const base = new Map(baseline);
    expect(changes).toEqual(allEntries.filter(e => base.get(e.name) !== e.value));
    expect(changes.map(e => e.name)).toEqual(expect.arrayContaining(["GPS1_DELAY_MS", "RTL_ALT_M"]));
    console.log(`EVID export all=${allEntries.length} chosen=${chosen.length} changes=${changes.map(e => e.name).join(",")}`);

    // The simulator settings: a project archive of the profile and its cards, without runs.
    const settings = await saved(page, exportSection.getByRole("button", { name: "Save the simulator settings" }));
    expect(settings.name).toBe("Quad-X-export-simulator-settings.mirageproj");
    const kinds = await page.evaluate(async ({ urls, bytes }) => {
      const { decodeArchive } = await import(urls.archive) as Archive;
      const { versions } = await decodeArchive(new Uint8Array(bytes));
      return versions.map(v => v.record.kind);
    }, { urls, bytes: [...settings.bytes] });
    expect(new Set(kinds)).toEqual(new Set(["project", "component-card", "aircraft-profile"]));
    console.log(`EVID settings ${settings.bytes.length} bytes, ${kinds.length} records: ${kinds.join(",")}`);

    // An experiment record exports the parameters MirageSITL generated from its saved profile.
    await exportSection.getByRole("radio", { name: "All" }).check();
    await exportSection.getByLabel("Values from").selectOption({ label: (await exportSection.getByLabel("Values from").locator("option", { hasText: "Experiment " }).first().textContent()) ?? "" });
    await expect(exportSection.getByTestId("parameter-export-preview").locator("tbody tr").first()).toHaveAttribute("data-source", "experiment");
    const generated = parseParamFile((await saved(page, exportSection.getByRole("button", { name: "Save the parameter file" }))).bytes.toString("utf8"));
    expect(generated.map(e => e.name)).toEqual(expect.arrayContaining(["FRAME_CLASS", "FRAME_TYPE", "MOT_PWM_MIN", "MOT_PWM_MAX"]));
    for (const entry of generated) expect(values.get(entry.name), entry.name).toBe(entry.value);

    await runTab.click();
    await run.getByRole("button", { name: "Resume", exact: true }).click();
    await paramsTab.click();
    await expect(rows("LAND_SPD_MS").last()).toHaveAttribute("data-outcome", "confirmed", { timeout: 30000 });
    await runTab.click();
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30000 });
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
