// TASK-128 synthetic reference step G1; setup, reporting and observer work are cold.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PerformanceObserver,performance} from 'node:perf_hooks';
import v8 from 'node:v8';
import {MultirotorReference} from '../../scripts/sitl/multirotor.mjs';
if(!globalThis.gc)throw Error('Use --expose-gc');
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--wasm'||args[2]!=='--out')throw Error('Expected --wasm PATH --out REPORT');
const wasm=readFileSync(args[1]);
const instance=new WebAssembly.Instance(new WebAssembly.Module(wasm),{});
const model=new MultirotorReference(instance,'paired-16'),throttle=new Float64Array(16);
const buffer=instance.exports.memory.buffer;
const checksum=new Float64Array(1);
let tick=0;
function run(n){
  for(let i=0;i<n;i++){
    const u=0.1+(tick%1000)*0.00001;
    for(let m=0;m<16;m++)throttle[m]=u;
    model.step(throttle,1/800);
    checksum[0]+=model.specificForce[2];tick++;
  }
}
const events=[];
const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())events.push(entry.startTime);});
observer.observe({entryTypes:['gc']});
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
const young=()=>v8.getHeapSpaceStatistics().find(s=>s.space_name==='new_space').space_used_size;
async function measure(body,steps){
  globalThis.gc();await settle();const before=young(),start=performance.now();
  body(steps);const end=performance.now(),bytes=young()-before;await settle();
  return {steps,bytes,durationMs:end-start,gcEvents:events.filter(t=>t>=start&&t<=end).length};
}
// Warm representative valid reset poses as well as the identity pose. The body
// reset validator accumulates squared quaternion components; exact-unit-norm-only
// training let V8 specialize the norm residual to zero and deopt on later
// roundoff. The perturbed pose is within the backend's existing 1e-6 validity bound.
for(let i=0;i<10000;i++){
  if(i&1)model.truth.quaternionBodyToNed.set([0.8,0.6000000001,0,0]);
  else model.truth.quaternionBodyToNed.set([0.5,0.5,0.5,0.5]);
  model.body.reset(model.truth);
}
model.truth.quaternionBodyToNed.set([1,0,0,0]);model.body.reset(model.truth);
run(4000000);
const samples=[];
for(let i=0;i<3;i++)samples.push(await measure(run,1000000),await measure(run,2000000));
const sink={value:null};
const control=await measure(n=>{for(let i=0;i<n;i++)sink.value={i};},2000000);
const short=Math.min(...samples.filter(s=>s.steps===1000000).map(s=>s.bytes));
const long=Math.min(...samples.filter(s=>s.steps===2000000).map(s=>s.bytes));
const bytesPerStep=Math.max(0,long-short)/1000000;
const sourceSha256=Object.fromEntries(['scripts/sitl/multirotor.mjs','packages/wasm-bet/src/backend.ts','tests/fixtures/sitl/frames.json','tests/support/frames-allocation.mjs'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const report={schemaVersion:1,task:'TASK-128',frameId:'paired-16',node:process.version,wasmSha256:createHash('sha256').update(wasm).digest('hex'),
 method:'Real 16-rotor reference step and Rust WASM body; warmed N/2N new-space windows, GC observation and allocating control; setup/I/O excluded',
 warmupSteps:4000000,warmupResetPoses:10000,samples,bytesPerStep,zeroAllocation:samples.every(s=>s.gcEvents===0)&&bytesPerStep<0.01,
 memoryStable:instance.exports.memory.buffer===buffer,controlDetected:control.gcEvents>0||control.bytes>1000000,positiveControl:control,
 totalSteps:tick,checksum:checksum[0],sourceSha256};
writeFileSync(args[3],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));observer.disconnect();
if(!report.zeroAllocation||!report.memoryStable||!report.controlDetected)process.exitCode=1;
