import {it,expect} from 'vitest';
import {admitWasmParity} from '../packages/autopilot/src/wasm-parity.ts';
import {AutopilotSession} from '../packages/autopilot/src/state-machine.ts';
const identity={firmwareCommit:'8ab6afde107a91df1b5f60ade8f333cb8a61b190',firmwareSha256:'a'.repeat(64),airframeSha256:'b'.repeat(64),
  parametersSha256:'c'.repeat(64),sensorSha256:'d'.repeat(64),commandsSha256:'e'.repeat(64),physicsHz:800};
function report(){return {schemaVersion:1,task:'TASK-047',kind:'autopilot-parity',status:'PASS',reasons:[],evidenceValidated:true,admission:identity,
  limits:{durationS:30,positionRmseM:0.5,attitudeRmseDeg:2,telemetryMaxAgeS:1,modeTransitionToleranceS:0.5},
  scenarios:['takeoff-land','gcs-failsafe'].map(id=>({id,samples:3001,positionRmseM:0.01,attitudeRmseDeg:0.1,maxModeMismatchS:0.2}))};}
async function encode(value:unknown){const bytes=new TextEncoder().encode(JSON.stringify(value));
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');return {bytes,hash};}
it('blocks WASM without issued input-bound parity, then still requires live health',async()=>{
  const a=new AutopilotSession();expect(a.connect('wasm-sitl',1,0)).toBe(false);
  expect(a.connect('wasm-sitl',1,0,{status:'PARITY_VERIFIED'},identity)).toBe(false);
  const {bytes,hash}=await encode(report()),capability=await admitWasmParity(bytes,hash,identity);
  expect(a.connect('wasm-sitl',1,0,{...capability},identity)).toBe(false);
  expect(a.connect('wasm-sitl',1,0,capability,{...identity,firmwareSha256:'f'.repeat(64)})).toBe(false);
  expect(a.connect('wasm-sitl',1,0,capability,identity)).toBe(true);
  expect(a.state).toBe('initializing');expect(a.start(1)).toBe(false);
});
it('rejects corrupt bytes, failed/partial/unverified reports, changed limits and mismatched inputs',async()=>{
  const {bytes}=await encode(report());await expect(admitWasmParity(bytes,'0'.repeat(64),identity)).rejects.toThrow();
  const failed={...report(),status:'FAIL'},partial={...report(),scenarios:report().scenarios.slice(1)},unverified={...report(),evidenceValidated:false};
  const limits={...report(),limits:{...report().limits,positionRmseM:1}};
  const excess=report();const first=excess.scenarios[0];if(first)first.attitudeRmseDeg=2.01;
  for(const invalid of [failed,partial,unverified,limits,excess]){const v=await encode(invalid);await expect(admitWasmParity(v.bytes,v.hash,identity)).rejects.toThrow();}
  const valid=await encode(report());await expect(admitWasmParity(valid.bytes,valid.hash,{...identity,parametersSha256:'f'.repeat(64)})).rejects.toThrow();
});
