import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { viteFileUrl } from '../support/vite-url';

// TASK-146: the application's physics Worker runs a quad X profile on the
// example cards with a 15 A pack limit and a 60 W motor power rating. The
// power panel must show the pack as Limited (the model clamps its current)
// and each motor's power as a Warning (the rating is exceeded, physics runs on).

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('the Run tab shows the power panel without an electrical model for the demo', async ({ page }) => {
  await page.goto('/');
  const run = page.getByRole('tabpanel', { name: 'Run', exact: true });
  await expect(run.getByTestId('power-panel')).toBeVisible();
  await expect(run.getByTestId('power-unavailable')).toContainText('No electrical model');
});

test('the power panel keeps a rating warning apart from a modeled limit on a running profile', async ({ page }) => {
  test.setTimeout(300000);
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  const wasm = readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm');
  const input = {
    bytes: Array.from(wasm), wasmSha256: createHash('sha256').update(wasm).digest('hex'),
    profile: read('../fixtures/aircraft/quad-x.json'),
    cards: Object.fromEntries(['motor', 'propeller', 'esc', 'battery'].map(type => [type, read(`../fixtures/components/${type}-example.json`)])),
    urls: {
      worker: viteFileUrl(new URL('../../apps/web/src/physics.worker.ts', import.meta.url)),
      host: viteFileUrl(new URL('./power-panel-host.tsx', import.meta.url)),
      protocol: viteFileUrl(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
      profile: viteFileUrl(new URL('../../packages/aircraft/src/profile.ts', import.meta.url)),
      components: viteFileUrl(new URL('../../packages/aircraft/src/components.ts', import.meta.url)),
      resolve: viteFileUrl(new URL('../../packages/aircraft/src/resolve-components.ts', import.meta.url)),
      derive: viteFileUrl(new URL('../../packages/aircraft/src/derive-manifest.ts', import.meta.url)),
    },
  };
  await page.goto('/');
  await page.route('**/power-panel-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Power panel check</title>' +
    // @vitejs/plugin-react's preamble, which the application's index.html receives from Vite.
    '<script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};' +
    'window.$RefreshSig$=()=>(t)=>t;window.__vite_plugin_react_preamble_installed__=true;</script><main id="root"></main>',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } }));
  await page.goto('/power-panel-test');
  const report = await page.evaluate(async ({ bytes, wasmSha256, profile, cards, urls }) => {
    const p = await import(urls.protocol) as typeof import('@mirage/protocol');
    const profiles = await import(urls.profile) as typeof import('@mirage/aircraft/profile');
    const components = await import(urls.components) as typeof import('@mirage/aircraft/components');
    const resolver = await import(urls.resolve) as typeof import('@mirage/aircraft/resolve-components');
    const derivation = await import(urls.derive) as typeof import('@mirage/aircraft/derive-manifest');
    const host = await import(urls.host) as typeof import('./power-panel-host');
    const ids = { motor: '11'.repeat(32), propeller: '22'.repeat(32), esc: '33'.repeat(32), battery: '44'.repeat(32) };
    const fixture = profiles.validateAircraftProfile(profile);
    const fitted = profiles.withPropellerPolars(profiles.validateAircraftProfile({ ...fixture, battery: { card: ids.battery },
      motors: fixture.motors.map(motor => ({ ...motor, components: { motor: ids.motor, propeller: ids.propeller, esc: ids.esc } })) }),
    [{ card: ids.propeller, polar: 'naca6409-neuralfoil-v1' }]);
    const edited: Record<string, unknown> = { ...cards };
    const battery = edited.battery as { values: Record<string, unknown> }, motor = edited.motor as { values: Record<string, unknown> };
    edited.battery = { ...battery, values: { ...battery.values, maxDischargeCurrentA: 15 } };
    edited.motor = { ...motor, values: { ...motor.values, maxPowerW: 60 } };
    const cardMap = new Map(Object.entries(edited).map(([type, value]) => [ids[type as keyof typeof ids], components.validateComponentCard(value)]));
    const resolved = resolver.resolveComponents(fitted, cardMap);
    if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
    const derived = await derivation.deriveVehicleManifest(fitted, resolved.components, { modelId: 146 });
    const ratings = resolver.componentRatings(fitted, cardMap);

    const stateBuffer = p.createSharedMemoryV2(), power = p.createPowerChannelV1(), worker = new Worker(urls.worker, { type: 'module' });
    const next = (predicate: (data: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker timeout')), 60000);
      const listener = (event: MessageEvent<unknown>): void => {
        const data = event.data;
        if (typeof data === 'object' && data !== null && predicate(data as Record<string, unknown>)) {
          clearTimeout(timer); worker.removeEventListener('message', listener); resolve(data as Record<string, unknown>);
        }
      };
      worker.addEventListener('message', listener);
    });
    const root = document.getElementById('root');
    if (!root) throw new Error('No root element');
    host.mountPowerPanel(root, power, worker);
    const reader = new p.StateReaderV2(stateBuffer), header = p.newHeaderSnapshotV2(), pilot = new p.PilotWriterV2(stateBuffer);
    const ready = next(d => d.type === 'ready-v2');
    worker.postMessage({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: p.createSpscQueue('sensor'), actuatorBuffer: p.createSpscQueue('actuator') });
    await ready;
    const attached = next(d => d.type === 'power.attached' || d.type === 'power.reject');
    worker.postMessage({ type: 'power.attach', buffer: power });
    const attach = await attached;
    const badRatings = next(d => d.type === 'limits.reject');
    worker.postMessage({ type: 'limits.register', sha256: derived.sha256, ratings: { ...ratings, schemaVersion: 2 } });
    const rejectedRatings = await badRatings;
    const goodRatings = next(d => d.type === 'limits.registered');
    worker.postMessage({ type: 'limits.register', sha256: derived.sha256, ratings });
    await goodRatings;
    const moduleReady = next(d => d.type === 'bet.module.ready');
    worker.postMessage({ type: 'bet.module', bytes: new Uint8Array(bytes), sha256: wasmSha256 });
    await moduleReady;
    const registered = next(d => d.type === 'model.registered');
    worker.postMessage({ type: 'model.register', bytes: derived.bytes, sha256: derived.sha256 });
    await registered;
    const final = (id: number) => (d: Record<string, unknown>) => d.requestId === id && (d.type === 'reject-v2' || (d.type === 'ack-v2' && d.status === 'applied'));
    reader.readHeader(header);
    let result = next(final(1));
    worker.postMessage({ protocolVersion: 2, requestId: 1, expectedEpoch: header.sessionEpoch, type: 'model.load', modelId: 146, manifestSha256: derived.sha256 });
    const load = await result;
    reader.readHeader(header);
    result = next(final(2));
    worker.postMessage({ protocolVersion: 2, requestId: 2, expectedEpoch: header.sessionEpoch, type: 'sim.start' });
    await result;
    // Arm at zero throttle, then hold 80 % throttle with fresh pilot samples.
    const sample = p.newPilotInputV2();
    sample.expectedEpoch = header.sessionEpoch; sample.flags = 3;
    let sampleId = 0;
    const fly = async (throttle: number, ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        sample.throttle = throttle; sample.sampledWallTimeMs = performance.timeOrigin + performance.now(); sample.inputSampleId = ++sampleId;
        pilot.publish(sample);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await fly(0, 300);
    await fly(0.8, 2500);
    const snapshot = p.newPowerSnapshotV1(), powerRead = new p.PowerReaderV1(power).latest(snapshot);
    // Keep the pilot fresh while the panel is checked: a stale pilot stops the motors, which then brake.
    setInterval(() => {
      sample.sampledWallTimeMs = performance.timeOrigin + performance.now(); sample.inputSampleId = ++sampleId;
      pilot.publish(sample);
    }, 20);
    return { attach, rejectedRatings, load, powerRead, motorCount: snapshot.motorCount, batteryLimited: snapshot.batteryLimited,
      currentA: snapshot.currentA, motorWarning: Array.from(snapshot.motorWarning.subarray(0, 4)) };
  }, input);
  expect(report.attach).toMatchObject({ type: 'power.attached' });
  expect(report.rejectedRatings).toMatchObject({ type: 'limits.reject' });
  expect(report.load).toMatchObject({ type: 'ack-v2', status: 'applied' });
  expect(report).toMatchObject({ powerRead: true, motorCount: 4, batteryLimited: 1 });
  expect(report.currentA).toBeCloseTo(15, 6);
  expect(report.motorWarning).toEqual([2, 2, 2, 2]);

  const panel = page.getByTestId('power-panel');
  await expect(panel.getByTestId('power-battery').locator('[data-kind="limited"][data-quantity="pack-current-limit"]')).toHaveText(
    'Limited: pack current at its limit');
  for (let i = 1; i <= 4; i++) {
    const row = panel.getByTestId(`power-motor-${i}`);
    await expect(row.locator('[data-kind="warning"][data-quantity="motor-power"]')).toHaveText('Warning: motor power above the motor rating');
    await expect(row.locator('[data-kind="limited"]')).toHaveCount(0);
  }
  const events = panel.getByTestId('power-events');
  await expect(events.locator('li[data-kind="limited"]').first()).toBeVisible();
  await expect(events.locator('li[data-kind="warning"]').first()).toBeVisible();
  await expect(events).toContainText('Battery: pack current at its limit');
});
