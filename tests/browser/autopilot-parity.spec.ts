import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {viteFileUrl} from '../support/vite-url';
import {parityIdentity} from '../support/parity-identity.ts';
test.skip(!process.env.MIRAGE_HAL_ARTIFACT_DIR||!process.env.MIRAGE_PARITY_DEFAULTS,'Real firmware and identical native/browser startup defaults required');
for(const caseId of ['takeoff-land','gcs-failsafe'])
test(`captures the real browser BET ${caseId} for parity diagnosis`,async({page,context})=>{
  test.setTimeout(180000);
  const dir=process.env.MIRAGE_HAL_ARTIFACT_DIR,defaults=process.env.MIRAGE_PARITY_DEFAULTS;
  if(!dir||!defaults)throw Error('Parity inputs missing');
  const manifest:unknown=JSON.parse(readFileSync(resolve(dir,'manifest.json'),'utf8'));
  const defaultsText=readFileSync(defaults,'utf8'),identity=parityIdentity(process.cwd(),defaultsText);
  for(const [name,type] of [['arducopter.js','text/javascript'],['arducopter.wasm','application/wasm']]) {
    if(!name||!type)throw Error('Missing artifact declaration');
    const body=readFileSync(resolve(dir,name));
    await context.route('**/__parity/'+name,route=>route.fulfill({body,contentType:type,headers:{'Cross-Origin-Resource-Policy':'same-origin'}}));
  }
  await page.route('**/parity-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Parity capture</title>',
    headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}));
  await page.goto('/parity-test');
  page.on('console',m=>console.log(m.text()));
  const result=await page.evaluate(async options=>{
    const worker=new Worker(options.workerUrl,{type:'module'});
    const events:Record<string,unknown>[]=[];
    const completed=new Promise<Record<string,unknown>>((resolve,reject)=>{
      const limit=setTimeout(()=>reject(Error('Parity capture deadline')),150000);
      worker.onmessage=(e:MessageEvent<unknown>)=>{
        if(typeof e.data!=='object'||e.data===null)return;
        const v=e.data as Record<string,unknown>;if(v.type!=='complete'&&v.type!=='error')events.push(v);
        if(v.type==='progress'||v.type==='log')console.log(JSON.stringify(v));
        if(v.type==='complete'||v.type==='error'){clearTimeout(limit);resolve(v);}
      };
      worker.onerror=e=>{clearTimeout(limit);reject(Error(e.message));};
    });
    try {
      worker.postMessage({type:'start',baseUrl:new URL('/__parity/',location.href).href,manifest:options.manifest,
        defaultsText:options.defaultsText,bodyBytes:new Uint8Array(options.bodyBytes),failsafe:options.failsafe});
      const capture=await completed;
      const stopped=new Promise<void>((resolve,reject)=>{
        const limit=setTimeout(()=>reject(Error('Parity teardown deadline')),10000);
        worker.onmessage=(e:MessageEvent<unknown>)=>{if(typeof e.data==='object'&&e.data!==null&&'type' in e.data&&e.data.type==='stopped'){clearTimeout(limit);resolve();}};
      });
      worker.postMessage({type:'stop'});await stopped;
      return {capture,events,browser:navigator.userAgent};
    }finally{worker.terminate();}
  },{workerUrl:viteFileUrl(new URL('./autopilot-parity-worker.ts',import.meta.url)),manifest,
    defaultsText,bodyBytes:Array.from(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm')),failsafe:caseId==='gcs-failsafe'});
  mkdirSync('test-results/validation',{recursive:true});
  expect(parityIdentity(process.cwd(),defaultsText)).toEqual(identity);
  writeFileSync(`test-results/validation/task-047-browser-${caseId}.json`,JSON.stringify({identity,defaultsText,caseId,manifest,...result})+'\n');
  expect(result.capture.type).toBe('complete');
  await expect.poll(()=>page.workers().length).toBe(0);
  // Capture completion is transport evidence; the independent flight comparator
  // must still reject incomplete flights, unhealthy EKF and native divergence.
});
