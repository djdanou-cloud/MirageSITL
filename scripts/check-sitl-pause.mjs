// Cold TASK-129 audit against original PWM, physics replies, telemetry and outgoing bytes.
import assert from 'node:assert/strict';
import {readFileSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {MultirotorReference,frameParameters,referenceConfiguration} from './sitl/multirotor.mjs';
import {PAUSE_CONTRACT} from './sitl/pause-probe.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex');
export function assessPauseWindow(pause,physics,replies,duplicates,events,outgoing){
 assert(['ground','hover'].includes(pause.kind));
 assert(pause.durationMs>=60000&&pause.durationMs<=65000);
 assert(Math.abs(pause.endWallMs-pause.startWallMs-pause.durationMs)<2);
 assert.deepEqual(pause.before,pause.after,'Paused truth changed');
 assert.equal(pause.bridgeOpen,true);assert(pause.bridgePingCount>=55);
 assert(Number.isSafeInteger(pause.servoFrame)&&pause.servoFrame>0);
 const previous=physics[pause.servoFrame-1],next=physics[pause.servoFrame];
 assert.equal(previous.timeS,pause.timeS);assert.equal(next.timeS,(pause.servoFrame+1)/800);
 for(const key of ['positionNedM','velocityNedMps','quaternionWxyz'])assert.deepEqual(previous[key],pause.before[key]);
 assert(previous.wallTimeMs<=pause.startWallMs&&next.wallTimeMs>=pause.endWallMs-2);
 assert(!physics.some(row=>row.wallTimeMs>pause.startWallMs&&row.wallTimeMs<pause.endWallMs-2),'Physics advanced during pause');
 assert(!replies.some(row=>row.wallTimeMs>pause.startWallMs&&row.wallTimeMs<pause.endWallMs-2),'Physics reply was sent while paused');
 const held=duplicates.filter(row=>row.kind===pause.kind);
 assert.equal(held.length,pause.repeatedFrames+1);assert(held.length>=40,'Missing repeated frozen servo packets');
 assert(held.every(row=>row.hex===held[0].hex));
 const packet=Buffer.from(held[0].hex,'hex');assert.equal(packet.readUInt32LE(4),pause.servoFrame);
 assert(held.at(-1).wallTimeMs-held[0].wallTimeMs>=58000);
 const settled=events.filter(row=>row.wallTimeMs>=pause.startWallMs+1000&&row.wallTimeMs<=pause.endWallMs);
 // The stock main scheduler is blocked. Drained messages may arrive just after hold starts.
 assert.equal(settled.length,0,'Firmware continued scheduler telemetry during settled pause');
 const writes=outgoing.filter(row=>row.message.mavpackettype==='PARAM_SET'&&row.message.param_value===11);
 const write=writes[pause.kind==='ground'?0:1];assert(write,'Missing original paused parameter write');
 const traffic=outgoing.filter(row=>row.wallMonotonicS>=write.wallMonotonicS+1&&row.wallMonotonicS<=write.wallMonotonicS+59);
 const counts={};
 for(const kind of ['HEARTBEAT','RC_CHANNELS_OVERRIDE']){
  const rows=traffic.filter(row=>row.message.mavpackettype===kind);
  assert(rows.length>=200,'RC/GCS traffic stopped during hold');
  for(let i=1;i<rows.length;i++)assert(rows[i].wallMonotonicS-rows[i-1].wallMonotonicS<=0.5);
  if(kind==='RC_CHANNELS_OVERRIDE')assert(rows.every(row=>row.message.chan1_raw===1500&&row.message.chan3_raw===1000));
  counts[kind]=rows.length;
 }
 const paramReplies=events.filter(row=>row.message.mavpackettype==='PARAM_VALUE'&&row.message.param_id==='WP_SPD'&&row.message.param_value===11&&row.wallTimeMs>pause.endWallMs&&row.receivedSimS<=pause.timeS+1);
 assert(paramReplies.length,'Queued parameter change did not respond after resume');
 const clocks=events.filter(row=>row.message.mavpackettype==='SYSTEM_TIME');
 const before=clocks.filter(row=>row.wallTimeMs<=pause.startWallMs).at(-1),after=clocks.find(row=>row.wallTimeMs>=pause.endWallMs);
 assert(before&&after,'Missing autopilot clock around pause');
 const clockDeltaS=(after.message.time_boot_ms-before.message.time_boot_ms)/1000;
 assert(clockDeltaS>=0&&clockDeltaS<=1,'Autopilot clock advanced with paused wall time');
 return {kind:pause.kind,durationS:pause.durationMs/1000,simS:pause.timeS,repeatedFrames:pause.repeatedFrames,
  bridgePings:pause.bridgePingCount,settledTelemetry:0,parameterAccess:'deferred until resume',traffic:counts,autopilotClockDeltaS:clockDeltaS};
}
export function auditPauseCapture(input){
 const directory=resolve(input),artifacts=[];
 const read=name=>{const path=join(directory,name);assert(statSync(path).size<=64*1024*1024);const b=readFileSync(path);artifacts.push({file:name,sha256:sha(b),bytes:b.length});return b;};
 const run=JSON.parse(read('run.json'));
 assert.equal(run.task,'TASK-129');assert.equal(run.schemaVersion,1);assert.equal(run.status,'captured');
 assert.deepEqual(run.contract,PAUSE_CONTRACT);assert.equal(run.frameId,'quad-x');assert.equal(run.phase,'flight');
 assert.deepEqual(run.configuration,referenceConfiguration('quad-x'));
 assert.equal(run.host.platform,'darwin');assert.equal(run.host.architecture,'arm64');assert.equal(run.nativeBinary.format,'mach-o64');
 assert.equal(run.sourceCommit,'8ab6afde107a91df1b5f60ade8f333cb8a61b190');
 for(const source of run.sourceInputs){assert(!source.file.includes('..')&&!source.file.startsWith('/'));assert.equal(sha(readFileSync(join(root,source.file))),source.sha256,`Source changed: ${source.file}`);}
 assert.equal(read('frame.parm').toString(),frameParameters('quad-x')+'LOG_DISARMED 1\n');
 const expected={AHRS_EKF_TYPE:3,EK3_ENABLE:1,WP_SPD:10};
 for(const line of (frameParameters('quad-x')+'LOG_DISARMED 1\n').trim().split('\n')){const [key,value]=line.split(' ');expected[key]=Number(value);}
 assert.deepEqual(run.frameExpectedParameters,expected);
 for(const [key,value]of Object.entries(expected))assert.equal(run.parameterValues[key],value);
 const wire=JSON.parse(read('mavlink-audit.json'));
 assert.equal(wire.task,'TASK-129');assert.equal(wire.status,'PASS');assert.equal(wire.pymavlink,'2.4.50');
 assert.equal(wire.validatorSha256,sha(readFileSync(join(root,'scripts/sitl/check-pause-raw.py'))));
 for(const [file,key]of [['mavlink.raw','rawSha256'],['tx.raw','outboundSha256'],['telemetry.ndjson','decodedSha256'],['tx.ndjson','txEventsSha256']])assert.equal(sha(read(file)),wire[key]);
 for(const item of wire.dataflash)assert.equal(sha(read(item.file)),item.sha256);
 const physics=read('physics.ndjson').toString().trim().split('\n').map(JSON.parse);
 const replies=read('replies.ndjson').toString().trim().split('\n').map(JSON.parse);
 const servo=read('servo.raw'),count=run.stats.steps;
 assert(Number.isSafeInteger(count)&&count>0&&count<=96000);assert.equal(physics.length,count);assert.equal(replies.length,count);assert.equal(servo.length,count*40);
 assert.equal(run.timeS,count/800);assert(run.wallS>0&&run.wallS<=300);
 for(const key of ['duplicates','gaps','droppedFrames','restarts','stale','invalid','repliesResent'])assert.equal(run.stats[key],0,key);
 const wasm=readFileSync(join(root,'packages/wasm-bet/dist/mirage_bet.scalar.wasm'));assert.equal(sha(wasm),run.wasmSha256);
 const model=new MultirotorReference(new WebAssembly.Instance(new WebAssembly.Module(wasm),{}),'quad-x'),u=new Float64Array(4);
 let maxError=0;
 for(let i=0;i<count;i++){
  assert.equal(servo.readUInt16LE(i*40),18458);assert.equal(servo.readUInt32LE(i*40+4),i);
  const rate=servo.readUInt16LE(i*40+2);assert([799,800].includes(rate)||i===0&&rate===1200);
  for(let m=0;m<4;m++)u[m]=Math.max(0,Math.min(1,(servo.readUInt16LE(i*40+8+2*m)-1000)/1000));
  model.step(u,1/800);const row=physics[i];assert.equal(row.timeS,(i+1)/800);assert.equal(row.servoFrame,i);
  assert.equal(replies[i].servoFrame,i);const response=JSON.parse(Buffer.from(replies[i].hex,'hex').toString());
  assert.equal(response.timestamp,row.timeS);assert.equal(response.no_lockstep,undefined,'Non-lockstep physics cannot satisfy pause');
  for(const [key,value,wireKey]of [['positionNedM',model.truth.positionNedM,'position'],['velocityNedMps',model.truth.velocityNedMps,'velocity'],['quaternionWxyz',model.truth.quaternionBodyToNed,'quaternion']]){
   let sign=1;if(key==='quaternionWxyz'&&row[key].reduce((n,x,j)=>n+x*value[j],0)<0)sign=-1;
   assert(Array.isArray(row[key])&&row[key].length===value.length);
   for(let j=0;j<value.length;j++){const e=Math.abs(row[key][j]*sign-value[j]);assert(e<=1e-10);maxError=Math.max(maxError,e);assert(Math.abs(response[wireKey][j]-row[key][j])<=0.5e-9+1e-14,'Reply differs beyond existing nine-decimal codec quantization');}
  }
 }
 const events=read('telemetry.ndjson').toString().trim().split('\n').map(JSON.parse);assert.equal(events.length,wire.observations);
 const duplicates=read('pause-servo.ndjson').toString().trim().split('\n').filter(Boolean).map(JSON.parse);
 assert.equal(run.pauses.length,run.withPauses?2:0);assert.equal(wire.ekfWindows.length,run.pauses.length);
 if(run.withPauses)assert.deepEqual(run.pauses.map(p=>p.kind),['ground','hover']);
 const pauses=run.pauses.map(p=>assessPauseWindow(p,physics,replies,duplicates,events,wire.outgoing));
 for(const p of run.pauses)assert(servo.subarray(p.servoFrame*40,(p.servoFrame+1)*40).equals(Buffer.from(duplicates.find(d=>d.kind===p.kind).hex,'hex')));
 const byType=type=>events.filter(e=>e.message.mavpackettype===type);
 const observation=(type,timeS,predicate)=>assert(byType(type).some(e=>Math.abs(e.receivedSimS-timeS)<1e-9&&predicate(e.message)),`Missing original ${type}`);
 let previous=null,holdStart=null,holdEnd=null,stage=0;
 const stages=['arm','takeoff','hold','land'];
 for(const sample of run.samples){
  assert.equal(sample.stage===stages[stage]||sample.stage===stages[stage+1],true);if(sample.stage!==stages[stage])stage++;
  const row=physics[sample.servoFrame];assert.equal(sample.timeS,row.timeS);assert(sample.altitudeM===-row.positionNedM[2]);
  if(previous)assert.equal(sample.servoFrame-previous.servoFrame,8);assert.equal(sample.servoFrame%8,0);
  assert.equal(sample.mode,sample.stage==='land'?9:4);if(sample.stage!=='land')assert(sample.armed);
  assert((sample.ekfFlags&55)===55&&!(sample.ekfFlags&1024));assert(sample.innovationRatios.every(v=>Number.isFinite(v)&&v>=0&&v<1));
  for(const key of ['heartbeatAgeS','ekfAgeS','altitudeAgeS'])assert(sample[key]>=0&&sample[key]<=1);
  observation('HEARTBEAT',sample.timeS-sample.heartbeatAgeS,m=>m.custom_mode===sample.mode&&Boolean(m.base_mode&128)===sample.armed);
  observation('EKF_STATUS_REPORT',sample.timeS-sample.ekfAgeS,m=>m.flags===sample.ekfFlags);
  observation('GLOBAL_POSITION_INT',sample.timeS-sample.altitudeAgeS,m=>m.relative_alt/1000===sample.autopilotAltitudeM);
  if(sample.stage==='takeoff')assert(sample.altitudeM>=3);
  if(sample.stage==='hold'){assert(Math.abs(sample.altitudeM-10)<=1&&Math.abs(sample.autopilotAltitudeM-10)<=1);holdStart??=sample.timeS;holdEnd=sample.timeS;}
  previous=sample;
 }
 assert.equal(stage,3);assert.equal(previous.armed,false);assert(previous.altitudeM<=0.5);assert(holdEnd-holdStart>=10);
 if(run.withPauses){const hover=run.pauses[1];assert(holdEnd-hover.timeS>=10,'Insufficient post-resume hover');}
 const postGround=run.withPauses?run.pauses[0].timeS:run.firstReady.timeS;
 const faultTexts=events.filter(e=>e.receivedSimS>=postGround&&e.message.mavpackettype==='STATUSTEXT'&&/failsafe|EKF.*(reset|unhealthy|lane switch)/i.test(e.message.text));assert.equal(faultTexts.length,0,'Pause induced firmware fault');
 const pausedS=run.pauses.reduce((n,p)=>n+p.durationMs/1000,0),activeWallS=run.wallS-pausedS;
 return {schemaVersion:1,task:'TASK-129',status:'PASS',sourceCommit:run.sourceCommit,firmwareSha256:run.firmwareSha256,host:run.host,sourceInputs:run.sourceInputs,
  validatorSha256:sha(readFileSync(fileURLToPath(import.meta.url))),physicsFrames:count,simS:run.timeS,wallS:run.wallS,pausedS,activeWallS,
  requestedSpeedup:run.speedup,achievedSpeedup:run.timeS/activeWallS,maxReplayError:maxError,scoredSamples:run.samples.length,holdDurationS:holdEnd-holdStart,pauses,ekfWindows:wire.ekfWindows,artifacts};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [flag,input,outFlag,output]=process.argv.slice(2);if(flag!=='--input'||!input||outFlag!=='--output'||!output)throw Error('Expected --input CAPTURE --output REPORT');
 const report=auditPauseCapture(input);writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,artifacts:undefined,sourceInputs:undefined}));
}
