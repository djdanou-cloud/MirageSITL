import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";

// TASK-174 (S10): manual flight of native ArduCopter fb773567 with a mocked
// USB controller (the Gamepad API, default TASK-038 calibration: throttle on
// axis 2, -1 down, 1 up), through the Run tab alone. With the throttle down
// MirageSITL sets altitude hold and arms; raising the throttle climbs and
// centring it holds. Unplugging pauses the run (user decision of
// 2026-11-03): simulated time stands, and Resume waits for the controller.
// Stalling the page's main thread stops the stick commands, so the physics
// Worker pauses the run: thrust is never held on stale input, and Resume goes
// on in manual control with the controller that never left. A controller
// plugged back in is a new device (TASK-038) and does not take over: Resume
// gives the flight back to MirageSITL, which holds position in GUIDED.

const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

interface TestPad { index: number; connected: boolean; id: string; axes: number[]; buttons: never[]; mapping: string; timestamp: number }
/** Changes the mocked controller: its throttle axis (raw, -1 down to 1 up), whether it is plugged in, and its device ID. */
const pad = (page: Page, change: { readonly throttle?: number; readonly connected?: boolean; readonly id?: string }) => page.evaluate(next => {
  const target = (window as unknown as { testPad: TestPad }).testPad;
  if (next.throttle !== undefined) target.axes[2] = next.throttle;
  if (next.connected !== undefined) target.connected = next.connected;
  if (next.id !== undefined) target.id = next.id;
}, change);
const simTime = async (run: Locator) => Number.parseFloat((await run.getByTestId("sitl-sim-time").textContent()) ?? "NaN");
const altitude = async (run: Locator) => Number((await run.getByTestId("sitl-altitude").textContent())?.replace(" m", ""));

test("manual flight with a USB controller arms, climbs and holds, and losing the controller pauses the run", async ({ page }) => {
  test.setTimeout(600_000);
  await page.addInitScript(() => {
    const testPad = { index: 0, connected: true, id: "Mirage test transmitter", axes: [0, 0, -1, 0], buttons: [], mapping: "", timestamp: 0 };
    Object.defineProperty(navigator, "getGamepads", { value: () => [testPad.connected ? { ...testPad, axes: [...testPad.axes] } : null] });
    Object.assign(window, { testPad });
  });
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-manual-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    await seedQuadProject(page, "Quad X manual");
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300000 });
    const stage = run.getByTestId("sitl-stage");
    await expect(run.getByTestId("manual-controller")).toHaveAttribute("data-status", "connected");

    // The throttle up refuses; down, MirageSITL sets altitude hold and arms.
    await pad(page, { throttle: 0 });
    await run.getByRole("button", { name: "Take manual control" }).click();
    await expect(run.getByTestId("manual-refusal")).toHaveText("Lower the throttle to take manual control on the ground");
    await pad(page, { throttle: -1 });
    await run.getByRole("button", { name: "Take manual control" }).click();
    await expect(stage).toHaveText("Manual control");
    await expect(run.getByTestId("sitl-mode")).toHaveText("ALTHOLD", { timeout: 30000 });
    await expect(run.getByTestId("sitl-armed")).toHaveText("Armed", { timeout: 30000 });
    // Throttle up climbs; centred (0.5, a raw 0) holds altitude.
    await pad(page, { throttle: 0.8 });
    await expect.poll(() => altitude(run), { timeout: 60000 }).toBeGreaterThan(4);
    await pad(page, { throttle: 0 });
    await page.waitForTimeout(3000);
    const held = await altitude(run);
    await page.waitForTimeout(4000);
    expect(Math.abs((await altitude(run)) - held)).toBeLessThan(1);
    console.log(`EVID climbed and held at ${held} m`);

    // A stalled main thread stops the stick commands: the Worker pauses the run. The controller never left, so Resume
    // goes on in manual control.
    await page.evaluate(() => { const end = performance.now() + 1500; while (performance.now() < end) { /* the page stalls */ } });
    await expect(stage).toHaveAttribute("data-state", "paused", { timeout: 10000 });
    await expect(stage).toContainText("controller lost");
    await run.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(stage).toHaveText("Manual control", { timeout: 30000 });
    await expect(run.getByTestId("manual-status")).toHaveAttribute("data-mode", "alt-hold");

    // Unplugged: the run pauses, simulated time stands, and Resume waits for the controller.
    await pad(page, { connected: false });
    await expect(stage).toHaveAttribute("data-state", "paused", { timeout: 10000 });
    await expect(stage).toContainText("controller lost");
    await page.waitForTimeout(1000);
    const pausedAt = await simTime(run);
    await page.waitForTimeout(3000);
    expect(await simTime(run)).toBe(pausedAt);
    await run.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(run.getByTestId("manual-refusal")).toHaveText("Reconnect the controller, or release manual control");
    await expect(stage).toHaveAttribute("data-state", "paused");
    const reasons = await run.getByTestId("sitl-pauses").getByRole("listitem").evaluateAll(items => items.map(item => item.getAttribute("data-reason")));
    expect(reasons).toEqual(["controller", "controller"]);
    // Plugged back in, it is a new device (TASK-038) and does not take over: Resume holds position in GUIDED.
    await pad(page, { connected: true });
    await expect(run.getByTestId("manual-controller")).toHaveAttribute("data-status", "connected");
    await run.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(stage).toHaveText("Flying", { timeout: 30000 });
    await expect(run.getByTestId("sitl-mode")).toHaveText("GUIDED", { timeout: 30000 });
    await expect(run.getByTestId("manual-status")).toHaveCount(0);
    const guided = await altitude(run);
    await page.waitForTimeout(4000);
    expect(Math.abs((await altitude(run)) - guided)).toBeLessThan(1);
    console.log(`EVID GUIDED after replug holds ${guided} m; pauses ${reasons.join(",")}`);
    // Manual control can be taken again in flight, with the throttle centred.
    await pad(page, { throttle: 0 });
    await run.getByRole("button", { name: "Take manual control" }).click();
    await expect(stage).toHaveText("Manual control");
    await expect(run.getByTestId("sitl-mode")).toHaveText("ALTHOLD", { timeout: 30000 });
    await run.getByRole("button", { name: "Release manual control" }).click();
    await expect(stage).toHaveText("Flying");

    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 120000 });
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 30000 });
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
