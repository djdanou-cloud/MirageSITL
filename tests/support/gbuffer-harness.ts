// Browser harness for the thermal G-buffer (TASK-073 P5/P6) on WebGL2 and WebGPU:
// renders known geometry over a two-class material raster and compares every
// texel with the AreaThermal table, the class emissivity and the analytic
// camera distance. Scenes: "ground" (camera 10 m above a horizontal plane,
// looking down, north up; west half class 0, east half class 1) and "wall"
// (camera looking west at a vertical plane facing east, class 1).
import {
  DoubleSide, FloatType, Mesh, MeshBasicMaterial, NoBlending, PerspectiveCamera, PlaneGeometry, RenderTarget, Scene, Vector3, WebGLRenderTarget, WebGLRenderer,
} from "three";
import { AreaThermal, TABLE_WIDTH } from "../../packages/thermal/src/area-thermal.ts";
import { parseDataManifest } from "../../packages/thermal/src/data-manifest.ts";
import { MaterialDrape } from "../../apps/web/src/render/material-drape.ts";
import { ThermalGBuffer } from "../../apps/web/src/render/thermal-gbuffer.ts";
import { ThermalGBufferNode } from "../../apps/web/src/render/thermal-gbuffer-node.ts";
import { createWebGpuRenderer } from "../../apps/web/src/render/webgpu.ts";

export interface GBufferComparison { checked: number; worstTemperatureK: number; worstEmissivity: number; worstDistanceRel: number; sky: number; error: string | null; centre?: number[] }

const W = 64, H = 48;
const MATERIALS = ["synthetic-ground", "asphalt"];

function fixture() {
  const area = new AreaThermal(MATERIALS, { latDeg: 32.2, lonDeg: 34.87, startUtcMs: Date.UTC(2026, 6, 15, 7), weather: { airTemperatureK: 303.15, windSpeedMps: 3, cloudFraction: 0.1, deepTemperatureK: 298.15 } });
  area.spinUp();
  // 2 x 2 class raster over 20 m x 20 m: west column class 0, east column class 1.
  const raster = { origin: { latDeg: 32.2, lonDeg: 34.87 }, pixelM: 10, width: 2, height: 2, extentM: { west: -10, east: 10, south: -10, north: 10 },
    materials: MATERIALS, datasets: ["synthetic-grid"] };
  const manifest = parseDataManifest({ schema: "mirage.thermal-data/1", datasets: [{ id: "synthetic-grid", provider: "synthetic", version: "1", license: "CC0-1.0",
    attribution: "MirageSITL synthetic test grid", sha256: null, crs: "EPSG:4326", bounds: { south: 32.1, west: 34.8, north: 32.3, east: 34.9 }, synthetic: true }] });
  const drape = new MaterialDrape(raster, new Uint8Array([0, 1, 0, 1]), manifest);
  return { area, drape };
}

function scene(kind: "ground" | "wall"): { scene: Scene; camera: PerspectiveCamera; plane: Mesh } {
  const s = new Scene();
  const plane = new Mesh(new PlaneGeometry(200, 200), new MeshBasicMaterial({ side: DoubleSide }));
  const camera = new PerspectiveCamera(60, W / H, 0.1, 1000);
  if (kind === "ground") {
    plane.rotation.x = -Math.PI / 2; // horizontal, facing +y (up)
    camera.position.set(0, 10, 0);
    camera.up.set(0, 0, -1); // north (-z) at the top of the image
    camera.lookAt(0, 0, 0);
  } else {
    plane.rotation.y = Math.PI / 2; // vertical, facing +x (east)
    plane.position.set(5, 0, 0);    // inside the east class column
    camera.position.set(9, 0, 0);
    camera.lookAt(5, 0, 0);
  }
  s.add(plane);
  plane.updateMatrixWorld();
  camera.updateMatrixWorld();
  return { scene: s, camera, plane };
}

/** Expected texel at pixel (i, j) with ndc y = ndcY, or null for sky / class-boundary pixels. */
function expected(kind: "ground" | "wall", camera: PerspectiveCamera, area: AreaThermal, i: number, ndcY: number) {
  const ndcX = ((i + 0.5) / W) * 2 - 1;
  const dir = new Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  const o = camera.position;
  // Ground: y = 0; wall: x = 5.
  const s = kind === "ground" ? -o.y / dir.y : (5 - o.x) / dir.x;
  if (!(s > 0)) return null;
  const p = o.clone().addScaledVector(dir, s);
  if (Math.abs(p.x) > 99 || Math.abs(p.z) > 99 || Math.abs(p.y) > 99) return null;
  let cls = 0;
  if (p.x >= -10 && p.x < 10 && -p.z >= -10 && -p.z < 10) cls = p.x >= 0 ? 1 : 0;
  if (Math.abs(p.x) < 0.3 || Math.abs(Math.abs(p.x) - 10) < 0.3 || Math.abs(Math.abs(p.z) - 10) < 0.3) return null; // class edges
  const row = kind === "ground" ? 0 : 1; // up, or the east-facing wall
  return { temperatureK: area.temperatureK[row * TABLE_WIDTH + cls]!, emissivity: area.emissivity[cls]!, distanceM: s };
}

function compare(kind: "ground" | "wall", camera: PerspectiveCamera, area: AreaThermal, floats: Float32Array, rowsTopDown: boolean, stride: number): GBufferComparison {
  let checked = 0, worstT = 0, worstE = 0, worstD = 0, sky = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const ndcY = rowsTopDown ? 1 - ((j + 0.5) / H) * 2 : ((j + 0.5) / H) * 2 - 1;
    const o = j * stride + 4 * i;
    const want = expected(kind, camera, area, i, ndcY);
    if (floats[o + 3]! < 0.5) { sky++; continue; }
    if (!want) continue;
    checked++;
    worstT = Math.max(worstT, Math.abs(floats[o]! - want.temperatureK));
    worstE = Math.max(worstE, Math.abs(floats[o + 1]! - want.emissivity));
    worstD = Math.max(worstD, Math.abs(floats[o + 2]! - want.distanceM) / want.distanceM);
  }
  const c = (H / 2) * stride + 4 * (W / 2);
  return { checked, worstTemperatureK: worstT, worstEmissivity: worstE, worstDistanceRel: worstD, sky, error: null, centre: Array.from(floats.subarray(c, c + 4)) };
}

export async function compareGBuffer(backend: "webgl2" | "webgpu", kind: "ground" | "wall"): Promise<GBufferComparison> {
  const { area, drape } = fixture();
  const { scene: s, camera, plane } = scene(kind);
  try {
    if (backend === "webgl2") {
      const r = new WebGLRenderer({ canvas: document.createElement("canvas") });
      const gbuffer = new ThermalGBuffer(area, drape);
      gbuffer.material.blending = NoBlending;
      const target = new WebGLRenderTarget(W, H, { type: FloatType });
      s.overrideMaterial = gbuffer.material;
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(target);
      r.render(s, camera);
      const floats = new Float32Array(W * H * 4);
      r.readRenderTargetPixels(target, 0, 0, W, H, floats);
      const result = compare(kind, camera, area, floats, false, W * 4);
      gbuffer.dispose(); target.dispose(); r.dispose();
      return result;
    }
    const r = await createWebGpuRenderer({ canvas: document.createElement("canvas"), antialias: false });
    const gbuffer = new ThermalGBufferNode(area, drape);
    const target = new RenderTarget(W, H, { type: FloatType });
    s.overrideMaterial = gbuffer.material;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(target);
    void r.render(s, camera);
    const raw: unknown = await r.readRenderTargetPixelsAsync(target, 0, 0, W, H);
    if (!(raw instanceof Float32Array)) throw new Error("Expected float readback");
    const stride = (Math.ceil((W * 16) / 256) * 256) / 4;
    const result = compare(kind, camera, area, raw, true, stride);
    gbuffer.dispose(); target.dispose(); r.dispose();
    return result;
  } catch (error) {
    return { checked: 0, worstTemperatureK: -1, worstEmissivity: -1, worstDistanceRel: -1, sky: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    plane.geometry.dispose();
    drape.dispose();
  }
}

