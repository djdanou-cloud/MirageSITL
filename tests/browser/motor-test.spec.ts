import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { field, seedQuadProject } from "../support/run-tab";

// TASK-157 through the Run tab alone, with the installed ArduCopter: before
// take-off the motor check spins each of the S19 quad X's motors in
// ArduPilot's test order (motors 1, 4, 2, 3, catalog frame quad-x), the flight
// view rings the rotor the physics turns, which is the motor being tested,
// every motor passes, and the check is not offered in flight. The five
// configurations and the swapped and reversed faults run against the same
// ArduCopter in tests/motor-check-sitl.test.ts.
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

test("the motor check spins each motor alone before flight, rings the turning rotor, and passes", async ({ page }) => {
  test.setTimeout(600000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-motor-test-"));
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    await seedQuadProject(page, "Quad X SITL");
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const panel = page.getByRole("region", { name: "ArduPilot SITL" });
    const check = panel.getByTestId("motor-check"), button = check.getByRole("button");
    await expect(button).toBeDisabled();
    await panel.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await panel.getByLabel("Launcher token", { exact: true }).fill(token);
    await panel.getByRole("button", { name: "List ArduPilot builds" }).click();
    // Real time: each motor spins 1.5 s, long enough for the view's probe (every 20 frames) to see every ring.
    await panel.getByLabel("Speed").selectOption("1");
    await panel.getByRole("button", { name: "Start SITL run" }).click();
    const stage = panel.getByTestId("sitl-stage");
    await expect(stage).toHaveAttribute("data-state", /warming|ready/, { timeout: 120000 });
    await expect(button).toBeEnabled();
    await button.click();

    // While it runs, the view rings the rotor the physics turns, read from its own probe: one motor after the other,
    // in ArduPilot's test order (a motor still spinning down stays ringed until the next one is faster).
    const view = panel.getByTestId("flight-view");
    const seen: number[] = [];
    while ((await check.getAttribute("data-state")) === "running") {
      const probe: unknown = JSON.parse((await view.getAttribute("data-probe")) ?? "null");
      const ringed = field(probe, "ringed");
      if (typeof ringed === "number" && seen.at(-1) !== ringed) seen.push(ringed);
      await page.waitForTimeout(50);
    }
    await expect(check).toHaveAttribute("data-state", "passed", { timeout: 120000 });
    expect(seen).toEqual([1, 4, 2, 3]);
    for (const [order, motor] of [[1, 1], [2, 4], [3, 2], [4, 3]] as const) {
      const row = check.getByTestId(`motor-check-${order}`);
      await expect(row).toHaveAttribute("data-pass", "true");
      await expect(row).toContainText(`Motor ${motor}, output ${motor}`);
    }
    await expect(check.getByTestId("motor-check-summary")).toHaveText("All 4 motors turn as the profile and ArduPilot's frame expect.");

    // Not offered in flight.
    await expect(stage).toHaveAttribute("data-state", "ready", { timeout: 180000 });
    await panel.getByLabel("Take-off altitude, m").fill("3");
    await panel.getByRole("button", { name: "Take off" }).click();
    await expect(panel.getByTestId("sitl-armed")).toHaveText("Armed", { timeout: 60000 });
    await expect(button).toBeDisabled();
    await panel.getByRole("button", { name: "Stop run" }).click();
    await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 30000 });
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
