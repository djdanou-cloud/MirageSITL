// TASK-064: persistent region cache for permitted datasets, against an
// in-memory R2 emulator (tests/support/memory-r2.ts). No bucket is bound in
// the proxy Worker; enabling persistent R2 caching needs explicit permission.
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REGION_RADIUS_M, REGION_MANIFEST_SCHEMA, canonicalTileIndex, parseRegionManifest, regionDecision, regionDistanceM, sha256Hex,
  verifyRegionManifest, type RegionTile,
} from "../packages/terrain/src/region-manifest.ts";
import { RegionCache, readThrough } from "../services/tiles-worker/src/r2-cache.ts";
import { MemoryR2Bucket } from "./support/memory-r2.ts";

const EVIDENCE = "a".repeat(64);
const LICENSED = { provider: "licensed", attribution: "Example survey (CC BY 4.0)", allowedCache: "persistent", ttlS: 3600, offline: false, prefetch: false,
  datasetLicense: "CC-BY-4.0", evidenceSha256: EVIDENCE };
const GOOGLE = { provider: "google-live", attribution: "Google", allowedCache: "memory", ttlS: 0, offline: false, prefetch: false,
  datasetLicense: "Google Map Tiles API terms", evidenceSha256: null };
const CENTER = { latDeg: 47.3769, lonDeg: 8.5417 };
const M_PER_DEG_LAT = 111_200; // ~WGS84 meridian degree at 47 deg; boundary cases keep >= 1 km margin

function tileBytes(path: string, size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (path.charCodeAt(i % path.length) + i) & 0xff;
  return out;
}
const BODIES = new Map<string, Uint8Array<ArrayBuffer>>();
async function tile(path: string, northM: number, size = 1000): Promise<RegionTile> {
  const bytes = tileBytes(path, size);
  BODIES.set(path, bytes);
  return { path, sha256: await sha256Hex(bytes), bytes: size, latDeg: CENTER.latDeg + northM / M_PER_DEG_LAT, lonDeg: CENTER.lonDeg };
}
async function manifest(overrides: Record<string, unknown> = {}, tiles?: RegionTile[]): Promise<Record<string, unknown>> {
  const list = tiles ?? [await tile("t/a.glb", 0), await tile("t/b.glb", 2000), await tile("t/c.glb", 9000), await tile("t/far.glb", 11_000), await tile("t/d.glb", -4000)];
  return { schema: REGION_MANIFEST_SCHEMA, datasetId: "zurich-survey", datasetSha256: await sha256Hex(canonicalTileIndex(list)), cacheVersion: 1, policy: LICENSED,
    cacheable: true, center: CENTER, radiusM: DEFAULT_REGION_RADIUS_M, maxBytes: 3000, maxObjectBytes: 2000, tiles: list, ...overrides };
}

let clockMs = 1_800_000_000_000;
let originCalls: string[] = [];
const origin = (path: string) => {
  originCalls.push(path);
  const body = BODIES.get(path);
  return Promise.resolve(body ? new Response(body.slice()) : new Response("missing", { status: 404 }));
};
beforeEach(() => { originCalls = []; });

describe("region manifest", () => {
  it("validates structure, radius, paths and the dataset hash", async () => {
    const good = await manifest();
    expect(parseRegionManifest(good).radiusM).toBe(10_000);
    expect((await verifyRegionManifest({ ...good, radiusM: 15_000 })).radiusM).toBe(15_000);
    const t = (good.tiles as RegionTile[])[0]!;
    for (const change of [{ schema: "x" }, { radiusM: 15_001 }, { radiusM: 0 }, { datasetId: "Bad Id" }, { maxBytes: 10 }, { cacheable: "yes" },
      { tiles: [t, t] }, { tiles: [{ ...t, path: "../x" }] }, { tiles: [{ ...t, sha256: "abc" }] }, { tiles: [{ ...t, bytes: 5000 }] }, { extra: 1 },
      { policy: { ...LICENSED, evidenceSha256: null } }]) {
      expect(() => parseRegionManifest({ ...good, ...change }), JSON.stringify(change)).toThrow();
    }
    await expect(verifyRegionManifest({ ...good, datasetSha256: "b".repeat(64) })).rejects.toThrow("Dataset hash");
  });

  it("decides fail-closed: Google and missing rights or data block, cacheable=false and TTL 0 bypass", async () => {
    const decide = async (o: Record<string, unknown>) => regionDecision(await verifyRegionManifest(await manifest(o)));
    expect(await decide({})).toEqual({ status: "CACHEABLE" });
    expect((await decide({ policy: GOOGLE })).status).toBe("BLOCKED");
    // Reviewed evidence does not unlock Google persistence.
    expect(await decide({ policy: { ...GOOGLE, evidenceSha256: EVIDENCE } })).toMatchObject({ status: "BLOCKED", reason: expect.stringContaining("Google") as unknown });
    expect((await decide({ policy: { ...LICENSED, allowedCache: "memory", evidenceSha256: null } })).status).toBe("BLOCKED");
    expect((await decide({ datasetSha256: null })).status).toBe("BLOCKED");
    expect(regionDecision(parseRegionManifest(await manifest({}, [])))).toMatchObject({ status: "BLOCKED", reason: "Missing dataset data or dataset hash" });
    expect((await decide({ cacheable: false })).status).toBe("NO_CACHE");
    expect((await decide({ policy: { ...LICENSED, allowedCache: "memory" } })).status).toBe("NO_CACHE");
    expect((await decide({ policy: { ...LICENSED, ttlS: 0 } })).status).toBe("NO_CACHE");
  });

  it("measures region distance on the ellipsoid", async () => {
    const m = parseRegionManifest(await manifest());
    expect(regionDistanceM(m, CENTER.latDeg, CENTER.lonDeg)).toBeLessThan(1e-6);
    // 0.1 deg of latitude at 47.4 deg is 11.12 km on WGS84 (meridian arc).
    expect(regionDistanceM(m, CENTER.latDeg + 0.1, CENTER.lonDeg)).toBeGreaterThan(11_090);
    expect(regionDistanceM(m, CENTER.latDeg + 0.1, CENTER.lonDeg)).toBeLessThan(11_140);
  });
});

describe("R2 region cache", () => {
  it("misses, stores, hits, and expires after the policy TTL", async () => {
    const bucket = new MemoryR2Bucket(() => clockMs);
    const cache = new RegionCache(bucket, await verifyRegionManifest(await manifest()), () => clockMs);
    const first = await readThrough(cache, "t/a.glb", origin);
    expect(first).toMatchObject({ status: "fetched", write: "stored" });
    const second = await readThrough(cache, "t/a.glb", origin);
    expect(second.status).toBe("hit");
    expect(second.status === "hit" && second.bytes).toEqual(BODIES.get("t/a.glb"));
    expect(originCalls).toEqual(["t/a.glb"]);
    clockMs += 3600 * 1000;
    expect(await cache.get("t/a.glb")).toEqual({ status: "expired" });
    expect(bucket.objects.size).toBe(0); // expired object deleted
    expect((await readThrough(cache, "t/a.glb", origin)).status).toBe("fetched");
    expect(cache.stats).toMatchObject({ hits: 1, misses: 2, expired: 1, writes: 2 }) // first read and the refetch after expiry;
    const [key] = [...bucket.objects.keys()];
    expect(key).toMatch(/^zurich-survey\/[0-9a-f]{16}\/v1\/t\/a\.glb$/);
    expect(bucket.objects.get(key!)?.customMetadata).toMatchObject({ license: "CC-BY-4.0", expiresAtMs: String(clockMs + 3_600_000) });
  });

  it("enforces the byte cap by evicting the oldest (earliest-expiring) objects", async () => {
    const bucket = new MemoryR2Bucket(() => clockMs, 2); // paginated listing
    const cache = new RegionCache(bucket, await verifyRegionManifest(await manifest()), () => clockMs);
    for (const path of ["t/a.glb", "t/b.glb", "t/c.glb"]) { await readThrough(cache, path, origin); clockMs += 1000; }
    expect(bucket.totalBytes).toBe(3000);
    expect(cache.stats.evictions).toBe(0);
    await readThrough(cache, "t/d.glb", origin);
    expect([...bucket.objects.keys()].map(k => k.split("/").pop())).toEqual(["b.glb", "c.glb", "d.glb"]); // oldest (a) evicted
    expect(bucket.totalBytes).toBeLessThanOrEqual(3000);
    // Re-writing an existing key replaces it without evicting others.
    await cache.put("t/c.glb", BODIES.get("t/c.glb")!);
    expect(bucket.objects.size).toBe(3);
    // The oldest object (now expired) goes first.
    clockMs += 3_598_500; // b expires (uploaded first), c and d are still live
    const before = cache.stats.evictions;
    await readThrough(cache, "t/a.glb", origin);
    expect(cache.stats.evictions - before).toBe(1);
    expect([...bucket.objects.keys()].map(k => k.split("/").pop()).sort()).toEqual(["a.glb", "c.glb", "d.glb"]);
    expect(await cache.usedBytes()).toBeLessThanOrEqual(3000);
  });

  it("never writes outside the radius, for unlisted or mismatching tiles, or when cacheable=false", async () => {
    const bucket = new MemoryR2Bucket(() => clockMs);
    const cache = new RegionCache(bucket, await verifyRegionManifest(await manifest()), () => clockMs);
    expect(await readThrough(cache, "t/far.glb", origin)).toMatchObject({ status: "fetched", write: "outside-region" }); // 11 km > 10 km
    expect(await cache.put("t/c.glb", BODIES.get("t/c.glb")!)).toBe("stored"); // 9 km
    expect(await cache.put("t/a.glb", tileBytes("tampered", 1000))).toBe("hash-mismatch");
    expect(await cache.put("t/unlisted.glb", tileBytes("x", 10))).toBe("not-listed");
    expect(await readThrough(cache, "t/unlisted.glb", origin)).toMatchObject({ status: "origin-error", httpStatus: 404 });
    const corrupt = await readThrough(cache, "t/b.glb", () => Promise.resolve(new Response(tileBytes("evil", 1000))));
    expect(corrupt.status).toBe("integrity-error");
    expect(bucket.puts).toBe(1);
    // 15 km region admits the 11 km tile.
    const wide = new RegionCache(bucket, await verifyRegionManifest(await manifest({ radiusM: 15_000 })), () => clockMs);
    expect(await wide.put("t/far.glb", BODIES.get("t/far.glb")!)).toBe("stored");

    const noCache = new MemoryR2Bucket(() => clockMs);
    const bypass = new RegionCache(noCache, await verifyRegionManifest(await manifest({ cacheable: false })), () => clockMs);
    for (let i = 0; i < 3; i++) expect((await readThrough(bypass, "t/a.glb", origin)).status).toBe("fetched");
    expect(await bypass.put("t/a.glb", BODIES.get("t/a.glb")!)).toBe("not-cacheable");
    expect([noCache.puts, noCache.objects.size]).toEqual([0, 0]);
  });

  it("blocks the provider without fetching when rights or data are missing, including Google", async () => {
    for (const o of [{ policy: GOOGLE }, { datasetSha256: null }, { policy: { ...LICENSED, allowedCache: "memory", evidenceSha256: null } }]) {
      const bucket = new MemoryR2Bucket(() => clockMs);
      const cache = new RegionCache(bucket, await verifyRegionManifest(await manifest(o)), () => clockMs);
      expect((await readThrough(cache, "t/a.glb", origin)).status).toBe("blocked");
      expect(await cache.put("t/a.glb", BODIES.get("t/a.glb")!)).toBe("blocked");
      expect(bucket.puts).toBe(0);
    }
    expect(originCalls).toEqual([]);
  });

  it("isolates dataset versions by key", async () => {
    const bucket = new MemoryR2Bucket(() => clockMs);
    const v1 = new RegionCache(bucket, await verifyRegionManifest(await manifest()), () => clockMs);
    await readThrough(v1, "t/a.glb", origin);
    const v2 = new RegionCache(bucket, await verifyRegionManifest(await manifest({ cacheVersion: 2 })), () => clockMs);
    expect(v2.prefix).not.toBe(v1.prefix);
    expect((await v2.get("t/a.glb")).status).toBe("miss");
    expect((await v1.get("t/a.glb")).status).toBe("hit");
  });
});
