// TASK-063: local tests of the Cloudflare tiles proxy (no deployment, no live
// provider request). The upstream and the Durable Object namespace are local
// fakes; every response and log event is collected to prove that the provider
// key never reaches a client or a log.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TileQuota, createHandler, type Env, type LogEvent, type QuotaNamespace } from "../services/tiles-worker/src/index.ts";
import { cacheControl, parseProxyConfig, upstreamUrl, verifySession, signingKey, issueSession } from "../services/tiles-worker/src/policy.ts";
import { TileFetchTracker, requestTilesSession } from "../packages/terrain/src/tiles-provider.ts";
import { providerPolicy } from "../packages/terrain/src/provider-policy.ts";

const API_KEY = "AIzaTEST-not-a-real-key-0123456789";
const SIGNING = "test-signing-secret-0123456789abcdef";
const APP = "https://sim.example.org";
const PROXY = "https://tiles.example.org";
const GOOGLE_POLICY = { provider: "google-live", attribution: "Google", allowedCache: "memory", ttlS: 0, offline: false, prefetch: false, datasetLicense: "Google Map Tiles API terms", evidenceSha256: null };

let clockMs = 1_800_000_000_000;
function quotaNamespace(): QuotaNamespace {
  const objects = new Map<string, TileQuota>();
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = String(id);
      let object = objects.get(name);
      if (!object) {
        const store = new Map<string, unknown>();
        object = new TileQuota({ storage: { get: k => Promise.resolve(store.get(k)), put: (k, v) => { store.set(k, v); return Promise.resolve(); } } }, undefined, () => clockMs);
        objects.set(name, object);
      }
      return object;
    },
  };
}
function env(overrides: Partial<Env> = {}): Env {
  return { GOOGLE_MAPS_API_KEY: API_KEY, SESSION_SIGNING_KEY: SIGNING, ALLOWED_ORIGINS: `${APP}, http://localhost:5173`, PROVIDER_POLICY: JSON.stringify(GOOGLE_POLICY),
    SESSION_REQUEST_LIMIT: "3", SESSION_ISSUE_LIMIT: "2", QUOTA_WINDOW_S: "60", QUOTA: quotaNamespace(), ...overrides };
}

// Everything a client or log could observe, checked for the key after all tests.
const observed: string[] = [];
const logs: LogEvent[] = [];
const upstreamCalls: URL[] = [];
type Upstream = (url: URL) => Response | Promise<Response>;
let upstream: Upstream = () => new Response("{}", { headers: { "content-type": "application/json" } });
const handler = createHandler({
  fetchUpstream: (url, init) => { upstreamCalls.push(url); expect(init.cache).toBe("no-store"); return Promise.resolve(upstream(url)); },
  log: event => { logs.push(event); },
  nowS: () => Math.floor(clockMs / 1000),
});
async function call(e: Env, path: string, init: RequestInit & { origin?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const origin = init.origin === undefined ? APP : init.origin;
  if (origin !== null) headers.set("Origin", origin);
  const response = await handler(new Request(PROXY + path, { ...init, headers }), e);
  const text = await response.clone().text();
  observed.push(text, JSON.stringify([...response.headers]));
  return response;
}
async function session(e: Env, origin = APP, ip = "198.51.100.7"): Promise<string> {
  const response = await call(e, "/v1/session", { method: "POST", origin, headers: { "CF-Connecting-IP": ip } });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

beforeEach(() => {
  upstream = () => new Response("{}", { headers: { "content-type": "application/json" } });
  upstreamCalls.length = 0;
});

describe("configuration", () => {
  it("fails closed on a missing credential, origins, signing key or a non-Google policy", () => {
    const base = env();
    expect(parseProxyConfig(base).policy.ttlS).toBe(0);
    const bad: Partial<Env>[] = [
      { GOOGLE_MAPS_API_KEY: undefined }, { SESSION_SIGNING_KEY: "short" }, { ALLOWED_ORIGINS: "" },
      { ALLOWED_ORIGINS: "http://sim.example.org" }, { ALLOWED_ORIGINS: "https://sim.example.org/path" }, { PROVIDER_POLICY: "{" },
      { PROVIDER_POLICY: JSON.stringify({ ...GOOGLE_POLICY, allowedCache: "persistent" }) },
      { PROVIDER_POLICY: JSON.stringify({ ...GOOGLE_POLICY, provider: "licensed" }) }, { SESSION_TTL_S: "5" },
    ];
    for (const change of bad) expect(() => parseProxyConfig({ ...base, ...change })).toThrow();
    expect(cacheControl(parseProxyConfig(base).policy)).toBe("no-store");
    expect(cacheControl(providerPolicy({ ...GOOGLE_POLICY, provider: "licensed", ttlS: 600 }))).toBe("private, max-age=600");
  });

  it("answers 503 without detail when misconfigured", async () => {
    const response = await call(env({ SESSION_SIGNING_KEY: undefined }), "/v1/3dtiles/root.json");
    expect(response.status).toBe(503);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("origin and session verification", () => {
  it("rejects missing and foreign origins, and answers preflight for allowed ones", async () => {
    const e = env();
    expect((await call(e, "/v1/session", { method: "POST", origin: null })).status).toBe(403);
    expect((await call(e, "/v1/session", { method: "POST", origin: "https://evil.example" })).status).toBe(403);
    const pre = await call(e, "/v1/3dtiles/root.json", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(APP);
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("X-Mirage-Session");
    expect((await call(e, "/v1/session", { method: "GET" })).status).toBe(405);
  });

  it("rejects missing, tampered, expired and cross-origin sessions before any upstream request", async () => {
    const e = env();
    const token = await session(e);
    const get = (t: string | null, origin = APP) => call(e, "/v1/3dtiles/root.json", { origin, headers: t === null ? {} : { "X-Mirage-Session": t } });
    expect(await (await get(null)).text()).toBe("Session missing");
    const [body, mac] = token.split(".") as [string, string];
    const flipped = mac.slice(0, -2) + (mac.endsWith("AA") ? "BB" : "AA");
    expect(await (await get(`${body}.${flipped}`)).text()).toBe("Session signature");
    expect(await (await get("not-a-token")).text()).toBe("Session malformed");
    expect(await (await get(token, "http://localhost:5173")).text()).toBe("Session origin");
    expect(upstreamCalls).toHaveLength(0);
    clockMs += 3601 * 1000;
    expect(await (await get(token)).text()).toBe("Session expired");
    expect(upstreamCalls).toHaveLength(0);
    // A token signed with another key fails even with valid claims.
    const other = await issueSession(await signingKey("another-secret-0123456789abcdefghij"), APP, Math.floor(clockMs / 1000), 600);
    expect(await (await get(other.token)).text()).toBe("Session signature");
    expect((await verifySession(await signingKey(SIGNING), other.token, APP, 0)).ok).toBe(false);
  });
});

describe("forwarding and provider restrictions", () => {
  it("forwards permitted tile paths with the key only upstream, and keeps Google's session parameter", async () => {
    const e = env();
    const token = await session(e);
    upstream = url => new Response(url.pathname.endsWith(".glb") ? new Uint8Array([0x67, 0x6c, 0x54, 0x46]) : '{"root":{}}', {
      headers: { "content-type": url.pathname.endsWith(".glb") ? "model/gltf-binary" : "application/json", "set-cookie": "tracking=1", etag: '"v1"' },
    });
    const root = await call(e, "/v1/3dtiles/root.json", { headers: { "X-Mirage-Session": token } });
    expect(root.status).toBe(200);
    expect(await root.text()).toBe('{"root":{}}');
    expect(root.headers.get("Access-Control-Allow-Origin")).toBe(APP);
    expect(root.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(root.headers.get("Cache-Control")).toBe("no-store"); // Google live: TTL 0, no retention
    expect(root.headers.get("X-Mirage-Attribution")).toBe("Google");
    expect(root.headers.get("set-cookie")).toBeNull();
    expect(root.headers.get("etag")).toBe('"v1"');
    const glb = await call(e, "/v1/3dtiles/datasets/CgA/files/UlRPVEYu.glb?session=CJ-abc_123", { headers: { "X-Mirage-Session": token } });
    expect(new Uint8Array(await glb.arrayBuffer())).toEqual(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
    expect(upstreamCalls.map(u => u.href)).toEqual([
      `https://tile.googleapis.com/v1/3dtiles/root.json?key=${API_KEY}`,
      `https://tile.googleapis.com/v1/3dtiles/datasets/CgA/files/UlRPVEYu.glb?session=CJ-abc_123&key=${API_KEY}`,
    ]);
    const head = await call(e, "/v1/3dtiles/root.json", { method: "HEAD", headers: { "X-Mirage-Session": token } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("rejects foreign paths, traversal, extra query parameters and client-supplied keys", async () => {
    const e = env();
    const token = await session(e);
    for (const path of ["/v1/2dtiles/root.json", "/v1/3dtiles/../maps", "/v1/3dtiles//root.json", "/v1/3dtiles/root.json?key=stolen",
      "/v1/3dtiles/root.json?session=a&session=b", "/v1/3dtiles/root.json?callback=x", "/", "/v1/3dtiles/root.json?session=%3Cscript%3E"]) {
      expect((await call(e, path, { headers: { "X-Mirage-Session": token } })).status, path).toBe(404);
    }
    expect((await call(e, "/v1/3dtiles/root.json", { method: "POST", headers: { "X-Mirage-Session": token } })).status).toBe(405);
    expect(upstreamCalls).toHaveLength(0);
    expect(upstreamUrl(new URL("https://x/v1/3dtiles/a.json"), "k")?.origin).toBe("https://tile.googleapis.com");
  });

  it("never echoes upstream errors and blocks responses that contain the key", async () => {
    const e = env();
    const token = await session(e);
    const get = () => call(e, "/v1/3dtiles/root.json", { headers: { "X-Mirage-Session": token } });
    upstream = url => new Response(`API key ${url.searchParams.get("key")} rejected`, { status: 403 });
    const denied = await get();
    expect([denied.status, await denied.text()]).toEqual([503, "Upstream provider error"]);
    upstream = url => new Response(JSON.stringify({ next: url.href }), { headers: { "content-type": "application/json" } });
    const leaked = await get();
    expect([leaked.status, await leaked.text()]).toEqual([502, "Upstream response rejected"]);
    expect(logs.some(l => l.type === "key-leak-blocked")).toBe(true);
    upstream = () => { throw new TypeError(`connect failed for key=${API_KEY}`); };
    expect((await get()).status).toBe(502);
  });
});

describe("quotas", () => {
  it("limits tile requests per session and sessions per client IP, resetting each window", async () => {
    const e = env();
    const token = await session(e, APP, "203.0.113.1");
    await session(e, APP, "203.0.113.1");
    expect((await call(e, "/v1/session", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.1" } })).status).toBe(429);
    await session(e, APP, "203.0.113.2"); // per-IP, not global
    const get = () => call(e, "/v1/3dtiles/root.json", { headers: { "X-Mirage-Session": token } });
    for (let i = 0; i < 3; i++) expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429);
    expect(upstreamCalls).toHaveLength(3);
    clockMs += 61_000;
    expect((await get()).status).toBe(200);
  });

  it("rejects malformed quota requests", async () => {
    const quota = new TileQuota({ storage: { get: () => Promise.resolve(undefined), put: () => Promise.resolve() } });
    expect((await quota.fetch(new Request("https://q/", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await quota.fetch(new Request("https://q/", { method: "POST", body: '{"limit":0,"windowS":60}' }))).status).toBe(400);
  });
});

describe("client integration", () => {
  it("requests a validated session and sends it with every tile request", async () => {
    const e = env();
    const viaProxy = (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("Origin", APP);
      return handler(new Request(url, { ...init, headers }), e);
    };
    const tilesSession = await requestTilesSession(PROXY, viaProxy);
    expect(tilesSession.header).toBe("X-Mirage-Session");
    expect(tilesSession.attribution).toBe("Google");
    const tracker = new TileFetchTracker(viaProxy);
    tracker.session = tilesSession;
    const response = await tracker.fetch(`${PROXY}/v1/3dtiles/root.json`);
    expect(response.status).toBe(200);
    tracker.session = null;
    expect((await tracker.fetch(`${PROXY}/v1/3dtiles/root.json`)).status).toBe(401);
    observed.push(JSON.stringify(tilesSession));
    await expect(requestTilesSession(PROXY, () => Promise.resolve(new Response('{"token":"x"}')))).rejects.toThrow("Invalid tiles session response");
    await expect(requestTilesSession(PROXY, () => Promise.resolve(new Response("", { status: 429 })))).rejects.toThrow("HTTP 429");
  });
});

afterAll(() => {
  // No key in any response body/header or log event across the whole suite.
  expect(observed.length).toBeGreaterThan(20);
  expect(logs.length).toBeGreaterThan(20);
  for (const text of [...observed, ...logs.map(l => JSON.stringify(l))]) expect(text).not.toContain(API_KEY);
  expect(logs.some(l => l.type === "tile" && l.path?.includes("session=<"))).toBe(true);
});
