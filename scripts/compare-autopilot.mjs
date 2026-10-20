// Cold TASK-047 analysis. Never changes goldens, thresholds or runtime admission.
import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import Ajv from 'ajv';

const root=fileURLToPath(new URL('../',import.meta.url));
const schema=JSON.parse(readFileSync(new URL('../docs/validation/autopilot-parity.schema.json',import.meta.url)));
const validate=new Ajv({allErrors:true,strict:true}).compile(schema);
export const PARITY_LIMITS=Object.freeze({durationS:30,positionRmseM:0.5,attitudeRmseDeg:2,telemetryMaxAgeS:1,modeTransitionToleranceS:0.5});
const equalKeys=['firmwareCommit','physicsHz','captureStride','seed','airframeSha256','parametersSha256','commandsSha256','sensorSha256'];
const sha=b=>createHash('sha256').update(b).digest('hex');
function assert(condition,message){if(!condition)throw Error(message);}

function checkCapture(capture,backend) {
  assert(validate(capture),'Invalid capture schema: '+JSON.stringify(validate.errors));
  assert(capture.backend===backend,'Wrong backend identity');
  assert(capture.firmwareCommit===JSON.parse(readFileSync(new URL('../native/ardupilot/source.lock.json',import.meta.url))).commit,'Wrong pinned firmware revision');
  assert(capture.physicsHz%capture.captureStride===0&&capture.physicsHz/capture.captureStride>=20,'Capture rate must be an integral >=20 Hz');
  const ids=new Set(capture.scenarios.map(s=>s.id));
  assert(ids.size===2&&capture.scenarios.length===2&&ids.has('takeoff-land')&&ids.has('gcs-failsafe'),'Both distinct flight scenarios required');
  for(const scenario of capture.scenarios) {
    const points=scenario.samples,expected=PARITY_LIMITS.durationS*capture.physicsHz/capture.captureStride+1;
    assert(points.length===expected,'Incomplete 30 s reference');
    assert(scenario.referenceStartTick%capture.captureStride===0,'Reference start must align to capture stride');
    if(scenario.id==='takeoff-land')assert(scenario.failsafeTick===null,'Unexpected failsafe in nominal scenario');
    else assert(Number.isSafeInteger(scenario.failsafeTick)&&scenario.failsafeTick>=scenario.referenceStartTick&&
      scenario.failsafeTick<scenario.referenceStartTick+30*capture.physicsHz,'Failsafe must occur inside reference');
    let flew=false,landed=false;
    for(let i=0;i<points.length;i++) {
      const p=points[i];
      assert(p.tick===scenario.referenceStartTick+i*capture.captureStride,'Missing, duplicate or shifted capture tick');
      const norm=p.quaternionWxyz.reduce((sum,v)=>sum+v*v,0);
      assert(Math.abs(norm-1)<=1e-6,'Non-unit attitude quaternion');
      assert(p.heartbeatAgeS<=PARITY_LIMITS.telemetryMaxAgeS&&p.ekfAgeS<=PARITY_LIMITS.telemetryMaxAgeS,'Stale autopilot telemetry');
      assert((p.ekfFlags&55)===55&&(p.ekfFlags&1024)===0&&p.innovationRatios.every(v=>v<1),'Unhealthy autopilot EKF');
      if(p.armed&&p.mode===4&&-p.positionNedM[2]>=3)flew=true;
      if(flew&&p.mode===9&&(!scenario.failsafeTick||p.tick>=scenario.failsafeTick))landed=true;
    }
    const last=points.at(-1);
    assert(flew&&landed&&!last.armed&&Math.abs(last.positionNedM[2])<=0.5,'Missing armed takeoff, LAND response or completed disarmed landing');
  }
}

/** Samples use common absolute simulation ticks, NED metres and unit wxyz.
 * No alignment by trajectory, interpolation, mean removal or golden rewriting. */
export function compareAutopilot(native,wasm) {
  checkCapture(native,'native');checkCapture(wasm,'wasm');
  for(const key of equalKeys)assert(native[key]===wasm[key],'Unequal scenario input: '+key);
  const reasons=[],scenarios=[];
  for(const a of native.scenarios) {
    const b=wasm.scenarios.find(s=>s.id===a.id);
    assert(a.referenceStartTick===b.referenceStartTick&&a.failsafeTick===b.failsafeTick,'Unequal scenario schedule');
    let positionSum=0,attitudeSum=0,maxModeMismatchS=0,mismatch=0;
    for(let i=0;i<a.samples.length;i++) {
      const x=a.samples[i],y=b.samples[i];let squared=0,dot=0;
      for(let j=0;j<3;j++)squared+=(x.positionNedM[j]-y.positionNedM[j])**2;
      for(let j=0;j<4;j++)dot+=x.quaternionWxyz[j]*y.quaternionWxyz[j];
      // Normalize within the separately validated unit-norm envelope.
      const nx=Math.hypot(...x.quaternionWxyz),ny=Math.hypot(...y.quaternionWxyz);
      const angle=2*Math.acos(Math.min(1,Math.abs(dot/(nx*ny))))*180/Math.PI;
      positionSum+=squared;attitudeSum+=angle*angle;
      if(x.mode!==y.mode||x.armed!==y.armed)mismatch+=native.captureStride/native.physicsHz;else mismatch=0;
      maxModeMismatchS=Math.max(maxModeMismatchS,mismatch);
    }
    const positionRmseM=Math.sqrt(positionSum/a.samples.length),attitudeRmseDeg=Math.sqrt(attitudeSum/a.samples.length);
    if(positionRmseM>PARITY_LIMITS.positionRmseM)reasons.push(a.id+': position RMSE exceeded');
    if(attitudeRmseDeg>PARITY_LIMITS.attitudeRmseDeg)reasons.push(a.id+': attitude RMSE exceeded');
    if(maxModeMismatchS>PARITY_LIMITS.modeTransitionToleranceS)reasons.push(a.id+': mode/arming divergence exceeded');
    scenarios.push({id:a.id,samples:a.samples.length,positionRmseM,attitudeRmseDeg,maxModeMismatchS});
  }
  return {schemaVersion:1,task:'TASK-047',kind:'autopilot-parity',status:reasons.length?'FAIL':'PASS',reasons,limits:PARITY_LIMITS,scenarios};
}

export function runComparison(args) {
  assert(args.length===6&&args[0]==='--native'&&args[2]==='--wasm'&&args[4]==='--output','Expected --native CAPTURE.json --wasm CAPTURE.json --output REPORT.json');
  const inputs=[];
  const read=path=>{const file=resolve(path);assert(statSync(file).size<=64*1024*1024,'Capture exceeds 64 MiB budget');
    const bytes=readFileSync(file);inputs.push({file,sha256:sha(bytes)});return JSON.parse(bytes);};
  const native=read(args[1]),wasm=read(args[3]);
  for(const [bundle,backend] of [[native,'native'],[wasm,'wasm']]) {
    assert(bundle.comparison?.backend===backend&&Array.isArray(bundle.evidence)&&bundle.evidence.length===2,'CLI requires provenance-bound capture bundles');
    const ids=new Set();
    for(const entry of bundle.evidence) {
      assert(!ids.has(entry.id),'Duplicate raw scenario');ids.add(entry.id);
      const captureFile=resolve(entry.captureFile),auditFile=resolve(entry.auditFile);
      const rawBytes=readFileSync(captureFile),auditBytes=readFileSync(auditFile);
      assert(rawBytes.length<=64*1024*1024&&auditBytes.length<=4*1024*1024,'Raw evidence exceeds budget');
      assert(sha(rawBytes)===entry.captureSha256&&sha(auditBytes)===entry.auditSha256,'Raw evidence hash mismatch');
      inputs.push({file:captureFile,sha256:sha(rawBytes)},{file:auditFile,sha256:sha(auditBytes)});
      const envelope=JSON.parse(rawBytes),audit=JSON.parse(auditBytes),capture=envelope.capture??envelope;
      assert(audit.status==='PASS'&&audit.kind==='autopilot-parity-wire'&&audit.pymavlink==='2.4.50'&&audit.scoredSamples===3001&&
        audit.captureSha256===sha(rawBytes)&&audit.rawSha256===sha(Buffer.from(capture.raw))&&
        audit.auditorSha256===sha(readFileSync(resolve(root,'scripts/sitl/check-parity-wire.py'))),'Missing/stale independent wire audit');
      assert(envelope.caseId===entry.id,'Raw scenario identity differs');
      assert(Array.isArray(envelope.identity?.sourceInputs)&&envelope.identity.sourceInputs.length>=30,'Missing capture source identities');
      for(const source of envelope.identity.sourceInputs) {
        assert(typeof source.file==='string'&&!source.file.includes('..')&&!/[:\\]/.test(source.file)&&!source.file.startsWith('/'),'Unsafe source path');
        assert(sha(readFileSync(resolve(root,source.file)))===source.sha256,'Capture source changed: '+source.file);
      }
      assert(sha(readFileSync(resolve(root,'packages/wasm-bet/dist/mirage_bet.scalar.wasm')))===envelope.identity.bodyWasmSha256,'Physics artifact changed');
      assert(sha(envelope.defaultsText)===envelope.identity.parametersSha256,'Startup parameter bytes changed');
      for(const key of equalKeys)assert(bundle.comparison[key]===envelope.identity[key],'Bundle input identity differs: '+key);
      const expected=capture.samples.filter(p=>p.tick>=72000&&p.tick<=96000).map(({validityFlags,...p})=>{assert(Number.isInteger(validityFlags),'Missing model validity flags');return p;});
      const scenario=bundle.comparison.scenarios.find(s=>s.id===entry.id);
      assert(scenario&&JSON.stringify(scenario.samples)===JSON.stringify(expected),'Scored samples differ from original capture');
      if(backend==='native')assert(bundle.comparison.firmwareSha256===envelope.firmwareSha256,'Native firmware identity differs');
      else assert(bundle.comparison.firmwareSha256===envelope.manifest?.module?.sha256,'WASM firmware identity differs');
    }
  }
  const result={...compareAutopilot(native.comparison,wasm.comparison),evidenceValidated:true,
    admission:Object.fromEntries(['firmwareCommit','firmwareSha256','airframeSha256','parametersSha256','sensorSha256','commandsSha256','physicsHz'].map(key=>[key,wasm.comparison[key]]))};
  // A comparison result is evidence only; no file written here admits READY.
  const output=resolve(args[5]);assert(!inputs.some(input=>input.file===output),'Output must preserve input evidence');mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify({...result,inputs,analyzerSha256:sha(readFileSync(resolve(root,'scripts/compare-autopilot.mjs')))},null,2)+'\n');
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{if(process.argv.length===2){console.log(JSON.stringify({schemaVersion:1,kind:'autopilot-parity',status:'BLOCKED_EXTERNAL',reasons:['Provide audited native/browser capture bundles using --native, --wasm and --output']}));process.exitCode=2;}
    else {const result=runComparison(process.argv.slice(2));console.log(JSON.stringify(result));process.exitCode=result.status==='PASS'?0:1;}}
  catch(error){if(error&&typeof error==='object'&&error.code==='ENOENT'){
    console.error(JSON.stringify({schemaVersion:1,kind:'autopilot-parity',status:'BLOCKED_EXTERNAL',reasons:[String(error)]}));process.exitCode=2;
  }else{console.error(String(error));process.exitCode=1;}}
}
