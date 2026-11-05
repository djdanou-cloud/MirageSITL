import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-177 (S12): two configurations of one aircraft flown from the Run tab by native ArduCopter
// 8ab6afde, the same hover on each, and compared on the Experiments tab. The second motor is 20 g heavier
// and is rated at 10 W, so a real limit event has to reach its recording. Numbers on the page are read
// back against values this test computes from the recording's rows and from the cards by its own arithmetic.
// The quad flies with the 40 Hz gyro filter of decision A-13, written through the Parameters tab.

type Store = typeof import("../../packages/project/src/store");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Host = typeof import("../../packages/aar/src/recorder-v2-host");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  host: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";
const GRAMS_HEAVIER = 0.02, EXAMPLE_MOTOR_KG = 0.105;

/** A second profile on a heavier motor rated at 10 W, its stated mass up by what the four motors add. */
async function seedHeavierMotorProfile(page: Page, projectId: string, baseSha256: string): Promise<void> {
  await page.evaluate(async ({ urls, projectId, baseSha256, grams }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { profileDraft, readAircraftProfile, validateAircraftProfile } = await import(urls.profile) as Profiles;
    const store = await ProjectStore.openIndexedDb();
    try {
      const base = readAircraftProfile(await store.get(baseSha256));
      const motorSha = base.motors[0]?.components.motor;
      if (!motorSha) throw new Error("The base profile has no motor");
      const card: unknown = (await store.get(motorSha)).record.payload;
      const values: unknown = Reflect.get(card as object, "values");
      const heavier = await store.createItem(projectId, "component-card", { name: "Heavier motor", payload: { ...(card as object), values: { ...(values as object), massKg: Number(Reflect.get(values as object, "massKg")) + grams, maxPowerW: 10 } } });
      const profile = validateAircraftProfile({ ...base, massProperties: { ...base.massProperties, massKg: base.massProperties.massKg + 4 * grams },
        motors: base.motors.map(motor => ({ ...motor, components: { ...motor.components, motor: heavier.sha256 } })) });
      await store.createItem(projectId, "aircraft-profile", profileDraft("Heavier motors", profile));
    } finally { store.close(); }
  }, { urls, projectId, baseSha256, grams: GRAMS_HEAVIER });
}
async function flyHover(page: Page, profileLabel: string, port: number, token: string): Promise<string> {
  const runTab = page.getByRole("tab", { name: "Run", exact: true });
  await runTab.click();
  await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
  const run = page.getByRole("region", { name: "ArduPilot SITL" });
  await run.getByLabel("Aircraft profile", { exact: true }).selectOption({ label: profileLabel });
  await run.getByLabel("Flight task", { exact: true }).selectOption({ label: "Hover 5 m (version 1)" });
  await run.getByLabel("Launcher port", { exact: true }).fill(String(port));
  await run.getByLabel("Launcher token", { exact: true }).fill(token);
  await run.getByRole("button", { name: "List ArduPilot builds" }).click();
  await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
  await run.getByLabel("Speed").selectOption("4");
  await run.getByRole("button", { name: "Start SITL run" }).click();
  await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
  const record = (await run.getByTestId("sitl-record").textContent()) ?? "";
  await page.getByRole("tab", { name: "Parameters", exact: true }).click();
  const parameters = page.getByRole("tabpanel", { name: "Parameters", exact: true });
  await expect(parameters.getByTestId("parameters-status")).toHaveAttribute("data-download", "complete", { timeout: 120_000 });
  await parameters.getByLabel("Search parameters").fill("INS_GYRO_FILTER");
  await parameters.getByTestId("parameter-table").getByRole("button", { name: "INS_GYRO_FILTER", exact: true }).click();
  await parameters.getByLabel("New value of INS_GYRO_FILTER").fill("40");
  await parameters.getByRole("button", { name: "Write", exact: true }).click();
  await expect(parameters.getByTestId("parameter-history").locator('tr[data-name="INS_GYRO_FILTER"]').last()).toHaveAttribute("data-outcome", "confirmed", { timeout: 60_000 });
  await runTab.click();
  await run.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(run.getByTestId("task-state")).toHaveAttribute("data-state", "done", { timeout: 600_000 });
  await run.getByRole("button", { name: "Stop run", exact: true }).click();
  await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
  return record;
}
interface Hand { startS: number; endS: number; meanCurrentA: number; energyWh: number; chargeAh: number; meanRpm: number; startAh: number; capacityAh: number; limitRows: number; monitorRows: number }
/** The measured part of a run, worked out here from its rows by trapezoids, without the analysis package. */
async function byHand(page: Page, record: string): Promise<Hand> {
  return page.evaluate(async ({ urls, record }) => {
    const { reopenRecording } = await import(urls.host) as Host;
    const { ProjectStore } = await import(urls.store) as Store;
    const { readExperiment } = await import(urls.experiment) as Experiments;
    const store = await ProjectStore.openIndexedDb();
    try {
      const opened = await reopenRecording(readExperiment(await store.get(record)).recording?.recordId ?? "");
      const rows = (name: string) => opened.rows.get(name) ?? [];
      const measured = rows("events.flightTask").filter(row => row.values?.[1] === 1), startS = measured[0]?.simTimeS ?? 0, endS = measured.at(-1)?.simTimeS ?? 0;
      const within = (name: string) => rows(name).filter(row => row.simTimeS >= startS && row.simTimeS <= endS);
      const integrate = (list: readonly { simTimeS: number; values: readonly number[] | null }[], of: (values: readonly number[]) => number) => {
        let area = 0;
        for (let i = 1; i < list.length; i++) area += (of(list[i]?.values ?? []) + of(list[i - 1]?.values ?? [])) / 2 * ((list[i]?.simTimeS ?? 0) - (list[i - 1]?.simTimeS ?? 0));
        return area / ((list.at(-1)?.simTimeS ?? 0) - (list[0]?.simTimeS ?? 0));
      };
      const battery = within("battery"), speed = within("motors.speed"), first = rows("battery")[0]?.values ?? [];
      const span = (battery.at(-1)?.simTimeS ?? 0) - (battery[0]?.simTimeS ?? 0);
      return { startS, endS, meanCurrentA: integrate(battery, v => v[2] ?? 0), energyWh: integrate(battery, v => v[3] ?? 0) * span / 3600,
        chargeAh: (battery[0]?.values?.[4] ?? 0) - (battery.at(-1)?.values?.[4] ?? 0), meanRpm: integrate(speed, v => ((v[0] ?? 0) + (v[1] ?? 0) + (v[2] ?? 0) + (v[3] ?? 0)) / 4),
        startAh: first[4] ?? 0, capacityAh: (first[4] ?? 0) / (first[0] ?? 1), limitRows: rows("events.limit").filter(row => row.values?.[0] === 1).length, monitorRows: rows("events.limit").filter(row => row.values?.[0] === 0).length };
    } finally { store.close(); }
  }, { urls, record });
}
const cell = (table: Locator, metric: string, side: "a" | "b" | "difference") => table.locator(`tr[data-metric="${metric}"] td[data-side="${side}"]`);
const near = async (table: Locator, metric: string, side: "a" | "b", expected: number, tolerance: number) => {
  const text = (await cell(table, metric, side).textContent()) ?? "";
  expect(Math.abs(Number(text) - expected), `${metric} ${side}: ${text} against ${expected}`).toBeLessThanOrEqual(tolerance);
};

test("two configurations flown from the Run tab compare with their inputs, mass, limits and results", async ({ page }) => {
  test.setTimeout(900_000);
  test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-compare-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  const evidence: Record<string, unknown> = {};
  try {
    const { projectId, profileSha256 } = await seedQuadProject(page, "Example motors");
    await seedHeavierMotorProfile(page, projectId, profileSha256);
    await page.reload();
    await page.getByRole("tab", { name: "Flight tasks", exact: true }).click();
    const tasks = page.getByRole("tabpanel", { name: "Flight tasks", exact: true });
    await tasks.getByLabel("Task name", { exact: true }).fill("Hover 5 m");
    await tasks.getByLabel("Task type", { exact: true }).selectOption("hover");
    await tasks.getByRole("button", { name: "Save flight task", exact: true }).click();
    await expect(tasks.getByTestId("task-status")).toHaveText("Saved Hover 5 m, version 1.");

    const recordA = await flyHover(page, "Example motors (version 1)", launcher.port, token);
    const recordB = await flyHover(page, "Heavier motors (version 1)", launcher.port, token);
    const handA = await byHand(page, recordA), handB = await byHand(page, recordB);
    evidence.handA = handA; evidence.handB = handB;
    expect(handA.monitorRows).toBe(1);
    expect(handB.monitorRows).toBe(1);
    // Rated at 10 W, the heavier motors exceed it as soon as they lift.
    expect(handB.limitRows).toBeGreaterThan(0);

    await page.getByRole("tab", { name: "Experiments", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Experiments", exact: true }).getByTestId("compare-panel");
    await panel.getByLabel("Experiment A", { exact: true }).selectOption({ value: recordA });
    await panel.getByLabel("Experiment B", { exact: true }).selectOption({ value: recordB });
    const result = panel.getByTestId("compare-result");
    await expect(result).toBeVisible({ timeout: 120_000 });

    // What differs is what was changed, so nothing is flagged.
    const controls = result.getByTestId("compare-controls");
    await expect(result).toHaveAttribute("data-flags", "0");
    await expect(result.getByTestId("compare-flagged")).toHaveCount(0);
    for (const control of ["motors", "aircraft-mass"]) await expect(controls.locator(`tr[data-control="${control}"]`)).toHaveAttribute("data-differs", "true");
    for (const control of ["flight-task", "propellers", "escs", "battery", "payload", "charge", "start", "home", "weather", "ardupilot", "physics-rate"]) await expect(controls.locator(`tr[data-control="${control}"]`), control).toHaveAttribute("data-differs", "false");
    await expect(controls.locator('tr[data-control="motors"]')).toContainText("Example motor × 4");
    await expect(controls.locator('tr[data-control="motors"]')).toContainText("Heavier motor × 4");
    await expect(result.getByTestId("compare-lists")).toContainText("Differ: Motors, Aircraft mass, CG and inertia");

    // Four motors, 20 g heavier each: 0.42 kg against 0.50 kg, which the stated mass accounts for.
    const mass = result.getByTestId("compare-mass");
    await expect(mass.locator('tr[data-part="motors"]')).toContainText(`${(4 * EXAMPLE_MOTOR_KG).toFixed(3)} kg`);
    await expect(mass.locator('tr[data-part="motors"]')).toContainText(`${(4 * (EXAMPLE_MOTOR_KG + GRAMS_HEAVIER)).toFixed(3)} kg`);
    await expect(mass.locator('tr[data-part="motors"]')).toContainText("+0.080 kg");
    await expect(mass.locator('tr[data-part="aircraft"]')).toContainText("+0.080 kg");
    await expect(result.getByTestId("compare-mass-flagged")).toHaveCount(0);

    // Calculation mode and confidence are in view.
    for (const side of ["a", "b"]) {
      await expect(result.getByTestId(`compare-mode-${side}`)).toHaveText("Preliminary");
      await expect(result.getByTestId(`compare-label-${side}`)).toHaveText("preliminary");
    }

    // Results against this test's own arithmetic on the rows.
    const metrics = result.getByTestId("compare-metrics");
    await expect(result.getByTestId("compare-window")).toContainText("measured part");
    for (const [side, hand] of [["a", handA], ["b", handB]] as const) {
      await near(metrics, "current-mean", side, hand.meanCurrentA, 0.01);
      await near(metrics, "energy", side, hand.energyWh, 0.001);
      await near(metrics, "charge", side, hand.chargeAh, 0.0001);
      await near(metrics, "rpm-mean", side, hand.meanRpm, 1);
      await near(metrics, "window", side, hand.endS - hand.startS, 0.1);
      // A hover at 5 m, so it rose about that far.
      await near(metrics, "highest", side, 5, 1);
      // 20 % of the pack is the reserve; the rest at the mean current.
      await near(metrics, "duration", side, (hand.startAh - 0.2 * hand.capacityAh) / hand.meanCurrentA * 60, 0.1);
    }
    // The heavier aircraft asks for more of the same rotors, and the thrust at full command is the same.
    expect(Number(await cell(metrics, "current-mean", "b").textContent())).toBeGreaterThan(Number(await cell(metrics, "current-mean", "a").textContent()));
    const thrustA = Number(await cell(metrics, "thrust", "a").textContent()), thrustB = Number(await cell(metrics, "thrust", "b").textContent()), ratioA = Number(await cell(metrics, "thrust-to-weight", "a").textContent()), ratioB = Number(await cell(metrics, "thrust-to-weight", "b").textContent());
    expect(thrustA).toBeGreaterThan(14.71);
    expect(Math.abs(thrustB - thrustA)).toBeLessThanOrEqual(0.01);
    expect(ratioB).toBeLessThan(ratioA);
    await expect(result.getByTestId("compare-duration-scenario")).toContainText("the measured part of Hover 5 m");
    await expect(result.getByTestId("compare-duration-scenario")).toContainText("20 % reserve");
    await expect(result.getByTestId("compare-pack-limited-a")).toHaveCount(0);

    // A different reserve is a different estimate, and it says so.
    await panel.getByLabel("Reserve for the duration estimate (% of capacity)", { exact: true }).fill("40");
    await near(metrics, "duration", "a", (handA.startAh - 0.4 * handA.capacityAh) / handA.meanCurrentA * 60, 0.1);
    await expect(result.getByTestId("compare-duration-scenario")).toContainText("40 % reserve");
    await panel.getByLabel("Reserve for the duration estimate (% of capacity)", { exact: true }).fill("20");

    // Limits: no rating exceeded on the example motor, whose brief clamp at the drive's 30 A as it starts is the model's and is shown as such;
    // and the 10 W rating on the heavier one, as a rating and not a clamp.
    await expect(result.getByTestId("compare-limits-a")).not.toContainText("over its rating");
    await expect(result.getByTestId("compare-limits-a")).not.toContainText("not known");
    const limits = result.getByTestId("compare-limits-b");
    await expect(limits).toContainText("Motor power over its rating");
    await expect(limits).toContainText("Rating exceeded; physics unchanged");
    await expect(limits).toContainText("10.0");
    mkdirSync(join(ROOT, "test-results/browser"), { recursive: true });
    await panel.screenshot({ path: join(ROOT, "test-results/browser/task-177-compare.png") });

    // Asked as one aircraft under different conditions, the same two are not controlled: a different motor is flagged.
    await panel.getByLabel("What is being compared", { exact: true }).selectOption("conditions");
    const flagged = result.getByTestId("compare-flagged");
    await expect(flagged).toContainText("Motors");
    await expect(flagged).toContainText("Aircraft mass");
    await expect(result).toHaveAttribute("data-flags", "2");
    await expect(controls.locator('tr[data-control="motors"]')).toHaveAttribute("data-flagged", "true");
    await expect(controls.locator('tr[data-control="motors"]')).toContainText("Differs: flagged");
    // A user who means it can stop holding them, and the flag goes.
    await controls.getByRole("checkbox", { name: "Hold Motors equal", exact: true }).uncheck();
    await controls.getByRole("checkbox", { name: "Hold Aircraft mass, CG and inertia equal", exact: true }).uncheck();
    await expect(result.getByTestId("compare-flagged")).toHaveCount(0);
    await panel.getByLabel("Experiment B", { exact: true }).selectOption({ value: recordA });
    await expect(panel.getByTestId("compare-problem")).toHaveText("Choose two different experiments.");
    evidence.thrust = { thrustA, thrustB, ratioA, ratioB };
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(ROOT, "test-results/validation"), { recursive: true });
    writeFileSync(join(ROOT, "test-results/validation/task-177-browser-flights.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
});
