import { viteFileUrl } from "../support/vite-url";
import { expect, test } from "@playwright/test";

// TASK-066: renderer adapter. WebGPU runs on SwiftShader's software adapter
// where the browser exposes one; otherwise WebGPU-only checks are skipped
// with the browser's reason, never reported as passed.
test.use({ launchOptions: { ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}), args: process.env.MIRAGE_BROWSER_GPU === "hardware" ? [] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"] } });

type Harness = typeof import("../support/render-harness");
const harnessUrl = viteFileUrl(new URL("../support/render-harness.ts", import.meta.url));

async function detect(page: import("@playwright/test").Page) {
  await page.goto(viteFileUrl(new URL("../support/render-harness.html", import.meta.url)));
  return page.evaluate(async url => (await import(url) as Harness).detectBackends(), harnessUrl);
}

test("WebGL2 renders, and releases every resource and its context", async ({ page }) => {
  const backends = await detect(page);
  expect(backends.webgl2.available, backends.webgl2.reason ?? "").toBe(true);
  const run = await page.evaluate(async url => (await import(url) as Harness).runBackend("webgl2"), harnessUrl);
  expect(run.backend).toBe("webgl2");
  expect(run.fallbackReason).toBeNull();
  expect(run.centerPixel.slice(0, 3).some(v => v > 20)).toBe(true); // lit box, not the black background
  expect(run.memoryBefore.geometries).toBeGreaterThanOrEqual(1);
  expect(run.memoryBefore.textures).toBeGreaterThanOrEqual(1);
  expect(run.released).toEqual({ geometries: 1, materials: 1, textures: 1 });
  expect(run.memoryAfterSceneDispose).toEqual({ geometries: 0, textures: 0 });
  expect([run.contextLost, run.disposed]).toEqual([true, true]);
});

test("a failing WebGL2 shader falls back to a basic material", async ({ page }) => {
  await page.goto("/");
  const run = await page.evaluate(async url => (await import(url) as Harness).runBackend("webgl2", { brokenShader: true }), harnessUrl);
  expect(run.shaderFallbacks).toHaveLength(1);
  expect(run.shaderFallbacks[0]!.material).toBe("broken");
  expect(run.shaderFallbacks[0]!.reason).toMatch(/undefinedSymbol|undeclared/i);
  expect(run.centerPixel.slice(0, 3)).toEqual([255, 0, 255]); // magenta fallback is drawn
  expect(run.memoryAfterSceneDispose).toEqual({ geometries: 0, textures: 0 });
});

test("WebGPU renders and releases resources", async ({ page }) => {
  const backends = await detect(page);
  test.skip(!backends.webgpu.available, `WebGPU unavailable: ${backends.webgpu.reason ?? "unknown"}`);
  const run = await page.evaluate(async url => (await import(url) as Harness).runBackend("webgpu"), harnessUrl);
  expect(run.fallbackReason).toBeNull();
  expect(run.backend).toBe("webgpu");
  expect(run.centerPixel.slice(0, 3).some(v => v > 20)).toBe(true);
  expect(run.memoryBefore.geometries).toBeGreaterThanOrEqual(1);
  expect(run.released).toEqual({ geometries: 1, materials: 1, textures: 1 });
  expect(run.memoryBefore.geometries - run.memoryBaseline.geometries).toBe(1);
  expect(run.memoryAfterSceneDispose).toEqual(run.memoryBaseline);
  expect(run.memoryAfterRendererDispose).toEqual({ geometries: 0, textures: 0 });
  test.info().annotations.push({ type: "resource-counts", description: JSON.stringify(run) });
  expect(run.disposed).toBe(true);
});

test("a WebGPU failure falls back to WebGL2 with the reason", async ({ page }) => {
  const backends = await detect(page);
  const run = await page.evaluate(async url => (await import(url) as Harness).runBackend("webgpu", { injectWebGpuFailure: "injected shader failure" }), harnessUrl);
  expect(run.backend).toBe("webgl2");
  expect(run.centerPixel.slice(0, 3).some(v => v > 20)).toBe(true);
  if (backends.webgpu.available) expect(run.fallbackReason).toBe("WebGPU probe failed: injected shader failure");
  else expect(run.fallbackReason).toBe(backends.webgpu.reason);
});

test("switching backends releases each renderer before the next", async ({ page }) => {
  const backends = await detect(page);
  const modes = backends.webgpu.available ? (["webgl2", "webgpu", "webgl2"] as const) : (["webgl2", "webgl2"] as const);
  for (const mode of modes) {
    const run = await page.evaluate(async ([url, m]) => (await import(url) as Harness).runBackend(m), [harnessUrl, mode] as const);
    expect(run.backend).toBe(mode);
    expect(run.memoryBefore.geometries - run.memoryBaseline.geometries).toBe(1);
    expect(run.memoryAfterSceneDispose).toEqual(run.memoryBaseline);
    expect(run.memoryAfterRendererDispose).toEqual({ geometries: 0, textures: 0 });
    expect(run.disposed).toBe(true);
  }
  test.info().annotations.push({ type: "backends", description: modes.join(" -> ") });
});

test("the app selects the adapter from ?renderer= and reports the backend", async ({ page }) => {
  for (const mode of ["webgl2", "webgpu"] as const) {
    await page.goto(`/?renderer=${mode}`);
    const canvas = page.locator("canvas[data-render-backend]");
    await expect(canvas).toHaveCount(1, { timeout: 15_000 });
    const backends = await page.evaluate(async url => (await import(url) as Harness).detectBackends(), harnessUrl);
    const expected = mode === "webgpu" && !backends.webgpu.available ? "webgl2" : mode;
    await expect(canvas).toHaveAttribute("data-render-backend", expected);
    if (mode === "webgpu" && !backends.webgpu.available) await expect(canvas).toHaveAttribute("data-render-fallback", backends.webgpu.reason ?? "");
  }
});
