// TASK-069: real ESA WorldCover tiles (Israel scope) through the windowed
// GeoTIFF reader and the material map. Known-coordinate expectations are
// geographic facts independent of this code: open sea and lakes are water,
// central Tel Aviv is built-up, Makhtesh Ramon is bare desert, and the
// Jezreel and Hula valleys are farmland.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { parseDataManifest } from "../packages/thermal/src/data-manifest.ts";
import {
  assertIsraelCoverage, MAX_WINDOW_PIXELS, parseGeoTiffHeader, readWindow, windowForBounds,
  type ByteReader, type GeoTiffHeader,
} from "../packages/thermal/src/geotiff.ts";
import { MaterialMap, parseMaterialClasses, type WorldCoverRaster } from "../packages/thermal/src/material-map.ts";

const DIR = new URL("../data/worldcover/2021-v200/israel/", import.meta.url);
const ATTRIBUTION = "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium";
const inflate = (b: Uint8Array) => new Uint8Array(inflateSync(b));
const classes = parseMaterialClasses(JSON.parse(readFileSync(new URL("./fixtures/thermal/material-classes.json", import.meta.url), "utf8")));
const inventory: unknown = JSON.parse(readFileSync(new URL("inventory.json", DIR), "utf8"));

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function inventoryFiles(): { tile: string; path: string; sha256: string; bytes: number }[] {
  const files = record(inventory) ? inventory.files : undefined;
  if (!Array.isArray(files)) throw new Error("inventory files");
  return files.map((f: unknown) => {
    if (!record(f) || typeof f.tile !== "string" || typeof f.path !== "string" || typeof f.sha256 !== "string" || typeof f.bytes !== "number") throw new Error("inventory entry");
    return { tile: f.tile, path: f.path, sha256: f.sha256, bytes: f.bytes };
  });
}

interface Tile { header: GeoTiffHeader; read: ByteReader; sha256: string }
const opened: number[] = [];
const tiles = new Map<string, Tile>();
for (const f of inventoryFiles()) {
  const fd = openSync(new URL(f.path, DIR), "r");
  opened.push(fd);
  const read: ByteReader = (offset, length) => {
    const out = new Uint8Array(length);
    if (readSync(fd, out, 0, length, offset) !== length) throw new Error("short read");
    return out;
  };
  tiles.set(f.tile, { header: parseGeoTiffHeader(read, fstatSync(fd).size), read, sha256: f.sha256 });
}
afterAll(() => { for (const fd of opened) closeSync(fd); });

function tile(name: string): Tile {
  const t = tiles.get(name);
  if (!t) throw new Error(`tile ${name}`);
  return t;
}
/** Decodes a window of a real tile and its manifest entry (bounds are the window's own). */
function load(name: string, b: { south: number; west: number; north: number; east: number }, id = `worldcover-${name.toLowerCase()}`) {
  const t = tile(name), raster = readWindow(t.header, t.read, inflate, windowForBounds(t.header, b), id);
  const entry = {
    id, provider: "esa-worldcover", version: "2021-v200", license: "CC-BY-4.0", attribution: ATTRIBUTION, sha256: t.sha256, crs: "EPSG:4326",
    bounds: { south: raster.northDeg - raster.height * raster.pixelDeg, west: raster.westDeg, north: raster.northDeg, east: raster.westDeg + raster.width * raster.pixelDeg },
    synthetic: false,
  };
  return { raster, entry };
}
function majority(r: WorldCoverRaster): [number, number] {
  const counts = new Map<number, number>();
  for (const c of r.data) counts.set(c, (counts.get(c) ?? 0) + 1);
  const [code, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [NaN, 0];
  return [code, n / r.data.length];
}

describe("ESA WorldCover Israel tiles", () => {
  it("match the inventory hashes and the WorldCover georeferencing", () => {
    for (const f of inventoryFiles()) {
      const bytes = readFileSync(new URL(f.path, DIR));
      expect(bytes.length).toBe(f.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.sha256);
      const h = tile(f.tile).header, south = Number(f.tile.slice(1, 3)), west = Number(f.tile.slice(4, 7));
      expect(h).toMatchObject({ width: 36000, height: 36000, tileWidth: 1024, tileHeight: 1024, compression: 8, nodata: 0 });
      expect(h.pixelDeg).toBeCloseTo(1 / 12000, 15);
      // Tile names give the south-west corner; the tiepoint is the north-west corner.
      expect(h.northDeg).toBe(south + 3);
      expect(h.westDeg).toBe(west);
    }
  });

  it.each([
    ["Mediterranean off Tel Aviv", "N30E033", 32.10, 34.60, 80, "water"],
    ["Dead Sea", "N30E033", 31.50, 35.48, 80, "water"],
    ["Lake Kinneret", "N30E033", 32.82, 35.59, 80, "water"],
    ["Gulf of Eilat", "N27E033", 29.50, 34.93, 80, "water"],
    ["central Tel Aviv", "N30E033", 32.075, 34.78, 50, "built-up"],
    ["Makhtesh Ramon", "N30E033", 30.60, 34.80, 60, "bare-soil"],
    ["Jezreel Valley", "N30E033", 32.62, 35.30, 40, "cropland"],
    ["Hula Valley", "N33E033", 33.08, 35.61, 40, "cropland"],
  ] as const)("maps %s to its known land class", (_name, name, lat, lon, code, material) => {
    const d = 0.000625; // about 150 m square
    const { raster, entry } = load(name, { south: lat - d, west: lon - d, north: lat + d, east: lon + d });
    const [top, share] = majority(raster);
    expect(top).toBe(code);
    expect(share).toBeGreaterThanOrEqual(0.7);
    const map = new MaterialMap(classes, parseDataManifest({ schema: "mirage.thermal-data/1", datasets: [entry] }), { latDeg: lat, lonDeg: lon }, { worldcover: [raster] });
    const centre = raster.data[Math.floor(raster.height / 2) * raster.width + Math.floor(raster.width / 2)];
    const sample = map.sampleAt(raster.northDeg - (Math.floor(raster.height / 2) + 0.5) * raster.pixelDeg, raster.westDeg + (Math.floor(raster.width / 2) + 0.5) * raster.pixelDeg);
    expect(sample).toMatchObject({ source: "worldcover", synthetic: false, datasetId: entry.id, worldCoverClass: centre });
    if (centre === code) expect(sample.material).toBe(material);
    expect(map.attributions()).toEqual([ATTRIBUTION]);
  });

  it("joins the 30 N seam without a gap and labels uncovered points synthetic", () => {
    const b = { south: 29.999, west: 34.95, north: 30.001, east: 34.952 };
    const south = load("N27E033", b), north = load("N30E033", b);
    expect(south.raster.northDeg).toBeCloseTo(30, 12);
    expect(north.raster.northDeg - north.raster.height * north.raster.pixelDeg).toBeCloseTo(30, 12);
    const manifest = parseDataManifest({ schema: "mirage.thermal-data/1", datasets: [south.entry, north.entry] });
    const map = new MaterialMap(classes, manifest, { latDeg: 30, lonDeg: 34.951 }, { worldcover: [north.raster, south.raster] });
    const px = south.raster.pixelDeg, lon = 34.95 + 0.5 * px;
    // A point on the boundary belongs to the pixel to its south: row 0 of N27E033.
    expect(map.sampleAt(30, lon)).toMatchObject({ datasetId: south.entry.id, worldCoverClass: south.raster.data[0] });
    expect(map.sampleAt(30 + 0.5 * px, lon)).toMatchObject({ datasetId: north.entry.id, worldCoverClass: north.raster.data[(north.raster.height - 1) * north.raster.width] });
    expect(map.sampleAt(30.01, lon)).toMatchObject({ source: "synthetic", synthetic: true, datasetId: null });
  });

  it("keeps windows bounded and coverage restricted to Israel", () => {
    const h = tile("N30E033").header;
    expect(() => readWindow(h, tile("N30E033").read, inflate, { row: 0, col: 0, rows: 4097, cols: 4096 }, "x")).toThrow(`${MAX_WINDOW_PIXELS}`);
    expect(() => windowForBounds(h, { south: 40, west: 34, north: 41, east: 35 })).toThrow("does not intersect");
    expect(() => assertIsraelCoverage({ south: 32.0, west: 34.7, north: 32.2, east: 34.9 })).not.toThrow();
    expect(() => assertIsraelCoverage({ south: 30.0, west: 31.2, north: 30.1, east: 31.3 })).toThrow("Israel-only"); // Cairo
  });
});

/** Minimal classic little-endian tiled TIFF in the WorldCover profile, for decoder oracles. */
function tinyTiff(pixels: Uint8Array, size: number, tileSize: number, change: { compression?: number; predictor?: number; epsg?: number; bigTiff?: boolean; strip?: boolean } = {}): Uint8Array {
  const across = size / tileSize, chunks: Uint8Array[] = [];
  for (let tr = 0; tr < across; tr++) for (let tc = 0; tc < across; tc++) {
    const t = new Uint8Array(tileSize * tileSize);
    for (let r = 0; r < tileSize; r++) t.set(pixels.subarray((tr * tileSize + r) * size + tc * tileSize, (tr * tileSize + r) * size + (tc + 1) * tileSize), r * tileSize);
    chunks.push(new Uint8Array(deflateSync(t)));
  }
  const tags: [number, number, number[] | string][] = [
    [256, 3, [size]], [257, 3, [size]], [258, 3, [8]], [259, 3, [change.compression ?? 8]], [277, 3, [1]],
    [317, 3, [change.predictor ?? 1]], [322, 3, [tileSize]], [323, 3, [tileSize]],
    [324, 4, chunks.map(() => 0)], [325, 4, chunks.map((c) => c.length)], [339, 3, [1]],
    [33550, 12, [0.25, 0.25, 0]], [33922, 12, [0, 0, 0, 34.5, 32.0, 0]],
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, change.epsg ?? 4326]], [42113, 2, "0\0"],
  ];
  if (change.strip) tags.push([273, 4, [8]]);
  tags.sort((a, b) => a[0] - b[0]);
  const size4 = (t: number) => ({ 2: 1, 3: 2, 4: 4, 12: 8 })[t] ?? 0;
  let cursor = 8;
  const tileStart = cursor;
  for (const c of chunks) cursor += c.length;
  const external: { at: number; bytes: Uint8Array }[] = [];
  const values = tags.map(([tag, type, v]) => {
    const n = typeof v === "string" ? v.length : v.length, bytes = new Uint8Array(size4(type) * n), dv = new DataView(bytes.buffer);
    if (typeof v === "string") bytes.set(new TextEncoder().encode(v));
    else v.forEach((x, i) => type === 3 ? dv.setUint16(i * 2, x, true) : type === 4 ? dv.setUint32(i * 4, x, true) : dv.setFloat64(i * 8, x, true));
    if (tag === 324) { let o = tileStart; chunks.forEach((c, i) => { dv.setUint32(i * 4, o, true); o += c.length; }); }
    if (bytes.length > 4) { external.push({ at: cursor, bytes }); cursor += bytes.length; return { tag, type, n, inline: null, at: cursor - bytes.length }; }
    return { tag, type, n, inline: bytes, at: 0 };
  });
  const ifd = cursor, out = new Uint8Array(ifd + 2 + tags.length * 12 + 4), dv = new DataView(out.buffer);
  out.set([0x49, 0x49]); dv.setUint16(2, change.bigTiff ? 43 : 42, true); dv.setUint32(4, ifd, true);
  let o = tileStart; for (const c of chunks) { out.set(c, o); o += c.length; }
  for (const e of external) out.set(e.bytes, e.at);
  dv.setUint16(ifd, tags.length, true);
  values.forEach((v, i) => {
    const at = ifd + 2 + i * 12;
    dv.setUint16(at, v.tag, true); dv.setUint16(at + 2, v.type, true); dv.setUint32(at + 4, v.n, true);
    if (v.inline) out.set(v.inline, at + 8); else dv.setUint32(at + 8, v.at, true);
  });
  return out;
}

describe("windowed GeoTIFF decoder", () => {
  const SIZE = 64, TILE = 16;
  const pixels = new Uint8Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) pixels[r * SIZE + c] = (r * 7 + c * 13) % 251;
  const reader = (bytes: Uint8Array): ByteReader => (offset, length) => bytes.subarray(offset, offset + length);

  it("reassembles windows across internal tile boundaries exactly", () => {
    const file = tinyTiff(pixels, SIZE, TILE), h = parseGeoTiffHeader(reader(file), file.length);
    expect(h).toMatchObject({ width: SIZE, northDeg: 32, westDeg: 34.5, pixelDeg: 0.25, nodata: 0 });
    for (const w of [{ row: 0, col: 0, rows: SIZE, cols: SIZE }, { row: 13, col: 9, rows: 21, cols: 30 }, { row: 63, col: 63, rows: 1, cols: 1 }]) {
      const r = readWindow(h, reader(file), inflate, w, "t");
      for (let i = 0; i < w.rows; i++) for (let j = 0; j < w.cols; j++) expect(r.data[i * w.cols + j]).toBe(pixels[(w.row + i) * SIZE + w.col + j]);
      expect(r.northDeg).toBe(32 - w.row * 0.25);
      expect(r.westDeg).toBe(34.5 + w.col * 0.25);
    }
    expect(windowForBounds(h, { south: 31.6, west: 34.6, north: 31.9, east: 35.1 })).toEqual({ row: 0, col: 0, rows: 2, cols: 3 });
  });

  it.each([
    ["LZW compression", { compression: 5 }, "compression 5"],
    ["a horizontal predictor", { predictor: 2 }, "predictor"],
    ["a projected CRS", { epsg: 32636 }, "EPSG:4326"],
    ["BigTIFF", { bigTiff: true }, "BigTIFF"],
    ["a stripped layout", { strip: true }, "stripped"],
  ] as const)("rejects %s", (_label, change, message) => {
    const file = tinyTiff(pixels, SIZE, TILE, change);
    expect(() => parseGeoTiffHeader(reader(file), file.length)).toThrow(message);
  });
});
