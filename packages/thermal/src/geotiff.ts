// Windowed GeoTIFF reader for ESA WorldCover 10 m tiles (TASK-069).
//
// A WorldCover v200 tile is a 36000 x 36000 single-band uint8 classic TIFF,
// tiled 1024 x 1024, DEFLATE-compressed without a predictor, georeferenced
// in EPSG:4326 with PixelIsArea, a 1/12000 deg pixel and a north-west tie
// point. Decoding a whole tile would need 1.3 GB, so this reader parses the
// first IFD once and then decodes only the internal tiles a requested window
// touches. Anything outside that exact profile is rejected rather than
// guessed: other compressions, predictors, sample formats, BigTIFF,
// projected CRSs and rotated/sheared transforms.
//
// I/O and decompression are injected: `read(offset, length)` returns file
// bytes (Node: fs.readSync; browser: File.slice) and `inflate` decompresses
// one zlib stream (Node: zlib.inflateSync). The module itself has no network
// or file-system code.
import type { WorldCoverRaster } from "./material-map.ts";

export type ByteReader = (offset: number, length: number) => Uint8Array;
export type Inflate = (compressed: Uint8Array) => Uint8Array;

export interface GeoTiffHeader {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  compression: 1 | 8;
  /** North edge latitude and west edge longitude of pixel (0, 0), degrees. */
  northDeg: number;
  westDeg: number;
  pixelDeg: number;
  nodata: number | null;
  tileOffsets: Float64Array;
  tileByteCounts: Float64Array;
}

export interface PixelWindow { row: number; col: number; rows: number; cols: number }

/** Largest window decoded at once: 4096 x 4096 pixels (about 41 x 41 km at 10 m). */
export const MAX_WINDOW_PIXELS = 4096 * 4096;
/** Upper bound on one compressed internal tile, bytes (uncompressed 1 MiB). */
const MAX_TILE_BYTES = 4 * 1024 * 1024;

const TAG = {
  width: 256, height: 257, bitsPerSample: 258, compression: 259, samplesPerPixel: 277,
  planar: 284, predictor: 317, tileWidth: 322, tileHeight: 323, tileOffsets: 324,
  tileByteCounts: 325, sampleFormat: 339, pixelScale: 33550, tiepoint: 33922,
  geoKeys: 34735, nodata: 42113, stripOffsets: 273,
} as const;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };

function fail(message: string): never {
  throw new Error(`Unsupported WorldCover GeoTIFF: ${message}`);
}

interface Entry { type: number; count: number; value: Uint8Array }

/** Parses the first IFD of a classic TIFF and checks the WorldCover profile. */
export function parseGeoTiffHeader(read: ByteReader, fileSize: number): GeoTiffHeader {
  if (!Number.isSafeInteger(fileSize) || fileSize < 8) fail("file too small");
  const head = read(0, 8);
  const little = head[0] === 0x49 && head[1] === 0x49;
  if (!little && !(head[0] === 0x4d && head[1] === 0x4d)) fail("not a TIFF");
  const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (bytes: Uint8Array, at: number) => view(bytes).getUint16(at, little);
  const u32 = (bytes: Uint8Array, at: number) => view(bytes).getUint32(at, little);
  if (u16(head, 2) !== 42) fail("BigTIFF or unknown version");
  const ifd = u32(head, 4);
  if (ifd + 2 > fileSize) fail("IFD outside file");
  const count = u16(read(ifd, 2), 0);
  if (count === 0 || count > 64) fail("IFD entry count");
  const table = read(ifd + 2, count * 12);
  const entries = new Map<number, Entry>();
  for (let i = 0; i < count; i++) {
    const at = i * 12, type = u16(table, at + 2), n = u32(table, at + 4);
    const size = (TYPE_SIZE[type] ?? 0) * n;
    if (size === 0) continue; // unused tag types (none required here)
    let value: Uint8Array;
    if (size <= 4) value = table.subarray(at + 8, at + 8 + size);
    else {
      const offset = u32(table, at + 8);
      if (offset + size > fileSize || size > 64 * 1024 * 1024) fail("tag data outside file");
      value = read(offset, size);
    }
    entries.set(u16(table, at), { type, count: n, value });
  }
  const numbers = (tag: number): number[] => {
    const e = entries.get(tag);
    if (!e) fail(`missing tag ${tag}`);
    const out: number[] = [], v = view(e.value);
    for (let i = 0; i < e.count; i++) {
      if (e.type === 3) out.push(v.getUint16(i * 2, little));
      else if (e.type === 4) out.push(v.getUint32(i * 4, little));
      else if (e.type === 12) out.push(v.getFloat64(i * 8, little));
      else if (e.type === 1) out.push(v.getUint8(i));
      else fail(`tag ${tag} type ${e.type}`);
    }
    return out;
  };
  const one = (tag: number, fallback?: number): number => {
    if (!entries.has(tag) && fallback !== undefined) return fallback;
    const [v, extra] = numbers(tag);
    if (v === undefined || extra !== undefined) fail(`tag ${tag} must be scalar`);
    return v;
  };
  if (entries.has(TAG.stripOffsets)) fail("stripped (not tiled) layout");
  const width = one(TAG.width), height = one(TAG.height);
  const tileWidth = one(TAG.tileWidth), tileHeight = one(TAG.tileHeight);
  if (one(TAG.bitsPerSample) !== 8 || one(TAG.samplesPerPixel, 1) !== 1 || one(TAG.sampleFormat, 1) !== 1) fail("not single-band uint8");
  if (one(TAG.planar, 1) !== 1 || one(TAG.predictor, 1) !== 1) fail("planar configuration or predictor");
  const compression = one(TAG.compression);
  if (compression !== 1 && compression !== 8) fail(`compression ${compression}`);
  if (width < 1 || height < 1 || tileWidth < 16 || tileHeight < 16 || tileWidth % 16 || tileHeight % 16) fail("dimensions");
  const tiles = Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight);
  const tileOffsets = Float64Array.from(numbers(TAG.tileOffsets));
  const tileByteCounts = Float64Array.from(numbers(TAG.tileByteCounts));
  if (tileOffsets.length !== tiles || tileByteCounts.length !== tiles) fail("tile table size");
  for (let i = 0; i < tiles; i++) {
    const o = tileOffsets[i] ?? NaN, n = tileByteCounts[i] ?? NaN; // i < tiles = length
    if (!(n > 0 && n <= MAX_TILE_BYTES && o + n <= fileSize)) fail(`tile ${i} outside file`);
  }
  const [sx, sy, sz] = numbers(TAG.pixelScale);
  const tie = numbers(TAG.tiepoint);
  if (sx === undefined || sy === undefined || sz === undefined || tie.length !== 6) fail("pixel scale or tiepoint");
  if (sx !== sy || !(sx > 0) || tie[0] !== 0 || tie[1] !== 0) fail("non-square pixel or tiepoint not at pixel (0, 0)");
  // GeoKeyDirectory: header [1, 1, 0, n] then (key, location, count, value) quadruples.
  const keys = numbers(TAG.geoKeys), key = new Map<number, number>();
  if (keys[0] !== 1 || keys.length !== 4 + 4 * (keys[3] ?? -1)) fail("GeoKeyDirectory");
  for (let i = 4; i + 3 < keys.length; i += 4) if (keys[i + 1] === 0) key.set(keys[i] ?? -1, keys[i + 3] ?? -1);
  // GTModelType 2 = geographic, GTRasterType 1 = PixelIsArea, GeographicType 4326 = WGS 84.
  if (key.get(1024) !== 2 || key.get(1025) !== 1 || key.get(2048) !== 4326) fail("not EPSG:4326 PixelIsArea");
  const nodataEntry = entries.get(TAG.nodata);
  let nodata: number | null = null;
  if (nodataEntry) {
    const text = new TextDecoder("ascii").decode(nodataEntry.value).replace(/\0+$/, "").trim();
    if (!/^\d{1,3}$/.test(text) || Number(text) > 255) fail("GDAL_NODATA");
    nodata = Number(text);
  }
  return {
    width, height, tileWidth, tileHeight, compression,
    northDeg: tie[4] ?? NaN, westDeg: tie[3] ?? NaN, pixelDeg: sx, nodata, tileOffsets, tileByteCounts,
  };
}

/** Pixel window covering a geographic box: outward to whole pixels, clamped to the raster. */
export function windowForBounds(h: GeoTiffHeader, b: { south: number; west: number; north: number; east: number }): PixelWindow {
  if (!(b.south < b.north && b.west < b.east)) throw new Error("Invalid window bounds");
  const eps = 1e-9;
  const row0 = Math.max(0, Math.floor((h.northDeg - b.north) / h.pixelDeg + eps));
  const row1 = Math.min(h.height, Math.ceil((h.northDeg - b.south) / h.pixelDeg - eps));
  const col0 = Math.max(0, Math.floor((b.west - h.westDeg) / h.pixelDeg + eps));
  const col1 = Math.min(h.width, Math.ceil((b.east - h.westDeg) / h.pixelDeg - eps));
  if (row1 <= row0 || col1 <= col0) throw new Error("Window does not intersect the raster");
  return { row: row0, col: col0, rows: row1 - row0, cols: col1 - col0 };
}

/** Decodes a pixel window into a WorldCoverRaster (row 0 at the window's north edge). */
export function readWindow(h: GeoTiffHeader, read: ByteReader, inflate: Inflate, w: PixelWindow, datasetId: string): WorldCoverRaster {
  if (![w.row, w.col, w.rows, w.cols].every(Number.isSafeInteger) || w.rows < 1 || w.cols < 1 ||
    w.row < 0 || w.col < 0 || w.row + w.rows > h.height || w.col + w.cols > h.width) throw new Error("Window outside raster");
  if (w.rows * w.cols > MAX_WINDOW_PIXELS) throw new Error(`Window exceeds ${MAX_WINDOW_PIXELS} pixels`);
  const data = new Uint8Array(w.rows * w.cols);
  const across = Math.ceil(h.width / h.tileWidth), tileBytes = h.tileWidth * h.tileHeight;
  const tr0 = Math.floor(w.row / h.tileHeight), tr1 = Math.floor((w.row + w.rows - 1) / h.tileHeight);
  const tc0 = Math.floor(w.col / h.tileWidth), tc1 = Math.floor((w.col + w.cols - 1) / h.tileWidth);
  for (let tr = tr0; tr <= tr1; tr++) {
    for (let tc = tc0; tc <= tc1; tc++) {
      const index = tr * across + tc;
      const raw = read(h.tileOffsets[index] ?? NaN, h.tileByteCounts[index] ?? NaN); // index < tile count
      const tile = h.compression === 8 ? inflate(raw) : raw;
      if (tile.length !== tileBytes) fail(`tile ${index} decodes to ${tile.length} bytes`);
      // Copy the overlap of this tile with the window, row by row.
      const r0 = Math.max(w.row, tr * h.tileHeight), r1 = Math.min(w.row + w.rows, (tr + 1) * h.tileHeight);
      const c0 = Math.max(w.col, tc * h.tileWidth), c1 = Math.min(w.col + w.cols, (tc + 1) * h.tileWidth);
      for (let r = r0; r < r1; r++) {
        const src = (r - tr * h.tileHeight) * h.tileWidth + (c0 - tc * h.tileWidth);
        data.set(tile.subarray(src, src + (c1 - c0)), (r - w.row) * w.cols + (c0 - w.col));
      }
    }
  }
  return {
    datasetId,
    northDeg: h.northDeg - w.row * h.pixelDeg,
    westDeg: h.westDeg + w.col * h.pixelDeg,
    pixelDeg: h.pixelDeg,
    width: w.cols,
    height: w.rows,
    data,
  };
}

/**
 * Supported-coverage guard: the operator restricted WorldCover use to Israel.
 * This box (29.4-33.4 N, 34.2-35.95 E) encloses Israel with a margin, so a
 * window inside it may still include neighboring territory; a window outside
 * it is refused rather than treated as supported coverage.
 */
export const ISRAEL_COVERAGE_BOX = Object.freeze({ south: 29.4, west: 34.2, north: 33.4, east: 35.95 });
export function assertIsraelCoverage(b: { south: number; west: number; north: number; east: number }): void {
  const box = ISRAEL_COVERAGE_BOX;
  if (!(b.south >= box.south && b.north <= box.north && b.west >= box.west && b.east <= box.east))
    throw new Error("Requested region is outside the supported Israel-only WorldCover coverage");
}
