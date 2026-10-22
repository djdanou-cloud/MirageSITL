// Browser harness for tests/browser/thermal.spec.ts (TASK-071): runs the real
// thermal GLSL over a float G-buffer and compares it with the CPU mirror.
import { DataTexture, FloatType, NearestFilter, RGBAFormat, WebGLRenderer } from "three";
import {
  SYNTHETIC_LWIR_640, apparentLevel, apparentTableRadiance, levelFromRadiance, paletteColor, radianceTable, type ThermalPalette, type ThermalScene,
} from "../../packages/thermal/src/thermal-camera.ts";
import { ThermalCameraPass } from "../../packages/thermal/src/thermal-material.ts";

export interface ThermalComparison { width: number; height: number; targetSize: number[]; mismatched: number; worst: number; shaderErrors: number; corners: number[][] }

const scene: ThermalScene = { reflectedK: 250, airK: 288, extinctionPerM: 2e-4, spanMinK: 270, spanMaxK: 320 };

export function compareThermal(palette: ThermalPalette, constantK: number | null): ThermalComparison {
  const W = 64, H = 48;
  const profile = { ...SYNTHETIC_LWIR_640, id: "test-64x48", resolution: [W, H] as const };
  const g = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = 4 * (y * W + x);
    g[o] = constantK ?? 255 + (80 * x) / (W - 1); // 255..335 K across the frame
    g[o + 1] = 0.5 + (0.5 * y) / (H - 1);          // emissivity 0.5..1
    g[o + 2] = (x * y * 7) % 5000;                 // distance 0..5 km
    g[o + 3] = 1;
  }
  const gBuffer = new DataTexture(g, W, H, RGBAFormat, FloatType);
  gBuffer.minFilter = NearestFilter; gBuffer.magFilter = NearestFilter; gBuffer.generateMipmaps = false; gBuffer.needsUpdate = true;
  const renderer = new WebGLRenderer({ canvas: document.createElement("canvas") });
  let shaderErrors = 0;
  renderer.debug.onShaderError = () => { shaderErrors++; };
  const pass = new ThermalCameraPass(profile, gBuffer);
  pass.configure(scene, palette, false);
  pass.render(renderer);
  const pixels = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(pass.target, 0, 0, W, H, pixels);
  const table = radianceTable(profile.spectralBandUm);
  const c = new Float64Array(3);
  let mismatched = 0, worst = 0;
  for (let i = 0; i < W * H; i++) {
    paletteColor(palette, apparentLevel(table, g[4 * i]!, g[4 * i + 1]!, g[4 * i + 2]!, scene), c);
    let err = 0;
    for (let k = 0; k < 3; k++) err = Math.max(err, Math.abs(pixels[4 * i + k]! - Math.round(c[k]! * 255)));
    worst = Math.max(worst, err);
    if (err > 2) mismatched++;
  }
  const corner = (x: number, y: number) => Array.from(pixels.slice(4 * (y * W + x), 4 * (y * W + x) + 3));
  const result = { width: W, height: H, targetSize: [pass.target.width, pass.target.height], mismatched, worst, shaderErrors, corners: [corner(0, 0), corner(W - 1, H - 1)] };
  pass.dispose(); gBuffer.dispose(); renderer.dispose();
  return result;
}

/**
 * TASK-073 P5: fixed-pattern residual + gain x drift and open-sky texels (alpha 0)
 * through the real shader, against the CPU mirror with the same additions.
 */
export function compareThermalFpn(): ThermalComparison {
  const W = 64, H = 48, skyK = 270, driftK = 1.5;
  const profile = { ...SYNTHETIC_LWIR_640, id: "test-64x48", resolution: [W, H] as const };
  const g = new Float32Array(W * H * 4), residual = new Float32Array(W * H), gain = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = 4 * i;
    g[o] = 285 + (30 * x) / (W - 1); g[o + 1] = 0.9; g[o + 2] = 50 * y; g[o + 3] = y < 8 ? 0 : 1; // top-of-texture rows are sky
    residual[i] = ((x % 7) - 3) * 0.4; // +-1.2 K column-like pattern
    gain[i] = ((y % 5) - 2) * 0.5;     // +-1 K/K row-like pattern
  }
  const gBuffer = new DataTexture(g, W, H, RGBAFormat, FloatType);
  gBuffer.minFilter = NearestFilter; gBuffer.magFilter = NearestFilter; gBuffer.generateMipmaps = false; gBuffer.needsUpdate = true;
  const renderer = new WebGLRenderer({ canvas: document.createElement("canvas") });
  let shaderErrors = 0;
  renderer.debug.onShaderError = () => { shaderErrors++; };
  const pass = new ThermalCameraPass(profile, gBuffer);
  pass.configure(scene, "white-hot", false);
  pass.setFixedPattern(residual, gain);
  pass.setDriftK(driftK);
  pass.setSkyK(skyK);
  pass.render(renderer);
  const pixels = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(pass.target, 0, 0, W, H, pixels);
  const table = radianceTable(profile.spectralBandUm);
  const c = new Float64Array(3);
  let mismatched = 0, worst = 0;
  for (let i = 0; i < W * H; i++) {
    const sky = g[4 * i + 3]! < 0.5;
    const t = (sky ? skyK : g[4 * i]!) + residual[i]! + gain[i]! * driftK;
    paletteColor("white-hot", apparentLevel(table, t, sky ? 1 : g[4 * i + 1]!, sky ? 0 : g[4 * i + 2]!, scene), c);
    const err = Math.abs(pixels[4 * i]! - Math.round(c[0]! * 255));
    worst = Math.max(worst, err);
    if (err > 2) mismatched++;
  }
  const corner = (x: number, y: number) => Array.from(pixels.slice(4 * (y * W + x), 4 * (y * W + x) + 3));
  const result = { width: W, height: H, targetSize: [pass.target.width, pass.target.height], mismatched, worst, shaderErrors, corners: [corner(0, 0), corner(W - 1, H - 1)] };
  pass.dispose(); gBuffer.dispose(); renderer.dispose();
  return result;
}

/**
 * TASK-073 detector-area integration: a 2x G-buffer with a fine checkerboard; each output pixel
 * must equal the level of the mean apparent radiance of its 2 x 2 subsamples (not of the mean
 * temperature). Shared by the WebGL2 test here and the WebGPU harness.
 */
export function supersampleFixture(W: number, H: number, S: number) {
  const g = new Float32Array(W * S * H * S * 4);
  for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S; x++) {
    const o = 4 * (y * W * S + x), odd = (x + y) % 2;
    g[o] = odd ? 330 : 270; g[o + 1] = odd ? 0.95 : 0.6; g[o + 2] = 10 * x; g[o + 3] = x % 7 === 0 && y % 5 === 0 ? 0 : 1;
  }
  return g;
}
export function expectedSupersampled(g: Float32Array, W: number, H: number, S: number, x: number, y: number, skyK: number): number {
  const table = radianceTable(SYNTHETIC_LWIR_640.spectralBandUm);
  let sum = 0;
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const o = 4 * ((y * S + j) * W * S + (x * S + i)), sky = g[o + 3]! < 0.5;
    sum += apparentTableRadiance(table, sky ? skyK : g[o]!, sky ? 1 : g[o + 1]!, sky ? 0 : g[o + 2]!, scene);
  }
  return levelFromRadiance(table, sum / (S * S), scene);
}
export const SUPERSAMPLE_SCENE = scene;

export function compareThermalSupersampled(): ThermalComparison {
  const W = 64, H = 48, S = 2, skyK = 260;
  const profile = { ...SYNTHETIC_LWIR_640, id: "test-64x48", resolution: [W, H] as const };
  const g = supersampleFixture(W, H, S);
  const gBuffer = new DataTexture(g, W * S, H * S, RGBAFormat, FloatType);
  gBuffer.minFilter = NearestFilter; gBuffer.magFilter = NearestFilter; gBuffer.generateMipmaps = false; gBuffer.needsUpdate = true;
  const renderer = new WebGLRenderer({ canvas: document.createElement("canvas") });
  let shaderErrors = 0;
  renderer.debug.onShaderError = () => { shaderErrors++; };
  const pass = new ThermalCameraPass(profile, gBuffer, S);
  pass.configure(scene, "white-hot", false);
  pass.setSkyK(skyK);
  pass.render(renderer);
  const pixels = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(pass.target, 0, 0, W, H, pixels);
  let mismatched = 0, worst = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const err = Math.abs(pixels[4 * (y * W + x)]! - Math.round(expectedSupersampled(g, W, H, S, x, y, skyK) * 255));
    worst = Math.max(worst, err);
    if (err > 2) mismatched++;
  }
  const result = { width: W, height: H, targetSize: [pass.target.width, pass.target.height], mismatched, worst, shaderErrors, corners: [] };
  pass.dispose(); gBuffer.dispose(); renderer.dispose();
  return result;
}
