import { viteFileUrl } from "../support/vite-url";
import { expect, test } from '@playwright/test';

const protocolUrl = viteFileUrl(new URL('../../packages/protocol/src/index.ts', import.meta.url));

test('real v2 Worker disarms on a stale epoch or device change, paces 800 Hz, and breaks history on reset', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const result = await page.evaluate(async (protocolUrl) => {
    // Statically known checkout module, transformed by the application's Vite server.
    const p = await import(protocolUrl) as typeof import('@mirage/protocol');
    const stateBuffer = p.createSharedMemoryV2(400);
    const reader = new p.StateReaderV2(stateBuffer), pilotWriter = new p.PilotWriterV2(stateBuffer);
    const current = p.newFlightStateV2(), previous = p.newFlightStateV2(), header = p.newHeaderSnapshotV2(), pilot = p.newPilotInputV2();
    const worker = new Worker('/src/physics.worker.ts', { type: 'module' });
    const replies = new Map<number, string>();
    let ready = false;
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      const event = p.parseWorkerEventV2(data);
      if (event?.type === 'ready-v2') ready = true;
      if (event && 'requestId' in event && (event.type === 'reject-v2' || event.status === 'applied')) replies.set(event.requestId, event.type);
    };
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async (check: () => boolean) => {
      const until = performance.now() + 5000;
      while (!check()) { if (performance.now() > until) throw new Error('timed out'); await sleep(5); }
    };
    let requestId = 0;
    const command = async (type: string, extra: Record<string, unknown> = {}) => {
      reader.readHeader(header);
      const id = ++requestId;
      worker.postMessage({ protocolVersion: 2, requestId: id, expectedEpoch: header.sessionEpoch, type, ...extra });
      await waitFor(() => replies.has(id));
      return replies.get(id);
    };
    /** Publishes armed sticks at 0% throttle for `ms`, like Main's rAF loop. */
    const hold = async (ms: number, options: { generation?: number; epoch?: number } = {}) => {
      const until = performance.now() + ms;
      while (performance.now() < until) {
        reader.readHeader(header);
        pilot.expectedEpoch = options.epoch ?? header.sessionEpoch; pilot.throttle = 0;
        pilot.flags = p.PilotFlagV2.Connected | p.PilotFlagV2.Armed; pilot.deviceGeneration = options.generation ?? 0;
        pilot.sampledWallTimeMs = p.wallNow();
        pilotWriter.publish(pilot);
        await sleep(10);
      }
      reader.latest(current);
      return (current.vehicleFlags & p.VehicleFlagV2.Armed) !== 0;
    };
    try {
      worker.postMessage({ type: 'init-v2', protocolVersion: 2, stateBuffer,
        sensorBuffer: p.createSpscQueue('sensor'), actuatorBuffer: p.createSpscQueue('actuator') });
      await waitFor(() => ready);
      await command('sim.start');
      const staleEpochArmed = await hold(150, { epoch: 99 });
      const freshArmed = await hold(150, { generation: 1 });
      const swappedArmed = await hold(150, { generation: 2 });
      await command('sim.pause');
      const configured = await command('sim.configure', { hz: 800, clockMode: 'interactive' });
      reader.readHeader(header);
      const configuredHeader = { hz: header.physicsHz, epoch: header.sessionEpoch };
      const afterEpoch = reader.latestPair(current, previous);
      await command('sim.start');
      await sleep(200);
      reader.latest(current); const t0 = performance.now(), tick0 = p.tickToNumber(current.tickId);
      await sleep(2000);
      reader.latest(current); const t1 = performance.now(), tick1 = p.tickToNumber(current.tickId);
      const pairWhileRunning = reader.latestPair(current, previous);
      return { staleEpochArmed, freshArmed, swappedArmed, configured, configuredHeader, afterEpoch, pairWhileRunning,
        hz: (tick1 - tick0) * 1000 / (t1 - t0), simTimeExact: current.simTimeS === p.tickToNumber(current.tickId) / 800 };
    } finally { worker.terminate(); }
  }, protocolUrl);
  expect(result.staleEpochArmed).toBe(false);
  expect(result.freshArmed).toBe(true);
  expect(result.swappedArmed).toBe(false);
  expect(result.configured).toBe('ack-v2');
  expect(result.configuredHeader).toEqual({ hz: 800, epoch: 2 });
  expect(result.afterEpoch).toBe('latest'); // the new epoch never pairs with the old one
  expect(result.pairWhileRunning).toBe('pair');
  expect(result.simTimeExact).toBe(true);
  // Wall-clock pacing in a shared software browser: executed rate within 10% of 800 Hz.
  expect(result.hz).toBeGreaterThan(720); expect(result.hz).toBeLessThan(880);
});

test('a different transmitter appearing at the armed index disarms the UI and the Worker', async ({ page }) => {
  await page.addInitScript(() => {
    const pad = { index: 0, connected: true, id: 'EdgeTX A', axes: [0, 0, -1, 0], buttons: [], mapping: '', timestamp: 0, vibrationActuator: null };
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad] });
    Object.assign(window, { swapTestPad: () => { pad.id = 'Other transmitter'; } });
  });
  await page.goto('/');
  await expect(page.getByTestId('worker-status')).toHaveText('READY');
  await page.getByRole('button', { name: 'USB / EdgeTX', exact: true }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: 'Arm motors', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disarm motors', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { swapTestPad: () => void }).swapTestPad());
  await expect(page.getByRole('button', { name: 'Arm motors', exact: true })).toBeVisible();
  await expect(page.getByTestId('input-status')).toContainText('Other transmitter');
});

test('a session fault leaves the app resettable without a reload', async ({ page }) => {
  await page.addInitScript(() => {
    // Keeps the app's own physics Worker and state buffer so the test can stage what a faulted session publishes.
    const capture: { worker: Worker | null; stateBuffer: SharedArrayBuffer | null } = { worker: null, stateBuffer: null };
    class CapturingWorker extends Worker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name === 'mirage-physics') capture.worker = this;
      }
      override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
        if (this === capture.worker && typeof message === 'object' && message !== null && 'stateBuffer' in message &&
          message.stateBuffer instanceof SharedArrayBuffer) capture.stateBuffer = message.stateBuffer;
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    }
    Object.defineProperty(window, 'Worker', { value: CapturingWorker, configurable: true, writable: true });
    Object.assign(window, { physicsCapture: capture });
  });
  await page.goto('/');
  await expect(page.getByTestId('worker-status')).toHaveText('READY');
  await page.evaluate(async (protocolUrl) => {
    const p = await import(protocolUrl) as typeof import('@mirage/protocol');
    const { worker, stateBuffer } = (window as unknown as { physicsCapture: { worker: Worker | null; stateBuffer: SharedArrayBuffer | null } }).physicsCapture;
    if (!worker || !stateBuffer) throw new Error('The physics Worker was not captured');
    // Staged exactly as a faulted session publishes it; the paused session writes no header word until its next command.
    new p.StateWriterV2(stateBuffer).setRuntimeFlags(p.RuntimeFlagV2.Ready | p.RuntimeFlagV2.Fault);
    worker.dispatchEvent(new MessageEvent('message', { data: { type: 'fault-v2', protocolVersion: 2, message: 'EW fault registry is full' } }));
  }, protocolUrl);
  await expect(page.getByTestId('worker-status')).toHaveText('FAULT');
  await expect(page.getByRole('alert')).toContainText('EW fault registry is full');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reset flight', exact: true }).click();
  await expect(page.getByTestId('worker-status')).toHaveText('READY');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect.poll(async () => Number.parseInt(await page.getByTestId('tick').innerText(), 10)).toBeGreaterThan(0);
});
