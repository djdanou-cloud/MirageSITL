// Browser harness for tests/browser/analog.spec.ts (TASK-068): renders a
// source texture through the real analog GLSL on WebGL2 and returns pixels.
import { DataTexture, Mesh, NearestFilter, OrthographicCamera, PlaneGeometry, RGBAFormat, Scene, UnsignedByteType, WebGLRenderTarget, WebGLRenderer } from "three";
import { AnalogVideo, DEFAULT_VIDEO_NOISE, type VideoNoiseConfig } from "../../packages/cameras/src/analog.ts";
import { createAnalogMaterial } from "../../packages/cameras/src/analog-material.ts";

export type SourceKind = "gray" | "vertical-line";
export interface AnalogFrame { width: number; height: number; red: number[]; shaderErrors: number }

const W = 128, H = 96;

function sourceTexture(kind: SourceKind): DataTexture {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = 4 * (y * W + x);
    const v = kind === "gray" ? 128 : x === W / 2 ? 255 : 0;
    data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
  }
  const t = new DataTexture(data, W, H, RGBAFormat, UnsignedByteType);
  t.minFilter = NearestFilter; t.magFilter = NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

/** Renders one frame for (config, time, throttle); a fresh renderer each call. */
export function renderAnalog(config: Partial<VideoNoiseConfig>, timeS: number, throttle: number, kind: SourceKind): AnalogFrame {
  const video = new AnalogVideo({ ...DEFAULT_VIDEO_NOISE, lines: H, ...config });
  video.update(timeS, throttle);
  const renderer = new WebGLRenderer({ canvas: document.createElement("canvas") });
  let shaderErrors = 0;
  renderer.debug.onShaderError = () => { shaderErrors++; };
  const source = sourceTexture(kind);
  const material = createAnalogMaterial(video, source);
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new Scene(); scene.add(quad);
  const target = new WebGLRenderTarget(W, H, { type: UnsignedByteType });
  renderer.setRenderTarget(target);
  renderer.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  const pixels = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, W, H, pixels);
  const red: number[] = [];
  for (let i = 0; i < W * H; i++) red.push(pixels[4 * i]!); // 4 * i < pixels.length
  material.dispose(); quad.geometry.dispose(); source.dispose(); target.dispose(); renderer.dispose();
  return { width: W, height: H, red, shaderErrors };
}
