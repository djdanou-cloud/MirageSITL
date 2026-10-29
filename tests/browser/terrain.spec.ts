import { viteFileUrl } from "../support/vite-url";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// TASK-061: the real loader places the local CC0 fixture, releases it on dispose,
// and surfaces a network/CORS failure instead of silently showing nothing.
const harnessUrl = viteFileUrl(new URL("../support/terrain-harness.ts", import.meta.url));
const tilesetPath = fileURLToPath(new URL("../fixtures/tiles/tileset.json", import.meta.url));
const origin = (JSON.parse(readFileSync(tilesetPath, "utf8")) as { asset: { extras: { origin: { latDeg: number; lonDeg: number; heightM: number } } } }).asset.extras.origin;

test("loads and places the local 3D Tiles fixture, then disposes it", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async ({ harnessUrl, url, origin }) => {
    const h = await import(harnessUrl) as typeof import("../support/terrain-harness");
    return h.runTilesScenario(url, origin);
  }, { harnessUrl, url: viteFileUrl(new URL("../fixtures/tiles/tileset.json", import.meta.url)), origin });
  expect(result.failures).toEqual([]);
  expect(result.models).toBe(1);
  // The 200 m tile with a 20 m centre marker sits on the render origin's tangent plane.
  const expectedMin = [-100, 0, -100], expectedMax = [100, 20, 100];
  result.boxMin.forEach((v, i) => expect(Math.abs(v - expectedMin[i]!), `min ${i}: ${v}`).toBeLessThan(0.01));
  result.boxMax.forEach((v, i) => expect(Math.abs(v - expectedMax[i]!), `max ${i}: ${v}`).toBeLessThan(0.01));
  // Asymmetric check: 100 m east and 100 m north of the origin is render (100, 0, -100).
  result.northEastCorner.forEach((v, i) => expect(Math.abs(v - [100, 0, -100][i]!), `corner ${i}: ${v}`).toBeLessThan(0.01));
  expect(result.geometriesLoaded).toBeGreaterThan(0); // uploaded to the GPU while rendering
  expect(result.resourcesTracked).toBeGreaterThanOrEqual(2); // geometry + material
  expect(result.resourcesDisposed).toBe(result.resourcesTracked);
  expect([result.inFlightAfterDispose, result.modelsAfterDispose]).toEqual([0, 0]);
  expect(result.attribution).toBe("MirageSITL synthetic test tiles (CC0-1.0)");
  // TASK-062: the loader cache is capped at the smaller (512 MiB CPU) budget and the
  // fixture, far under budget, keeps the finest SSE target.
  expect(result.lruMaxBytes).toBe(512 * 1024 ** 2);
  expect(result.cachedBytes).toBeGreaterThan(0);
  expect(result.errorTarget).toBe(16);
});

test("reports an unreachable or CORS-blocked tileset as a classified failure", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async ({ harnessUrl, origin }) => {
    const h = await import(harnessUrl) as typeof import("../support/terrain-harness");
    return h.runTilesScenario("http://127.0.0.1:9/tileset.json", origin, 5000);
  }, { harnessUrl, origin });
  expect(result.models).toBe(0);
  expect(result.failures.map(f => f.kind)).toContain("cors-or-network");
  expect(result.inFlightAfterDispose).toBe(0);
});

// TASK-073: quantized-mesh terrain (the FABDEM pipeline's format) loads through the same
// TilesScene placement; the synthetic fixture is flat at 405 m ellipsoidal, origin at 400 m.
test("places quantized-mesh terrain at its ellipsoidal height", async ({ page }) => {
  const layerPath = fileURLToPath(new URL("../fixtures/terrain-qm/layer.json", import.meta.url));
  const layer = JSON.parse(readFileSync(layerPath, "utf8")) as { maxzoom: number; available: { startX: number; startY: number }[][];
    extras: { origin: { latDeg: number; lonDeg: number; heightM: number }; groundHeightM: number } };
  await page.goto("/");
  const result = await page.evaluate(async ({ harnessUrl, url, origin }) => {
    const h = await import(harnessUrl) as typeof import("../support/terrain-harness");
    return h.runQuantizedMeshScenario(url, origin);
  }, { harnessUrl, url: viteFileUrl(new URL("../fixtures/terrain-qm/layer.json", import.meta.url)), origin: layer.extras.origin });
  expect([result.failures, result.loadErrors]).toEqual([0, 0]);
  expect(result.models).toBeGreaterThan(0);
  // The ray ends on the deepest tile, the one generate.py wrote around the origin; coarser levels sag below the ellipsoid.
  const deepest = layer.available[layer.maxzoom]?.[0] ?? { startX: -1, startY: -1 };
  expect(result.hitLeaf, `hit tile ${String(result.hitUrl)}`).toBe(true);
  expect(result.hitUrl).toMatch(new RegExp(`/${layer.maxzoom}/${deepest.startX}/${deepest.startY}\\.terrain$`));
  expect(result.groundY).not.toBeNull();
  expect(Math.abs((result.groundY ?? 0) - (layer.extras.groundHeightM - layer.extras.origin.heightM))).toBeLessThan(0.5);
});

// TASK-073: pg2b3dm writes 3D Tiles 1.1 implicit tiling (subtrees + {level}_{x}_{y} content).
// Without ImplicitTilingPlugin the loader requests the literal template path and gets a 404.
test("loads an implicit-tiling tileset like its explicit twin", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async ({ harnessUrl, url, origin }) => {
    const h = await import(harnessUrl) as typeof import("../support/terrain-harness");
    return h.runTilesScenario(url, origin);
  }, { harnessUrl, url: viteFileUrl(new URL("../fixtures/tiles-implicit/tileset.json", import.meta.url)), origin });
  expect(result.failures).toEqual([]);
  expect(result.loadErrors).toBe(0);
  expect(result.models).toBe(1);
  const expectedMin = [-100, 0, -100], expectedMax = [100, 20, 100];
  result.boxMin.forEach((v, i) => expect(Math.abs(v - expectedMin[i]!), `min ${i}: ${v}`).toBeLessThan(0.01));
  result.boxMax.forEach((v, i) => expect(Math.abs(v - expectedMax[i]!), `max ${i}: ${v}`).toBeLessThan(0.01));
});
