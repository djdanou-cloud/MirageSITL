import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Download, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";

// TASK-165 (S16): the experiment lifecycle with native ArduCopter fb773567,
// through the application alone. An original run, then its Repeat, loaded in
// the Run tab with the same inputs locked, records the same trajectory at
// every common tick before any command; Create variant runs it at another
// speed and the record lists that change; the parent is never changed. The
// differences are shown, never judged (user decision of 2026-11-03). An
// exported experiment imports into another browser profile, which lists what
// the archive could not hold: the recording and the ArduPilot build.

const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

/** Starts what the Run tab holds, waits for READY, and stops the run. */
async function runToReady(run: Locator, button: string): Promise<string> {
  await run.getByRole("button", { name: button }).click();
  await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300000 });
  const record = (await run.getByTestId("sitl-record").textContent()) ?? "";
  await run.getByRole("button", { name: "Stop run" }).click();
  await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30000 });
  return record;
}
async function saved(page: Page, button: Locator): Promise<Buffer> {
  const [file]: [Download, void] = await Promise.all([page.waitForEvent("download"), button.click()]);
  return readFileSync(await file.path());
}

test("Repeat and Create variant run as new experiments that name their parent, and an exported experiment lists what it leaves behind", async ({ page }) => {
  test.setTimeout(900_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-experiments-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    await seedQuadProject(page, "Quad X lifecycle");
    const runTab = page.getByRole("tab", { name: "Run" }), experimentsTab = page.getByRole("tab", { name: "Experiments" });
    const panel = page.getByRole("tabpanel", { name: "Experiments" });
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    const original = await runToReady(run, "Start SITL run");

    // Repeat: the Run tab loads the original's inputs, locked.
    await experimentsTab.click();
    const rows = panel.getByTestId("experiment-list").locator("tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-lineage", "original");
    await panel.getByRole("button", { name: "Repeat", exact: true }).click();
    await expect(runTab).toHaveAttribute("aria-selected", "true");
    await expect(run.getByTestId("sitl-plan")).toHaveAttribute("data-kind", "repeat");
    await expect(run.getByLabel("Speed")).toBeDisabled();
    await expect(run.getByLabel("Speed")).toHaveValue("4");
    await expect(run.getByLabel("Aircraft profile")).toBeDisabled();
    const repeat = await runToReady(run, "Start repeat");
    await expect(run.getByTestId("sitl-plan")).toHaveCount(0);

    await experimentsTab.click();
    await expect(rows).toHaveCount(2);
    await panel.locator(`tr[data-sha="${repeat}"]`).getByRole("button").click();
    await expect(panel.getByTestId("experiment-lineage")).toHaveText(/^Repeat of Quad X lifecycle run /);
    await expect(panel.getByTestId("experiment-input-differences")).toHaveText("No input differs.");
    await panel.getByRole("button", { name: "Compare the recorded trajectories" }).click();
    const trajectory = panel.getByTestId("experiment-trajectory");
    await expect(trajectory).toContainText("Shown, not judged.", { timeout: 30000 });
    // No command reached the autopilot in either run: every common recorded tick holds the same position.
    await expect(trajectory).toHaveAttribute("data-first-different", "none");
    expect(Number(await trajectory.getAttribute("data-compared"))).toBeGreaterThan(500);
    console.log(`EVID repeat ${(await trajectory.textContent()) ?? ""}`);

    // Create variant of the original at another speed: the record lists the change, and the original stays as it was.
    await panel.locator(`tr[data-sha="${original}"]`).getByRole("button").click();
    await panel.getByRole("button", { name: "Create variant" }).click();
    await expect(run.getByTestId("sitl-plan")).toHaveAttribute("data-kind", "variant");
    await expect(run.getByLabel("Speed")).toBeEnabled();
    await run.getByLabel("Speed").selectOption("2");
    const variant = await runToReady(run, "Start variant");
    await experimentsTab.click();
    await expect(rows).toHaveCount(3);
    await panel.locator(`tr[data-sha="${variant}"]`).getByRole("button").click();
    await expect(panel.getByTestId("experiment-lineage")).toHaveText(/^Variant of Quad X lifecycle run .*: speed changed$/);
    await expect(panel.getByTestId("experiment-input-differences")).toHaveText("Inputs that differ: speed.");
    await expect(panel.locator(`tr[data-sha="${original}"]`)).toHaveAttribute("data-lineage", "original");

    // Export the repeat; another browser profile imports it and lists what the archive left behind.
    await panel.locator(`tr[data-sha="${repeat}"]`).getByRole("button").click();
    await expect(panel.getByTestId("experiment-external")).toContainText(`ArduPilot build ${FIRMWARE_ID}`);
    const archive = await saved(page, panel.getByRole("button", { name: "Export the experiment" }));
    const other = await page.context().browser()?.newContext();
    if (!other) throw new Error("No browser for another profile");
    try {
      const second = await other.newPage();
      await second.goto("/");
      await second.getByRole("tab", { name: "Experiments" }).click();
      const otherPanel = second.getByRole("tabpanel", { name: "Experiments" });
      await otherPanel.getByLabel("Experiment archive (.mirageproj)").setInputFiles({ name: "repeat.mirageproj", mimeType: "application/octet-stream", buffer: archive });
      const lacking = otherPanel.getByTestId("experiments-lacking");
      await expect(lacking).toContainText("is not in this browser");
      await expect(lacking).toContainText(`needs ArduPilot build ${FIRMWARE_ID}`);
      console.log(`EVID import ${(await otherPanel.getByTestId("experiments-imported").textContent()) ?? ""}`);
    } finally {
      await other.close();
    }
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
