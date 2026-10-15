import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test('isolates shared memory, renders, takes off and pauses/resets', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.getByTestId('worker-status')).toHaveText('READY');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Arm motors', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disarm motors', exact: true })).toBeVisible();
  await page.getByLabel('Demo throttle').fill('0.7');
  await expect.poll(async () => Number(await page.getByTestId('altitude').innerText().then(t => t.replace('m', ''))), { timeout: 10000 }).toBeGreaterThan(0.5);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
  await page.waitForTimeout(300); // Allow UI stats to reflect the pause ACK.
  const tick = await page.getByTestId('tick').innerText();
  await page.waitForTimeout(250);
  expect(await page.getByTestId('tick').innerText()).toBe(tick);
  await page.getByRole('button', { name: 'Reset flight' }).click();
  await expect(page.getByTestId('tick')).toHaveText('0 ticks');
  await expect(page.getByTestId('altitude')).toHaveText('0.0m');
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/tmp/mirage-desktop.png', fullPage: true });
});

test('real worker keeps fixed dt, detects stale control and acknowledges lifecycle', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (protocolUrl) => {
    // Use the same Vite-transformed source modules as the application.
    // This URL points to the checkout's own statically known protocol module.
    const p = await import(protocolUrl) as typeof import('@mirage/protocol');
    const buffer = p.createSharedMemory();
    const reader = new p.StateReader(buffer), writer = new p.ControlWriter(buffer);
    const current = p.newState();
    const worker = new Worker('/src/physics.worker.ts', { type: 'module' });
    const events: { type: string; command?: string; requestId?: number }[] = [];
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (typeof data !== 'object' || data === null || !('type' in data) || typeof data.type !== 'string') {
        throw new Error('Invalid worker event');
      }
      const event: { type: string; command?: string; requestId?: number } = { type: data.type };
      if ('command' in data) {
        if (typeof data.command !== 'string') throw new Error('Invalid worker command');
        event.command = data.command;
      }
      if ('requestId' in data) {
        if (typeof data.requestId !== 'number') throw new Error('Invalid worker request ID');
        event.requestId = data.requestId;
      }
      events.push(event);
    };
    const waitFor = async (check: () => boolean) => {
      const until = performance.now() + 5000;
      while (!check()) {
        if (performance.now() > until) throw new Error('Worker test timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    try {
      worker.postMessage({ type: 'init', version: p.ABI_VERSION, buffer });
      await waitFor(() => events.some(e => e.type === 'ready'));
      const input = { ...p.newInput(), throttle: 0.7, flags: 3, wallTimeMs: p.wallNow() };
      writer.publish(input);
      worker.postMessage({ type: 'start', requestId: 1 });
      await waitFor(() => reader.latest(current) && current.tick > 10);
      const live = !(current.flags & p.StateFlag.InputFailsafe);
      await sleep(750); reader.latest(current);
      const stale = !!(current.flags & p.StateFlag.InputFailsafe);
      const fixedTime = current.simTime === current.tick * p.DT;
      const ticks = current.tick;
      worker.postMessage({ type: 'pause', requestId: 2 });
      await waitFor(() => events.some(e => e.type === 'ack' && e.requestId === 2));
      reader.latest(current); const pausedTick = current.tick;
      await sleep(100); reader.latest(current);
      const held = current.tick === pausedTick;
      worker.postMessage({ type: 'reset', requestId: 3 });
      await waitFor(() => events.some(e => e.type === 'ack' && e.requestId === 3));
      reader.latest(current);
      const reset = current.tick === 0 && current.down === 0;
      worker.postMessage({ type: 'start', requestId: 4 });
      await waitFor(() => reader.latest(current) && current.tick > 10);
      worker.postMessage({ type: 'dispose', requestId: 5 });
      await waitFor(() => events.some(e => e.type === 'ack' && e.requestId === 5));
      return { live, stale, fixedTime, ticks, held, reset, events };
    } finally { worker.terminate(); }
  }, '/@fs' + fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)));
  expect(result.live).toBe(true); expect(result.stale).toBe(true);
  expect(result.fixedTime).toBe(true); expect(result.ticks).toBeGreaterThan(20);
  expect(result.held).toBe(true); expect(result.reset).toBe(true);
  expect(result.events.some(e => e.type === 'error')).toBe(false);
});

test('Gamepad API adapter drives USB channels and disarms on unplug', async ({ page }) => {
  await page.addInitScript(() => {
    const fake = { index: 0, connected: true, id: 'EdgeTX simulated USB', axes: [0.5, -0.5, -1, 0.25],
      buttons: [], mapping: '', timestamp: 0, vibrationActuator: null };
    Object.defineProperty(navigator, 'getGamepads', { value: () => [fake] });
    Object.assign(window, { unplugTestPad: () => { fake.connected = false; }, setTestThrottle: (v: number) => { fake.axes[2] = v; } });
  });
  await page.goto('/');
  await expect(page.getByTestId('worker-status')).toHaveText('READY');
  await page.getByRole('button', { name: 'USB / EdgeTX', exact: true }).click();
  await expect(page.getByTestId('input-status')).toContainText('connected EdgeTX');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: 'Arm motors', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disarm motors', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { setTestThrottle: (v: number) => void }).setTestThrottle(0.4));
  await page.evaluate(() => (window as unknown as { unplugTestPad: () => void }).unplugTestPad());
  await expect(page.getByTestId('input-status')).toHaveText('disconnected ');
  await expect(page.getByRole('button', { name: 'Arm motors', exact: true })).toBeVisible();
});

test('mobile layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('worker-status')).toHaveText('READY');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/mirage-mobile.png', fullPage: true });
});
