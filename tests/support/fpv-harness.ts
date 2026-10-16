// Browser harness for tests/browser/fpv.spec.ts (TASK-067): runs the real
// fisheye GLSL over a source texture whose texels encode their own (x, y),
// so every output pixel reveals which source texel the shader sampled.
import { DataTexture, Mesh, NearestFilter, OrthographicCamera, PlaneGeometry, RGBAFormat, Scene, UnsignedByteType, WebGLRenderTarget, WebGLRenderer } from "three";
import { fisheyeParams, fisheyeSourceUvInto, type LensConfig } from "../../packages/cameras/src/fisheye.ts";
import { createFisheyeMaterial } from "../../packages/cameras/src/fisheye-material.ts";

const SRC = 256;
export interface FisheyeComparison { pixels: number; mismatched: number; inside: number; worst: number; shaderErrors: number }

export function compareShaderWithCpu(lens: LensConfig, width: number, height: number): FisheyeComparison {
  const data = new Uint8Array(SRC * SRC * 4);
  for (let y = 0; y < SRC; y++) for (let x = 0; x < SRC; x++) { const o = 4 * (y * SRC + x); data[o] = x; data[o + 1] = y; data[o + 2] = 255; data[o + 3] = 255; }
  const source = new DataTexture(data, SRC, SRC, RGBAFormat, UnsignedByteType);
  source.minFilter = NearestFilter; source.magFilter = NearestFilter; source.generateMipmaps = false; source.needsUpdate = true;
  const params = fisheyeParams(lens, width, height);
  const canvas = document.createElement("canvas");
  const renderer = new WebGLRenderer({ canvas });
  let shaderErrors = 0;
  renderer.debug.onShaderError = () => { shaderErrors++; };
  const target = new WebGLRenderTarget(width, height, { type: UnsignedByteType });
  const material = createFisheyeMaterial(params, source);
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new Scene(); scene.add(quad);
  renderer.setRenderTarget(target);
  renderer.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  const out = new Float64Array(2);
  let mismatched = 0, inside = 0, worst = 0;
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const o = 4 * (j * width + i);
    const ok = fisheyeSourceUvInto(params, (i + 0.5) / width, (j + 0.5) / height, out);
    const r = pixels[o]!, g = pixels[o + 1]!, b = pixels[o + 2]!; // o + 2 < pixels.length by construction
    if (!ok) { if (b !== 0) mismatched++; continue; }
    inside++;
    const ex = Math.min(SRC - 1, Math.floor(out[0]! * SRC)), ey = Math.min(SRC - 1, Math.floor(out[1]! * SRC));
    const err = Math.max(Math.abs(r - ex), Math.abs(g - ey), b === 255 ? 0 : 255);
    worst = Math.max(worst, err);
    if (err > 1) mismatched++;
  }
  material.dispose(); quad.geometry.dispose(); source.dispose(); target.dispose(); renderer.dispose();
  return { pixels: width * height, mismatched, inside, worst, shaderErrors };
}
