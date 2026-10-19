import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,hash,finite} from '../validation/evidence.mjs';
import {QuadReference,configuration} from './quad.mjs';
import {EwObservations,PLAN} from './ew-observations.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const read=(dir,file)=>{
  const path=join(dir,file);if(statSync(path).size>64*1024*1024)throw Error('Capture file exceeds budget');
  return readFileSync(path);
};
const json=(dir,file)=>JSON.parse(read(dir,file));
const lines=(dir,file)=>read(dir,file).toString().trim().split('\n').map(line=>JSON.parse(line));
const fields=['velocity_variance','pos_horiz_variance','pos_vert_variance','compass_variance','terrain_alt_variance'];
const truthHash=t=>sha256(Buffer.concat([Buffer.from(t.positionNedM.buffer),Buffer.from(t.velocityNedMps.buffer),Buffer.from(t.quaternionBodyToNed.buffer)]));

/** Reconstruct observations and physics from actual PWM; join original firmware telemetry. */
export async function auditEwCapture(directory) {
  if(!process.env.MIRAGE_SITL_PYTHON)throw Error('Native EW audit requires pinned pymavlink Python');
  // Re-run the decoder: an edited receipt/hash cannot bless edited telemetry.
  execFileSync(process.env.MIRAGE_SITL_PYTHON,[join(root,'scripts/sitl/check-ew.py'),'--input',directory],{timeout:30000,maxBuffer:1024*1024});
  const run=json(directory,'run.json'),flight=json(directory,'flight.json'),wire=json(directory,'ew-wire-audit.json');
  if(run.status!=='captured'||wire.status!=='PASS')throw Error('Incomplete native EW acquisition/audit');
  if(wire.auditorSha256!==sha256(readFileSync(join(root,'scripts/sitl/check-ew.py'))))throw Error('Wire auditor identity mismatch');
  for(const [file,expected] of Object.entries(wire.inputs))if(sha256(read(directory,file))!==expected)throw Error(`Wire audit input changed: ${file}`);
  for(const input of run.sourceInputs)if(sha256(readFileSync(join(root,input.file)))!==input.sha256)throw Error(`Native source changed: ${input.file}`);
  const e=run.experiment;
  assert.deepEqual(e.plan,PLAN);
  const ew=new EwObservations(e.caseId);
  if(!(e.faultStart>30)||!(e.faultEnd>e.faultStart)||!(e.experimentEnd>=e.faultEnd)||!run.warmup.firstReady||
    run.warmup.firstReady.timeS>=e.faultStart||run.warmup.disposedReady||run.warmup.disposedEwAllowed||
    run.stats.gaps||run.stats.restarts||run.stats.invalid||run.stats.stale||run.stats.droppedFrames)throw Error('Bad acquisition/admission lifecycle');
  assert(Math.abs(e.faultEnd-e.faultStart-(e.caseId==='motor-loss'?PLAN.motorExposureS:PLAN.exposureS))<1e-9);
  assert(Math.abs(e.experimentEnd-e.faultEnd-(e.caseId==='motor-loss'?0:PLAN.recoveryS))<1e-9);
  const wasm=readFileSync(join(root,'packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  assert.equal(sha256(wasm),run.wasmSha256);
  assert.deepEqual(run.configuration,configuration);
  assert.equal(flight.provenance.modelSha256,sha256(Buffer.concat([readFileSync(join(root,'scripts/sitl/quad.mjs')),wasm,Buffer.from(JSON.stringify(configuration))])));
  const {instance}=await WebAssembly.instantiate(wasm,{}),quad=new QuadReference(instance);
  const physics=lines(directory,'physics.ndjson'),observations=lines(directory,'observations.ndjson');
  if(physics.length!==run.stats.steps||physics.length>100000||observations.length!==wire.gpsInputFrames)throw Error('Incomplete physics/observations');
  let oi=0,sourceChanged=false;
  const throttles=new Float64Array(4),truthAtSample=new Map();
  for(let frame=0;frame<physics.length;frame++) {
    const p=physics[frame],timeS=(frame+1)/800;
    if(p.servoFrame!==frame||p.timeS!==timeS||p.pwmUs.length!==4||p.pwmUs.some(v=>!Number.isInteger(v)||v<0||v>2000))throw Error('Invalid PWM frame/time');
    const prior=frame/800;
    if(prior>=e.faultStart&&prior<e.faultEnd&&!ew.active)ew.setActive(true,frame);
    if(prior>=e.faultEnd&&ew.active&&e.caseId!=='motor-loss')ew.setActive(false,frame);
    for(let m=0;m<4;m++)throttles[m]=Math.max(0,Math.min(1,(p.pwmUs[m]-1000)/1000));
    quad.step(throttles,1/800,ew.thrustFractions);ew.advance(timeS);
    assert.deepEqual(p.positionNedM,Array.from(quad.truth.positionNedM));
    assert.deepEqual(p.quaternion,Array.from(quad.truth.quaternionBodyToNed));
    if(frame%80===0) {
      const observation=observations[oi++],before=truthHash(quad.truth);
      ew.sample(timeS,quad.truth.positionNedM,quad.truth.velocityNedMps);
      assert.equal(observation.servoFrame,frame);assert.equal(observation.timeS,timeS);
      assert.equal(observation.truthBefore,before);assert.equal(observation.truthAfter,before);
      assert.equal(truthHash(quad.truth),before);
      assert.deepEqual(observation.baseline,ew.gps);assert.deepEqual(observation.command.gps,ew.distorted);
      sourceChanged ||= JSON.stringify(ew.gps)!==JSON.stringify(ew.distorted);
    }
    if(frame%8===0&&timeS>e.faultStart)truthAtSample.set(frame,{position:Array.from(quad.truth.positionNedM),velocity:Array.from(quad.truth.velocityNedMps)});
  }
  if(oi!==observations.length)throw Error('Unconsumed observations');
  // Actual compass parameters must be acknowledged, on every enabled receiver.
  const telemetry=lines(directory,'telemetry.ndjson');
  const wantedOffset=e.caseId==='magnetic'?[-300,-200,0]:[0,0,0];
  for(let compass=1;compass<=3;compass++)for(let axis=0;axis<3;axis++) {
    const name=`SIM_MAG${compass}_OFS_${'XYZ'[axis]}`;
    const values=telemetry.filter(r=>r.message.mavpackettype==='PARAM_VALUE'&&r.message.param_id===name);
    if(!values.some(r=>r.message.param_value===0&&r.receivedSimS<e.faultStart))throw Error('Missing baseline compass readback');
    if(e.caseId==='magnetic'&&!values.some(r=>r.message.param_value===wantedOffset[axis]&&r.receivedSimS>=e.faultStart&&r.receivedSimS<e.faultStart+1))throw Error('Missing magnetic fault parameter acknowledgment');
    if(e.caseId==='magnetic'&&!values.some(r=>r.message.param_value===0&&r.receivedSimS>=e.faultEnd&&r.receivedSimS<e.faultEnd+1))throw Error('Missing magnetic recovery acknowledgment');
  }
  if(e.caseId==='motor-loss'||e.caseId==='magnetic')sourceChanged=true; // proven by replayed wrench / CRC-checked compass readbacks
  if(sourceChanged!==(e.caseId!=='control'))throw Error('Required observation/actuator effect not delivered');
  // AP_GPS_MAV must publish the injected receiver, including denial during jamming.
  const gpsReports=telemetry.filter(r=>r.message.mavpackettype==='GPS_RAW_INT');
  if(gpsReports.length<100||!gpsReports.some(r=>r.receivedSimS<e.faultStart&&r.message.fix_type===3))throw Error('Missing firmware GPS readback');
  if(e.caseId==='jamming'&&!gpsReports.some(r=>r.receivedSimS>e.faultStart+1&&r.receivedSimS<e.faultEnd&&r.message.fix_type===0))throw Error('Firmware did not observe GPS denial');
  const samples=flight.samples;
  if(samples.length!==truthAtSample.size||samples.length<100)throw Error('Incomplete EKF response window');
  let ti=0,heartbeat=null,ekf=null,global=null,maxError=0,maxInnovation=0,maxTruthDistance=0,unhealthyRows=0;
  const modes=new Set(),flags=new Set();
  for(const s of samples) {
    const truth=truthAtSample.get(s.servoFrame);if(!truth)throw Error('Response frame outside window');
    assert.deepEqual(s.truthNedM,truth.position);assert.deepEqual(s.velocityNedMps,truth.velocity);
    while(ti<telemetry.length&&telemetry[ti].receivedSimS<s.timeS) {
      const r=telemetry[ti++];
      if(r.message.mavpackettype==='HEARTBEAT')heartbeat=r;
      if(r.message.mavpackettype==='EKF_STATUS_REPORT')ekf=r;
      if(r.message.mavpackettype==='GLOBAL_POSITION_INT')global=r;
    }
    if(!heartbeat||!ekf||!global)throw Error('Missing actual firmware response');
    assert.equal(s.mode,heartbeat.message.custom_mode);assert.equal(s.armed,Boolean(heartbeat.message.base_mode&128));
    assert.equal(s.ekfFlags,ekf.message.flags);assert.deepEqual(s.innovationRatios,fields.map(k=>ekf.message[k]));
    for(const [key,r] of [['heartbeatAgeS',heartbeat],['ekfAgeS',ekf],['positionAgeS',global]]) {
      assert.equal(s[key],s.timeS-r.receivedSimS);finite(s[key],0,1);
    }
    assert.deepEqual(s.autopilotPosition,{lat:global.message.lat,lon:global.message.lon,alt:global.message.alt,relative_alt:global.message.relative_alt});
    const estimate=new Float64Array(3);
    ew.frame.geodeticToNedInto(global.message.lat/1e7*Math.PI/180,global.message.lon/1e7*Math.PI/180,global.message.alt/1000,estimate);
    maxError=Math.max(maxError,Math.hypot(...truth.position.map((v,i)=>v-estimate[i])));
    maxTruthDistance=Math.max(maxTruthDistance,Math.hypot(truth.position[0],truth.position[1],truth.position[2]+10));
    for(const v of s.innovationRatios)maxInnovation=Math.max(maxInnovation,finite(v,0,10000));
    modes.add(s.mode);flags.add(s.ekfFlags);
    if((s.ekfFlags&55)!==55||(s.ekfFlags&1024)||s.innovationRatios.some(v=>v>=1))unhealthyRows++;
  }
  if(samples.at(-1).timeS<e.experimentEnd)throw Error('Truncated exposure/recovery');
  const parameterSha256=sha256(Buffer.concat([Buffer.from(run.defaultsSha256),readFileSync(join(root,'tests/fixtures/sitl/parameters.parm')),read(directory,'quad.parm')]));
  const artifacts=['run.json','flight.json','physics.ndjson','observations.ndjson','telemetry.ndjson','mavlink.raw','tx.raw','ew-wire-audit.json','quad.parm'];
  const identities=artifacts.map(file=>({file,sha256:sha256(read(directory,file))}));
  if(!hash(flight.provenance.firmwareSha256))throw Error('Missing firmware identity');
  return {id:e.caseId,firmwareSha256:flight.provenance.firmwareSha256,parameterSha256,modelSha256:flight.provenance.modelSha256,
    planSha256:sha256(JSON.stringify(PLAN)),sourceInputs:run.sourceInputs,artifacts:identities,
    captureSha256:sha256(JSON.stringify(identities)),metrics:{maxPositionErrorM:maxError,maxInnovationRatio:maxInnovation,
      maxTruthDisplacementM:maxTruthDistance,modes:[...modes].sort((a,b)=>a-b),ekfFlags:[...flags].sort((a,b)=>a-b),
      unhealthyRows,samples:samples.length,physicsFrames:physics.length,gpsInputFrames:oi,faultStartS:e.faultStart,
      faultEndS:e.faultEnd,experimentEndS:e.experimentEnd,changedInputs:sourceChanged},
    statusTexts:telemetry.filter(r=>r.message.mavpackettype==='STATUSTEXT'&&r.receivedSimS>=e.faultStart).map(r=>({timeS:r.receivedSimS,text:r.message.text}))};
}
