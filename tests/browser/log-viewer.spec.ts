import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DataFlashWriter } from "../../packages/dataflash/src/writer";

// TASK-179 (S14): the Analysis tab embeds the offline UAVLogViewer build that
// scripts/build-uavlogviewer.mjs writes, served by Vite at /uavlogviewer/ from
// MIRAGE_UAVLOGVIEWER_DIR (default: the launcher home). Every request that
// leaves the loopback server is aborted and counted. MIRAGE_DATAFLASH_REFERENCE
// names a real ArduPilot DataFlash log for the reference case.
const ORIGIN = "http://127.0.0.1:5173";
const REFERENCE = process.env.MIRAGE_DATAFLASH_REFERENCE;

/** Aborts every request outside the loopback server; returns the aborted URLs. */
async function offline(page: Page): Promise<string[]> {
  const aborted: string[] = [];
  await page.context().route("**/*", route => {
    const url = route.request().url();
    if (url.startsWith(`${ORIGIN}/`) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    aborted.push(url);
    return route.abort("internetdisconnected");
  });
  return aborted;
}

/** Exceptions raised by the application or the viewer, as the TASK-130 check counts them. */
function exceptions(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => {
    if (message.type() === "error" && /^(TypeError|ReferenceError|RangeError|SyntaxError|Error)\b/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

function writerLog(): Uint8Array {
  const writer = new DataFlashWriter();
  for (let i = 0; i < 50; i++) {
    const timeUs = 1_000_000 + i * 20_000;
    writer.append({ kind: "truth", timeUs, latitudeDeg: -35.363261, longitudeDeg: 149.16523, altitudeM: 584 + i * 0.1, northM: 0, eastM: 0, downM: -i * 0.1, northMps: 0, eastMps: 0, downMps: -5,
      rollDeg: 0, pitchDeg: 0, yawDeg: 0, rollRateDegS: 0, pitchRateDegS: 0, yawRateDegS: 0 });
    for (let motor = 0; motor < 4; motor++) writer.append({ kind: "motor", timeUs, motor, command: 0.5, rpm: 6000, thrustN: 4, torqueNm: 0.05, currentA: 2, voltageV: 15.8 });
  }
  writer.append({ kind: "event", timeUs: 1_200_000, event: "command", text: "Takeoff" });
  writer.append({ kind: "parameter", timeUs: 1_300_000, sequence: 1, name: "ATC_RAT_RLL_P", requestedValue: 0.135, previousValue: 0.135, confirmedValue: 0.135, status: "confirmed" });
  return writer.bytes();
}

test("without a viewer build the Analysis tab says what is missing and how to fix it", async ({ page }) => {
  await page.route("**/uavlogviewer/build-manifest.json", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/");
  await page.getByRole("tab", { name: "Analysis", exact: true }).click();
  const host = page.getByRole("region", { name: "Flight log viewer" });
  await expect(host).toContainText("The log viewer is not installed.");
  await expect(host).toContainText("node scripts/build-uavlogviewer.mjs");
  await expect(host.locator("iframe")).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).include("#panel-analysis").analyze();
  expect(axe.violations).toEqual([]);
});

test("the offline viewer opens DataFlash logs through the message interface with no network", async ({ page }) => {
  test.setTimeout(240_000);
  const manifest = await page.request.get("/uavlogviewer/build-manifest.json");
  test.skip(!manifest.ok(), "BLOCKED_EXTERNAL: no TASK-179 build is served; run node scripts/build-uavlogviewer.mjs or set MIRAGE_UAVLOGVIEWER_DIR");
  const build: unknown = await manifest.json();
  expect(build).toMatchObject({ schemaVersion: 1, task: "TASK-179" });
  // The viewer is served with the application's isolation headers.
  const viewerPage = await page.request.get("/uavlogviewer/");
  expect(viewerPage.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(viewerPage.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(viewerPage.headers()["cross-origin-resource-policy"]).toBe("same-origin");
  expect((await page.request.get("/uavlogviewer/licenses/UAVLogViewer-LICENSE.txt")).ok()).toBe(true);
  // Encoded slashes survive URL normalization and reach the route as a traversal attempt.
  expect((await page.request.get("/uavlogviewer/..%2f..%2fpackage.json")).status()).toBe(404);

  const aborted = await offline(page);
  const errors = exceptions(page);
  const scratch = mkdtempSync(join(tmpdir(), "mirage-log-viewer-"));
  try {
    await page.goto("/");
    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    const host = page.getByRole("region", { name: "Flight log viewer" });
    const status = host.getByRole("status");
    await expect(host).toContainText("MirageSITL patches");
    const viewer = page.frameLocator("iframe[title=UAVLogViewer]");
    await expect(viewer.locator("#app")).toBeAttached({ timeout: 60_000 });
    expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
    // The icon font ships with the build (patch 0001) and must load as a font, not as a JavaScript stub.
    const viewerFrame = await (await page.locator("iframe[title=UAVLogViewer]").elementHandle())?.contentFrame();
    const iconFont = await viewerFrame?.evaluate(async () => {
      try {
        const faces = await globalThis.document.fonts.load('900 16px "Font Awesome 5 Free"');
        return faces.length > 0 && faces.every(face => face.status === "loaded");
      } catch {
        return false;
      }
    });
    expect(iconFont).toBe(true);

    // A file that is not a DataFlash log is refused before it reaches the viewer.
    const text = join(scratch, "notes.bin");
    writeFileSync(text, "not a log");
    await host.getByLabel("Open DataFlash log (.bin)").setInputFiles(text);
    await expect(status).toContainText("is not a DataFlash binary log");

    // A message the viewer does not accept is answered with its reason.
    await page.evaluate(() => {
      const frame = globalThis.document.querySelector("iframe");
      frame?.contentWindow?.postMessage({ type: "mirage.loadLog", protocol: 2, name: "x.bin", bytes: new ArrayBuffer(4) }, globalThis.location.origin);
    });
    await expect(status).toContainText("Unsupported protocol 2");

    // A log written by MirageSITL (TASK-178) opens with its own message types.
    const written = join(scratch, "mirage-writer.bin");
    writeFileSync(written, writerLog());
    await host.getByLabel("Open DataFlash log (.bin)").setInputFiles(written);
    await expect(status).toContainText(/Opened mirage-writer\.bin: \d+ message types\./, { timeout: 60_000 });
    for (const name of ["MSTR", "MSMO", "MSEV", "MSPC"]) await expect(viewer.locator("li.type a.section", { hasText: name }).first()).toBeAttached();

    if (REFERENCE !== undefined && existsSync(REFERENCE)) {
      // A real ArduPilot log: the viewer lists its types and decodes attitude samples.
      const reference = join(scratch, "reference.bin");
      writeFileSync(reference, readFileSync(REFERENCE));
      await host.getByLabel("Open DataFlash log (.bin)").setInputFiles(reference);
      await expect(status).toContainText(/Opened reference\.bin: \d{2,} message types\./, { timeout: 120_000 });
      await expect(viewer.locator("li.type a.section", { hasText: "ATT" }).first()).toBeAttached();
      await page.screenshot({ path: "test-results/browser/task-179-analysis.png" });
    }
    expect(errors).toEqual([]);
    expect(aborted).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
