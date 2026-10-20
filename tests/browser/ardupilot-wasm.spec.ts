import {expect,test,type Page} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import golden from '../fixtures/mavlink/wasm-parameters.json' with {type:'json'};
import manifest from '../../native/ardupilot/wasm-artifact.manifest.json' with {type:'json'};

test.skip(!process.env.MIRAGE_ARDUPILOT_WASM_DIR,'Real local firmware artifact required; no synthetic replacement');
test.afterEach(async({page},info)=>{
  if(info.status===info.expectedStatus)return;
  const snapshot:unknown=await page.evaluate(()=>({status:document.querySelector('output')?.textContent,events:window.ardupilotCheck?.events.filter(e=>!(e!==null&&typeof e==='object'&&'type' in e&&e.type==='serial'))})).catch(()=>null);
  writeFileSync(info.outputPath('firmware-diagnostic.json'),JSON.stringify(snapshot,null,2));
  const workers=await Promise.all(page.workers().map(async worker=>({url:worker.url(),
    response:await Promise.race([worker.evaluate(()=>({url:location.href,now:performance.now()})).catch(error=>String(error)),
      new Promise(resolve=>setTimeout(()=>resolve('Worker evaluation deadline'),500))])})));
  const cdp=await page.context().newCDPSession(page);
  const targets=await cdp.send('Target.getTargets');await cdp.detach();
  writeFileSync(info.outputPath('worker-diagnostic.json'),JSON.stringify({workers,targets},null,2));
});
async function boot(page:Page,profile:string):Promise<void>{
  await page.evaluate(profile=>window.ardupilotCheck.start(profile),profile);
  await expect.poll(()=>page.evaluate(()=>window.ardupilotCheck.events.filter(e=>e!==null&&typeof e==='object'&&'type' in e&&e.type==='booted').length),{timeout:30000}).toBe(1);
}
function request(id:number):number[]{const f=golden.frames.find(f=>f.id===id);if(!f)throw Error('Missing independent wire oracle');return Array.from(Buffer.from(f.hex,'hex'));}
async function readParameter(page:Page):Promise<number>{
  await page.evaluate(bytes=>{delete window.ardupilotCheck.parameters.WP_SPD;window.ardupilotCheck.send(bytes);},request(20));
  await expect.poll(()=>page.evaluate(()=>window.ardupilotCheck.parameters.WP_SPD),{timeout:10000}).toBeDefined();
  return page.evaluate(()=>window.ardupilotCheck.parameters.WP_SPD??NaN);
}
async function stop(page:Page):Promise<void>{
  await page.evaluate(()=>window.ardupilotCheck.stop());
  await expect.poll(()=>page.evaluate(()=>window.ardupilotCheck.worker===null),{timeout:20000}).toBe(true);
}
async function checkpointImage(page:Page,profile:string):Promise<unknown>{
  return page.evaluate(async({profile,manifest})=>{
    const {EepromStore,storageIdentity}=window.ardupilotStorage;
    const store=await EepromStore.open(storageIdentity(manifest.sourceCommit,manifest.module.sha256,profile));
    try{const saved=await store.load();return saved?{...saved,image:Array.from(saved.image)}:null;}finally{store.close();}
  },{profile,manifest});
}
test('real firmware boots in an isolated Worker and persists a real parameter across restart',async({page})=>{
  test.setTimeout(120000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/ardupilot-check.html');
  expect(await page.evaluate(()=>crossOriginIsolated)).toBe(true);
  const profile='boot-'+Date.now();await boot(page,profile);
  const initial=await readParameter(page);expect(initial).not.toBe(8.125);
  const bootWorkers=page.workers().length;expect(bootWorkers).toBeGreaterThanOrEqual(1);
  await page.evaluate(bytes=>window.ardupilotCheck.send(bytes),request(23));
  await expect.poll(()=>page.evaluate(()=>window.ardupilotCheck.parameters.WP_SPD)).toBe(8.125);
  await stop(page);
  await expect.poll(()=>page.workers().map(worker=>worker.url())).toEqual([]);
  const first=await page.evaluate(()=>({events:window.ardupilotCheck.events.filter(e=>!(e!==null&&typeof e==='object'&&'type' in e&&e.type==='serial')),serial:window.ardupilotCheck.serial}));
  const firstImage=await checkpointImage(page,profile);
  expect(errors).toEqual([]);
  await boot(page,profile);expect(await readParameter(page)).toBe(8.125);
  await expect.poll(()=>page.evaluate(()=>window.ardupilotCheck.events.filter(e=>e!==null&&typeof e==='object'&&'type' in e&&e.type==='checkpoint').length),{timeout:15000}).toBeGreaterThan(0);
  const second=await page.evaluate(()=>({events:window.ardupilotCheck.events.filter(e=>!(e!==null&&typeof e==='object'&&'type' in e&&e.type==='serial')),serial:window.ardupilotCheck.serial}));
  await page.evaluate(()=>window.ardupilotCheck.terminate());
  await expect.poll(()=>page.workers().map(worker=>worker.url())).toEqual([]);
  const secondImage=await checkpointImage(page,profile);
  await boot(page,profile);expect(await readParameter(page)).toBe(8.125);await stop(page);
  const third=await page.evaluate(()=>({events:window.ardupilotCheck.events.filter(e=>!(e!==null&&typeof e==='object'&&'type' in e&&e.type==='serial')),serial:window.ardupilotCheck.serial}));
  const thirdImage=await checkpointImage(page,profile);
  mkdirSync('test-results/validation',{recursive:true});
  await expect.poll(()=>page.workers().map(worker=>worker.url())).toEqual([]);
  writeFileSync('test-results/validation/task-045-browser-boot.json',JSON.stringify({schemaVersion:1,scope:'Actual local firmware, built-in quad; no MirageSITL physics or autopilot READY',browser:page.context().browser()?.version(),bootWorkers,remainingWorkers:page.workers().length,profile,manifest,initial,first:{...first,checkpoint:firstImage},second:{...second,checkpoint:secondImage},third:{...third,checkpoint:thirdImage},errors},null,2)+'\n');
});
test('checkpoints are atomic under concurrent writers and reject corrupted stored bytes',async({page})=>{
  await page.goto('/ardupilot-check.html');
  const result=await page.evaluate(async()=>{
    const {EepromStore,storageIdentity}=window.ardupilotStorage;
    const identity=storageIdentity('8'.repeat(40),'a'.repeat(64),'transaction-'+Date.now());
    const a=await EepromStore.open(identity),b=await EepromStore.open(identity);
    try {
      const one=await a.commit(new Uint8Array(16384).fill(1),0);
      const races=await Promise.allSettled([a.commit(new Uint8Array(16384).fill(2),1),b.commit(new Uint8Array(16384).fill(3),1)]);
      const current=await a.load();
      // A transaction abort must preserve the entire last committed record.
      await new Promise<void>((resolve,reject)=>{
        const request=indexedDB.open('mirage-ardupilot-eeprom-v1',1);request.onerror=()=>reject(Error('open failed'));
        request.onsuccess=()=>{const db=request.result,tx=db.transaction('profiles','readwrite');
          tx.objectStore('profiles').put({...one,image:new Uint8Array(16384).fill(9)},identity);tx.abort();
          tx.onabort=()=>{db.close();resolve();};};
      });
      const after=await b.load();
      return {races:races.map(r=>r.status),revision:current?.revision,uniform:current?.image.every(v=>v===current.image[0]),same:after?.sha256===current?.sha256};
    }finally{a.close();b.close();}
  });
  expect(result.races.sort()).toEqual(['fulfilled','rejected']);expect(result.revision).toBe(2);expect(result.uniform).toBe(true);expect(result.same).toBe(true);
});
test('profile locks reject a second firmware owner; corrupted EEPROM prevents boot without being erased',async({page,context})=>{
  test.setTimeout(90000);
  const profile='exclusive-'+Date.now();await page.goto('/ardupilot-check.html');await boot(page,profile);
  const other=await context.newPage();await other.goto('/ardupilot-check.html');await other.evaluate(profile=>window.ardupilotCheck.start(profile),profile);
  await expect.poll(()=>other.locator('output').textContent()).toBe('error');
  expect(await other.evaluate(()=>JSON.stringify(window.ardupilotCheck.events))).toContain('already in use');
  await stop(page);await expect.poll(()=>page.workers().map(worker=>worker.url())).toEqual([]);
  const identity=`${manifest.sourceCommit}:${manifest.module.sha256}:${profile}`;
  await page.evaluate(identity=>new Promise<void>((resolve,reject)=>{
    const request=indexedDB.open('mirage-ardupilot-eeprom-v1',1);request.onerror=()=>reject(Error('open failed'));
    request.onsuccess=()=>{const db=request.result,tx=db.transaction('profiles','readwrite'),store=tx.objectStore('profiles'),get=store.get(identity);
      get.onsuccess=()=>{const value:unknown=get.result;
        if(value===null||typeof value!=='object'||!('image' in value)||!(value.image instanceof Uint8Array)){reject(Error('missing checkpoint'));return;}
        value.image[0]=value.image[0]!^1;store.put(value,identity);};
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(Error('corruption probe aborted'));};
  }),identity);
  await page.evaluate(profile=>window.ardupilotCheck.start(profile),profile);
  await expect.poll(()=>page.locator('output').textContent()).toBe('error');
  expect(await page.evaluate(()=>JSON.stringify(window.ardupilotCheck.events))).toContain('checksum');
  expect(page.workers().length).toBe(0);await other.close();
});
test('rejects missing cross-origin isolation before fetching or starting firmware',async({page})=>{
  await page.route('**/ardupilot-check.html',async route=>{
    const response=await route.fetch(),headers=response.headers();delete headers['cross-origin-opener-policy'];delete headers['cross-origin-embedder-policy'];
    await route.fulfill({response,headers});
  });
  let artifactRequests=0;page.on('request',request=>{if(request.url().includes('/__local-ardupilot/'))artifactRequests++;});
  await page.goto('/ardupilot-check.html');expect(await page.evaluate(()=>crossOriginIsolated)).toBe(false);
  await page.evaluate(()=>window.ardupilotCheck.start('isolation-rejection'));
  await expect.poll(()=>page.locator('output').textContent()).toBe('error');expect(artifactRequests).toBe(0);
});
for(const artifact of ['arducopter.js','arducopter.wasm'])test(`rejects changed ${artifact} bytes before starting pthreads`,async({page})=>{
  await page.route('**/__local-ardupilot/'+artifact,async route=>{
    const response=await route.fetch(),bytes=await response.body();bytes[100]=bytes[100]!^1;await route.fulfill({response,body:bytes});
  });
  await page.goto('/ardupilot-check.html');await page.evaluate(()=>window.ardupilotCheck.start('hash-rejection'));
  await expect.poll(()=>page.locator('output').textContent()).toBe('error');
  expect(await page.evaluate(()=>JSON.stringify(window.ardupilotCheck.events))).toContain(artifact.endsWith('.js')?'glue SHA-256':'module SHA-256');
});
test('rejects oversized artifact declarations before fetching bytes',async({page})=>{
  let requests=0;page.on('request',r=>{if(r.url().includes('/__local-ardupilot/'))requests++;});
  await page.goto('/ardupilot-check.html');
  await page.evaluate(override=>window.ardupilotCheck.start('oversized-artifact',override),{...manifest,module:{...manifest.module,bytes:64*1024*1024+1}});
  await expect.poll(()=>page.locator('output').textContent()).toBe('error');expect(requests).toBe(0);
});
test('local artifact serving rejects foreign hosts/origins, writes and unknown files',async({request})=>{
  const path='/__local-ardupilot/manifest.json';
  expect((await request.get(path,{headers:{host:'foreign.invalid'}})).status()).toBe(403);
  expect((await request.get(path,{headers:{origin:'http://foreign.invalid'}})).status()).toBe(403);
  expect((await request.post(path)).status()).toBe(403);
  expect((await request.get('/__local-ardupilot/private-file')).status()).toBe(404);
  expect((await request.get(path)).status()).toBe(200);
});
