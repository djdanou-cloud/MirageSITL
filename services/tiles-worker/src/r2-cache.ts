// Persistent region cache for permitted datasets on Cloudflare R2 (TASK-064).
//
// Only a verified RegionManifest whose decision is CACHEABLE ever writes.
// Keys: "<datasetId>/<datasetSha256[0..16]>/v<cacheVersion>/<tile path>", so
// a new dataset hash or cache version never reads stale objects. A tile is
// written only when it is listed in the manifest, its centre is inside the
// region radius, its body matches the listed SHA-256 and size, and the region
// stays under its byte cap after evicting the oldest objects.
// Objects expire after the policy TTL (checked on read; expired objects are
// deleted). Google live tiles are BLOCKED by the manifest decision.
// The proxy Worker does not bind a bucket by default: enabling persistent R2
// caching needs explicit permission (CLAUDE.md section 9).
import { regionDecision, regionDistanceM, sha256Hex, type RegionManifest, type RegionTile } from "../../../packages/terrain/src/region-manifest.ts";

/** Subset of the Workers R2Bucket binding used here. */
export interface R2ObjectLike { key: string; size: number; uploaded: Date; customMetadata?: Record<string, string> }
export interface R2BodyLike extends R2ObjectLike { arrayBuffer(): Promise<ArrayBuffer> }
export interface R2BucketLike {
  get(key: string): Promise<R2BodyLike | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, options: { customMetadata: Record<string, string>; httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number; include?: ("customMetadata")[] }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
}

export type CacheRead =
  | { status: "hit"; bytes: Uint8Array }
  | { status: "miss" | "expired" }
  | { status: "bypass"; reason: string }
  | { status: "blocked"; reason: string };
export type CacheWrite =
  | "stored" | "not-cacheable" | "blocked" | "not-listed" | "outside-region" | "hash-mismatch";

export interface RegionCacheStats { hits: number; misses: number; expired: number; writes: number; evictions: number; rejected: number }

export class RegionCache {
  readonly prefix: string;
  readonly stats: RegionCacheStats = { hits: 0, misses: 0, expired: 0, writes: 0, evictions: 0, rejected: 0 };
  private readonly tiles = new Map<string, RegionTile>();

  constructor(private readonly bucket: R2BucketLike, readonly manifest: RegionManifest, private readonly nowMs: () => number = () => Date.now()) {
    this.prefix = `${manifest.datasetId}/${(manifest.datasetSha256 ?? "none").slice(0, 16)}/v${manifest.cacheVersion}/`;
    for (const tile of manifest.tiles) this.tiles.set(tile.path, tile);
  }

  get decision(): ReturnType<typeof regionDecision> { return regionDecision(this.manifest); }

  async get(path: string): Promise<CacheRead> {
    const decision = this.decision;
    if (decision.status === "BLOCKED") return { status: "blocked", reason: decision.reason };
    if (decision.status === "NO_CACHE") return { status: "bypass", reason: decision.reason };
    if (!this.tiles.has(path)) return { status: "bypass", reason: "Tile not listed in the region manifest" };
    const object = await this.bucket.get(this.prefix + path);
    if (!object) { this.stats.misses++; return { status: "miss" }; }
    const expires = Number(object.customMetadata?.expiresAtMs);
    if (!(expires > this.nowMs())) {
      await this.bucket.delete(object.key);
      this.stats.expired++;
      return { status: "expired" };
    }
    this.stats.hits++;
    return { status: "hit", bytes: new Uint8Array(await object.arrayBuffer()) };
  }

  async put(path: string, bytes: Uint8Array): Promise<CacheWrite> {
    const result = await this.tryPut(path, bytes);
    if (result !== "stored") this.stats.rejected++;
    return result;
  }

  private async tryPut(path: string, bytes: Uint8Array): Promise<CacheWrite> {
    const decision = this.decision;
    if (decision.status === "BLOCKED") return "blocked";
    if (decision.status === "NO_CACHE") return "not-cacheable";
    const tile = this.tiles.get(path);
    if (!tile) return "not-listed";
    if (regionDistanceM(this.manifest, tile.latDeg, tile.lonDeg) > this.manifest.radiusM) return "outside-region";
    if (bytes.byteLength !== tile.bytes || (await sha256Hex(bytes)) !== tile.sha256) return "hash-mismatch";
    // Listed sizes are bounded by maxObjectBytes <= maxBytes (parseRegionManifest), so room can always be made.
    await this.makeRoom(path, bytes.byteLength);
    const now = this.nowMs();
    await this.bucket.put(this.prefix + path, bytes, {
      customMetadata: { expiresAtMs: String(now + this.manifest.policy.ttlS * 1000), sha256: tile.sha256, license: this.manifest.policy.datasetLicense },
    });
    this.stats.writes++;
    return "stored";
  }

  /**
   * Evicts the oldest uploads (expired ones first, as every object of a
   * dataset version shares one TTL) until `incoming` bytes
   * fit under maxBytes (replacing `path` frees its old size). Concurrent
   * writers can each pass this check: the cap may be exceeded by at most one
   * object per concurrent writer, so maxBytes should keep that headroom.
   */
  private async makeRoom(path: string, incoming: number): Promise<void> {
    const key = this.prefix + path;
    const objects = (await this.listAll()).filter(o => o.key !== key);
    let used = 0;
    for (const o of objects) used += o.size;
    if (used + incoming <= this.manifest.maxBytes) return;
    // One TTL per dataset version: the oldest upload is also the earliest to expire.
    objects.sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime() || (a.key < b.key ? -1 : 1));
    const victims: string[] = [];
    for (const o of objects) {
      if (used + incoming <= this.manifest.maxBytes) break;
      victims.push(o.key);
      used -= o.size;
    }
    if (victims.length > 0) {
      await this.bucket.delete(victims);
      this.stats.evictions += victims.length;
    }
  }

  private async listAll(): Promise<R2ObjectLike[]> {
    const out: R2ObjectLike[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = await this.bucket.list({ prefix: this.prefix, cursor, include: ["customMetadata"] });
      out.push(...result.objects);
      if (!result.truncated) return out;
      cursor = result.cursor;
    }
    throw new Error("R2 listing did not terminate");
  }

  /** Bytes currently stored for this dataset version. */
  async usedBytes(): Promise<number> {
    let used = 0;
    for (const o of await this.listAll()) used += o.size;
    return used;
  }
}

export type ReadThrough =
  | { status: "hit" | "fetched"; bytes: Uint8Array; write?: CacheWrite }
  | { status: "blocked"; reason: string }
  | { status: "origin-error"; httpStatus: number }
  | { status: "integrity-error" };

/**
 * Serves a tile from the region cache, else from the dataset origin, writing
 * back only what the manifest permits. A BLOCKED manifest serves nothing:
 * missing rights or data make the provider explicitly unavailable. A listed
 * tile whose body does not match the manifest hash is not served.
 */
export async function readThrough(cache: RegionCache, path: string, fetchOrigin: (path: string) => Promise<Response>): Promise<ReadThrough> {
  const read = await cache.get(path);
  if (read.status === "blocked") return read;
  if (read.status === "hit") return { status: "hit", bytes: read.bytes };
  const response = await fetchOrigin(path);
  if (!response.ok) return { status: "origin-error", httpStatus: response.status };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (read.status === "bypass") return { status: "fetched", bytes };
  const write = await cache.put(path, bytes);
  if (write === "hash-mismatch") return { status: "integrity-error" };
  return { status: "fetched", bytes, write };
}
