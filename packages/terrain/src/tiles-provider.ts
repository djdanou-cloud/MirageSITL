// 3D Tiles source resolution, placement and request tracking (TASK-061).
// Rendering-free so it runs in Node tests; tiles-scene.ts binds it to the
// chosen loader (NASA-AMMOS 3d-tiles-renderer 0.5.3, Apache-2.0).
//
// * Sources go through the TASK-060 ProviderPolicy. Google live tiles need the
//   authenticated proxy (TASK-063) and provider credentials; API keys never
//   enter the client, so without a proxy URL the source is BLOCKED_EXTERNAL
//   while local licensed fixtures keep working.
// * Placement: tilesets are in ECEF; the scene renders in a local frame at a
//   geodetic origin. The ECEF-to-render matrix is computed in float64:
//   render = B * R_ecef->ned * (ecef - origin), with render x = east,
//   y = up, z = -north (apps/web/src/coordinates.ts).
// * Every tile request goes through TileFetchTracker: in-flight requests are
//   counted, abort on dispose, and failures are classified so CORS/COEP or
//   network problems are shown instead of silently missing terrain.
import { LocalTangentFrame } from "@mirage/sensors/geodesy";
import type { ProviderPolicy } from "./provider-policy.ts";

export type TilesSource =
  | { kind: "local"; tilesetUrl: string; policy: Readonly<ProviderPolicy> }
  | { kind: "google-live"; proxyUrl: string | null; policy: Readonly<ProviderPolicy> };

export type TilesResolution =
  | { status: "READY"; url: string; attribution: string }
  | { status: "BLOCKED_EXTERNAL"; reason: string };

/** Resolves a configured source to a loadable URL, or the exact external blocker. */
export function resolveTilesSource(source: TilesSource): TilesResolution {
  if (source.kind === "google-live") {
    if (source.policy.provider !== "google-live") return { status: "BLOCKED_EXTERNAL", reason: "Google tiles require a google-live provider policy" };
    if (!source.proxyUrl) {
      return { status: "BLOCKED_EXTERNAL", reason: "Live Google 3D Tiles require the authenticated tiles proxy (TASK-063) with provider credentials; no API key is ever placed in the client" };
    }
    return { status: "READY", url: source.proxyUrl, attribution: source.policy.attribution };
  }
  if (source.policy.provider !== "licensed") return { status: "BLOCKED_EXTERNAL", reason: "Local tilesets require a licensed provider policy" };
  if (!/\.json(\?|$)/.test(source.tilesetUrl)) return { status: "BLOCKED_EXTERNAL", reason: "Tileset URL must reference a tileset JSON" };
  return { status: "READY", url: source.tilesetUrl, attribution: source.policy.attribution };
}

/**
 * Column-major 4x4 (three.js Matrix4.elements order) mapping ECEF metres to
 * the local render frame at the origin. Computed in float64.
 */
export function ecefToRenderMatrix(originLatRad: number, originLonRad: number, originHeightM: number): Float64Array {
  const frame = new LocalTangentFrame(originLatRad, originLonRad, originHeightM);
  const r = frame.ecefToNed, o = frame.originEcefM;
  // Rows of B*R: render x = east row, y = -down row, z = -north row.
  const rows = [
    [r[3]!, r[4]!, r[5]!],
    [-r[6]!, -r[7]!, -r[8]!],
    [-r[0]!, -r[1]!, -r[2]!],
  ];
  const m = new Float64Array(16);
  for (let row = 0; row < 3; row++) {
    const q = rows[row]!;
    m[row] = q[0]!; m[4 + row] = q[1]!; m[8 + row] = q[2]!;
    m[12 + row] = -(q[0]! * o[0]! + q[1]! * o[1]! + q[2]! * o[2]!);
  }
  m[15] = 1;
  return m;
}

export type TileFailureKind = "aborted" | "http" | "cors-or-network" | "unknown";
export interface TileFailure { url: string; kind: TileFailureKind; status: number; message: string }

/** Classifies a failed tile request. Browsers report CORS/COEP blocks and network errors as TypeError. */
export function classifyTileFailure(error: unknown, response?: { status: number; ok: boolean }): TileFailureKind {
  if (response && !response.ok) return "http";
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") return "aborted";
  if (error instanceof TypeError) return "cors-or-network";
  return "unknown";
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Counts and aborts tile requests and records classified failures (I/O side, not the physics loop). */
export class TileFetchTracker {
  readonly failures: TileFailure[] = [];
  private readonly controllers = new Set<AbortController>();
  private disposed = false;
  constructor(private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init), private readonly maxFailures = 64) {}

  get inFlight(): number { return this.controllers.size; }

  /** fetch() with an abort signal chained to `init.signal` and to dispose(). */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (this.disposed) throw new DOMException("Tiles source disposed", "AbortError");
    const controller = new AbortController();
    const upstream = init.signal;
    const relay = () => controller.abort(upstream?.reason);
    if (upstream?.aborted) controller.abort(upstream.reason);
    upstream?.addEventListener("abort", relay, { once: true });
    this.controllers.add(controller);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal, mode: "cors", credentials: "omit" });
      if (!response.ok) this.record(url, classifyTileFailure(null, response), response.status, `HTTP ${response.status}`);
      return response;
    } catch (error) {
      const kind = classifyTileFailure(error);
      if (kind !== "aborted") this.record(url, kind, 0, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.controllers.delete(controller);
      upstream?.removeEventListener("abort", relay);
    }
  }

  private record(url: string, kind: TileFailureKind, status: number, message: string): void {
    if (this.failures.length < this.maxFailures) this.failures.push({ url, kind, status, message });
  }

  /** Aborts every in-flight request; later requests fail immediately. */
  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort(new DOMException("Tiles source disposed", "AbortError"));
    this.controllers.clear();
  }
}
