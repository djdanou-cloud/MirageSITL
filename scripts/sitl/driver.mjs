// Cold Linux integration driver. The parent harness owns this process group.
import {spawn} from 'node:child_process';
import {createSocket} from 'node:dgram';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,writeSync,existsSync,readdirSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {QuadReference,configuration} from './quad.mjs';
import {ExternalSitlLockstep,newSitlPhysicsState,MAX_STATE_LINE_BYTES} from '../../packages/autopilot/src/external-sitl.ts';
import {LiveEkfWarmup} from '../../packages/autopilot/src/live-warmup.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const args=process.argv.slice(2);
if(process.platform==='win32'||args.length!==4||args[0]!=='--binary'||args[2]!=='--parameters')throw Error('Run the owned SITL driver on Linux with --binary PATH --parameters PATH');
const binary=resolve(args[1]),parameters=resolve(args[3]);
const source=process.env.MIRAGE_SITL_SOURCE,python=process.env.MIRAGE_SITL_PYTHON;
if(!source||!python)throw Error('Missing pinned source or pymavlink Python');
const directory=resolve(process.env.MIRAGE_SITL_CAPTURE_DIR??join(root,'.cache/task-042/capture'));
mkdirSync(directory,{recursive:true});
if(existsSync(join(directory,'run.json'))||existsSync(join(directory,'physics.ndjson')))throw Error('Capture directory already contains evidence; select a new directory');
const sourceFiles=['scripts/sitl/driver.mjs','scripts/sitl/quad.mjs','scripts/sitl/telemetry.py','scripts/run-sitl.mjs','scripts/sitl.lock.json',
  'packages/wasm-bet/src/backend.ts','packages/autopilot/src/external-sitl.ts','tests/fixtures/sitl/parameters.parm',
  'native/bet/src/rigid_body.rs','native/bet/src/body_abi.rs','native/bet/src/math.rs','native/bet/src/lib.rs',
  'native/Cargo.lock','native/rust-toolchain.toml'];
sourceFiles.push('packages/autopilot/src/live-warmup.ts','packages/autopilot/src/ekf-status.ts','packages/autopilot/src/warmup.ts',
  'packages/mavlink/src/codec.ts','packages/protocol/src/layout-v2.ts');
const sourceInputs=sourceFiles.map(file=>({file,sha256:sha(readFileSync(join(root,file)))}));
const wasmPath=join(root,'packages/wasm-bet/dist/mirage_bet.scalar.wasm'),wasm=readFileSync(wasmPath);
const manifest=JSON.parse(readFileSync(join(root,'packages/wasm-bet/dist/manifest.json')));
if(manifest.artifacts.find(v=>v.variant==='scalar')?.sha256!==sha(wasm))throw Error('Body WASM manifest mismatch');
const {instance}=await WebAssembly.instantiate(wasm,{});
const quad=new QuadReference(instance),lock=new ExternalSitlLockstep({motorChannels:[1,2,3,4]});
const state=newSitlPhysicsState(),reply=new Uint8Array(MAX_STATE_LINE_BYTES),throttle=new Float64Array(4);
const physics=createSocket('udp4');physics.bind(0,'127.0.0.1');await once(physics,'listening');
// Dedicated instance ports: neither attach to nor terminate an existing SITL.
const tcpProbe=createServer();tcpProbe.listen(0,'127.0.0.1');await once(tcpProbe,'listening');
const tcpPort=tcpProbe.address().port;await new Promise(resolve=>tcpProbe.close(resolve));
const extra=join(process.cwd(),'quad.parm');
writeFileSync(extra,'FRAME_CLASS 1\nFRAME_TYPE 1\nMOT_PWM_MIN 1000\nMOT_PWM_MAX 2000\nSIM_RATE_HZ 800\n');
const logs=openSync(join(directory,'firmware.log'),'w'),raw=openSync(join(directory,'physics.ndjson'),'w');
let rawBatch='';let rawBatchCount=0;
function recordPhysics(value){rawBatch+=JSON.stringify(value)+'\n';if(++rawBatchCount>=128){writeSync(raw,rawBatch);rawBatch='';rawBatchCount=0;}}
const firmware=spawn(binary,['--model','JSON:127.0.0.1','--speedup','2','--rate','800','--home','-35.362938,149.165085,584,0',
  '--sim-port-out',String(physics.address().port),'--serial0',`tcp:${tcpPort}`,'--serial1','none','--serial2','none',
  '--defaults',[join(source,'Tools/autotest/default_params/copter.parm'),parameters,extra].join(',')],
  {stdio:['ignore',logs,logs]});
const telemetry=spawn(python,[join(root,'scripts/sitl/telemetry.py'),String(tcpPort),join(directory,'mavlink.raw')],{stdio:['pipe','pipe','pipe']});
const events=openSync(join(directory,'telemetry.ndjson'),'w');
const readinessLog=openSync(join(directory,'warmup.ndjson'),'w');
const gate=new LiveEkfWarmup('external-sitl',1,0,0,2,{imuSource:'json-lockstep'});
let lastRepliedFrame=-1,lastImuSampleS=-1;
let readyPrevious=false,firstReady=null,warmupBatch='',warmupCount=0;
let timeS=0,heartbeat=null,ekf=null,global=null,finished=false,failure=null,stage='warmup',lastCommand=-Infinity,holdStart=-1;
const samples=[],commands=[];
function fail(error){failure??=error instanceof Error?error:Error(String(error));finished=true;}
for(const child of [firmware,telemetry]) {child.on('error',fail);child.on('exit',(code,signal)=>{if(!finished)fail(Error(`Owned child exited ${code}/${signal}`));});}
telemetry.stderr.on('data',bytes=>process.stderr.write(bytes));
function command(value){commands.push({timeS,...value});telemetry.stdin.write(JSON.stringify(value)+'\n');lastCommand=timeS;}
createInterface({input:telemetry.stdout}).on('line',line=>{
  try {
    const envelope=JSON.parse(line),m=envelope.message;
    if(typeof envelope.wireHex!=='string'||!/^(?:[a-f0-9]{2})+$/.test(envelope.wireHex))throw Error('Missing original MAVLink wire frame');
    if(['HEARTBEAT','EKF_STATUS_REPORT','HIGHRES_IMU','RAW_IMU','GPS_RAW_INT'].includes(m.mavpackettype))gate.ingest(Buffer.from(envelope.wireHex,'hex'),timeS);
    writeSync(events,JSON.stringify({receivedSimS:timeS,wallTimeMs:performance.now()-start,message:m,wireHex:envelope.wireHex})+'\n');
    if(m.mavpackettype==='HEARTBEAT')heartbeat={timeS,...m};
    if(m.mavpackettype==='EKF_STATUS_REPORT')ekf={timeS,...m};
    if(m.mavpackettype==='GLOBAL_POSITION_INT')global={timeS,...m};
    if(m.mavpackettype==='STATUSTEXT')process.stderr.write(`SITL ${timeS.toFixed(2)} ${m.text}\n`);
  } catch(error){fail(error);}
});
const start=performance.now();
const deadline=setTimeout(()=>fail(Error('Driver flight deadline exceeded')),110000);
physics.on('error',fail);
physics.on('message',(bytes,peer)=>{
  if(finished)return;
  try {
    if(peer.address!=='127.0.0.1')throw Error('Non-loopback physics peer');
    const disposition=lock.receive(bytes);
    if(disposition==='duplicate') {const n=lock.resendReplyInto(reply);if(n)physics.send(reply.subarray(0,n),peer.port,peer.address);return;}
    if(disposition!=='step')throw Error(`Unexpected servo disposition ${disposition}`);
    // SIM_JSON starts with Aircraft's 1200 Hz default; our reply dt sets its
    // rate via adjust_frame_time. Its float is truncated to uint16 on the wire.
    const advertisedHz=bytes.readUInt16LE(2);
    if(!([799,800].includes(advertisedHz)||(lock.stats.steps===0&&advertisedHz===1200)))throw Error(`Unexpected firmware physics rate ${advertisedHz}`);
    if(!lock.consumeActuatorsInto(throttle))throw Error('Missing pending actuator frame');
    if(lastRepliedFrame>=0&&!gate.acknowledgeJsonImu(lock.lastFrameCount,lastRepliedFrame,lastImuSampleS))throw Error('Invalid JSON IMU acknowledgment');
    quad.step(throttle,1/800);timeS=lock.stats.steps/800;
    const t=quad.truth;
    state.timestampS=timeS;state.gyroBodyRadS.set(t.angularVelocityBodyRadS);state.accelBodyMps2.set(quad.specificForce);
    state.positionNedM.set(t.positionNedM);state.velocityNedMps.set(t.velocityNedMps);state.quaternionWxyz.set(t.quaternionBodyToNed);
    const n=lock.completeStepInto(state,reply);if(!n)throw Error('Invalid JSON state');
    physics.send(reply.subarray(0,n),peer.port,peer.address);
    lastRepliedFrame=lock.lastFrameCount;lastImuSampleS=state.timestampS;
    const fresh=(m)=>m&&timeS>=m.timeS&&timeS-m.timeS<=1;
    const innovations=ekf&&['velocity_variance','pos_horiz_variance','pos_vert_variance','compass_variance','terrain_alt_variance'].map(k=>ekf[k]);
    const healthy=gate.monitor.snapshot(timeS*1000).healthy;
    const wallTimeMs=performance.now()-start,ready=gate.observe(timeS,wallTimeMs);
    if(ready&&firstReady===null)firstReady={timeS,wallTimeMs,imuTimeS:gate.imuTimeS,gpsTimeS:gate.gpsTimeS,accelerationFactor:gate.warmup.accelerationFactor};
    if(lock.lastFrameCount%8===0||ready!==readyPrevious) {
      warmupBatch+=JSON.stringify({timeS,wallTimeMs,servoFrame:lock.lastFrameCount,acknowledgedReplyFrame:lock.lastFrameCount-1,
        imuTimeS:gate.imuTimeS,imuSource:gate.imuSource,reportedImuTimeS:gate.reportedImuTimeS,gpsTimeS:gate.gpsTimeS,ready,ewAllowed:gate.warmup.ewAllowed,
        reason:gate.warmup.reason,accelerationFactor:gate.warmup.accelerationFactor,health:gate.monitor.snapshot(timeS*1000)})+'\n';
      if(++warmupCount>=128){writeSync(readinessLog,warmupBatch);warmupBatch='';warmupCount=0;}
    }
    readyPrevious=ready;
    const armed=Boolean(heartbeat&&(heartbeat.base_mode&128)),mode=heartbeat?.custom_mode;
    recordPhysics({timeS,servoFrame:lock.lastFrameCount,pwmUs:Array.from({length:4},(_,i)=>bytes.readUInt16LE(8+2*i)),
      positionNedM:Array.from(t.positionNedM),quaternion:Array.from(t.quaternionBodyToNed),healthy,armed,mode,stage});
    if(timeS-lastCommand>1) {
      if(stage==='warmup'&&ready) {if(mode!==4)command({kind:'mode',mode:4});else command({kind:'arm'});}
      else if(stage==='arm'&&armed)command({kind:'takeoff'});
    }
    if(stage==='warmup'&&armed&&ready&&mode===4)stage='arm';
    const altitude=-t.positionNedM[2];
    if(stage==='arm'&&altitude>=3)stage='takeoff';
    if(stage==='takeoff'&&Math.abs(altitude-10)<=1&&Math.abs(t.velocityNedMps[2])<0.5) {stage='hold';holdStart=timeS;}
    if(stage==='hold'&&timeS-holdStart>=10.2&&timeS-lastCommand>1)command({kind:'land'});
    if(stage==='hold'&&mode===9)stage='land';
    if(stage!=='warmup') {
      if(!healthy)throw Error('Autopilot health lost during accepted flight');
      if(!fresh(global))throw Error('Missing fresh autopilot altitude');
      if(lock.lastFrameCount%8===0)samples.push({timeS,stage,armed,altitudeM:altitude,mode,ekfHealthy:healthy,servoFrame:lock.lastFrameCount,
        pwmUs:Array.from({length:4},(_,i)=>bytes.readUInt16LE(8+2*i)),
        heartbeatAgeS:timeS-heartbeat.timeS,ekfAgeS:timeS-ekf.timeS,ekfFlags:ekf.flags,innovationRatios:innovations,
        autopilotAltitudeM:global.relative_alt/1000,altitudeAgeS:timeS-global.timeS});
    }
    if(stage==='land'&&!armed&&altitude<=0.5&&lock.lastFrameCount%8===0)finished=true;
    if(Math.abs(altitude)>100||t.positionNedM.some(v=>!Number.isFinite(v)))throw Error('Aircraft left integration envelope');
  } catch(error){fail(error);}
});
while(!finished)await new Promise(resolve=>setTimeout(resolve,20));
clearTimeout(deadline);physics.close();
for(const child of [telemetry,firmware])if(child.exitCode===null)child.kill('SIGTERM');
await Promise.all([telemetry,firmware].map(child=>child.exitCode!==null?null:new Promise(resolve=>{
  const timer=setTimeout(()=>child.kill('SIGKILL'),500);child.once('close',()=>{clearTimeout(timer);resolve();});
})));
if(rawBatch)writeSync(raw,rawBatch);
if(warmupBatch)writeSync(readinessLog,warmupBatch);
gate.dispose();
for(const fd of [logs,raw,events,readinessLog])closeSync(fd);
for(const input of sourceInputs)if(sha(readFileSync(join(root,input.file)))!==input.sha256)failure??=Error(`Source changed during flight: ${input.file}`);
const dataflash=join(process.cwd(),'logs');
if(existsSync(dataflash)) {
  mkdirSync(join(directory,'dataflash'),{recursive:true});
  for(const name of readdirSync(dataflash))if(/\.(BIN|LOG)$/.test(name))copyFileSync(join(dataflash,name),join(directory,'dataflash',name));
}
const modelSha256=sha(Buffer.concat([readFileSync(new URL('./quad.mjs',import.meta.url)),wasm,Buffer.from(JSON.stringify(configuration))]));
const trace={schemaVersion:2,physicsHz:800,captureStride:8,provenance:{source:'native-sitl',operator:'TASK-042 owned local integration driver',recordedAt:new Date().toISOString(),firmwareSha256:sha(readFileSync(binary)),modelSha256},samples};
writeFileSync(join(directory,'flight.json'),JSON.stringify(trace)+'\n');
writeFileSync(join(directory,'run.json'),JSON.stringify({status:failure?'FAIL':'captured',failure:failure?.message,configuration,commands,timeS,wallS:(performance.now()-start)/1000,stats:lock.stats,
  sourceInputs,wasmSha256:sha(wasm),node:process.version,python,firmwarePid:firmware.pid,telemetryPid:telemetry.pid,
  warmup:{firstReady,imuSource:gate.imuSource,epoch:1,configuredSpeed:2,disposedReady:gate.warmup.ready,disposedEwAllowed:gate.warmup.ewAllowed,parserFrames:gate.parser.frames,badCrc:gate.parser.badCrc},
  childExit:[{pid:firmware.pid,code:firmware.exitCode,signal:firmware.signalCode},{pid:telemetry.pid,code:telemetry.exitCode,signal:telemetry.signalCode}],
  defaultsSha256:sha(readFileSync(join(source,'Tools/autotest/default_params/copter.parm'))),extraParametersSha256:sha(readFileSync(extra))},null,2)+'\n');
if(failure)throw failure;
process.stdout.write(JSON.stringify(trace));
