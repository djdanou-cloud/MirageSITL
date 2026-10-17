import { viteFileUrl } from "../support/vite-url";
import { expect, test } from "@playwright/test";

// TASK-067: the fisheye GLSL agrees with its CPU mirror on WebGL2 (SwiftShader).
// Tolerance is backend-specific: one source texel, because float32 shader math
// can land on the other side of a texel boundary than the float64 mirror.
type Harness = typeof import("../support/fpv-harness");
const harnessUrl = viteFileUrl(new URL("../support/fpv-harness.ts", import.meta.url));
const deg = Math.PI / 180;

const cases = [
  { name: "identity (no distortion)", lens: { fovHorizontalRad: 90 * deg, distortion: { model: "none" as const } }, maxMismatch: 0 },
  { name: "equidistant 120 deg", lens: { fovHorizontalRad: 120 * deg, distortion: { model: "kannala-brandt" as const, k: [0, 0, 0, 0] as const } }, maxMismatch: 0.01 },
  { name: "distorted 110 deg with offset principal point", lens: { fovHorizontalRad: 110 * deg, principalPointOffsetPx: [6, -4] as const,
    distortion: { model: "kannala-brandt" as const, k: [0.08, -0.015, 0.002, -0.0003] as const } }, maxMismatch: 0.01 },
];

for (const c of cases) {
  test(`fisheye shader matches the CPU mirror: ${c.name}`, async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async ([url, lens]) => (await import(url) as Harness).compareShaderWithCpu(lens, 96, 72), [harnessUrl, c.lens] as const);
    test.info().annotations.push({ type: "comparison", description: JSON.stringify(result) });
    expect(result.shaderErrors).toBe(0);
    expect(result.inside).toBe(result.pixels); // the whole frame maps into the source
    expect(result.mismatched / result.pixels, JSON.stringify(result)).toBeLessThanOrEqual(c.maxMismatch);
    expect(result.worst).toBeLessThanOrEqual(c.maxMismatch === 0 ? 0 : 255);
  });
}
