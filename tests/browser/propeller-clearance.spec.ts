import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { group, panel } from "../support/aircraft-ui";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-195 (S03, S18): the propeller clearance check and its fix, through the
// Aircraft and Run tabs alone. The project, the example component cards
// (0.254 m propellers) and the S19 quad X profile are seeded through the
// application's own store modules. Its arms are shortened to 0.17 m in the
// Aircraft tab, so neighbouring propellers overlap by 0.254 - 0.17·√2 m =
// 13.6 mm; the fix proposes 0.189 m arms (0.17·√2·k ≥ 0.254·1.05 gives
// 0.18859 m, rounded up to the millimetre). With the TASK-152 installation the
// Run tab refuses the clashing version and flies the fixed one with native
// ArduCopter.
type Store = typeof import("../../packages/project/src/store");
const urls = { store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)) };
const PROFILE = "Quad X clearance";
const CLASHES = ["1 and 3", "1 and 4", "2 and 3", "2 and 4"].map(pair => `The propellers of motors ${pair} overlap by 13.6 mm`);

/** The stored versions of the seeded profile, oldest first. */
async function versions(page: Page): Promise<{ version: number; payload: unknown }[]> {
  return page.evaluate(async ({ urls, name }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const store = await ProjectStore.openIndexedDb();
    try {
      const [project] = await store.listProjects();
      if (!project) throw new Error("No project");
      const head = (await store.listItems(project.record.id, "aircraft-profile")).find(stored => stored.record.name === name);
      if (!head) throw new Error(`No profile ${name}`);
      const history = await store.history(head.record.id);
      return history.map(stored => ({ version: stored.record.version, payload: JSON.parse(JSON.stringify(stored.record.payload)) as unknown }))
        .sort((a, b) => a.version - b.version);
    } finally {
      store.close();
    }
  }, { urls, name: PROFILE });
}

/** Opens the seeded profile in the Aircraft tab and saves it with 0.17 m arms; the clash list names the four neighbouring pairs. */
async function shortenArms(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
  const tab = panel(page);
  await tab.getByRole("button", { name: `Open ${PROFILE}`, exact: true }).click();
  await expect(tab.getByTestId("clearance-verdict")).toHaveText("Every propeller clears the other propellers, the body and the ground at rest.");
  for (let arm = 1; arm <= 4; arm++) await group(tab, `Arm ${arm}`).getByLabel("Length (m)", { exact: true }).fill("0.17");
  // A profile with a clash still saves.
  await tab.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText(`Saved version 2 of ${PROFILE}.`);
  await expect(tab.getByTestId("clearance-verdict")).toHaveText("The propellers clash, so no run starts from this profile. It can still be saved.");
  await expect(tab.getByRole("list", { name: "Propeller clashes" }).getByRole("listitem")).toHaveText(CLASHES);
}

/** Proposes the fix, checks what it shows before and after, and saves it as version 3. */
async function applyFix(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
  const tab = panel(page);
  await tab.getByRole("button", { name: "Propose a fix", exact: true }).click();
  const fix = tab.getByRole("group", { name: "Proposed fix" });
  await expect(fix.getByRole("table", { name: "Changes of the proposed fix" }).getByRole("row")).toHaveText([
    "ValueNowAfter the fix", ...[1, 2, 3, 4].map(arm => `Arm ${arm} length0.170 m0.189 m`),
  ]);
  await expect(fix).toContainText("Every arm grows by the same factor");
  await expect(fix).toContainText("The mass and inertia stay as they are");
  await expect(fix.getByRole("img", { name: "Now: the aircraft seen from above, to scale" })).toBeVisible();
  await expect(fix.getByRole("img", { name: "After the fix: the aircraft seen from above, to scale" })).toBeVisible();
  // The four propellers clash now and none after the fix.
  await expect(fix.getByRole("img", { name: "Now: the aircraft seen from above, to scale" }).locator("circle.clearance-disc.clash")).toHaveCount(4);
  await expect(fix.getByRole("img", { name: "After the fix: the aircraft seen from above, to scale" }).locator("circle.clash")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include("#clearance-heading").include(".clearance-fix").analyze()).violations).toEqual([]);
  // Nothing is saved until the fix is confirmed.
  expect(await versions(page)).toHaveLength(2);
  await fix.getByRole("button", { name: "Save the fixed version", exact: true }).click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText(`Saved the propeller clearance fix as version 3 of ${PROFILE}.`);
  await expect(tab.getByTestId("clearance-verdict")).toHaveText("Every propeller clears the other propellers, the body and the ground at rest.");
  for (let arm = 1; arm <= 4; arm++) await expect(group(tab, `Arm ${arm}`).getByLabel("Length (m)", { exact: true })).toHaveValue("0.189");
  const stored = await versions(page);
  expect(stored.map(entry => entry.version)).toEqual([1, 2, 3]);
  // Only the arm lengths differ from the clashing version.
  const lengths = (payload: unknown) => {
    const arms: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "arms") : null;
    const list: readonly unknown[] = Array.isArray(arms) ? arms : [];
    return list.map((arm): unknown => {
      if (typeof arm !== "object" || arm === null) return null;
      const length: unknown = Reflect.get(arm, "lengthM");
      return length;
    });
  };
  expect(lengths(stored[2]?.payload)).toEqual([0.189, 0.189, 0.189, 0.189]);
  const withoutLengths = (payload: unknown) => JSON.parse(JSON.stringify(payload, (key, value: unknown) => (key === "lengthM" ? undefined : value))) as unknown;
  expect(withoutLengths(stored[2]?.payload)).toEqual(withoutLengths(stored[1]?.payload));
}

test("a clashing profile saves with its clashes listed, and the confirmed fix saves a version that clears them", async ({ page }) => {
  test.setTimeout(120000);
  await seedQuadProject(page, PROFILE);
  await shortenArms(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Cancel leaves the profile as it is.
  await panel(page).getByRole("button", { name: "Propose a fix", exact: true }).click();
  await panel(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel(page).getByRole("group", { name: "Proposed fix" })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await applyFix(page);
});

const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";

test("the Run tab refuses the clashing version naming the clashes, and the fixed version flies with native ArduCopter", async ({ page }) => {
  test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
  test.setTimeout(600000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-clearance-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    await seedQuadProject(page, PROFILE);
    await shortenArms(page);

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await expect(run.getByLabel("Aircraft profile")).toContainText(`${PROFILE} (version 2)`);
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    const stage = run.getByTestId("sitl-stage"), failure = run.getByTestId("sitl-failure");
    await expect(stage).toHaveAttribute("data-state", "failed", { timeout: 30000 });
    await expect(failure).toHaveAttribute("data-reason", "vehicle");
    await expect(failure).toContainText("The aircraft profile cannot run: the propellers clash.");
    for (const clash of CLASHES) await expect(failure).toContainText(clash);
    await expect(failure).toContainText("The Aircraft tab proposes a fix");

    await applyFix(page);
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await expect(run.getByLabel("Aircraft profile")).toContainText(`${PROFILE} (version 3)`);
    await run.getByRole("button", { name: "Start again" }).click();
    const ready = run.getByTestId("sitl-ready"), altitude = run.getByTestId("sitl-altitude");
    await expect(ready).toHaveText("READY", { timeout: 180000 });
    await run.getByLabel("Take-off altitude, m").fill("5");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Armed", { timeout: 60000 });
    await expect(stage).toHaveText("Flying", { timeout: 120000 });
    // Hold: at least 10 s of simulated time, every reading within 0.5 m of 5 m, after one settling second.
    const meters = async () => Number((await altitude.textContent())?.replace(" m", ""));
    const simTime = async () => Number.parseFloat((await run.getByTestId("sitl-sim-time").textContent()) ?? "NaN");
    const settled = await simTime();
    while ((await simTime()) - settled < 1) await page.waitForTimeout(100);
    const holdStart = await simTime(), readings: number[] = [];
    while ((await simTime()) - holdStart < 10) {
      readings.push(await meters());
      await page.waitForTimeout(250);
    }
    expect(readings.length).toBeGreaterThan(3);
    expect(Math.min(...readings)).toBeGreaterThan(4.5);
    expect(Math.max(...readings)).toBeLessThan(5.5);
    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-mode")).toHaveText("LAND", { timeout: 30000 });
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 120000 });
    await expect(stage).toHaveAttribute("data-state", "ready", { timeout: 60000 });
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 30000 });
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
