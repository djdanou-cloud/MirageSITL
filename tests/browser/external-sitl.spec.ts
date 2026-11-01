import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import {
  field, groupMembers, launcherExperiments, processesNaming, psGroup, readExperimentRecords, seedQuadProject, signalZeroCode,
} from "../support/run-tab";

// TASK-153 (S01, S02, S03) DoD: in the browser application, a profile-defined
// quad X arms, takes off, holds and lands with native ArduCopter. The launcher
// runs on a temporary home holding copies of the TASK-152 installation's token
// and catalog, so the installed ArduCopter 8ab6afde and its Python environment
// are used while the installation itself is only read; the project, the
// example component cards and the S19 quad X profile are seeded through the
// application's own store modules, and the flight is driven through the Run
// tab alone. READY must come from the Worker's LiveEkfWarmup on this run.
// TASK-154 adds the experiment record of this real build and the check that
// Stop leaves no process of the run.
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

/** The TASK-152 catalog entry of the build this test flies. */
function catalogEntry(): { binaryPath: string; defaultParametersPath: string; firmwareVersion: string; commit: string; binarySha256: string; defaultParametersSha256: string } {
  const catalog: unknown = JSON.parse(readFileSync(join(HOME, "catalog.json"), "utf8"));
  const list = field(catalog, "firmware");
  const items: readonly unknown[] = Array.isArray(list) ? list : [];
  const entry = items.find(item => field(item, "id") === FIRMWARE_ID);
  const binaryPath = field(entry, "binaryPath"), defaultParametersPath = field(entry, "defaultParametersPath"), firmwareVersion = field(entry, "firmwareVersion");
  const commit = field(entry, "commit"), binarySha256 = field(entry, "binarySha256"), defaultParametersSha256 = field(entry, "defaultParametersSha256");
  if (typeof binaryPath !== "string" || typeof defaultParametersPath !== "string" || typeof firmwareVersion !== "string" || typeof commit !== "string" ||
    typeof binarySha256 !== "string" || typeof defaultParametersSha256 !== "string") throw new Error(`The TASK-152 catalog has no usable ${FIRMWARE_ID}`);
  return { binaryPath, defaultParametersPath, firmwareVersion, commit, binarySha256, defaultParametersSha256 };
}

test("the Run tab flies the quad X profile with native ArduCopter: READY, take-off to 5 m, hold and land", async ({ page }) => {
  test.setTimeout(600000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const entry = catalogEntry();
  const home = mkdtempSync(join(tmpdir(), "mirage-external-sitl-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const seeded = await seedQuadProject(page, "Quad X SITL");

    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const panel = page.getByRole("region", { name: "ArduPilot SITL" });
    await expect(panel.getByLabel("Aircraft profile")).toContainText("Quad X SITL");
    await panel.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await panel.getByLabel("Launcher token", { exact: true }).fill(token);
    await panel.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(panel.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await panel.getByLabel("Speed").selectOption("4");
    expect((await new AxeBuilder({ page }).include(".sitl-flight").analyze()).violations).toEqual([]);
    await panel.getByRole("button", { name: "Start SITL run" }).click();

    const stage = panel.getByTestId("sitl-stage"), ready = panel.getByTestId("sitl-ready"), altitude = panel.getByTestId("sitl-altitude");
    await expect(ready).toHaveText("READY", { timeout: 180000 });
    await expect(stage).toHaveText("READY");
    expect(await page.evaluate(() => location.href)).not.toContain(token);

    // The experiment record of this run names the real build, hashed here independently, and this launcher experiment.
    const flown = await launcherExperiments(launcher.port, token, ORIGIN);
    expect(flown).toHaveLength(1);
    const experiment = flown[0], run = experiment?.runs.at(-1);
    if (!experiment || !run) throw new Error("The launcher has no run");
    const readback = await readExperimentRecords(page, seeded);
    expect(readback.experiments).toHaveLength(1);
    const record = readback.experiments[0];
    expect(record?.launcherExperimentId).toBe(experiment.id);
    expect(record?.ardupilot).toEqual({
      catalogId: FIRMWARE_ID, firmwareVersion: entry.firmwareVersion, commit: entry.commit,
      binarySha256: sha256(entry.binaryPath), defaultParametersSha256: sha256(entry.defaultParametersPath),
    });
    expect(record?.ardupilot?.binarySha256).toBe(entry.binarySha256);
    expect(record?.ardupilot?.defaultParametersSha256).toBe(entry.defaultParametersSha256);
    await expect(panel.getByTestId("sitl-record")).toHaveText(record?.sha256 ?? "missing");

    await panel.getByLabel("Take-off altitude, m").fill("5");
    await panel.getByRole("button", { name: "Take off" }).click();
    await expect(panel.getByTestId("sitl-armed")).toHaveText("Armed", { timeout: 60000 });
    await expect(stage).toHaveText("Flying", { timeout: 120000 });
    await expect(panel.getByTestId("sitl-mode")).toHaveText("GUIDED");
    // Hold: at least 10 s of simulated time as the page shows it, every reading within 0.5 m of 5 m.
    const meters = async () => Number((await altitude.textContent())?.replace(" m", ""));
    const simTime = async () => Number.parseFloat((await panel.getByTestId("sitl-sim-time").textContent()) ?? "NaN");
    // The panel refreshes every 250 ms; one simulated second passes before sampling, so no reading predates the settled climb.
    const settled = await simTime();
    while ((await simTime()) - settled < 1) await page.waitForTimeout(100);
    const holdStart = await simTime();
    const readings: number[] = [];
    while ((await simTime()) - holdStart < 10) {
      readings.push(await meters());
      await page.waitForTimeout(250);
    }
    expect(readings.length).toBeGreaterThan(3);
    expect(Math.min(...readings)).toBeGreaterThan(4.5);
    expect(Math.max(...readings)).toBeLessThan(5.5);

    // TASK-185: in the hover, the flight view draws the aircraft at the session's altitude (render up = -down)
    // with its trajectory, and the panels show the session's flight and per-motor values.
    const view = panel.getByTestId("flight-view");
    const probed = async () => {
      const text = await view.getAttribute("data-probe");
      const parsed: unknown = text ? JSON.parse(text) : null;
      const at = field(parsed, "aircraft");
      return { mode: field(parsed, "mode"), up: Array.isArray(at) ? Number(at[1]) : Number.NaN, trail: Number(field(parsed, "trailPoints")) };
    };
    await expect.poll(async () => (await probed()).up).toBeGreaterThan(4.5);
    const hover = await probed();
    expect(hover.up).toBeLessThan(5.5);
    // One sample per 0.1 s of simulated time: the climb and more than 10 s of hover.
    expect(hover.trail).toBeGreaterThan(100);
    const flightAltitude = Number.parseFloat((await panel.getByTestId("flight-altitude").textContent()) ?? "NaN");
    expect(Math.abs(flightAltitude - 5)).toBeLessThan(0.5);
    // Every motor turns, and its current is a number: a decelerating motor may brake regeneratively, so one motor's
    // current can be negative for a moment, while the pack as a whole supplies the hover.
    for (let motor = 1; motor <= 4; motor++) {
      const cells = panel.getByTestId(`power-motor-${motor}`).locator("td");
      expect(Number.parseFloat((await cells.nth(0).textContent()) ?? "NaN"), `motor ${motor} speed`).toBeGreaterThan(1000);
      expect(Number.isFinite(Number.parseFloat((await cells.nth(1).textContent()) ?? "NaN")), `motor ${motor} current`).toBe(true);
    }
    const packCurrent = panel.getByTestId("power-battery").locator("div", { hasText: "Current" }).locator("dd");
    expect(Number.parseFloat((await packCurrent.textContent()) ?? "NaN")).toBeGreaterThan(0);
    await panel.getByRole("radio", { name: "Onboard" }).check();
    await expect.poll(async () => (await probed()).mode).toBe("onboard");
    await panel.getByRole("radio", { name: "External" }).check();
    await expect.poll(async () => (await probed()).mode).toBe("external");

    await panel.getByRole("button", { name: "Land" }).click();
    await expect(panel.getByTestId("sitl-mode")).toHaveText("LAND", { timeout: 30000 });
    // Landed: disarmed on the ground, and the run is READY again.
    await expect(panel.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 120000 });
    await expect(stage).toHaveAttribute("data-state", "ready", { timeout: 60000 });
    await expect(ready).toHaveText("READY");
    // On its feet: the quad X profile's reference point rests at its 0.12 m ground clearance on the decision D-07 supports
    // (TASK-095), so its CG, 0.02 m lower, shows 0.10 m.
    expect(Math.abs((await meters()) - 0.1)).toBeLessThan(0.006);
    await expect(panel.getByTestId("sitl-frames")).toContainText(" 0 lost, 0 resent");
    await panel.getByRole("button", { name: "Stop run" }).click();
    await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 30000 });
    await expect(stage).toContainText("stopped");
    // Stop left no process of the run: its group, signal 0, and any process naming this launcher home.
    expect((await launcherExperiments(launcher.port, token, ORIGIN))[0]?.runs.at(-1)?.state).toBe("stopped");
    expect(psGroup(run.pid)).toBe("");
    expect(groupMembers(run.pid)).toEqual([]);
    expect(signalZeroCode(run.pid)).toBe("ESRCH");
    expect(processesNaming(home)).toEqual([]);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
