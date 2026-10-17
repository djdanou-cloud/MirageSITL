// Browser harness for tests/browser/render-backends.spec.ts (TASK-066), loaded
// through the Vite dev server so "three" resolves to one instance.
import { BoxGeometry, Color, DataTexture, DirectionalLight, AmbientLight, Mesh, MeshStandardMaterial, RGBAFormat, Scene, ShaderMaterial, WebGLRenderer } from "three";
import { createRenderer, detectBackends, disposeSceneResources, probeCamera, type RendererMode } from "../../apps/web/src/render/renderer.ts";

export { detectBackends };

export interface BackendRun {
  backend: RendererMode;
  fallbackReason: string | null;
  centerPixel: number[];
  memoryBefore: { geometries: number; textures: number };
  memoryBaseline: { geometries: number; textures: number };
  memoryAfterSceneDispose: { geometries: number; textures: number };
  memoryAfterRendererDispose: { geometries: number; textures: number };
  released: { geometries: number; materials: number; textures: number };
  contextLost: boolean | null;
  shaderFallbacks: { material: string; reason: string }[];
  disposed: boolean;
}

function texture(): DataTexture {
  const data = new Uint8Array(4 * 4 * 4).fill(255);
  const t = new DataTexture(data, 4, 4, RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** Renders a lit textured box (optionally with a broken shader material) and disposes everything. */
export async function runBackend(mode: RendererMode, options: { injectWebGpuFailure?: string; brokenShader?: boolean } = {}): Promise<BackendRun> {
  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 64;
  document.body.appendChild(canvas);
  const handle = await createRenderer({ canvas, mode, antialias: false,
    webgpuProbe: options.injectWebGpuFailure === undefined ? undefined : () => options.injectWebGpuFailure ?? null });
  handle.renderer.setSize(64, 64, false);
  const scene = new Scene();
  scene.background = new Color(0x000000);
  const camera = probeCamera();
  // Initialize renderer-owned output resources before measuring scene ownership.
  handle.renderer.render(scene, camera);
  const memoryBaseline = { ...handle.renderer.info.memory };
  const material = options.brokenShader
    ? new ShaderMaterial({ name: "broken", vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "void main() { gl_FragColor = vec4(undefinedSymbol, 1.0); }" })
    : new MeshStandardMaterial({ color: 0x70c4b1, map: texture() });
  scene.add(new Mesh(new BoxGeometry(1.5, 1.5, 1.5), material), new DirectionalLight(0xffffff, 2), new AmbientLight(0xffffff, 1));
  handle.compileWithFallback(scene, camera);
  handle.renderer.render(scene, camera);
  if (handle.backend === "webgpu") await new Promise(resolve => requestAnimationFrame(resolve));
  const copy = document.createElement("canvas");
  copy.width = 64; copy.height = 64;
  const ctx = copy.getContext("2d")!; // 2D contexts are always available
  if (handle.backend === "webgl2") handle.renderer.render(scene, camera); // draw in the same task as the copy
  ctx.drawImage(canvas, 0, 0);
  const centerPixel = Array.from(ctx.getImageData(32, 32, 1, 1).data);
  const memoryBefore = { ...handle.renderer.info.memory };
  const released = disposeSceneResources(scene);
  if (handle.backend === "webgpu") handle.renderer.render(new Scene(), camera); // let the backend observe disposals
  const memoryAfterSceneDispose = { geometries: handle.renderer.info.memory.geometries, textures: handle.renderer.info.memory.textures };
  handle.dispose();
  const memoryAfterRendererDispose = { ...handle.renderer.info.memory };
  const r = handle.renderer;
  const contextLost = r instanceof WebGLRenderer ? r.getContext().isContextLost() : null;
  canvas.remove();
  return { backend: handle.backend, fallbackReason: handle.fallbackReason, centerPixel, memoryBefore, memoryBaseline, memoryAfterSceneDispose, memoryAfterRendererDispose, released, contextLost,
    shaderFallbacks: handle.shaderFallbacks, disposed: handle.disposed };
}
