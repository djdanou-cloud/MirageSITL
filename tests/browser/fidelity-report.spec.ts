import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-184 (S15) on the reference Mac: a hover of native ArduCopter 8ab6afde flown from the Run tab, then compared on the Analysis tab with
// a second log through the fidelity report alone. The second log here is the repository's SITL log (tests/fixtures/dataflash/sitl-copter.bin):
// no real flight log exists yet (G4), so the report must say it is simulated and the profile version must stay not flight-checked. Declared:
//  - the report shows every quantity's row, over the interval and per regime, compared or missing with a reason, and no word that judges;
//  - the saved comparison is a `fidelity-comparison` record of the run's profile version, holding both logs' SHA-256 and origins;
//  - with a real flight log in its place (MIRAGE_REAL_FLIGHT_LOG), the version becomes flight-checked in the regimes it compared.
// Needs the TASK-152 installation; it skips everywhere else.

type Store = typeof import("../../packages/project/src/store");
const urls = { store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)) };
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";
const REAL = process.env.MIRAGE_REAL_FLIGHT_LOG ?? join(ROOT, "tests/fixtures/dataflash/sitl-copter.bin");

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

test("a flown hover is compared with a second log through the fidelity report, kept as a comparison of its profile version, and judged by nobody", async ({ page }) => {
  test.setTimeout(900_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-fidelity-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const seeded = await seedQuadProject(page, "Quad X fidelity");
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    await run.getByLabel("Take-off altitude, m").fill("5");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect.poll(async () => Number.parseFloat((await run.getByTestId("sitl-altitude").textContent()) ?? "NaN"), { timeout: 120_000 }).toBeGreaterThan(4.5);
    await page.waitForTimeout(10_000);
    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 180_000 });
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30_000 });

    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    const report = page.getByRole("tabpanel", { name: "Analysis", exact: true }).getByTestId("fidelity-report");
    const experiment = report.getByLabel("Simulated run (experiment)", { exact: true });
    await experiment.selectOption({ index: 1 });
    await expect(report.getByTestId("fidelity-simulated-note")).toContainText(/ArduPilot's own log of this run|MirageSITL's truth from the stored recording/, { timeout: 60_000 });
    await expect(report.getByTestId("fidelity-label")).toContainText("not flight-checked; it has no comparison with a real flight log");
    await report.getByLabel("Real flight log (.bin)", { exact: true }).setInputFiles(REAL);
    await expect(report.getByLabel("Real log to, s", { exact: true })).not.toHaveValue("", { timeout: 30_000 });
    await report.getByRole("button", { name: "Compare", exact: true }).click();
    const result = report.getByTestId("fidelity-result");
    await expect(result).toBeVisible({ timeout: 60_000 });
    const real = process.env.MIRAGE_REAL_FLIGHT_LOG !== undefined;
    await expect(report.getByTestId("fidelity-origin")).toContainText(real ? "a real flight" : "simulated (It sets the SITL parameter SIM_");
    // Every quantity has its row over the whole interval, compared or missing with its reason.
    for (const quantity of ["roll", "pitch", "yaw", "rollRate", "pitchRate", "yawRate", "altitude", "verticalSpeed", "batteryVoltage", "batteryCurrent", "motorOutput"]) {
      const row = result.locator(`tr[data-quantity="${quantity}"][data-regime="all"]`);
      await expect(row).toHaveCount(1);
      if ((await row.getAttribute("data-status")) === "missing") await expect(row).toContainText("Missing: ");
    }
    expect((await result.textContent()) ?? "").not.toMatch(/\b(pass|fail|verdict|limit)\b/i);
    await report.getByRole("button", { name: "Save comparison", exact: true }).click();
    await expect(report.getByTestId("fidelity-status")).toContainText("Saved as a comparison of");
    const stored = await page.evaluate(async ({ urls, projectId }) => {
      const { ProjectStore } = await import(urls.store) as Store;
      const store = await ProjectStore.openIndexedDb();
      try {
        const [item] = await store.listItems(projectId, "fidelity-comparison");
        return item ? { dependencies: item.record.dependencies, payload: JSON.parse(JSON.stringify(item.record.payload)) as { real: { sha256: string; origin: string }; profile: { sha256: string } } } : null;
      } finally { store.close(); }
    }, { urls, projectId: seeded.projectId });
    expect(stored?.dependencies).toEqual([{ kind: "aircraft-profile", sha256: seeded.profileSha256 }]);
    expect(stored?.payload.profile.sha256).toBe(seeded.profileSha256);
    expect(stored?.payload.real.sha256).toBe(createHash("sha256").update(readFileSync(REAL)).digest("hex"));
    await expect(report.getByTestId("fidelity-label")).toContainText(real ? "flight-checked in" : "not flight-checked");
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
