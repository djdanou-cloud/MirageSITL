import { viteFileUrl } from "../support/vite-url";
import { expect, test, type Page } from "@playwright/test";

// TASK-073 P6: TSL node-material ports of the G3 passes against the CPU mirrors.
// MIRAGE_BROWSER_GPU=hardware runs on the machine's GPU (the RTX 4050 here);
// otherwise SwiftShader's WebGPU adapter is used where the browser exposes one.
// Without WebGPU the tests are skipped with the browser's reason, never passed.
test.use({ launchOptions: { ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: process.env.MIRAGE_BROWSER_GPU === "hardware" ? ["--enable-unsafe-webgpu"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"] } });

type Harness = typeof import("../support/webgpu-passes-harness");
const harnessUrl = viteFileUrl(new URL("../support/webgpu-passes-harness.ts", import.meta.url));
const deg = Math.PI / 180;

async function requireWebGpu(page: Page): Promise<void> {
  await page.goto("/");
  const probe = await page.evaluate(async url => (await import(url) as Harness).webGpuAvailable(), harnessUrl);
  test.info().annotations.push({ type: "adapter", description: probe.reason });
  test.skip(!probe.available, `WebGPU unavailable: ${probe.reason}`);
}

// Same cases and tolerances as tests/browser/fpv.spec.ts (one source texel at a texel boundary).
const lenses = [
  { name: "identity (no distortion)", lens: { fovHorizontalRad: 90 * deg, distortion: { model: "none" as const } }, maxMismatch: 0 },
  { name: "equidistant 120 deg", lens: { fovHorizontalRad: 120 * deg, distortion: { model: "kannala-brandt" as const, k: [0, 0, 0, 0] as const } }, maxMismatch: 0.01 },
  { name: "distorted 110 deg with offset principal point", lens: { fovHorizontalRad: 110 * deg, principalPointOffsetPx: [6, -4] as const,
    distortion: { model: "kannala-brandt" as const, k: [0.08, -0.015, 0.002, -0.0003] as const } }, maxMismatch: 0.01 },
];

for (const c of lenses) {
  test(`WebGPU fisheye matches the CPU mirror: ${c.name}`, async ({ page }) => {
    await requireWebGpu(page);
    const result = await page.evaluate(async ([url, lens]) => (await import(url) as Harness).compareFisheyeWebGpu(lens, 96, 72), [harnessUrl, c.lens] as const);
    test.info().annotations.push({ type: "comparison", description: JSON.stringify(result) });
    expect(result.error).toBeNull();
    expect(result.inside).toBe(result.pixels);
    expect(result.mismatched / result.pixels, JSON.stringify(result)).toBeLessThanOrEqual(c.maxMismatch);
    // Pixels whose source coordinate lies exactly on a texel boundary may take either neighbour on a GPU;
    // everywhere else the identity remap must be exact.
    if (c.maxMismatch === 0) { expect(result.offBoundaryWorst).toBe(0); expect(result.worst).toBeLessThanOrEqual(1); }
  });
}

// Analog interference: the tests of tests/browser/analog.spec.ts on WebGPU, plus WebGL2 parity
// for the noise-free effects (jelly, tearing, scanlines are keyed to uv and line, not pixel origin).
type AnalogHarness = typeof import("../support/analog-harness");
const analogUrl = viteFileUrl(new URL("../support/analog-harness.ts", import.meta.url));
type Config = Parameters<Harness["renderAnalogWebGpu"]>[0];
const OFF: Config = { noiseBase: 0, noiseThrottleGain: 0, scanlineIntensity: 0, jellyAmplitudeUv: 0, tearProbability: 0 };
async function gpuFrame(page: Page, config: Config, timeS: number, throttle: number, kind: "gray" | "vertical-line" = "gray") {
  const f = await page.evaluate(async ([url, c, t, th, k]) => (await import(url) as Harness).renderAnalogWebGpu(c, t, th, k), [harnessUrl, config, timeS, throttle, kind] as const);
  expect(f.error).toBeNull();
  return f;
}
const std = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };

test("WebGPU analog: identity when off, deterministic per seed and frame, noise follows throttle", async ({ page }) => {
  await requireWebGpu(page);
  expect(new Set((await gpuFrame(page, OFF, 1, 1)).red)).toEqual(new Set([128]));
  const a = await gpuFrame(page, { seed: 7 }, 2.01, 0.5), b = await gpuFrame(page, { seed: 7 }, 2.02, 0.5);
  expect(b.red).toEqual(a.red);
  expect((await gpuFrame(page, { seed: 7 }, 2.05, 0.5)).red).not.toEqual(a.red);
  expect((await gpuFrame(page, { seed: 8 }, 2.01, 0.5)).red).not.toEqual(a.red);
  const config: Config = { ...OFF, noiseBase: 0.02, noiseThrottleGain: 0.1 };
  const idle = std((await gpuFrame(page, config, 1, 0)).red), full = std((await gpuFrame(page, config, 1, 1)).red);
  expect(idle).toBeGreaterThan(2.9 * 0.8); expect(idle).toBeLessThan(2.9 * 1.2);
  expect(full).toBeGreaterThan(17.7 * 0.8); expect(full).toBeLessThan(17.7 * 1.2);
});

test("WebGPU analog matches the WebGL2 GLSL for jelly, tearing and scanlines", async ({ page }) => {
  await requireWebGpu(page);
  for (const [config, kind] of [
    [{ ...OFF, jellyAmplitudeUv: 0.03, vibFreqMinHz: 200, vibFreqMaxHz: 200 }, "vertical-line"],
    [{ ...OFF, tearProbability: 0.5, tearAmplitudeUv: 0.05, noiseBase: 1 - 1e-9 }, "vertical-line"],
    [{ ...OFF, scanlineIntensity: 0.5, lines: 24 }, "gray"],
  ] as const) {
    // Tearing probability scales with the noise amplitude; with noise on, compare only rows' line positions.
    const gpu = await gpuFrame(page, config, 1, 1, kind);
    const gl = await page.evaluate(async ([url, c, k]) => (await import(url) as AnalogHarness).renderAnalog(c, 1, 1, k), [analogUrl, config, kind] as const);
    expect(gl.shaderErrors).toBe(0);
    const lineX = (red: number[]) => Array.from({ length: 96 }, (_, y) => { const row = red.slice(y * 128, (y + 1) * 128); return row.indexOf(Math.max(...row)); });
    if (kind === "vertical-line") {
      const g = lineX(gpu.red), w = lineX(gl.red);
      const off = g.filter((x, y) => Math.abs(x - w[y]!) > 1).length;
      expect(off, JSON.stringify({ g, w })).toBe(0);
      expect(Math.max(...g) - Math.min(...g)).toBeGreaterThanOrEqual(4); // the effect is actually present
    } else {
      let worst = 0;
      for (let i = 0; i < gpu.red.length; i++) worst = Math.max(worst, Math.abs(gpu.red[i]! - gl.red[i]!));
      expect(worst).toBeLessThanOrEqual(1);
    }
  }
});

// Thermal camera: same tolerance as tests/browser/thermal.spec.ts (2 of 255 levels).
for (const [palette, fpn] of [["white-hot", false], ["black-hot", false], ["ironbow", false], ["white-hot", true]] as const) {
  test(`WebGPU thermal pass matches the CPU radiometry: ${palette}${fpn ? " with fixed pattern and sky" : ""}`, async ({ page }) => {
    await requireWebGpu(page);
    const r = await page.evaluate(async ([url, p, f]) => (await import(url) as Harness).compareThermalWebGpu(p, f), [harnessUrl, palette, fpn] as const);
    test.info().annotations.push({ type: "comparison", description: JSON.stringify(r) });
    expect(r.error).toBeNull();
    expect(r.mismatched).toBe(0);
    expect(r.worst).toBeLessThanOrEqual(2);
  });
}

// Thermal G-buffer on both backends: class from the raster, orientation-weighted table temperature,
// class emissivity and analytic distance (float32 tolerances; class edges excluded by the harness).
type GBufferHarness = typeof import("../support/gbuffer-harness");
const gbufferUrl = viteFileUrl(new URL("../support/gbuffer-harness.ts", import.meta.url));
for (const backend of ["webgl2", "webgpu"] as const) {
  for (const kind of ["ground", "wall"] as const) {
    test(`thermal G-buffer on ${backend}: ${kind}`, async ({ page }) => {
      if (backend === "webgpu") await requireWebGpu(page); else await page.goto("/");
      const r = await page.evaluate(async ([url, b, k]) => (await import(url) as GBufferHarness).compareGBuffer(b, k), [gbufferUrl, backend, kind] as const);
      test.info().annotations.push({ type: "comparison", description: JSON.stringify(r) });
      expect(r.error).toBeNull();
      expect(r.checked, JSON.stringify(r)).toBeGreaterThan(1000); // of 64 x 48 = 3072 texels
      expect(r.worstTemperatureK).toBeLessThan(0.01);
      expect(r.worstEmissivity).toBeLessThan(1e-6);
      expect(r.worstDistanceRel).toBeLessThan(1e-3);
    });
  }
}

test("WebGPU thermal pass averages the radiance of its 2 x 2 G-buffer subsamples", async ({ page }) => {
  await requireWebGpu(page);
  const r = await page.evaluate(async url => (await import(url) as Harness).compareThermalSupersampledWebGpu(), harnessUrl);
  test.info().annotations.push({ type: "comparison", description: JSON.stringify(r) });
  expect(r.error).toBeNull();
  expect(r.mismatched).toBe(0);
  expect(r.worst).toBeLessThanOrEqual(2);
});
