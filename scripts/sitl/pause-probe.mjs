// Cold TASK-129 native clock experiment. The parent owns this process group.
import {spawn,execFileSync} from 'node:child_process';
import {createSocket} from 'node:dgram';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,writeSync,readdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {cpus,release} from 'node:os';
import {readNativeExecutable} from './native-binary.ts';
import {MultirotorReference,frameById,frameParameters,frameScript} from './multirotor.mjs';
import {ExternalSitlLockstep,newSitlPhysicsState,MAX_STATE_LINE_BYTES} from '../../packages/autopilot/src/external-sitl.ts';
import {LiveEkfWarmup} from '../../packages/autopilot/src/live-warmup.ts';
export const PAUSE_CONTRACT=Object.freeze({minimumPauseMs:60000,maximumPauseMs:65000,replayTolerance:1e-10,physicsHz:800});
// The probe always writes this fixed offset and restores the frame baseline.
// Using the last observed value stacks a second pause on an unrestored write.
export function pauseProbeValue(baseline){
  if(!Number.isFinite(baseline))throw Error('Missing probe parameter baseline');
  return baseline+1;
}
// 'held' stores the deferred acknowledgement. 'restore' waits for that value, then writes the baseline once.
export function parameterProbe(phase,observed,baseline,sawProbe){
  if(phase==='held')return {phase,write:null,sawProbe};
  if(phase==='restore'){
    const seen=sawProbe||observed===baseline+1;
    if(seen&&observed===baseline)return {phase:'confirm',write:null,sawProbe:false};
    if(!seen)return {phase:'restore',write:null,sawProbe:false};
    return {phase:'restore',write:baseline,sawProbe:true};
  }
  return {phase:'confirm',write:null,sawProbe:false};
}
// Cold control boundary: retain the next packet without consuming or replying to it.
export class PauseBoundary {
  active=null;
  resumeEcho=null;
  hold(kind,packet,peer,truth,timeS,wallMs){
    if(this.active)throw Error('Pause boundary is already held');
    this.active={kind,packet:Buffer.from(packet),peer:{...peer},truth:JSON.stringify(truth),timeS,wallMs,repeatedFrames:0};
  }
  // 'echo' is a datagram already accepted at release, still queued from the frozen resend.
  // It is not a second step and must not be answered again: SIM_JSON increments frame_counter for every valid reply.
  accept(packet){
    if(this.active){
      if(!this.active.packet.equals(packet))return 'changed';
      this.active.repeatedFrames++;
      return 'held';
    }
    if(this.resumeEcho){
      if(this.resumeEcho.equals(packet))return 'echo';
      this.resumeEcho=null;
    }
    return 'live';
  }
  release(timeS,truth,wallMs){
    const a=this.active;
    if(!a||timeS!==a.timeS||JSON.stringify(truth)!==a.truth)throw Error('Paused time or truth changed');
    const durationMs=wallMs-a.wallMs;
    if(durationMs<PAUSE_CONTRACT.minimumPauseMs||durationMs>PAUSE_CONTRACT.maximumPauseMs)throw Error('Invalid pause duration');
    this.active=null;return {...a,durationMs};
  }
  noteEcho(packet){this.resumeEcho=Buffer.from(packet);}
}
export async function capturePause(){
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(3);
if(args.length!==4||args[0]!=='--binary'||args[2]!=='--parameters')throw Error('Expected --binary PATH --parameters PATH');
const binary=resolve(args[1]),parameters=resolve(args[3]);
const native=readNativeExecutable(binary);
const frame=frameById(process.env.MIRAGE_SITL_FRAME),phase=process.env.MIRAGE_SITL_FRAME_PHASE;
if(phase!=='flight'||!['darwin','linux'].includes(process.platform))throw Error('Invalid native frame phase/host');
const source=process.env.MIRAGE_SITL_SOURCE,python=process.env.MIRAGE_SITL_PYTHON;
if(!source||!python||process.env.MIRAGE_SITL_IMU_NOISE_FLOOR!=='ardupilot'||process.env.MIRAGE_EW_CASE)throw Error('Frame probes require stock firmware error terms, Python and source');
const pin=JSON.parse(readFileSync(join(root,'scripts/sitl.lock.json')));
if(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==pin.commit||
  execFileSync('git',['-C',source,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Pinned source is not clean');
const speedup=Number(process.env.MIRAGE_SITL_PAUSE_SPEEDUP);
if(![2,20].includes(speedup))throw Error('Unsupported probe speedup');
const withPauses=process.env.MIRAGE_SITL_PAUSE_MODE==='holds';
const directory=resolve(process.env.MIRAGE_SITL_CAPTURE_DIR);
if(existsSync(directory))throw Error('Frame capture directory must be new');
mkdirSync(directory,{recursive:true});
const inputFiles=['scripts/sitl/pause-probe.mjs','scripts/run-sitl-pause.mjs','scripts/sitl/pause-telemetry.py','scripts/sitl/multirotor.mjs',
  'scripts/sitl/native-binary.ts','apps/bridge/src/server.ts','apps/bridge/src/session.ts','apps/bridge/src/framing.ts','apps/bridge/src/ardupilot-json.ts','scripts/run-sitl.mjs','scripts/sitl.lock.json',
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
const text=frameParameters(frame.id)+'LOG_DISARMED 1\n',extra=join(process.cwd(),'frame.parm');
writeFileSync(extra,text);writeFileSync(join(directory,'frame.parm'),text);
const frameExpectedParameters={AHRS_EKF_TYPE:3,EK3_ENABLE:1,WP_SPD:10};
for(const line of text.trim().split('\n')){const [name,value]=line.split(' ');frameExpectedParameters[name]=Number(value);}
const script=frameScript(frame.id);
if(script){mkdirSync('scripts');writeFileSync('scripts/frame.lua',script);writeFileSync(join(directory,'frame.lua'),script);}
const physics=createSocket('udp4');physics.bind(0,'127.0.0.1');await once(physics,'listening');
// This separate quiet socket tests bridge liveness across the same wall holds.
// Native physics below remains direct UDP; integrated bridge physics is TASK-153.
const {startBridge}=await import('../../apps/bridge/src/server.ts');
const {WebSocket}=await import('ws');
const token=randomBytes(32).toString('hex'),origin='http://localhost:5173';
const bridge=await startBridge({port:0,origin,token,epoch:1,udp:{mavlinkPort:14550,physicsPort:14551},ardupilotJson:{localPort:0}});
const bridgeClient=new WebSocket(`ws://127.0.0.1:${bridge.port}`,['mirage-v1',`session.${token}`],{origin});
await once(bridgeClient,'open');
const bridgePings=[];bridgeClient.on('ping',()=>bridgePings.push(performance.now()));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const tcpPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const firmwareLog=openSync(join(directory,'firmware.log'),'w');
const physicsLog=openSync(join(directory,'physics.ndjson'),'w'),servoLog=openSync(join(directory,'servo.raw'),'w');
const replyLog=openSync(join(directory,'replies.ndjson'),'w');
const telemetryLog=openSync(join(directory,'telemetry.ndjson'),'w');
const firmware=spawn(binary,['--model','JSON:127.0.0.1','--speedup',String(speedup),'--rate','800',
  '--home','-35.362938,149.165085,584,0','--sim-port-out',String(physics.address().port),
  '--serial0',`tcp:${tcpPort}`,'--serial1','none','--serial2','none',
  '--defaults',[join(source,'Tools/autotest/default_params/copter.parm'),parameters,extra].join(',')],{stdio:['ignore',firmwareLog,firmwareLog]});
const telemetry=spawn(python,[join(root,'scripts/sitl/pause-telemetry.py'),String(tcpPort),join(directory,'mavlink.raw'),'--frames'],{stdio:['pipe','pipe','pipe']});
const gate=new LiveEkfWarmup('external-sitl',1,0,0,speedup,{imuSource:'json-lockstep'});
const parameterValues={},commands=[],samples=[];
const boundary=new PauseBoundary(),pauses=[],completed=new Set();
const pauseWire=openSync(join(directory,'pause-servo.ndjson'),'w');
let pauseTimer=null,probePhase='confirm',sawProbe=false,lastProbeWrite=-Infinity,lastProbeWritten=null;
const truthSnapshot=()=>({positionNedM:Array.from(model.truth.positionNedM),velocityNedMps:Array.from(model.truth.velocityNedMps),quaternionWxyz:Array.from(model.truth.quaternionBodyToNed),angularVelocityBodyRadS:Array.from(model.truth.angularVelocityBodyRadS)});
let heartbeat=null,ekf=null,globalPosition=null,scriptReady=script===null;
let timeS=0,lastReply=-1,lastSample=-1,stage='warmup',lastCommand=-Infinity,holdStart=-1;
let firstReady=null,finished=false,failure=null,lastParameterRequest=-Infinity;

let physicsBatch='',physicsCount=0;
const start=performance.now();
function fail(error){failure??=error instanceof Error?error:Error(String(error));finished=true;}
function command(value){commands.push({timeS,wallTimeMs:performance.now()-start,...value});telemetry.stdin.write(JSON.stringify(value)+'\n');lastCommand=timeS;}
const parametersConfirmed=()=>Object.entries(frameExpectedParameters).every(([name,value])=>parameterValues[name]===value);
const baselineParameter=()=>frameExpectedParameters.WP_SPD;
function syncProbe(){
  if(boundary.active)return;
  const action=parameterProbe(probePhase,parameterValues.WP_SPD,baselineParameter(),sawProbe);
  probePhase=action.phase;sawProbe=action.sawProbe;
  if(action.write===null)return;
  if(lastProbeWritten===action.write&&timeS-lastProbeWrite<1)return;
  command({kind:'set-parameter',name:'WP_SPD',value:action.write});
  lastProbeWritten=action.write;lastProbeWrite=timeS;
}
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
    if(m.mavpackettype==='PARAM_VALUE'&&m.param_id==='WP_SPD')syncProbe();
  }catch(error){fail(error);}
});
const deadline=setTimeout(()=>fail(Error('Pause capture wall deadline exceeded')),280000);
physics.on('error',fail);
function processPacket(bytes,peer){
  if(finished)return;
  try{
    if(peer.address!=='127.0.0.1')throw Error('Non-loopback servo peer');
    const disposition=boundary.accept(bytes);
    if(disposition==='echo')return;
    if(disposition==='held'){writeSync(pauseWire,JSON.stringify({wallTimeMs:performance.now()-start,kind:boundary.active.kind,hex:bytes.toString('hex')})+'\n');return;}
    if(disposition==='changed')throw Error('Servo packet advanced or changed while held');
    syncProbe();
    let pauseKind=null;
    if(withPauses&&probePhase==='confirm'&&parametersConfirmed()&&!completed.has('ground')&&timeS>=35&&firstReady)pauseKind='ground';
    if(withPauses&&probePhase==='confirm'&&parametersConfirmed()&&!completed.has('hover')&&stage==='hold'&&timeS-holdStart>=2)pauseKind='hover';
    if(pauseKind){
      const frozen=truthSnapshot();boundary.hold(pauseKind,bytes,peer,frozen,timeS,performance.now()-start);
      const entry={kind:pauseKind,timeS,servoFrame:bytes.readUInt32LE(4),startWallMs:performance.now()-start,before:frozen,heartbeat,ekf,globalPosition};
      entry.bridgePingStart=bridgePings.length;pauses.push(entry);
      writeSync(pauseWire,JSON.stringify({wallTimeMs:entry.startWallMs,kind:pauseKind,hex:bytes.toString('hex')})+'\n');
      probePhase='held';sawProbe=false;
      const probe=pauseProbeValue(baselineParameter());
      command({kind:'read-parameters',names:['WP_SPD']});
      command({kind:'set-parameter',name:'WP_SPD',value:probe});
      command({kind:'read-parameters',names:['WP_SPD']});
      lastProbeWritten=probe;lastProbeWrite=timeS;
      pauseTimer=setTimeout(()=>{
        try{
          const held=boundary.release(timeS,truthSnapshot(),performance.now()-start);
          entry.endWallMs=performance.now()-start;entry.durationMs=held.durationMs;entry.repeatedFrames=held.repeatedFrames;entry.after=truthSnapshot();
          entry.bridgePingCount=bridgePings.length-entry.bridgePingStart;entry.bridgeOpen=bridgeClient.readyState===WebSocket.OPEN;
          if(!entry.bridgeOpen||entry.bridgePingCount<55)throw Error('Quiet bridge did not survive the pause');
          completed.add(pauseKind);probePhase='restore';
          processPacket(held.packet,held.peer);
          boundary.noteEcho(held.packet);
        }catch(error){fail(error);}
      },60050);
      return;
    }
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
    writeSync(replyLog,JSON.stringify({wallTimeMs:performance.now()-start,servoFrame:link.lastFrameCount,hex:Buffer.from(reply.subarray(0,size)).toString('hex')})+'\n');
    physics.send(reply.subarray(0,size),peer.port,peer.address);
    lastReply=link.lastFrameCount;lastSample=timeS;
    if(timeS>=5&&!parametersConfirmed()&&timeS-lastParameterRequest>=3){
      const names=Object.keys(frameExpectedParameters).filter(name=>parameterValues[name]!==frameExpectedParameters[name]);
      command({kind:'read-parameters',names});lastParameterRequest=timeS;
    }
    if(probePhase==='confirm'&&timeS>30&&(!parametersConfirmed()||!scriptReady))throw Error('Frame parameters or stock Lua initialization were not confirmed');
    const pausedMs=pauses.reduce((sum,p)=>sum+(p.durationMs??0),0);
    const ready=gate.observe(timeS,performance.now()-start-pausedMs);
    if(ready&&firstReady===null)firstReady={timeS,wallTimeMs:performance.now()-start};
    const armed=Boolean(heartbeat&&(heartbeat.base_mode&128)),mode=heartbeat?.custom_mode;
    const health=gate.monitor.snapshot(timeS*1000);
    const pwm=Array.from({length:frame.servoPacketChannels},(_,i)=>bytes.readUInt16LE(8+2*i));
    if(phase==='flight'){
      if(parametersConfirmed()&&scriptReady&&timeS-lastCommand>1){
        if(stage==='warmup'&&ready&&(!withPauses||completed.has('ground'))){if(mode!==4)command({kind:'mode',mode:4});else command({kind:'arm'});}
        else if(stage==='arm'&&armed)command({kind:'takeoff'});
      }
      if(stage==='warmup'&&ready&&armed&&mode===4)stage='arm';
      const altitude=-truth.positionNedM[2];
      if(stage==='arm'&&altitude>=3)stage='takeoff';
      if(stage==='takeoff'&&Math.abs(altitude-10)<=1&&Math.abs(truth.velocityNedMps[2])<0.5){stage='hold';holdStart=timeS;}
      if(stage==='hold'&&timeS-holdStart>=(withPauses?12.2:10.2)&&timeS-lastCommand>1)command({kind:'land'});
      if(stage==='hold'&&mode===9)stage='land';
      if(stage!=='warmup'){
        if(!health.healthy||!globalPosition||timeS-globalPosition.timeS>1)throw Error('Flight diagnostics lost freshness/health');
        if(link.lastFrameCount%8===0)samples.push({timeS,servoFrame:link.lastFrameCount,stage,armed,mode,altitudeM:altitude,
          heartbeatAgeS:timeS-heartbeat.timeS,ekfAgeS:timeS-ekf.timeS,altitudeAgeS:timeS-globalPosition.timeS,
          ekfFlags:ekf.flags,innovationRatios:['velocity_variance','pos_horiz_variance','pos_vert_variance','compass_variance','terrain_alt_variance'].map(k=>ekf[k]),
          autopilotAltitudeM:globalPosition.relative_alt/1000,pwmUs:channels.map(channel=>pwm[channel-1])});
      }
      if(stage==='land'&&!armed&&altitude<=0.5&&probePhase==='confirm'&&parametersConfirmed()&&link.lastFrameCount%8===0)finished=true;
      if(Math.abs(altitude)>100||truth.positionNedM.some(value=>!Number.isFinite(value)))throw Error('Frame left the flight envelope');
    }
    physicsBatch+=JSON.stringify({timeS,wallTimeMs:performance.now()-start,servoFrame:link.lastFrameCount,positionNedM:Array.from(truth.positionNedM),
      velocityNedMps:Array.from(truth.velocityNedMps),quaternionWxyz:Array.from(truth.quaternionBodyToNed)})+'\n';
    if(++physicsCount>=128){writeSync(physicsLog,physicsBatch);physicsBatch='';physicsCount=0;}
  }catch(error){fail(error);}
}
physics.on('message',processPacket);
while(!finished)await new Promise(resolve=>setTimeout(resolve,20));
clearTimeout(deadline);if(pauseTimer)clearTimeout(pauseTimer);physics.close();
bridgeClient.terminate();await bridge.close();
for(const child of [telemetry,firmware])if(child.exitCode===null)child.kill('SIGTERM');
await Promise.all([telemetry,firmware].map(child=>child.exitCode!==null?null:new Promise(resolve=>{
  const timer=setTimeout(()=>child.kill('SIGKILL'),500);child.once('close',()=>{clearTimeout(timer);resolve();});
})));
if(physicsBatch)writeSync(physicsLog,physicsBatch);
for(const fd of [physicsLog,servoLog,telemetryLog,firmwareLog,pauseWire,replyLog])closeSync(fd);
gate.dispose();
for(const input of sourceInputs)if(sha(readFileSync(join(root,input.file)))!==input.sha256)failure??=Error(`Source changed during frame capture: ${input.file}`);
if(sha(readFileSync(binary))!==sha(native.bytes))failure??=Error('Native binary changed during frame capture');
if(existsSync('logs')){mkdirSync(join(directory,'dataflash'));for(const name of readdirSync('logs'))if(/\.(BIN|LOG)$/.test(name))copyFileSync(join('logs',name),join(directory,'dataflash',name));}
const report={schemaVersion:1,task:'TASK-129',status:failure?'FAIL':'captured',failure:failure?.message??null,
  recordedAt:new Date().toISOString(),frameId:frame.id,phase,benchConstrained:phase==='motor-test',physicsHz:800,captureStride:8,
  configuration:model.configuration,frameExpectedParameters,parameterValues,scriptReady,speedup,withPauses,pauses,contract:PAUSE_CONTRACT,
  firmwareSourceInputs:['libraries/SITL/SIM_JSON.cpp','libraries/SITL/SIM_Aircraft.cpp','libraries/AC_WPNav/AC_WPNav.cpp','libraries/AP_AHRS/AP_AHRS.cpp','libraries/AP_Logger/AP_Logger.h','libraries/AP_NavEKF3/LogStructure.h'].map(file=>({file,sha256:sha(readFileSync(join(source,file)))})),
  sourceCommit:pin.commit,sourceInputs,firmwareSha256:sha(native.bytes),wasmSha256:sha(wasm),
  modelSha256:sha(Buffer.concat([readFileSync(join(root,'scripts/sitl/multirotor.mjs')),wasm,Buffer.from(JSON.stringify(model.configuration))])),
  host:{platform:process.platform,architecture:process.arch,osRelease:release(),cpu:cpus()[0]?.model},nativeBinary:native.identity,
  node:process.version,python,timeS,wallS:(performance.now()-start)/1000,stats:link.stats,firstReady,
  commands,samples,childExit:[firmware,telemetry].map(child=>({pid:child.pid,code:child.exitCode,signal:child.signalCode})),
  imuNoiseFloor:{setting:'ardupilot',expected:[]}};
writeFileSync(join(directory,'run.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify({task:'TASK-129',status:report.status,frameId:frame.id,phase,timeS,steps:link.stats.steps,failure:report.failure}));
if(failure)throw failure;
}
if(process.argv[2]==='--child')await capturePause();
