// Binds one 3D Tiles source to a three.js scene (TASK-061) with the chosen
// loader, NASA-AMMOS 3d-tiles-renderer 0.5.3 (Apache-2.0). All tile requests go
// through TileFetchTracker via the loader's fetchData plugin hook, the group
// is placed with the float64 ECEF-to-render matrix, attribution is kept for
// display, and dispose() aborts downloads and releases every loaded model.
// TASK-062: the loader's LRU byte cap and SSE error target follow a LodBudget.
// The loader exposes one estimate (geometry + texture bytes); three.js keeps
// the decoded CPU arrays alongside the GPU copies, so the same estimate is
// charged against both budgets and the cap is the smaller of the two.
import { Matrix4, Mesh, MeshStandardMaterial, type Camera, type Object3D, type WebGLRenderer } from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { ImplicitTilingPlugin } from "3d-tiles-renderer/core/plugins";
import { QuantizedMeshPlugin } from "3d-tiles-renderer/three/plugins";
import { TileFetchTracker, ecefToRenderMatrix, type TileFailure, type TilesSession } from "./tiles-provider.ts";
import { LodBudget } from "./lod-budget.ts";

/** "3d-tiles": a tileset JSON; "quantized-mesh": a Cesium terrain layer.json (TASK-073), tiled by QuantizedMeshPlugin. */
export type TilesFormat = "3d-tiles" | "quantized-mesh";

export interface TilesSceneOptions {
  url: string;
  /** Default "3d-tiles". */
  format?: TilesFormat;
  attribution: string;
  originLatRad: number;
  originLonRad: number;
  originHeightM: number;
  camera: Camera;
  renderer: WebGLRenderer;
  /** Optional fetch replacement (tests); defaults to the browser fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Tiles-proxy session sent with every request (google-live through TASK-063). */
  session?: TilesSession;
  /** LOD budget (default: 2 GiB GPU, 512 MiB decoded CPU). */
  budget?: LodBudget;
  /** Ground colour for quantized-mesh terrain (sRGB hex); default a matte desert earth tone. */
  groundColor?: number;
  /** Called once per quantized-mesh tile material after tinting (e.g. the TASK-073 material drape). */
  onGroundMaterial?: (material: MeshStandardMaterial) => void;
}

const DEFAULT_GROUND_COLOR = 0x9c8b6a;

/** Recolours the materials of one loaded terrain tile in place (no new materials, nothing to dispose). */
function tintGround(model: Object3D, color: number, hook: ((material: MeshStandardMaterial) => void) | null): void {
  model.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const materials: unknown[] = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof MeshStandardMaterial)) continue;
      material.color.setHex(color);
      material.roughness = 1;
      material.metalness = 0;
      hook?.(material);
    }
  });
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
    this.tracker.session = options.session ?? null;
    const tiles = new TilesRenderer(options.url);
    const tracker = this.tracker;
    tiles.registerPlugin({ name: "MIRAGE_FETCH_TRACKER", fetchData: (url: string, init: RequestInit) => tracker.fetch(url, init) });
    // Quantized-mesh terrain: the plugin reads layer.json next to the URL and builds ECEF tiles, placed like any 3D Tiles content.
    if (options.format === "quantized-mesh") tiles.registerPlugin(new QuantizedMeshPlugin({ useRecommendedSettings: true }));
    // 3D Tiles 1.1 implicit tiling (pg2b3dm buildings: subtrees + {level}_{x}_{y} content); explicit tilesets are unaffected.
    else tiles.registerPlugin(new ImplicitTilingPlugin());
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
    // Quantized-mesh tiles carry no colour: give the ground a matte earth tone (display only).
    const tint = options.format === "quantized-mesh" ? (options.groundColor ?? DEFAULT_GROUND_COLOR) : null;
    tiles.addEventListener("load-model", event => {
      this.loadedModels++;
      if (tint !== null) tintGround(event.scene, tint, options.onGroundMaterial ?? null);
    });
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
