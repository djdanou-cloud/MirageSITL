import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

// JavaScript cold tooling is loaded with a checked public API shape.
interface Sample {tick:number;positionNedM:number[];quaternionWxyz:number[];armed:boolean;mode:number;ekfFlags:number;innovationRatios:number[];heartbeatAgeS:number;ekfAgeS:number}
interface Capture {schemaVersion:number;backend:string;firmwareCommit:string;firmwareSha256:string;physicsHz:number;captureStride:number;seed:number;airframeSha256:string;parametersSha256:string;commandsSha256:string;sensorSha256:string;scenarios:{id:string;referenceStartTick:number;failsafeTick:number|null;samples:Sample[]}[]}
interface Result {status:string;reasons:string[];scenarios:{id:string;positionRmseM:number;attitudeRmseDeg:number}[]}
const script=pathToFileURL(createRequire(import.meta.url).resolve('../../scripts/compare-autopilot.mjs')).href;
const imported:unknown=await import(/* @vite-ignore */ script);
function isApi(v:unknown):v is {compareAutopilot:(native:unknown,wasm:unknown)=>Result} {
  return typeof v==='object'&&v!==null&&'compareAutopilot' in v&&typeof v.compareAutopilot==='function';
}
if(!isApi(imported))throw Error('Comparator export missing');
const compare: (native:unknown,wasm:unknown)=>Result=imported.compareAutopilot;

function capture(backend='native'):Capture {
  return {schemaVersion:1,backend,firmwareCommit:'8ab6afde107a91df1b5f60ade8f333cb8a61b190',firmwareSha256:'a'.repeat(64),
    physicsHz:400,captureStride:4,seed:47,airframeSha256:'b'.repeat(64),parametersSha256:'c'.repeat(64),
    commandsSha256:'d'.repeat(64),sensorSha256:'e'.repeat(64),
    scenarios:['takeoff-land','gcs-failsafe'].map(id=>({id,referenceStartTick:0,failsafeTick:id==='gcs-failsafe'?6000:null,
      samples:Array.from({length:3001},(_,i)=>({tick:i*4,positionNedM:[0,0,i<100?0:i<2000?-5:0],
        quaternionWxyz:[1,0,0,0],armed:i>=100&&i<2900,mode:i<2000?4:9,ekfFlags:831,
        innovationRatios:[0.1,0.1,0.1,0.1,0.1],heartbeatAgeS:0,ekfAgeS:0}))}))};
}
describe('TASK-047 native/browser parity (synthetic analyzer oracles, no flight claim)',()=>{
  it('accepts equal full-duration flights and q/-q equivalence',()=>{
    const native=capture(),wasm=capture('wasm');
    for(const s of wasm.scenarios)for(const p of s.samples)p.quaternionWxyz=[-1,0,0,0];
    expect(compare(native,wasm).status).toBe('PASS');
  });
  it('uses Euclidean position RMSE and quaternion geodesic attitude degrees',()=>{
    const native=capture(),wasm=capture('wasm'),theta=1.5*Math.PI/180;
    for(const s of wasm.scenarios)for(const p of s.samples){p.positionNedM[0]=0.3;p.positionNedM[1]=0.4;p.quaternionWxyz=[Math.cos(theta/2),0,0,Math.sin(theta/2)];}
    const result=compare(native,wasm);expect(result.status).toBe('PASS');
    expect(result.scenarios[0]?.positionRmseM).toBeCloseTo(0.5,10);
    expect(result.scenarios[0]?.attitudeRmseDeg).toBeCloseTo(1.5,9);
  });
  it.each(['position','attitude'])('rejects independently exceeded %s limits',kind=>{
    const native=capture(),wasm=capture('wasm');
    for(const s of wasm.scenarios)for(const p of s.samples){if(kind==='position')p.positionNedM[0]=0.501;else p.quaternionWxyz=[Math.cos(1.01*Math.PI/180),0,Math.sin(1.01*Math.PI/180),0];}
    expect(compare(native,wasm).status).toBe('FAIL');
  });
  it.each(['seed','airframeSha256','parametersSha256','commandsSha256','sensorSha256','firmwareCommit','physicsHz','captureStride'])('rejects mismatched %s before scoring',key=>{
    const native=capture(),wasm={...capture('wasm'),[key]:key.includes('Sha256')?'f'.repeat(64):key==='firmwareCommit'?'f'.repeat(40):800};
    expect(()=>compare(native,wasm)).toThrow();
  });
  it.each(['gap','short','duplicate','quaternion','nan','stale','ekf','disarmed','no-land','no-failsafe','different-mode','extra-scenario'])('rejects %s evidence',fault=>{
    const native=capture(),wasm=capture('wasm'),scenario=wasm.scenarios[0],point=scenario?.samples[200];
    if(!scenario||!point)throw Error('Oracle missing');
    if(fault==='gap')scenario.samples.splice(500,1);
    if(fault==='short')scenario.samples.pop();
    if(fault==='duplicate')point.tick-=4;
    if(fault==='quaternion')point.quaternionWxyz=[2,0,0,0];
    if(fault==='nan')point.positionNedM[0]=NaN;
    if(fault==='stale')point.heartbeatAgeS=1.01;
    if(fault==='ekf')point.ekfFlags=0;
    if(fault==='disarmed')for(const p of scenario.samples)p.armed=false;
    if(fault==='no-land')for(const p of scenario.samples)p.mode=4;
    if(fault==='no-failsafe'){const s=wasm.scenarios[1];if(s)s.failsafeTick=null;}
    if(fault==='different-mode')point.mode=5;
    if(fault==='extra-scenario')wasm.scenarios.push(structuredClone(scenario));
    const rejected=()=>{try{return compare(native,wasm).status!=='PASS';}catch{return true;}};
    expect(rejected()).toBe(true);
  });
});
