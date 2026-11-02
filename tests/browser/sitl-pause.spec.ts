import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject, type SeedOptions } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-156 (S02): one pause path for the integrated session, through the Run
// tab alone with native ArduCopter. A user pause in a 5 m hover lasts more
// than 10 min of wall time and resumes within the TASK-129 continuity
// tolerance: the retained state is the paused tick's, simulated time does not
// move while paused, and after Resume the hover holds within 0.5 m of 5 m for
// 10 s of simulated time, armed in GUIDED, with no failsafe or EKF message. A
// nose-heavy quad (CG 0.152 m forward, 7 mm inside its front supports) tips
// onto its nose as it settles on them at the start, before the autopilot's
// first heartbeat: an accident pause (TASK-149), continued with its label. A
// hidden tab then pauses the run, which waits for Resume.
// The pauses are logged and recorded as events.pause rows (TASK-163).

type Host = typeof import("../../packages/aar/src/recorder-v2-host");
type Store = typeof import("../../packages/project/src/store");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
const urls = {
  host: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";
/** At least 10 min, the DoD's pause, with a margin. */
const PAUSE_MS = 605_000;
/** ArduCopter's failsafe, EKF fault and crash messages; its normal EKF start-up lines ("EKF3 IMU0 origin set") are not among them. */
const FAILSAFE = /failsafe|variance|lane switch|crash|bad ahrs|glitch|EKF\S* (?:fault|reset)/i;

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

interface Run { readonly page: Page; readonly run: Locator; readonly projectId: string; readonly close: () => Promise<void> }
async function startRun(page: Page, name: string, options: SeedOptions = {}, ready = true): Promise<Run> {
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-pause-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  const seeded = await seedQuadProject(page, name, options);
  await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
  const run = page.getByRole("region", { name: "ArduPilot SITL" });
  await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
  await run.getByLabel("Launcher token", { exact: true }).fill(token);
  await run.getByRole("button", { name: "List ArduPilot builds" }).click();
  await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
  await run.getByLabel("Speed").selectOption("4");
  await run.getByRole("button", { name: "Start SITL run" }).click();
  if (ready) await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 180000 });
  return { page, run, projectId: seeded.projectId, close: async () => { await launcher.close(); rmSync(home, { recursive: true, force: true }); } };
}
const simTime = async (run: Locator) => Number.parseFloat((await run.getByTestId("sitl-sim-time").textContent()) ?? "NaN");
const altitude = async (run: Locator) => Number((await run.getByTestId("sitl-altitude").textContent())?.replace(" m", ""));
const stepped = async (run: Locator) => Number.parseInt((await run.getByTestId("sitl-frames").textContent()) ?? "NaN", 10);

/** The pause rows of the run's recording, [tick, paused]. */
async function pauseRows(page: Page, projectId: string): Promise<[number, number][]> {
  return page.evaluate(async ({ urls, projectId }) => {
    const { reopenRecording } = await import(urls.host) as Host;
    const { ProjectStore } = await import(urls.store) as Store;
    const { readExperiment } = await import(urls.experiment) as Experiments;
    const store = await ProjectStore.openIndexedDb();
    try {
      const [stored] = await store.listItems(projectId, "experiment");
      if (!stored) throw new Error("No experiment record");
      const opened = await reopenRecording(readExperiment(stored).recording?.recordId ?? "");
      return (opened.rows.get("events.pause") ?? []).map((row): [number, number] => [row.tick, row.values?.[0] ?? -1]);
    } finally {
      store.close();
    }
  }, { urls, projectId });
}

test("a user pause of more than 10 min in a 5 m hover resumes the same flight with no failsafe", async ({ page }) => {
  test.setTimeout(1_500_000);
  const r = await startRun(page, "Quad X paused");
  const { run } = r;
  try {
    await run.getByLabel("Take-off altitude, m").fill("5");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveText("Flying", { timeout: 120000 });
    const start = await simTime(run);
    while ((await simTime(run)) - start < 2) await page.waitForTimeout(100);

    await run.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "paused");
    await expect(run.getByTestId("sitl-stage")).toContainText("by you");
    await page.waitForTimeout(1000);
    const pausedAt = await simTime(run), heldAt = await altitude(run), steps = await stepped(run);
    // Pause for more than 10 min of wall time; simulated time, the state and the stepped frames stand still.
    const until = Date.now() + PAUSE_MS;
    while (Date.now() < until) await page.waitForTimeout(Math.min(30_000, until - Date.now()));
    expect(await simTime(run)).toBe(pausedAt);
    expect(await altitude(run)).toBe(heldAt);
    expect(await stepped(run)).toBe(steps);
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "paused");

    await run.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveText("Flying", { timeout: 30000 });
    // Continuity: within 0.5 m of 5 m for 10 s of simulated time, armed, in GUIDED, and no failsafe or EKF message.
    const resumedAt = await simTime(run), readings: number[] = [];
    while ((await simTime(run)) - resumedAt < 10) { readings.push(await altitude(run)); await page.waitForTimeout(250); }
    expect(readings.length).toBeGreaterThan(3);
    expect(Math.min(...readings)).toBeGreaterThan(4.5);
    expect(Math.max(...readings)).toBeLessThan(5.5);
    console.log(`EVID hover ${pausedAt} ${heldAt} ${resumedAt} ${Math.min(...readings)} ${Math.max(...readings)} ${readings.length} ${steps}`);
    await expect(run.getByTestId("sitl-armed")).toHaveText("Armed");
    await expect(run.getByTestId("sitl-mode")).toHaveText("GUIDED");
    const messages = await run.getByRole("list", { name: "Autopilot messages" }).textContent().catch(() => "");
    expect(messages ?? "").not.toMatch(FAILSAFE);
    // The pause is logged with its wall time, which the simulated duration does not count.
    const log = run.getByTestId("sitl-pauses").getByRole("listitem");
    await expect(log).toHaveCount(1);
    await expect(log.first()).toHaveAttribute("data-reason", "user");
    const wall = Number(/resumed after ([0-9.]+) s/.exec((await log.first().textContent()) ?? "")?.[1]);
    console.log(`EVID wall ${wall}`);
    expect(wall).toBeGreaterThan(600);
    expect(resumedAt - pausedAt).toBeLessThan(1);

    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 120000 });
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30000 });
    // The recording holds the pause and the resume.
    await expect.poll(async () => (await pauseRows(page, r.projectId)).map(([, paused]) => paused), { timeout: 30000 }).toEqual([1, 0]);
  } finally {
    await r.close();
  }
});

test("a nose-heavy quad that tips over at the start pauses on the accident and continues labelled, and a hidden tab pauses the run until Resume", async ({ page }) => {
  test.setTimeout(900_000);
  const r = await startRun(page, "Quad X nose-heavy", { cgOffsetBodyM: [0.152, 0, 0.02] }, false);
  const { run } = r;
  try {
    const stage = run.getByTestId("sitl-stage");
    await expect(stage).toHaveAttribute("data-state", "paused", { timeout: 120000 });
    await expect(stage).toContainText("accident");
    await expect(run.getByTestId("sitl-accidents")).toContainText(/(The propeller of motor \d|The body|Arm \d) struck the ground/);
    await expect(run.getByTestId("sitl-pause-hint")).toContainText("not validated for a physically damaged aircraft");
    await page.waitForTimeout(1000);
    const pausedAt = await simTime(run);
    await page.waitForTimeout(3000);
    expect(await simTime(run)).toBe(pausedAt);
    console.log(`EVID accident ${pausedAt} ${(await run.getByTestId("sitl-accidents").textContent()) ?? ""}`);
    // Each new contact of the rocking wreck is a new accident, which pauses the run again until it lies still.
    let continued = 0;
    for (let i = 0; i < 20; i++) {
      const state = await stage.getAttribute("data-state");
      if (state !== "paused" && state !== "starting") break;
      if (state === "paused") { await run.getByRole("button", { name: "Continue after the accident" }).click(); continued++; }
      await page.waitForTimeout(3000);
    }
    expect(continued).toBeGreaterThan(0);
    await expect(run.getByTestId("sitl-after-accident")).toBeVisible({ timeout: 30000 });
    // The start goes on: the autopilot's first heartbeat comes, and its parameters load.
    await expect(stage).toHaveAttribute("data-state", /loading-parameters|warming|ready/, { timeout: 120000 });

    // A hidden tab pauses the run; it waits for Resume when the tab is back.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(stage).toHaveAttribute("data-state", "paused", { timeout: 30000 });
    await expect(stage).toContainText("the tab was hidden");
    await expect(run.getByTestId("sitl-pause-hint")).toContainText("a run never goes on there unwatched");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // A hidden page draws nothing, so the shown time catches up with the paused tick once it is visible again.
    await page.waitForTimeout(1000);
    const hiddenAt = await simTime(run);
    await page.waitForTimeout(3000);
    await expect(stage).toHaveAttribute("data-state", "paused");
    expect(await simTime(run)).toBe(hiddenAt);
    await run.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(stage).not.toHaveAttribute("data-state", "paused", { timeout: 30000 });
    await expect(run.getByTestId("sitl-after-accident")).toBeVisible();
    const reasons = await run.getByTestId("sitl-pauses").getByRole("listitem").evaluateAll(items => items.map(item => item.getAttribute("data-reason")));
    expect(reasons).toEqual([...Array.from({ length: continued }, () => "accident"), "visibility"]);
    console.log(`EVID pauses ${reasons.join(",")}`);
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 30000 });
    // The recording holds both pauses and their resumes.
    await expect.poll(async () => (await pauseRows(page, r.projectId)).map(([, paused]) => paused), { timeout: 30000 })
      .toEqual(Array.from({ length: 2 * (continued + 1) }, (_, i) => (i % 2 === 0 ? 1 : 0)));
  } finally {
    await r.close();
  }
});
