import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

// TASK-076: the recorder Worker stores CRC-checked chunks and the manifest in IndexedDB.
type Harness = typeof import("../support/aar-harness");
const harnessUrl = "/@fs" + fileURLToPath(new URL("../support/aar-harness.ts", import.meta.url));
const workerUrl = "/@fs" + fileURLToPath(new URL("../../packages/aar/src/recorder.worker.ts", import.meta.url));

test("recorder Worker drains the queue into IndexedDB with no loss", async ({ page }) => {
  await page.goto("/");
  const r = await page.evaluate(async ([h, w]) => (await import(h) as Harness).runRecorderWorker(w, 3000), [harnessUrl, workerUrl] as const);
  expect(r.manifestSeed).toBe(7);
  expect(r.storedTicks).toHaveLength(3000);
  r.storedTicks.forEach((t, i) => expect(t).toBe(i));
  expect(r.chunks).toBe(Math.ceil(3000 / 64));
  expect(r.stats).toMatchObject({ queueDroppedRecords: 0, storageErrors: 0, recordsQueued: 3000 });
});
