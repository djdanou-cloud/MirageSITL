// TASK-073 P4: material raster parsing, display palette and drape loading.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MATERIAL_COLORS, loadMaterialDrape, paletteBytes, parseMaterialRaster } from "../apps/web/src/render/material-drape.ts";

const raster = {
  schema: "mirage.material-raster/1", origin: { latDeg: 32.2, lonDeg: 34.87 }, pixelM: 1, width: 4, height: 2,
  extentM: { west: -2, east: 2, south: -1, north: 1 }, materials: ["synthetic-ground", "asphalt", "not-a-colour"], datasets: ["synthetic-grid"],
};
const bounds = { south: 32.19, west: 34.86, north: 32.21, east: 34.88 };
const manifest = { schema: "mirage.thermal-data/1", datasets: [{ id: "synthetic-grid", provider: "synthetic", version: "1", license: "CC0-1.0",
  attribution: "MirageSITL synthetic test grid", sha256: null, crs: "EPSG:4326", bounds, synthetic: true }] };

describe("material raster", () => {
  it("parses a valid raster and rejects grids, extents and class tables that do not match", () => {
    expect(parseMaterialRaster(raster)).toMatchObject({ width: 4, height: 2, extentM: { west: -2, north: 1 }, materials: raster.materials });
    for (const bad of [{ ...raster, schema: "mirage.material-raster/2" }, { ...raster, width: 0 }, { ...raster, width: 2.5 }, { ...raster, pixelM: 0 },
      { ...raster, extentM: { ...raster.extentM, east: 10 } }, { ...raster, materials: [] }, { ...raster, materials: ["Asphalt"] },
      { ...raster, datasets: [1] }, { ...raster, origin: { latDeg: "32", lonDeg: 34 } }]) {
      expect(() => parseMaterialRaster(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("has a display colour for every configured material and leaves unknown classes transparent", () => {
    const config: unknown = JSON.parse(readFileSync("config/material-classes.json", "utf8"));
    const ids = [...JSON.stringify(config).matchAll(/"material":"([a-z-]+)"/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) expect(MATERIAL_COLORS[id ?? ""], id).toBeTypeOf("number");
    const bytes = paletteBytes(raster.materials);
    expect(bytes.length).toBe(1024);
    expect([...bytes.subarray(4, 8)]).toEqual([0x4b, 0x4d, 0x50, 255]);
    expect(bytes[11]).toBe(0);
    expect(bytes[15]).toBe(0);
  });
});

describe("material drape loading", () => {
  const files: Record<string, () => Response> = {
    "materials.json": () => Response.json(raster),
    "materials.bin": () => new Response(new Uint8Array(8)),
    "data-manifest.json": () => Response.json(manifest),
  };
  const fetchFrom = (table: Record<string, () => Response>): typeof fetch => (input) => {
    const name = String(input instanceof Request ? input.url : input).split("/").pop() ?? "";
    const make = table[name];
    return Promise.resolve(make ? make() : new Response("missing", { status: 404 }));
  };

  it("loads siblings of materials.json and reports attributions", async () => {
    const drape = await loadMaterialDrape("http://localhost/geodata/materials/materials.json", fetchFrom(files));
    expect(drape.attributions).toEqual(["MirageSITL synthetic test grid"]);
    expect([drape.extent.x, drape.extent.y, drape.extent.z, drape.extent.w]).toEqual([-2, -1, 2, 1]);
    drape.dispose();
  });

  it("rejects a class grid of the wrong size, an unlisted dataset and a missing file", async () => {
    const url = "http://localhost/geodata/materials/materials.json";
    await expect(loadMaterialDrape(url, fetchFrom({ ...files, "materials.bin": () => new Response(new Uint8Array(7)) }))).rejects.toThrow("does not match");
    await expect(loadMaterialDrape(url, fetchFrom({ ...files, "materials.json": () => Response.json({ ...raster, datasets: ["osm"] }) }))).rejects.toThrow("not in the data manifest");
    await expect(loadMaterialDrape(url, fetchFrom({ "materials.json": files["materials.json"]! }))).rejects.toThrow("HTTP 404");
  });
});
