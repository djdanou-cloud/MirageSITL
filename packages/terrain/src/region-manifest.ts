// Region manifests for persistent caching of permitted datasets (TASK-064).
//
// A manifest names one dataset version, its license policy (TASK-060), a
// region (centre + radius, at most 15 km, 10 km by default) and the complete
// tile index with per-tile SHA-256 and size. datasetSha256 is the SHA-256 of
// the canonical index, so the manifest itself is integrity-checked. The cache
// decision fails closed:
//   * google-live, or any policy without persistent rights and reviewed
//     evidence: BLOCKED (missing rights);
//   * no tiles or no dataset hash: BLOCKED (missing data);
//   * cacheable=false or TTL 0: NO_CACHE (serve without writing);
//   * otherwise CACHEABLE.
import { providerPolicy, type ProviderPolicy } from "./provider-policy.ts";
import { LocalTangentFrame } from "@mirage/sensors/geodesy";

export const REGION_MANIFEST_SCHEMA = "mirage.region-manifest/1";
export const DEFAULT_REGION_RADIUS_M = 10_000;
export const MAX_REGION_RADIUS_M = 15_000;
const SHA256 = /^[a-f0-9]{64}$/;
const TILE_PATH = /^[A-Za-z0-9_\-][A-Za-z0-9_\-./]{0,255}$/;
const DATASET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface RegionTile { path: string; sha256: string; bytes: number; latDeg: number; lonDeg: number }
export interface RegionManifest {
  schema: typeof REGION_MANIFEST_SCHEMA;
  datasetId: string;
  /** SHA-256 of canonicalTileIndex(tiles), or null when the data is not available. */
  datasetSha256: string | null;
  /** Bumped to invalidate every cached object of the dataset. */
  cacheVersion: number;
  policy: Readonly<ProviderPolicy>;
  cacheable: boolean;
  center: { latDeg: number; lonDeg: number };
  radiusM: number;
  /** Byte cap of the region in the cache. */
  maxBytes: number;
  maxObjectBytes: number;
  tiles: readonly RegionTile[];
}

function record(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${what}`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every(k => actual.includes(k))) throw new Error(`Invalid ${what} fields`);
  return Object.fromEntries(Object.entries(value));
}
function finiteIn(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${what}`);
  return value;
}
function intIn(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${what}`);
  return value;
}

/** Structural validation (synchronous). Use verifyRegionManifest to also check the dataset hash. */
export function parseRegionManifest(value: unknown): RegionManifest {
  const m = record(value, ["schema", "datasetId", "datasetSha256", "cacheVersion", "policy", "cacheable", "center", "radiusM", "maxBytes", "maxObjectBytes", "tiles"], "region manifest");
  if (m.schema !== REGION_MANIFEST_SCHEMA) throw new Error("Unsupported region manifest schema");
  if (typeof m.datasetId !== "string" || !DATASET_ID.test(m.datasetId)) throw new Error("Invalid datasetId");
  if (m.datasetSha256 !== null && (typeof m.datasetSha256 !== "string" || !SHA256.test(m.datasetSha256))) throw new Error("Invalid datasetSha256");
  if (typeof m.cacheable !== "boolean") throw new Error("Invalid cacheable");
  const center = record(m.center, ["latDeg", "lonDeg"], "center");
  const maxObjectBytes = intIn(m.maxObjectBytes, 1, 256 * 1024 * 1024, "maxObjectBytes");
  const maxBytes = intIn(m.maxBytes, maxObjectBytes, 64 * 1024 ** 3, "maxBytes");
  if (!Array.isArray(m.tiles) || m.tiles.length > 100_000) throw new Error("Invalid tiles");
  const seen = new Set<string>();
  const tiles: RegionTile[] = [];
  for (const raw of m.tiles as unknown[]) {
    const t = record(raw, ["path", "sha256", "bytes", "latDeg", "lonDeg"], "tile");
    if (typeof t.path !== "string" || !TILE_PATH.test(t.path) || t.path.includes("..") || t.path.includes("//") || seen.has(t.path)) throw new Error("Invalid tile path");
    if (typeof t.sha256 !== "string" || !SHA256.test(t.sha256)) throw new Error("Invalid tile sha256");
    seen.add(t.path);
    tiles.push({ path: t.path, sha256: t.sha256, bytes: intIn(t.bytes, 0, maxObjectBytes, "tile bytes"),
      latDeg: finiteIn(t.latDeg, -90, 90, "tile latitude"), lonDeg: finiteIn(t.lonDeg, -180, 180, "tile longitude") });
  }
  return Object.freeze({
    schema: REGION_MANIFEST_SCHEMA,
    datasetId: m.datasetId,
    datasetSha256: m.datasetSha256,
    cacheVersion: intIn(m.cacheVersion, 1, 1_000_000, "cacheVersion"),
    policy: providerPolicy(m.policy),
    cacheable: m.cacheable,
    center: { latDeg: finiteIn(center.latDeg, -90, 90, "center latitude"), lonDeg: finiteIn(center.lonDeg, -180, 180, "center longitude") },
    radiusM: finiteIn(m.radiusM, 1, MAX_REGION_RADIUS_M, "radiusM"),
    maxBytes,
    maxObjectBytes,
    tiles: Object.freeze(tiles),
  });
}

/** Canonical index text hashed into datasetSha256: "path sha256 bytes\n" sorted by path. */
export function canonicalTileIndex(tiles: readonly RegionTile[]): string {
  return [...tiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(t => `${t.path} ${t.sha256} ${t.bytes}\n`).join("");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  // Copy into an ArrayBuffer-backed view (digest rejects shared buffers).
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Parses and checks that datasetSha256 matches the tile index. */
export async function verifyRegionManifest(value: unknown): Promise<RegionManifest> {
  const manifest = parseRegionManifest(value);
  if (manifest.datasetSha256 !== null && (await sha256Hex(canonicalTileIndex(manifest.tiles))) !== manifest.datasetSha256) {
    throw new Error("Dataset hash does not match the tile index");
  }
  return manifest;
}

export type RegionDecision =
  | { status: "CACHEABLE" }
  | { status: "NO_CACHE"; reason: string }
  | { status: "BLOCKED"; reason: string };

export function regionDecision(manifest: RegionManifest): RegionDecision {
  const p = manifest.policy;
  if (p.provider === "google-live") return { status: "BLOCKED", reason: "Google tiles are never persisted without a separately authorized lawful policy" };
  if (!p.evidenceSha256) return { status: "BLOCKED", reason: "Missing reviewed license evidence for the dataset" };
  if (manifest.datasetSha256 === null || manifest.tiles.length === 0) return { status: "BLOCKED", reason: "Missing dataset data or dataset hash" };
  if (!manifest.cacheable) return { status: "NO_CACHE", reason: "Manifest marks the dataset as not cacheable" };
  if (p.allowedCache !== "persistent") return { status: "NO_CACHE", reason: "License permits memory caching only" };
  if (p.ttlS === 0) return { status: "NO_CACHE", reason: "License permits no retention (TTL 0)" };
  return { status: "CACHEABLE" };
}

/** Horizontal distance (m) of a tile centre from the region centre on the WGS84 ellipsoid tangent plane. */
export function regionDistanceM(manifest: RegionManifest, latDeg: number, lonDeg: number): number {
  const deg = Math.PI / 180;
  const frame = new LocalTangentFrame(manifest.center.latDeg * deg, manifest.center.lonDeg * deg, 0);
  const ned = new Float64Array(3);
  frame.geodeticToNedInto(latDeg * deg, lonDeg * deg, 0, ned);
  return Math.hypot(ned[0]!, ned[1]!); // fixed length 3
}
