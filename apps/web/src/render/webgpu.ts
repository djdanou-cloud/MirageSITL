// WebGPU backend (TASK-066), loaded on demand so the WebGL2 path never pays
// for three/webgpu. The browser chooses the native API (Metal, D3D12 or
// Vulkan) behind WebGPU; this module only requests an adapter.
//
// three's WebGPURenderer silently switches to its own WebGL2 backend when
// WebGPU is unavailable. That is reported here as unavailable instead, so the
// adapter in renderer.ts owns every fallback decision and reason.
import { BoxGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, DirectionalLight, Vector2 } from "three";
import { WebGPURenderer } from "three/webgpu";

export type WebGpuProbe = { available: true; adapter: string } | { available: false; reason: string };

/**
 * Functional availability: an adapter, a device, and one cleared canvas frame
 * that completes without losing the device. Some software adapters expose an
 * adapter but lose the device on first presentation; those are unavailable.
 */
// Share in-flight/result capability per document: repeated device probes can
// reset software GPU contexts and need not return identical driver loss messages.
// Reload the document to retry capability detection after driver/device changes.
let documentProbe:Promise<WebGpuProbe>|null=null;
export function probeWebGpu():Promise<WebGpuProbe> {
  return documentProbe ??= checkWebGpu();
}
async function checkWebGpu(): Promise<WebGpuProbe> {
  if (!globalThis.isSecureContext) return { available: false, reason: "WebGPU requires a secure context" };
  if (!("gpu" in navigator)) return { available: false, reason: "navigator.gpu is not exposed by this browser" };
  let device: GPUDevice | null = null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { available: false, reason: "No WebGPU adapter (GPU blocklisted, disabled or absent)" };
    const info = adapter.info;
    const name = [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") || "unknown adapter";
    device = await adapter.requestDevice();
    const lost = device.lost.then(i => `device lost: ${i.message || i.reason}`);
    const canvas = document.createElement("canvas");
    canvas.width = 4; canvas.height = 4;
    const context = canvas.getContext("webgpu");
    if (!context) return { available: false, reason: "Canvas has no webgpu context" };
    context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque" });
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] }).end();
    device.queue.submit([encoder.finish()]);
    const done = device.queue.onSubmittedWorkDone().then(() => null);
    const failure = await Promise.race([lost, done, new Promise<string>(resolve => setTimeout(() => resolve("WebGPU probe frame timed out"), 5000))]);
    // A loss reported just after completion still means presentation is broken.
    const late = await Promise.race([lost, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    const reason = failure ?? late;
    return reason === null ? { available: true, adapter: name } : { available: false, reason: `WebGPU adapter "${name}" is not functional: ${reason}` };
  } catch (error) {
    return { available: false, reason: `WebGPU probe failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    device?.destroy();
  }
}

export interface WebGpuOptions { canvas: HTMLCanvasElement; antialias: boolean }

/** Initializes a WebGPURenderer on `canvas`; throws when only three's WebGL fallback backend came up. */
export async function createWebGpuRenderer(options: WebGpuOptions): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({ canvas: options.canvas, antialias: options.antialias, powerPreference: "high-performance" });
  await renderer.init();
  if (!("isWebGPUBackend" in renderer.backend) || renderer.backend.isWebGPUBackend !== true) {
    renderer.dispose();
    throw new Error("WebGPURenderer initialized its WebGL fallback backend, not WebGPU");
  }
  // setSize() skips the backend's buffers until init() has finished, so a resize that arrived during
  // init (the app layout settling) left the multisample buffer at the canvas's initial size and the
  // next frame failed validation. Re-apply the current size now that the backend exists.
  const size = renderer.getSize(new Vector2());
  renderer.setSize(size.x, size.y, false);
  return renderer;
}

/** Device of an initialized WebGPU renderer, for validation error scopes. */
export function rendererDevice(renderer: WebGPURenderer): GPUDevice | null {
  const backend = renderer.backend;
  return "device" in backend && backend.device instanceof GPUDevice ? backend.device : null;
}

/**
 * Compiles and renders a lit probe scene (standard material, shadows off)
 * inside a validation error scope and returns the first validation or
 * shader-compilation error, or null.
 */
export async function validateWebGpuPipeline(renderer: WebGPURenderer): Promise<string | null> {
  const device = rendererDevice(renderer);
  if (!device) return "WebGPU device unavailable";
  const scene = new Scene();
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial({ color: 0x70c4b1 });
  scene.add(new Mesh(geometry, material), new DirectionalLight(0xffffff, 2));
  const camera = new PerspectiveCamera(50, 1, 0.1, 10);
  camera.position.set(0, 0, 3);
  device.pushErrorScope("validation");
  try {
    await renderer.compileAsync(scene, camera);
    await renderer.renderAsync(scene, camera);
  } catch (error) {
    await device.popErrorScope();
    return error instanceof Error ? error.message : String(error);
  } finally {
    geometry.dispose();
    material.dispose();
  }
  const error = await device.popErrorScope();
  return error ? error.message : null;
}
