import {test,expect} from '@playwright/test';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {viteFileUrl} from '../support/vite-url';

test.skip(!process.env.MIRAGE_HAL_ARTIFACT_DIR,'Real local HAL-enabled firmware required; no synthetic substitute');
for(const {hz,coupled} of [{hz:400,coupled:false},{hz:800,coupled:false},{hz:1200,coupled:false},{hz:800,coupled:true}])
test(`real HAL firmware ${coupled?'couples NACA6409 BET':'exchanges SI sensors and PWM'} at ${hz} Hz and pauses/stops`,async({page,context})=>{
  test.setTimeout(180000);
  const directory=process.env.MIRAGE_HAL_ARTIFACT_DIR;if(!directory)throw Error('HAL artifact directory missing');
  const manifest:unknown=JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8'));
  const workerUrl=viteFileUrl(new URL('./wasm-hal-worker.ts',import.meta.url));
  const bodyBytes=coupled?Array.from(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm')):null;
  const files=new Map<string,{bytes:Buffer;type:string}>([
    ['arducopter.js',{bytes:readFileSync(resolve(directory,'arducopter.js')),type:'text/javascript'}],
    ['arducopter.wasm',{bytes:readFileSync(resolve(directory,'arducopter.wasm')),type:'application/wasm'}],
  ]);
  await context.route('**/__hal-test/*',async route=>{
    const file=files.get(new URL(route.request().url()).pathname.split('/').pop()??'');
    if(!file){await route.fulfill({status:404});return;}
    await route.fulfill({body:file.bytes,contentType:file.type,headers:{'Cross-Origin-Resource-Policy':'same-origin'}});
  });
  await page.route('**/hal-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>HAL check</title>',
    headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}));
  await page.goto('/hal-test');
  const result=await page.evaluate(async({workerUrl,manifest,hz,bodyBytes})=>{
    const worker=new Worker(workerUrl,{type:'module'}),events:Record<string,unknown>[]=[];
    let onEvent=()=>{};
    worker.onmessage=(e:MessageEvent<unknown>)=>{
      if(typeof e.data==='object'&&e.data!==null){events.push(e.data as Record<string,unknown>);onEvent();}
    };
    const next=(type:string)=>new Promise<Record<string,unknown>>((resolve,reject)=>{
      const limit=setTimeout(()=>reject(Error('HAL Worker deadline: '+JSON.stringify(events))),150000);
      const check=()=>{
        const error=events.find(e=>e.type==='error');if(error){clearTimeout(limit);reject(Error(String(error.message)));return;}
        const found=events.find(e=>e.type===type);if(found){clearTimeout(limit);resolve(found);}
      };onEvent=check;check();
    });
    try {
      worker.postMessage({type:'start',baseUrl:new URL('/__hal-test/',location.href).href,manifest,hz,
        bodyBytes:bodyBytes?new Uint8Array(bodyBytes):null});
      const paused=await next('paused');await new Promise(resolve=>setTimeout(resolve,150));
      worker.postMessage({type:'snapshot'});const frozen=await next('snapshot');
      worker.postMessage({type:'continue'});const complete=await next('complete');
      worker.postMessage({type:'stop'});const stopped=await next('stopped');
      return {paused,frozen,complete,stopped,browser:navigator.userAgent};
    }finally{worker.terminate();}
  },{workerUrl,manifest,hz,bodyBytes});
  expect(result.paused.steps).toBe(200);expect(result.frozen.steps).toBe(200);
  expect(result.frozen.diagnostics).toEqual(result.paused.diagnostics);
  expect(result.complete.steps).toBe(hz*(coupled?1:8));expect(result.complete.memoryStable).toBe(true);
  expect(result.complete.fault).toBe('');expect(result.complete.isolated).toBe(true);
  if(coupled) {
    expect(result.complete.body).toMatchObject({tick:800,modelId:73});
    if(typeof result.complete.body!=='object'||result.complete.body===null||!('downM' in result.complete.body))throw Error('Missing BET truth');
    expect(result.complete.body.downM).toBeGreaterThan(-20); // actual unarmed free flight, no fabricated ground support
  }else expect(result.complete.diagnostics).toEqual(expect.arrayContaining([5.729577951308233,210,28.64788975654116,8000000]));
  expect(result.complete.serialBytes).toBeGreaterThan(0);expect(result.stopped.terminatedPthreads).toBeGreaterThanOrEqual(4);
  await expect.poll(()=>page.workers().length).toBe(0);
  mkdirSync('test-results/validation',{recursive:true});writeFileSync(`test-results/validation/task-046-browser-${hz}${coupled?'-bet':''}.json`,JSON.stringify({manifest,...result},null,2)+'\n');
});
