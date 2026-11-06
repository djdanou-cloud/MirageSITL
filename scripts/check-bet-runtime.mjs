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
// TASK-097: --extended-polar runs the 18 comparisons on the full-range NACA 6409 table, with its rotational
// augmentation, and writes test-results/validation/bet-runtime-extended.json.
const extendedPolarRun=process.argv.includes('--extended-polar');
// TASK-098: --dynamic-inflow runs the 18 comparisons with Pitt-Peters inflow and annular losses, and writes test-results/validation/bet-runtime-inflow.json.
const dynamicInflowRun=process.argv.includes('--dynamic-inflow');
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
export {CollisionChunks} from './packages/terrain/src/collision-chunks.ts';
export {createSessionFaultPort} from './packages/ew/src/session-port.ts';
export {WEATHER_DISCRETE_DOWN,WEATHER_DISCRETE_DURATION,WEATHER_DISCRETE_EAST,WEATHER_DISCRETE_NORTH,WEATHER_GUST_RMS,WEATHER_PRESSURE,WEATHER_SEED,WEATHER_SLOTS,WEATHER_TEMPERATURE,WEATHER_WIND_DOWN,WEATHER_WIND_EAST,WEATHER_WIND_NORTH} from './packages/physics/src/atmosphere.ts';
export {StateReaderV2,createSharedMemoryV2,createSpscQueue,newFlightStateV2,newHeaderSnapshotV2,tickToNumber} from '@mirage/protocol';
export {flightConfiguration,rotorDefinition} from './tests/bet-runtime-fixture.ts';
export {parseNeuralFoilPolar} from './packages/wasm-bet/src/rotor.ts';`,resolveDir:root,sourcefile:'bet-runtime-entry.ts',loader:'ts'},
  bundle:true,platform:'node',format:'esm',packages:'external',outfile:bundle,metafile:true});
const {BetRotorEngine,BetRotorEngineV2,BetRigidBodyBackendV2,newBodyTruthV2,BetFlightDynamics,MotorFaults,PhysicsSessionV2,CollisionChunks,createSessionFaultPort,WEATHER_DISCRETE_DOWN,WEATHER_DISCRETE_DURATION,
  WEATHER_DISCRETE_EAST,WEATHER_DISCRETE_NORTH,WEATHER_GUST_RMS,WEATHER_PRESSURE,
  WEATHER_SEED,WEATHER_SLOTS,WEATHER_TEMPERATURE,WEATHER_WIND_DOWN,WEATHER_WIND_EAST,WEATHER_WIND_NORTH,StateReaderV2,createSharedMemoryV2,createSpscQueue,
  newFlightStateV2,newHeaderSnapshotV2,tickToNumber,flightConfiguration,rotorDefinition,parseNeuralFoilPolar}=await import(pathToFileURL(bundle).href);
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
    const configuration=flightConfiguration(index,count,options);
    if(dynamicInflowRun){configuration.dynamicInflow=true;configuration.inflowTauS=configuration.inflowTauS.map(()=>0);}
    if(extendedPolarRun)configuration.polars=new Map([[0,parseNeuralFoilPolar(JSON.parse(read('tests/fixtures/polars/naca6409-extended.json').toString('utf8')))]]);
    const d=new BetFlightDynamics(module,configuration,hz);
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
  writeFileSync(resolve(root,`test-results/validation/${dynamicInflowRun?'bet-runtime-inflow':extendedPolarRun?'bet-runtime-extended':kernelOptions===0?'bet-runtime':'bet-runtime-modes'}.json`),JSON.stringify(kernelOptions===0?{...report,...(extendedPolarRun?{polar:'naca6409-extended.json'}:{})}:{...report,kernelOptions},null,2)+'\n');
  if(report.status!=='pass')process.exitCode=1;
}else{
  const native=execFileSync('cargo',['test','--release','-p','mirage-bet','--test','allocation','--locked'],{cwd:resolve(root,'native'),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:300000});
  if(!native.includes('production_bound_step_allocates_zero_over_one_million_steps ... ok') || !native.includes('bus_solve_allocates_zero_over_one_million_steps ... ok') || !native.includes('test result: ok. 3 passed;'))throw Error('Native bound allocator check did not execute');
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
  // graph here, warmed code: V8's first tiers box numbers) and every 1000 steps measured. TASK-167: each application starts a 2 s
  // discrete gust, so the measured steps hold running pulses (800 steps of each 1000) and ended ones.
  const weatherOf=(north,east,seed)=>{const w=new Float64Array(WEATHER_SLOTS);w[WEATHER_WIND_NORTH]=north;w[WEATHER_WIND_EAST]=east;w[WEATHER_WIND_DOWN]=0.5;
    w[WEATHER_GUST_RMS]=1.5;w[WEATHER_SEED]=seed;w[WEATHER_TEMPERATURE]=293.15;w[WEATHER_PRESSURE]=98000;
    w[WEATHER_DISCRETE_NORTH]=-4;w[WEATHER_DISCRETE_EAST]=1.5;w[WEATHER_DISCRETE_DOWN]=-0.8;w[WEATHER_DISCRETE_DURATION]=2;return w;};
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
  const EFFECT_CONTROLS=[{effect:'wind.mean',parameters:{windNedMps:[3,-2,0.5]}},{effect:'wind.gust',parameters:{rmsMps:1.5,bandwidthHz:2,seed:0x9e3779b9}},{effect:'wind.turbulence',parameters:{w20Mps:6,seed:0x9e3779b9}},
    // TASK-167: a discrete gust's pulse, started again by each command.
    {effect:'wind.discrete-gust',parameters:{amplitudeMps:5,durationS:3,fromDeg:45,upwardDeg:-10}},
    {effect:'atmosphere',parameters:{temperatureK:293.15,pressurePa:98000}},{effect:'sensor.imu.frozen',parameters:{}},
    // TASK-169: what goes on the state line, whose offsets and rotation the session copies out after each step.
    {effect:'ew.position-step',parameters:{offsetNedM:[30,-12.5,0]}},{effect:'ew.velocity-drift',parameters:{accelerationNedMps2:[0.2,-0.1,0],maxSpeedMps:2}},
    {effect:'ew.magnetic',parameters:{rotationRad:[0.1,-0.2,0.5],biasBodyGauss:[0.1,0,0]}},{effect:'ew.gnss-jamming',parameters:{severity:0.5}}];
  const stateBuffer=createSharedMemoryV2(),fake={mono:0};let sessionDynamics=null;
  const session=new PhysicsSessionV2({type:'init-v2',protocolVersion:2,stateBuffer,sensorBuffer:createSpscQueue('sensor'),actuatorBuffer:createSpscQueue('actuator')},
    // TASK-145: rotor 0 is calibrated, so every step checks its envelope and the session its validity changes.
    {monotonicMs:()=>fake.mono,wallMs:()=>1.79e12+fake.mono},hz=>(sessionDynamics=new BetFlightDynamics(modules[0],{...padded(),
      calibrationEnvelopes:[{rotorIndex:0,rpmLow:100,rpmHigh:1e5,densityLowKgM3:0.5,densityHighKgM3:2,advanceRatioMax:0.02}]},hz)),createSessionFaultPort());
  session.attachDelivery(true);
  // TASK-186: a real-terrain run checks the published ground under the vehicle every tick; four chunks around the pad hold it.
  const ground=new CollisionChunks(1,129,4);
  for(const [northIndex,eastIndex] of [[-1,-1],[-1,0],[0,-1],[0,0]])ground.stage({version:1,epoch:1,revision:0,resolution:129,spacingM:4,northIndex,eastIndex,downM:new Float64Array(129*129)});
  ground.publishAtTick(1,0);session.attachGround(ground);
  // TASK-169: a tick-boundary EW command is rare, and a drift reaches its top speed, slows and holds only after seconds, so V8 would still be interpreting these
  // paths when the windows below reach them, and its first tiers box numbers. tests/ew-pipeline.test.ts holds them to zero when warmed; this warms every path the
  // same way, on an engine of its own: each effect on, a drift to its top speed, off with its offset held, on again, and off by a step to the truth.
  const warmPort=createSessionFaultPort(),warmContext={dtS:1/400,simTimeS:0,northM:0,eastM:0,downM:0};
  warmPort.reset(1);
  const warmSend=(tick,effect,enabled,recovery)=>warmPort.apply({protocolVersion:2,requestId:tick+1,expectedEpoch:1,type:'fault.set',atTick:{lo:tick,hi:0},faultId:effect.kind,enabled,effect,recovery},{lo:tick,hi:0});
  const warmEffects=[{kind:'position-step',offsetNedM:[30,-12.5,0]},{kind:'velocity-drift',accelerationNedMps2:[0.2,-0.1,0.05],maxSpeedMps:0.05},{kind:'magnetic',rotationRad:[0.1,-0.2,0.5],biasBodyGauss:[0.1,0,0]},{kind:'gnss-jamming',severity:0.5}];
  for(let tick=0;tick<400000;tick++){
    const phase=tick%400;
    if(phase===0||phase===300)for(const effect of warmEffects)warmSend(tick,effect,true,'hold-offset');
    if(phase===200)for(const effect of warmEffects)warmSend(tick,effect,false,'hold-offset');
    if(phase===350)for(const effect of warmEffects)warmSend(tick,effect,false,'step-to-truth');
    warmPort.advanceInto(warmContext);warmPort.deliveryInto(session.delivery);warmContext.simTimeS+=warmContext.dtS;
  }
  warmPort.reset(1);session.delivery.gnssActive=false;session.delivery.magActive=false;
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
      const atTick={lo:now+300+Math.floor(3300*k/count),hi:0};
      // TASK-166: every third command is one effect control, in turn, each sometimes off, through the same tick boundary.
      const effect=sent%3===0?EFFECT_CONTROLS[(sent/3)%EFFECT_CONTROLS.length]:null;
      if(effect)send({protocolVersion:3,type:'effect.set',atTick,recovery:'hold-offset',control:{schemaVersion:1,id:effect.effect.replaceAll('.','-'),...effect,enabled:(sent&8)===0,intensity:sent&16?0.5:1}});
      else send({type:'weather.set',atTick,windNedMps:k&1?[-4,1,0.5]:[3,-2,0.5],temperatureK:293.15,
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
  if(session.terrainMissing[0]!==0||!session.running)throw Error('The session left its terrain');
  session.drainValidityChanges(()=>undefined);
  const sessionGraph={graph:'weather-session-synthetic-pad',variant:'scalar',...total,bytesPerStep:total.bytes/total.steps,windows,
    weatherApplications:sent-warmupApplications,warmupApplications,memoryStable:sessionDynamics?.engine.memoryStable===true};
  samples.push(sessionGraph);session.dispose();console.log(JSON.stringify(sessionGraph));
  // TASK-096: airframe drag on the same pad in the same gusty wind; the 3.8 m/s data range puts the step above it about half the time.
  const dragged=padded();
  dragged.airframeDrag={dragAreaBodyM2:[0.02,0.003,-0.001,0.003,0.025,0.002,-0.001,0.002,0.04],centerOfPressureCgM:[0.01,-0.02,-0.03],maxAirspeedMps:3.8};
  const draggy=new BetFlightDynamics(modules[0],dragged,400);
  if(draggy.setWeather(weathers[0])!==null)throw Error('Weather refused');
  let flaggedSteps=0;
  const dragRun=n=>{for(let i=0;i<n;i++){
    draggy.nowMs=0;draggy.stepNow(pilot);
    if(draggy.fault||draggy.state.down!==0)throw Error('Airframe drag allocation step failed');
    if(draggy.validityFlags&(1<<17))flaggedSteps++;}};
  dragRun(100000);await measure(dragRun,10000);
  flaggedSteps=0;
  const dragGraph={graph:'airframe-drag-weather-pad-four-rotor',variant:'scalar',...await measure(dragRun,1000000),flaggedSteps,
    memoryStable:draggy.engine.memoryStable};
  if(!(flaggedSteps>0&&flaggedSteps<1000000))throw Error('The drag validity flag did not switch');
  samples.push(dragGraph);draggy.dispose();console.log(JSON.stringify(dragGraph));
  // TASK-097: a full-range table, with the Reynolds and Mach brackets moving and rotational augmentation on every strip.
  for(const [variantIndex,variant] of ['scalar','simd128'].entries()){
    const extended=padded();
    extended.polars=new Map([[0,parseNeuralFoilPolar(JSON.parse(read('tests/fixtures/polars/naca6409-extended.json').toString('utf8')))]]);
    const full=new BetFlightDynamics(modules[variantIndex],extended,400);
    if(full.setWeather(weathers[0])!==null)throw Error('Weather refused');
    const fullRun=n=>{for(let i=0;i<n;i++){full.nowMs=0;full.stepNow(pilot);if(full.fault||full.state.down!==0)throw Error('Extended polar allocation step failed');}};
    fullRun(100000);await measure(fullRun,10000);
    const fullGraph={graph:'extended-polar-synthetic-pad-four-rotor',variant,...await measure(fullRun,1000000),memoryStable:full.engine.memoryStable};
    samples.push(fullGraph);full.dispose();console.log(JSON.stringify(fullGraph));
  }
  // TASK-100: the rotor ground effect on the ESC drive's interface.
  {
    const near=new BetFlightDynamics(modules[0],driven,400);
    near.setGroundEffect(1);
    const nearRun=n=>{for(let i=0;i<n;i++){near.nowMs=0;near.stepNow(escPilot);if(near.fault||near.state.down!==0)throw Error('Ground effect allocation step failed');}};
    nearRun(100000);await measure(nearRun,10000);
    const nearGraph={graph:'ground-effect-esc-drive-pad-four-rotor',variant:'scalar',...await measure(nearRun,1000000),memoryStable:near.escEngine.memoryStable};
    samples.push(nearGraph);near.dispose();console.log(JSON.stringify(nearGraph));
  }
  // TASK-101: the rotor wakes: rotor 1 under rotor 0 on one arm, so a wake reaches it at every step; every ordered pair checked.
  {
    const stacked=flightConfiguration(0,4);stacked.initialBody.positionNedM[2]=0;stacked.initialOmegaRadS=[0,0,0,0];stacked.syntheticGroundDownM=0;
    const hub=stacked.manifest.rotors[0].hubPositionBodyM;stacked.manifest.rotors[1].hubPositionBodyM=[hub[0],hub[1],hub[2]+0.05];
    stacked.drive=driven.drive;stacked.rotorWake={pairs:'all',washedDragAreaM2:[0.001,0,0.001,0.001]};
    const washed=new BetFlightDynamics(modules[0],stacked,400);
    const washedRun=n=>{for(let i=0;i<n;i++){washed.nowMs=0;washed.stepNow(escPilot);if(washed.fault||washed.state.down!==0)throw Error('Rotor wake allocation step failed');}};
    washedRun(100000);await measure(washedRun,10000);
    const washedGraph={graph:'rotor-wake-esc-drive-pad-four-rotor',variant:'scalar',...await measure(washedRun,1000000),memoryStable:washed.escEngine.memoryStable};
    if(!(washed.rotorWakes.wakeHubMps[5]<-0.1)||!(washed.rotorWakes.downloadN[0]>0))throw Error('The rotor wake allocation graph has no wake');
    samples.push(washedGraph);washed.dispose();console.log(JSON.stringify(washedGraph));
  }
  // TASK-098 and TASK-099: dynamic inflow with its annular solve and the vortex ring option, in a gusty wind on the pad.
  for(const [variantIndex,variant] of ['scalar','simd128'].entries()){
    const dynamic=padded();dynamic.dynamicInflow=true;dynamic.vortexRingSeed=7;dynamic.inflowTauS=dynamic.inflowTauS.map(()=>0);
    const flow=new BetFlightDynamics(modules[variantIndex],dynamic,400);
    if(flow.setWeather(weathers[0])!==null)throw Error('Weather refused');
    const flowRun=n=>{for(let i=0;i<n;i++){flow.nowMs=0;flow.stepNow(pilot);if(flow.fault||flow.state.down!==0)throw Error('Dynamic inflow allocation step failed');}};
    flowRun(100000);await measure(flowRun,10000);
    const flowGraph={graph:'dynamic-inflow-synthetic-pad-four-rotor',variant,...await measure(flowRun,1000000),memoryStable:flow.engine.memoryStable};
    samples.push(flowGraph);flow.dispose();console.log(JSON.stringify(flowGraph));
  }
  // TASK-145: four calibrated rotors turning on the ESC drive on the same pad, each step checked against its bench envelope. The weather
  // re-applied every 1000 steps alternates between 98 kPa and 90 kPa, so the air's density leaves the 1.12 to 1.25 kg/m³ band of the
  // bench data every other window and the flag switches; the RPM and advance-ratio bounds stay wide, so every comparison is evaluated.
  const calibratedConfig=padded();calibratedConfig.drive=driven.drive;
  calibratedConfig.calibrationEnvelopes=[0,1,2,3].map(rotorIndex=>({rotorIndex,rpmLow:1,rpmHigh:1e6,densityLowKgM3:1.12,densityHighKgM3:1.25,advanceRatioMax:1e3}));
  const thin=weatherOf(-4,1,0x9e3779b9);thin[WEATHER_PRESSURE]=90000;
  const calibratedWeathers=[weathers[0],thin],calibrated=new BetFlightDynamics(modules[0],calibratedConfig,400);
  if(calibrated.setWeather(calibratedWeathers[0])!==null)throw Error('Weather refused');
  let calibratedApplications=0,calibratedSteps=0,calibratedEvery=5;flaggedSteps=0;
  const calibratedRun=n=>{for(let i=0;i<n;i++){
    if(++calibratedSteps%calibratedEvery===0){if(calibrated.setWeather(calibratedWeathers[(++calibratedApplications)&1])!==null)throw Error('Weather refused');}
    calibrated.nowMs=0;calibrated.stepNow(escPilot);
    if(calibrated.fault||calibrated.state.down!==0||!(calibrated.electrical[2]>0))throw Error('Calibrated rotor allocation step failed');
    if(calibrated.validityFlags&(1<<18))flaggedSteps++;}};
  // Warmed as the weather graph is, with an application every 5 steps; then one every 1000.
  calibratedRun(100000);calibratedEvery=1000;calibratedSteps=0;await measure(calibratedRun,10000);
  flaggedSteps=0;
  const calibratedGraph={graph:'calibrated-esc-weather-pad-four-rotor',variant:'scalar',...await measure(calibratedRun,1000000),flaggedSteps,
    memoryStable:calibrated.escEngine.memoryStable};
  if(!(flaggedSteps>0&&flaggedSteps<1000000))throw Error('The calibration validity flag did not switch');
  samples.push(calibratedGraph);calibrated.dispose();console.log(JSON.stringify(calibratedGraph));
  const sink={value:null};const control=n=>{for(let i=0;i<n;i++)sink.value={i};};
  const positive=await measure(control,1000000),controlDetected=positive.gcEvents>0 || positive.bytes>1000000;
  const passed=completeAllocationSamples(samples)&&samples.every(s=>s.gcEvents===0&&s.bytesPerStep<0.01&&s.memoryStable)&&controlDetected;
  const report={schemaVersion:1,status:passed?'pass':'failed',...identity,warmupSteps:100000,samples,positiveControl:positive,controlDetected,
    nativeAllocator:{steps:1000000,calls:0,bytes:0,positiveControlDetected:true,driveSteps:{boundV2:1000000,esc:1000000,bus:1000000}},
    scope:'Active NeuralFoil rotor graph through step interfaces v1 and v2 and a stationary body through interface v2, each in both WASM variants, plus stationary four-rotor body, synthetic-pad and ESC-drive bus (synthetic pad) graphs, and the TASK-093 weather graphs (gust and per-step air with a weather re-applied every 1000 steps, and the real session applying scheduled weather.set commands, on the synthetic pad, and TASK-096 airframe drag in that wind, and TASK-145 calibrated rotors on the ESC drive checked against their bench envelope every step); native counted allocator checks (bound v1, v2, ESC drive, bus) and WASM trapping allocator; no measured aerodynamic acceptance or hardware realtime claim'};
  writeFileSync(resolve(root,'test-results/validation/bet-runtime-allocation.json'),JSON.stringify(report,null,2)+'\n');
  observer.disconnect();if(!passed)process.exitCode=1;
}
