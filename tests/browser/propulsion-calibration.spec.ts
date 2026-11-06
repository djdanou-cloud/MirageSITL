import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";

// TASK-145 (S04, S05): the Components tab fits a measured motor's rotor and motor to the bench data bound for its exact combination, shows
// every residual and the envelope, and on request stores the calibration and binds it as a new profile version. Seeded through the
// application's own store modules: the example cards, the quad X with NACA6409 on its propellers, the synthetic bench file of combination A
// (motor, propeller A, ESC, battery) and a profile version in Calculation from measurements. Declared:
//  - the fit runs in the page on the served scalar BET module, and its table has a row per bench point (7);
//  - Save and bind stores one `propulsion-calibration` record depending on the set and both cards, and profile version 2 at schema 6;
//  - both motors of combination A show it after a reload, and motors 3 and 4 (propeller B, never measured) have no calibration at all;
//  - the tab still fits a phone and passes axe with the residual table open.
type Store = typeof import("../../packages/project/src/store");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Measurements = typeof import("../../packages/aircraft/src/measurements");
type Calculation = typeof import("../../packages/aircraft/src/calculation-mode");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  measurements: viteFileUrl(new URL("../../packages/aircraft/src/measurements.ts", import.meta.url)),
  calculation: viteFileUrl(new URL("../../packages/aircraft/src/calculation-mode.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
};
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The bench project in measured mode, opened on the Components tab; returns the project's ID. */
async function seed(page: Page): Promise<string> {
  await page.goto("/");
  const texts = {
    motor: read("../fixtures/components/motor-example.json"), propeller: read("../fixtures/components/propeller-example.json"),
    esc: read("../fixtures/components/esc-example.json"), battery: read("../fixtures/components/battery-example.json"),
    profile: read("../fixtures/aircraft/quad-x.json"), bench: read("../fixtures/components/bench-combination.csv"),
  };
  const projectId = await page.evaluate(async ({ urls, texts }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { profileDraft, validateAircraftProfile, withPropellerPolars } = await import(urls.profile) as Profiles;
    const { measurementSetDraft, measurementSetFromBenchCsv } = await import(urls.measurements) as Measurements;
    const { bindMeasurements } = await import(urls.calculation) as Calculation;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("Calibration project");
      const add = async (name: string, payload: unknown) => (await store.createItem(project.record.id, "component-card", { name, payload })).sha256;
      const motor = await add("Example motor", JSON.parse(texts.motor));
      const propA = await add("Propeller A 10x4.5", JSON.parse(texts.propeller));
      const propellerB = JSON.parse(texts.propeller) as { model: string; values: { diameterM: number } };
      propellerB.model = "Example 9x4.5 propeller";
      propellerB.values.diameterM = 0.2286;
      const propB = await add("Propeller B 9x4.5", propellerB);
      const esc = await add("Example ESC", JSON.parse(texts.esc));
      const battery = await add("Example battery", JSON.parse(texts.battery));
      const set = await measurementSetFromBenchCsv(texts.bench, {
        combination: { motor, propeller: propA, esc, supply: { kind: "battery", card: battery } },
        fileName: "bench-combination.csv", date: "2026-10-29", description: "Synthetic thrust stand run", applicability: null,
      });
      const stored = await store.createItem(project.record.id, "measurement-set", measurementSetDraft("Bench A", set));
      const fixture = validateAircraftProfile(JSON.parse(texts.profile));
      const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: battery },
        motors: fixture.motors.map(item => ({ ...item, components: { motor, propeller: item.id <= 2 ? propA : propB, esc } })) }),
      [{ card: propA, polar: "naca6409-neuralfoil-v1" }, { card: propB, polar: "naca6409-neuralfoil-v1" }]);
      const measured = await bindMeasurements(profile, "measured", [{ sha256: stored.sha256, createdAt: stored.record.createdAt, set }]);
      await store.createItem(project.record.id, "aircraft-profile", profileDraft("Quad X", measured));
      await saveNavigation(store, { tab: "components", projectId: project.record.id });
      return project.record.id;
    } finally {
      store.close();
    }
  }, { urls, texts });
  await page.reload();
  return projectId;
}

test("a measured motor is fitted to its own bench data, and the calibration binds as a new version for that combination only", async ({ page }) => {
  test.setTimeout(300_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  const projectId = await seed(page);
  const panel = page.getByRole("tabpanel", { name: "Components", exact: true });
  const motors = panel.getByRole("list", { name: "Motors of Quad X" });
  const one = motors.getByTestId("calibration-1");
  await expect(one).toContainText("Not calibrated: the BET rotor flies on its catalog polar.");
  await expect(motors.getByTestId("calibration-2")).toBeVisible();
  // Propeller B was never measured: motors 3 and 4 have nothing to calibrate.
  await expect(motors.getByTestId("calibration-3")).toHaveCount(0);
  await expect(motors.getByTestId("calibration-4")).toHaveCount(0);

  await one.getByRole("button", { name: "Fit to the bench data" }).click();
  const result = one.getByTestId("calibration-result-1");
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(result).toContainText(/Lift ×\d+\.\d{4}, drag ×\d+\.\d{4} in \d+ iterations; RMS thrust residual \d+\.\d{4} N, torque \d+\.\d{5} N·m\./);
  await expect(result).toContainText("Motor at KV 700: R ");
  await expect(result.getByRole("region", { name: "Residuals of motor 1" }).locator("tbody tr")).toHaveCount(7);
  await expect(result).toContainText("Envelope: 2000 to 8000 rpm at ");
  expect((await result.textContent()) ?? "").not.toMatch(/\b(pass|fail|verdict|tolerance)\b/i);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 });

  await result.getByRole("button", { name: "Save and bind as a new profile version" }).click();
  await expect(panel.getByTestId("calculation-status")).toHaveText("Saved the calibration and version 2 of Quad X, which flies every motor of this combination calibrated.");
  const stored = await page.evaluate(async ({ urls, projectId }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const store = await ProjectStore.openIndexedDb();
    try {
      const [calibration] = await store.listItems(projectId, "propulsion-calibration");
      const [profile] = await store.listItems(projectId, "aircraft-profile");
      const [set] = await store.listItems(projectId, "measurement-set");
      return {
        calibration: calibration ? { sha256: calibration.sha256, dependencies: calibration.record.dependencies.map(d => d.kind).sort() } : null,
        profile: profile ? { version: profile.record.version, payload: JSON.parse(JSON.stringify(profile.record.payload)) as { schemaVersion: number; propulsionCalibrations?: { record: string; measurementSet: string }[] } } : null,
        set: set?.sha256 ?? null,
      };
    } finally { store.close(); }
  }, { urls, projectId });
  expect(stored.calibration?.dependencies).toEqual(["component-card", "component-card", "measurement-set"]);
  expect(stored.profile?.version).toBe(2);
  expect(stored.profile?.payload.schemaVersion).toBe(6);
  expect(stored.profile?.payload.propulsionCalibrations).toEqual([expect.objectContaining({ record: stored.calibration?.sha256, measurementSet: stored.set })]);

  await page.reload();
  for (const id of [1, 2]) await expect(motors.getByTestId(`calibration-${id}`)).toContainText(/Calibrated \(lift ×\d+\.\d{4}, drag ×\d+\.\d{4}\) from the set measured on 2026-10-29/);
  await expect(motors.getByTestId("calibration-3")).toHaveCount(0);
});
