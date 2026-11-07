import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { readExperimentRecords, seedQuadProject } from "../support/run-tab";

// TASK-182 (S15): a real log and an interval give a report field by field; the user supplies the aircraft; the run it plans starts on
// native ArduCopter fb773567 at the log's home with the log's settings, and its experiment says where it came from.

const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";
const REFERENCE = join(ROOT, "tests/fixtures/dataflash/sitl-copter.bin");

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

test("a log and an interval become a report, the aircraft is supplied, and the experiment it plans runs", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-from-log-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const seeded = await seedQuadProject(page, "Quad X from log");
    await page.getByRole("tab", { name: "Experiments", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Experiments", exact: true }), wizard = panel.getByTestId("from-log");

    // A file that is no log is refused, with its reason.
    const notALog = join(home, "notes.bin");
    writeFileSync(notALog, "not a log");
    await wizard.getByLabel("DataFlash log (.bin)").setInputFiles(notALog);
    await expect(wizard.getByTestId("from-log-refused")).toBeVisible();

    await wizard.getByLabel("DataFlash log (.bin)").setInputFiles(REFERENCE);
    await expect(wizard.getByTestId("from-log-interval")).toContainText("sitl-copter.bin runs from");
    // An interval outside the log is refused too.
    await wizard.getByLabel("From, s").fill("9000");
    await wizard.getByLabel("To, s").fill("9001");
    await wizard.getByRole("button", { name: "Read the log", exact: true }).click();
    await expect(wizard.getByTestId("from-log-refused")).toContainText("does not lie in this log");
    await wizard.getByLabel("From, s").fill("42.4");
    await wizard.getByLabel("To, s").fill("42.6");
    await wizard.getByRole("button", { name: "Read the log", exact: true }).click();

    const report = wizard.getByTestId("from-log-report"), row = (key: string) => report.locator(`tr[data-key="${key}"]`);
    await expect(row("home")).toHaveAttribute("data-status", "extracted");
    await expect(row("home")).toContainText("-35.3629380°, 149.1650850°, 584.00 m");
    await expect(row("home")).toContainText("ORGN");
    await expect(row("attitude")).toContainText("ATT");
    await expect(row("parameters")).toContainText("PARM");
    await expect(row("wind")).toContainText("estimate");
    // What it cannot say is listed, and nothing starts until the aircraft is supplied.
    await expect(row("aircraft")).toHaveAttribute("data-status", "missing");
    await expect(wizard.getByTestId("from-log-missing")).toContainText("Aircraft profile");
    await expect(wizard.getByTestId("from-log-missing")).toContainText("Turbulence");
    const load = wizard.getByRole("button", { name: "Load into the Run tab", exact: true });
    await expect(load).toBeDisabled();
    await wizard.getByLabel("Aircraft for the new run").selectOption({ label: "Quad X from log (version 1)" });
    await expect(row("aircraft")).toHaveAttribute("data-status", "user-supplied");
    await expect(wizard.getByTestId("from-log-missing")).not.toContainText("Aircraft profile");
    await load.click();

    // The Run tab has it, and it starts.
    await expect(page.getByRole("tab", { name: "Run", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await expect(run.getByTestId("sitl-plan")).toHaveAttribute("data-kind", "from-log");
    await expect(run.getByTestId("sitl-plan")).toContainText("sitl-copter.bin");
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    await expect(run.getByTestId("sitl-plan")).toHaveCount(0);
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 60_000 });

    // The experiment flew from the log's home with its settings, and says where it came from.
    const records = await readExperimentRecords(page, seeded);
    const flown = records.experiments.at(-1);
    expect(flown?.session.home[0]).toBeCloseTo(-35.362938, 5);
    expect(flown?.session.home[1]).toBeCloseTo(149.165085, 5);
    expect(flown?.parameters.filter(parameter => parameter.source === "set").length).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "Experiments", exact: true }).click();
    await panel.getByTestId("experiment-list").locator("tbody tr").first().getByRole("button").click();
    await expect(panel.getByTestId("experiment-from-log")).toContainText("sitl-copter.bin");
    await expect(panel.getByTestId("experiment-from-log")).toContainText("42.40 s to 42.60 s");
    await expect(panel.getByTestId("experiment-from-log")).toContainText("Turbulence");
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
