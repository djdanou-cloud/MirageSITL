import { viteFileUrl } from "../support/vite-url";
import { expect, test } from "@playwright/test";

// TASK-071: thermal GLSL vs the float64 CPU mirror on WebGL2 (SwiftShader).
// Backend-specific tolerance: 2 of 255 levels (float32 shader math and table).
type Harness = typeof import("../support/thermal-harness");
const harnessUrl = viteFileUrl(new URL("../support/thermal-harness.ts", import.meta.url));

for (const palette of ["white-hot", "black-hot", "ironbow"] as const) {
  test(`thermal shader matches the CPU radiometry: ${palette}`, async ({ page }) => {
    await page.goto("/");
    const r = await page.evaluate(async ([url, p]) => (await import(url) as Harness).compareThermal(p, null), [harnessUrl, palette] as const);
    test.info().annotations.push({ type: "comparison", description: JSON.stringify({ mismatched: r.mismatched, worst: r.worst }) });
    expect(r.shaderErrors).toBe(0);
    expect(r.targetSize).toEqual([64, 48]); // rendered at the profile's native resolution
    expect(r.mismatched).toBe(0);
    expect(r.worst).toBeLessThanOrEqual(2);
  });
}

test("palette endpoints for cold and hot scenes", async ({ page }) => {
  await page.goto("/");
  const run = (palette: "white-hot" | "black-hot" | "ironbow", k: number) =>
    page.evaluate(async ([url, p, t]) => (await import(url) as Harness).compareThermal(p, t), [harnessUrl, palette, k] as const);
  // 200 K is below the span everywhere (even through the warmer path), 400 K above it at short range.
  expect((await run("white-hot", 200)).corners[0]).toEqual([0, 0, 0]);
  expect((await run("black-hot", 200)).corners[0]).toEqual([255, 255, 255]);
  expect((await run("white-hot", 400)).corners[0]).toEqual([255, 255, 255]);
  expect((await run("ironbow", 400)).corners[0]).toEqual([255, 255, 255]);
  expect((await run("ironbow", 200)).corners[0]).toEqual([0, 0, 0]);
});

test("fixed-pattern noise and open sky match the CPU mirror (TASK-073 P5)", async ({ page }) => {
  await page.goto("/");
  const r = await page.evaluate(async url => (await import(url) as Harness).compareThermalFpn(), harnessUrl);
  test.info().annotations.push({ type: "comparison", description: JSON.stringify({ mismatched: r.mismatched, worst: r.worst }) });
  expect(r.shaderErrors).toBe(0);
  expect(r.mismatched).toBe(0);
  expect(r.worst).toBeLessThanOrEqual(2);
});

test("each sensor pixel averages the radiance of its 2 x 2 G-buffer subsamples (TASK-073)", async ({ page }) => {
  await page.goto("/");
  const r = await page.evaluate(async url => (await import(url) as Harness).compareThermalSupersampled(), harnessUrl);
  test.info().annotations.push({ type: "comparison", description: JSON.stringify({ mismatched: r.mismatched, worst: r.worst }) });
  expect(r.shaderErrors).toBe(0);
  expect(r.targetSize).toEqual([64, 48]);
  expect(r.mismatched).toBe(0);
  expect(r.worst).toBeLessThanOrEqual(2);
});
