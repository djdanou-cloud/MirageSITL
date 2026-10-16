// Browser harness for tests/browser/thermal.spec.ts (TASK-071): runs the real
// thermal GLSL over a float G-buffer and compares it with the CPU mirror.
import { DataTexture, FloatType, NearestFilter, RGBAFormat, WebGLRenderer } from "three";
import { SYNTHETIC_LWIR_640, apparentLevel, paletteColor, radianceTable, type ThermalPalette, type ThermalScene } from "../../packages/thermal/src/thermal-camera.ts";
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
