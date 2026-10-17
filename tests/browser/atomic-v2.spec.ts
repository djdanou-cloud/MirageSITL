import { viteFileUrl } from "../support/vite-url";
import { expect, test } from '@playwright/test';

// ABI v2 concurrency in a real browser: a module Worker publishes 1e6 frames
// through StateWriterV2 while the page reads through StateReaderV2.
test('ABI v2 transport survives 1e6 concurrent publications in a browser Worker', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const stressUrl = viteFileUrl(new URL('../support/atomic-v2-stress.ts', import.meta.url));
  const workerUrl = viteFileUrl(new URL('../support/atomic-v2-stress.browser-worker.ts', import.meta.url));
  const protocolUrl = viteFileUrl(new URL('../../packages/protocol/src/index.ts', import.meta.url));
  const report = await page.evaluate(async ({ stressUrl, workerUrl, protocolUrl }) => {
    // Statically known checkout modules, transformed by the same Vite server as the application.
    const stress = await import(stressUrl) as typeof import('../support/atomic-v2-stress');
    const protocol = await import(protocolUrl) as typeof import('@mirage/protocol');
    const buffer = protocol.createSharedMemoryV2(), control = new SharedArrayBuffer(16);
    const worker = new Worker(workerUrl, { type: 'module' });
    const finished = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<unknown>) => resolve(data);
      worker.onerror = event => reject(new Error(event.message || 'Stress worker failed'));
    });
    try {
      worker.postMessage({ buffer, control });
      // Yield until the Worker has started, then read synchronously while it writes.
      const started = performance.now() + 30_000;
      while (Atomics.load(new Int32Array(control), stress.CONTROL_STARTED) === 0) {
        if (performance.now() > started) throw new Error('Stress worker did not start');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const result = stress.runStressReader(buffer, new Int32Array(control), 120_000);
      return { ...result, message: await finished };
    } finally { worker.terminate(); }
  }, { stressUrl, workerUrl, protocolUrl });
  console.info('browser stress', JSON.stringify(report));
  expect(report.message).toBe('done');
  expect(report.timedOut).toBe(false);
  expect(report.failures).toBe(0);
  expect(report.finalPublished).toBe(1_000_000);
  expect(report.finalMatches).toBe(true);
  expect(report.torn).toBe(0); expect(report.nonFinite).toBe(0); expect(report.regressions).toBe(0);
  expect(report.reads).toBeGreaterThan(10_000);
});
