import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";

// TASK-162: recorder v2 in Chromium. The application's physics Worker runs the
// demo session with the producer armed; the recorder Worker streams chunks to
// the persistent IndexedDB database; the browser is closed and relaunched on
// the same profile, and the records reopen: a closed one with every row, and
// one cut off mid-recording as interrupted with the chunks written before.
type Harness = typeof import("../support/recorder-v2-harness");
const harnessUrl = viteFileUrl(new URL("../support/recorder-v2-harness.ts", import.meta.url));
const workerUrl = viteFileUrl(new URL("../../apps/web/src/physics.worker.ts", import.meta.url));

test("records the physics Worker at its effective rates and reopens closed and interrupted records after a browser restart", async ({ playwright, launchOptions, headless, baseURL }, testInfo) => {
  test.setTimeout(180000);
  const userDataDir = testInfo.outputPath("chrome-profile");
  const open = async (): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await playwright.chromium.launchPersistentContext(userDataDir, { ...launchOptions, headless, baseURL });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("/");
    await page.evaluate(async url => { await import(url); }, harnessUrl);
    return { context, page };
  };

  const first = await open();
  const recorded = await first.page.evaluate(async ({ url, worker }) => (await import(url) as Harness).recordPhysics(worker, 3), { url: harnessUrl, worker: workerUrl });
  const unfinished = await first.page.evaluate(async url => (await import(url) as Harness).recordUnfinished(), harnessUrl);
  // Closing the browser ends the recorder Worker without its close: the second record stays `recording` in storage.
  await first.context.close();

  const second = await open();
  const closed = await second.page.evaluate(async ({ url, id }) => (await import(url) as Harness).reopen(id), { url: harnessUrl, id: recorded.recordId });
  const cut = await second.page.evaluate(async ({ url, id }) => (await import(url) as Harness).reopen(id), { url: harnessUrl, id: unfinished.recordId });
  await second.context.close();

  // Evidence line for the roadmap: the counts this run produced.
  console.log(JSON.stringify({ positionRows: closed.rows["truth.position"], velocityRows: closed.rows["truth.velocity"], closedChunks: closed.entry.storedChunks,
    closedBytes: closed.entry.bytes, interruptedRows: cut.rows["truth.position"], interruptedChunks: cut.entry.storedChunks, unfinishedTicks: unfinished.ticks }));
  // A 2 kHz request on the 400 Hz source is capped, and the record's own header says so.
  expect(recorded.motors).toMatchObject({ requestedHz: 2000, effectiveHz: 400, capped: true });
  expect(closed.header.signals.find(s => s.name === "motors.speed")).toMatchObject({ requestedHz: 2000, effectiveHz: 400, capped: true });

  expect(closed.status).toBe("closed");
  expect([closed.missing, closed.corrupt, closed.gaps]).toEqual([[], 0, 0]);
  const n = closed.rows["truth.position"] ?? 0;
  expect(n).toBeGreaterThan(400);
  expect(closed.increasing).toBe(true);
  expect((closed.lastTick ?? 0) - (closed.firstTick ?? 0) + 1).toBe(n);
  // Every 50 Hz physics signal kept exactly floor(n · 50 / 400) samples of the same ticks.
  for (const name of ["truth.velocity", "truth.attitude", "truth.bodyRates", "truth.acceleration", "truth.specificForce", "truth.air", "pilot"]) {
    expect([name, closed.rows[name]]).toEqual([name, Math.floor(n * 50 / 400)]);
  }
  // The demo has no electrical drive and no actuator frames: no rows, only absent counts at the effective rates.
  for (const name of ["motors.speed", "motors.current", "motors.busCurrent", "motors.power", "motors.command", "battery", "actuators"]) {
    expect([name, closed.rows[name]]).toEqual([name, undefined]);
  }
  expect(closed.entry.absent["motors.speed"]).toBe(n);
  expect(closed.entry.absent.battery).toBe(Math.floor(n * 50 / 400));
  expect(closed.entry.producerLost).toBe(0);
  expect(closed.rows["events.pause"]).toBe(1);
  expect(closed.parameter).toEqual([{ name: "ATC_RAT_RLL_I", value: Math.fround(0.00017) }, { name: "FRAME_CLASS", value: 1 }]);

  expect(cut.status).toBe("interrupted");
  expect(cut.entry.storedChunks).toBeGreaterThanOrEqual(2);
  expect([cut.missing, cut.corrupt]).toEqual([[], 0]);
  expect(cut.rows["truth.position"]).toBeGreaterThan(0);
  expect(cut.rows["truth.position"]).toBeLessThanOrEqual(unfinished.ticks);
  expect(cut.firstTick).toBe(1);
  expect((cut.lastTick ?? 0) - (cut.firstTick ?? 0) + 1).toBe(cut.rows["truth.position"]);
});
