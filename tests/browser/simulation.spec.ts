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
    const stateBuffer = p.createSharedMemoryV2(400);
    const reader = new p.StateReaderV2(stateBuffer), pilotWriter = new p.PilotWriterV2(stateBuffer);
    const current = p.newFlightStateV2(), header = p.newHeaderSnapshotV2(), pilot = p.newPilotInputV2();
    const worker = new Worker('/src/physics.worker.ts', { type: 'module' });
    const events: { type: string; requestId?: number; status?: string; epoch?: number }[] = [];
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      const event = p.parseWorkerEventV2(data);
      if (!event) throw new Error('Invalid worker event');
      events.push({ type: event.type, ...('requestId' in event ? { requestId: event.requestId } : {}),
        ...('status' in event ? { status: event.status } : {}), ...('epoch' in event ? { epoch: event.epoch } : {}) });
    };
    const waitFor = async (check: () => boolean) => {
      const until = performance.now() + 5000;
      while (!check()) {
        if (performance.now() > until) throw new Error('Worker test timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    let requestId = 0;
    const command = async (type: string, extra: Record<string, unknown> = {}) => {
      reader.readHeader(header);
      const id = ++requestId;
      worker.postMessage({ protocolVersion: 2, requestId: id, expectedEpoch: header.sessionEpoch, type, ...extra });
      await waitFor(() => events.some(e => e.requestId === id));
      return events.find(e => e.requestId === id);
    };
    const stick = (throttle: number) => {
      reader.readHeader(header);
      pilot.expectedEpoch = header.sessionEpoch; pilot.throttle = throttle;
      pilot.flags = p.PilotFlagV2.Connected | p.PilotFlagV2.Armed; pilot.sampledWallTimeMs = p.wallNow();
      pilotWriter.publish(pilot);
    };
    try {
      worker.postMessage({ type: 'init-v2', protocolVersion: 2, stateBuffer,
        sensorBuffer: p.createSpscQueue('sensor'), actuatorBuffer: p.createSpscQueue('actuator') });
      await waitFor(() => events.some(e => e.type === 'ready-v2'));
      await command('sim.start');
      // Arm at zero throttle (the v2 latch rule), then climb while input stays fresh.
      for (let i = 0; i < 10; i++) { stick(0); await sleep(10); }
      for (let i = 0; i < 30; i++) { stick(0.7); await sleep(10); }
      await waitFor(() => reader.latest(current) && p.tickToNumber(current.tickId) > 10);
      const live = !(current.vehicleFlags & p.VehicleFlagV2.InputFailsafe) && !!(current.vehicleFlags & p.VehicleFlagV2.Armed);
      await sleep(750); reader.latest(current); // no fresh pilot samples for 750 ms
      const stale = !!(current.vehicleFlags & p.VehicleFlagV2.InputFailsafe) && !(current.vehicleFlags & p.VehicleFlagV2.Armed);
      const fixedTime = current.simTimeS === p.tickToNumber(current.tickId) / 400; // sim_time = tick / hz
      const ticks = p.tickToNumber(current.tickId);
      const paused = await command('sim.pause');
      reader.latest(current); const pausedTick = p.tickToNumber(current.tickId);
      await sleep(100); reader.latest(current);
      const held = p.tickToNumber(current.tickId) === pausedTick;
      const reset = await command('sim.reset', { seed: 0 });
      reader.latest(current);
      const resetState = p.tickToNumber(current.tickId) === 0 && current.downM === 0 && current.epoch === 2 && reset?.epoch === 2;
      await command('sim.start');
      await waitFor(() => reader.latest(current) && p.tickToNumber(current.tickId) > 10);
      const disposed = await command('worker.dispose');
      return { live, stale, fixedTime, ticks, held, reset: resetState, paused: paused?.status, disposed: disposed?.status, events };
    } finally { worker.terminate(); }
  }, '/@fs' + fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)));
  expect(result.live).toBe(true); expect(result.stale).toBe(true);
  expect(result.fixedTime).toBe(true); expect(result.ticks).toBeGreaterThan(20);
  expect(result.held).toBe(true); expect(result.reset).toBe(true);
  expect([result.paused, result.disposed]).toEqual(['applied', 'applied']);
  expect(result.events.some(e => e.type === 'reject-v2' || e.type === 'fault-v2')).toBe(false);
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
