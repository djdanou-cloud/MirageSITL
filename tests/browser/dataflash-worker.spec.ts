import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { viteFileUrl } from '../support/vite-url';

interface Reference { slice: { records: number }; records: { names: string[]; order: number[] } }

test('the DataFlash Worker parses the SITL slice in chunks and transfers typed columns', async ({ page }) => {
  const bytes = Array.from(readFileSync(new URL('../fixtures/dataflash/sitl-copter.bin', import.meta.url)));
  const reference = JSON.parse(readFileSync(new URL('../fixtures/dataflash/reference.json', import.meta.url), 'utf8')) as Reference;
  const counts: Record<string, number> = {};
  for (const index of reference.records.order) {
    const name = reference.records.names[index] ?? '?';
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const workerUrl = viteFileUrl(new URL('../../packages/dataflash/src/dataflash.worker.ts', import.meta.url));
  await page.goto('/');
  await page.route('**/dataflash-worker-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>DataFlash Worker check</title>',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } }));
  await page.goto('/dataflash-worker-test');
  const report = await page.evaluate(async ({ bytes, workerUrl }) => {
    const worker = new Worker(workerUrl, { type: 'module' });
    try {
      const replies: unknown[] = [];
      const done = new Promise<void>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<unknown>) => {
          replies.push(e.data);
          const type = (e.data as { type?: string }).type;
          if (type === 'result' || type === 'error') resolve();
        };
        worker.onerror = e => reject(Error(e.message));
      });
      const source = new Blob([new Uint8Array(bytes)]);
      worker.postMessage({ type: 'parse', id: 7, source, chunkBytes: 16384 });
      await done;
      const rejected = new Promise<unknown>(resolve => { worker.onmessage = (e: MessageEvent<unknown>) => resolve(e.data); });
      worker.postMessage({ type: 'unknown' });
      const result = replies.at(-1) as { type: string; id: number; log: {
        records: number; clock: string; damaged: unknown[];
        groups: { name: string; count: number; timestampsS: Float64Array; columns: { name: string; values: ArrayLike<number | bigint> }[] }[];
      } };
      const gps = result.log.groups.find(g => g.name === 'GPS');
      return {
        type: result.type, id: result.id, records: result.log.records, clock: result.log.clock, damaged: result.log.damaged,
        counts: Object.fromEntries(result.log.groups.filter(g => g.count > 0).map(g => [g.name, g.count])),
        progress: replies.slice(0, -1).map(r => (r as { bytes: number }).bytes),
        gpsWeek: Number(gps?.columns.find(c => c.name === 'GWk')?.values[0]),
        timeIsFloat64: gps?.timestampsS instanceof Float64Array,
        timeUsIsBigInt: typeof gps?.columns.find(c => c.name === 'TimeUS')?.values[0] === 'bigint',
        rejected: await rejected,
        isolated: self.crossOriginIsolated,
      };
    } finally { worker.terminate(); }
  }, { bytes, workerUrl });
  expect(report).toMatchObject({ type: 'result', id: 7, records: reference.slice.records, clock: 'usec', damaged: [], gpsWeek: 2442,
    timeIsFloat64: true, timeUsIsBigInt: true, isolated: true });
  expect(report.counts).toEqual(counts);
  expect(report.progress).toHaveLength(Math.ceil(bytes.length / 16384));
  expect(report.progress.at(-1)).toBe(bytes.length);
  expect(report.rejected).toMatchObject({ type: 'error', id: -1 });
});
