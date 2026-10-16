// Tiles proxy policy (TASK-063): configuration validation, origin and session
// verification, and the upstream URL allowlist. Web-platform APIs only
// (Request/URL/crypto.subtle), so it runs in Cloudflare Workers and in Node.
//
// * The provider API key exists only in the Worker secret binding and in the
//   upstream URL built here. It never appears in responses, client-visible
//   URLs, or log events (redactUrl).
// * Sessions are HMAC-SHA256 tokens bound to the requesting origin with an
//   expiry. They limit and attribute use; they do not authenticate a person.
// * Only GET/HEAD of Google Photorealistic 3D Tiles paths are forwarded, and
//   only Google's own `session` query parameter is kept.
import { providerPolicy, type ProviderPolicy } from "../../../packages/terrain/src/provider-policy.ts";

export const UPSTREAM_ORIGIN = "https://tile.googleapis.com";
const TILE_PATH = /^\/v1\/3dtiles\/[A-Za-z0-9_\-./]+$/;
const UPSTREAM_SESSION = /^[A-Za-z0-9_\-.~]{1,512}$/;

export interface ProxyConfig {
  readonly apiKey: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly policy: Readonly<ProviderPolicy>;
  readonly sessionTtlS: number;
  /** Tile requests per session per quota window. */
  readonly sessionRequestLimit: number;
  /** Sessions issued per client IP per quota window. */
  readonly sessionIssueLimit: number;
  readonly quotaWindowS: number;
}

/** Plain-string Worker bindings; validated before any request is served. */
export interface ProxyEnvStrings {
  GOOGLE_MAPS_API_KEY?: unknown;
  SESSION_SIGNING_KEY?: unknown;
  ALLOWED_ORIGINS?: unknown;
  PROVIDER_POLICY?: unknown;
  SESSION_TTL_S?: unknown;
  SESSION_REQUEST_LIMIT?: unknown;
  SESSION_ISSUE_LIMIT?: unknown;
  QUOTA_WINDOW_S?: unknown;
}

function intBinding(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}

/** Fails closed: a missing secret, origin list or policy, or a non-Google policy, rejects the configuration. */
export function parseProxyConfig(env: ProxyEnvStrings): ProxyConfig {
  const apiKey = env.GOOGLE_MAPS_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length < 8) throw new Error("Missing provider credential binding");
  if (typeof env.SESSION_SIGNING_KEY !== "string" || env.SESSION_SIGNING_KEY.length < 32) throw new Error("Missing or short session signing key");
  if (typeof env.ALLOWED_ORIGINS !== "string") throw new Error("Missing allowed origins");
  const origins = new Set<string>();
  for (const raw of env.ALLOWED_ORIGINS.split(",")) {
    const origin = raw.trim();
    if (!origin) continue;
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error("Invalid allowed origin"); }
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.origin !== origin || (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:"))) throw new Error("Invalid allowed origin");
    origins.add(origin);
  }
  if (origins.size === 0) throw new Error("No allowed origins");
  if (typeof env.PROVIDER_POLICY !== "string") throw new Error("Missing provider policy");
  let policyJson: unknown;
  try { policyJson = JSON.parse(env.PROVIDER_POLICY); } catch { throw new Error("Invalid provider policy JSON"); }
  const policy = providerPolicy(policyJson);
  if (policy.provider !== "google-live") throw new Error("The tiles proxy serves only the google-live provider");
  return {
    apiKey,
    allowedOrigins: origins,
    policy,
    sessionTtlS: intBinding(env.SESSION_TTL_S, 3600, 60, 86_400, "SESSION_TTL_S"),
    sessionRequestLimit: intBinding(env.SESSION_REQUEST_LIMIT, 5000, 1, 1_000_000, "SESSION_REQUEST_LIMIT"),
    sessionIssueLimit: intBinding(env.SESSION_ISSUE_LIMIT, 20, 1, 10_000, "SESSION_ISSUE_LIMIT"),
    quotaWindowS: intBinding(env.QUOTA_WINDOW_S, 3600, 60, 86_400, "QUOTA_WINDOW_S"),
  };
}

/** Exact-match origin check; a missing Origin header (non-browser client) is rejected. */
export function allowedOrigin(request: Request, config: ProxyConfig): string | null {
  const origin = request.headers.get("Origin");
  return origin !== null && config.allowedOrigins.has(origin) ? origin : null;
}

/**
 * Forwardable upstream URL (with the key) for a client request URL, or null.
 * Rejects foreign paths, traversal, and every query parameter except Google's
 * `session`; a client-supplied `key` is never forwarded.
 */
export function upstreamUrl(requestUrl: URL, apiKey: string): URL | null {
  const path = requestUrl.pathname;
  if (!TILE_PATH.test(path) || path.includes("..") || path.includes("//")) return null;
  const upstream = new URL(path, UPSTREAM_ORIGIN);
  for (const [name, value] of requestUrl.searchParams) {
    if (name !== "session" || !UPSTREAM_SESSION.test(value) || upstream.searchParams.has("session")) return null;
    upstream.searchParams.set("session", value);
  }
  upstream.searchParams.set("key", apiKey);
  return upstream;
}

/** Path and permitted query only: safe for logs. */
export function redactUrl(url: URL): string {
  const session = url.searchParams.get("session");
  return session === null ? url.pathname : `${url.pathname}?session=<${session.length} chars>`;
}

// ---- Session tokens ----------------------------------------------------------

export interface SessionClaims { sid: string; origin: string; exp: number }

const encoder = new TextEncoder();
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueSession(key: CryptoKey, origin: string, nowS: number, ttlS: number): Promise<{ token: string; claims: SessionClaims }> {
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  const claims: SessionClaims = { sid: base64Url(id), origin, exp: nowS + ttlS };
  const body = base64Url(encoder.encode(JSON.stringify(claims)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return { token: `${body}.${base64Url(mac)}`, claims };
}

export type SessionCheck = { ok: true; claims: SessionClaims } | { ok: false; reason: "missing" | "malformed" | "signature" | "expired" | "origin" };

/** Verifies MAC (constant time via crypto.subtle.verify), expiry, and origin binding. */
export async function verifySession(key: CryptoKey, token: string | null, origin: string, nowS: number): Promise<SessionCheck> {
  if (token === null || token === "") return { ok: false, reason: "missing" };
  if (token.length > 1024) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, macText] = parts as [string, string];
  const mac = fromBase64Url(macText);
  const bodyBytes = fromBase64Url(body);
  if (!mac || !bodyBytes || mac.length !== 32) return { ok: false, reason: "malformed" };
  if (!(await crypto.subtle.verify("HMAC", key, mac, encoder.encode(body)))) return { ok: false, reason: "signature" };
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bodyBytes)); } catch { return { ok: false, reason: "malformed" }; }
  if (typeof parsed !== "object" || parsed === null || !("sid" in parsed) || !("origin" in parsed) || !("exp" in parsed)) return { ok: false, reason: "malformed" };
  const { sid, origin: boundOrigin, exp } = parsed;
  if (typeof sid !== "string" || typeof boundOrigin !== "string" || typeof exp !== "number" || !Number.isSafeInteger(exp)) return { ok: false, reason: "malformed" };
  if (exp <= nowS) return { ok: false, reason: "expired" };
  if (boundOrigin !== origin) return { ok: false, reason: "origin" };
  return { ok: true, claims: { sid, origin: boundOrigin, exp } };
}

/** Cache-Control for proxied tiles: TTL 0 (Google live) forbids any retention. */
export function cacheControl(policy: Readonly<ProviderPolicy>): string {
  return policy.ttlS === 0 ? "no-store" : `private, max-age=${policy.ttlS}`;
}
