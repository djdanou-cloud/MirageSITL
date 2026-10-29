import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";

// TASK-143 (S08), ownership mapping 2 of TASK-147: the Sensors tab. A quad X profile is seeded through the
// application's own store modules; the test then sets sensors through the UI
// alone and compares the stored profile with the configuration written out
// here. Every field shows its owner, locked fields are disabled with their
// reason, Ideal keeps the typed values inert, the Aircraft tab keeps the
// configuration when it saves, and a reset stores the ArduPilot defaults.
type Store = typeof import("../../packages/project/src/store");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
};
const QUAD = readFileSync(new URL("../fixtures/aircraft/quad-x.json", import.meta.url), "utf8");

/** Hand-typed owner text of every field in specified mode. */
const OWNERS: readonly [string, string][] = [
  ["imu.accelNoiseDensityMps2PerSqrtHz", "MirageSITL"], ["imu.gyroNoiseDensityRadSPerSqrtHz", "MirageSITL"], ["imu.accelBiasMps2", "MirageSITL"],
  ["imu.gyroBiasRadS", "MirageSITL"], ["imu.latencyUs", "MirageSITL"], ["imu.positionBodyM", "MirageSITL"], ["imu.orientationRad", "MirageSITL"],
  ["gnss.updateRateHz", "ArduPilot SITL"], ["gnss.horizontalSigmaM", "ArduPilot SITL"], ["gnss.verticalSigmaM", "ArduPilot SITL"],
  ["gnss.velocitySigmaMps", "ArduPilot SITL"], ["gnss.latencyUs", "ArduPilot SITL"],
  ["barometer.noiseRmsPa", "ArduPilot SITL"], ["barometer.biasPa", "ArduPilot SITL"], ["barometer.latencyUs", "ArduPilot SITL"],
  ["magnetometer.noiseRmsGauss", "ArduPilot SITL"], ["magnetometer.biasGauss", "ArduPilot SITL"], ["magnetometer.positionBodyM", "Nobody on native-json"],
  ["magnetometer.orientationRad", "ArduPilot SITL; cannot be set on native-json"],
  ["battery.voltageGainError", "MirageSITL"], ["battery.voltageOffsetV", "MirageSITL"], ["battery.voltageNoiseRmsV", "MirageSITL"],
  ["battery.currentGainError", "MirageSITL"], ["battery.currentOffsetA", "MirageSITL"], ["battery.currentNoiseRmsA", "MirageSITL"],
  ["imu-accel-noise-floor", "ArduPilot SITL (fixed)"], ["imu-gyro-noise-floor", "ArduPilot SITL (fixed)"], ["imu-sample-rates", "ArduPilot SITL (fixed)"],
];
/** The configuration the UI steps below must store. */
const EXPECTED = {
  schemaVersion: 1, mode: "specified",
  imu: { preset: { catalogVersion: 1, id: "imu-icm-42688-p" }, accelNoiseDensityMps2PerSqrtHz: (70 * 9.80665) / 1e6,
    gyroNoiseDensityRadSPerSqrtHz: (2.8 * Math.PI) / 180000, accelBiasMps2: null, gyroBiasRadS: [(0.5 * Math.PI) / 180, 0, 0],
    latencyUs: 2500, positionBodyM: [0.03, 0, -0.02], orientationRad: null },
  gnss: { preset: { catalogVersion: 1, id: "gnss-neo-m9n" }, updateRateHz: 10, horizontalSigmaM: 1.6986436005760381, verticalSigmaM: null,
    velocitySigmaMps: null, latencyUs: null },
  barometer: { preset: { catalogVersion: 1, id: "baro-ms5611" }, noiseRmsPa: 2.7, biasPa: -30, latencyUs: 20000 },
  magnetometer: { preset: null, noiseRmsGauss: 0.003, biasGauss: null, positionBodyM: null, orientationRad: null },
  battery: { preset: null, voltageGainError: null, voltageOffsetV: -0.15, voltageNoiseRmsV: null, currentGainError: null, currentOffsetA: null, currentNoiseRmsA: null },
};

async function seed(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(async ({ urls, quad }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { profileDraft } = await import(urls.profile) as Profiles;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("Sensor project");
      await store.createItem(project.record.id, "aircraft-profile", profileDraft("Quad X", JSON.parse(quad)));
      await saveNavigation(store, { tab: "sensors", projectId: project.record.id });
    } finally {
      store.close();
    }
  }, { urls, quad: QUAD });
  await page.reload();
}
interface StoredProfile { version: number; payload: { schemaVersion: number; sensorConfiguration: unknown; groundClearanceM: number | null } }
async function versions(page: Page): Promise<StoredProfile[]> {
  return page.evaluate(async ({ urls }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = (await store.listProjects())[0];
      const head = project ? (await store.listItems(project.record.id, "aircraft-profile"))[0] : undefined;
      if (!head) throw new Error("No profile");
      return (await store.history(head.record.id)).map(v => ({ version: v.record.version, payload: JSON.parse(JSON.stringify(v.record.payload)) as StoredProfile["payload"] }));
    } finally {
      store.close();
    }
  }, { urls });
}
const label = (scope: Locator, text: string) => scope.getByLabel(text, { exact: true });

test("sensors are set through the UI, every field shows its owner, and the configuration survives the Aircraft tab", async ({ page }) => {
  test.setTimeout(60_000);
  await seed(page);
  const tab = page.getByRole("tabpanel", { name: "Sensors", exact: true }), status = tab.getByTestId("sensors-status");
  await tab.getByRole("button", { name: "Open the sensors of Quad X", exact: true }).click();
  const editor = tab.getByTestId("sensor-editor");
  for (const [path, owner] of OWNERS) await expect(tab.getByTestId(`owner-${path}`), path).toHaveText(owner);
  // A locked field is disabled and described by its reason.
  const magnetometerX = label(tab, "Magnetometer position (m) X");
  await expect(magnetometerX).toBeDisabled();
  await expect(magnetometerX).toHaveAccessibleDescription(/uniform Earth field/);
  await expect(label(tab, "Magnetometer orientation (°) roll")).toHaveAccessibleDescription(/SIM_MAGn_ORIENT/);
  await expect(tab.getByRole("region", { name: "What ArduPilot still adds in Ideal mode" })).toBeVisible();
  await expect(tab.getByText(/adds uniform noise of up to ±0\.01 m\/s² to each accelerometer axis/)).toBeVisible();
  // The box lists what Ideal keeps, in every mode: the hard-iron pairing, never the drift Ideal switches off.
  const residuals = tab.getByRole("region", { name: "What ArduPilot still adds in Ideal mode" });
  // TASK-147 confirmed the hard-iron pairing nets to zero, so Ideal no longer lists it.
  await expect(residuals).toContainText("Ideal removes its position wander, velocity error and 100 ms lag");
  await expect(residuals).not.toContainText("SIM_MAGn_OFS");
  await expect(residuals).not.toContainText("SIM_DRIFT_SPEED");

  // Presets and typed values.
  await label(tab, "IMU preset").selectOption({ label: "TDK InvenSense ICM-42688-P" });
  await tab.getByRole("button", { name: "Apply IMU preset", exact: true }).click();
  await expect(label(tab, "Accelerometer noise density (µg/√Hz)")).toHaveValue("70");
  await expect(label(tab, "Gyroscope noise density (mdps/√Hz)")).toHaveValue("2.8");
  await label(tab, "Barometer preset").selectOption({ label: "TE Connectivity MS5611-01BA03" });
  await tab.getByRole("button", { name: "Apply Barometer preset", exact: true }).click();
  await expect(label(tab, "Barometer noise (1σ) (Pa)")).toHaveValue("2.7");
  await label(tab, "GNSS preset").selectOption({ label: "u-blox NEO-M9N" });
  await tab.getByRole("button", { name: "Apply GNSS preset", exact: true }).click();
  await expect(status).toHaveText("Applied NEO-M9N: GNSS horizontal position error (1σ per axis) (m).");
  await expect(label(tab, "GNSS horizontal position error (1σ per axis) (m)")).toHaveValue("1.69864360058");
  await label(tab, "GNSS update rate (Hz)").fill("10");
  await label(tab, "IMU latency (ms)").fill("2.5");
  await label(tab, "Voltage offset (V)").fill("-0.15");
  for (const [axis, value] of [["X", "0.5"], ["Y", "0"], ["Z", "0"]]) await label(tab, `Gyroscope bias (°/s) ${axis}`).fill(value!);
  for (const [axis, value] of [["X", "0.03"], ["Y", "0"], ["Z", "-0.02"]]) await label(tab, `IMU position (m) ${axis}`).fill(value!);
  await label(tab, "Barometer bias (Pa)").fill("-30");
  await label(tab, "Magnetometer noise (1σ per axis) (mG)").fill("3");
  // Invalid edits are blocked with their reasons.
  const problems = tab.getByRole("list", { name: "Problems to fix before saving the sensors" });
  const save = tab.getByRole("button", { name: "Save sensors", exact: true });
  await label(tab, "Barometer latency (ms)").fill("2.5");
  await expect(problems).toHaveText("Barometer latency must be a whole number of milliseconds, because ArduPilot applies it in milliseconds");
  await expect(save).toBeDisabled();
  await label(tab, "Barometer latency (ms)").fill("20");
  await label(tab, "IMU position (m) Y").fill("");
  await expect(problems).toHaveText("IMU position (m) Y is empty; give all 3 components or none");
  await label(tab, "IMU position (m) Y").fill("0");
  await expect(problems).toHaveCount(0);
  await save.click();
  await expect(status).toHaveText("Saved version 2 of Quad X.");
  let stored = await versions(page);
  expect(stored.map(v => v.payload.schemaVersion)).toEqual([1, 3]);
  expect(stored[1]?.payload.sensorConfiguration).toEqual(EXPECTED);
  expect(JSON.parse(await editor.getAttribute("data-resolved") ?? "{}")).toMatchObject({ state: "specified", mappingVersion: 2 });

  // Ideal keeps the values but uses none of them.
  await tab.getByRole("radio", { name: "Ideal sensors" }).check();
  await expect(tab.getByTestId("owner-imu.gyroBiasRadS")).toHaveText("MirageSITL, off in Ideal");
  await expect(tab.getByTestId("owner-barometer.noiseRmsPa")).toHaveText("ArduPilot SITL, switched off in Ideal");
  await expect(tab.getByTestId("owner-magnetometer.biasGauss")).toHaveText("ArduPilot SITL, paired to zero in Ideal");
  await expect(tab.getByTestId("owner-gnss.updateRateHz")).toHaveText("ArduPilot SITL, kept in Ideal");
  await expect(tab.getByTestId("owner-battery.voltageOffsetV")).toHaveText("MirageSITL, off in Ideal");
  await expect(label(tab, "Barometer bias (Pa)")).toBeDisabled();
  await save.click();
  await expect(status).toHaveText("Saved version 3 of Quad X.");
  stored = await versions(page);
  expect(stored[2]?.payload.sensorConfiguration).toEqual({ ...EXPECTED, mode: "ideal" });

  // The Aircraft tab saves a geometry change and keeps the sensors.
  await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
  const aircraft = page.getByRole("tabpanel", { name: "Aircraft", exact: true });
  await aircraft.getByRole("button", { name: "Open Quad X", exact: true }).click();
  await label(aircraft, "Ground clearance (m, optional)").fill("0.2");
  await aircraft.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(aircraft.getByTestId("aircraft-status")).toHaveText("Saved version 4 of Quad X.");
  stored = await versions(page);
  expect(stored[3]?.payload).toMatchObject({ schemaVersion: 3, groundClearanceM: 0.2, sensorConfiguration: { ...EXPECTED, mode: "ideal" } });

  // Back in the Sensors tab the editor follows version 4; a reset stores the ArduPilot defaults as null.
  await page.getByRole("tab", { name: "Sensors", exact: true }).click();
  await expect(tab.getByRole("heading", { name: "Sensors of Quad X, version 4" })).toBeVisible();
  await tab.getByRole("button", { name: "Reset to ArduPilot defaults", exact: true }).click();
  await expect(tab.getByTestId("sensor-state")).toHaveText("ArduPilot defaults: MirageSITL injects nothing.");
  await save.click();
  await expect(status).toHaveText("Saved version 5 of Quad X.");
  stored = await versions(page);
  expect(stored[4]?.payload).toMatchObject({ schemaVersion: 2, groundClearanceM: 0.2, sensorConfiguration: null });
  await expect(tab.getByRole("list", { name: "Aircraft profiles for sensors" })).toContainText("Quad X, version 5: ArduPilot defaults");

  // The tab fits a phone and passes axe.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});
