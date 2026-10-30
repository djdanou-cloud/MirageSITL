import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {beforeAll,expect,it} from 'vitest';
import {BetRotorEngine,encodeBoundRotor,KERNEL_OPTION_HOVER_SAMPLING,KERNEL_OPTION_REDUCED_PREDICTOR,ROTOR_FLAG_HOVER_SAMPLING,
  ROTOR_FLAG_REDUCED_PREDICTOR,type BoundRotorDefinition} from '@mirage/wasm-bet/rotor';
import {BetFlightDynamics} from '@mirage/physics/bet-dynamics';
import {PhysicsSessionV2} from '../packages/physics/src/session-v2.ts';
import {flightConfiguration,rotorDefinition} from './bet-runtime-fixture.ts';
import {createSharedMemoryV2,createSpscQueue,StateReaderV2,newFlightStateV2,newInput,VehicleFlagV2} from '@mirage/protocol';
const modules:WebAssembly.Module[]=[];
function numeric(value:unknown):value is (...args:number[])=>number{return typeof value==='function';}
beforeAll(()=>{
  execFileSync(process.execPath,['scripts/build-wasm.mjs'],{stdio:'pipe'});
  for(const variant of ['scalar','simd128'])modules.push(new WebAssembly.Module(readFileSync(`packages/wasm-bet/dist/mirage_bet.${variant}.wasm`)));
},300000);

function constantRotor():BoundRotorDefinition {
  const d=rotorDefinition();d.geometry={...d.geometry,radiusM:0.5,rootCutoutM:0.1,
    radialStationM:[0.3],chordM:[0.03],twistRad:[0],quadratureWidthM:[0.4],shaftInertiaKgM2:0.02,
    bearingViscousNmPerRadS:0};d.initialOmegaRadS=100;
  d.polar={alphaRad:[-3.15,3.15],reynolds:[1,1e9],mach:[0,1],cl:Array(8).fill(1),cd:Array(8).fill(0.02),confidence:Array(8).fill(1)};
  return d;
}
it('binds real production WASM and matches independent section force/shaft torque',()=>{
  for(const module of modules) {
    const d=constantRotor(),e=new BetRotorEngine(module,[d],400);
    expect(e.stepInto()).toBe(true);
    const initialThrust=0.5*1.225*30*30*0.03*0.4*2;
    const halfOmega=100-initialThrust*0.02*0.3/0.02/800;
    const halfInduced=Math.sqrt(initialThrust/(2*1.225*Math.PI*0.25))*(1-Math.exp(-1/800/0.1));
    const velocity=Math.hypot(halfOmega*0.3,halfInduced),scale=0.5*1.225*velocity**2*0.03*0.4*2;
    const thrust=scale*(halfOmega*0.3-0.02*halfInduced)/velocity,torque=-scale*0.3*(halfInduced+0.02*halfOmega*0.3)/velocity;
    expect(e.output[2]).toBeCloseTo(thrust,10);expect(e.output[10]).toBeCloseTo(torque,10);
    expect(e.output[8]).toBeCloseTo(0,10);expect(e.output[12]).toBeGreaterThan(0);
    expect(e.output[14]).toBe(0);expect(e.memoryStable).toBe(true);
    e.reset();expect(e.output[9]).toBe(100);e.dispose();expect(e.stepInto()).toBe(false);
  }
});
it('rejects version/pointer/overlap/dt/growth errors and preserves raw output',()=>{
  const module=modules[0];if(!module)throw Error('Missing module');
  const e=new WebAssembly.Instance(module,{}).exports;
  const memory=e.memory,heap=e.__heap_base;
  if(!(memory instanceof WebAssembly.Memory) || !(heap instanceof WebAssembly.Global) || typeof heap.value!=='number')throw Error('Invalid memory');
  const init=e.bet_bound_init,step=e.bet_bound_step;
  if(!numeric(init)||!numeric(step))throw Error('Missing ABI');
  const bytes=encodeBoundRotor(constantRotor(),1/400),cp=Math.ceil(heap.value/64)*64;
  const ap=Math.ceil((cp+bytes.length)/64)*64,al=bytes.length+64,ip=Math.ceil((ap+al)/64)*64,op=ip+128;
  memory.grow(Math.max(0,Math.ceil((op+128-memory.buffer.byteLength)/65536)));
  const view=new DataView(memory.buffer);new Uint8Array(memory.buffer,cp,bytes.length).set(bytes);
  // Configuration version 2 carries the TASK-091 kernel options; 3 is unknown.
  view.setUint32(cp,3,true);expect(init(cp,bytes.length,ap,al)).toBe(-7);view.setUint32(cp,1,true);
  expect(init(cp+1,bytes.length,ap,al)).toBe(-2);expect(init(cp,bytes.length,cp,al)).toBe(-2);
  expect(init(cp,bytes.length,ap,al)).toBe(0);view.setUint32(ip,1,true);
  view.setFloat64(ip+8,1.225,true);view.setFloat64(ip+16,1.789e-5,true);view.setFloat64(ip+24,340,true);
  new Uint8Array(memory.buffer,op,128).fill(90);
  expect(step(ap,ip,op,1/800)).toBe(-4);expect(new Uint8Array(memory.buffer,op,128).every(v=>v===90)).toBe(true);
  expect(step(ap,ap,op,1/400)).toBe(-2);expect(step(ap,ip,ip,1/400)).toBe(-2);
  memory.grow(1);expect(step(ap,ip,op,1/400)).toBe(-5);
});
it('retains confidence flags and scalar/SIMD parity for all configured airfoils',()=>{
  for(let index=0;index<3;index++) {
    const engines=modules.map(m=>new BetRotorEngine(m,[rotorDefinition(index)],800));
    for(let step=0;step<100;step++)for(const e of engines){e.input[12]=0.01;expect(e.stepInto()).toBe(true);}
    const first=engines[0],second=engines[1];if(!first||!second)throw Error('Missing variant');
    for(let i=0;i<16;i++)expect(first.output[i]).toBeCloseTo(second.output[i]!,9);
    expect(first.output[14]!&4).toBe(4);
  }
});
it('uses selected BET dynamics in the real SAB session and preserves model validity',()=>{
  const module=modules[0];if(!module)throw Error('Missing module');
  const stateBuffer=createSharedMemoryV2(),sensorBuffer=createSpscQueue('sensor'),actuatorBuffer=createSpscQueue('actuator');
  let now=0;
  const session=new PhysicsSessionV2({type:'init-v2',protocolVersion:2,stateBuffer,sensorBuffer,actuatorBuffer},
    {monotonicMs:()=>now,wallMs:()=>100000+now},hz=>new BetFlightDynamics(module,flightConfiguration(2,6),hz));
  expect(session.rotorCount()).toBe(6);session.start();
  for(let i=0;i<100;i++){now++;session.pump();}
  const reader=new StateReaderV2(stateBuffer),state=newFlightStateV2();expect(reader.latest(state)).toBe(true);
  expect(state.modelId).toBe(75);expect(state.downM).toBeGreaterThan(-20);expect(state.referenceRotorRpm).toBeGreaterThan(0);
  expect(state.vehicleFlags&VehicleFlagV2.ModelOutsideValidity).toBeTruthy();expect(state.autopilotHealth).toBe(0);
  session.dispose();expect(session.disposed).toBe(true);
});
it('runs configurable body/rotor layouts deterministically at all supported rates',()=>{
  const module=modules[0];if(!module)throw Error('Missing module');
  for(const hz of [400,800,1200] as const)for(const count of [4,6,8]) {
    const a=new BetFlightDynamics(module,flightConfiguration(0,count),hz),b=new BetFlightDynamics(module,flightConfiguration(0,count),hz);
    const pilot=newInput();pilot.flags=3;pilot.throttle=0.5;pilot.wallTimeMs=100;
    for(let i=0;i<40;i++){a.nowMs=100;b.nowMs=100;a.stepNow(pilot);b.stepNow(pilot);}
    expect(a.fault).toBe('');expect(a.state).toEqual(b.state);expect(a.state.tick).toBe(40);expect(a.state.down).not.toBe(-20);
    a.reset();expect(a.state.down).toBe(-20);expect(a.state.tick).toBe(0);
  }
});
it('uses the opt-in synthetic pad only at penetration, preserving free flight above it',()=>{
  const module=modules[0];if(!module)throw Error('Missing module');
  const grounded=flightConfiguration();grounded.initialBody.positionNedM[2]=0;
  grounded.initialOmegaRadS=[0,0,0,0];grounded.syntheticGroundDownM=0;
  const supported=new BetFlightDynamics(module,grounded,400);
  const free=flightConfiguration();free.initialBody.positionNedM[2]=0;free.initialOmegaRadS=[0,0,0,0];
  const falling=new BetFlightDynamics(module,free,400),pilot=newInput();
  for(let i=0;i<20;i++){supported.stepNow(pilot);falling.stepNow(pilot);}
  expect(supported.state.down).toBe(0);expect(supported.state.vd).toBe(0);expect(supported.state.ad).toBe(0);
  expect(falling.state.down).toBeGreaterThan(0);
  const above=flightConfiguration();above.syntheticGroundDownM=0;
  const a=new BetFlightDynamics(module,above,400),b=new BetFlightDynamics(module,flightConfiguration(),400);
  for(let i=0;i<20;i++){a.stepNow(pilot);b.stepNow(pilot);}
  expect(a.state).toEqual(b.state);
  const invalid=flightConfiguration();invalid.syntheticGroundDownM=NaN;
  expect(()=>new BetFlightDynamics(module,invalid,400)).toThrow('Invalid synthetic ground plane');
  for(const p of [supported,falling,a,b])p.dispose();
});

it('encodes the TASK-091 kernel options as configuration version 2 and reports their steps apart from validity',()=>{
  const plain=new DataView(encodeBoundRotor(rotorDefinition(),1/400).buffer);
  expect([plain.getUint32(0,true),plain.getUint32(36,true)]).toEqual([1,0]);
  const both=KERNEL_OPTION_REDUCED_PREDICTOR|KERNEL_OPTION_HOVER_SAMPLING;
  const encoded=new DataView(encodeBoundRotor({...rotorDefinition(),kernelOptions:both},1/400).buffer);
  expect([encoded.getUint32(0,true),encoded.getUint32(36,true)]).toEqual([2,3]);
  for(const bad of [4,-1,0.5])expect(()=>encodeBoundRotor({...rotorDefinition(),kernelOptions:bad},1/400)).toThrow('kernel options');
  for(const module of modules) {
    const full=new BetFlightDynamics(module,flightConfiguration(0,4),400),modes=new BetFlightDynamics(module,flightConfiguration(0,4,both),400);
    const pilot={flags:3,throttle:0.5,roll:0,pitch:0,yaw:0,wallTimeMs:0};
    let sampling=0,validity=0;
    for(let i=0;i<800;i++){
      const t=(i+0.5)/400;full.nowMs=modes.nowMs=pilot.wallTimeMs=t*1000;
      full.stepNow(pilot);modes.stepNow(pilot);sampling|=modes.samplingFlags;validity|=modes.validityFlags;
      expect(full.samplingFlags).toBe(0);
    }
    // Both modes ran, never as a validity breach, and the vertical flight stays with the full kernel.
    expect(sampling).toBe(ROTOR_FLAG_HOVER_SAMPLING|ROTOR_FLAG_REDUCED_PREDICTOR);
    expect(validity&(ROTOR_FLAG_HOVER_SAMPLING|ROTOR_FLAG_REDUCED_PREDICTOR)).toBe(0);
    expect(Math.abs(modes.state.down-full.state.down)).toBeLessThan(1e-3);
    full.dispose();modes.dispose();
  }
},120000);
