import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
test("dedicated collision Worker transfers meshes and rejects malformed messages", async ({ page }) => {
  await page.goto("/");
  const path = fileURLToPath(new URL("../../packages/terrain/src/collision-builder.worker.ts", import.meta.url));
  const result = await page.evaluate(async (path) => {
    const worker = new Worker(`/@fs/${path}`, { type: "module" });
    function reply(): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Collision Worker deadline")), 5000);
        worker.onmessage = e => { clearTimeout(timeout); resolve(e.data as unknown); };
        worker.onerror = () => { clearTimeout(timeout); reject(new Error("Collision Worker load failed")); };
      });
    }
    try {
      let pending = reply(); const heights = new Float64Array([0, 0, 0, 0]);
      worker.postMessage({ version: 1, epoch: 1, revision: 0, northIndex: 0, eastIndex: 0, resolution: 2, spacingM: 1, downM: heights }, [heights.buffer]);
      const detached = heights.byteLength === 0, good = await pending;
      pending = reply(); worker.postMessage({ version: 1, downM: [] });
      return { detached, good, bad: await pending };
    } finally { worker.terminate(); }
  }, path);
  expect(result).toMatchObject({ detached: true, good: { type: "collision-built", chunk: { epoch: 1, revision: 0 } }, bad: { type: "collision-rejected" } });
});
