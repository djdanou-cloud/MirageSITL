/** Cold TASK-047 admission. The expected report hash comes from trusted local
 * acceptance configuration, never from the report/download itself. */
export interface WasmParityIdentity {
  firmwareCommit:string;firmwareSha256:string;airframeSha256:string;parametersSha256:string;
  sensorSha256:string;commandsSha256:string;physicsHz:number;
}
export interface WasmParityCapability {readonly status:'PARITY_VERIFIED'}
const issued=new WeakMap<object,Readonly<WasmParityIdentity>>();
function record(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function list(v:unknown):v is readonly unknown[]{return Array.isArray(v);}
function validIdentity(v:WasmParityIdentity):boolean {
  return typeof v.firmwareCommit==='string'&&/^[a-f0-9]{40}$/.test(v.firmwareCommit)&&[400,800,1200].includes(v.physicsHz)&&
    [v.firmwareSha256,v.airframeSha256,v.parametersSha256,v.sensorSha256,v.commandsSha256].every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h));
}
function matches(v:unknown,expected:WasmParityIdentity):boolean {
  return record(v)&&Object.entries(expected).every(([key,value])=>v[key]===value);
}
export function isIssuedWasmParity(value:unknown,expected?:WasmParityIdentity):boolean {
  if(!record(value)||!expected||!validIdentity(expected))return false;
  return matches(issued.get(value),expected);
}
export async function admitWasmParity(bytes:Uint8Array,expectedSha256:string,expected:WasmParityIdentity):Promise<WasmParityCapability> {
  if(bytes.length<1||bytes.length>65536||!/^[a-f0-9]{64}$/.test(expectedSha256)||!validIdentity(expected))throw Error('Invalid parity admission inputs');
  const copy=new Uint8Array(bytes),digest=new Uint8Array(await crypto.subtle.digest('SHA-256',copy));
  const hash=Array.from(digest,v=>v.toString(16).padStart(2,'0')).join('');
  if(hash!==expectedSha256)throw Error('Parity report SHA-256 mismatch');
  const v:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(copy));
  if(!record(v)||v.schemaVersion!==1||v.task!=='TASK-047'||v.kind!=='autopilot-parity'||v.status!=='PASS'||
    v.evidenceValidated!==true||!list(v.reasons)||v.reasons.length!==0||!matches(v.admission,expected)||!record(v.limits)||
    v.limits.durationS!==30||v.limits.positionRmseM!==0.5||v.limits.attitudeRmseDeg!==2||v.limits.telemetryMaxAgeS!==1||
    v.limits.modeTransitionToleranceS!==0.5||!list(v.scenarios)||v.scenarios.length!==2)throw Error('Unverified or mismatched parity report');
  const ids=new Set<string>();
  for(const s of v.scenarios) {
    if(!record(s)||(s.id!=='takeoff-land'&&s.id!=='gcs-failsafe')||ids.has(s.id)||s.samples!==3001||
      typeof s.positionRmseM!=='number'||!Number.isFinite(s.positionRmseM)||s.positionRmseM<0||s.positionRmseM>0.5||
      typeof s.attitudeRmseDeg!=='number'||!Number.isFinite(s.attitudeRmseDeg)||s.attitudeRmseDeg<0||s.attitudeRmseDeg>2||
      typeof s.maxModeMismatchS!=='number'||!Number.isFinite(s.maxModeMismatchS)||s.maxModeMismatchS<0||s.maxModeMismatchS>0.5)
      throw Error('Incomplete or failed parity scenarios');
    ids.add(s.id);
  }
  const capability:WasmParityCapability=Object.freeze({status:'PARITY_VERIFIED'});
  issued.set(capability,Object.freeze({...expected}));return capability;
}
