// Native reference plus actual HAL-kernel WASM/JS allocation acceptance.
// Full firmware/browser execution is a separate required report.
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {PerformanceObserver,performance} from 'node:perf_hooks';
import v8 from 'node:v8';
import {Session} from 'node:inspector/promises';
if(!globalThis.gc){
  const r=spawnSync(process.execPath,['--expose-gc','--single-threaded','--max-semi-space-size=64',fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);
}
const root=fileURLToPath(new URL('../',import.meta.url)),cache=resolve(root,'.cache/task-046');mkdirSync(cache,{recursive:true});
const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
const wp=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replaceAll('\\','/');
const repo=wp(root),out=wp(cache),source=repo+'/native/ardupilot/hal/';
const run=s=>execFileSync('wsl.exe',['-e','bash','-lc',s],{encoding:'utf8',timeout:300000});
const sha=b=>createHash('sha256').update(b).digest('hex');
const files=['native/ardupilot/hal/browser_hal.h','native/ardupilot/hal/browser_hal.cpp','native/ardupilot/hal/probe.cpp','native/ardupilot/hal/wasm_probe.cpp',
  'native/ardupilot/hal/sitl-state.patch','packages/autopilot/src/wasm-sitl.ts','packages/autopilot/src/wasm-browser.ts','scripts/check-ardupilot-hal.mjs'];
const sourceInputs=files.map(file=>({file,sha256:sha(readFileSync(resolve(root,file)))}));
const native=[];
let nativeReference=null;
if(process.argv.includes('--reuse-native')) {
  const path=resolve(root,'test-results/validation/task-046-allocation.json'),previous=readFileSync(path),report=JSON.parse(previous);
  for(const file of files.slice(0,3))if(!report.sourceInputs.some(item=>item.file===file&&item.sha256===sha(readFileSync(resolve(root,file)))))
    throw Error('Cannot reuse changed native probe sources');
  if(!Array.isArray(report.native)||report.native.length!==3||!report.native.every((n,i)=>n.hz===[400,800,1200][i]&&n.steps===1000000&&n.allocationCalls===0&&n.positiveControl&&n.stopped))
    throw Error('Cannot reuse failed native probe evidence');
  const archive=`test-results/validation/task-046-allocation-reference-${sha(previous).slice(0,12)}.json`;
  writeFileSync(resolve(root,archive),previous);nativeReference={file:archive,sha256:sha(previous)};
  native.push(...report.native);console.log('Reusing source-identical native measurements; original report archived');
}else{
run(`g++ -std=c++17 -O2 -pthread -fno-builtin-malloc ${q(source+'browser_hal.cpp')} ${q(source+'probe.cpp')} -Wl,--wrap=malloc -o ${q(out+'/native-probe')}`);
for(const hz of [400,800,1200]){
  const result=JSON.parse(run(`${q(out+'/native-probe')} ${hz} 1000000`));native.push(result);
  console.log(`Native HAL ${hz} Hz: ${result.steps} steps, ${result.allocationCalls} allocation calls`);
}
}
const sdk=process.env.MIRAGE_EMSDK_DIR??'/home/dadu/mirage/emsdk';
run(`. ${q(sdk+'/emsdk_env.sh')} >/dev/null 2>&1 && em++ -O2 -std=c++17 -pthread -fno-builtin-malloc ${q(source+'browser_hal.cpp')} ${q(source+'wasm_probe.cpp')} -Wl,--wrap=malloc -sPROXY_TO_PTHREAD=1 -sPTHREAD_POOL_SIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,worker -sEXPORTED_RUNTIME_METHODS='["HEAPU8"]' -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 -o ${q(out+'/hal-probe.mjs')}`);
const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('vite/package.json'))('esbuild');
await build({stdin:{contents:"export {WasmHalPort} from './packages/autopilot/src/wasm-sitl.ts';",resolveDir:root,sourcefile:'hal-probe-entry.ts',loader:'ts'},
  bundle:true,platform:'node',format:'esm',outfile:resolve(cache,'port.mjs')});
const {WasmHalPort}=await import(pathToFileURL(resolve(cache,'port.mjs')).href);
const factory=(await import(pathToFileURL(resolve(cache,'hal-probe.mjs')).href)).default;
const module=await factory({wasmBinary:readFileSync(resolve(cache,'hal-probe.wasm'))});
const port=new WasmHalPort(module,{hz:800,epoch:7,motorMapId:42,motorChannels:[0,1,2,3]});
const events=[],observer=new PerformanceObserver(list=>{for(const e of list.getEntries())events.push(e.startTime);});observer.observe({entryTypes:['gc']});
const settle=()=>new Promise(r=>setTimeout(r,30));
const young=()=>v8.getHeapSpaceStatistics().find(s=>s.space_name==='new_space').space_used_size;
function runSteps(n){
  let spins=0;
  for(let i=0;i<n;i++){
    while(port.state!==1){if(++spins>1000000000)throw Error('Kernel request deadline');}
    if(!port.submit())throw Error('Real HAL kernel rejected input');
  }
  while(port.state!==1){if(++spins>1000000000)throw Error('Kernel completion deadline');}
}
await settle();runSteps(100000);globalThis.gc();await settle();runSteps(10000);globalThis.gc();await settle();
if(module._mirage_probe_control()===0)throw Error('WASM allocator positive control missed');
const profiling=process.argv.includes('--profile'),inspector=profiling?new Session():null;
if(inspector){inspector.connect();await inspector.post('HeapProfiler.enable');await inspector.post('HeapProfiler.startSampling',{samplingInterval:128});}
module._mirage_probe_count_begin();const before=young(),start=performance.now();runSteps(1000000);const end=performance.now(),allocated=young()-before;
const calls=module._mirage_probe_count_end(),bytes=module._mirage_probe_bytes();await settle();
if(inspector){const profile=await inspector.post('HeapProfiler.stopSampling');writeFileSync(resolve(cache,'heap-profile.json'),JSON.stringify(profile,null,2)+'\n');inspector.disconnect();}
const wasm={steps:1000000,calls,bytes,jsIncrementalBytes:allocated,bytesPerStep:allocated/1000000,
  gcEvents:events.filter(t=>t>=start&&t<=end).length,memoryStable:port.memoryStable,elapsedMs:end-start,positiveControl:true};
// Observe an allocating JS control through the same heap/GC instrumentation.
globalThis.gc();await settle();const controlBefore=young(),controlStart=performance.now(),sink={value:null};
for(let i=0;i<1000000;i++)sink.value={i};
const controlEnd=performance.now(),controlBytes=young()-controlBefore;await settle();
const controlDetected=controlBytes>1000000||events.some(t=>t>=controlStart&&t<=controlEnd);
for(const f of sourceInputs)if(sha(readFileSync(resolve(root,f.file)))!==f.sha256)throw Error('Acceptance source changed during measurement');
const passed=native.every(n=>n.steps===1000000&&n.allocationCalls===0&&n.positiveControl&&n.stopped)&&
  calls===0&&bytes===0&&wasm.gcEvents===0&&wasm.bytesPerStep<0.01&&wasm.memoryStable&&controlDetected;
const report={schemaVersion:1,status:passed&&!profiling?'pass':'failed',profiling,sourceInputs,warmupSteps:100000,nativeReference,
  kernelWasmSha256:sha(readFileSync(resolve(cache,'hal-probe.wasm'))),node:process.version,native,wasm,controlDetected,
  scope:'Actual HAL kernel only: native and pthread WASM plus real JS adapter; not whole-ArduPilot allocator certification or flight parity'};
mkdirSync(resolve(root,'test-results/validation'),{recursive:true});writeFileSync(resolve(root,`test-results/validation/task-046-${profiling?'profile':'allocation'}.json`),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));port.stop();observer.disconnect();process.exit(passed?0:1);
