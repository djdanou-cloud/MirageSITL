import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { decimalYearOf, effectiveConditions, type LocationInput } from "../../packages/sensors/src/environment";
import { WorldMagneticModel, parseWmmCoefficients } from "../../packages/sensors/src/geomagnetic";
import { loadEgm96Geoid } from "../../packages/sensors/src/geoid";
import { viteFileUrl } from "../support/vite-url";

// TASK-148 (S07): the Weather and location tab. A project is seeded through
// the application's own store modules; the test then chooses a location
// through the UI alone and reads the effective conditions the tab shows
// against the same models evaluated here in Node from the repository's data
// files (verified against TR8350.2, NOAA and PROJ-data in the unit tests).
// The saved location survives a reload and is the Run tab's next home.
type Store = typeof import("../../packages/project/src/store");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
};
const CMAC = { latitudeDeg: -35.363261, longitudeDeg: 149.16523, groundElevationMslM: 584 };
const ISRAEL = { latitudeDeg: 31.5, longitudeDeg: 34.9, groundElevationMslM: 250, measuredQnhPa: 102000, temperatureOffsetK: 5 };

async function seed(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(async ({ urls }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("Location project");
      await saveNavigation(store, { tab: "weather", projectId: project.record.id });
    } finally {
      store.close();
    }
  }, { urls });
  await page.reload();
}
const label = (scope: Locator, text: string) => scope.getByLabel(text, { exact: true });
const picker = (page: Page) => page.getByRole("tabpanel", { name: "Weather and location", exact: true }).getByTestId("location-picker");

test("a location is chosen through the UI, its effective conditions come from the verified models, and it is the next run's home after a reload", async ({ page }) => {
  test.setTimeout(60_000);
  const models = {
    geoid: await loadEgm96Geoid(new Uint8Array(readFileSync("data/geoid/WW15MGH.DAC"))),
    magnetic: new WorldMagneticModel(parseWmmCoefficients(readFileSync("data/geomagnetic/WMM_2025.COF", "utf8"))),
  };
  const expected = (location: Omit<LocationInput, "decimalYear">) => effectiveConditions({ ...location, decimalYear: decimalYearOf(new Date()) }, models);
  await seed(page);
  const form = picker(page);
  // The default: ArduPilot's SITL test site, whose coordinates the site fixes.
  await expect(label(form, "Site")).toHaveValue("cmac");
  await expect(label(form, "Latitude (°)")).toBeDisabled();
  await expect(label(form, "Measured QNH (hPa)")).toBeDisabled();
  const cmac = expected(CMAC);
  await expect(form.getByTestId("conditions-gravity")).toContainText(`${cmac.gravityMps2.toFixed(5)} m/s²`);
  await expect(form.getByTestId("conditions-geoid")).toContainText(`EGM96-15min: undulation ${cmac.geoid.undulationM.toFixed(2)} m`);
  await expect(form.getByTestId("conditions-field")).toContainText(`WMM-2025: ${cmac.magnetic.totalNt.toFixed(0)} nT, declination ${cmac.magnetic.declinationDeg.toFixed(2)}°`);
  await expect(form.getByTestId("conditions-air")).toContainText(`${(cmac.air.pressurePa / 100).toFixed(2)} hPa, ${cmac.air.densityKgM3.toFixed(4)} kg/m³ (sea-level pressure 1013.25 hPa standard, ISA +0 K)`);
  await expect(form.getByTestId("location-status")).toHaveText("Saved location: ArduPilot SITL test site (CMAC, Canberra), heading 0°, standard sea-level pressure");

  // Coordinates in Israel with a typed elevation, a measured QNH and a temperature offset.
  await label(form, "Site").selectOption("coordinates");
  await expect(label(form, "Latitude (°)")).toBeEnabled();
  await label(form, "Latitude (°)").fill("31.5");
  await label(form, "Longitude (°)").fill("34.9");
  await label(form, "Ground elevation above mean sea level (m)").fill("250");
  await label(form, "Heading (°)").fill("90");
  await label(form, "Sea-level pressure").selectOption("measured");
  await label(form, "Measured QNH (hPa)").fill("1020");
  await label(form, "Temperature offset from ISA (K)").fill("5");
  const israel = expected(ISRAEL);
  await expect(form.getByTestId("conditions-gravity")).toContainText(`${israel.gravityMps2.toFixed(5)} m/s²`);
  await expect(form.getByTestId("conditions-geoid")).toContainText(`undulation ${israel.geoid.undulationM.toFixed(2)} m, ellipsoidal height ${israel.ellipsoidalHeightM.toFixed(2)} m`);
  await expect(form.getByTestId("conditions-field")).toContainText(`declination ${israel.magnetic.declinationDeg.toFixed(2)}°, inclination ${israel.magnetic.inclinationDeg.toFixed(2)}°`);
  await expect(form.getByTestId("conditions-air")).toContainText(`${(israel.air.temperatureK - 273.15).toFixed(2)} °C, ${(israel.air.pressurePa / 100).toFixed(2)} hPa`);
  await expect(form.getByTestId("conditions-air")).toContainText("(sea-level pressure 1020.00 hPa measured, ISA +5 K)");
  expect(israel.gravityMps2).not.toBeCloseTo(cmac.gravityMps2, 3);
  // A problem blocks saving and is named; fixing it unblocks.
  const save = form.getByRole("button", { name: "Save location", exact: true });
  await label(form, "Ground elevation above mean sea level (m)").fill("");
  await expect(form.getByRole("list", { name: "Problems to fix before saving the location" })).toHaveText("Ground elevation must be a number from -500 to 9000");
  await expect(save).toBeDisabled();
  await label(form, "Ground elevation above mean sea level (m)").fill("250");
  await expect(save).toBeEnabled();
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
  await save.click();
  await expect(form.getByTestId("location-status")).toHaveText(/^Saved\./);

  // The choice survives a reload, and the Run tab starts its next run there.
  await page.reload();
  const again = picker(page);
  await expect(label(again, "Site")).toHaveValue("coordinates");
  await expect(label(again, "Latitude (°)")).toHaveValue("31.5");
  await expect(label(again, "Measured QNH (hPa)")).toHaveValue("1020");
  await expect(label(again, "Temperature offset from ISA (K)")).toHaveValue("5");
  await expect(again.getByTestId("conditions-gravity")).toContainText(`${israel.gravityMps2.toFixed(5)} m/s²`);
  await page.getByRole("tab", { name: "Run", exact: true }).click();
  await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
  await expect(page.getByTestId("sitl-location")).toHaveText(
    "Location: 31.5°, 34.9°, 250 m above mean sea level, heading 90°, QNH 1020.00 hPa, ISA +5 K (Weather and location tab).");
});
