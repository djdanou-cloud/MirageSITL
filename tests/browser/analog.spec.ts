import { viteFileUrl } from "../support/vite-url";
import { expect, test, type Page } from "@playwright/test";

// TASK-068: analog interference on WebGL2 (SwiftShader). Tolerances are for this
// backend: equal inputs must give identical bytes here; no cross-GPU equality is claimed.
type Harness = typeof import("../support/analog-harness");
type Config = Parameters<Harness["renderAnalog"]>[0];
const harnessUrl = viteFileUrl(new URL("../support/analog-harness.ts", import.meta.url));
const OFF: Config = { noiseBase: 0, noiseThrottleGain: 0, scanlineIntensity: 0, jellyAmplitudeUv: 0, tearProbability: 0 };

async function frame(page: Page, config: Config, timeS: number, throttle: number, kind: "gray" | "vertical-line" = "gray") {
  const result = await page.evaluate(async ([url, c, t, th, k]) => (await import(url) as Harness).renderAnalog(c, t, th, k), [harnessUrl, config, timeS, throttle, kind] as const);
  expect(result.shaderErrors).toBe(0);
  return result;
}
const std = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };

test.beforeEach(async ({ page }) => { await page.goto("/"); });

test("all effects off is the identity", async ({ page }) => {
  const f = await frame(page, OFF, 1, 1);
  expect(new Set(f.red)).toEqual(new Set([128]));
});

test("equal seed and time give the same frame; time or seed change it", async ({ page }) => {
  const a = await frame(page, { seed: 7 }, 2.01, 0.5), b = await frame(page, { seed: 7 }, 2.02, 0.5); // same 30 Hz video frame
  expect(b.red).toEqual(a.red);
  const nextFrame = await frame(page, { seed: 7 }, 2.05, 0.5), otherSeed = await frame(page, { seed: 8 }, 2.01, 0.5);
  expect(nextFrame.red).not.toEqual(a.red);
  expect(otherSeed.red).not.toEqual(a.red);
});

test("throttle raises noise as configured", async ({ page }) => {
  const config: Config = { ...OFF, noiseBase: 0.02, noiseThrottleGain: 0.1 };
  const idle = std((await frame(page, config, 1, 0)).red), full = std((await frame(page, config, 1, 1)).red);
  // Uniform noise of amplitude a has standard deviation 255 a / sqrt(3): 2.9 and 17.7 levels.
  expect(idle).toBeGreaterThan(2.9 * 0.8); expect(idle).toBeLessThan(2.9 * 1.2);
  expect(full).toBeGreaterThan(17.7 * 0.8); expect(full).toBeLessThan(17.7 * 1.2);
});

test("rolling shutter bends a vertical line only when the frame vibrates", async ({ page }) => {
  const lineX = (f: { width: number; height: number; red: number[] }) => {
    const xs: number[] = [];
    for (let y = 0; y < f.height; y++) { const row = f.red.slice(y * f.width, (y + 1) * f.width); xs.push(row.indexOf(Math.max(...row))); }
    return xs;
  };
  const config: Config = { ...OFF, jellyAmplitudeUv: 0.03, vibFreqMinHz: 200, vibFreqMaxHz: 200 };
  const still = lineX(await frame(page, config, 1, 0, "vertical-line"));
  expect(new Set(still)).toEqual(new Set([64]));
  const shaking = lineX(await frame(page, config, 1, 1, "vertical-line"));
  // 0.03 of 128 px = 3.8 px amplitude; 200 Hz over a 30 ms readout spans several periods.
  expect(Math.max(...shaking) - Math.min(...shaking)).toBeGreaterThanOrEqual(6);
  expect(Math.max(...shaking.map(x => Math.abs(x - 64)))).toBeLessThanOrEqual(5);
});

test("scanlines modulate rows at the configured line count", async ({ page }) => {
  const rowMeans = (f: { width: number; height: number; red: number[] }) => {
    const rows: number[] = [];
    for (let y = 0; y < f.height; y++) rows.push(f.red.slice(y * f.width, (y + 1) * f.width).reduce((a, b) => a + b, 0) / f.width);
    return rows;
  };
  // scan = 1 - I (0.5 + 0.5 cos(2 pi v lines)). With one line per pixel row every row centre is at
  // cos = -1, so rows are unchanged (a line cannot be darker than itself at this resolution).
  const perRow = rowMeans(await frame(page, { ...OFF, scanlineIntensity: 0.5 }, 1, 0));
  expect(Math.max(...perRow) - Math.min(...perRow)).toBeLessThanOrEqual(1);
  // 24 lines over 96 rows: row centres at cos = +-0.707 give 128 (1 - 0.5 (0.5 +- 0.354)) = 73.3 or 118.7.
  const rows = rowMeans(await frame(page, { ...OFF, scanlineIntensity: 0.5, lines: 24 }, 1, 0));
  expect(Math.min(...rows)).toBeGreaterThan(73.3 - 2); expect(Math.min(...rows)).toBeLessThan(73.3 + 2);
  expect(Math.max(...rows)).toBeGreaterThan(118.7 - 2); expect(Math.max(...rows)).toBeLessThan(118.7 + 2);
  // The pattern repeats every four pixel rows (one scanline).
  for (let y = 0; y + 4 < rows.length; y++) expect(Math.abs(rows[y]! - rows[y + 4]!)).toBeLessThanOrEqual(1);
});
