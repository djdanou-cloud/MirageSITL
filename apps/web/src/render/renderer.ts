// Renderer adapter (TASK-066): one entry point for the WebGPU and WebGL2
// backends with explicit fallback reasons and resource lifecycle.
//
// * Common capability surface: render(scene, camera), setSize/setPixelRatio,
//   info.memory, dispose. Scenes use core three materials that both backends
//   translate (WebGPU through node materials).
// * WebGPU is probed, initialized and validated (lit probe scene inside a
//   validation error scope, plus an optional caller probe) on a scratch
//   canvas first: a canvas that once returned a "webgpu" context can never
//   return "webgl2", so a failure must not touch the target canvas.
// * WebGL2 materials whose shaders fail to compile or link are replaced by a
//   basic fallback material (compileWithFallback), recorded with the reason.
// * dispose(scene) releases every geometry, material and texture reachable
//   from the scene, then the renderer (and its WebGL context).
import {
  Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Texture, WebGLRenderTarget, WebGLRenderer, type Camera, type Material, type Object3D,
} from "three";

export type RendererMode = "webgl2" | "webgpu";
export interface BackendAvailability { available: boolean; reason: string | null; detail: string | null }

/** The capability surface shared by both backends. */
export interface CommonRenderer {
  readonly domElement: HTMLCanvasElement;
  render(scene: Object3D, camera: Camera): unknown;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setPixelRatio(ratio: number): void;
  readonly info: { memory: { geometries: number; textures: number } };
  dispose(): void;
}

export interface ShaderFallback { material: string; reason: string }

export interface RendererHandle {
  readonly requested: RendererMode;
  readonly backend: RendererMode;
  /** Why the requested backend was not used (null when it was). */
  readonly fallbackReason: string | null;
  readonly renderer: CommonRenderer;
  readonly shaderFallbacks: ShaderFallback[];
  /** Checks every material's program, replacing WebGL2 materials whose shaders fail (no-op on WebGPU, validated at creation). */
  compileWithFallback(scene: Scene, camera: Camera): void;
  dispose(scene?: Object3D): void;
  readonly disposed: boolean;
}

export interface CreateRendererOptions {
  canvas: HTMLCanvasElement;
  mode: RendererMode;
  antialias?: boolean;
  /** Extra WebGPU validation (tests inject failures); a throw or string result triggers the WebGL2 fallback. */
  webgpuProbe?: (renderer: CommonRenderer) => Promise<string | null> | string | null;
}

/** Reports which backends this browser can create, with the reason when not. */
export async function detectBackends(): Promise<Record<RendererMode, BackendAvailability>> {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  const webgl2: BackendAvailability = gl
    ? { available: true, reason: null, detail: gl.getParameter(gl.VERSION) as string }
    : { available: false, reason: "WebGL2 context creation failed", detail: null };
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  const { probeWebGpu } = await import("./webgpu.ts");
  const probe = await probeWebGpu();
  const webgpu: BackendAvailability = probe.available
    ? { available: true, reason: null, detail: probe.adapter }
    : { available: false, reason: probe.reason, detail: null };
  return { webgl2, webgpu };
}

export async function createRenderer(options: CreateRendererOptions): Promise<RendererHandle> {
  const antialias = options.antialias ?? true;
  let fallbackReason: string | null = null;
  if (options.mode === "webgpu") {
    const reason = await webGpuFailure(options, antialias);
    if (reason === null) {
      const { createWebGpuRenderer } = await import("./webgpu.ts");
      return new Handle("webgpu", "webgpu", null, await createWebGpuRenderer({ canvas: options.canvas, antialias }));
    }
    fallbackReason = reason;
  }
  const renderer = new WebGLRenderer({ canvas: options.canvas, antialias, powerPreference: "high-performance" });
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    throw new Error("WebGL2 is unavailable");
  }
  return new Handle(options.mode, "webgl2", fallbackReason, renderer);
}

/** Runs the whole WebGPU bring-up on a scratch canvas; returns the failure reason or null. */
async function webGpuFailure(options: CreateRendererOptions, antialias: boolean): Promise<string | null> {
  const { probeWebGpu, createWebGpuRenderer, validateWebGpuPipeline } = await import("./webgpu.ts");
  const probe = await probeWebGpu();
  if (!probe.available) return probe.reason;
  const scratch = document.createElement("canvas");
  scratch.width = 64; scratch.height = 64;
  let renderer: Awaited<ReturnType<typeof createWebGpuRenderer>> | null = null;
  try {
    renderer = await createWebGpuRenderer({ canvas: scratch, antialias });
    const pipelineError = await validateWebGpuPipeline(renderer);
    if (pipelineError !== null) return `WebGPU pipeline validation failed: ${pipelineError}`;
    const custom = options.webgpuProbe ? await options.webgpuProbe(renderer) : null;
    return custom === null ? null : `WebGPU probe failed: ${custom}`;
  } catch (error) {
    return `WebGPU initialization failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    renderer?.dispose();
  }
}

class Handle implements RendererHandle {
  readonly shaderFallbacks: ShaderFallback[] = [];
  private disposedFlag = false;
  constructor(readonly requested: RendererMode, readonly backend: RendererMode, readonly fallbackReason: string | null, readonly renderer: CommonRenderer & object) {}

  get disposed(): boolean { return this.disposedFlag; }

  compileWithFallback(scene: Scene, camera: Camera): void {
    const renderer = this.renderer;
    if (!(renderer instanceof WebGLRenderer)) return;
    // Compile each distinct material alone so a failure maps to its material.
    const users = new Map<Material, Mesh[]>();
    scene.traverse(object => {
      if (!isMesh(object)) return;
      for (const material of materialsOf(object)) {
        const list = users.get(material);
        if (list) list.push(object); else users.set(material, [object]);
      }
    });
    const probeScene = new Scene();
    probeScene.fog = scene.fog;
    // three checks shader status lazily on first use, so each material is
    // drawn once into a 1x1 target (never the visible canvas).
    const target = new WebGLRenderTarget(1, 1);
    const previousTarget = renderer.getRenderTarget();
    let failure: string | null = null;
    const previous = renderer.debug.onShaderError;
    renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      failure = gl.getShaderInfoLog(fragmentShader) || gl.getShaderInfoLog(vertexShader) || gl.getProgramInfoLog(program) || "shader compile failed";
    };
    try {
      for (const [material, meshes] of users) {
        failure = null;
        const probe = new Mesh(meshes[0]!.geometry, material); // users lists are non-empty by construction
        probeScene.add(probe);
        renderer.setRenderTarget(target);
        renderer.render(probeScene, camera);
        probeScene.remove(probe);
        if (failure === null) continue;
        const fallback = new MeshBasicMaterial({ color: 0xff00ff, name: `fallback:${material.name || material.type}` });
        for (const mesh of meshes) mesh.material = Array.isArray(mesh.material) ? mesh.material.map(m => (m === material ? fallback : m)) : fallback;
        this.shaderFallbacks.push({ material: material.name || material.type, reason: String(failure).slice(0, 500) });
        material.dispose();
      }
    } finally {
      renderer.setRenderTarget(previousTarget);
      target.dispose();
      renderer.debug.onShaderError = previous;
    }
  }

  dispose(scene?: Object3D): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    if (scene) disposeSceneResources(scene);
    this.renderer.dispose();
    if (this.renderer instanceof WebGLRenderer) this.renderer.forceContextLoss();
  }
}

/** instanceof narrows to Mesh<any>; this guard keeps the default generic types. */
function isMesh(object: Object3D): object is Mesh {
  return object instanceof Mesh;
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** Disposes every geometry, material and material texture reachable from `root`, once each. */
export function disposeSceneResources(root: Object3D): { geometries: number; materials: number; textures: number } {
  const geometries = new Set<{ dispose(): void }>(), materials = new Set<Material>(), textures = new Set<Texture>();
  root.traverse(object => {
    if (!isMesh(object)) return;
    geometries.add(object.geometry);
    for (const material of materialsOf(object)) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  for (const g of geometries) g.dispose();
  for (const t of textures) t.dispose();
  for (const m of materials) m.dispose();
  return { geometries: geometries.size, materials: materials.size, textures: textures.size };
}

/** A default perspective camera helper for probes and tests. */
export function probeCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 3);
  return camera;
}

/** `?renderer=webgpu|webgl2` opts into the adapter; null keeps the default WebGL renderer. */
export function rendererModeFromSearch(search: string): RendererMode | null {
  const value = new URLSearchParams(search).get("renderer");
  return value === "webgpu" || value === "webgl2" ? value : null;
}

/**
 * React Three Fiber `gl` factory for a requested mode. The chosen backend and
 * any fallback reason are exposed on the canvas as data-render-backend and
 * data-render-fallback.
 */
export function rendererFactory(mode: RendererMode): (defaults: { canvas: EventTarget }) => Promise<CommonRenderer> {
  return async ({ canvas }) => {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("The renderer adapter needs an HTMLCanvasElement");
    const handle = await createRenderer({ canvas, mode });
    canvas.dataset.renderBackend = handle.backend;
    if (handle.fallbackReason !== null) canvas.dataset.renderFallback = handle.fallbackReason;
    return handle.renderer;
  };
}
