// Cross-checks the generated material raster (build_material_map.py) against
// the TypeScript MaterialMap (TASK-069) on the same inputs (TASK-073 P4).
//
//   node --experimental-transform-types scripts/geodata/check_material_map.mjs --materials DIR --osm DIR \
//        [--worldcover data/worldcover/2021-v200/israel] [--classes config/material-classes.json] [--samples 5000]
//
// Samples seeded random pixel centres. Pass criterion, fixed before the first
// run: at least 97% agreement, and every disagreement lies within 1.5 px of a
// raster class boundary (rasterising at pixel centres legitimately differs
// from exact point-in-polygon and distance tests right at an edge). Also
// validates data-manifest.json with parseDataManifest. Exit 0 on PASS, 1 on FAIL.
import { readFileSync, openSync, readSync, fstatSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { MaterialMap, parseMaterialClasses } from "../../packages/thermal/src/material-map.ts";
import { parseDataManifest } from "../../packages/thermal/src/data-manifest.ts";
import { parseGeoTiffHeader, windowForBounds, readWindow } from "../../packages/thermal/src/geotiff.ts";
import { LocalTangentFrame } from "../../packages/sensors/src/geodesy.ts";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
const materialsDir = option("materials", null), osmDir = option("osm", null);
if (!materialsDir || !osmDir) throw new Error("Expected --materials DIR --osm DIR");
const worldcoverDir = option("worldcover", "data/worldcover/2021-v200/israel");
const samples = Number(option("samples", "5000"));
const json = path => JSON.parse(readFileSync(path, "utf8"));

const raster = json(join(materialsDir, "materials.json"));
const data = readFileSync(join(materialsDir, "materials.bin"));
if (data.length !== raster.width * raster.height) throw new Error("materials.bin size does not match materials.json");
const manifest = parseDataManifest(json(join(materialsDir, "data-manifest.json")));
const classes = parseMaterialClasses(json(option("classes", "config/material-classes.json")));
const { latDeg, lonDeg } = raster.origin;

// WorldCover window around the area, read with the repository's GeoTIFF decoder.
const wcEntry = manifest.datasets.find(d => d.provider === "esa-worldcover");
const inventory = json(join(worldcoverDir, "inventory.json"));
const tile = inventory.files.find(f => f.sha256 === wcEntry.sha256);
const fd = openSync(join(worldcoverDir, tile.path), "r");
const read = (offset, length) => { const b = Buffer.alloc(length); readSync(fd, b, 0, length, offset); return new Uint8Array(b.buffer, b.byteOffset, length); };
const header = parseGeoTiffHeader(read, fstatSync(fd).size);
const dLat = (raster.extentM.north + 50) / 111320, dLon = dLat / Math.cos(latDeg * Math.PI / 180);
const window = windowForBounds(header, { south: latDeg - dLat, west: lonDeg - dLon, north: latDeg + dLat, east: lonDeg + dLon });
const worldcover = readWindow(header, read, bytes => new Uint8Array(inflateSync(bytes)), window, wcEntry.id);
// The manifest describes the whole tile; MaterialMap checks a raster against its entry's bounds, so describe the window.
const windowManifest = parseDataManifest({ schema: "mirage.thermal-data/1", datasets: manifest.datasets.map(d => d.id !== wcEntry.id ? d : {
  ...d, bounds: { north: worldcover.northDeg, west: worldcover.westDeg, south: worldcover.northDeg - worldcover.height * worldcover.pixelDeg,
    east: worldcover.westDeg + worldcover.width * worldcover.pixelDeg } }) });

// OSM features: each polygon's outer ring and each line part, as [lat, lon].
const osmId = manifest.datasets.find(d => d.provider === "openstreetmap").id;
const ringsOf = geometry => geometry.type === "Polygon" ? [geometry.coordinates[0]] : geometry.type === "MultiPolygon" ? geometry.coordinates.map(p => p[0]) : [];
const linesOf = geometry => geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
const latLon = coordinates => coordinates.map(([lon, lat]) => [lat, lon]);
const buildings = json(join(osmDir, "osm-buildings.geojson")).features.flatMap(f => ringsOf(f.geometry).filter(r => r.length >= 3)
  .map(ring => ({ datasetId: osmId, tags: Object.fromEntries(Object.entries(f.properties).filter(([k, v]) => k !== "osm_id" && typeof v === "string")), coordinates: latLon(ring) })));
const roads = json(join(osmDir, "osm-roads.geojson")).features.flatMap(f => linesOf(f.geometry).filter(l => l.length >= 2)
  .map(line => ({ datasetId: osmId, tags: { highway: f.properties.highway }, coordinates: latLon(line) })));
const map = new MaterialMap(classes, windowManifest, { latDeg, lonDeg }, { worldcover: [worldcover], buildings, roads });

// Seeded sampling (mulberry32) of pixel centres -> local north/east -> geodetic.
let seed = 0x7a5c0073;
const random = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const frame = new LocalTangentFrame(latDeg * Math.PI / 180, lonDeg * Math.PI / 180, 0);
const ned = new Float64Array(3), geo = new Float64Array(3);
const at = (row, col) => data[row * raster.width + col];
let agree = 0, nearEdge = 0, far = 0;
const farExamples = [];
for (let i = 0; i < samples; i++) {
  const row = Math.floor(random() * raster.height), col = Math.floor(random() * raster.width);
  ned[0] = raster.extentM.north - (row + 0.5) * raster.pixelM; ned[1] = raster.extentM.west + (col + 0.5) * raster.pixelM; ned[2] = 0;
  frame.nedToGeodeticFromInto(ned, geo);
  const expected = map.sampleAt(geo[0] * 180 / Math.PI, geo[1] * 180 / Math.PI).material;
  if (raster.materials[at(row, col)] === expected) { agree++; continue; }
  let edge = false;
  for (let dr = -1; dr <= 1 && !edge; dr++) for (let dc = -1; dc <= 1; dc++) {
    const r = row + dr, c = col + dc;
    if (r >= 0 && c >= 0 && r < raster.height && c < raster.width && raster.materials[at(r, c)] === expected) { edge = true; break; }
  }
  if (edge) nearEdge++; else { far++; if (farExamples.length < 5) farExamples.push({ row, col, raster: raster.materials[at(row, col)], materialMap: expected }); }
}
const agreement = agree / samples;
const pass = agreement >= 0.97 && far === 0;
console.log(JSON.stringify({ status: pass ? "PASS" : "FAIL", samples, agreement, mismatchesNearEdge: nearEdge, mismatchesAwayFromEdge: far, farExamples,
  manifest: manifest.datasets.map(d => d.id) }, null, 1));
process.exitCode = pass ? 0 : 1;
