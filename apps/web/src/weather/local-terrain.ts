import type { ExperimentEnvironment, ExperimentTerrain } from "@mirage/aircraft/experiment";
import { covers, parseManifestBox, parseQuantizedLayer, parseTerrainInventory, terrainSources, type InventorySource, type LocalTerrain, type TerrainSourceRecord } from "@mirage/terrain/coverage";
import { buildRunTerrain, latticeSha256, terrainHeightAt } from "@mirage/terrain/run-terrain";
import inventoryJson from "../../../../data/terrain/inventory.json" with { type: "json" };
import type { RunTerrainInput } from "../run/session-controller";
import type { TerrainChoice } from "./terrain-store";

// The local real terrain of a run (TASK-186): the FABDEM output of scripts/geodata/build_terrain.py that the dev server serves at
// /geodata/terrain/ from MIRAGE_GEODATA_DIR, to loopback clients only (apps/web/vite.config.ts). Nothing is downloaded from
// anywhere else and nothing is cached: without a local folder there is no real terrain, and the pad stays the only ground.

export const LOCAL_TERRAIN_URL = "/geodata/terrain/";
const NOT_SERVED = "No local terrain is served: start the application with MIRAGE_GEODATA_DIR set to the folder that holds terrain/ from scripts/geodata/build_terrain.py";

/** The TASK-131 terrain inventory the application is built with. */
export const TERRAIN_INVENTORY: readonly InventorySource[] = parseTerrainInventory(inventoryJson);

/** The served local terrain with the SHA-256 of its layer and manifest, or why there is none. */
export type DiscoveredTerrain = { readonly local: LocalTerrain; readonly layerSha256: string | null; readonly manifestSha256: string | null };

async function sha256Of(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const response = await fetch(url, { cache: "no-store" });
  // Without MIRAGE_GEODATA_DIR the dev server has no /geodata/ route and may answer with the application's page instead.
  if (response.status === 404 || (response.headers.get("content-type") ?? "").includes("text/html")) return null;
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
const text = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

/** Looks for the local terrain's layer.json and terrain-manifest.json; any failure is a reason, never a substitute ground. */
export async function discoverLocalTerrain(baseUrl = LOCAL_TERRAIN_URL): Promise<DiscoveredTerrain> {
  try {
    const [layerBytes, manifestBytes] = await Promise.all([fetchBytes(`${baseUrl}layer.json`), fetchBytes(`${baseUrl}terrain-manifest.json`)]);
    if (!layerBytes) return { local: { status: "absent", reason: NOT_SERVED }, layerSha256: null, manifestSha256: null };
    if (!manifestBytes) return { local: { status: "absent", reason: "The local terrain has no terrain-manifest.json beside its layer.json, so its coverage is unknown" }, layerSha256: null, manifestSha256: null };
    const layer = parseQuantizedLayer(text(layerBytes)), bbox = parseManifestBox(text(manifestBytes));
    return { local: { status: "served", layer, bbox, baseUrl }, layerSha256: await sha256Of(layerBytes), manifestSha256: await sha256Of(manifestBytes) };
  } catch (cause) {
    return { local: { status: "absent", reason: `The local terrain cannot be read: ${cause instanceof Error ? cause.message : String(cause)}` }, layerSha256: null, manifestSha256: null };
  }
}
/** Tile bytes of the served layer, or null when the tile is not there. */
function tileFetcher(local: Extract<LocalTerrain, { status: "served" }>): (z: number, x: number, y: number) => Promise<Uint8Array | null> {
  return (z, x, y) => fetchBytes(local.baseUrl + local.layer.tiles.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
}

/** Every source's record for a place. */
export function sourcesAt(discovered: DiscoveredTerrain, latitudeDeg: number, longitudeDeg: number): TerrainSourceRecord[] {
  return terrainSources(TERRAIN_INVENTORY, discovered.local, { latitudeDeg, longitudeDeg });
}

/** The terrain's ellipsoidal height at a place, m, or why it has none. */
export async function terrainHeightAtPlace(discovered: DiscoveredTerrain, latitudeDeg: number, longitudeDeg: number): Promise<number | string> {
  const { local } = discovered;
  if (local.status === "absent") return local.reason;
  return terrainHeightAt(local.layer, local.bbox, tileFetcher(local), latitudeDeg, longitudeDeg);
}

/**
 * The terrain a run stands on for a choice: null for the pad; for real terrain, the lattice around the environment's home and its
 * record. Refused with a reason when the terrain is not served, does not cover the home, or holds no chunk there.
 */
export async function runTerrainFor(choice: TerrainChoice, environment: ExperimentEnvironment | null, discovered?: DiscoveredTerrain): Promise<RunTerrainInput | null> {
  if (choice.sourceId === "synthetic-pad") return null;
  if (!environment) throw new Error("Real terrain is built around the location's home: this run has no location (it comes from a record or a log without one)");
  const found = discovered ?? await discoverLocalTerrain();
  const { local } = found;
  if (local.status === "absent" || found.layerSha256 === null || found.manifestSha256 === null) throw new Error(local.status === "absent" ? local.reason : NOT_SERVED);
  const { latitudeDeg, longitudeDeg } = environment.location;
  if (!covers({ kind: "box", west: local.bbox[0], south: local.bbox[1], east: local.bbox[2], north: local.bbox[3] }, latitudeDeg, longitudeDeg)) {
    throw new Error("The local terrain does not cover the location: choose the synthetic pad, or a location inside the terrain's bounding box");
  }
  const home = { latitudeDeg, longitudeDeg, ellipsoidalHeightM: environment.conditions.ellipsoidalHeightM };
  const built = await buildRunTerrain({ layer: local.layer, bbox: local.bbox, fetchTile: tileFetcher(local), home, radiusM: choice.radiusM });
  if (built.tiles.length === 0) throw new Error(`The local terrain holds no ground within ${choice.radiusM} m of the home: ${built.missing[0]?.reason ?? "no chunk"}`);
  const record: ExperimentTerrain = {
    sourceId: "fabdem-elevation", layerSha256: found.layerSha256, manifestSha256: found.manifestSha256, radiusM: choice.radiusM, level: built.level,
    chunks: built.tiles.length, missingChunks: built.missing.length, latticeSha256: await latticeSha256(built.tiles),
    homeHeightM: Number.isFinite(built.homeHeightM) ? built.homeHeightM : null,
  };
  return { record, chunks: built.tiles.map(tile => ({ northIndex: tile.northIndex, eastIndex: tile.eastIndex, downM: tile.downM })) };
}
