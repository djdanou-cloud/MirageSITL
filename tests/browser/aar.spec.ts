import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
type Harness = typeof import("../support/aar-harness");
const url =
  "/@fs" + fileURLToPath(new URL("../support/aar-harness.ts", import.meta.url));
test("real recorder Worker and IndexedDB bound chunks and return validated snapshots", async ({
  page,
}) => {
  await page.goto("/");
  const r = await page.evaluate(
    async (u) => ((await import(u)) as Harness).recordInWorker(),
    url,
  );
  expect(r.records).toBe(10);
  expect(r.persistent).toBe(true);
  expect(r.queueLost).toBe(0);
  expect(r.invalid).toBe(0);
  expect(r.dbChunks).toBeLessThanOrEqual(2);
  expect(r.storageRejected).toBe(true);
  expect(r.storageQueued).toBe(true);
  expect(r.queuedDropped).toBe(0);
});
test("record/review/export/import UI keeps physics live and displays provenance and epoch", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect
    .poll(async () =>
      Number((await page.getByTestId("tick").innerText()).split(" ")[0]),
    )
    .toBeGreaterThan(200);
  await page
    .getByRole("button", { name: "Review recording", exact: true })
    .click();
  await expect(
    page.getByLabel("After-action review", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("aar-status")).toContainText("bytes");
  await expect(page.getByTestId("aar-point-count")).toContainText(
    "maximum 10000",
  );
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export session", exact: true })
    .click();
  const d = await download;
  const file = await d.path();
  if (!file) throw new Error("Download missing");
  await page.getByLabel("Import AAR", { exact: true }).setInputFiles(file);
  await expect(page.getByTestId("aar-status")).toContainText("imported");
  await page
    .getByLabel("Import AAR", { exact: true })
    .setInputFiles({
      name: "broken.aar",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("invalid"),
    });
  await expect(page.getByTestId("aar-status")).toContainText("rejected");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
});
