// Terrain source records (TASK-186, SPECS_SIMULATION_ENGINES "Terrain source selection: TASK-186"): what each source of the TASK-131
// terrain inventory gives, where it covers, how detailed it is, and whether a run can use it now. Elevation a run can stand on is the
// `ground` layer; imagery, land cover and online photogrammetry are `imagery`, shown and never chosen as ground. FABDEM is ready only
// while its local output is served and covers the place; an adapter that needs keys or a deployment is never ready. Cold path.

export const TERRAIN_INVENTORY_READINESS = ["ready", "ready-not-wired", "needs-data", "needs-keys-or-deployment", "test-only"] as const;
export type InventoryReadiness = typeof TERRAIN_INVENTORY_READINESS[number];
export type TerrainLayer = "ground" | "imagery" | "other";
/** The inventory row of a source, as data/terrain/inventory.json holds it. */
export interface InventorySource {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly license: string;
  readonly licenseStatus: string;
  readonly coverage: string;
  readonly resolution: string;
  readonly readiness: InventoryReadiness;
  readonly decision: string | null;
  readonly offline: boolean;
}
export type Coverage = { readonly kind: "any" } | { readonly kind: "box"; readonly west: number; readonly south: number; readonly east: number; readonly north: number } | { readonly kind: "none" };
export interface TerrainSourceRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly layer: TerrainLayer;
  readonly coverage: Coverage;
  /** The inventory's own words for the coverage. */
  readonly coverageText: string;
  readonly resolution: string;
  readonly license: string;
  readonly licenseStatus: string;
  readonly readiness: "ready" | "not-ready";
  /** Why it is not ready, or null. */
  readonly reason: string | null;
  readonly offline: boolean;
}
/** The local FABDEM output a run can load: its layer and the bounding box its manifest states, or why there is none. */
export type LocalTerrain =
  | { readonly status: "served"; readonly layer: QuantizedLayer; readonly bbox: readonly [number, number, number, number]; readonly baseUrl: string }
  | { readonly status: "absent"; readonly reason: string };
/** A quantized-mesh layer.json: which tiles of which level exist. */
export interface QuantizedLayer {
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly tiles: string;
  /** Per level, the TMS index ranges that exist. */
  readonly available: readonly (readonly { readonly startX: number; readonly startY: number; readonly endX: number; readonly endY: number }[])[];
}

const fail = (message: string): never => { throw new Error(`Invalid terrain data: ${message}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, label: string): string => (typeof value === "string" && value.length > 0 && value.length <= 2000 ? value : fail(`${label} must be text`));
const finite = (value: unknown, label: string): number => (typeof value === "number" && Number.isFinite(value) ? value : fail(`${label} must be a finite number`));

/** The sources of the terrain inventory, checked as scripts/check-offline.mjs checks them. */
export function parseTerrainInventory(value: unknown): InventorySource[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.sources)) return fail("the inventory must be schema 1 with sources");
  const sources: readonly unknown[] = value.sources;
  return sources.map((row, index) => {
    if (!isRecord(row)) return fail(`sources[${index}] must be an object`);
    const readiness = row.readiness;
    if (typeof readiness !== "string" || !(TERRAIN_INVENTORY_READINESS as readonly string[]).includes(readiness)) return fail(`sources[${index}].readiness is unknown`);
    return {
      id: text(row.id, `sources[${index}].id`), name: text(row.name, `sources[${index}].name`), kind: text(row.kind, `sources[${index}].kind`),
      license: text(row.license, `sources[${index}].license`), licenseStatus: text(row.licenseStatus, `sources[${index}].licenseStatus`),
      coverage: text(row.coverage, `sources[${index}].coverage`), resolution: text(row.resolution, `sources[${index}].resolution`),
      readiness: readiness as InventoryReadiness, decision: typeof row.decision === "string" ? row.decision : null, offline: row.offline === true,
    };
  });
}
/** A layer.json of the TASK-073 pipeline: quantized-mesh-1.0 in the EPSG:4326 TMS scheme. */
export function parseQuantizedLayer(value: unknown): QuantizedLayer {
  if (!isRecord(value) || value.format !== "quantized-mesh-1.0" || value.scheme !== "tms" || value.projection !== "EPSG:4326") return fail("the layer must be quantized-mesh-1.0 in EPSG:4326 TMS");
  const tiles = Array.isArray(value.tiles) && typeof value.tiles[0] === "string" ? value.tiles[0] : fail("the layer names no tile template");
  if (!tiles.includes("{z}") || !tiles.includes("{x}") || !tiles.includes("{y}")) fail("the tile template must hold {z}, {x} and {y}");
  const minzoom = finite(value.minzoom, "minzoom"), maxzoom = finite(value.maxzoom, "maxzoom");
  if (!Number.isInteger(minzoom) || !Number.isInteger(maxzoom) || minzoom < 0 || maxzoom < minzoom || maxzoom > 24) fail("the zoom levels must be whole, from 0 to 24");
  if (!Array.isArray(value.available)) return fail("the layer lists no available tiles");
  const levels: readonly unknown[] = value.available;
  const available = levels.map((level, z) => {
    if (!Array.isArray(level)) return fail(`available[${z}] must be a list`);
    const ranges: readonly unknown[] = level;
    return ranges.map(range => {
      if (!isRecord(range)) return fail(`available[${z}] holds a range that is not an object`);
      return { startX: finite(range.startX, "startX"), startY: finite(range.startY, "startY"), endX: finite(range.endX, "endX"), endY: finite(range.endY, "endY") };
    });
  });
  return { minzoom, maxzoom, tiles, available };
}
/** The bounding box a terrain-manifest.json states: [west, south, east, north] in degrees. */
export function parseManifestBox(value: unknown): readonly [number, number, number, number] {
  if (!isRecord(value) || value.kind !== "quantized-mesh-terrain" || !Array.isArray(value.bbox) || value.bbox.length !== 4) return fail("the terrain manifest states no bounding box");
  const [west, south, east, north] = value.bbox.map((item, index) => finite(item, `bbox[${index}]`)) as [number, number, number, number];
  if (!(west < east && south < north && west >= -180 && east <= 180 && south >= -90 && north <= 90)) fail("the terrain manifest's bounding box is not a box on the globe");
  return [west, south, east, north];
}
/** Whether tile (x, y) of level z is listed as available. */
export function tileAvailable(layer: QuantizedLayer, x: number, y: number, z: number): boolean {
  if (z < layer.minzoom || z > layer.maxzoom) return false;
  return (layer.available[z] ?? []).some(range => x >= range.startX && x <= range.endX && y >= range.startY && y <= range.endY);
}

const LAYER_OF: Readonly<Record<string, TerrainLayer>> = {
  "synthetic-surface": "ground", elevation: "ground", "land-cover": "imagery", imagery: "imagery", "imagery-and-mesh": "imagery",
};
/** The records a run's Weather and location tab shows, for the place it starts from. */
export function terrainSources(inventory: readonly InventorySource[], local: LocalTerrain, place: { readonly latitudeDeg: number; readonly longitudeDeg: number }): TerrainSourceRecord[] {
  return inventory.map(source => {
    const layer = LAYER_OF[source.kind] ?? "other";
    let coverage: Coverage = { kind: "none" }, readiness: TerrainSourceRecord["readiness"] = "not-ready", reason: string | null = null;
    if (source.kind === "synthetic-surface") {
      coverage = { kind: "any" };
      if (source.readiness === "ready") readiness = "ready"; else reason = source.decision ?? "The inventory does not list it as ready";
    } else if (source.kind === "elevation") {
      if (local.status === "absent") reason = local.reason;
      else {
        const [west, south, east, north] = local.bbox;
        coverage = { kind: "box", west, south, east, north };
        if (covers(coverage, place.latitudeDeg, place.longitudeDeg)) readiness = "ready";
        else reason = `The local terrain covers ${south.toFixed(3)}° to ${north.toFixed(3)}° north and ${west.toFixed(3)}° to ${east.toFixed(3)}° east, not the location`;
      }
    } else {
      switch (source.readiness) {
        case "needs-keys-or-deployment": reason = `Needs keys or a deployment: ${source.decision ?? "not a Phase 1 source"}`; break;
        case "ready-not-wired": reason = `Available but not wired into a run: ${source.decision ?? ""}`.trim(); break;
        case "needs-data": reason = `Needs data: ${source.decision ?? "not prepared"}`; break;
        case "test-only": reason = "A test fixture, not a source for a run"; break;
        case "ready": reason = layer === "other" ? "Not ground a run stands on" : "Shown with the terrain, never the ground of a run"; break;
        default: { const never: never = source.readiness; reason = String(never); }
      }
    }
    return { id: source.id, name: source.name, kind: source.kind, layer, coverage, coverageText: source.coverage, resolution: source.resolution,
      license: source.license, licenseStatus: source.licenseStatus, readiness, reason, offline: source.offline };
  });
}
/** Whether a coverage holds a place. */
export function covers(coverage: Coverage, latitudeDeg: number, longitudeDeg: number): boolean {
  switch (coverage.kind) {
    case "any": return true;
    case "none": return false;
    case "box": return latitudeDeg >= coverage.south && latitudeDeg <= coverage.north && longitudeDeg >= coverage.west && longitudeDeg <= coverage.east;
    default: { const never: never = coverage; return Boolean(never); }
  }
}
