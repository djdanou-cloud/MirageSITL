// Actual production rotor/body/session acceptance; synthetic, not measured fidelity.
import {createRequire} from 'node:module';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {PerformanceObserver,performance} from 'node:perf_hooks';
import v8 from 'node:v8';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const allocation=process.argv.includes('--allocation');
if(allocation && !globalThis.gc){
  const result=spawnSync(process.execPath,['--expose-gc','--single-threaded','--max-semi-space-size=64',fileURLToPath(import.meta.url),'--allocation'],{stdio:'inherit'});
  process.exit(result.status??1);
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=path=>readFileSync(resolve(root,path));
mkdirSync(resolve(root,'.cache/bet-runtime'),{recursive:true});
const bundle=resolve(root,'.cache/bet-runtime/acceptance.mjs');
const bundled=await build({stdin:{contents:`export {BetRotorEngine} from './packages/wasm-bet/src/rotor.ts';
export {BetFlightDynamics} from './packages/physics/src/bet-dynamics.ts';
export {flightConfiguration,rotorDefinition} from './tests/bet-runtime-fixture.ts';`,resolveDir:root,sourcefile:'bet-runtime-entry.ts',loader:'ts'},
  bundle:true,platform:'node',format:'esm',packages:'external',outfile:bundle,metafile:true});
const {BetRotorEngine,BetFlightDynamics,flightConfiguration,rotorDefinition}=await import(pathToFileURL(bundle).href);
const modules=['scalar','simd128'].map(v=>new WebAssembly.Module(read(`packages/wasm-bet/dist/mirage_bet.${v}.wasm`)));
const sourceFiles=Object.keys(bundled.metafile.inputs).filter(p=>p!=='bet-runtime-entry.ts').map(p=>p.replaceAll('\\','/'));
sourceFiles.push('scripts/check-bet-runtime.mjs','native/bet/src/bound.rs','native/bet/src/polar.rs','native/bet/src/lib.rs',
  'native/bet/src/blade.rs','native/bet/src/shaft.rs','native/bet/src/inflow.rs','native/bet/src/rigid_body.rs',
  'native/bet/src/body_abi.rs','native/Cargo.lock','native/rust-toolchain.toml',
  'packages/physics/package.json','packages/wasm-bet/package.json',
  'native/bet/Cargo.toml','native/bet/tests/allocation.rs','native/bet/tests/support/bound_fixture.rs');
for (const entry of readdirSync(resolve(root,'native/bet/src')))
  if(entry.endsWith('.rs')) sourceFiles.push('native/bet/src/'+entry);
const identity={sourceInputs:[...new Set(sourceFiles)].map(file=>({file,sha256:sha(read(file))})),
  artifactSha256:{scalar:sha(read('packages/wasm-bet/dist/mirage_bet.scalar.wasm')),simd128:sha(read('packages/wasm-bet/dist/mirage_bet.simd128.wasm'))},
  node:process.version,platform:process.platform,architecture:process.arch};
mkdirSync(resolve(root,'test-results/validation'),{recursive:true});
if(!allocation){
  const cases=[];
  function trajectory(module,index,count,hz){
    const d=new BetFlightDynamics(module,flightConfiguration(index,count),hz);
    const pilot={flags:3,throttle:0.5,roll:0,pitch:0,yaw:0,wallTimeMs:0};
    let flags=0;
    for(let i=0;i<hz*10;i++){
      const t=(i+0.5)/hz;pilot.throttle=0.5+0.05*Math.sin(t*2*Math.PI/5);
      d.nowMs=t*1000;pilot.wallTimeMs=d.nowMs;d.stepNow(pilot);flags|=d.validityFlags;
      if(d.fault)throw Error(d.fault);
    }
    const s={...d.state},stable=d.engine.memoryStable;d.dispose();return {s,flags,stable};
  }
  for(let index=0;index<3;index++){
    const count=4+index*2,reference=trajectory(modules[0],index,count,4800);
    for(let v=0;v<2;v++)for(const hz of [400,800,1200]){
      const result=trajectory(modules[v],index,count,hz),a=result.s,b=reference.s;
      const positionErrorM=Math.hypot(a.north-b.north,a.east-b.east,a.down-b.down);
      const dot=Math.min(1,Math.abs(a.qw*b.qw+a.qx*b.qx+a.qy*b.qy+a.qz*b.qz));
      const attitudeErrorRad=2*Math.acos(dot);
      cases.push({configuration:index,rotors:count,variant:v===0?'scalar':'simd128',hz,referenceHz:4800,durationS:10,
        positionErrorM,attitudeErrorRad,validityFlags:result.flags,memoryStable:result.stable,
        passed:positionErrorM<=0.1 && attitudeErrorRad<=Math.PI/360 && result.stable});
    }
    console.log(`BET runtime convergence: configuration=${index}; ${cases.slice(-6).filter(c=>c.passed).length}/6 passed`);
  }
  const report={schemaVersion:1,status:cases.every(c=>c.passed)?'pass':'failed',...identity,cases,
    tolerance:{positionM:0.1,attitudeRad:Math.PI/360},scope:'Actual rotor/polar/free-shaft/axial-inflow/frame/body graph; synthetic geometry and NeuralFoil predictions; flags remain active; no measured-fidelity or target-device timing claim'};
  writeFileSync(resolve(root,'test-results/validation/bet-runtime.json'),JSON.stringify(report,null,2)+'\n');
  if(report.status!=='pass')process.exitCode=1;
}else{
  const native=execFileSync('cargo',['test','--release','-p','mirage-bet','--test','allocation','--locked'],{cwd:resolve(root,'native'),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:300000});
  if(!native.includes('production_bound_step_allocates_zero_over_one_million_steps ... ok') || !native.includes('test result: ok. 2 passed;'))throw Error('Native bound allocator check did not execute');
  const events=[],observer=new PerformanceObserver(list=>{for(const e of list.getEntries())events.push(e.startTime);});observer.observe({entryTypes:['gc']});
  const settle=()=>new Promise(r=>setTimeout(r,30));
  const young=()=>v8.getHeapSpaceStatistics().find(s=>s.space_name==='new_space').space_used_size;
  async function measure(fn,n){globalThis.gc();await settle();const before=young(),start=performance.now();fn(n);const end=performance.now(),bytes=young()-before;await settle();
    return {steps:n,bytes,bytesPerStep:bytes/n,gcEvents:events.filter(t=>t>=start&&t<=end).length,elapsedMs:end-start};}
  const samples=[];
  for(let v=0;v<2;v++){
    const e=new BetRotorEngine(modules[v],[rotorDefinition(0)],800),bytes=e.memoryBytes;e.input[12]=0.01;
    const run=n=>{for(let i=0;i<n;i++)if(!e.stepInto())throw Error('Bound rotor allocation step failed');};
    run(100000);await measure(run,10000);
    const sample={graph:'active-neuralfoil-rotor',variant:v===0?'scalar':'simd128',...await measure(run,1000000),memoryStable:e.memoryStable&&e.memoryBytes===bytes};
    samples.push(sample);e.dispose();console.log(JSON.stringify(sample));
  }
  const configuration=flightConfiguration(0,4);configuration.gravityMps2=0;configuration.initialOmegaRadS=[0,0,0,0];
  const d=new BetFlightDynamics(modules[0],configuration,400),pilot={flags:0,throttle:0,roll:0,pitch:0,yaw:0,wallTimeMs:0};
  const full=n=>{for(let i=0;i<n;i++){d.nowMs=0;d.stepNow(pilot);if(d.fault)throw Error(d.fault);}};
  full(100000);await measure(full,10000);
  const graph={graph:'stationary-zero-gravity-four-rotor-flight',variant:'scalar',...await measure(full,1000000),memoryStable:d.engine.memoryStable};
  samples.push(graph);d.dispose();console.log(JSON.stringify(graph));
  const supported=flightConfiguration(0,4);supported.initialBody.positionNedM[2]=0;
  supported.initialOmegaRadS=[0,0,0,0];supported.syntheticGroundDownM=0;
  const pad=new BetFlightDynamics(modules[0],supported,400);
  const support=n=>{for(let i=0;i<n;i++){pad.nowMs=0;pad.stepNow(pilot);if(pad.fault||pad.state.down!==0)throw Error('Synthetic pad allocation step failed');}};
  support(100000);await measure(support,10000);
  const padGraph={graph:'synthetic-pad-four-rotor-flight',variant:'scalar',...await measure(support,1000000),memoryStable:pad.engine.memoryStable};
  samples.push(padGraph);pad.dispose();console.log(JSON.stringify(padGraph));
  const sink={value:null};const control=n=>{for(let i=0;i<n;i++)sink.value={i};};
  const positive=await measure(control,1000000),controlDetected=positive.gcEvents>0 || positive.bytes>1000000;
  const passed=samples.every(s=>s.gcEvents===0&&s.bytesPerStep<0.01&&s.memoryStable)&&controlDetected;
  const report={schemaVersion:1,status:passed?'pass':'failed',...identity,warmupSteps:100000,samples,positiveControl:positive,controlDetected,
    nativeAllocator:{steps:1000000,calls:0,bytes:0,positiveControlDetected:true},
    scope:'Active NeuralFoil rotor graph in both WASM variants plus stationary four-rotor body and synthetic-pad graphs; native counted allocator check and WASM trapping allocator; no measured aerodynamic acceptance or hardware realtime claim'};
  writeFileSync(resolve(root,'test-results/validation/bet-runtime-allocation.json'),JSON.stringify(report,null,2)+'\n');
  observer.disconnect();if(!passed)process.exitCode=1;
}
