// Optional terrain layer configuration (TASK-061). The app renders no terrain
// unless VITE_MIRAGE_TILESET_URL and VITE_MIRAGE_TILES_ORIGIN ("latDeg,lonDeg,
// ellipsoidalHeightM") are set at build time, e.g. pointing at the local CC0
// fixture. Only licensed/local tilesets are supported in the client; live
// Google tiles stay blocked until the TASK-063 proxy exists.
import { providerPolicy } from "@mirage/terrain/provider-policy";
import { resolveTilesSource } from "@mirage/terrain/tiles-provider";

export interface TerrainConfig {
  url: string;
  attribution: string;
  originLatRad: number;
  originLonRad: number;
  originHeightM: number;
}

export type TerrainConfigResult = { status: "off" } | { status: "ready"; config: TerrainConfig } | { status: "blocked"; reason: string };

/** Parses build-time settings from unknown values. */
export function terrainConfigFrom(url: unknown, origin: unknown, attribution: unknown): TerrainConfigResult {
  if (url === undefined || url === "") return { status: "off" };
  if (typeof url !== "string" || typeof origin !== "string") return { status: "blocked", reason: "Tileset URL and origin must both be set" };
  const parts = origin.split(",").map(Number);
  const [latDeg, lonDeg, heightM] = parts;
  if (parts.length !== 3 || latDeg === undefined || lonDeg === undefined || heightM === undefined || !parts.every(Number.isFinite) ||
    Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180 || Math.abs(heightM) > 10_000) {
    return { status: "blocked", reason: "Tiles origin must be 'latDeg,lonDeg,heightM'" };
  }
  const label = typeof attribution === "string" && attribution.trim() ? attribution : "Unattributed tileset";
  const policy = providerPolicy({ provider: "licensed", attribution: label, allowedCache: "memory", ttlS: 0, offline: false,
    prefetch: false, datasetLicense: "See tileset attribution", evidenceSha256: null });
  const resolved = resolveTilesSource({ kind: "local", tilesetUrl: url, policy });
  if (resolved.status !== "READY") return { status: "blocked", reason: resolved.reason };
  const deg = Math.PI / 180;
  return { status: "ready", config: { url: resolved.url, attribution: resolved.attribution, originLatRad: latDeg * deg,
    originLonRad: lonDeg * deg, originHeightM: heightM } };
}
