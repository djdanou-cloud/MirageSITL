// Cold TASK-128 audit: original motor commands, parameter read-backs, servo bytes and physics replay.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {frameById,referenceConfiguration,MultirotorReference,frameParameters,frameScript} from './sitl/multirotor.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function assessMotorWindow(frame,sequence,rows,baseline){
  assert(Number.isInteger(sequence)&&sequence>=1&&sequence<=frame.motorCount,'Invalid test sequence');
  const expected=frame.motors.find(motor=>motor.testOrder===sequence);
  assert(expected,'Missing source-derived test order');
  assert(Array.isArray(baseline)&&baseline.length===frame.servoPacketChannels,'Invalid baseline width');
  let observedFrames=0;
  for(const pwm of rows){
    assert(Array.isArray(pwm)&&pwm.length===frame.servoPacketChannels,'Wrong servo width');
    assert(pwm.every(value=>Number.isInteger(value)&&value>=0&&value<=65535),'Invalid PWM bytes');
    const active=frame.motors.filter(motor=>pwm[motor.output-1]>1000);
    if(!active.length)continue;
    assert(active.length===1&&active[0].motor===expected.motor,'Wrong or simultaneous motor output');
    assert.equal(pwm[expected.output-1],1200,'Motor-test PWM differs from command');
    for(let output=0;output<pwm.length;output++){
      if(output===expected.output-1)continue;
      const motorOutput=frame.motors.some(motor=>motor.output===output+1);
      assert(motorOutput?pwm[output]<=1000:pwm[output]===baseline[output],'Another output changed');
    }
    observedFrames++;
  }
  assert(observedFrames>=8,'Missing sustained actual motor-test output');
  return {sequence,motor:expected.motor,output:expected.output,observedFrames};
}
export function auditFrameCapture(input){
  const directory=resolve(input);
  const read=file=>{const path=join(directory,file);assert(statSync(path).size<=64*1024*1024,'Frame input exceeds 64 MiB');return readFileSync(path);};
  const run=JSON.parse(read('run.json'));
  assert.equal(run.schemaVersion,1);assert.equal(run.task,'TASK-128');assert.equal(run.status,'captured');
  assert(['motor-test','flight'].includes(run.phase));
  assert.equal(run.physicsHz,800);assert.equal(run.captureStride,8);
  const frame=frameById(run.frameId);
  assert.equal(run.host?.platform,'darwin','TASK-128 target evidence requires native macOS');
  assert.equal(run.host?.architecture,'arm64');assert.equal(run.nativeBinary?.format,'mach-o64');
  assert.equal(run.nativeBinary?.architecture,'arm64');
  assert.equal(run.sourceCommit,'8ab6afde107a91df1b5f60ade8f333cb8a61b190');
  assert.match(run.firmwareSha256,/^[a-f0-9]{64}$/);
  assert(Array.isArray(run.sourceInputs)&&run.sourceInputs.length>=20,'Missing source identities');
  for(const input of run.sourceInputs){
    assert(typeof input.file==='string'&&!input.file.includes('..')&&!input.file.startsWith('/')&&!input.file.includes('\\')&&!input.file.includes(':'));
    assert.equal(sha(readFileSync(join(root,input.file))),input.sha256,`Source changed: ${input.file}`);
  }
  assert.deepEqual(run.configuration,referenceConfiguration(frame.id));
  assert.equal(read('frame.parm').toString(),frameParameters(frame.id));
  if(frame.kind==='stock-scripting')assert.equal(read('frame.lua').toString(),frameScript(frame.id));
  const rawAudit=JSON.parse(read('mavlink-audit.json'));
  assert.equal(rawAudit.status,'PASS');assert.equal(rawAudit.pymavlink,'2.4.50');
  assert.equal(rawAudit.rawSha256,sha(read('mavlink.raw')));
  assert.equal(rawAudit.decodedSha256,sha(read('telemetry.ndjson')));
  assert.equal(rawAudit.generatorSha256,sha(readFileSync(join(root,'scripts/sitl/check-raw.py'))));
  assert.equal(rawAudit.outboundSha256,sha(read('tx.raw')));
  assert.equal(rawAudit.frameParametersChecked,Object.keys(run.frameExpectedParameters).length);
  const expectedParameters={AHRS_EKF_TYPE:3,EK3_ENABLE:1};
  for(const line of frameParameters(frame.id).trim().split('\n')){const [name,value]=line.split(' ');expectedParameters[name]=Number(value);}
  assert.deepEqual(run.frameExpectedParameters,expectedParameters,'Missing frame parameter expectations');
  assert.equal(run.frameExpectedParameters.ARMING_SKIPCHK,0,'All arming checks must remain enabled');
  assert.equal(run.frameExpectedParameters.AHRS_EKF_TYPE,3);assert.equal(run.frameExpectedParameters.EK3_ENABLE,1);
  for(const [name,value] of Object.entries(run.frameExpectedParameters))assert.equal(run.parameterValues[name],value,`Unconfirmed ${name}`);
  assert.equal(run.scriptReady,true);
  for(const key of ['duplicates','gaps','droppedFrames','restarts','stale','invalid','repliesResent'])assert.equal(run.stats[key],0,key);
  const count=run.stats.steps;
  assert(Number.isSafeInteger(count)&&count>0&&count<=96000,'Unbounded frame count');
  assert.equal(run.timeS,count/800);assert(Number.isFinite(run.wallS)&&run.wallS>0&&run.wallS<=120);
  const servo=read('servo.raw'),stride=8+frame.servoPacketChannels*2;
  assert.equal(servo.length,count*stride);
  const physics=read('physics.ndjson').toString().trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(physics.length,count);
  const wasm=readFileSync(join(root,'packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  assert.equal(sha(wasm),run.wasmSha256);
  assert.equal(run.modelSha256,sha(Buffer.concat([readFileSync(join(root,'scripts/sitl/multirotor.mjs')),wasm,Buffer.from(JSON.stringify(run.configuration))])));
  const model=new MultirotorReference(new WebAssembly.Instance(new WebAssembly.Module(wasm),{}),frame.id);
  const throttles=new Float64Array(frame.motorCount);
  let clamped=0,maxPositionErrorM=0,maxQuaternionError=0;
  const pwmAt=index=>Array.from({length:frame.servoPacketChannels},(_,channel)=>servo.readUInt16LE(index*stride+8+channel*2));
  for(let index=0;index<count;index++){
    const offset=index*stride;
    assert.equal(servo.readUInt16LE(offset),frame.servoPacketChannels===32?29569:18458);
    assert.equal(servo.readUInt32LE(offset+4),index,'Original servo frame gap');
    const rate=servo.readUInt16LE(offset+2);assert([799,800].includes(rate)||index===0&&rate===1200);
    for(let m=0;m<frame.motorCount;m++){
      const value=servo.readUInt16LE(offset+8+2*(frame.motors[m].output-1));
      if(value<1000||value>2000)clamped++;
      throttles[m]=Math.max(0,Math.min(1,(value-1000)/1000));
    }
    if(run.phase==='flight')model.step(throttles,1/800);
    const row=physics[index];
    assert.equal(row.servoFrame,index);assert(Math.abs(row.timeS-(index+1)/800)<1e-9,'Physics timestamp mismatch');
    for(const [name,expected] of [['positionNedM',model.truth.positionNedM],['velocityNedMps',model.truth.velocityNedMps],['quaternionWxyz',model.truth.quaternionBodyToNed]]){
      assert(Array.isArray(row[name])&&row[name].length===expected.length);
      let sign=1;
      if(name==='quaternionWxyz'&&row[name].reduce((sum,value,index)=>sum+value*expected[index],0)<0)sign=-1;
      for(let component=0;component<expected.length;component++){
        assert(Number.isFinite(row[name][component]));
        const error=Math.abs(row[name][component]*sign-expected[component]);
        assert(error<=1e-10,'Raw servo replay differs from recorded truth');
        if(name==='positionNedM')maxPositionErrorM=Math.max(maxPositionErrorM,error);
        if(name==='quaternionWxyz')maxQuaternionError=Math.max(maxQuaternionError,error);
      }
    }
  }
  assert.equal(run.stats.clampedPwm,clamped);
  const telemetry=read('telemetry.ndjson').toString().trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(telemetry.length,rawAudit.recordedObservations);assert.equal(rawAudit.wireFramesChecked,telemetry.length);
  const byType=new Map();
  for(const event of telemetry){const kind=event.message.mavpackettype;if(!byType.has(kind))byType.set(kind,[]);byType.get(kind).push(event);}
  const observed=(kind,timeS,predicate)=>{
    assert(byType.get(kind)?.some(event=>Math.abs(event.receivedSimS-timeS)<1e-9&&predicate(event.message)),`No original ${kind} observation`);
  };
  let metrics;
  if(run.phase==='motor-test'){
    assert.equal(run.benchConstrained,true);assert.deepEqual(run.samples,[]);
    assert.equal(run.motorTests.length,frame.motorCount);assert.equal(rawAudit.motorTestCommands,frame.motorCount);
    const tests=[];
    for(let index=0;index<frame.motorCount;index++){
      const test=run.motorTests[index];assert.equal(test.sequence,index+1);
      const command=run.commands.filter(c=>c.kind==='motor-test')[index];
      assert.equal(command.sequence,test.sequence);assert.equal(command.timeS,test.startS);
      const start=Math.max(0,Math.round(test.startS*800));
      assert.deepEqual(test.baseline,pwmAt(Math.max(0,start-1)),'Baseline is not the original pre-command packet');
      const end=Math.min(count,Math.ceil((test.startS+0.8)*800));
      const rows=[];for(let tick=start;tick<end;tick++)rows.push(pwmAt(tick));
      const result=assessMotorWindow(frame,test.sequence,rows,test.baseline);
      assert.equal(result.observedFrames,test.observedFrames);
      assert(test.ackTimeS>=test.startS&&test.ackTimeS<=test.startS+0.8);
      observed('COMMAND_ACK',test.ackTimeS,m=>m.command===209&&m.result===0);
      tests.push(result);
    }
    metrics={testedMotors:tests.length,tests};
  }else{
    assert.equal(run.benchConstrained,false);assert.deepEqual(run.motorTests,[]);assert.equal(rawAudit.motorTestCommands,0);
    assert(Array.isArray(run.samples)&&run.samples.length>=4&&run.samples.length<=12000);
    const stages=['arm','takeoff','hold','land'];let stage=0,previous=null,holdStart=-1,holdEnd=-1,minHoldM=Infinity,maxHoldM=-Infinity;
    for(const sample of run.samples){
      assert(Number.isSafeInteger(sample.servoFrame)&&sample.servoFrame>=0&&sample.servoFrame<count);
      assert.equal(sample.servoFrame%8,0);
      if(previous){assert.equal(sample.servoFrame-previous.servoFrame,8);assert(Math.abs(sample.timeS-previous.timeS-0.01)<1e-9);}
      assert.equal(sample.timeS,physics[sample.servoFrame].timeS);
      // JSON canonicalizes -0 to 0; both denote the same pad altitude.
      assert(sample.altitudeM===-physics[sample.servoFrame].positionNedM[2]);
      assert.deepEqual(sample.pwmUs,frame.motors.map(m=>pwmAt(sample.servoFrame)[m.output-1]));
      assert(sample.pwmUs.every(value=>Number.isInteger(value)&&value>=1000&&value<=2000));
      if(sample.stage!==stages[stage]){assert.equal(sample.stage,stages[stage+1]);stage++;}
      assert.equal(sample.mode,sample.stage==='land'?9:4);
      if(sample.stage!=='land')assert.equal(sample.armed,true);
      for(const key of ['heartbeatAgeS','ekfAgeS','altitudeAgeS'])assert(Number.isFinite(sample[key])&&sample[key]>=0&&sample[key]<=1);
      assert(Number.isInteger(sample.ekfFlags)&&(sample.ekfFlags&55)===55&&!(sample.ekfFlags&1024));
      assert(Array.isArray(sample.innovationRatios)&&sample.innovationRatios.length===5&&sample.innovationRatios.every(v=>Number.isFinite(v)&&v>=0&&v<1));
      observed('HEARTBEAT',sample.timeS-sample.heartbeatAgeS,m=>m.custom_mode===sample.mode&&Boolean(m.base_mode&128)===sample.armed);
      observed('GLOBAL_POSITION_INT',sample.timeS-sample.altitudeAgeS,m=>m.relative_alt/1000===sample.autopilotAltitudeM);
      observed('EKF_STATUS_REPORT',sample.timeS-sample.ekfAgeS,m=>m.flags===sample.ekfFlags&&['velocity_variance','pos_horiz_variance','pos_vert_variance','compass_variance','terrain_alt_variance'].every((key,i)=>m[key]===sample.innovationRatios[i]));
      if(sample.stage==='takeoff')assert(sample.altitudeM>=3);
      if(sample.stage==='hold'){
        assert(Math.abs(sample.altitudeM-10)<=1&&Math.abs(sample.autopilotAltitudeM-10)<=1);
        if(holdStart<0)holdStart=sample.timeS;holdEnd=sample.timeS;
        minHoldM=Math.min(minHoldM,sample.altitudeM);maxHoldM=Math.max(maxHoldM,sample.altitudeM);
      }
      previous=sample;
    }
    assert.equal(stage,3);assert(holdEnd-holdStart>=10);assert.equal(previous.armed,false);assert(previous.altitudeM<=0.5);
    assert(run.firstReady&&run.firstReady.timeS>=30);
    metrics={scoredSamples:run.samples.length,holdDurationS:holdEnd-holdStart,minHoldM,maxHoldM};
  }
  const files=['run.json','frame.parm','servo.raw','physics.ndjson','telemetry.ndjson','mavlink.raw','tx.raw','mavlink-audit.json','firmware.log'];
  if(scriptFor(frame))files.push('frame.lua');
  return {schemaVersion:1,task:'TASK-128',status:'PASS',validatorSha256:sha(readFileSync(fileURLToPath(import.meta.url))),frameId:frame.id,phase:run.phase,
    scope:'Native stock frame/output feasibility with a synthetic reference; no measured or coaxial fidelity admission',
    firmwareSha256:run.firmwareSha256,sourceCommit:run.sourceCommit,sourceInputs:run.sourceInputs,
    host:run.host,servoPacketChannels:frame.servoPacketChannels,physicsFrames:count,simS:run.timeS,wallS:run.wallS,
    metrics,maxPositionErrorM,maxQuaternionError,stats:run.stats,
    artifacts:files.map(file=>({file,sha256:sha(read(file)),bytes:statSync(join(directory,file)).size}))};
}
function scriptFor(frame){return frame.kind==='stock-scripting';}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [flag,input,outFlag,output]=process.argv.slice(2);
  if(flag!=='--input'||!input||outFlag!=='--output'||!output||process.argv.length!==6)throw Error('Expected --input CAPTURE --output REPORT');
  const report=auditFrameCapture(input);writeFileSync(resolve(output),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,frameId:report.frameId,phase:report.phase,physicsFrames:report.physicsFrames,metrics:report.metrics}));
}
