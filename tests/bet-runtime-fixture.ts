/** Explicit synthetic test models; all geometric and control values are test inputs. */
import suite from './fixtures/rotors/synthetic-bet-suite.json';
import naca6409 from './fixtures/polars/naca6409-neuralfoil.json';
import naca0012 from './fixtures/polars/naca0012-neuralfoil.json';
import { syntheticRotor, type BoundRotorDefinition } from '../packages/wasm-bet/src/rotor.ts';
import { newBodyTruth } from '../packages/wasm-bet/src/backend.ts';
import type { BetFlightConfiguration } from '../packages/physics/src/bet-dynamics.ts';

export function rotorDefinition(index=0):BoundRotorDefinition {
  const config=suite.configurations[index];if(!config)throw Error('Missing synthetic configuration');
  return syntheticRotor(config,config.airfoil==='NACA0012'?naca0012:naca6409,
    {spinSign:1,initialOmegaRadS:3000*Math.PI/30,shaftInertiaKgM2:0.0002,
      bearingViscousNmPerRadS:1e-6,inflowTauS:0.1,inflowLimitMps:500});
}
/** `kernelOptions` turns on the TASK-091 opt-in rotor kernel modes; 0 keeps the full kernel. */
export function flightConfiguration(index=0,count=4,kernelOptions=0):BetFlightConfiguration {
  const definition=rotorDefinition(index),rotors=[],mix:number[]=[];
  for(let i=0;i<count;i++) {
    const angle=2*Math.PI*i/count,spin=i%2===0?1:-1;
    rotors.push({...definition.geometry,id:i,motorChannel:i,polarId:0,spinSign:spin,
      hubPositionBodyM:[0.25*Math.cos(angle),0.25*Math.sin(angle),0],hubToBody:[0,1,0,0]});
    mix.push(1,-0.1*Math.sin(angle),0.1*Math.cos(angle),spin*0.05);
  }
  const initial=newBodyTruth();initial.positionNedM[2]=-20;
  return {manifest:{schemaVersion:1,modelId:73+index,kind:'bet',units:'SI',worldFrame:'NED',bodyFrame:'FRD',
    quaternionOrder:'wxyz',massKg:2,inertiaBodyKgM2:[0.05,0,0,0,0.05,0,0,0,0.1],
    rotorCount:count,rotorCapacity:32,rotors},polars:new Map([[0,definition.polar]]),
    initialOmegaRadS:Array.from({length:count},()=>definition.initialOmegaRadS),
    motorMaxTorqueNm:Array.from({length:count},()=>0.03),inflowTauS:Array.from({length:count},()=>0.1),
    inflowLimitMps:Array.from({length:count},()=>500),pilotMix:mix,motorMapId:42,initialBody:initial,
    minimumConfidence:0.9,densityKgM3:1.225,viscosityPaS:1.789e-5,soundMps:340,kernelOptions};
}
