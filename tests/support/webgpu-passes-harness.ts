// Browser harness for tests/browser/webgpu-passes.spec.ts (TASK-073 P6): runs
// the TSL node-material ports of the G3 passes on WebGPURenderer and compares
// them with the CPU mirrors (and, where useful, the WebGL2 GLSL output).
import { DataTexture, FloatType, NearestFilter, RGBAFormat, RenderTarget, UnsignedByteType, type Texture } from "three";
import { QuadMesh, type NodeMaterial, type WebGPURenderer } from "three/webgpu";
import { fisheyeParams, fisheyeSourceUvInto, type LensConfig } from "../../packages/cameras/src/fisheye.ts";
import { FisheyeNodeMaterial } from "../../packages/cameras/src/fisheye-node.ts";
import { AnalogVideo, DEFAULT_VIDEO_NOISE, type VideoNoiseConfig } from "../../packages/cameras/src/analog.ts";
import { AnalogNodeMaterial } from "../../packages/cameras/src/analog-node.ts";
import { SYNTHETIC_LWIR_640, apparentLevel, paletteColor, radianceTable, type ThermalPalette, type ThermalScene } from "../../packages/thermal/src/thermal-camera.ts";
import { ThermalCameraNodePass } from "../../packages/thermal/src/thermal-node.ts";
import { SUPERSAMPLE_SCENE, expectedSupersampled, supersampleFixture } from "./thermal-harness.ts";
import { createWebGpuRenderer, probeWebGpu } from "../../apps/web/src/render/webgpu.ts";

export async function webGpuAvailable(): Promise<{ available: boolean; reason: string }> {
  const probe = await probeWebGpu();
  return probe.available ? { available: true, reason: probe.adapter } : { available: false, reason: probe.reason };
}

async function renderer(): Promise<WebGPURenderer> {
  return createWebGpuRenderer({ canvas: document.createElement("canvas"), antialias: false });
}

/** Renders a full-screen node material into a target and reads it back, rows bottom-up (WebGL convention). */
async function renderQuad(r: WebGPURenderer, material: NodeMaterial, width: number, height: number, float = false): Promise<{ bytes: Uint8Array | null; floats: Float32Array | null }> {
  const target = new RenderTarget(width, height, { type: float ? FloatType : UnsignedByteType, depthBuffer: false });
  const quad = new QuadMesh(material);
  r.setRenderTarget(target);
  quad.render(r);
  r.setRenderTarget(null);
  const raw: unknown = await r.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  target.dispose();
  // WebGPU pads each row to 256 bytes: take the stride from the buffer, keep `width` texels per row.
  const tight = <T extends Uint8Array | Float32Array>(src: T, make: (n: number) => T): T => {
    // bytesPerRow is rounded up to a multiple of 256 (the last row may be unpadded).
    const out = make(width * height * 4), row = width * 4, bytesPerTexel = 4 * src.BYTES_PER_ELEMENT;
    const stride = (Math.ceil((width * bytesPerTexel) / 256) * 256) / src.BYTES_PER_ELEMENT;
    for (let j = 0; j < height; j++) out.set(src.subarray(j * stride, j * stride + row), j * row);
    return out;
  };
  if (raw instanceof Float32Array) return { bytes: null, floats: tight(raw, n => new Float32Array(n)) };
  if (raw instanceof Uint8Array) return { bytes: tight(raw, n => new Uint8Array(n)), floats: null };
  throw new Error("Unexpected readback type");
}

function selfAddressingTexture(size: number): Texture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const o = 4 * (y * size + x); data[o] = x; data[o + 1] = y; data[o + 2] = 255; data[o + 3] = 255; }
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.minFilter = NearestFilter; t.magFilter = NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}

export interface FisheyeComparison { pixels: number; mismatched: number; inside: number; worst: number; offBoundaryWorst: number; error: string | null }

/** Same oracle as tests/support/fpv-harness.ts: each output texel names the source texel it sampled. */
export async function compareFisheyeWebGpu(lens: LensConfig, width: number, height: number): Promise<FisheyeComparison> {
  const SRC = 256;
  const r = await renderer();
  const source = selfAddressingTexture(SRC);
  const params = fisheyeParams(lens, width, height);
  const node = new FisheyeNodeMaterial(params, source);
  try {
    const { bytes } = await renderQuad(r, node.material, width, height);
    if (!bytes) throw new Error("Expected byte readback");
    const out = new Float64Array(2);
    let mismatched = 0, inside = 0, worst = 0, offBoundaryWorst = 0;
    // Distance (texels) of a source coordinate from the nearest texel boundary.
    const edge = (x: number) => Math.abs(x * SRC - Math.round(x * SRC));
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const o = 4 * (j * width + i);
      const ok = fisheyeSourceUvInto(params, (i + 0.5) / width, (j + 0.5) / height, out);
      const red = bytes[o]!, green = bytes[o + 1]!, blue = bytes[o + 2]!; // o + 2 < length by construction
      if (!ok) { if (blue !== 0) mismatched++; continue; }
      inside++;
      const ex = Math.min(SRC - 1, Math.floor(out[0]! * SRC)), ey = Math.min(SRC - 1, Math.floor(out[1]! * SRC));
      const err = Math.max(Math.abs(red - ex), Math.abs(green - ey), blue === 255 ? 0 : 255);
      worst = Math.max(worst, err);
      if (edge(out[0]!) > 1e-3 && edge(out[1]!) > 1e-3) offBoundaryWorst = Math.max(offBoundaryWorst, err);
      if (err > 1) mismatched++;
    }
    return { pixels: width * height, mismatched, inside, worst, offBoundaryWorst, error: null };
  } catch (error) {
    return { pixels: width * height, mismatched: -1, inside: 0, worst: -1, offBoundaryWorst: -1, error: error instanceof Error ? error.message : String(error) };
  } finally {
    node.dispose(); source.dispose(); r.dispose();
  }
}

export interface AnalogFrameGpu { width: number; height: number; red: number[]; error: string | null }

/** WebGPU twin of tests/support/analog-harness.ts renderAnalog (same source textures and size). */
export async function renderAnalogWebGpu(config: Partial<VideoNoiseConfig>, timeS: number, throttle: number, kind: "gray" | "vertical-line"): Promise<AnalogFrameGpu> {
  const W = 128, H = 96;
  const video = new AnalogVideo({ ...DEFAULT_VIDEO_NOISE, lines: H, ...config });
  video.update(timeS, throttle);
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = 4 * (y * W + x), v = kind === "gray" ? 128 : x === W / 2 ? 255 : 0;
    data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
  }
  const source = new DataTexture(data, W, H, RGBAFormat, UnsignedByteType);
  source.minFilter = NearestFilter; source.magFilter = NearestFilter; source.generateMipmaps = false; source.needsUpdate = true;
  const r = await renderer();
  const node = new AnalogNodeMaterial(video, source);
  try {
    const { bytes } = await renderQuad(r, node.material, W, H);
    if (!bytes) throw new Error("Expected byte readback");
    const red: number[] = [];
    for (let i = 0; i < W * H; i++) red.push(bytes[4 * i]!); // 4 * i < bytes.length
    return { width: W, height: H, red, error: null };
  } catch (error) {
    return { width: W, height: H, red: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    node.dispose(); source.dispose(); r.dispose();
  }
}

export interface ThermalComparisonGpu { mismatched: number; worst: number; error: string | null }

/**
 * WebGPU twin of compareThermal/compareThermalFpn (tests/support/thermal-harness.ts): a float
 * G-buffer through ThermalCameraNodePass against apparentLevel(). Texel (x, y) of every input is
 * output pixel (x, y) on this backend (rows counted from the top on input and readback alike).
 */
export async function compareThermalWebGpu(palette: ThermalPalette, withFpn: boolean): Promise<ThermalComparisonGpu> {
  const W = 64, H = 48, skyK = 270, driftK = 1.5;
  const scene: ThermalScene = { reflectedK: 250, airK: 288, extinctionPerM: 2e-4, spanMinK: 270, spanMaxK: 320 };
  const profile = { ...SYNTHETIC_LWIR_640, id: "test-64x48", resolution: [W, H] as const };
  const g = new Float32Array(W * H * 4), residual = new Float32Array(W * H), gain = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = 4 * i;
    g[o] = 255 + (80 * x) / (W - 1); g[o + 1] = 0.5 + (0.5 * y) / (H - 1); g[o + 2] = (x * y * 7) % 5000;
    g[o + 3] = withFpn && y < 8 ? 0 : 1;
    residual[i] = ((x % 7) - 3) * 0.4; gain[i] = ((y % 5) - 2) * 0.5;
  }
  const gBuffer = new DataTexture(g, W, H, RGBAFormat, FloatType);
  gBuffer.minFilter = NearestFilter; gBuffer.magFilter = NearestFilter; gBuffer.generateMipmaps = false; gBuffer.needsUpdate = true;
  const r = await renderer();
  const pass = new ThermalCameraNodePass(profile, gBuffer);
  try {
    pass.configure(scene, palette, false);
    if (withFpn) { pass.setFixedPattern(residual, gain); pass.setDriftK(driftK); pass.setSkyK(skyK); }
    pass.render(r);
    const raw: unknown = await r.readRenderTargetPixelsAsync(pass.target, 0, 0, W, H);
    if (!(raw instanceof Uint8Array)) throw new Error("Expected byte readback");
    const stride = Math.ceil((W * 4) / 256) * 256;
    const table = radianceTable(profile.spectralBandUm);
    const c = new Float64Array(3);
    let mismatched = 0, worst = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, sky = g[4 * i + 3]! < 0.5;
      const t = (sky ? skyK : g[4 * i]!) + (withFpn ? residual[i]! + gain[i]! * driftK : 0);
      paletteColor(palette, apparentLevel(table, t, sky ? 1 : g[4 * i + 1]!, sky ? 0 : g[4 * i + 2]!, scene), c);
      let err = 0;
      for (let k = 0; k < 3; k++) err = Math.max(err, Math.abs(raw[y * stride + 4 * x + k]! - Math.round(c[k]! * 255)));
      worst = Math.max(worst, err);
      if (err > 2) mismatched++;
    }
    return { mismatched, worst, error: null };
  } catch (error) {
    return { mismatched: -1, worst: -1, error: error instanceof Error ? error.message : String(error) };
  } finally {
    pass.dispose(); gBuffer.dispose(); r.dispose();
  }
}

/** WebGPU twin of compareThermalSupersampled (tests/support/thermal-harness.ts). */
export async function compareThermalSupersampledWebGpu(): Promise<ThermalComparisonGpu> {
  const W = 64, H = 48, S = 2, skyK = 260;
  const profile = { ...SYNTHETIC_LWIR_640, id: "test-64x48", resolution: [W, H] as const };
  const g = supersampleFixture(W, H, S);
  const gBuffer = new DataTexture(g, W * S, H * S, RGBAFormat, FloatType);
  gBuffer.minFilter = NearestFilter; gBuffer.magFilter = NearestFilter; gBuffer.generateMipmaps = false; gBuffer.needsUpdate = true;
  const r = await renderer();
  const pass = new ThermalCameraNodePass(profile, gBuffer, S);
  try {
    pass.configure(SUPERSAMPLE_SCENE, "white-hot", false);
    pass.setSkyK(skyK);
    pass.render(r);
    const raw: unknown = await r.readRenderTargetPixelsAsync(pass.target, 0, 0, W, H);
    if (!(raw instanceof Uint8Array)) throw new Error("Expected byte readback");
    const stride = Math.ceil((W * 4) / 256) * 256;
    let mismatched = 0, worst = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const err = Math.abs(raw[y * stride + 4 * x]! - Math.round(expectedSupersampled(g, W, H, S, x, y, skyK) * 255));
      worst = Math.max(worst, err);
      if (err > 2) mismatched++;
    }
    return { mismatched, worst, error: null };
  } catch (error) {
    return { mismatched: -1, worst: -1, error: error instanceof Error ? error.message : String(error) };
  } finally {
    pass.dispose(); gBuffer.dispose(); r.dispose();
  }
}
