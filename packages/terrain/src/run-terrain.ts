import type { HeightTile } from "./collision-build.ts";
import { tileAvailable, type QuantizedLayer } from "./coverage.ts";
import { TileSurface, decodeQuantizedMesh, tileAt } from "./quantized-mesh.ts";

// The collision lattice of a real-terrain run (TASK-186, SPECS_SIMULATION_ENGINES "Terrain source selection: TASK-186"): chunks of
// 129 by 129 posts 4 m apart, north and east from the home, with down = -(h - h_home) from the deepest tile level available at each
// post. A chunk with any post outside the terrain's bounding box, on a tile that is not served, or between triangles is not built:
// that ground is missing, and a run that reaches it pauses. Built on Main before a run; cold path.

export const RUN_TERRAIN_EPOCH = 1;
export const RUN_CHUNK_RESOLUTION = 129, RUN_CHUNK_SPACING_M = 4, RUN_CHUNK_SPAN_M = (RUN_CHUNK_RESOLUTION - 1) * RUN_CHUNK_SPACING_M;
/** The radius around the home a run loads, m. */
export const MIN_RUN_RADIUS_M = 256, MAX_RUN_RADIUS_M = 1500, DEFAULT_RUN_RADIUS_M = 1000;
/** WGS84 semi-major axis and first eccentricity squared (NIMA TR8350.2 Table 3.1). */
const A_M = 6378137, E2 = 6.69437999014e-3;

export interface RunTerrainInput {
  readonly layer: QuantizedLayer;
  readonly bbox: readonly [number, number, number, number];
  /** The bytes of a tile, or null when it is not served. */
  readonly fetchTile: (z: number, x: number, y: number) => Promise<Uint8Array | null>;
  readonly home: { readonly latitudeDeg: number; readonly longitudeDeg: number; readonly ellipsoidalHeightM: number };
  readonly radiusM: number;
}
export interface MissingChunk { readonly northIndex: number; readonly eastIndex: number; readonly reason: string }
export interface RunTerrain {
  readonly tiles: HeightTile[];
  readonly missing: MissingChunk[];
  /** The terrain's ellipsoidal height at the home, m, or NaN where it is missing. */
  readonly homeHeightM: number;
  /** The deepest level read. */
  readonly level: number;
}

/** Degrees per metre north and east at a latitude, on the WGS84 ellipsoid's local tangent plane. */
export function degreesPerMetre(latitudeDeg: number): { readonly north: number; readonly east: number } {
  const phi = latitudeDeg * Math.PI / 180, s = Math.sin(phi), w = 1 - E2 * s * s;
  const meridian = A_M * (1 - E2) / (w * Math.sqrt(w)), normal = A_M / Math.sqrt(w);
  return { north: 180 / (Math.PI * meridian), east: 180 / (Math.PI * normal * Math.cos(phi)) };
}

/** The chunk indices a radius around the home covers, along one axis. */
export const chunkRange = (radiusM: number): readonly [number, number] => [Math.floor(-radiusM / RUN_CHUNK_SPAN_M), Math.floor((radiusM - 1e-9) / RUN_CHUNK_SPAN_M)];

/** Heights of the deepest available tile at a point, decoding each tile once. */
class SurfaceReader {
  private readonly surfaces = new Map<string, Promise<TileSurface | null>>();
  deepest = -1;
  constructor(private readonly layer: QuantizedLayer, private readonly bbox: readonly [number, number, number, number],
    private readonly fetchTile: RunTerrainInput["fetchTile"]) {}
  /** The ellipsoidal height at a point, m, or the reason it is missing. */
  async heightAt(lonDeg: number, latDeg: number): Promise<number | string> {
    const [west, south, east, north] = this.bbox;
    if (!(latDeg >= south && latDeg <= north && lonDeg >= west && lonDeg <= east)) return "outside the terrain's coverage";
    const surface = this.surfaceAt(lonDeg, latDeg);
    if (!surface) return "no tile of the layer holds it";
    const tile = await surface;
    if (!tile) return "its tile is not served";
    const h = tile.heightAt(lonDeg, latDeg);
    return Number.isFinite(h) ? h : "no triangle of its tile holds it";
  }
  private surfaceAt(lonDeg: number, latDeg: number): Promise<TileSurface | null> | null {
    const { layer, surfaces } = this;
    for (let z = layer.maxzoom; z >= layer.minzoom; z--) {
      const { x, y } = tileAt(lonDeg, latDeg, z);
      if (!tileAvailable(layer, x, y, z)) continue;
      const key = `${z}/${x}/${y}`;
      let found = surfaces.get(key);
      if (!found) {
        found = this.fetchTile(z, x, y).then(bytes => (bytes ? new TileSurface(decodeQuantizedMesh(bytes), x, y, z) : null));
        surfaces.set(key, found);
      }
      this.deepest = Math.max(this.deepest, z);
      return found;
    }
    return null;
  }
}

/** The terrain's WGS84 ellipsoidal height at one point, m, or the reason it is missing (the Weather and location tab's elevation from terrain). */
export function terrainHeightAt(layer: QuantizedLayer, bbox: readonly [number, number, number, number], fetchTile: RunTerrainInput["fetchTile"],
  latitudeDeg: number, longitudeDeg: number): Promise<number | string> {
  return new SurfaceReader(layer, bbox, fetchTile).heightAt(longitudeDeg, latitudeDeg);
}

/**
 * SHA-256 of a lattice, as an experiment records it: per chunk, in north then east index order, its indices as int32 and its
 * posts' down as float64, little-endian.
 */
export async function latticeSha256(tiles: readonly Pick<HeightTile, "northIndex" | "eastIndex" | "downM">[]): Promise<string> {
  const ordered = [...tiles].sort((a, b) => a.northIndex - b.northIndex || a.eastIndex - b.eastIndex);
  const bytes = new Uint8Array(ordered.reduce((sum, tile) => sum + 8 + 8 * tile.downM.length, 0)), view = new DataView(bytes.buffer);
  let offset = 0;
  for (const tile of ordered) {
    view.setInt32(offset, tile.northIndex, true); view.setInt32(offset + 4, tile.eastIndex, true); offset += 8;
    for (const down of tile.downM) { view.setFloat64(offset, down, true); offset += 8; }
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildRunTerrain(input: RunTerrainInput): Promise<RunTerrain> {
  const { layer, bbox, home } = input;
  if (!(input.radiusM >= MIN_RUN_RADIUS_M && input.radiusM <= MAX_RUN_RADIUS_M)) throw new Error(`The terrain radius must be ${MIN_RUN_RADIUS_M} m to ${MAX_RUN_RADIUS_M} m`);
  const per = degreesPerMetre(home.latitudeDeg), reader = new SurfaceReader(layer, bbox, input.fetchTile);
  /** The ellipsoidal height at a post north and east of the home, or the reason it is missing. */
  const heightAt = (northM: number, eastM: number): Promise<number | string> => reader.heightAt(home.longitudeDeg + eastM * per.east, home.latitudeDeg + northM * per.north);
  const [first, last] = chunkRange(input.radiusM), n = RUN_CHUNK_RESOLUTION;
  const tiles: HeightTile[] = [], missing: MissingChunk[] = [];
  for (let ni = first; ni <= last; ni++) {
    for (let ei = first; ei <= last; ei++) {
      const downM = new Float64Array(n * n);
      let reason: string | null = null;
      for (let r = 0; r < n && reason === null; r++) {
        for (let c = 0; c < n; c++) {
          const h = await heightAt(ni * RUN_CHUNK_SPAN_M + r * RUN_CHUNK_SPACING_M, ei * RUN_CHUNK_SPAN_M + c * RUN_CHUNK_SPACING_M);
          if (typeof h === "string") { reason = h; break; }
          downM[r * n + c] = -(h - home.ellipsoidalHeightM);
        }
      }
      if (reason !== null) missing.push({ northIndex: ni, eastIndex: ei, reason });
      else tiles.push({ version: 1, epoch: RUN_TERRAIN_EPOCH, revision: 0, resolution: n, spacingM: RUN_CHUNK_SPACING_M, northIndex: ni, eastIndex: ei, downM });
    }
  }
  const atHome = await heightAt(0, 0);
  return { tiles, missing, homeHeightM: typeof atHome === "number" ? atHome : Number.NaN, level: reader.deepest };
}
