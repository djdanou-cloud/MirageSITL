/** Real module Worker exercises the same selectable SAB session as Node acceptance. */
import {BetFlightDynamics} from '../../packages/physics/src/bet-dynamics.ts';
import {PhysicsSessionV2} from '../../packages/physics/src/session-v2.ts';
import {flightConfiguration} from '../bet-runtime-fixture.ts';
import {record} from '../../packages/wasm-bet/src/rotor.ts';
import type {PhysicsHz} from '@mirage/protocol';
self.onmessage=(event:MessageEvent<unknown>)=>{
  try {
    const value=event.data;
    if(!record(value) || !(value.bytes instanceof Uint8Array) || !(value.stateBuffer instanceof SharedArrayBuffer) ||
        !(value.sensorBuffer instanceof SharedArrayBuffer) || !(value.actuatorBuffer instanceof SharedArrayBuffer))throw Error('Invalid BET Worker input');
    const module=new WebAssembly.Module(new Uint8Array(value.bytes)),initial=flightConfiguration(2,6);
    let now=0;
    const factory=(hz:PhysicsHz)=>new BetFlightDynamics(module,initial,hz);
    const session=new PhysicsSessionV2({type:'init-v2',protocolVersion:2,stateBuffer:value.stateBuffer,
      sensorBuffer:value.sensorBuffer,actuatorBuffer:value.actuatorBuffer},
      {monotonicMs:()=>now,wallMs:()=>100000+now},factory);
    session.start();for(let i=0;i<1000;i++){now++;session.pump();}
    self.postMessage({fault:session.fault,rotors:session.rotorCount(),isolated:self.crossOriginIsolated});
    session.dispose();
  }catch(error){self.postMessage({error:String(error)});}
};
