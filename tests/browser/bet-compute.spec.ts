import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { expect, test } from '@playwright/test';
import { viteFileUrl } from '../support/vite-url';

// TASK-091: the G3 compute limit in Chrome, not in Node. An evidence run, because a limit on this
// machine's time means nothing on a shared CI runner:
//
//   CHROMIUM_PATH=... MIRAGE_BET_CHROME_REPORT=test-results/bench/bet-chrome.json npx playwright test tests/browser/bet-compute.spec.ts

/** G3: the compute of one octocopter step at 1200 Hz. */
const G3_COMPUTE_LIMIT_MS = 0.4167;
const report = process.env.MIRAGE_BET_CHROME_REPORT;

const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

test('an octocopter step at 1200 Hz stays inside the G3 compute limit in a Chrome Worker', async ({ page, browser }) => {
  test.skip(!report, 'Set MIRAGE_BET_CHROME_REPORT to measure this machine');
  test.setTimeout(300_000);
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  const variants = ['simd128', 'scalar'] as const;
  const modules = Object.fromEntries(variants.map(name => [name, readFileSync(`packages/wasm-bet/dist/mirage_bet.${name}.wasm`)]));
  await page.goto('/');
  // A blank isolated document, as in bet-runtime.spec.ts: no application running beside the Worker.
  await page.route('**/bet-compute-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>BET compute</title>',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } }));
  await page.goto('/bet-compute-test');
  const workerUrl = viteFileUrl(new URL('./bet-compute-worker.ts', import.meta.url));
  const input = {
    variants: Object.fromEntries(variants.map(name => [name, Array.from(modules[name] ?? [])])),
    profiles: { 'octa-x': json('tests/fixtures/aircraft/octa-x.json'), 'octa-coaxial-16': json('tests/fixtures/aircraft/octa-coaxial-16.json') },
    cards: Object.fromEntries(['motor', 'propeller', 'esc', 'battery'].map(type => [type, json(`tests/fixtures/components/${type}-example.json`)])),
  };
  const loadStart = os.loadavg();
  const result = await page.evaluate(async ({ workerUrl, input }) => {
    const worker = new Worker(workerUrl, { type: 'module' });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<unknown>) => { resolve(event.data); };
        worker.onerror = event => { reject(new Error(event.message)); };
        worker.postMessage({ ...input, variants: Object.fromEntries(Object.entries(input.variants).map(([name, bytes]) => [name, new Uint8Array(bytes)])) });
      });
    } finally { worker.terminate(); }
  }, { workerUrl, input }) as { error?: string; isolated: boolean; simd: boolean; rows: { variant: string; fixture: string; rotors: number; p99Ms: number; p50Ms: number }[] };
  expect(result.error).toBeUndefined();
  expect(result.isolated).toBe(true);
  expect(result.simd).toBe(true);
  writeFileSync(report ?? '', `${JSON.stringify({
    schemaVersion: 1, benchmark: 'bet-kernel-chrome', task: 'TASK-091', generatedAt: new Date().toISOString(),
    load: 'synthetic pad at 0.8 x hover-trim duty, as scripts/bench-bet.mjs; cards tests/fixtures/components/*-example.json; polar naca6409-neuralfoil-v1',
    limit: { g3ComputeMs: G3_COMPUTE_LIMIT_MS, row: 'octa-x at 1200 Hz, p99' },
    rows: result.rows,
    identity: { browser: browser.version(), cpu: os.cpus()[0]?.model ?? 'unknown', cpus: os.cpus().length, platform: process.platform, release: os.release(), memoryBytes: os.totalmem(),
      lowPowerMode: process.platform === 'darwin' ? /lowpowermode\s+1/.test(execFileSync('pmset', ['-g'], { encoding: 'utf8' })) : null,
      loadAverage: { start: loadStart, end: os.loadavg() }, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain', '--', 'native/bet/src', 'packages'], { encoding: 'utf8' }) !== '',
      wasmSha256: Object.fromEntries(variants.map(name => [name, createHash('sha256').update(modules[name] ?? Buffer.alloc(0)).digest('hex')])) },
    scope: 'Compute of BetFlightDynamics flight steps in a Chrome module Worker on this machine, with the 5 us timer of an isolated page; not wakeup lateness, a session or a rendered application.',
  }, null, 2)}\n`);
  const octocopter = result.rows.filter(row => row.fixture === 'octa-x');
  expect(octocopter.length).toBe(2);
  for (const row of octocopter) expect(row.p99Ms, row.variant).toBeLessThanOrEqual(G3_COMPUTE_LIMIT_MS);
});
