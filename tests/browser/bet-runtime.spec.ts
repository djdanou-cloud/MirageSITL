import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {viteFileUrl} from '../support/vite-url';

test('production BET runs through a selected SAB flight session in an isolated Worker',async({page})=>{
  test.setTimeout(300000);
  execFileSync(process.execPath,['scripts/build-wasm.mjs'],{stdio:'pipe'});
  const bytes=Array.from(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  const workerUrl=viteFileUrl(new URL('./bet-worker.ts',import.meta.url));
  const protocolUrl=viteFileUrl(new URL('../../packages/protocol/src/index.ts',import.meta.url));
  await page.goto('/');
  // Cold dependency optimization can reload Vite; a blank isolated document
  // retains the origin/COOP/COEP without the application's HMR client.
  await page.route('**/bet-runtime-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>BET runtime check</title>',
    headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}));
  await page.goto('/bet-runtime-test');
  const report=await page.evaluate(async({bytes,workerUrl,protocolUrl})=>{
    const p=await import(protocolUrl) as typeof import('@mirage/protocol');
    const stateBuffer=p.createSharedMemoryV2(),sensorBuffer=p.createSpscQueue('sensor'),actuatorBuffer=p.createSpscQueue('actuator');
    const worker=new Worker(workerUrl,{type:'module'});
    try {
      const done=new Promise<unknown>((resolve,reject)=>{
        worker.onmessage=(e:MessageEvent<unknown>)=>resolve(e.data);
        worker.onerror=e=>reject(Error(e.message));
      });
      worker.postMessage({bytes:new Uint8Array(bytes),stateBuffer,sensorBuffer,actuatorBuffer});
      const message=await done,reader=new p.StateReaderV2(stateBuffer),state=p.newFlightStateV2();
      if(!reader.latest(state))throw Error('No BET state published');
      return {message,state};
    }finally{worker.terminate();}
  },{bytes,workerUrl,protocolUrl});
  expect(report.message).toMatchObject({fault:'',rotors:6,isolated:true});
  expect(report.state.modelId).toBe(75);expect(report.state.tickId.lo).toBe(400);
  expect(report.state.autopilotHealth).toBe(0);expect(report.state.referenceRotorRpm).toBeGreaterThan(0);
});
