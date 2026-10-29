// Browser harness for tests/browser/terrain.spec.ts (TASK-061). Imported through
// the Vite dev server so "three" and the tiles loader resolve to one instance.
import { Box3, Mesh, PerspectiveCamera, Raycaster, Scene, Vector3, WebGLRenderer, type BufferGeometry, type Material, type Object3D } from "three";
import { TilesScene } from "@mirage/terrain/tiles-scene";

export interface TilesScenarioResult {
  models: number;
  boxMin: number[];
  boxMax: number[];
  /** World position of the fixture's north-east corner vertex (glTF x = 100, z = -100: index 20). */
  northEastCorner: number[];
  geometriesLoaded: number;
  resourcesTracked: number;
  resourcesDisposed: number;
  inFlightAfterDispose: number;
  modelsAfterDispose: number;
  failures: { kind: string; status: number }[];
  loadErrors: number;
  attribution: string;
  /** TASK-062: loader byte cap, cached-byte estimate and SSE target while loaded. */
  lruMaxBytes: number;
  cachedBytes: number;
  errorTarget: number;
}

const deg = Math.PI / 180;
export async function runTilesScenario(url: string, origin: { latDeg: number; lonDeg: number; heightM: number },
  timeoutMs = 10_000): Promise<TilesScenarioResult> {
  const canvas = document.createElement("canvas");
  canvas.width = 320; canvas.height = 240;
  const renderer = new WebGLRenderer({ canvas });
  const camera = new PerspectiveCamera(60, 320 / 240, 0.5, 5000);
  camera.position.set(0, 250, 250);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const scene = new Scene();
  const tiles = new TilesScene({ url, attribution: "MirageSITL synthetic test tiles (CC0-1.0)", originLatRad: origin.latDeg * deg,
    originLonRad: origin.lonDeg * deg, originHeightM: origin.heightM, camera, renderer });
  scene.add(tiles.tiles.group);
  const geometriesBefore = renderer.info.memory.geometries;
  const until = performance.now() + timeoutMs;
  while (tiles.modelCount === 0 && tiles.failures.length === 0 && tiles.loadErrors.length === 0 && performance.now() < until) {
    tiles.update();
    renderer.render(scene, camera);
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  for (let i = 0; i < 5; i++) { tiles.update(); renderer.render(scene, camera); await new Promise(resolve => setTimeout(resolve, 16)); }
  const box = new Box3().setFromObject(tiles.tiles.group);
  const corner = new Vector3();
  tiles.tiles.group.traverse(object => {
    if (object instanceof Mesh) corner.fromBufferAttribute((object.geometry as BufferGeometry).getAttribute("position"), 20).applyMatrix4(object.matrixWorld);
  });
  // Track every geometry/material of the loaded models; dispose() must release each one.
  let tracked = 0, disposed = 0;
  tiles.tiles.group.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const resources: (BufferGeometry | Material)[] = [object.geometry as BufferGeometry, ...([] as Material[]).concat(object.material as Material | Material[])];
    for (const resource of resources) { tracked++; resource.addEventListener("dispose", () => { disposed++; }); }
  });
  const result = {
    models: tiles.modelCount,
    boxMin: box.isEmpty() ? [] : box.min.toArray(),
    boxMax: box.isEmpty() ? [] : box.max.toArray(),
    northEastCorner: corner.toArray(),
    geometriesLoaded: renderer.info.memory.geometries - geometriesBefore,
    failures: tiles.failures.map(f => ({ kind: f.kind, status: f.status })),
    loadErrors: tiles.loadErrors.length,
    attribution: tiles.attribution,
    lruMaxBytes: tiles.tiles.lruCache.maxBytesSize,
    cachedBytes: tiles.cachedBytes,
    errorTarget: tiles.tiles.errorTarget,
  };
  tiles.dispose();
  renderer.render(scene, camera);
  const after = { resourcesTracked: tracked, resourcesDisposed: disposed, inFlightAfterDispose: tiles.tracker.inFlight,
    modelsAfterDispose: tiles.modelCount };
  renderer.dispose();
  return { ...result, ...after };
}

export interface QuantizedMeshResult {
  models: number;
  groundY: number | null;
  /** Content URL of the tile model the ray hit last, or null without a hit. */
  hitUrl: string | null;
  /** True when that tile has no children, so no finer tile can replace it. */
  hitLeaf: boolean;
  failures: number;
  loadErrors: number;
}

/**
 * TASK-073: loads a quantized-mesh layer.json through TilesScene and raycasts
 * straight down at the render origin until the hit comes from a leaf tile.
 * Each coarser level's flat ground is a mesh of chords that sags below the
 * ellipsoid (at the origin, 30 km at level 1 and 33 m at level 6), and a slow tile server
 * keeps such a level displayed for many frames, so an unchanged hit does not
 * mean the deepest tiles have replaced the coarse ones.
 */
export async function runQuantizedMeshScenario(url: string, origin: { latDeg: number; lonDeg: number; heightM: number },
  timeoutMs = 20_000): Promise<QuantizedMeshResult> {
  const canvas = document.createElement("canvas");
  canvas.width = 320; canvas.height = 240;
  const renderer = new WebGLRenderer({ canvas });
  const camera = new PerspectiveCamera(60, 320 / 240, 0.5, 50_000);
  camera.position.set(0, 300, 0.01);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const scene = new Scene();
  const tiles = new TilesScene({ url, format: "quantized-mesh", attribution: "MirageSITL synthetic quantized-mesh fixture (CC0-1.0)",
    originLatRad: origin.latDeg * deg, originLonRad: origin.lonDeg * deg, originHeightM: origin.heightM, camera, renderer });
  scene.add(tiles.tiles.group);
  // Each model's root object maps to its tile, so a hit can be traced to the tile that drew it.
  const models = new Map<Object3D, { url: string; tile: { children?: readonly unknown[] } }>();
  tiles.tiles.addEventListener("load-model", event => { models.set(event.scene, { url: event.url, tile: event.tile }); });
  tiles.tiles.addEventListener("dispose-model", event => { models.delete(event.scene); });
  const raycaster = new Raycaster(new Vector3(0, 1000, 0), new Vector3(0, -1, 0));
  const until = performance.now() + timeoutMs;
  let groundY: number | null = null, hitUrl: string | null = null, hitLeaf = false;
  while (performance.now() < until && tiles.failures.length === 0 && tiles.loadErrors.length === 0) {
    tiles.update();
    renderer.render(scene, camera);
    await new Promise(resolve => setTimeout(resolve, 16));
    const hit = raycaster.intersectObject(tiles.tiles.group, true)[0];
    let root: Object3D | null = hit ? hit.object : null;
    while (root !== null && !models.has(root)) root = root.parent;
    const model = root === null ? undefined : models.get(root);
    groundY = hit ? hit.point.y : null;
    hitUrl = model ? model.url : null;
    // The plugin adds a tile's children when it parses the tile, before its model is shown.
    hitLeaf = model !== undefined && (model.tile.children?.length ?? 0) === 0;
    if (hitLeaf) break;
  }
  const result = { models: tiles.modelCount, groundY, hitUrl, hitLeaf, failures: tiles.failures.length, loadErrors: tiles.loadErrors.length };
  tiles.dispose();
  renderer.dispose();
  return result;
}
