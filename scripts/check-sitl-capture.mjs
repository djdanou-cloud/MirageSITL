// Cold replay audit: raw physics and decoded real telemetry must support the scored trace.
import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {assessFlight} from './run-sitl.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2);
if(![2,4].includes(args.length)||args[0]!=='--input'||(args.length===4&&args[2]!=='--output'))throw Error('Expected --input CAPTURE_DIRECTORY [--output REPORT_PATH]');
const output=args.length===4?resolve(args[3]):join(root,'test-results/validation/task-042-flight.json');
const directory=resolve(args[1]);
const read=name=>{
  const file=join(directory,name),size=statSync(file).size;
  if(size>32*1024*1024)throw Error(`Capture exceeds file budget: ${name}`);
  return readFileSync(file);
};
const traceBytes=read('flight.json'),trace=JSON.parse(traceBytes),run=JSON.parse(read('run.json'));
const rawAudit=JSON.parse(read('mavlink-audit.json'));
if(rawAudit.status!=='PASS'||rawAudit.pymavlink!=='2.4.50'||rawAudit.rawSha256!==sha(read('mavlink.raw'))||rawAudit.decodedSha256!==sha(read('telemetry.ndjson'))||
  rawAudit.generatorSha256!==sha(readFileSync(join(root,'scripts/sitl/check-raw.py'))))throw Error('Missing or stale raw MAVLink audit');
const verdict=assessFlight(trace);
if(trace.schemaVersion!==2||run.status!=='captured')throw Error('Capture is not a completed native v2 flight');
if(!Array.isArray(run.sourceInputs)||run.sourceInputs.length<10)throw Error('Missing source identities');
for(const entry of run.sourceInputs) {
  if(typeof entry.file!=='string'||entry.file.includes('..')||entry.file.startsWith('/')||entry.file.includes('\\')||entry.file.includes(':')||sha(readFileSync(join(root,entry.file)))!==entry.sha256)throw Error('Source identity changed');
}
for(const key of ['duplicates','gaps','droppedFrames','restarts','stale','invalid','repliesResent'])if(run.stats[key]!==0)throw Error(`Unexpected lockstep counter ${key}`);
const physics=read('physics.ndjson').toString().trim().split('\n').map(line=>JSON.parse(line));
if(physics.length!==run.stats.steps)throw Error('Incomplete full-rate physics capture');
let clamped=0;
for(let i=0;i<physics.length;i++) {
  const p=physics[i];
  if(p.servoFrame!==i||Math.abs(p.timeS-(i+1)/800)>1e-9)throw Error('Full-rate capture gap or timestamp mismatch');
  clamped+=p.pwmUs.filter(pwm=>pwm<1000||pwm>2000).length;
}
if(clamped!==run.stats.clampedPwm)throw Error('Unexplained PWM clamp counter');
const telemetry=read('telemetry.ndjson').toString().trim().split('\n').map(line=>JSON.parse(line));
if(rawAudit.recordedObservations!==telemetry.length||!Number.isSafeInteger(rawAudit.messages)||rawAudit.messages<telemetry.length)throw Error('Inconsistent raw MAVLink audit counts');
const byType=new Map();
for(const event of telemetry) {
  const type=event.message.mavpackettype;
  if(!byType.has(type))byType.set(type,[]);
  byType.get(type).push(event);
}
function observed(type,time,predicate) {
  if(!byType.get(type)?.some(v=>Math.abs(v.receivedSimS-time)<1e-9&&predicate(v.message)))throw Error(`Scored field lacks original telemetry: ${type}`);
}
for(const s of trace.samples) {
  const p=physics[s.servoFrame];
  if(!p||p.timeS!==s.timeS||p.healthy!==s.ekfHealthy||p.armed!==s.armed||p.mode!==s.mode||Math.abs(-p.positionNedM[2]-s.altitudeM)>1e-12||p.pwmUs.some((v,i)=>v!==s.pwmUs[i]))throw Error('Scored sample differs from original physics');
  observed('HEARTBEAT',s.timeS-s.heartbeatAgeS,m=>m.custom_mode===s.mode&&Boolean(m.base_mode&128)===s.armed);
  observed('GLOBAL_POSITION_INT',s.timeS-s.altitudeAgeS,m=>m.relative_alt/1000===s.autopilotAltitudeM);
  observed('EKF_STATUS_REPORT',s.timeS-s.ekfAgeS,m=>m.flags===s.ekfFlags&&
    ['velocity_variance','pos_horiz_variance','pos_vert_variance','compass_variance','terrain_alt_variance'].every((key,i)=>m[key]===s.innovationRatios[i]));
}
const stages=['arm','takeoff','hold','land'].map(stage=>{
  const samples=trace.samples.filter(s=>s.stage===stage);
  return {stage,samples:samples.length,startS:samples[0].timeS,endS:samples.at(-1).timeS,
    minTruthAltitudeM:Math.min(...samples.map(s=>s.altitudeM)),maxTruthAltitudeM:Math.max(...samples.map(s=>s.altitudeM)),
    minAutopilotAltitudeM:Math.min(...samples.map(s=>s.autopilotAltitudeM)),maxAutopilotAltitudeM:Math.max(...samples.map(s=>s.autopilotAltitudeM))};
});
const files=['flight.json','run.json','physics.ndjson','telemetry.ndjson','mavlink.raw','mavlink-audit.json','firmware.log'];
for(const name of readdirSync(join(directory,'dataflash')))files.push('dataflash/'+name);
const report={schemaVersion:1,task:'TASK-042',status:'PASS',scope:'Native ArduCopter JSON/MAVLink integration with synthetic quad and Rust WASM rigid body; not measured aircraft fidelity or browser READY',
  sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),validatorSha256:sha(readFileSync(fileURLToPath(import.meta.url))),
  captureDirectory:relative(root,directory).replaceAll('\\','/'),firmwareSha256:trace.provenance.firmwareSha256,modelSha256:trace.provenance.modelSha256,
  traceFileSha256:sha(traceBytes),driverStdoutSha256:sha(Buffer.from(traceBytes.toString().trimEnd())),
  metrics:{...verdict.metrics,physicsFrames:physics.length,wallS:run.wallS,simS:run.timeS,telemetryEvents:telemetry.length},
  stages,stats:run.stats,sourceInputs:run.sourceInputs,rawMavlinkAudit:rawAudit,runtime:{node:run.node,python:run.python},childExit:run.childExit,
  artifacts:files.map(file=>({file:relative(root,join(directory,file)).replaceAll('\\','/'),sha256:sha(read(file)),bytes:statSync(join(directory,file)).size}))};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(`Verified ${physics.length} actual physics frames, ${trace.samples.length} scored samples and original telemetry; hold=${verdict.metrics.holdDurationS}s`);
