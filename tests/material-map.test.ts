// TASK-069: surface material map with provenance. The raster below is a
// synthetic, georeferenced stand-in on the real WorldCover grid (1/12000 deg
// pixels) and is labelled synthetic; no ESA or OSM data is downloaded or
// committed. Checking real tiles needs a locally placed, licensed file.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attributionsFor, parseDataManifest, planWorldCoverTiles, worldCoverTileName, type DataManifest } from "../packages/thermal/src/data-manifest.ts";
import { MaterialMap, parseMaterialClasses, type OsmFeature, type WorldCoverRaster } from "../packages/thermal/src/material-map.ts";

const legendJson: unknown = JSON.parse(readFileSync(new URL("./fixtures/thermal/material-classes.json", import.meta.url), "utf8"));
const classes = parseMaterialClasses(legendJson);
const PX = 1 / 12000;
const NORTH = 47.38, WEST = 8.53, SIZE = 12;
const CODES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
/** Synthetic raster: class index (row + 2 col) mod 11; row 5, col 5 is no-data. */
function raster(datasetId: string): WorldCoverRaster {
  const data = new Uint8Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) data[r * SIZE + c] = r === 5 && c === 5 ? 0 : CODES[(r + 2 * c) % 11]!;
  return { datasetId, northDeg: NORTH, westDeg: WEST, pixelDeg: PX, width: SIZE, height: SIZE, data };
}
const bounds = { south: NORTH - SIZE * PX, west: WEST, north: NORTH, east: WEST + SIZE * PX };
const SYNTH = { id: "synthetic-grid", provider: "synthetic", version: "1", license: "CC0-1.0", attribution: "MirageSITL synthetic test grid", sha256: null, crs: "EPSG:4326", bounds, synthetic: true };
// Test double for the provider path only: NOT real ESA/OSM data and never shipped.
const ESA_DOUBLE = { id: "esa-path-double", provider: "esa-worldcover", version: "v200", license: "CC-BY-4.0",
  attribution: "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium", sha256: "c".repeat(64), crs: "EPSG:4326", bounds, synthetic: false };
const OSM_DOUBLE = { id: "osm-path-double", provider: "openstreetmap", version: "2026-10-01", license: "ODbL-1.0", attribution: "© OpenStreetMap contributors", sha256: "d".repeat(64),
  crs: "EPSG:4326", bounds, synthetic: false };
const manifest: DataManifest = parseDataManifest({ schema: "mirage.thermal-data/1", datasets: [SYNTH, ESA_DOUBLE, OSM_DOUBLE] });
const pixelCentre = (r: number, c: number): [number, number] => [NORTH - (r + 0.5) * PX, WEST + (c + 0.5) * PX];
const origin = { latDeg: NORTH, lonDeg: WEST };

describe("material classes", () => {
  it("covers the full WorldCover v200 legend and rejects temperatures or unknown fields", () => {
    expect([...classes.worldcover.keys()].sort((a, b) => a - b)).toEqual(CODES);
    expect(classes.worldcover.get(80)?.material).toBe("water");
    expect(classes.highway.get("residential")).toEqual({ material: "asphalt", widthM: 6 });
    const legend = legendJson as { worldcover: { classes: Record<string, object> } };
    const withTemperature = structuredClone(legend);
    withTemperature.worldcover.classes["80"] = { ...withTemperature.worldcover.classes["80"], temperatureK: 290 };
    expect(() => parseMaterialClasses(withTemperature)).toThrow("expected keys");
    expect(() => parseMaterialClasses({ ...legend, emissivity: 0.9 })).toThrow();
  });
});

describe("data manifest", () => {
  it("enforces provider licenses, attribution, hashes and synthetic labelling", () => {
    const parse = (entry: object) => parseDataManifest({ schema: "mirage.thermal-data/1", datasets: [entry] });
    expect(parse(ESA_DOUBLE).datasets[0]!.license).toBe("CC-BY-4.0");
    for (const bad of [{ ...ESA_DOUBLE, license: "CC0-1.0" }, { ...ESA_DOUBLE, attribution: "ESA" }, { ...ESA_DOUBLE, sha256: null },
      { ...ESA_DOUBLE, synthetic: true }, { ...OSM_DOUBLE, license: "CC-BY-4.0" }, { ...OSM_DOUBLE, attribution: "OSM" }, { ...SYNTH, synthetic: false },
      { ...SYNTH, crs: "EPSG:3857" }, { ...SYNTH, bounds: { ...bounds, south: 50 } }, { ...SYNTH, provider: "google" }, { ...SYNTH, extra: 1 }]) {
      expect(() => parse(bad), JSON.stringify(bad).slice(0, 80)).toThrow();
    }
    expect(() => parseDataManifest({ schema: "mirage.thermal-data/1", datasets: [SYNTH, SYNTH] })).toThrow("duplicate");
    expect(attributionsFor(manifest, ["osm-path-double", "synthetic-grid"])).toEqual(["MirageSITL synthetic test grid", "© OpenStreetMap contributors"]);
  });

  it("names WorldCover tiles by their south-west corner and refuses bulk plans", () => {
    expect(worldCoverTileName(47.38, 8.53)).toBe("N45E006");
    expect(worldCoverTileName(-1.5, -58.2)).toBe("S03W060");
    expect(worldCoverTileName(0, 0)).toBe("N00E000");
    expect(worldCoverTileName(-0.1, -0.1)).toBe("S03W003");
    expect(worldCoverTileName(48, 9)).toBe("N48E009");
    // A 15 km region around Zurich needs one tile; one straddling 48N/9E needs four.
    expect(planWorldCoverTiles({ south: 47.31, west: 8.44, north: 47.45, east: 8.64 })).toEqual(["N45E006"]);
    expect(planWorldCoverTiles({ south: 47.93, west: 8.9, north: 48.07, east: 9.1 })).toEqual(["N45E006", "N45E009", "N48E006", "N48E009"]);
    expect(() => planWorldCoverTiles({ south: 40, west: 0, north: 50, east: 10 })).toThrow("explicit authorization");
  });
});

describe("material map", () => {
  it("maps known coordinates to their WorldCover pixel, including pixel edges", () => {
    const map = new MaterialMap(classes, manifest, origin, { worldcover: [raster("esa-path-double")] });
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (r === 5 && c === 5) continue;
      const [lat, lon] = pixelCentre(r, c);
      const s = map.sampleAt(lat, lon);
      expect(s.worldCoverClass, `${r},${c}`).toBe(CODES[(r + 2 * c) % 11]);
      expect(s).toMatchObject({ source: "worldcover", synthetic: false, datasetId: "esa-path-double" });
    }
    // Pixel-is-area: a point on a pixel's north-west corner belongs to that pixel.
    expect(map.sampleAt(NORTH - 3 * PX, WEST + 7 * PX).worldCoverClass).toBe(CODES[(3 + 14) % 11]);
    expect(map.sampleAt(NORTH, WEST).worldCoverClass).toBe(CODES[0]);
    expect(map.sampleAt(NORTH - 2 * PX + 1e-12, WEST + 1 * PX).worldCoverClass).toBe(CODES[(1 + 2) % 11]); // just north of the row-2 edge
    expect(map.sampleAt(pixelCentre(0, 3)[0], pixelCentre(0, 3)[1]).material).toBe(classes.worldcover.get(CODES[6]!)!.material);
  });

  it("labels missing data synthetic: outside every layer and WorldCover no-data", () => {
    const map = new MaterialMap(classes, manifest, origin, { worldcover: [raster("esa-path-double")] });
    const synthetic = { material: "synthetic-ground", source: "synthetic", synthetic: true, datasetId: null, worldCoverClass: null };
    expect(map.sampleAt(...pixelCentre(5, 5))).toEqual(synthetic);
    expect(map.sampleAt(NORTH + 0.5 * PX, WEST + 0.5 * PX)).toEqual(synthetic);
    expect(map.sampleAt(NORTH - 0.5 * PX, WEST + (SIZE + 0.5) * PX)).toEqual(synthetic);
    // Synthetic layers stay labelled synthetic even when they carry WorldCover-coded classes.
    const fake = new MaterialMap(classes, manifest, origin, { worldcover: [raster("synthetic-grid")] });
    expect(fake.sampleAt(...pixelCentre(0, 0))).toMatchObject({ source: "worldcover", synthetic: true, worldCoverClass: 10 });
  });

  it("overlays OSM buildings over roads over land classes, with roof materials", () => {
    // Local metres north/east of the origin -> degrees (small region, spherical scale is enough for test geometry).
    const toDeg = (northM: number, eastM: number): [number, number] => [NORTH + northM / 111_195, WEST + eastM / (111_195 * Math.cos(NORTH * Math.PI / 180))];
    const square = (n0: number, e0: number, size: number) => [toDeg(n0, e0), toDeg(n0, e0 + size), toDeg(n0 - size, e0 + size), toDeg(n0 - size, e0)];
    const buildings: OsmFeature[] = [
      { datasetId: "osm-path-double", tags: { building: "yes", "roof:material": "metal" }, coordinates: square(-20, 20, 20) },
      { datasetId: "osm-path-double", tags: { building: "house" }, coordinates: square(-60, 60, 10) },
    ];
    const roads: OsmFeature[] = [
      { datasetId: "osm-path-double", tags: { highway: "residential" }, coordinates: [toDeg(-30, 0), toDeg(-30, 140)] },
      { datasetId: "osm-path-double", tags: { highway: "footway" }, coordinates: [toDeg(-80, 0), toDeg(-80, 140)] },
    ];
    const map = new MaterialMap(classes, manifest, origin, { worldcover: [raster("esa-path-double")], buildings, roads });
    expect(map.attributions()).toEqual([]);
    expect(map.sampleAt(...toDeg(-25, 25))).toMatchObject({ material: "roof-metal", source: "osm-building", synthetic: false });
    expect(map.sampleAt(...toDeg(-62, 62)).material).toBe("roof-generic");
    // Road: residential is 6 m wide, so 2.9 m from the centreline is asphalt and 3.2 m is not.
    expect(map.sampleAt(...toDeg(-32.9, 50))).toMatchObject({ material: "asphalt", source: "osm-road" });
    expect(map.sampleAt(...toDeg(-33.2, 50)).source).toBe("worldcover");
    // The building over the road wins; footways carry no surface class.
    expect(map.sampleAt(...toDeg(-30, 30)).source).toBe("osm-building");
    expect(map.sampleAt(...toDeg(-80, 50)).source).toBe("worldcover");
    expect(map.attributions()).toEqual([ESA_DOUBLE.attribution, OSM_DOUBLE.attribution]);
  });

  it("never returns a temperature or other thermal quantity", () => {
    const map = new MaterialMap(classes, manifest, origin, { worldcover: [raster("synthetic-grid")] });
    for (const point of [pixelCentre(1, 1), pixelCentre(5, 5), [0, 0] as [number, number]]) {
      expect(Object.keys(map.sampleAt(...point)).sort()).toEqual(["datasetId", "material", "source", "synthetic", "worldCoverClass"]);
    }
  });

  it("rejects layers without manifest provenance, mismatched bounds and unknown classes", () => {
    expect(() => new MaterialMap(classes, manifest, origin, { worldcover: [raster("unregistered")] })).toThrow("not in the data manifest");
    expect(() => new MaterialMap(classes, manifest, origin, { worldcover: [raster("osm-path-double")] })).toThrow("cannot provide");
    expect(() => new MaterialMap(classes, manifest, origin, { worldcover: [{ ...raster("esa-path-double"), northDeg: NORTH + 0.01 }] })).toThrow("manifest bounds");
    const bad = raster("esa-path-double"); bad.data[3] = 77;
    expect(() => new MaterialMap(classes, manifest, origin, { worldcover: [bad] })).toThrow("Unknown WorldCover class 77");
    expect(() => new MaterialMap(classes, manifest, origin, { buildings: [{ datasetId: "esa-path-double", tags: { building: "yes" }, coordinates: [] }] })).toThrow("cannot provide");
  });

  it("contains no network or download code", () => {
    const dir = new URL("../packages/thermal/src/", import.meta.url);
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile());
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const entry of files) {
      const file = `${entry.parentPath}/${entry.name}`;
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\/|node:https?|import\(\s*["']http/);
    }
  });
});
