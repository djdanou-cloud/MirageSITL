// Actual production rotor/body/session acceptance; synthetic, not measured fidelity.
import {createRequire} from 'node:module';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {PerformanceObserver,performance} from 'node:perf_hooks';
import v8 from 'node:v8';
import {completeAllocationSamples} from './bet-runtime-graphs.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const allocation=process.argv.includes('--allocation');
// TASK-091: --kernel-options N runs the coarse-rate trajectories with the opt-in rotor kernel modes
// (1 reduced predictor, 2 hover sampling, 3 both) against the unchanged 4800 Hz full-kernel references,
// adds forward-flight trajectories against the full kernel at the same rate, and writes bet-runtime-modes.json.
const optionIndex=process.argv.indexOf('--kernel-options');
const kernelOptions=optionIndex>=0?Number(process.argv[optionIndex+1]):0;
if(![0,1,2,3].includes(kernelOptions))throw Error('Invalid --kernel-options');
if(allocation && !globalThis.gc){
  const result=spawnSync(process.execPath,['--expose-gc','--single-threaded','--max-semi-space-size=64',fileURLToPath(import.meta.url),'--allocation'],{stdio:'inherit'});
  process.exit(result.status??1);
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=path=>readFileSync(resolve(root,path));
mkdirSync(resolve(root,'.cache/bet-runtime'),{recursive:true});
const bundle=resolve(root,'.cache/bet-runtime/acceptance.mjs');
const bundled=await build({stdin:{contents:`export {BetRotorEngine} from './packages/wasm-bet/src/rotor.ts';
export {BetRotorEngineV2} from './packages/wasm-bet/src/rotor-v2.ts';
export {BetRigidBodyBackendV2,newBodyTruthV2} from './packages/wasm-bet/src/body-v2.ts';
export {BetFlightDynamics} from './packages/physics/src/bet-dynamics.ts';
export {MotorFaults} from './packages/physics/src/motor-fault.ts';
export {PhysicsSessionV2} from './packages/physics/src/session-v2.ts';
export {WEATHER_GUST_RMS,WEATHER_PRESSURE,WEATHER_SEED,WEATHER_SLOTS,WEATHER_TEMPERATURE,WEATHER_WIND_DOWN,WEATHER_WIND_EAST,WEATHER_WIND_NORTH} from './packages/physics/src/atmosphere.ts';
export {StateReaderV2,createSharedMemoryV2,createSpscQueue,newFlightStateV2,newHeaderSnapshotV2,tickToNumber} from '@mirage/protocol';
export {flightConfiguration,rotorDefinition} from './tests/bet-runtime-fixture.ts';`,resolveDir:root,sourcefile:'bet-runtime-entry.ts',loader:'ts'},
  bundle:true,platform:'node',format:'esm',packages:'external',outfile:bundle,metafile:true});
const {BetRotorEngine,BetRotorEngineV2,BetRigidBodyBackendV2,newBodyTruthV2,BetFlightDynamics,MotorFaults,PhysicsSessionV2,WEATHER_GUST_RMS,WEATHER_PRESSURE,
  WEATHER_SEED,WEATHER_SLOTS,WEATHER_TEMPERATURE,WEATHER_WIND_DOWN,WEATHER_WIND_EAST,WEATHER_WIND_NORTH,StateReaderV2,createSharedMemoryV2,createSpscQueue,
  newFlightStateV2,newHeaderSnapshotV2,tickToNumber,flightConfiguration,rotorDefinition}=await import(pathToFileURL(bundle).href);
const modules=['scalar','simd128'].map(v=>new WebAssembly.Module(read(`packages/wasm-bet/dist/mirage_bet.${v}.wasm`)));
const sourceFiles=Object.keys(bundled.metafile.inputs).filter(p=>p!=='bet-runtime-entry.ts').map(p=>p.replaceAll('\\','/'));
sourceFiles.push('scripts/check-bet-runtime.mjs','scripts/bet-runtime-graphs.ts','native/bet/src/bound.rs','native/bet/src/polar.rs','native/bet/src/lib.rs',
  'native/bet/src/blade.rs','native/bet/src/shaft.rs','native/bet/src/inflow.rs','native/bet/src/rigid_body.rs',
  'native/bet/src/body_abi.rs','native/Cargo.lock','native/rust-toolchain.toml',
  'packages/physics/package.json','packages/wasm-bet/package.json',
  'native/bet/Cargo.toml','native/bet/tests/allocation.rs','native/bet/tests/bound_v2.rs','native/bet/tests/support/bound_fixture.rs');
for (const entry of readdirSync(resolve(root,'native/bet/src')))
  if(entry.endsWith('.rs')) sourceFiles.push('native/bet/src/'+entry);
const identity={sourceInputs:[...new Set(sourceFiles)].map(file=>({file,sha256:sha(read(file))})),
  artifactSha256:{scalar:sha(read('packages/wasm-bet/dist/mirage_bet.scalar.wasm')),simd128:sha(read('packages/wasm-bet/dist/mirage_bet.simd128.wasm'))},
  node:process.version,platform:process.platform,architecture:process.arch};
mkdirSync(resolve(root,'test-results/validation'),{recursive:true});
if(!allocation){
  const cases=[];
  // `forward` adds a pitch doublet (0.2 for 1 s, then -0.2 for 1 s), which leaves the vehicle tilted and translating.
  function trajectory(module,index,count,hz,options=0,forward=false){
    const d=new BetFlightDynamics(module,flightConfiguration(index,count,options),hz);
    const pilot={flags:3,throttle:0.5,roll:0,pitch:0,yaw:0,wallTimeMs:0};
    let flags=0,sampling=0;
    for(let i=0;i<hz*10;i++){
      const t=(i+0.5)/hz;pilot.throttle=0.5+0.05*Math.sin(t*2*Math.PI/5);
      if(forward)pilot.pitch=t<1?0.2:t<2?-0.2:0;
      d.nowMs=t*1000;pilot.wallTimeMs=d.nowMs;d.stepNow(pilot);flags|=d.validityFlags;sampling|=d.samplingFlags;
      if(d.fault)throw Error(d.fault);
    }
    const s={...d.state},stable=d.engine.memoryStable;d.dispose();return {s,flags,sampling,stable};
  }
  const compare=(a,b)=>({positionErrorM:Math.hypot(a.north-b.north,a.east-b.east,a.down-b.down),
    attitudeErrorRad:2*Math.acos(Math.min(1,Math.abs(a.qw*b.qw+a.qx*b.qx+a.qy*b.qy+a.qz*b.qz)))});
  for(let index=0;index<3;index++){
    const count=4+index*2,reference=trajectory(modules[0],index,count,4800);
    for(let v=0;v<2;v++)for(const hz of [400,800,1200]){
      const result=trajectory(modules[v],index,count,hz,kernelOptions);
      const {positionErrorM,attitudeErrorRad}=compare(result.s,reference.s);
      cases.push({configuration:index,rotors:count,variant:v===0?'scalar':'simd128',hz,referenceHz:4800,durationS:10,kernelOptions,
        positionErrorM,attitudeErrorRad,validityFlags:result.flags,samplingFlags:result.sampling,memoryStable:result.stable,
        passed:positionErrorM<=0.1 && attitudeErrorRad<=Math.PI/360 && result.stable});
    }
    console.log(`BET runtime convergence: configuration=${index}; ${cases.slice(-6).filter(c=>c.passed).length}/6 passed`);
  }
  // TASK-091: the modes in forward flight against the full kernel at the same rate (scalar).
  if(kernelOptions!==0)for(let index=0;index<3;index++)for(const hz of [400,1200]){
    const count=4+index*2,full=trajectory(modules[0],index,count,hz,0,true),modes=trajectory(modules[0],index,count,hz,kernelOptions,true);
    const {positionErrorM,attitudeErrorRad}=compare(modes.s,full.s);
    const travelM=Math.hypot(full.s.north,full.s.east);
    cases.push({configuration:index,rotors:count,variant:'scalar',hz,referenceHz:hz,reference:'full kernel, forward flight',durationS:10,kernelOptions,
      positionErrorM,attitudeErrorRad,travelM,validityFlags:modes.flags,samplingFlags:modes.sampling,memoryStable:modes.stable,
      passed:positionErrorM<=0.1 && attitudeErrorRad<=Math.PI/360 && modes.stable});
    console.log(`Forward flight with modes ${kernelOptions}: configuration=${index} ${hz} Hz: ${positionErrorM.toExponential(3)} m, ${attitudeErrorRad.toExponential(3)} rad over ${travelM.toFixed(1)} m travelled`);
  }
  const report={schemaVersion:1,status:cases.every(c=>c.passed)?'pass':'failed',...identity,cases,
    tolerance:{positionM:0.1,attitudeRad:Math.PI/360},scope:'Actual rotor/polar/free-shaft/axial-inflow/frame/body graph; synthetic geometry and NeuralFoil predictions; flags remain active; no measured-fidelity or target-device timing claim'};
  writeFileSync(resolve(root,`test-results/validation/${kernelOptions===0?'bet-runtime':'bet-runtime-modes'}.json`),JSON.stringify(kernelOptions===0?report:{...report,kernelOptions},null,2)+'\n');
  if(report.status!=='pass')process.exitCode=1;
}else{
  const native=execFileSync('cargo',['test','--release','-p','mirage-bet','--test','allocation','--locked'],{cwd:resolve(root,'native'),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:300000});
  if(!native.includes('production_bound_step_allocates_zero_over_one_million_steps ... ok') || !native.includes('test result: ok. 2 passed;'))throw Error('Native bound allocator check did not execute');
  // TASK-092: the ESC drive mode and the shared bus under the same counting allocator.
  const drive=execFileSync('cargo',['test','--release','-p','mirage-bet','--test','bound_v2','--locked','allocate'],{cwd:resolve(root,'native'),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:300000});
  // TASK-091: the opt-in kernel modes run under the same counting allocator.
  for(const name of ['v2_step_allocates_zero_over_one_million_steps','esc_steps_allocate_zero_over_one_million_steps','bus_steps_allocate_zero_over_one_million_steps',
    'opt_in_kernel_modes_allocate_zero_over_one_million_steps'])
    if(!drive.includes(`${name} ... ok`))throw Error(`Native ${name} did not execute`);
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
  // TASK-088 step interfaces v2: the same active rotor through BetRotorEngineV2
  // (motor torque is v2 input index 12, as in v1), and a stationary body through
  // BetRigidBodyBackendV2 with zero wrench and zero gravity.
  for(let v=0;v<2;v++){
    const e=new BetRotorEngineV2(modules[v],[rotorDefinition(0)],800),bytes=e.memoryBytes;e.input[12]=0.01;
    const run=n=>{for(let i=0;i<n;i++)if(!e.stepInto())throw Error(`Bound rotor v2 allocation step failed: ${e.lastStatus}`);};
    run(100000);await measure(run,10000);
    const sample={graph:'active-neuralfoil-rotor-v2',variant:v===0?'scalar':'simd128',...await measure(run,1000000),memoryStable:e.memoryStable&&e.memoryBytes===bytes};
    samples.push(sample);e.dispose();console.log(JSON.stringify(sample));
  }
  for(let v=0;v<2;v++){
    const body=new BetRigidBodyBackendV2(new WebAssembly.Instance(modules[v],{}),1.5,[0.03,0,0,0,0.03,0,0,0,0.05],0);
    const truth=newBodyTruthV2(),wrench=new Float64Array(6);
    const run=n=>{for(let i=0;i<n;i++)if(!body.stepInto(wrench,1/800,truth))throw Error(`Body v2 allocation step failed: ${body.lastStatus}`);};
    run(100000);await measure(run,10000);
    const sample={graph:'stationary-zero-gravity-body-v2',variant:v===0?'scalar':'simd128',...await measure(run,1000000),memoryStable:body.memoryStable};
    samples.push(sample);console.log(JSON.stringify(sample));
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
  // TASK-092: four rotors on the ESC drive and the shared bus, with a motor-fault table attached and one partial power cut.
  const motor={resistanceOhm:0.1,torqueConstantNmPerA:60/(2*Math.PI*300),currentLimitA:30,brakeCurrentLimitA:10,
    noLoadTorqueNm:0.5*60/(2*Math.PI*300),commandTauS:0.02,updatePeriodS:1/490};
  // On the synthetic pad: 0.3 duty lifts well under the 2 kg weight, so the graph stays stationary for 1.1M steps.
  const driven=flightConfiguration(0,4);driven.initialBody.positionNedM[2]=0;driven.initialOmegaRadS=[0,0,0,0];driven.syntheticGroundDownM=0;
  driven.drive={motors:[motor,motor,motor,motor],initialStateOfCharge:1,housePowerW:3,
    battery:{openCircuitFullV:16.8,openCircuitEmptyV:13.2,internalResistanceOhm:0.02,capacityAh:1e6,currentLimitA:100}};
  const esc=new BetFlightDynamics(modules[0],driven,400),faults=new MotorFaults([0,1,2,3]),escPilot={flags:3,throttle:0.3,roll:0,pitch:0,yaw:0,wallTimeMs:0};
  esc.useMotorFaults(faults);faults.set(1,'power-cut',0.5);
  const escRun=n=>{for(let i=0;i<n;i++){esc.nowMs=0;esc.stepNow(escPilot);if(esc.fault||!(esc.electrical[2]>0)||esc.state.down!==0)throw Error('ESC drive allocation step failed');}};
  escRun(100000);await measure(escRun,10000);
  const escGraph={graph:'esc-drive-bus-synthetic-pad-four-rotor',variant:'scalar',...await measure(escRun,1000000),memoryStable:esc.escEngine.memoryStable};
  samples.push(escGraph);esc.dispose();console.log(JSON.stringify(escGraph));
  // TASK-093: weather on the synthetic pad, rotors at rest in a 3.6 m/s mean wind with a 1.5 m/s RMS gust: the gust and the ISA
  // air every step, and a weather re-applied from preallocated slots with seeds above 2^31, every 5 steps while warming (as every
  // graph here, warmed code: V8's first tiers box numbers) and every 1000 steps measured.
  const weatherOf=(north,east,seed)=>{const w=new Float64Array(WEATHER_SLOTS);w[WEATHER_WIND_NORTH]=north;w[WEATHER_WIND_EAST]=east;w[WEATHER_WIND_DOWN]=0.5;
    w[WEATHER_GUST_RMS]=1.5;w[WEATHER_SEED]=seed;w[WEATHER_TEMPERATURE]=293.15;w[WEATHER_PRESSURE]=98000;return w;};
  const weathers=[weatherOf(3,-2,0xfffffffe),weatherOf(-4,1,0x9e3779b9)];
  const padded=()=>{const c=flightConfiguration(0,4);c.initialBody.positionNedM[2]=0;c.initialOmegaRadS=[0,0,0,0];c.syntheticGroundDownM=0;return c;};
  const windy=new BetFlightDynamics(modules[0],padded(),400);
  if(windy.setWeather(weathers[0])!==null)throw Error('Weather refused');
  let applications=0,applyEvery=5;
  const weatherRun=n=>{for(let i=0;i<n;i++){
    if(i%applyEvery===applyEvery-1){if(windy.setWeather(weathers[applications&1])!==null)throw Error('Weather refused');applications++;}
    windy.nowMs=0;windy.stepNow(pilot);
    if(windy.fault||!windy.weatherActive||windy.state.down!==0)throw Error('Weather pad allocation step failed');}};
  weatherRun(100000);const warmApplications=applications;applyEvery=1000;await measure(weatherRun,10000);
  const before=applications,weatherSample=await measure(weatherRun,1000000);
  const weatherGraph={graph:'weather-synthetic-pad-four-rotor',variant:'scalar',...weatherSample,weatherApplications:applications-before,
    warmupApplications:warmApplications,memoryStable:windy.engine.memoryStable};
  samples.push(weatherGraph);windy.dispose();console.log(JSON.stringify(weatherGraph));
  // The same pad through the real session: weather.set commands sent before each 4000-tick window (the 10 s horizon) and
  // applied by the processor inside it, the published airspeed and pressure from the weather's air. 100 commands per window
  // warm the path (10000 applications); then three per measured window, 250 windows. Each window is followed by an empty one,
  // whose bytes (the measurement's own, about 2 KB) are subtracted. One full GC precedes the series and none separates its
  // windows, as in the Worker: in this process, after the graphs above, a forced full GC that collects an applied command's
  // shape makes V8 discard the optimized tick ("embedded weak objects cleared"), which then boxes numbers until recompiled
  // (TASK-093 measured 44 B per tick that way; a fresh process stays at 0 with or without the GC).
  const stateBuffer=createSharedMemoryV2(),fake={mono:0};let sessionDynamics=null;
  const session=new PhysicsSessionV2({type:'init-v2',protocolVersion:2,stateBuffer,sensorBuffer:createSpscQueue('sensor'),actuatorBuffer:createSpscQueue('actuator')},
    {monotonicMs:()=>fake.mono,wallMs:()=>1.79e12+fake.mono},hz=>(sessionDynamics=new BetFlightDynamics(modules[0],padded(),hz)));
  const reader=new StateReaderV2(stateBuffer),header=newHeaderSnapshotV2(),published=newFlightStateV2(),results=[];
  let requestId=0,sent=0;
  const send=message=>{reader.readHeader(header);session.handle({protocolVersion:2,requestId:++requestId,expectedEpoch:header.sessionEpoch,...message});
    session.drain(result=>results.push(result));};
  send({type:'sim.start'});
  const pumpTicks=n=>{for(let i=0;i<n;i++){fake.mono+=2.5;session.pump();}};
  async function measureWindow(fn,n){const before=young(),start=performance.now();fn(n);const end=performance.now(),bytes=young()-before;await settle();
    return {steps:n,bytes,gcEvents:events.filter(t=>t>=start&&t<=end).length,elapsedMs:end-start};}
  const schedule=count=>{
    if(!reader.latest(published))throw Error('No published state');
    const now=tickToNumber(published.tickId);
    for(let k=0;k<count;k++){
      send({type:'weather.set',atTick:{lo:now+300+Math.floor(3300*k/count),hi:0},windNedMps:k&1?[-4,1,0.5]:[3,-2,0.5],temperatureK:293.15,
        pressurePa:98000,turbulenceRmsMps:1.5,seed:k&1?0x9e3779b9:0xfffffffe});
      sent++;
    }
  };
  for(let w=0;w<100;w++){schedule(100);pumpTicks(4000);session.drain(result=>results.push(result));}
  const warmupApplications=sent,total={steps:0,bytes:0,emptyWindowBytes:0,gcEvents:0,elapsedMs:0},idle=()=>undefined;let windows=0;
  globalThis.gc();await settle();
  while(total.steps<1000000){
    schedule(3);const sample=await measureWindow(pumpTicks,4000),empty=await measureWindow(idle,4000);session.drain(result=>results.push(result));windows++;
    total.steps+=sample.steps;total.bytes+=sample.bytes-empty.bytes;total.emptyWindowBytes+=empty.bytes;
    total.gcEvents+=sample.gcEvents+empty.gcEvents;total.elapsedMs+=sample.elapsedMs;
  }
  const appliedWeather=results.filter(r=>r.type==='ack-v2'&&r.status==='applied'&&r.requestId>1).length;
  if(appliedWeather!==sent||!session.wind.active||results.some(r=>r.type==='reject-v2'))throw Error('A scheduled weather.set was not applied');
  const sessionGraph={graph:'weather-session-synthetic-pad',variant:'scalar',...total,bytesPerStep:total.bytes/total.steps,windows,
    weatherApplications:sent-warmupApplications,warmupApplications,memoryStable:sessionDynamics?.engine.memoryStable===true};
  samples.push(sessionGraph);session.dispose();console.log(JSON.stringify(sessionGraph));
  const sink={value:null};const control=n=>{for(let i=0;i<n;i++)sink.value={i};};
  const positive=await measure(control,1000000),controlDetected=positive.gcEvents>0 || positive.bytes>1000000;
  const passed=completeAllocationSamples(samples)&&samples.every(s=>s.gcEvents===0&&s.bytesPerStep<0.01&&s.memoryStable)&&controlDetected;
  const report={schemaVersion:1,status:passed?'pass':'failed',...identity,warmupSteps:100000,samples,positiveControl:positive,controlDetected,
    nativeAllocator:{steps:1000000,calls:0,bytes:0,positiveControlDetected:true,driveSteps:{boundV2:1000000,esc:1000000,bus:1000000}},
    scope:'Active NeuralFoil rotor graph through step interfaces v1 and v2 and a stationary body through interface v2, each in both WASM variants, plus stationary four-rotor body, synthetic-pad and ESC-drive bus (synthetic pad) graphs, and the TASK-093 weather graphs (gust and per-step air with a weather re-applied every 1000 steps, and the real session applying scheduled weather.set commands, on the synthetic pad); native counted allocator checks (bound v1, v2, ESC drive, bus) and WASM trapping allocator; no measured aerodynamic acceptance or hardware realtime claim'};
  writeFileSync(resolve(root,'test-results/validation/bet-runtime-allocation.json'),JSON.stringify(report,null,2)+'\n');
  observer.disconnect();if(!passed)process.exitCode=1;
}
