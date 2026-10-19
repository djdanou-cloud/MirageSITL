// Replay actual native sensor acknowledgments and CRC-checked MAVLink through
// the same admission modules. Fault probes below are explicitly synthetic.
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {LiveEkfWarmup} from '../packages/autopilot/src/live-warmup.ts';
import {definition,encodeInto} from '../packages/mavlink/src/codec.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--input')throw Error('Expected --input CAPTURE_DIRECTORY');
const directory=resolve(args[1]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>{
  const path=join(directory,file);
  if(statSync(path).size>32*1024*1024)throw Error('Warmup input exceeds budget');
  return readFileSync(path);
};
const lines=file=>read(file).toString().trim().split('\n').map(line=>JSON.parse(line));
const run=JSON.parse(read('run.json')),rawAudit=JSON.parse(read('mavlink-audit.json'));
assert.equal(run.status,'captured');assert.equal(run.warmup.imuSource,'json-lockstep');
assert.equal(rawAudit.status,'PASS');assert.equal(rawAudit.rawSha256,sha(read('mavlink.raw')));
assert.equal(rawAudit.decodedSha256,sha(read('telemetry.ndjson')));
assert.equal(rawAudit.generatorSha256,sha(readFileSync(join(root,'scripts/sitl/check-raw.py'))));
for(const entry of run.sourceInputs) {
  assert(typeof entry.file==='string'&&!entry.file.includes('..')&&!entry.file.startsWith('/')&&!entry.file.includes(':')&&!entry.file.includes('\\'));
  assert.equal(sha(readFileSync(join(root,entry.file))),entry.sha256,entry.file);
}
const events=lines('telemetry.ndjson'),physics=lines('physics.ndjson'),observations=lines('warmup.ndjson');
assert.equal(events.length,rawAudit.recordedObservations);assert.equal(physics.length,run.stats.steps);
assert.equal(events.length,rawAudit.wireFramesChecked);
const gate=new LiveEkfWarmup('external-sitl',1,0,0,2,{imuSource:'json-lockstep'});
let eventIndex=0,rowIndex=0,firstReady=null,revocations=0,lastReady=false;
const selected=new Set(['HEARTBEAT','EKF_STATUS_REPORT','HIGHRES_IMU','RAW_IMU','GPS_RAW_INT']);
for(let i=0;i<physics.length;i++) {
  const p=physics[i];assert.equal(p.servoFrame,i);assert(Math.abs(p.timeS-(i+1)/800)<1e-9);
  while(eventIndex<events.length&&events[eventIndex].receivedSimS<p.timeS) {
    const event=events[eventIndex++];
    if(selected.has(event.message.mavpackettype))gate.ingest(Buffer.from(event.wireHex,'hex'),event.receivedSimS);
  }
  if(i>0)assert.equal(gate.acknowledgeJsonImu(i,i-1,physics[i-1].timeS),true);
  const row=observations[rowIndex];
  if(!row||row.servoFrame!==i)continue;
  rowIndex++;
  assert.equal(row.timeS,p.timeS);assert.equal(row.acknowledgedReplyFrame,i-1);assert.equal(row.imuSource,'json-lockstep');
  assert.equal(gate.observe(row.timeS,row.wallTimeMs),row.ready);
  assert.equal(gate.warmup.ewAllowed,row.ewAllowed);assert.equal(row.ready,row.ewAllowed);
  assert.equal(row.imuTimeS,gate.imuTimeS);assert.equal(row.reportedImuTimeS,gate.reportedImuTimeS);assert.equal(row.gpsTimeS,gate.gpsTimeS);
  const expectedHealth=gate.monitor.snapshot(row.timeS*1000);
  // Before the first diagnostic, infinite/unknown age is serialized as null.
  assert.equal(row.reason,gate.warmup.reason);assert.deepEqual(row.health,{...expectedHealth,ageMs:Number.isFinite(expectedHealth.ageMs)?expectedHealth.ageMs:null});
  assert(Math.abs(row.accelerationFactor-gate.warmup.accelerationFactor)<1e-12);
  if(row.ready) {
    assert(row.timeS>=30);assert(row.timeS-row.imuTimeS<=0.01);assert(row.timeS-row.gpsTimeS<=0.3);
    if(firstReady===null)firstReady=row;
  }
  if(lastReady&&!row.ready)revocations++;
  lastReady=row.ready;
}
assert.equal(rowIndex,observations.length);assert(firstReady,'Native gate never became ready');
assert.equal(gate.parser.badCrc,0);assert.equal(run.warmup.firstReady.timeS,firstReady.timeS);
assert.equal(run.warmup.disposedReady,false);assert.equal(run.warmup.disposedEwAllowed,false);
gate.dispose();assert.equal(gate.warmup.ewAllowed,false);
const seed=firstReady;
function freshProbe(backend='external-sitl') {
  const probe=new LiveEkfWarmup(backend,1,0,0,backend==='hitl'?1:2,backend==='hitl'?{}:{imuSource:'json-lockstep'});
  for(const event of events)if(event.receivedSimS<seed.timeS&&selected.has(event.message.mavpackettype))probe.ingest(Buffer.from(event.wireHex,'hex'),event.receivedSimS);
  if(backend==='external-sitl') {
    assert.equal(probe.acknowledgeJsonImu(seed.servoFrame,seed.servoFrame-1,seed.imuTimeS),true);
    assert.equal(probe.observe(seed.timeS,seed.wallTimeMs),true);
  }
  return probe;
}
function injectedWire(id,mutate) {
  const event=events.filter(e=>e.receivedSimS<seed.timeS&&Number.parseInt(e.wireHex.slice(14,16),16)===id).at(-1);
  assert(event,'Missing native wire source for probe');
  const source=Buffer.from(event.wireHex,'hex'),d=definition(id);assert(d);
  const payload=new Uint8Array(d.length);payload.set(source.subarray(10,10+source[1]));mutate(new DataView(payload.buffer));
  const out=new Uint8Array(280),count=encodeInto(id,payload,(source[4]+1)%256,1,1,out);assert(count>0);
  return out.subarray(0,count);
}
const probes=[];
function rejected(name,probe,sim=seed.timeS,wall=seed.wallTimeMs) {
  assert.equal(probe.observe(sim,wall),false);assert.equal(probe.warmup.ewAllowed,false);
  probes.push({name,kind:'synthetic-rejection-probe',ready:false,ewAllowed:false,reason:probe.warmup.reason});
}
const broken=freshProbe();assert.equal(broken.acknowledgeJsonImu(seed.servoFrame+2,seed.servoFrame,seed.timeS),false);rejected('noncausal IMU acknowledgment',broken);
const failed=freshProbe();failed.ingest(injectedWire(193,v=>v.setFloat32(0,1,true)),seed.timeS);rejected('failed innovation',failed);
const noFix=freshProbe();noFix.ingest(injectedWire(24,v=>v.setUint8(28,1)),seed.timeS);rejected('lost GNSS fix',noFix);
const stale=freshProbe(),later=seed.timeS+1.1;
for(let n=1;n<=880;n++)assert(stale.acknowledgeJsonImu(seed.servoFrame+n,seed.servoFrame+n-1,seed.imuTimeS+n/800));
stale.ingest(injectedWire(24,v=>{v.setUint32(0,Math.floor(later*1e6),true);v.setUint32(4,0,true);}),later);
rejected('stale heartbeat/EKF with fresh sensors',stale,later,seed.wallTimeMs+1100);
rejected('clock reversal',freshProbe(),seed.timeS-0.1,seed.wallTimeMs);
rejected('HITL observed fast-forward replay (no physical hardware)',freshProbe('hitl'));
const disposed=freshProbe();disposed.dispose();rejected('disposed session',disposed);
const after=observations.filter(r=>r.timeS>=seed.timeS),readyRows=after.filter(r=>r.ready).length;
const report={schemaVersion:1,task:'TASK-043',status:'PASS',scope:'Native external-SITL admission and replay; browser READY/EW application and physical HITL remain separate',
  validatorSha256:sha(readFileSync(fileURLToPath(import.meta.url))),firstReady:seed,
  metrics:{physicsFrames:physics.length,observations:observations.length,readyRowsAfterAdmission:readyRows,rowsAfterAdmission:after.length,
    observedRevocations:revocations,accelerationFactorAtAdmission:seed.accelerationFactor,finalAccelerationFactor:observations.at(-1).accelerationFactor},
  imuClock:{source:'acknowledged-json-lockstep-sample',firmwareReportClockRecordedSeparately:true,maximumAgeS:0.01},
  gpsClock:{source:'CRC-checked GPS_RAW_INT last_fix_time_ms',maximumAgeS:0.3},probes,
  sourceInputs:run.sourceInputs,artifacts:['run.json','warmup.ndjson','physics.ndjson','telemetry.ndjson','mavlink.raw','mavlink-audit.json','flight.json'].map(file=>({file:relative(root,join(directory,file)).replaceAll('\\','/'),sha256:sha(read(file))}))};
writeFileSync(join(root,'test-results/validation/task-043-warmup.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Live READY at ${seed.timeS}s; measured acceleration ${seed.accelerationFactor.toFixed(3)}x; ${probes.length} synthetic revocation probes rejected`);
