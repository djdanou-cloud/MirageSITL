import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { viteFileUrl } from '../support/vite-url';

// TASK-144: the application's physics Worker loads a profile-derived model.
// Chromium derives the 16-rotor manifest from the S19 fixture and the example
// cards, the Worker verifies the BET module and the manifest by hash, and a
// Control Protocol v2 model.load switches the session from the demo to it.

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('the physics Worker registers and loads 16-rotor profile dynamics, keeping the demo until model.load', async ({ page }) => {
  test.setTimeout(300000);
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  const wasm = readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm');
  const input = {
    bytes: Array.from(wasm), wasmSha256: createHash('sha256').update(wasm).digest('hex'),
    profile: read('../fixtures/aircraft/octa-coaxial-16.json'),
    cards: Object.fromEntries(['motor', 'propeller', 'esc', 'battery'].map(type => [type, read(`../fixtures/components/${type}-example.json`)])),
    urls: {
      worker: viteFileUrl(new URL('../../apps/web/src/physics.worker.ts', import.meta.url)),
      protocol: viteFileUrl(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
      profile: viteFileUrl(new URL('../../packages/aircraft/src/profile.ts', import.meta.url)),
      components: viteFileUrl(new URL('../../packages/aircraft/src/components.ts', import.meta.url)),
      resolve: viteFileUrl(new URL('../../packages/aircraft/src/resolve-components.ts', import.meta.url)),
      derive: viteFileUrl(new URL('../../packages/aircraft/src/derive-manifest.ts', import.meta.url)),
    },
  };
  await page.goto('/');
  await page.route('**/profile-dynamics-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Profile dynamics check</title>',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } }));
  await page.goto('/profile-dynamics-test');
  const report = await page.evaluate(async ({ bytes, wasmSha256, profile, cards, urls }) => {
    const p = await import(urls.protocol) as typeof import('@mirage/protocol');
    const profiles = await import(urls.profile) as typeof import('@mirage/aircraft/profile');
    const components = await import(urls.components) as typeof import('@mirage/aircraft/components');
    const resolver = await import(urls.resolve) as typeof import('@mirage/aircraft/resolve-components');
    const derivation = await import(urls.derive) as typeof import('@mirage/aircraft/derive-manifest');
    const ids = { motor: '11'.repeat(32), propeller: '22'.repeat(32), esc: '33'.repeat(32), battery: '44'.repeat(32) };
    const fixture = profiles.validateAircraftProfile(profile);
    const fitted = profiles.withPropellerPolars(profiles.validateAircraftProfile({ ...fixture, battery: { card: ids.battery },
      motors: fixture.motors.map(motor => ({ ...motor, components: { motor: ids.motor, propeller: ids.propeller, esc: ids.esc } })) }),
    [{ card: ids.propeller, polar: 'naca6409-neuralfoil-v1' }]);
    const cardMap = new Map(Object.entries(cards).map(([type, value]) => [ids[type as keyof typeof ids], components.validateComponentCard(value)]));
    const resolved = resolver.resolveComponents(fitted, cardMap);
    if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
    const derived = await derivation.deriveVehicleManifest(fitted, resolved.components, { modelId: 144 });

    const stateBuffer = p.createSharedMemoryV2(), worker = new Worker(urls.worker, { type: 'module' });
    const messages: unknown[] = [];
    const next = (predicate: (data: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker timeout')), 60000);
      const listener = (event: MessageEvent<unknown>): void => {
        const data = event.data;
        messages.push(data);
        if (typeof data === 'object' && data !== null && predicate(data as Record<string, unknown>)) {
          clearTimeout(timer); worker.removeEventListener('message', listener); resolve(data as Record<string, unknown>);
        }
      };
      worker.addEventListener('message', listener);
    });
    try {
      const reader = new p.StateReaderV2(stateBuffer), header = p.newHeaderSnapshotV2(), state = p.newFlightStateV2();
      const ready = next(d => d.type === 'ready-v2');
      worker.postMessage({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: p.createSpscQueue('sensor'), actuatorBuffer: p.createSpscQueue('actuator') });
      await ready;
      const demoModel = reader.latest(state) ? state.modelId : -1;
      // A load before the module and the registration is rejected.
      reader.readHeader(header);
      // A model load is acknowledged as accepted first; its final result is a reject or an applied ack for the same request.
      const final = (id: number) => (d: Record<string, unknown>): boolean => d.requestId === id && (d.type === 'reject-v2' || (d.type === 'ack-v2' && d.status === 'applied'));
      let result = next(final(7));
      worker.postMessage({ protocolVersion: 2, requestId: 7, expectedEpoch: header.sessionEpoch, type: 'model.load', modelId: 144, manifestSha256: derived.sha256 });
      const early = await result;
      const badModule = next(d => d.type === 'bet.module.reject');
      worker.postMessage({ type: 'bet.module', bytes: new Uint8Array(bytes), sha256: '00'.repeat(32) });
      const rejectedModule = await badModule;
      const moduleReady = next(d => d.type === 'bet.module.ready');
      worker.postMessage({ type: 'bet.module', bytes: new Uint8Array(bytes), sha256: wasmSha256 });
      await moduleReady;
      const registered = next(d => d.type === 'model.registered');
      worker.postMessage({ type: 'model.register', bytes: derived.bytes, sha256: derived.sha256 });
      const registration = await registered;
      reader.readHeader(header);
      result = next(final(8));
      worker.postMessage({ protocolVersion: 2, requestId: 8, expectedEpoch: header.sessionEpoch, type: 'model.load', modelId: 144, manifestSha256: derived.sha256 });
      const load = await result;
      await new Promise(resolve => setTimeout(resolve, 50));
      if (!reader.latest(state)) throw new Error('No state published');
      return { demoModel, early, rejectedModule, registration, load, modelId: state.modelId, batteryVoltage: state.batteryVoltage,
        outsideValidity: (state.vehicleFlags & p.VehicleFlagV2.ModelOutsideValidity) !== 0, rotors: derived.manifest.rotorCount };
    } finally { worker.terminate(); }
  }, input);
  expect(report.rotors).toBe(16);
  expect(report.demoModel).not.toBe(144);
  expect(report.early).toMatchObject({ type: 'reject-v2', code: 'ASSET_MISSING' });
  expect(report.rejectedModule).toMatchObject({ type: 'bet.module.reject', message: 'BET module SHA-256 mismatch' });
  expect(report.registration).toMatchObject({ type: 'model.registered', modelId: 144 });
  expect(report.load).toMatchObject({ type: 'ack-v2', status: 'applied' });
  expect(report.modelId).toBe(144);
  expect(report.batteryVoltage).toBeCloseTo(16.8, 4);
  expect(report.outsideValidity).toBe(true);
});
