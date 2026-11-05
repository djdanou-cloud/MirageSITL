// Quantized-mesh-1.0 terrain tiles (TASK-186, SPECS_SIMULATION_ENGINES "Terrain source selection: TASK-186"), as the TASK-073
// pipeline (scripts/geodata/build_terrain.py) writes them: an 88-byte header, zig-zag delta-coded u, v and height arrays, and
// high-water-mark coded triangle indices. Heights are WGS84 ellipsoidal. A point of a tile is the triangle that contains it,
// interpolated barycentrically; a point outside every triangle is missing (NaN), never zero. Cold path: tiles are decoded when a
// run's terrain is built, never in a physics step.

/** The largest quantized coordinate: u, v and height run over 0..32767. */
export const QUANTIZED_MAX = 32767;
const HEADER_BYTES = 88;

export interface QuantizedMeshTile {
  readonly minHeightM: number;
  readonly maxHeightM: number;
  /** Quantized positions, 0..32767: u east across the tile, v north. */
  readonly u: Uint16Array;
  readonly v: Uint16Array;
  /** Ellipsoidal heights of the vertices, m. */
  readonly heightsM: Float64Array;
  /** Three vertex indices per triangle. */
  readonly indices: Uint32Array;
}

const zigzag = (value: number): number => (value >> 1) ^ -(value & 1);

/** Decodes one tile, or throws for bytes that are not a whole quantized-mesh-1.0 tile. */
export function decodeQuantizedMesh(bytes: Uint8Array): QuantizedMeshTile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (end: number, what: string) => { if (end > bytes.byteLength) throw new Error(`The quantized-mesh tile ends inside its ${what}`); };
  need(HEADER_BYTES + 4, "header");
  const minHeightM = view.getFloat32(24, true), maxHeightM = view.getFloat32(28, true);
  if (!Number.isFinite(minHeightM) || !Number.isFinite(maxHeightM) || maxHeightM < minHeightM) throw new Error("The quantized-mesh tile has an invalid height range");
  let offset = HEADER_BYTES;
  const vertexCount = view.getUint32(offset, true); offset += 4;
  if (vertexCount < 3) throw new Error("The quantized-mesh tile has fewer than three vertices");
  need(offset + 6 * vertexCount, "vertex data");
  const u = new Uint16Array(vertexCount), v = new Uint16Array(vertexCount), heightsM = new Float64Array(vertexCount);
  let uu = 0, vv = 0, hh = 0;
  const scale = (maxHeightM - minHeightM) / QUANTIZED_MAX;
  for (let i = 0; i < vertexCount; i++) {
    uu += zigzag(view.getUint16(offset + 2 * i, true));
    vv += zigzag(view.getUint16(offset + 2 * (vertexCount + i), true));
    hh += zigzag(view.getUint16(offset + 2 * (2 * vertexCount + i), true));
    if (uu < 0 || uu > QUANTIZED_MAX || vv < 0 || vv > QUANTIZED_MAX || hh < 0 || hh > QUANTIZED_MAX) throw new Error("The quantized-mesh tile has a vertex outside 0..32767");
    u[i] = uu; v[i] = vv; heightsM[i] = minHeightM + hh * scale;
  }
  offset += 6 * vertexCount;
  const wide = vertexCount > 65536;
  if (wide && offset % 4 !== 0) offset += 4 - (offset % 4);
  need(offset + 4, "triangle count");
  const triangleCount = view.getUint32(offset, true); offset += 4;
  const size = wide ? 4 : 2;
  need(offset + 3 * triangleCount * size, "triangle indices");
  const indices = new Uint32Array(3 * triangleCount);
  let highest = 0;
  for (let i = 0; i < indices.length; i++) {
    const code = wide ? view.getUint32(offset + 4 * i, true) : view.getUint16(offset + 2 * i, true);
    // Modulo the index width, as Cesium's decoder stores it in a typed array: encoders such as quantized-mesh-encoder and the
    // TASK-073 pipeline keep the vertices in their own order, so `highest - index` wraps below zero for an earlier vertex.
    const index = wide ? (highest - code) >>> 0 : (highest - code) & 0xffff;
    if (index >= vertexCount) throw new Error("The quantized-mesh tile has a triangle index outside its vertices");
    indices[i] = index;
    if (code === 0) highest++;
  }
  return { minHeightM, maxHeightM, u, v, heightsM, indices };
}

/** EPSG:4326 TMS bounds of tile (x, y) at level z, degrees: level z has 2^(z+1) by 2^z tiles, y counted from the south. */
export function tileBounds(x: number, y: number, z: number): { readonly west: number; readonly south: number; readonly east: number; readonly north: number } {
  const size = 180 / 2 ** z;
  return { west: -180 + x * size, south: -90 + y * size, east: -180 + (x + 1) * size, north: -90 + (y + 1) * size };
}
/** The tile of level z that holds a point, as TMS indices. */
export function tileAt(lonDeg: number, latDeg: number, z: number): { readonly x: number; readonly y: number } {
  const size = 180 / 2 ** z, columns = 2 ** (z + 1), rows = 2 ** z;
  return { x: Math.min(columns - 1, Math.max(0, Math.floor((lonDeg + 180) / size))), y: Math.min(rows - 1, Math.max(0, Math.floor((latDeg + 90) / size))) };
}

/** Points of one tile: triangles found through a uniform grid over the quantized square. */
export class TileSurface {
  private readonly cells: Uint32Array[];
  private readonly grid: number;
  private readonly bounds: ReturnType<typeof tileBounds>;
  constructor(readonly tile: QuantizedMeshTile, x: number, y: number, z: number, grid = 32) {
    this.bounds = tileBounds(x, y, z);
    this.grid = grid;
    const lists: number[][] = Array.from({ length: grid * grid }, () => []);
    const { u, v, indices } = tile, cell = (QUANTIZED_MAX + 1) / grid;
    for (let t = 0; t < indices.length / 3; t++) {
      const a = indices[3 * t] ?? 0, b = indices[3 * t + 1] ?? 0, c = indices[3 * t + 2] ?? 0;
      const ua = u[a] ?? 0, ub = u[b] ?? 0, uc = u[c] ?? 0, va = v[a] ?? 0, vb = v[b] ?? 0, vc = v[c] ?? 0;
      const c0 = Math.floor(Math.min(ua, ub, uc) / cell), c1 = Math.min(grid - 1, Math.floor(Math.max(ua, ub, uc) / cell));
      const r0 = Math.floor(Math.min(va, vb, vc) / cell), r1 = Math.min(grid - 1, Math.floor(Math.max(va, vb, vc) / cell));
      for (let r = r0; r <= r1; r++) for (let k = c0; k <= c1; k++) lists[r * grid + k]?.push(t);
    }
    this.cells = lists.map(list => Uint32Array.from(list));
  }
  /** The ellipsoidal height at a point of the tile, m, or NaN when no triangle holds it. */
  heightAt(lonDeg: number, latDeg: number): number {
    const { west, south, east, north } = this.bounds;
    const uq = (lonDeg - west) / (east - west) * QUANTIZED_MAX, vq = (latDeg - south) / (north - south) * QUANTIZED_MAX;
    if (!(uq >= 0 && uq <= QUANTIZED_MAX && vq >= 0 && vq <= QUANTIZED_MAX)) return Number.NaN;
    const cell = (QUANTIZED_MAX + 1) / this.grid;
    const list = this.cells[Math.min(this.grid - 1, Math.floor(vq / cell)) * this.grid + Math.min(this.grid - 1, Math.floor(uq / cell))];
    if (!list) return Number.NaN;
    const { u, v, heightsM, indices } = this.tile;
    // A point on a shared edge belongs to either triangle; a small tolerance keeps it from falling between them.
    const tolerance = -1e-9;
    for (const t of list) {
      const a = indices[3 * t] ?? 0, b = indices[3 * t + 1] ?? 0, c = indices[3 * t + 2] ?? 0;
      const ax = u[a] ?? 0, ay = v[a] ?? 0, bx = u[b] ?? 0, by = v[b] ?? 0, cx = u[c] ?? 0, cy = v[c] ?? 0;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area === 0) continue;
      const wb = ((uq - ax) * (cy - ay) - (vq - ay) * (cx - ax)) / area, wc = ((bx - ax) * (vq - ay) - (by - ay) * (uq - ax)) / area, wa = 1 - wb - wc;
      if (wa >= tolerance && wb >= tolerance && wc >= tolerance) return wa * (heightsM[a] ?? 0) + wb * (heightsM[b] ?? 0) + wc * (heightsM[c] ?? 0);
    }
    return Number.NaN;
  }
}
