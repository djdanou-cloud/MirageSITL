import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseManifestBox, parseQuantizedLayer } from "../../packages/terrain/src/coverage.ts";
import { buildRunTerrain, latticeSha256 } from "../../packages/terrain/src/run-terrain.ts";
import { viteFileUrl } from "../support/vite-url";

// TASK-186 (S17): the terrain of the Weather and location tab through the UI. Offline, with nothing served, the pad is the only
// ground and every other source says why it is not ready. With local terrain served (the sloped quantized-mesh fixture, routed in
// place of MIRAGE_GEODATA_DIR's /geodata/terrain/), FABDEM is ready where it covers the location, the choice survives a reload, the
// terrain's height becomes the ground elevation, and the lattice a run builds in the browser is the one Node builds, bit for bit.
type Store = typeof import("../../packages/project/src/store");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
type LocalTerrain = typeof import("../../apps/web/src/weather/local-terrain");
type Conditions = typeof import("../../apps/web/src/weather/conditions");
type TerrainStore = typeof import("../../apps/web/src/weather/terrain-store");
type Location = typeof import("../../apps/web/src/weather/location");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
  local: viteFileUrl(new URL("../../apps/web/src/weather/local-terrain.ts", import.meta.url)),
  conditions: viteFileUrl(new URL("../../apps/web/src/weather/conditions.ts", import.meta.url)),
  terrainStore: viteFileUrl(new URL("../../apps/web/src/weather/terrain-store.ts", import.meta.url)),
  location: viteFileUrl(new URL("../../apps/web/src/weather/location.ts", import.meta.url)),
};
const FIXTURE = new URL("../fixtures/terrain-qm-slope/", import.meta.url);
const fixtureBytes = (name: string) => readFileSync(new URL(name, FIXTURE));
/** A place inside the fixture's bounding box, and the plane its tiles were written from. */
const PLACE = { latitudeDeg: 32.19, longitudeDeg: 34.8596 };

async function seed(page: Page): Promise<string> {
  await page.goto("/");
  const projectId = await page.evaluate(async ({ urls }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("Terrain project");
      await saveNavigation(store, { tab: "weather", projectId: project.record.id });
      return project.record.id;
    } finally {
      store.close();
    }
  }, { urls });
  await page.reload();
  return projectId;
}
/** Serves the fixture at /geodata/terrain/, as the dev server serves MIRAGE_GEODATA_DIR; a tile the fixture lacks is 404. */
async function serveFixture(page: Page): Promise<void> {
  await page.route("**/geodata/terrain/**", async route => {
    const name = new URL(route.request().url()).pathname.replace("/geodata/terrain/", "");
    try {
      await route.fulfill({ status: 200, body: fixtureBytes(name), contentType: name.endsWith(".json") ? "application/json" : "application/vnd.quantized-mesh" });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
}
const section = (page: Page) => page.getByRole("tabpanel", { name: "Weather and location", exact: true }).getByTestId("terrain-source");
const row = (scope: Locator, id: string) => scope.getByTestId(`terrain-source-${id}`);

test("offline, the pad is the only ground and every other source says why it is not ready", async ({ page }) => {
  test.setTimeout(60_000);
  // Offline: the page talks to its loopback server alone (Chrome's offline mode would cut that server too).
  const hosts = new Set<string>();
  page.on("request", request => { hosts.add(new URL(request.url()).host); });
  await seed(page);
  const terrain = section(page);
  await expect(terrain.getByRole("radio", { name: "Synthetic level pad (synthetic)" })).toBeChecked();
  await expect(terrain.getByLabel(/^Terrain radius around the home/)).toBeDisabled();
  await expect(row(terrain, "synthetic-pad")).toHaveAttribute("data-readiness", "ready");
  await expect(row(terrain, "synthetic-pad")).toContainText("Ready, offline");
  await expect(row(terrain, "fabdem-elevation")).toHaveAttribute("data-readiness", "not-ready");
  await expect(row(terrain, "fabdem-elevation")).toContainText("No local terrain is served: start the application with MIRAGE_GEODATA_DIR");
  // Real terrain cannot be chosen; imagery is never offered as ground.
  await expect(terrain.getByRole("radio", { name: /^FABDEM/ })).toBeDisabled();
  await expect(terrain.getByRole("radio")).toHaveCount(2);
  for (const id of ["google-photorealistic-3d-tiles", "r2-region-cache"]) {
    await expect(row(terrain, id)).toHaveAttribute("data-layer", "imagery");
    await expect(row(terrain, id)).toContainText("Not ready: Needs keys or a deployment");
  }
  await expect(row(terrain, "worldcover-israel")).toContainText("Imagery, not ground");
  await expect(terrain.getByTestId("terrain-elevation")).toContainText("No real terrain covers the location.");
  // The pad is the next run's ground, saved as such.
  await expect(terrain.getByRole("button", { name: "Save the terrain choice" })).toBeDisabled();
  const result = await new AxeBuilder({ page }).include('[data-testid="terrain-source"]').analyze();
  expect(result.violations).toEqual([]);
  expect([...hosts]).toEqual(["127.0.0.1:5173"]);
});

test("served local terrain is ready where it covers the location, is chosen at run time, gives the ground elevation, and builds the same lattice as Node", async ({ page }) => {
  test.setTimeout(90_000);
  await serveFixture(page);
  const projectId = await seed(page);
  // Coordinates inside the fixture.
  const picker = page.getByRole("tabpanel", { name: "Weather and location", exact: true }).getByTestId("location-picker");
  await picker.getByLabel("Site", { exact: true }).selectOption("coordinates");
  await picker.getByLabel("Latitude (°)", { exact: true }).fill(String(PLACE.latitudeDeg));
  await picker.getByLabel("Longitude (°)", { exact: true }).fill(String(PLACE.longitudeDeg));
  await picker.getByLabel("Ground elevation above mean sea level (m)", { exact: true }).fill("90");
  await picker.getByRole("button", { name: "Save location", exact: true }).click();
  await expect(picker.getByTestId("location-status")).toHaveText(/^Saved\./);
  const terrain = section(page);
  await expect(row(terrain, "fabdem-elevation")).toHaveAttribute("data-readiness", "ready");
  const box = parseManifestBox(JSON.parse(fixtureBytes("terrain-manifest.json").toString("utf8")));
  await expect(row(terrain, "fabdem-elevation")).toContainText(`${box[1].toFixed(4)}° to ${box[3].toFixed(4)}° N, ${box[0].toFixed(4)}° to ${box[2].toFixed(4)}° E`);
  // The terrain's height at the location: the plane's ellipsoidal height there, less the EGM96 undulation.
  const elevation = terrain.getByTestId("terrain-elevation");
  await expect(elevation).toContainText("m above mean sea level");
  const plane = 120 + 900 * (PLACE.longitudeDeg - 34.87) - 1500 * (PLACE.latitudeDeg - 32.2);
  await expect(elevation).toContainText(`(ellipsoidal ${plane.toFixed(1)} m`);
  const mslText = /^Terrain at the location([-\d.]+) m above mean sea level/.exec((await elevation.textContent()) ?? "")?.[1];
  expect(mslText).toBeDefined();
  // Choose it with a radius out of range first: the problem is named and nothing is saved.
  await terrain.getByRole("radio", { name: /^FABDEM/ }).check();
  await terrain.getByLabel(/^Terrain radius around the home/).fill("2000");
  await expect(terrain.getByTestId("terrain-refusal")).toHaveText("The terrain radius must be 256 m to 1500 m");
  await expect(terrain.getByRole("button", { name: "Save the terrain choice" })).toBeDisabled();
  await terrain.getByLabel(/^Terrain radius around the home/).fill("256");
  await terrain.getByRole("button", { name: "Save the terrain choice" }).click();
  await expect(terrain.getByTestId("terrain-status")).toHaveText("Saved. The next run loads the local terrain within 256 m of its home, and pauses where the aircraft leaves it.");
  // The terrain height becomes the location's ground elevation.
  await terrain.getByRole("button", { name: "Use the terrain height as the ground elevation" }).click();
  await expect(picker.getByLabel("Ground elevation above mean sea level (m)", { exact: true })).toHaveValue(String(Math.round(Number(mslText) * 10) / 10));
  const result = await new AxeBuilder({ page }).include('[data-testid="terrain-source"]').analyze();
  expect(result.violations).toEqual([]);

  // After a reload the choice stands, and a run's terrain is built in the browser from the served tiles.
  await page.reload();
  await expect(section(page).getByRole("radio", { name: /^FABDEM/ })).toBeChecked();
  await expect(section(page).getByLabel(/^Terrain radius around the home/)).toHaveValue("256");
  const built = await page.evaluate(async ({ urls, projectId }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { runTerrainFor } = await import(urls.local) as LocalTerrain;
    const { environmentFor } = await import(urls.conditions) as Conditions;
    const { loadTerrainChoice } = await import(urls.terrainStore) as TerrainStore;
    const { loadLocation } = await import(urls.location) as Location;
    const store = await ProjectStore.openIndexedDb();
    try {
      const environment = await environmentFor(await loadLocation(store, projectId));
      const terrain = await runTerrainFor(await loadTerrainChoice(store, projectId), environment);
      return { record: terrain?.record ?? null, chunks: terrain?.chunks.map(chunk => [chunk.northIndex, chunk.eastIndex]) ?? [],
        home: { latitudeDeg: environment.location.latitudeDeg, longitudeDeg: environment.location.longitudeDeg, ellipsoidalHeightM: environment.conditions.ellipsoidalHeightM } };
    } finally {
      store.close();
    }
  }, { urls, projectId });
  const sha = (name: string) => createHash("sha256").update(fixtureBytes(name)).digest("hex");
  expect(built.record).toMatchObject({ sourceId: "fabdem-elevation", radiusM: 256, level: 14, chunks: 4, missingChunks: 0,
    layerSha256: sha("layer.json"), manifestSha256: sha("terrain-manifest.json") });
  expect(built.chunks).toEqual([[-1, -1], [-1, 0], [0, -1], [0, 0]]);
  const node = await buildRunTerrain({ layer: parseQuantizedLayer(JSON.parse(fixtureBytes("layer.json").toString("utf8"))), bbox: box, home: built.home, radiusM: 256,
    fetchTile: (z, x, y) => Promise.resolve(new Uint8Array(fixtureBytes(`${z}/${x}/${y}.terrain`))) });
  expect(built.record?.latticeSha256).toBe(await latticeSha256(node.tiles));
  expect(built.record?.homeHeightM).toBe(node.homeHeightM);
});

test("a location the served terrain does not cover keeps FABDEM not ready, and a run there is refused with the reason", async ({ page }) => {
  test.setTimeout(60_000);
  await serveFixture(page);
  const projectId = await seed(page);
  const terrain = section(page);
  // The default location (CMAC, Canberra) is far outside the fixture.
  await expect(row(terrain, "fabdem-elevation")).toHaveAttribute("data-readiness", "not-ready");
  await expect(row(terrain, "fabdem-elevation")).toContainText("not the location");
  const refusal = await page.evaluate(async ({ urls, projectId }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { runTerrainFor } = await import(urls.local) as LocalTerrain;
    const { environmentFor } = await import(urls.conditions) as Conditions;
    const { loadLocation } = await import(urls.location) as Location;
    const store = await ProjectStore.openIndexedDb();
    try {
      const environment = await environmentFor(await loadLocation(store, projectId));
      return await runTerrainFor({ schemaVersion: 1, sourceId: "fabdem-elevation", radiusM: 1000 }, environment).then(() => "built", (cause: unknown) => String(cause));
    } finally {
      store.close();
    }
  }, { urls, projectId });
  expect(refusal).toBe("Error: The local terrain does not cover the location: choose the synthetic pad, or a location inside the terrain's bounding box");
});
