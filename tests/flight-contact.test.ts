import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {beforeAll,expect,it} from 'vitest';
import {BetFlightDynamics,type BetFlightConfiguration} from '@mirage/physics/bet-dynamics';
import {GroundContact,type ContactWheel} from '../packages/physics/src/ground-contact.ts';
import {newBodyTruth} from '@mirage/wasm-bet/backend';
import {ControlFlag,newInput} from '@mirage/protocol';
import {flightConfiguration} from './bet-runtime-fixture.ts';
import {prepareContact} from './contact-support.ts';
// TASK-095 increment 3: Rapier contact as the body integrator of the BET flight model. The
// vehicle and its four short legs are synthetic test inputs, not a measured aircraft.
let module:WebAssembly.Module;
beforeAll(async()=>{
  execFileSync(process.execPath,['scripts/build-wasm.mjs'],{stdio:'pipe'});
  module=new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  await prepareContact();
},300000);
/** Leg tips 0.17 m below the CG; down of the CG when the tips just touch the plane. */
const TOUCH_DOWN_M=-0.17;
function legs():ContactWheel[] {
  return [[0.2,0.2],[0.2,-0.2],[-0.2,-0.2],[-0.2,0.2]].map(([x,y])=>({anchorBodyM:[x!,y!,0.15] as const,unsprungMassKg:0.02,
    tireRadiusM:0.02,rimRadiusM:0.01,strutTravelM:0.05,
    suspension:{kind:'linear' as const,stiffnessNpm:2000,preloadN:0,compressionDamping:40,reboundDamping:40,dampingLaw:'linear' as const},
    tireLoadCurve:[[0,0],[0.01,200]] as const,tireDampingNsPm:5,rollingCoefficient:0.6,lateralCoefficient:0.6,brakingCoefficient:0.6}));
}
async function grounded(hz:400|800|1200):Promise<BetFlightDynamics> {
  const c:BetFlightConfiguration=flightConfiguration();
  c.initialOmegaRadS=[0,0,0,0];c.motorMaxTorqueNm=[0.6,0.6,0.6,0.6];
  c.initialBody.positionNedM[2]=TOUCH_DOWN_M-0.001;
  c.contact=await GroundContact.forVehicle(c.initialBody,c.manifest as {massKg:number;inertiaBodyKgM2:number[]},{wheels:legs(),hullRadiusM:0.05});
  return new BetFlightDynamics(module,c,hz);
}
function tilt(q:{qw:number;qx:number;qy:number;qz:number}):number {
  // Angle between body down and NED down: 1 - 2(qx^2 + qy^2) is its cosine.
  return Math.acos(Math.min(1,1-2*(q.qx*q.qx+q.qy*q.qy)));
}
it.each([400,800,1200] as const)('rests on its legs, takes off and lands at %i Hz with no attitude reset',async hz=>{
  const d=await grounded(hz),pilot=newInput();
  let tick=0,maxTurn=0,peak=0;
  const step=(throttle:number,armed:boolean)=>{
    const q0=[d.state.qw,d.state.qx,d.state.qy,d.state.qz];
    d.nowMs=pilot.wallTimeMs=(tick+0.5)/hz*1000;tick++;
    pilot.flags=armed?ControlFlag.Connected|ControlFlag.Armed:ControlFlag.Connected;pilot.throttle=throttle;
    d.stepNow(pilot);
    const dot=Math.abs(q0[0]!*d.state.qw+q0[1]!*d.state.qx+q0[2]!*d.state.qy+q0[3]!*d.state.qz);
    maxTurn=Math.max(maxTurn,2*Math.acos(Math.min(1,dot)));
  };
  try {
    for(let i=0;i<hz;i++)step(0,false);
    // On its legs: supported, level, the struts compressed but inside their travel.
    expect(d.fault).toBe('');
    expect(Math.abs(d.state.vd)).toBeLessThan(1e-3);
    expect(tilt(d.state)).toBeLessThan(1e-3);
    expect(d.state.down).toBeGreaterThan(TOUCH_DOWN_M);
    expect(d.state.down).toBeLessThan(TOUCH_DOWN_M+0.05);
    const rest=d.state.down;
    for(let i=0;i<1.5*hz;i++){step(0.3,true);peak=Math.min(peak,d.state.down);}
    expect(peak).toBeLessThan(rest-1);
    // Descend at 0.5 m/s on a vertical-speed loop, then cut the motors once on the legs.
    for(let i=0;i<60*hz&&d.state.down<TOUCH_DOWN_M;i++)step(Math.max(0,Math.min(0.4,0.2+0.2*(d.state.vd-0.5))),true);
    expect(d.state.down).toBeGreaterThanOrEqual(TOUCH_DOWN_M);
    for(let i=0;i<2*hz;i++)step(0,false);
    expect(d.fault).toBe('');
    expect(Math.abs(d.state.vd)).toBeLessThan(1e-3);
    expect(Math.abs(d.state.down-rest)).toBeLessThan(2e-3);
    expect(tilt(d.state)).toBeLessThan(0.02);
    // Rapier integrated every step: the attitude never jumps (the synthetic pad reset it).
    expect(maxTurn).toBeLessThan(0.01);
  } finally {d.dispose();}
},120000);
it('restarts its contact on reset and repeats the same steps',async()=>{
  const d=await grounded(400),pilot=newInput();
  pilot.flags=ControlFlag.Connected|ControlFlag.Armed;pilot.throttle=0.3;
  const run=()=>{const out:number[]=[];for(let i=0;i<600;i++){d.nowMs=pilot.wallTimeMs=(i+0.5)/400*1000;d.stepNow(pilot);out.push(d.state.down,d.state.vd,d.state.qx);}return out;};
  try {
    const first=run();d.reset();
    expect(d.state.down).toBe(TOUCH_DOWN_M-0.001);
    expect(run()).toEqual(first);
  } finally {d.dispose();}
},120000);
it('rejects a contact that does not match the model or comes with the synthetic pad',async()=>{
  const make=async(mass:number)=>{const c=flightConfiguration();c.contact=await GroundContact.forVehicle(c.initialBody,
    {massKg:mass,inertiaBodyKgM2:[0.05,0,0,0,0.05,0,0,0,0.1]},{wheels:legs()});return c;};
  const heavier=await make(2.5);
  expect(()=>new BetFlightDynamics(module,heavier,400)).toThrow('Contact vehicle mass properties differ from the model');
  const padded=await make(2);padded.syntheticGroundDownM=0;
  expect(()=>new BetFlightDynamics(module,padded,400)).toThrow('A contact and the synthetic pad exclude each other');
  const lunar=await make(2);lunar.gravityMps2=1.62;
  expect(()=>new BetFlightDynamics(module,lunar,400)).toThrow('Contact gravity differs from the model');
  for(const c of [heavier,padded,lunar])c.contact?.dispose();
  await expect(GroundContact.forVehicle(newBodyTruth(),{massKg:0.05,inertiaBodyKgM2:[0.05,0,0,0,0.05,0,0,0,0.1]},{wheels:legs()}))
    .rejects.toThrow('Unsprung masses exceed the vehicle mass');
});
