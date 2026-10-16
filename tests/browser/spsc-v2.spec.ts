import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// SPSC sensor queue in a real browser: a module Worker produces 1e6 frames
// (SITL would-block policy) while the page consumes and verifies them.
test('SPSC queue delivers 1e6 frames from a browser Worker in order without loss', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const stressUrl = '/@fs' + fileURLToPath(new URL('../support/spsc-stress.ts', import.meta.url));
  const workerUrl = '/@fs' + fileURLToPath(new URL('../support/spsc-stress.browser-worker.ts', import.meta.url));
  const protocolUrl = '/@fs' + fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url));
  const report = await page.evaluate(async ({ stressUrl, workerUrl, protocolUrl }) => {
    // Statically known checkout modules, transformed by the application's Vite server.
    const stress = await import(stressUrl) as typeof import('../support/spsc-stress');
    const protocol = await import(protocolUrl) as typeof import('@mirage/protocol');
    const buffer = protocol.createSpscQueue('sensor'), control = new SharedArrayBuffer(16);
    const worker = new Worker(workerUrl, { type: 'module' });
    const finished = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<unknown>) => resolve(data);
      worker.onerror = event => reject(new Error(event.message || 'SPSC stress worker failed'));
    });
    try {
      worker.postMessage({ buffer, control });
      const started = performance.now() + 30_000;
      while (Atomics.load(new Int32Array(control), stress.CONTROL_STARTED) === 0) {
        if (performance.now() > started) throw new Error('SPSC stress worker did not start');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const result = stress.runSpscConsumer(buffer, new Int32Array(control), 120_000);
      return { ...result, message: await finished };
    } finally { worker.terminate(); }
  }, { stressUrl, workerUrl, protocolUrl });
  console.info('browser spsc stress', JSON.stringify(report));
  expect(report.message).toBe('done');
  expect(report.timedOut).toBe(false);
  expect([report.received, report.outOfOrder, report.corrupt, report.invalid, report.encodeFailures]).toEqual([1_000_000, 0, 0, 0, 0]);
  expect(report.fullEvents).toBe(report.wouldBlock);
});
