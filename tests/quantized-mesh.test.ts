import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { QUANTIZED_MAX, TileSurface, decodeQuantizedMesh, tileAt, tileBounds } from '../packages/terrain/src/quantized-mesh.ts';

// TASK-186: the quantized-mesh decoder against tiles the independent quantized-mesh-encoder package wrote from a tilted plane of
// known heights (tests/fixtures/terrain-qm-slope/generate.py). Declared before the implementation: decoded vertices lie within one
// quantization step of the encoder's positions; a point inside a triangle is the plane through its three decoded vertices within
// 1e-9 m; a point outside every triangle, or outside the tile, is missing. Found while testing: the encoder holds longitude and
// latitude in float32 before it quantizes them, which moves a vertex by up to half a float32 step (2^-19 degrees between 32 and 64
// degrees, about six quantization steps of a level-14 tile); the heights it encodes are those of the unmoved positions. Against the
// tilted plane the budget is therefore one height step plus the slope times one quantization step and half a float32 step.
const DIR = new URL('./fixtures/terrain-qm-slope/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('terrain-manifest.json', DIR), 'utf8')) as { plane: { baseM: number; lat0Deg: number; lon0Deg: number; metresPerDegLon: number; metresPerDegLat: number } };
const plane = (lon: number, lat: number) => manifest.plane.baseM + manifest.plane.metresPerDegLon * (lon - manifest.plane.lon0Deg) + manifest.plane.metresPerDegLat * (lat - manifest.plane.lat0Deg);
const TILES = [[19556, 11121], [19556, 11122], [19557, 11121], [19557, 11122]] as const, Z = 14;
const tileBytes = (x: number, y: number) => new Uint8Array(readFileSync(new URL(`${Z}/${x}/${y}.terrain`, DIR)));
/** Half a float32 step at a value between 32 and 64. */
const HALF_FLOAT32_DEG = 2 ** -19;
/** How far the plane through decoded vertices may be from the generator's plane, m. */
const planeBudget = (minHeightM: number, maxHeightM: number, b: ReturnType<typeof tileBounds>) =>
  (maxHeightM - minHeightM) / QUANTIZED_MAX + Math.abs(manifest.plane.metresPerDegLon) * ((b.east - b.west) / QUANTIZED_MAX + HALF_FLOAT32_DEG)
  + Math.abs(manifest.plane.metresPerDegLat) * ((b.north - b.south) / QUANTIZED_MAX + HALF_FLOAT32_DEG) + 1e-9;
/** A deterministic sequence in [0, 1). */
function* uniform(seed: number): Generator<number> { let s = seed >>> 0; for (;;) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; yield s / 2 ** 32; } }

describe('quantized-mesh tiles (TASK-186)', () => {
  test.each(TILES)('tile %i/%i decodes to the encoder\'s vertices within their quantization and float32 steps', (x, y) => {
    const tile = decodeQuantizedMesh(tileBytes(x, y)), b = tileBounds(x, y, Z);
    expect(tile.u.length).toBe(13 * 13);
    expect(tile.indices.length).toBe(12 * 12 * 2 * 3);
    const bound = planeBudget(tile.minHeightM, tile.maxHeightM, b);
    let worst = 0;
    for (let i = 0; i < tile.u.length; i++) {
      const lon = b.west + (tile.u[i] ?? 0) / QUANTIZED_MAX * (b.east - b.west), lat = b.south + (tile.v[i] ?? 0) / QUANTIZED_MAX * (b.north - b.south);
      worst = Math.max(worst, Math.abs((tile.heightsM[i] ?? NaN) - plane(lon, lat)));
    }
    expect(worst).toBeLessThanOrEqual(bound);
    expect(tile.minHeightM).toBeLessThan(tile.maxHeightM);
  });
  test('a point inside a triangle is the plane through its decoded vertices, and anywhere the tilted plane within the quantization', () => {
    for (const [x, y] of TILES) {
      const tile = decodeQuantizedMesh(tileBytes(x, y)), surface = new TileSurface(tile, x, y, Z), b = tileBounds(x, y, Z), random = uniform(x * 31 + y);
      let worstPlane = 0, worstTriangle = 0;
      for (let k = 0; k < 2000; k++) {
        const lon = b.west + (random.next().value ?? 0) * (b.east - b.west), lat = b.south + (random.next().value ?? 0) * (b.north - b.south);
        const h = surface.heightAt(lon, lat);
        expect(Number.isFinite(h)).toBe(true);
        // Brute force over every triangle: the one that holds the point, and the plane of its three decoded vertices.
        const uq = (lon - b.west) / (b.east - b.west) * QUANTIZED_MAX, vq = (lat - b.south) / (b.north - b.south) * QUANTIZED_MAX;
        let expected = NaN;
        for (let t = 0; t < tile.indices.length / 3 && Number.isNaN(expected); t++) {
          const [a, c, d] = [tile.indices[3 * t] ?? 0, tile.indices[3 * t + 1] ?? 0, tile.indices[3 * t + 2] ?? 0];
          const p = [tile.u[a] ?? 0, tile.v[a] ?? 0, tile.heightsM[a] ?? 0], q = [tile.u[c] ?? 0, tile.v[c] ?? 0, tile.heightsM[c] ?? 0], r = [tile.u[d] ?? 0, tile.v[d] ?? 0, tile.heightsM[d] ?? 0];
          const det = ((q[0] ?? 0) - (p[0] ?? 0)) * ((r[1] ?? 0) - (p[1] ?? 0)) - ((q[1] ?? 0) - (p[1] ?? 0)) * ((r[0] ?? 0) - (p[0] ?? 0));
          const s1 = ((uq - (p[0] ?? 0)) * ((r[1] ?? 0) - (p[1] ?? 0)) - (vq - (p[1] ?? 0)) * ((r[0] ?? 0) - (p[0] ?? 0))) / det;
          const s2 = (((q[0] ?? 0) - (p[0] ?? 0)) * (vq - (p[1] ?? 0)) - ((q[1] ?? 0) - (p[1] ?? 0)) * (uq - (p[0] ?? 0))) / det;
          if (s1 >= 0 && s2 >= 0 && s1 + s2 <= 1) expected = (p[2] ?? 0) + s1 * ((q[2] ?? 0) - (p[2] ?? 0)) + s2 * ((r[2] ?? 0) - (p[2] ?? 0));
        }
        worstTriangle = Math.max(worstTriangle, Math.abs(h - expected));
        worstPlane = Math.max(worstPlane, Math.abs(h - plane(lon, lat)));
      }
      expect(worstTriangle).toBeLessThan(1e-9);
      expect(worstPlane).toBeLessThanOrEqual(planeBudget(tile.minHeightM, tile.maxHeightM, b));
    }
  });
  test('is missing outside its tile, and refuses bytes that are not a whole tile', () => {
    const [x, y] = TILES[0], surface = new TileSurface(decodeQuantizedMesh(tileBytes(x, y)), x, y, Z), b = tileBounds(x, y, Z);
    expect(surface.heightAt(b.east + 1e-6, b.south + 1e-6)).toBeNaN();
    expect(surface.heightAt(b.west, b.north + 1e-6)).toBeNaN();
    // The four corners are vertices of the fixture's grid.
    expect(Number.isFinite(surface.heightAt(b.west, b.south))).toBe(true);
    const bytes = tileBytes(x, y);
    expect(() => decodeQuantizedMesh(bytes.slice(0, 60))).toThrow('header');
    expect(() => decodeQuantizedMesh(bytes.slice(0, 200))).toThrow('vertex data');
    const bad = bytes.slice();
    // A first code of 1 decodes to index 65535 (0 - 1 modulo 2^16), beyond the tile's 169 vertices.
    const view = new DataView(bad.buffer), count = view.getUint32(88, true), first = 88 + 4 + 6 * count + 4;
    view.setUint16(first, 1, true);
    expect(() => decodeQuantizedMesh(bad)).toThrow('triangle index');
  });
  test('reads 32-bit indices after their alignment, as a tile of more than 65536 vertices has them', () => {
    // A tile written here in the format's layout: 65537 vertices, two triangles; 6 * 65537 bytes of vertex data end on an odd half-word.
    const n = 65537, triangles = [0, 1, 2, 0, 2, 3];
    const vertexEnd = 88 + 4 + 6 * n, aligned = vertexEnd + ((4 - (vertexEnd % 4)) % 4);
    const bytes = new Uint8Array(aligned + 4 + 4 * triangles.length), view = new DataView(bytes.buffer);
    view.setFloat32(24, 10, true); view.setFloat32(28, 20, true); view.setUint32(88, n, true);
    const zz = (value: number) => (value << 1) ^ (value >> 31);
    const u = [0, QUANTIZED_MAX, QUANTIZED_MAX, 0], v = [0, 0, QUANTIZED_MAX, QUANTIZED_MAX], h = [0, QUANTIZED_MAX, QUANTIZED_MAX, 0];
    let pu = 0, pv = 0, ph = 0;
    for (let i = 0; i < n; i++) {
      const cu = u[i] ?? 0, cv = v[i] ?? 0, ch = h[i] ?? 0;
      view.setUint16(92 + 2 * i, zz(cu - pu), true); view.setUint16(92 + 2 * (n + i), zz(cv - pv), true); view.setUint16(92 + 2 * (2 * n + i), zz(ch - ph), true);
      pu = cu; pv = cv; ph = ch;
    }
    view.setUint32(aligned, 2, true);
    let highest = 0;
    triangles.forEach((index, k) => { view.setUint32(aligned + 4 + 4 * k, highest - index, true); if (index === highest) highest++; });
    const tile = decodeQuantizedMesh(bytes);
    expect(Array.from(tile.indices)).toEqual(triangles);
    expect(tile.heightsM[1]).toBe(20);
    const surface = new TileSurface(tile, 0, 0, 0);
    // Height rises from 10 m on the west edge to 20 m on the east edge of the tile.
    expect(surface.heightAt(-90, -45)).toBeCloseTo(15, 9);
  });
  test('finds the tile of a point and its bounds', () => {
    const { x, y } = tileAt(34.87, 32.2, Z), b = tileBounds(x, y, Z);
    expect(34.87).toBeGreaterThanOrEqual(b.west); expect(34.87).toBeLessThan(b.east);
    expect(32.2).toBeGreaterThanOrEqual(b.south); expect(32.2).toBeLessThan(b.north);
    expect(tileAt(-180, -90, 0)).toEqual({ x: 0, y: 0 });
    expect(tileAt(180, 90, 0)).toEqual({ x: 1, y: 0 });
  });
});
