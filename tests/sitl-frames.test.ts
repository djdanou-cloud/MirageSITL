import {afterAll,beforeAll,expect,it} from "vitest";
import {execFileSync,spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {nodeCheck} from "./support/node-evidence";
const directory=mkdtempSync(join(tmpdir(),"mirage-frames-test-"));
const wasmPath=join(directory,"mirage_bet.scalar.wasm");
beforeAll(()=>execFileSync(process.execPath,["scripts/build-wasm.mjs","--out",directory],{stdio:"pipe"}),300000);
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
it("derives the five frame orders, output functions and all 16/32 wire channels from independent source oracles",()=>nodeCheck(`
import catalog from './tests/fixtures/sitl/frames.json' with {type:'json'};
import {frameById,frameParameters,frameScript} from './scripts/sitl/multirotor.mjs';
import {newServoFrame,decodeServoPacketInto,ExternalSitlLockstep} from './packages/autopilot/src/external-sitl.ts';
assert.deepEqual(catalog.frames.map(f=>f.motorCount),[4,6,8,8,16]);
assert.deepEqual(catalog.motorFunctions.filter(m=>[8,9,12,13,16,32].includes(m.motor)).map(m=>m.function),[40,82,85,160,163,179]);
for(const id of ['quad-x','hexa-x','octo-x','x8','paired-16']){
 const f=frameById(id);assert.equal(f.motorCount,f.motors.length);
 const text=frameParameters(id);
 for(const m of f.motors)assert(text.includes('SERVO'+m.output+'_FUNCTION '+m.function+'\\n'));
 assert.deepEqual(f.motors.map(m=>m.testOrder).sort((a,b)=>a-b),Array.from({length:f.motorCount},(_,i)=>i+1));
 const script=frameScript(id);
 assert.equal(script===null,id!=='paired-16');
 if(script){assert(script.includes('MotorsMatrix:init(16)'));assert.equal((script.match(/add_motor_raw/g)||[]).length,16);}
}
for(const fixture of catalog.servoPackets){
 const packet=Uint8Array.from(Buffer.from(fixture.hex,'hex')),out=newServoFrame();
 assert(decodeServoPacketInto(packet,out));assert.equal(out.channels,fixture.channels);
 assert.equal(out.frameRateHz,800);assert.equal(out.frameCount,0x12345678);
 assert.deepEqual(Array.from(out.pwmUs.subarray(0,fixture.channels)),fixture.pwmUs);
 const link=new ExternalSitlLockstep({motorChannels:[1,8,9,12,13,16]});
 const pwm=new Float64Array(6);assert.equal(link.receive(packet),'step');assert(link.consumeActuatorsInto(pwm));
 for(let i=0;i<6;i++)assert(Math.abs(pwm[i]-17*([1,8,9,12,13,16][i]-1)/1000)<1e-12);
}
assert.throws(()=>frameById('unsupported'));
`));
it("matches independent cross products, analytic hover/freefall and coaxial geometry on real Rust WASM",()=>nodeCheck(`
import {readFileSync} from 'node:fs';
import {MultirotorReference} from './scripts/sitl/multirotor.mjs';
const module=new WebAssembly.Module(readFileSync(${JSON.stringify(wasmPath)}));
const expectedYaw={'quad-x':[1,1,-1,-1],'hexa-x':[-1,1,-1,1,1,-1],'octo-x':[-1,-1,1,1,1,1,-1,-1],'x8':[1,-1,1,-1,1,-1,1,-1],'paired-16':Array.from({length:16},(_,i)=>(i%8+(i>=8?1:0))%2?-1:1)};
const expectedAngles={
 'quad-x':[45,-135,-45,135], 'hexa-x':[90,-90,-30,150,30,-150],
 'octo-x':[22.5,-157.5,67.5,157.5,-22.5,-112.5,-67.5,112.5],
 'x8':[45,-45,-135,135,-45,45,135,-135],
 'paired-16':Array.from({length:16},(_,i)=>22.5+(i%8)*45)};
for(const id of Object.keys(expectedAngles)){
 const model=new MultirotorReference(new WebAssembly.Instance(module,{}),id),n=model.frame.motorCount;
 const u=new Float64Array(n),out=new Float64Array(6),c=model.configuration;
 for(let i=0;i<n;i++){
  u.fill(0);u[i]=1;assert(model.wrenchInto(u,out));
  const a=expectedAngles[id][i]*Math.PI/180,x=.2*Math.cos(a),y=.2*Math.sin(a);
  assert(Math.abs(out[2]+10)<1e-12);assert(Math.abs(out[3]+10*y)<1e-12);assert(Math.abs(out[4]-10*x)<1e-12);
  assert(Math.abs(out[5]-.17*expectedYaw[id][i])<1e-12);
 }
 const load=c.massKg*c.gravityMps2/(n*10),e=c.thrustExpo;
 const hover=(-(1-e)+Math.sqrt((1-e)**2+4*e*load))/(2*e);
 u.fill(hover);assert(model.wrenchInto(u,out));
 assert(Math.abs(out[2]+c.massKg*c.gravityMps2)<1e-12);
 assert(Math.hypot(out[3],out[4],out[5])<1e-12);
 u.fill(0);for(let i=0;i<400;i++)model.step(u,1/400);
 assert.equal(model.truth.positionNedM[2],0);assert(Math.abs(model.specificForce[2]+9.80665)<1e-9);
 model.truth.positionNedM[2]=-10;model.body.reset(model.truth);
 for(let i=0;i<400;i++)model.step(u,1/400);
 assert(Math.abs(model.truth.positionNedM[2]-(-10+4.903325))<1e-9);
 assert(Math.abs(model.specificForce[2])<1e-9);
 u[0]=NaN;assert(!model.wrenchInto(u,out));assert.throws(()=>model.step(u,1/400));
}
`));
it("rejects wrong, simultaneous or missing motor-output evidence in the independent audit",()=>nodeCheck(`
import {assessMotorWindow} from './scripts/check-sitl-frames.mjs';
import {frameById} from './scripts/sitl/multirotor.mjs';
const f=frameById('quad-x');
const baseline=new Array(16).fill(1000);
const rows=Array.from({length:12},()=>{const pwm=baseline.slice();pwm[3]=1200;return pwm;});
// The pinned quad test order 2 addresses motor 4, not motor 2.
assert.equal(assessMotorWindow(f,2,rows,baseline).observedFrames,12);
assert.throws(()=>assessMotorWindow(f,1,rows,baseline));
const two=rows.map(p=>{const copy=p.slice();copy[0]=1200;return copy;});
assert.throws(()=>assessMotorWindow(f,2,two,baseline));
assert.throws(()=>assessMotorWindow(f,2,rows.slice(0,1),baseline));
assert.throws(()=>assessMotorWindow(f,2,rows.map(()=>baseline),baseline));
const other=rows.map(p=>{const copy=p.slice();copy[12]=1400;return copy;});
assert.throws(()=>assessMotorWindow(f,2,other,baseline));
`));

it("measures the 16-rotor real-WASM step with a GC-positive control",()=>{
  const output=join(directory,"allocation.json");
  const result=spawnSync(process.execPath,["--expose-gc","--single-threaded","--max-semi-space-size=64","tests/support/frames-allocation.mjs","--wasm",wasmPath,"--out",output],{encoding:"utf8"});
  expect(result.status,result.stdout+result.stderr).toBe(0);
  const report:unknown=JSON.parse(readFileSync(output,"utf8"));
  expect(report).toMatchObject({zeroAllocation:true,memoryStable:true,controlDetected:true,totalSteps:13000000});
},120000);
