// Binds one 3D Tiles source to a three.js scene (TASK-061) with the chosen
// loader, NASA-AMMOS 3d-tiles-renderer 0.5.3 (Apache-2.0). All tile requests go
// through TileFetchTracker via the loader's fetchData plugin hook, the group
// is placed with the float64 ECEF-to-render matrix, attribution is kept for
// display, and dispose() aborts downloads and releases every loaded model.
// TASK-062: the loader's LRU byte cap and SSE error target follow a LodBudget.
// The loader exposes one estimate (geometry + texture bytes); three.js keeps
// the decoded CPU arrays alongside the GPU copies, so the same estimate is
// charged against both budgets and the cap is the smaller of the two.
import { Matrix4, type Camera, type WebGLRenderer } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { TileFetchTracker, ecefToRenderMatrix, type TileFailure } from "./tiles-provider.ts";
import { LodBudget } from "./lod-budget.ts";

export interface TilesSceneOptions {
  url: string;
  attribution: string;
  originLatRad: number;
  originLonRad: number;
  originHeightM: number;
  camera: Camera;
  renderer: WebGLRenderer;
  /** Optional fetch replacement (tests); defaults to the browser fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** LOD budget (default: 2 GiB GPU, 512 MiB decoded CPU). */
  budget?: LodBudget;
}

export class TilesScene {
  readonly tiles: TilesRenderer;
  readonly tracker: TileFetchTracker;
  readonly attribution: string;
  readonly budget: LodBudget;
  /** Loader-level errors (tileset/model parse or fetch failures). */
  readonly loadErrors: { url: string; message: string }[] = [];
  private loadedModels = 0;
  private disposed = false;

  constructor(options: TilesSceneOptions) {
    this.attribution = options.attribution;
    this.tracker = new TileFetchTracker(options.fetchImpl);
    const tiles = new TilesRenderer(options.url);
    const tracker = this.tracker;
    tiles.registerPlugin({ name: "MIRAGE_FETCH_TRACKER", fetchData: (url: string, init: RequestInit) => tracker.fetch(url, init) });
    this.budget = options.budget ?? new LodBudget();
    const capBytes = Math.min(this.budget.gpuBudgetBytes, this.budget.cpuBudgetBytes);
    tiles.lruCache.maxBytesSize = capBytes;
    tiles.lruCache.minBytesSize = 0.75 * capBytes;
    tiles.errorTarget = this.budget.errorTarget;
    tiles.setCamera(options.camera);
    tiles.setResolutionFromRenderer(options.camera, options.renderer);
    const placement = new Matrix4().fromArray(Array.from(ecefToRenderMatrix(options.originLatRad, options.originLonRad, options.originHeightM)));
    tiles.group.matrixAutoUpdate = false;
    tiles.group.matrix.copy(placement);
    tiles.group.updateMatrixWorld(true);
    tiles.addEventListener("load-model", () => { this.loadedModels++; });
    tiles.addEventListener("dispose-model", () => { this.loadedModels--; });
    tiles.addEventListener("load-error", event => {
      if (this.loadErrors.length < 64) this.loadErrors.push({ url: String(event.url), message: event.error.message });
    });
    this.tiles = tiles;
  }

  /** Models currently loaded (and not yet disposed). */
  get modelCount(): number { return this.loadedModels; }
  /** Fetch failures classified by the tracker (CORS/network, HTTP, ...). */
  get failures(): readonly TileFailure[] { return this.tracker.failures; }

  /** Loader byte estimate of cached tiles (geometry + textures). */
  get cachedBytes(): number {
    const bytes: unknown = Reflect.get(this.tiles.lruCache, "cachedBytes"); // runtime field, untyped in 0.5.3
    return typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
  }

  /** Call once per rendered frame (render loop, never the physics step). */
  update(): void {
    if (this.disposed) return;
    const bytes = this.cachedBytes;
    this.tiles.errorTarget = this.budget.update(bytes, bytes);
    this.tiles.update();
  }

  /** Aborts in-flight requests and disposes every loaded model, geometry and texture. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tracker.dispose();
    this.tiles.dispose();
    this.tiles.group.removeFromParent();
  }
}
