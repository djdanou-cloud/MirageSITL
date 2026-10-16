import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
type Harness = typeof import("../support/thermal-harness");
const url =
  "/@fs" +
  fileURLToPath(new URL("../support/thermal-harness.ts", import.meta.url));
test("LWIR shader matches radiance oracle including palette endpoints and attenuation", async ({
  page,
}) => {
  await page.goto("/");
  const r = await page.evaluate(
    async (u) => ((await import(u)) as Harness).thermalPixels(),
    url,
  );
  expect(r.errors).toBe(0);
  expect(r.width).toBe(6);
  expect(r.height).toBe(2);
  for (let i = 0; i < r.red.length; i++)
    expect(Math.abs(r.red[i]! - r.expected[i % r.width]!)).toBeLessThanOrEqual(
      1,
    );
  expect(r.red[0]).toBe(0);
  expect(r.red[1]).toBe(255);
});
