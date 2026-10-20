/** TASK-047 common configurable test aircraft. No measured-flight claim. */
import {flightConfiguration} from '../bet-runtime-fixture.ts';
import {validateModelManifest} from '../../packages/physics/src/model-manifest.ts';
import type {BetFlightConfiguration} from '../../packages/physics/src/bet-dynamics.ts';

export const PARITY_HZ=800;
export const PARITY_ORIGIN={latitudeRad:-35.362938*Math.PI/180,longitudeRad:149.165085*Math.PI/180,
  // Pinned pymavlink AP_Declination table at this origin, gauss.
  altitudeMslM:584,geoidOffsetM:0,magneticNedGauss:[0.23217525275955084,0.052737121772554546,-0.5289092472443166] as const};
export function parityAircraft():BetFlightConfiguration {
  const c=flightConfiguration(0,4),model=validateModelManifest(c.manifest);
  // Pinned AP_MotorsMatrix quad-X channel order: FR, RL, FL, RR.
  const xs=[1,-1,1,-1],ys=[1,-1,-1,1],spins=[1,1,-1,-1] as const;
  c.manifest={...model,massKg:1.5,inertiaBodyKgM2:[0.03,0,0,0,0.03,0,0,0,0.05],
    // Synthetic two 1 g uniform blades, r=0.045..0.15 m: I=2*m*(b²+ab+a²)/3.
    rotors:model.rotors.map((r,i)=>({...r,shaftInertiaKgM2:2*0.001*(0.15**2+0.15*0.045+0.045**2)/3,
      hubPositionBodyM:[xs[i]!*0.2/Math.SQRT2,ys[i]!*0.2/Math.SQRT2,0],spinSign:spins[i]}))};
  c.initialBody.positionNedM[2]=0;c.initialOmegaRadS=[0,0,0,0];
  c.motorMaxTorqueNm=[0.15,0.15,0.15,0.15];c.syntheticGroundDownM=0;
  return c;
}
