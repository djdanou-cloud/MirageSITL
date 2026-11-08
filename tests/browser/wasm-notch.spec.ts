// TASK-105: the harmonic notch of the real browser firmware follows the motor speeds the host publishes (ESC telemetry mode 3).
// Declared before the first run in SPECS_SIMULATION_ENGINES "Notch tracking in the browser firmware": every FTNS row in the last
// second of a phase within 0.01 Hz of the phase's mean speed over 60, at least five rows a phase.
import {test,expect} from '@playwright/test';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {readDataFlash,type DataFlashLog} from '@mirage/dataflash/reader';
import {viteFileUrl} from '../support/vite-url';

test.skip(!process.env.MIRAGE_HAL_ARTIFACT_DIR,'Real local HAL-enabled firmware required; no synthetic substitute');

/** [start s, end s, expected notch Hz]: the worker's phases (4800, 7200, then 4000 to 7000 rpm), mean speed over 60. */
const PHASES:readonly (readonly [number,number,number])[]=[[6,9,80],[9,12,120],[12,15,5500/60]];
const LIMIT_HZ=0.01,MIN_ROWS=5;

function rows(log:DataFlashLog,name:string,field:string):{timeS:number;value:number}[] {
  const group=log.groups.find(g=>g.name===name);if(!group)return [];
  const time=group.columns.find(c=>c.name==='TimeUS'),value=group.columns.find(c=>c.name===field);
  if(!time||!value)return [];
  const out:{timeS:number;value:number}[]=[];
  for(let row=0;row<group.count;row++)out.push({timeS:Number(time.values[row])*1e-6,value:Number(value.values[row])*value.valueScale});
  return out;
}

test('the browser firmware\'s harmonic notch follows the published motor speeds',async({page,context})=>{
  test.setTimeout(240000);
  const directory=process.env.MIRAGE_HAL_ARTIFACT_DIR;if(!directory)throw Error('HAL artifact directory missing');
  const manifest:unknown=JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8'));
  const workerUrl=viteFileUrl(new URL('./wasm-notch-worker.ts',import.meta.url));
  const files=new Map<string,{bytes:Buffer;type:string}>([
    ['arducopter.js',{bytes:readFileSync(resolve(directory,'arducopter.js')),type:'text/javascript'}],
    ['arducopter.wasm',{bytes:readFileSync(resolve(directory,'arducopter.wasm')),type:'application/wasm'}],
  ]);
  await context.route('**/__hal-test/*',async route=>{
    const file=files.get(new URL(route.request().url()).pathname.split('/').pop()??'');
    if(!file){await route.fulfill({status:404});return;}
    await route.fulfill({body:file.bytes,contentType:file.type,headers:{'Cross-Origin-Resource-Policy':'same-origin'}});
  });
  await page.route('**/hal-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Notch check</title>',
    headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}));
  await page.goto('/hal-test');
  const result=await page.evaluate(async({workerUrl,manifest})=>{
    const worker=new Worker(workerUrl,{type:'module'}),events:Record<string,unknown>[]=[];
    let onEvent=()=>{};
    worker.onmessage=(e:MessageEvent<unknown>)=>{if(typeof e.data==='object'&&e.data!==null){events.push(e.data as Record<string,unknown>);onEvent();}};
    const next=(type:string)=>new Promise<Record<string,unknown>>((resolve,reject)=>{
      const limit=setTimeout(()=>reject(Error('Notch Worker deadline: '+JSON.stringify(events.filter(e=>e.type!=='complete')))),200000);
      const check=()=>{
        const error=events.find(e=>e.type==='error');if(error){clearTimeout(limit);reject(Error(String(error.message)));return;}
        const found=events.find(e=>e.type===type);if(found){clearTimeout(limit);resolve(found);}
      };onEvent=check;check();
    });
    try {
      worker.postMessage({type:'start',baseUrl:new URL('/__hal-test/',location.href).href,manifest});
      const complete=await next('complete');
      worker.postMessage({type:'stop'});const stopped=await next('stopped');
      return {complete,stopped,browser:navigator.userAgent};
    }finally{worker.terminate();}
  },{workerUrl,manifest});
  const complete=result.complete;
  expect(complete.fault).toBe('');expect(complete.memoryStable).toBe(true);expect(complete.steps).toBe(17*800);
  const logs=complete.logs;
  if(!Array.isArray(logs)||logs.length===0)throw Error('The firmware wrote no DataFlash log');
  const last:unknown=logs[logs.length-1];
  if(typeof last!=='object'||last===null||!('bytes' in last)||!Array.isArray(last.bytes)||!('name' in last))throw Error('Invalid log copy');
  const bytes=Uint8Array.from(last.bytes.map(Number));
  const log=readDataFlash(bytes),notch=rows(log,'FTNS','NF');
  const phases=PHASES.map(([from,to,expected])=>{
    const judged=notch.filter(r=>r.timeS>=to-1&&r.timeS<to);
    const worst=judged.reduce((w,r)=>Math.max(w,Math.abs(r.value-expected)),0);
    return {fromS:from,toS:to,expectedHz:expected,rows:judged.length,worstErrorHz:worst,
      values:judged.map(r=>Math.round(r.value*1e5)/1e5),firstRowsOfPhase:notch.filter(r=>r.timeS>=from&&r.timeS<from+0.5).map(r=>Math.round(r.value*1e3)/1e3)};
  });
  mkdirSync('test-results/browser',{recursive:true});writeFileSync('test-results/browser/task-105-notch.BIN',bytes);
  writeFileSync('test-results/browser/task-105-notch.json',JSON.stringify({manifest,browser:result.browser,log:String(last.name),
    logBytes:bytes.length,ftnsRows:notch.length,phases,terminatedPthreads:result.stopped.terminatedPthreads},null,2)+'\n');
  for(const phase of phases) {
    expect(phase.rows,`FTNS rows in the last second before ${phase.toS} s`).toBeGreaterThanOrEqual(MIN_ROWS);
    expect(phase.worstErrorHz,`notch frequency against ${phase.expectedHz} Hz`).toBeLessThanOrEqual(LIMIT_HZ);
  }
});
