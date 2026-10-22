// Optional terrain layer configuration (TASK-061, TASK-073). The app renders no
// terrain unless a source and VITE_MIRAGE_TILES_ORIGIN ("latDeg,lonDeg,
// ellipsoidalHeightM") are set at build time. Sources:
//   * VITE_MIRAGE_TILESET_URL: a 3D Tiles tileset JSON (e.g. the local CC0
//     fixture, or the generated buildings tileset);
//   * VITE_MIRAGE_TERRAIN_URL: a quantized-mesh terrain layer.json (the
//     generated FABDEM terrain).
// Both may be set; they share the origin, which is the render-frame origin and
// should sit on the ground at the area of operation. Only licensed/local
// sources are supported in the client; live Google tiles stay blocked until
// the TASK-063 proxy exists.
import { providerPolicy } from "@mirage/terrain/provider-policy";
import { resolveTilesSource } from "@mirage/terrain/tiles-provider";
import type { TilesFormat } from "@mirage/terrain/tiles-scene";

export interface TerrainSource {
  url: string;
  format: TilesFormat;
}

export interface TerrainConfig {
  sources: TerrainSource[];
  attribution: string;
  originLatRad: number;
  originLonRad: number;
  originHeightM: number;
}

export type TerrainConfigResult = { status: "off" } | { status: "ready"; config: TerrainConfig } | { status: "blocked"; reason: string };

const present = (value: unknown) => value !== undefined && value !== "";

/** Parses build-time settings from unknown values. */
export function terrainConfigFrom(tilesetUrl: unknown, origin: unknown, attribution: unknown, terrainUrl?: unknown): TerrainConfigResult {
  if (!present(tilesetUrl) && !present(terrainUrl)) return { status: "off" };
  if (typeof origin !== "string") return { status: "blocked", reason: "A tiles origin must be set with any terrain source" };
  const parts = origin.split(",").map(Number);
  const [latDeg, lonDeg, heightM] = parts;
  if (parts.length !== 3 || latDeg === undefined || lonDeg === undefined || heightM === undefined || !parts.every(Number.isFinite) ||
    Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180 || Math.abs(heightM) > 10_000) {
    return { status: "blocked", reason: "Tiles origin must be 'latDeg,lonDeg,heightM'" };
  }
  const label = typeof attribution === "string" && attribution.trim() ? attribution : "Unattributed tileset";
  const policy = providerPolicy({ provider: "licensed", attribution: label, allowedCache: "memory", ttlS: 0, offline: false,
    prefetch: false, datasetLicense: "See tileset attribution", evidenceSha256: null });
  const sources: TerrainSource[] = [];
  for (const [value, format] of [[terrainUrl, "quantized-mesh"], [tilesetUrl, "3d-tiles"]] as const) {
    if (!present(value)) continue;
    if (typeof value !== "string") return { status: "blocked", reason: "Terrain and tileset URLs must be strings" };
    if (format === "quantized-mesh" && !/\/layer\.json(\?|$)/.test(value)) return { status: "blocked", reason: "Terrain URL must reference a quantized-mesh layer.json" };
    const resolved = resolveTilesSource({ kind: "local", tilesetUrl: value, policy });
    if (resolved.status !== "READY") return { status: "blocked", reason: resolved.reason };
    sources.push({ url: resolved.url, format });
  }
  const deg = Math.PI / 180;
  return { status: "ready", config: { sources, attribution: label, originLatRad: latDeg * deg, originLonRad: lonDeg * deg, originHeightM: heightM } };
}
