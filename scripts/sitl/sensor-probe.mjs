// Cold TASK-147 native sensor-error probe. The parent (scripts/run-sitl-sensors.mjs)
// owns this process group. Each case boots the pinned ArduCopter SITL on the
// JSON backend with the vehicle at rest on the ground, writes the case's
// generated SITL parameters, reads every one of them back before its samples
// count, delivers the MirageSITL-owned errors in the JSON state line, and
// records what the firmware reports. scripts/check-sitl-sensors.mjs judges it.
import {spawn} from 'node:child_process';
import {createSocket} from 'node:dgram';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,writeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {ExternalSitlLockstep,newSitlPhysicsState,MAX_STATE_LINE_BYTES} from '../../packages/autopilot/src/external-sitl.ts';
import {parseArduPilotCatalog} from '../../packages/autopilot/src/error-ownership.ts';
import {ConfiguredBattery,ConfiguredImu} from '../../packages/sensors/src/configured.ts';
await import('./json-modules.mjs');
const {sensorRuntime,STOCK_COMPASS_OFFSETS_MILLIGAUSS}=await import('../../packages/aircraft/src/sensor-parameters.ts');
const {validateSensorConfiguration}=await import('../../packages/aircraft/src/sensor-config.ts');
const {DEFAULT_SENSOR_CONFIGURATION}=await import('../../packages/aircraft/src/sensor-fields.ts');

const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const PROBE=Object.freeze({physicsHz:800,homeAltitudeM:584,settleS:20,windowS:6,linesHashedFrames:8000,
  batteryTruthV:12.6,batteryTruthA:0,gravityMps2:9.80665,caseWallDeadlineMs:120000});
const specified=change=>{const config=structuredClone(DEFAULT_SENSOR_CONFIGURATION);change(config);return config;};
const noisy=specified(c=>{c.imu.accelNoiseDensityMps2PerSqrtHz=2e-3;c.imu.gyroNoiseDensityRadSPerSqrtHz=1e-4;});
/** Each case: a sensor configuration (null is the ArduPilot defaults), a seed, and user defaults written before the generated ones. */
export const SENSOR_CASES=Object.freeze([
  {id:'ideal',configuration:{...structuredClone(DEFAULT_SENSOR_CONFIGURATION),mode:'ideal'},seed:1,user:{}},
  // TASK-089's neutral for the hard iron: both offsets zero. The capture compares it with Ideal's pairing.
  {id:'zero-offsets',configuration:null,seed:1,user:Object.fromEntries([1,2,3].flatMap(n=>['X','Y','Z'].flatMap(a=>
    [[`SIM_MAG${n}_OFS_${a}`,0],[`COMPASS_OFS${n===1?'':n}_${a}`,0]])))},
  {id:'specified',seed:1,user:{},configuration:specified(c=>{
    c.magnetometer.biasGauss=[0.05,-0.03,0.02];c.barometer.biasPa=30;c.gnss.updateRateHz=10;
    c.battery.voltageGainError=0.02;c.battery.voltageOffsetV=-0.15;c.battery.currentOffsetA=0.4;})},
  // An earlier user setting of ArduPilot's own accelerometer bias, which MirageSITL's ownership must switch off.
  {id:'imu-bias',seed:1,user:{SIM_ACC1_BIAS_X:0.4,SIM_ACC1_BIAS_Y:0.4,SIM_ACC1_BIAS_Z:0.4},configuration:specified(c=>{
    c.imu.accelBiasMps2=[0.5,-0.3,0.2];c.imu.gyroBiasRadS=[0.01,0,-0.02];})},
  {id:'imu-tilt',seed:1,user:{},configuration:specified(c=>{c.imu.orientationRad=[0,0.05,0];})},
  // Every MirageSITL term given as zero: the delivered lines must equal the neutral ones bit for bit.
  {id:'zero-terms',seed:1,user:{},configuration:specified(c=>{
    Object.assign(c.imu,{accelNoiseDensityMps2PerSqrtHz:0,gyroNoiseDensityRadSPerSqrtHz:0,accelBiasMps2:[0,0,0],gyroBiasRadS:[0,0,0],
      latencyUs:0,positionBodyM:[0,0,0],orientationRad:[0,0,0]});
    Object.assign(c.battery,{voltageGainError:0,voltageOffsetV:0,voltageNoiseRmsV:0,currentGainError:0,currentOffsetA:0,currentNoiseRmsA:0});})},
  {id:'noise-a',seed:7,user:{},configuration:noisy},
  {id:'noise-b',seed:7,user:{},configuration:noisy},
  {id:'noise-c',seed:8,user:{},configuration:noisy},
]);

/** The parameters a case expects the firmware to hold: user defaults, then the generated ones, which win. */
export function expectedParameters(user,generated){
  const values=new Map(Object.entries(user));
  for(const p of generated)values.set(p.name,p.value);
  return [...values].sort(([a],[b])=>a<b?-1:1).map(([name,value])=>({name,value}));
}
const parm=values=>values.map(({name,value})=>`${name} ${String(value)}`).join('\n')+'\n';

async function runCase(entry,{binary,source,python,catalog,directory}){
  const dir=join(directory,entry.id);mkdirSync(dir);
  const configuration=entry.configuration===null?null:validateSensorConfiguration(entry.configuration);
  const runtime=sensorRuntime(configuration,catalog,{homeAltitudeM:PROBE.homeAltitudeM,compassOffsetsMilliGauss:STOCK_COMPASS_OFFSETS_MILLIGAUSS,cgBodyM:[0,0,0]});
  const user=Object.entries(entry.user).map(([name,value])=>({name,value}));
  const expected=expectedParameters(entry.user,runtime.parameters);
  writeFileSync(join(dir,'user.parm'),user.length?parm(user):'\n');
  writeFileSync(join(dir,'sensors.parm'),'FRAME_CLASS 1\nFRAME_TYPE 1\nMOT_PWM_MIN 1000\nMOT_PWM_MAX 2000\nSIM_RATE_HZ 800\n'+runtime.parameterProfile);
  const imu=new ConfiguredImu(runtime.imu,entry.seed,PROBE.physicsHz),battery=new ConfiguredBattery(runtime.battery,entry.seed);
  const lock=new ExternalSitlLockstep({motorChannels:[1,2,3,4]}),state=newSitlPhysicsState(),reply=new Uint8Array(MAX_STATE_LINE_BYTES);
  const throttle=new Float64Array(4),zero=new Float64Array(3),force=Float64Array.of(0,0,-PROBE.gravityMps2),measured=new Float64Array(2);
  const physics=createSocket('udp4');physics.bind(0,'127.0.0.1');await once(physics,'listening');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const tcpPort=probe.address().port;await new Promise(done=>probe.close(done));
  const logs=openSync(join(dir,'firmware.log'),'w'),events=openSync(join(dir,'telemetry.ndjson'),'w');
  const firmware=spawn(binary,['--model','JSON:127.0.0.1','--speedup','10','--rate','800','--home',`-35.362938,149.165085,${PROBE.homeAltitudeM},0`,
    '--sim-port-out',String(physics.address().port),'--serial0',`tcp:${tcpPort}`,'--serial1','none','--serial2','none',
    '--defaults',[join(source,'Tools/autotest/default_params/copter.parm'),join(root,'tests/fixtures/sitl/parameters.parm'),
      join(dir,'user.parm'),join(dir,'sensors.parm')].join(',')],{cwd:dir,stdio:['ignore',logs,logs]});
  const telemetry=spawn(python,[join(root,'scripts/sitl/telemetry.py'),String(tcpPort),join(dir,'mavlink.raw'),'--sensors'],{cwd:dir,stdio:['pipe','pipe','pipe']});
  let timeS=0,heartbeat=false,finished=false,failure=null,requestS=-Infinity,confirmedAtS=null,parameterCount=null;
  // The complete parameter list: it shows what the build holds and which cataloged instances it lacks.
  const reported={},indices=new Set(),lines=createHash('sha256');let hashed=0;
  const fail=error=>{failure??=error instanceof Error?error:Error(String(error));finished=true;};
  for(const child of [firmware,telemetry]){child.on('error',fail);child.on('exit',(code,signal)=>{if(!finished)fail(Error(`Owned child exited ${code}/${signal}`));});}
  telemetry.stderr.on('data',bytes=>process.stderr.write(bytes));
  createInterface({input:telemetry.stdout}).on('line',text=>{
    try{
      const envelope=JSON.parse(text),m=envelope.message;
      writeSync(events,JSON.stringify({receivedSimS:timeS,message:m,wireHex:envelope.wireHex})+'\n');
      if(m.mavpackettype==='HEARTBEAT')heartbeat=true;
      if(m.mavpackettype==='PARAM_VALUE'){
        reported[m.param_id]=m.param_value;
        if(m.param_index>=0&&m.param_index<65535){indices.add(m.param_index);parameterCount=m.param_count;}
      }
    }catch(error){fail(error);}
  });
  const listed=()=>parameterCount!==null&&indices.size===parameterCount;
  const confirmed=()=>listed()&&expected.every(p=>!(p.name in reported)||reported[p.name]===Math.fround(p.value));
  const deadline=setTimeout(()=>fail(Error(`Case ${entry.id} wall deadline exceeded`)),PROBE.caseWallDeadlineMs);
  physics.on('message',(bytes,peer)=>{
    if(finished)return;
    try{
      if(peer.address!=='127.0.0.1')throw Error('Non-loopback physics peer');
      const disposition=lock.receive(bytes);
      if(disposition==='duplicate'){const n=lock.resendReplyInto(reply);if(n)physics.send(reply.subarray(0,n),peer.port,peer.address);return;}
      if(disposition!=='step')throw Error(`Unexpected servo disposition ${disposition}`);
      if(!lock.consumeActuatorsInto(throttle))throw Error('Missing pending actuator frame');
      if(throttle.some(t=>t>0))throw Error('Motors ran during a ground probe');
      timeS=lock.stats.steps/PROBE.physicsHz;
      // At rest: no rotation, specific force −g along body z.
      if(!imu.stepInto(force,zero,zero,state.accelBodyMps2,state.gyroBodyRadS))throw Error('Invalid IMU sample');
      if(!battery.stepInto(PROBE.batteryTruthV,PROBE.batteryTruthA,measured))throw Error('Invalid battery sample');
      state.timestampS=timeS;state.batteryVoltageV=measured[0];state.batteryCurrentA=measured[1];state.batteryValid=true;
      const n=lock.completeStepInto(state,reply);if(!n)throw Error('Invalid JSON state');
      if(hashed<PROBE.linesHashedFrames){lines.update(reply.subarray(0,n));hashed++;}
      physics.send(reply.subarray(0,n),peer.port,peer.address);
      if(confirmedAtS===null){
        if(confirmed())confirmedAtS=timeS;
        else if(heartbeat&&!listed()&&timeS-requestS>=5){
          telemetry.stdin.write(JSON.stringify({kind:'parameters'})+'\n');
          requestS=timeS;
        }
      }
      if(timeS>=PROBE.settleS&&confirmedAtS===null)throw Error(`Case ${entry.id}: the firmware did not report every generated parameter before the window`);
      if(timeS>=PROBE.settleS+PROBE.windowS)finished=true;
    }catch(error){fail(error);}
  });
  while(!finished)await new Promise(done=>setTimeout(done,20));
  clearTimeout(deadline);physics.close();
  for(const child of [telemetry,firmware])if(child.exitCode===null)child.kill('SIGTERM');
  await Promise.all([telemetry,firmware].map(child=>child.exitCode!==null?null:new Promise(done=>{
    const timer=setTimeout(()=>child.kill('SIGKILL'),500);child.once('close',()=>{clearTimeout(timer);done();});
  })));
  closeSync(logs);closeSync(events);
  const record={id:entry.id,status:failure?'FAIL':'captured',failure:failure?.message,seed:entry.seed,configuration,user:entry.user,
    matrixId:runtime.matrix.id,expected,reported:Object.fromEntries(expected.map(p=>[p.name,reported[p.name]??null])),confirmedAtS,
    parameterCount,listedParameters:indices.size,
    imuPlan:runtime.imu,batteryPlan:runtime.battery,residuals:runtime.residuals.map(r=>r.id),
    lines:{frames:hashed,sha256:lines.digest('hex')},stats:lock.stats,timeS};
  writeFileSync(join(dir,'case.json'),JSON.stringify(record,null,2)+'\n');
  writeFileSync(join(dir,'parameters.json'),JSON.stringify({parameterCount,values:Object.fromEntries(Object.entries(reported).sort(([a],[b])=>a<b?-1:1))})+'\n');
  return record;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const at=name=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:undefined;};
  const binary=at('--binary'),source=process.env.MIRAGE_SITL_SOURCE,python=process.env.MIRAGE_SITL_PYTHON,out=at('--out');
  if(process.platform==='win32'||!binary||!out||!source||!python)throw Error('Run on Linux or macOS with --binary PATH --out NEW_DIRECTORY, MIRAGE_SITL_SOURCE and MIRAGE_SITL_PYTHON');
  const directory=resolve(out);
  if(existsSync(directory))throw Error('Capture directory must be new');
  mkdirSync(directory,{recursive:true});
  const catalogBytes=readFileSync(join(root,'tests/fixtures/sitl/ardupilot-catalog.json'));
  const catalog=parseArduPilotCatalog(JSON.parse(catalogBytes.toString('utf8')));
  const inputs=['scripts/sitl/sensor-probe.mjs','scripts/sitl/telemetry.py','scripts/sitl/json-modules.mjs','packages/sensors/src/configured.ts',
    'packages/sensors/src/lever-arm.ts','packages/aircraft/src/sensor-parameters.ts','packages/aircraft/src/sensor-ownership.ts',
    'packages/aircraft/src/sensor-fields.ts','packages/autopilot/src/error-ownership.ts','packages/autopilot/src/external-sitl.ts',
    'tests/fixtures/sitl/ardupilot-catalog.json','tests/fixtures/sitl/parameters.parm'].map(file=>({file,sha256:sha(readFileSync(join(root,file)))}));
  const cases=[];let failed=null;
  for(const entry of SENSOR_CASES){
    const record=await runCase(entry,{binary:resolve(binary),source:resolve(source),python:resolve(python),catalog,directory});
    cases.push(record.id);process.stderr.write(`TASK-147 case ${record.id}: ${record.status}\n`);
    if(record.status!=='captured'){failed=record.failure;break;}
  }
  writeFileSync(join(directory,'run.json'),JSON.stringify({task:'TASK-147',status:failed?'FAIL':'captured',failure:failed,cases,probe:PROBE,
    firmwareSha256:sha(readFileSync(resolve(binary))),sourceCommit:JSON.parse(readFileSync(join(root,'scripts/sitl.lock.json'),'utf8')).commit,
    copterDefaultsSha256:sha(readFileSync(join(resolve(source),'Tools/autotest/default_params/copter.parm'))),inputs,node:process.version,
    recordedAt:new Date().toISOString()},null,2)+'\n');
  if(failed)throw Error(failed);
}
