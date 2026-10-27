// Synthetic multi-LOD 3D Tiles stress tileset for the TASK-073 render profile.
// Own work, CC0-1.0; it depicts no real terrain. Deterministic: the same
// arguments always produce byte-identical files (see manifest.json hashes).
//
// Quadtree of `--depth` levels over a `--size` metre square; every tile is a
// 65 x 65 heightfield (positions, normals, vertex colours, uint16 indices) in
// glTF y-up local coordinates under one ENU-to-ECEF root transform, exactly
// as tests/fixtures/tiles/generate.py. Heights are a fixed sum of sines that
// blends to a 0 m plateau within PLATEAU_M of the origin (physics ground is
// flat at the origin), so the demo vehicle never sits inside a hill.
//
// Usage: node scripts/generate-render-tileset.mjs [--out DIR] [--depth 4] [--size 8000] [--origin LAT,LON,H]
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
const out = option("out", ".cache/render-tiles");
const depth = Number(option("depth", "4")), sizeM = Number(option("size", "8000"));
if (!Number.isInteger(depth) || depth < 1 || depth > 6 || !Number.isFinite(sizeM) || sizeM < 500 || sizeM > 50000) throw new Error("Invalid --depth or --size");

// --origin latDeg,lonDeg,ellipsoidalHeightM places the tileset (default: the CC0 fixture origin).
const [originLat, originLon, originHeight] = option("origin", "47.3769,8.5417,400").split(",").map(Number);
if (![originLat, originLon, originHeight].every(Number.isFinite) || Math.abs(originLat) > 90 || Math.abs(originLon) > 180 || Math.abs(originHeight) > 10000) throw new Error("Invalid --origin");
export const ORIGIN = Object.freeze({ latDeg: originLat, lonDeg: originLon, heightM: originHeight });
export const ATTRIBUTION = "MirageSITL synthetic render stress tiles (CC0-1.0)";
const GRID = 65; // vertices per tile edge: 4225 vertices fit uint16 indices
const PLATEAU_M = 250, BLEND_M = 400;
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F);

function ecef(lat, lon, h) {
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [(n + h) * Math.cos(lat) * Math.cos(lon), (n + h) * Math.cos(lat) * Math.sin(lon), (n * (1 - E2) + h) * Math.sin(lat)];
}
function rootTransform() {
  const lat = ORIGIN.latDeg * Math.PI / 180, lon = ORIGIN.lonDeg * Math.PI / 180;
  const o = ecef(lat, lon, ORIGIN.heightM);
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  return [...east, 0, ...north, 0, ...up, 0, ...o, 1]; // column-major 4x4
}

/** Height above the origin plane, m, at local (east, north). */
export function heightM(e, n) {
  const ridge = 60 * Math.sin(e / 900) * Math.cos(n / 1100) + 25 * Math.sin((e + n) / 370) + 8 * Math.sin(e / 97) * Math.sin(n / 131);
  const r = Math.hypot(e, n);
  const w = r <= PLATEAU_M ? 0 : r >= PLATEAU_M + BLEND_M ? 1 : (r - PLATEAU_M) / BLEND_M;
  return (w * w * (3 - 2 * w)) * (ridge + 93); // smoothstep blend; +93 keeps the far field >= 0
}

function colour(h) {
  // Height ramp: grass -> rock -> snow (display only; thermal uses its own model).
  const t = Math.min(1, Math.max(0, h / 190));
  return t < 0.6 ? [0.18 + 0.3 * t, 0.36 + 0.1 * t, 0.16 + 0.1 * t] : [0.5 + 0.4 * (t - 0.6) / 0.4, 0.47 + 0.4 * (t - 0.6) / 0.4, 0.42 + 0.5 * (t - 0.6) / 0.4];
}

/** One tile's GLB: centre (ce, cn) and edge length s, all in local ENU metres. */
function tileGlb(ce, cn, s) {
  const count = GRID * GRID, step = s / (GRID - 1);
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), col = new Float32Array(count * 3);
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const e = ce - s / 2 + i * step, n = cn - s / 2 + j * step, h = heightM(e, n), k = 3 * (j * GRID + i);
    pos[k] = e; pos[k + 1] = h; pos[k + 2] = -n; // glTF: x east, y up, z = -north (float32 is mm-exact over 8 km)
    const dx = (heightM(e + 1, n) - heightM(e - 1, n)) / 2, dn = (heightM(e, n + 1) - heightM(e, n - 1)) / 2;
    const len = Math.hypot(dx, 1, dn);
    nrm[k] = -dx / len; nrm[k + 1] = 1 / len; nrm[k + 2] = dn / len;
    const c = colour(h);
    col[k] = c[0]; col[k + 1] = c[1]; col[k + 2] = c[2];
    minY = Math.min(minY, h); maxY = Math.max(maxY, h);
  }
  const idx = new Uint16Array((GRID - 1) * (GRID - 1) * 6);
  let w = 0;
  for (let j = 0; j < GRID - 1; j++) for (let i = 0; i < GRID - 1; i++) {
    const a = j * GRID + i;
    // Counter-clockwise seen from above (+y): row j + 1 lies further north, i.e. at smaller glTF z.
    idx[w++] = a; idx[w++] = a + 1; idx[w++] = a + GRID; idx[w++] = a + 1; idx[w++] = a + GRID + 1; idx[w++] = a + GRID;
  }
  const views = [pos, nrm, col, idx].map(a => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  let offset = 0;
  const bufferViews = views.map((v, i) => { const view = { buffer: 0, byteOffset: offset, byteLength: v.length, target: i === 3 ? 34963 : 34962 }; offset += v.length; return view; });
  const half = s / 2;
  const gltf = {
    asset: { version: "2.0", generator: "MirageSITL scripts/generate-render-tileset.mjs", copyright: "CC0-1.0 MirageSITL synthetic render stress tile" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: "VEC3", min: [ce - half, minY, -(cn + half)], max: [ce + half, maxY, -(cn - half)] },
      { bufferView: 1, componentType: 5126, count, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count, type: "VEC3" },
      { bufferView: 3, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
    bufferViews, buffers: [{ byteLength: offset }],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const bin = Buffer.concat(views);
  const binPadded = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binPadded.length, 8);
  jsonHeader.writeUInt32LE(json.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(binPadded.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return { bytes: Buffer.concat([header, jsonHeader, json, binHeader, binPadded]), minY, maxY };
}

const files = [];
function emit(name, bytes) {
  writeFileSync(join(out, name), bytes);
  files.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}

/** Writes the tile and its children; returns the 3D Tiles node. */
function node(level, ce, cn, s, path) {
  const name = `t${path || "r"}.glb`;
  const { bytes, minY, maxY } = tileGlb(ce, cn, s);
  emit(name, bytes);
  const leaf = level === depth;
  const halfH = Math.max(0.5, (maxY - minY) / 2), midH = (maxY + minY) / 2;
  const result = {
    // box: centre, then x/y/z half-axes in tile (ENU, z-up) coordinates
    boundingVolume: { box: [ce, cn, midH, s / 2, 0, 0, 0, s / 2, 0, 0, 0, halfH] },
    geometricError: leaf ? 0 : 2 * s / (GRID - 1), // twice this tile's vertex spacing
    refine: "REPLACE",
    content: { uri: name },
  };
  if (!leaf) {
    const q = s / 4;
    result.children = [[-q, -q, "0"], [q, -q, "1"], [-q, q, "2"], [q, q, "3"]].map(([de, dn, k]) => node(level + 1, ce + de, cn + dn, s / 2, path + k));
  }
  return result;
}

mkdirSync(out, { recursive: true });
const root = node(0, 0, 0, sizeM, "");
const tileset = {
  asset: { version: "1.1", generator: "MirageSITL scripts/generate-render-tileset.mjs", extras: { license: "CC0-1.0", attribution: ATTRIBUTION, origin: ORIGIN, synthetic: true } },
  geometricError: 4 * sizeM / (GRID - 1),
  root: { ...root, transform: rootTransform() },
};
emit("tileset.json", Buffer.from(JSON.stringify(tileset, null, 1) + "\n"));
const manifest = { schemaVersion: 1, kind: "render-stress-tileset", synthetic: true, license: "CC0-1.0", attribution: ATTRIBUTION, origin: ORIGIN, depth, sizeM, grid: GRID,
  tiles: files.length - 1, totalBytes: files.reduce((a, f) => a + f.bytes, 0),
  tilesetSha256: files.at(-1).sha256, contentSha256: createHash("sha256").update(files.map(f => `${f.name}:${f.sha256}`).join("\n")).digest("hex") };
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ out, tiles: manifest.tiles, totalBytes: manifest.totalBytes, contentSha256: manifest.contentSha256 }));
