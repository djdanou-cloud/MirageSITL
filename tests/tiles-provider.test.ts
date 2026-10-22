import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerPolicy } from "@mirage/terrain/provider-policy";
import { TileFetchTracker, classifyTileFailure, ecefToRenderMatrix, resolveTilesSource } from "@mirage/terrain/tiles-provider";

// TASK-061. Oracle for placement: the ENU basis and origin written by the
// independent Python generator into tests/fixtures/tiles/tileset.json.
const tileset = JSON.parse(readFileSync(new URL("./fixtures/tiles/tileset.json", import.meta.url), "utf8")) as {
  asset: { extras: { origin: { latDeg: number; lonDeg: number; heightM: number }; attribution: string } };
  root: { transform: number[] };
};
const licensed = providerPolicy({ provider: "licensed", attribution: "MirageSITL synthetic test tiles (CC0-1.0)", allowedCache: "memory",
  ttlS: 0, offline: false, prefetch: false, datasetLicense: "CC0-1.0", evidenceSha256: null });
const google = providerPolicy({ provider: "google-live", attribution: "Google", allowedCache: "memory", ttlS: 0, offline: false,
  prefetch: false, datasetLicense: "Google Maps Platform Terms", evidenceSha256: null });

describe("3D Tiles source resolution", () => {
  it("blocks live Google tiles without the proxy and keeps local licensed fixtures available", () => {
    const blocked = resolveTilesSource({ kind: "google-live", proxyUrl: null, policy: google });
    expect(blocked.status).toBe("BLOCKED_EXTERNAL");
    expect(blocked.status === "BLOCKED_EXTERNAL" && blocked.reason).toMatch(/proxy \(TASK-063\).*no API key/);
    expect(resolveTilesSource({ kind: "local", tilesetUrl: "/fixtures/tiles/tileset.json", policy: licensed }))
      .toEqual({ status: "READY", url: "/fixtures/tiles/tileset.json", attribution: licensed.attribution });
    expect(resolveTilesSource({ kind: "local", tilesetUrl: "/x/tileset.json", policy: google }).status).toBe("BLOCKED_EXTERNAL");
    expect(resolveTilesSource({ kind: "local", tilesetUrl: "/x/tile.glb", policy: licensed }).status).toBe("BLOCKED_EXTERNAL");
    expect(resolveTilesSource({ kind: "google-live", proxyUrl: "https://tiles.example/root.json", policy: licensed }).status).toBe("BLOCKED_EXTERNAL");
  });
});

describe("ECEF to render placement", () => {
  const { latDeg, lonDeg, heightM } = tileset.asset.extras.origin;
  const m = ecefToRenderMatrix((latDeg * Math.PI) / 180, (lonDeg * Math.PI) / 180, heightM);
  const apply = (p: number[]) => [0, 1, 2].map(r => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!);
  const t = tileset.root.transform, origin = t.slice(12, 15), east = t.slice(0, 3), north = t.slice(4, 7), up = t.slice(8, 11);
  const offset = (axis: number[], d: number) => origin.map((o, i) => o + d * axis[i]!);
  const close = (actual: number[], expected: number[]) => actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `${i}: ${v}`).toBeLessThan(1e-6));
  it("maps the fixture origin to the render origin and ENU axes to render x/up/-z", () => {
    close(apply(origin), [0, 0, 0]);
    close(apply(offset(east, 100)), [100, 0, 0]);
    close(apply(offset(up, 20)), [0, 20, 0]);
    close(apply(offset(north, 100)), [0, 0, -100]);
    expect(m[15]).toBe(1);
  });
});

describe("tile request tracking", () => {
  const response = (status: number) => ({ ok: status >= 200 && status < 300, status } as Response);
  it("aborts in-flight requests on dispose without recording them as failures", async () => {
    const pending: ((r: Response) => void)[] = [];
    const tracker = new TileFetchTracker((_url, init) => new Promise((resolve, reject) => {
      pending.push(resolve);
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const a = tracker.fetch("/a.glb"), b = tracker.fetch("/b.glb");
    expect(tracker.inFlight).toBe(2);
    tracker.dispose();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    expect([tracker.inFlight, tracker.failures.length]).toEqual([0, 0]);
    await expect(tracker.fetch("/c.glb")).rejects.toMatchObject({ name: "AbortError" });
    expect(pending).toHaveLength(2);
  });
  it("relays the loader's own abort signal", async () => {
    const tracker = new TileFetchTracker((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const controller = new AbortController(), request = tracker.fetch("/x.glb", { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(tracker.inFlight).toBe(0);
  });
  it("classifies CORS/network and HTTP failures and forces CORS mode without credentials", async () => {
    let seen: RequestInit | null = null;
    const tracker = new TileFetchTracker((url, init) => {
      seen = init;
      return url.includes("blocked") ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(response(url.includes("missing") ? 404 : 200));
    });
    await expect(tracker.fetch("https://cross.origin/blocked.json")).rejects.toThrow("Failed to fetch");
    expect((await tracker.fetch("/missing.json")).status).toBe(404);
    expect((await tracker.fetch("/ok.json")).status).toBe(200);
    expect(tracker.failures.map(f => [f.kind, f.status])).toEqual([["cors-or-network", 0], ["http", 404]]);
    expect(seen).toMatchObject({ mode: "cors", credentials: "omit" });
    expect(classifyTileFailure(new Error("x"))).toBe("unknown");
  });
});

describe("fixture", () => {
  it("is a valid GLB with the documented CC0 provenance", () => {
    const glb = readFileSync(new URL("./fixtures/tiles/tile.glb", import.meta.url));
    expect(glb.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString()) as { asset: { copyright: string } };
    expect(json.asset.copyright).toMatch(/^CC0-1.0/);
    expect(tileset.asset.extras.attribution).toBe("MirageSITL synthetic test tiles (CC0-1.0)");
  });
});

describe("app terrain configuration", async () => {
  const { terrainConfigFrom } = await import("../apps/web/src/terrain-config");
  it("is off by default, parses a local tileset, and blocks malformed settings", () => {
    expect(terrainConfigFrom(undefined, undefined, undefined)).toEqual({ status: "off" });
    const ready = terrainConfigFrom("/fixtures/tiles/tileset.json", "47.3769,8.5417,400", "CC0 tiles");
    expect(ready.status === "ready" && ready.config).toMatchObject({ sources: [{ url: "/fixtures/tiles/tileset.json", format: "3d-tiles" }],
      attribution: "CC0 tiles", originHeightM: 400 });
    // TASK-073: quantized-mesh terrain alone or with a buildings tileset; terrain is listed first.
    const both = terrainConfigFrom("/geodata/buildings/tileset.json", "32.2,34.87,70", "FABDEM + Overture", "/geodata/terrain/layer.json");
    expect(both.status === "ready" && both.config.sources).toEqual([{ url: "/geodata/terrain/layer.json", format: "quantized-mesh" },
      { url: "/geodata/buildings/tileset.json", format: "3d-tiles" }]);
    expect(terrainConfigFrom(undefined, "32.2,34.87,70", "x", "/geodata/terrain/layer.json").status).toBe("ready");
    expect(terrainConfigFrom(undefined, "32.2,34.87,70", "x", "/geodata/terrain/terrain.json").status).toBe("blocked");
    expect(terrainConfigFrom(undefined, undefined, "x", "/geodata/terrain/layer.json").status).toBe("blocked");
    expect(ready.status === "ready" && ready.config.originLatRad).toBeCloseTo((47.3769 * Math.PI) / 180, 12);
    for (const [url, origin] of [["/t/tileset.json", undefined], ["/t/tileset.json", "91,0,0"], ["/t/tileset.json", "1,2"], ["/t/tile.glb", "1,2,3"]] as const) {
      expect(terrainConfigFrom(url, origin, "x").status, `${url} ${String(origin)}`).toBe("blocked");
    }
  });
});
