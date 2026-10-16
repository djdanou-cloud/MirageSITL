// Authenticated Google Photorealistic 3D Tiles proxy (TASK-063), a Cloudflare
// Worker. Routes:
//   OPTIONS *                 CORS preflight for allowed origins
//   POST /v1/session          issue an origin-bound session (per-IP quota)
//   GET|HEAD /v1/3dtiles/...  forward to tile.googleapis.com with the key
//                             (X-Mirage-Session required, per-session quota)
// The key lives only in the GOOGLE_MAPS_API_KEY secret binding. Upstream error
// bodies are never echoed, text bodies are checked for the key before they
// leave, and log events carry redacted paths only. Google live tiles are
// never cached or prefetched here (policy TTL 0 -> Cache-Control: no-store).
// Local tests only; deployment needs separate authorization.
import {
  allowedOrigin, cacheControl, issueSession, parseProxyConfig, redactUrl, signingKey, upstreamUrl, verifySession,
  type ProxyConfig, type ProxyEnvStrings,
} from "./policy.ts";

/** Subset of the Durable Object namespace binding used here. */
export interface QuotaNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface Env extends ProxyEnvStrings { QUOTA: QuotaNamespace }

export interface LogEvent { type: string; status: number; path?: string; reason?: string }
export interface HandlerDeps {
  /** Upstream fetch (tests inject a fake); defaults to global fetch. */
  fetchUpstream?: (url: URL, init: RequestInit) => Promise<Response>;
  /** Structured log sink; defaults to console.log of JSON. */
  log?: (event: LogEvent) => void;
  nowS?: () => number;
}

const SESSION_HEADER = "X-Mirage-Session";
const PASS_HEADERS = ["content-type", "content-length", "etag", "last-modified"];

interface Context { config: ProxyConfig; key: CryptoKey }

export function createHandler(deps: HandlerDeps = {}): (request: Request, env: Env) => Promise<Response> {
  const fetchUpstream = deps.fetchUpstream ?? ((url, init) => fetch(url, init));
  const log = deps.log ?? (event => { console.log(JSON.stringify(event)); });
  const nowS = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
  let cached: { env: Env; context: Context } | null = null;

  async function context(env: Env): Promise<Context> {
    if (cached?.env === env) return cached.context;
    const config = parseProxyConfig(env);
    const key = await signingKey(env.SESSION_SIGNING_KEY as string); // validated by parseProxyConfig
    cached = { env, context: { config, key } };
    return cached.context;
  }

  return async (request, env) => {
    let ctx: Context;
    try {
      ctx = await context(env);
    } catch (error) {
      log({ type: "config-error", status: 503, reason: error instanceof Error ? error.message : "invalid" });
      return plain(503, "Tiles proxy is not configured", null);
    }
    const url = new URL(request.url);
    const origin = allowedOrigin(request, ctx.config);
    if (origin === null) {
      log({ type: "origin-rejected", status: 403, path: redactUrl(url) });
      return plain(403, "Origin not allowed", null);
    }
    if (request.method === "OPTIONS") return preflight(origin);
    if (url.pathname === "/v1/session") {
      if (request.method !== "POST") return plain(405, "Method not allowed", origin);
      const client = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (!(await consume(env, `issue:${client}`, ctx.config.sessionIssueLimit, ctx.config.quotaWindowS))) {
        log({ type: "issue-quota", status: 429 });
        return plain(429, "Session quota exceeded", origin);
      }
      const { token, claims } = await issueSession(ctx.key, origin, nowS(), ctx.config.sessionTtlS);
      log({ type: "session-issued", status: 200 });
      return json(200, { token, expiresAtS: claims.exp, attribution: ctx.config.policy.attribution, header: SESSION_HEADER }, origin);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed", origin);
    const target = upstreamUrl(url, ctx.config.apiKey);
    if (target === null) {
      log({ type: "path-rejected", status: 404, path: url.pathname.slice(0, 128) });
      return plain(404, "Not a permitted tiles path", origin);
    }
    const session = await verifySession(ctx.key, request.headers.get(SESSION_HEADER), origin, nowS());
    if (!session.ok) {
      log({ type: "session-rejected", status: 401, reason: session.reason, path: redactUrl(url) });
      return plain(401, `Session ${session.reason}`, origin);
    }
    if (!(await consume(env, `session:${session.claims.sid}`, ctx.config.sessionRequestLimit, ctx.config.quotaWindowS))) {
      log({ type: "session-quota", status: 429, path: redactUrl(url) });
      return plain(429, "Session quota exceeded", origin);
    }
    let upstream: Response;
    try {
      upstream = await fetchUpstream(target, { method: request.method, cache: "no-store", redirect: "error", headers: { Accept: request.headers.get("Accept") ?? "*/*" } });
    } catch {
      log({ type: "upstream-unreachable", status: 502, path: redactUrl(url) });
      return plain(502, "Upstream unavailable", origin);
    }
    if (!upstream.ok) {
      // Never echo the upstream body: provider errors can quote the request.
      const status = upstream.status === 404 ? 404 : upstream.status === 429 || upstream.status === 403 ? 503 : 502;
      log({ type: "upstream-error", status, reason: String(upstream.status), path: redactUrl(url) });
      return plain(status, status === 404 ? "Tile not found" : "Upstream provider error", origin);
    }
    const headers = tileHeaders(origin, ctx.config);
    for (const name of PASS_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const type = upstream.headers.get("content-type") ?? "";
    let body: BodyInit | null = request.method === "HEAD" ? null : upstream.body;
    if (body !== null && /json|text/i.test(type)) {
      const text = await upstream.text();
      if (text.includes(ctx.config.apiKey)) {
        log({ type: "key-leak-blocked", status: 502, path: redactUrl(url) });
        return plain(502, "Upstream response rejected", origin);
      }
      headers.delete("content-length");
      body = text;
    }
    log({ type: "tile", status: 200, path: redactUrl(url) });
    return new Response(body, { status: 200, headers });
  };

  async function consume(env: Env, key: string, limit: number, windowS: number): Promise<boolean> {
    const stub = env.QUOTA.get(env.QUOTA.idFromName(key));
    const response = await stub.fetch(new Request("https://quota.internal/consume", { method: "POST", body: JSON.stringify({ limit, windowS }) }));
    return response.status === 200;
  }
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({ "Cross-Origin-Resource-Policy": "cross-origin", "Vary": "Origin", "Cache-Control": "no-store" });
  if (origin !== null) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}
function tileHeaders(origin: string, config: ProxyConfig): Headers {
  const headers = corsHeaders(origin);
  headers.set("Cache-Control", cacheControl(config.policy));
  headers.set("X-Mirage-Attribution", config.policy.attribution);
  headers.set("Access-Control-Expose-Headers", "X-Mirage-Attribution");
  return headers;
}
function preflight(origin: string): Response {
  const headers = corsHeaders(origin);
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", `${SESSION_HEADER}, Content-Type, Accept`);
  headers.set("Access-Control-Max-Age", "600");
  return new Response(null, { status: 204, headers });
}
function plain(status: number, message: string, origin: string | null): Response {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(message, { status, headers });
}
function json(status: number, value: unknown, origin: string): Response {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), { status, headers });
}

/** Subset of DurableObjectState used by TileQuota. */
export interface QuotaState {
  storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
}

/**
 * Fixed-window counter, one Durable Object per quota key. A Durable Object
 * processes requests for one key serially, so the read-modify-write is
 * atomic across Worker isolates (an in-isolate Map would not be).
 */
export class TileQuota {
  constructor(private readonly state: QuotaState, _env?: unknown, private readonly nowMs: () => number = () => Date.now()) {}

  async fetch(request: Request): Promise<Response> {
    let input: unknown;
    try { input = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
    if (typeof input !== "object" || input === null || !("limit" in input) || !("windowS" in input)) return new Response("bad request", { status: 400 });
    const { limit, windowS } = input;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || typeof windowS !== "number" || !Number.isSafeInteger(windowS) || windowS < 1) {
      return new Response("bad request", { status: 400 });
    }
    const now = this.nowMs();
    const stored = await this.state.storage.get("window");
    let start = now, count = 0;
    if (typeof stored === "object" && stored !== null && "start" in stored && "count" in stored &&
      typeof stored.start === "number" && typeof stored.count === "number" && now - stored.start < windowS * 1000) {
      start = stored.start; count = stored.count;
    }
    if (count >= limit) return new Response("quota", { status: 429 });
    await this.state.storage.put("window", { start, count: count + 1 });
    return new Response("ok", { status: 200 });
  }
}

const handler = createHandler();
export default { fetch: (request: Request, env: Env): Promise<Response> => handler(request, env) };
