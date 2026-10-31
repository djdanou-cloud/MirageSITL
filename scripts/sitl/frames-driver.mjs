// Cold TASK-128 native frame capture. Invoked by driver.mjs in its owned group.
import {spawn,execFileSync} from 'node:child_process';
import {createSocket} from 'node:dgram';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,writeSync,readdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {cpus,release} from 'node:os';
import {readNativeExecutable} from './native-binary.ts';
import {MultirotorReference,frameById,frameParameters,frameScript} from './multirotor.mjs';
import {ExternalSitlLockstep,newSitlPhysicsState,MAX_STATE_LINE_BYTES} from '../../packages/autopilot/src/external-sitl.ts';
import {LiveEkfWarmup} from '../../packages/autopilot/src/live-warmup.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--binary'||args[2]!=='--parameters')throw Error('Expected --binary PATH --parameters PATH');
const binary=resolve(args[1]),parameters=resolve(args[3]);
const native=readNativeExecutable(binary);
const frame=frameById(process.env.MIRAGE_SITL_FRAME),phase=process.env.MIRAGE_SITL_FRAME_PHASE;
if(!['flight','motor-test'].includes(phase)||!['darwin','linux'].includes(process.platform))throw Error('Invalid native frame phase/host');
const source=process.env.MIRAGE_SITL_SOURCE,python=process.env.MIRAGE_SITL_PYTHON;
if(!source||!python||process.env.MIRAGE_SITL_IMU_NOISE_FLOOR!=='ardupilot'||process.env.MIRAGE_EW_CASE)throw Error('Frame probes require stock firmware error terms, Python and source');
const pin=JSON.parse(readFileSync(join(root,'scripts/sitl.lock.json')));
if(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==pin.commit||
  execFileSync('git',['-C',source,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Pinned source is not clean');
const directory=resolve(process.env.MIRAGE_SITL_CAPTURE_DIR);
if(existsSync(directory))throw Error('Frame capture directory must be new');
mkdirSync(directory,{recursive:true});
const inputFiles=['scripts/sitl/driver.mjs','scripts/sitl/frames-driver.mjs','scripts/sitl/multirotor.mjs',
  'scripts/sitl/native-binary.ts','scripts/sitl/telemetry.py','scripts/run-sitl.mjs','scripts/sitl.lock.json',
  'tests/fixtures/sitl/frames.json','tests/fixtures/sitl/parameters.parm','packages/autopilot/src/external-sitl.ts',
  'packages/autopilot/src/live-warmup.ts','packages/autopilot/src/ekf-status.ts','packages/autopilot/src/warmup.ts',
  'packages/wasm-bet/src/backend.ts','packages/mavlink/src/codec.ts','packages/mavlink/dialect.lock.json',
  'native/bet/src/rigid_body.rs','native/bet/src/body_abi.rs','native/bet/src/math.rs','native/bet/src/lib.rs',
  'native/Cargo.lock','native/rust-toolchain.toml'];
const sourceInputs=inputFiles.map(file=>({file,sha256:sha(readFileSync(join(root,file)))}));
const wasm=readFileSync(join(root,'packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
const manifest=JSON.parse(readFileSync(join(root,'packages/wasm-bet/dist/manifest.json')));
if(manifest.artifacts.find(entry=>entry.variant==='scalar')?.sha256!==sha(wasm))throw Error('Body WASM manifest mismatch');
const {instance}=await WebAssembly.instantiate(wasm,{});
const model=new MultirotorReference(instance,frame.id),channels=frame.motors.map(m=>m.output);
const link=new ExternalSitlLockstep({motorChannels:channels});
const throttle=new Float64Array(frame.motorCount),state=newSitlPhysicsState(),reply=new Uint8Array(MAX_STATE_LINE_BYTES);
const text=frameParameters(frame.id),extra=join(process.cwd(),'frame.parm');
writeFileSync(extra,text);writeFileSync(join(directory,'frame.parm'),text);
const frameExpectedParameters={AHRS_EKF_TYPE:3,EK3_ENABLE:1};
for(const line of text.trim().split('\n')){const [name,value]=line.split(' ');frameExpectedParameters[name]=Number(value);}
const script=frameScript(frame.id);
if(script){mkdirSync('scripts');writeFileSync('scripts/frame.lua',script);writeFileSync(join(directory,'frame.lua'),script);}
const physics=createSocket('udp4');physics.bind(0,'127.0.0.1');await once(physics,'listening');
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const tcpPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const firmwareLog=openSync(join(directory,'firmware.log'),'w');
const physicsLog=openSync(join(directory,'physics.ndjson'),'w'),servoLog=openSync(join(directory,'servo.raw'),'w');
const telemetryLog=openSync(join(directory,'telemetry.ndjson'),'w');
const firmware=spawn(binary,['--model','JSON:127.0.0.1','--speedup','2','--rate','800',
  '--home','-35.362938,149.165085,584,0','--sim-port-out',String(physics.address().port),
  '--serial0',`tcp:${tcpPort}`,'--serial1','none','--serial2','none',
  '--defaults',[join(source,'Tools/autotest/default_params/copter.parm'),parameters,extra].join(',')],{stdio:['ignore',firmwareLog,firmwareLog]});
const telemetry=spawn(python,[join(root,'scripts/sitl/telemetry.py'),String(tcpPort),join(directory,'mavlink.raw'),'--frames'],{stdio:['pipe','pipe','pipe']});
const gate=new LiveEkfWarmup('external-sitl',1,0,0,2,{imuSource:'json-lockstep'});
const parameterValues={},commands=[],samples=[],motorTests=[];
let heartbeat=null,ekf=null,globalPosition=null,scriptReady=script===null;
let timeS=0,lastReply=-1,lastSample=-1,stage='warmup',lastCommand=-Infinity,holdStart=-1;
let firstReady=null,finished=false,failure=null,lastParameterRequest=-Infinity;
let pendingTest=null,nextSequence=1,quietUntil=0;
let physicsBatch='',physicsCount=0;
const start=performance.now();
function fail(error){failure??=error instanceof Error?error:Error(String(error));finished=true;}
function command(value){commands.push({timeS,...value});telemetry.stdin.write(JSON.stringify(value)+'\n');lastCommand=timeS;}
const parametersConfirmed=()=>Object.entries(frameExpectedParameters).every(([name,value])=>parameterValues[name]===value);
for(const child of [firmware,telemetry]){child.on('error',fail);child.on('exit',(code,signal)=>{if(!finished)fail(Error(`Owned frame child exited ${code}/${signal}`));});}
telemetry.stderr.on('data',bytes=>process.stderr.write(bytes));
createInterface({input:telemetry.stdout}).on('line',line=>{
  try{
    const event=JSON.parse(line),m=event.message;
    if(typeof event.wireHex!=='string'||!/^(?:[a-f0-9]{2})+$/.test(event.wireHex))throw Error('Missing original wire bytes');
    writeSync(telemetryLog,JSON.stringify({receivedSimS:timeS,wallTimeMs:performance.now()-start,message:m,wireHex:event.wireHex})+'\n');
    if(['HEARTBEAT','EKF_STATUS_REPORT','GPS_RAW_INT','RAW_IMU','HIGHRES_IMU'].includes(m.mavpackettype))gate.ingest(Buffer.from(event.wireHex,'hex'),timeS);
    if(m.mavpackettype==='HEARTBEAT')heartbeat={...m,timeS};
    if(m.mavpackettype==='EKF_STATUS_REPORT')ekf={...m,timeS};
    if(m.mavpackettype==='GLOBAL_POSITION_INT')globalPosition={...m,timeS};
    if(m.mavpackettype==='PARAM_VALUE')parameterValues[m.param_id]=m.param_value;
    if(m.mavpackettype==='STATUSTEXT'&&m.text==='Mirage paired-16 ready: 16')scriptReady=true;
    if(m.mavpackettype==='COMMAND_ACK'&&m.command===209&&pendingTest){
      if(m.result!==0)throw Error(`Motor test rejected with MAV_RESULT ${m.result}`);
      pendingTest.ackTimeS=timeS;
    }
  }catch(error){fail(error);}
});
const deadline=setTimeout(()=>fail(Error('Frame capture wall deadline exceeded')),110000);
physics.on('error',fail);
physics.on('message',(bytes,peer)=>{
  if(finished)return;
  try{
    if(peer.address!=='127.0.0.1')throw Error('Non-loopback servo peer');
    if(bytes.length!==8+2*frame.servoPacketChannels)throw Error('Configured servo packet width not observed');
    if(link.receive(bytes)!=='step')throw Error('Invalid, duplicate or gapped servo packet');
    const rate=bytes.readUInt16LE(2);
    if(![799,800].includes(rate)&&!(link.lastFrameCount===0&&rate===1200))throw Error('Unexpected firmware physics rate');
    writeSync(servoLog,bytes);
    if(!link.consumeActuatorsInto(throttle))throw Error('No actuator frame');
    if(lastReply>=0&&!gate.acknowledgeJsonImu(link.lastFrameCount,lastReply,lastSample))throw Error('Invalid native IMU acknowledgement');
    if(phase==='flight')model.step(throttle,1/800); // motor-test is an explicitly constrained stationary bench.
    timeS=link.stats.steps/800;
    if(link.stats.steps>96000)throw Error("Frame simulation deadline exceeded");
    const truth=model.truth;
    state.timestampS=timeS;state.positionNedM.set(truth.positionNedM);state.velocityNedMps.set(truth.velocityNedMps);
    state.quaternionWxyz.set(truth.quaternionBodyToNed);state.gyroBodyRadS.set(truth.angularVelocityBodyRadS);state.accelBodyMps2.set(model.specificForce);
    const size=link.completeStepInto(state,reply);if(!size)throw Error('Invalid physics reply');
    physics.send(reply.subarray(0,size),peer.port,peer.address);
    lastReply=link.lastFrameCount;lastSample=timeS;
    if(timeS>=5&&!parametersConfirmed()&&timeS-lastParameterRequest>=3){
      const names=Object.keys(frameExpectedParameters).filter(name=>parameterValues[name]!==frameExpectedParameters[name]);
      command({kind:'read-parameters',names});lastParameterRequest=timeS;
    }
    if(timeS>30&&(!parametersConfirmed()||!scriptReady))throw Error('Frame parameters or stock Lua initialization were not confirmed');
    const ready=gate.observe(timeS,performance.now()-start);
    if(ready&&firstReady===null)firstReady={timeS,wallTimeMs:performance.now()-start};
    const armed=Boolean(heartbeat&&(heartbeat.base_mode&128)),mode=heartbeat?.custom_mode;
    const health=gate.monitor.snapshot(timeS*1000);
    const pwm=Array.from({length:frame.servoPacketChannels},(_,i)=>bytes.readUInt16LE(8+2*i));
    if(phase==='motor-test'&&timeS>=10&&parametersConfirmed()&&scriptReady){
      if(pendingTest){
        const expected=frame.motors.find(m=>m.testOrder===pendingTest.sequence);
        const active=frame.motors.filter(m=>pwm[m.output-1]>1000);
        if(active.length){
          if(active.length!==1||active[0].motor!==expected.motor||pwm[expected.output-1]!==1200)throw Error('One-motor command moved the wrong output');
          for(let i=0;i<pwm.length;i++){
            if(i===expected.output-1)continue;
            const motorOutput=frame.motors.some(m=>m.output===i+1);
            if(motorOutput?pwm[i]>1000:pwm[i]!==pendingTest.baseline[i])throw Error('Another output moved during the one-motor test');
          }
          pendingTest.observedFrames++;pendingTest.firstFrame??=link.lastFrameCount;pendingTest.lastFrame=link.lastFrameCount;
        }
        if(timeS-pendingTest.startS>=0.8&&active.length===0){
          if(pendingTest.ackTimeS===null||pendingTest.observedFrames<8)throw Error('Motor test lacks ACK or observed PWM evidence');
          motorTests.push({...pendingTest,motor:expected.motor,output:expected.output});pendingTest=null;nextSequence++;quietUntil=timeS+0.1;
        }
        if(pendingTest&&timeS-pendingTest.startS>3)throw Error('Motor test did not return to idle');
      }else if(timeS>=quietUntil){
        if(nextSequence>frame.motorCount)finished=true;
        else if(frame.motors.every(m=>pwm[m.output-1]<=1000)){
          pendingTest={sequence:nextSequence,startS:timeS,baseline:pwm,observedFrames:0,ackTimeS:null};
          command({kind:'motor-test',sequence:nextSequence,pwmUs:1200,durationS:0.3});
        }
      }
    }
    if(phase==='flight'){
      if(parametersConfirmed()&&scriptReady&&timeS-lastCommand>1){
        if(stage==='warmup'&&ready){if(mode!==4)command({kind:'mode',mode:4});else command({kind:'arm'});}
        else if(stage==='arm'&&armed)command({kind:'takeoff'});
      }
      if(stage==='warmup'&&ready&&armed&&mode===4)stage='arm';
      const altitude=-truth.positionNedM[2];
      if(stage==='arm'&&altitude>=3)stage='takeoff';
      if(stage==='takeoff'&&Math.abs(altitude-10)<=1&&Math.abs(truth.velocityNedMps[2])<0.5){stage='hold';holdStart=timeS;}
      if(stage==='hold'&&timeS-holdStart>=10.2&&timeS-lastCommand>1)command({kind:'land'});
      if(stage==='hold'&&mode===9)stage='land';
      if(stage!=='warmup'){
        if(!health.healthy||!globalPosition||timeS-globalPosition.timeS>1)throw Error('Flight diagnostics lost freshness/health');
        if(link.lastFrameCount%8===0)samples.push({timeS,servoFrame:link.lastFrameCount,stage,armed,mode,altitudeM:altitude,
          heartbeatAgeS:timeS-heartbeat.timeS,ekfAgeS:timeS-ekf.timeS,altitudeAgeS:timeS-globalPosition.timeS,
          ekfFlags:ekf.flags,innovationRatios:['velocity_variance','pos_horiz_variance','pos_vert_variance','compass_variance','terrain_alt_variance'].map(k=>ekf[k]),
          autopilotAltitudeM:globalPosition.relative_alt/1000,pwmUs:channels.map(channel=>pwm[channel-1])});
      }
      if(stage==='land'&&!armed&&altitude<=0.5&&link.lastFrameCount%8===0)finished=true;
      if(Math.abs(altitude)>100||truth.positionNedM.some(value=>!Number.isFinite(value)))throw Error('Frame left the flight envelope');
    }
    physicsBatch+=JSON.stringify({timeS,servoFrame:link.lastFrameCount,positionNedM:Array.from(truth.positionNedM),
      velocityNedMps:Array.from(truth.velocityNedMps),quaternionWxyz:Array.from(truth.quaternionBodyToNed)})+'\n';
    if(++physicsCount>=128){writeSync(physicsLog,physicsBatch);physicsBatch='';physicsCount=0;}
  }catch(error){fail(error);}
});
while(!finished)await new Promise(resolve=>setTimeout(resolve,20));
clearTimeout(deadline);physics.close();
for(const child of [telemetry,firmware])if(child.exitCode===null)child.kill('SIGTERM');
await Promise.all([telemetry,firmware].map(child=>child.exitCode!==null?null:new Promise(resolve=>{
  const timer=setTimeout(()=>child.kill('SIGKILL'),500);child.once('close',()=>{clearTimeout(timer);resolve();});
})));
if(physicsBatch)writeSync(physicsLog,physicsBatch);
for(const fd of [physicsLog,servoLog,telemetryLog,firmwareLog])closeSync(fd);
gate.dispose();
for(const input of sourceInputs)if(sha(readFileSync(join(root,input.file)))!==input.sha256)failure??=Error(`Source changed during frame capture: ${input.file}`);
if(sha(readFileSync(binary))!==sha(native.bytes))failure??=Error('Native binary changed during frame capture');
if(existsSync('logs')){mkdirSync(join(directory,'dataflash'));for(const name of readdirSync('logs'))if(/\.(BIN|LOG)$/.test(name))copyFileSync(join('logs',name),join(directory,'dataflash',name));}
const report={schemaVersion:1,task:'TASK-128',status:failure?'FAIL':'captured',failure:failure?.message??null,
  recordedAt:new Date().toISOString(),frameId:frame.id,phase,benchConstrained:phase==='motor-test',physicsHz:800,captureStride:8,
  configuration:model.configuration,frameExpectedParameters,parameterValues,scriptReady,
  sourceCommit:pin.commit,sourceInputs,firmwareSha256:sha(native.bytes),wasmSha256:sha(wasm),
  modelSha256:sha(Buffer.concat([readFileSync(join(root,'scripts/sitl/multirotor.mjs')),wasm,Buffer.from(JSON.stringify(model.configuration))])),
  host:{platform:process.platform,architecture:process.arch,osRelease:release(),cpu:cpus()[0]?.model},nativeBinary:native.identity,
  node:process.version,python,timeS,wallS:(performance.now()-start)/1000,stats:link.stats,firstReady,
  commands,samples,motorTests,childExit:[firmware,telemetry].map(child=>({pid:child.pid,code:child.exitCode,signal:child.signalCode})),
  imuNoiseFloor:{setting:'ardupilot',expected:[]}};
writeFileSync(join(directory,'run.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify({task:'TASK-128',status:report.status,frameId:frame.id,phase,timeS,steps:link.stats.steps,failure:report.failure}));
if(failure)throw failure;
