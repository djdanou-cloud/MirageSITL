import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {beforeAll,describe,expect,it} from 'vitest';
import {BetFlightDynamics,type BetFlightConfiguration} from '@mirage/physics/bet-dynamics';
import {AIR_PRESSURE,atmosphereAtHeightInto} from '../packages/physics/src/atmosphere.ts';
import {GroundContact,type ContactWheel} from '../packages/physics/src/ground-contact.ts';
import {PhysicsSessionV2,isaPressurePa} from '../packages/physics/src/session-v2.ts';
import {newBodyTruth} from '@mirage/wasm-bet/backend';
import {createSharedMemoryV2,createSpscQueue,newFlightStateV2,StateReaderV2} from '@mirage/protocol';
import {effectiveConditions} from '../packages/sensors/src/environment.ts';
import {WorldMagneticModel,parseWmmCoefficients} from '../packages/sensors/src/geomagnetic.ts';
import {loadEgm96Geoid} from '../packages/sensors/src/geoid.ts';
import {flightConfiguration} from './bet-runtime-fixture.ts';
import {prepareContact} from './contact-support.ts';

// TASK-148: the location's gravity and air reach the flight session. At rest on its legs the
// published specific force is the local gravity, and the published pressure is the origin air's
// ISA pressure at the CG height, not that of a sea-level origin. Without them, the session
// publishes exactly what it did before. FlightStateV2 carries pressure and specific force as
// float32 and the height as float64, so the pressure must equal Math.fround of the oracle exactly.
let module:WebAssembly.Module;
beforeAll(async()=>{
  execFileSync(process.execPath,['scripts/build-wasm.mjs'],{stdio:'pipe'});
  module=new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  await prepareContact();
},300000);
const legs=():ContactWheel[]=>[[0.2,0.2],[0.2,-0.2],[-0.2,-0.2],[-0.2,0.2]].map(([x,y])=>({anchorBodyM:[x!,y!,0.15] as const,unsprungMassKg:0.02,
  tireRadiusM:0.02,rimRadiusM:0.01,strutTravelM:0.05,
  suspension:{kind:'linear' as const,stiffnessNpm:2000,preloadN:0,compressionDamping:40,reboundDamping:40,dampingLaw:'linear' as const},
  tireLoadCurve:[[0,0],[0.01,200]] as const,tireDampingNsPm:5,rollingCoefficient:0.6,lateralCoefficient:0.6,brakingCoefficient:0.6}));
async function conditions() {
  const geoid=await loadEgm96Geoid(new Uint8Array(readFileSync('data/geoid/WW15MGH.DAC')));
  const magnetic=new WorldMagneticModel(parseWmmCoefficients(readFileSync('data/geomagnetic/WMM_2025.COF','utf8')));
  return effectiveConditions({latitudeDeg:-35.363261,longitudeDeg:149.16523,groundElevationMslM:584,decimalYear:2026.5},{geoid,magnetic});
}
function grounded(gravityMps2:number|undefined,originAir:{temperatureK:number;pressurePa:number}|undefined):BetFlightConfiguration {
  const c=flightConfiguration();c.initialOmegaRadS=[0,0,0,0];c.initialBody.positionNedM[2]=-0.171;
  if(gravityMps2!==undefined)c.gravityMps2=gravityMps2;
  if(originAir)c.originAir=originAir;
  c.contact=GroundContact.forVehicleNow(c.initialBody,{massKg:2,inertiaBodyKgM2:[0.05,0,0,0,0.05,0,0,0,0.1]},
    {wheels:legs(),hullRadiusM:0.05,...(gravityMps2===undefined?{}:{gravityMps2})});
  return c;
}
function runSession(configuration:BetFlightConfiguration) {
  const stateBuffer=createSharedMemoryV2(),sensorBuffer=createSpscQueue('sensor'),actuatorBuffer=createSpscQueue('actuator');
  let now=0;
  const session=new PhysicsSessionV2({type:'init-v2',protocolVersion:2,stateBuffer,sensorBuffer,actuatorBuffer},
    {monotonicMs:()=>now,wallMs:()=>100000+now},hz=>new BetFlightDynamics(module,configuration,hz));
  session.start();
  for(let i=0;i<2000;i++){now++;session.pump();}
  const state=newFlightStateV2();expect(new StateReaderV2(stateBuffer).latest(state)).toBe(true);
  session.dispose();
  return state;
}

describe('the location in flight sessions (TASK-148)', () => {
  it('publishes the local gravity and the origin air at rest', async () => {
    const c=await conditions();
    const state=runSession(grounded(c.gravityMps2,{temperatureK:c.air.temperatureK,pressurePa:c.air.pressurePa}));
    expect(Math.abs(state.vdMps)).toBeLessThan(1e-6);
    // Specific force at rest: the support against the local normal gravity, not 9.80665.
    expect(Math.abs(state.specificForceZBodyMps2+c.gravityMps2)).toBeLessThan(1e-6);
    expect(Math.abs(state.specificForceZBodyMps2+9.80665)).toBeGreaterThan(1e-2);
    const reference=new Float64Array([c.air.temperatureK,c.air.pressurePa,-state.downM]),air=new Float64Array(5);
    expect(atmosphereAtHeightInto(reference,air)).toBe(true);
    expect(state.ambientPressurePa).toBe(Math.fround(air[AIR_PRESSURE]??Number.NaN));
    // 584 m above sea level: about 6.6 kPa below the sea-level origin the session assumed before.
    expect(isaPressurePa(-state.downM)-state.ambientPressurePa).toBeGreaterThan(6000);
  },120000);
  it('publishes exactly what it did before without a location', () => {
    const state=runSession(grounded(undefined,undefined));
    expect(Math.abs(state.specificForceZBodyMps2+9.80665)).toBeLessThan(1e-6);
    expect(state.ambientPressurePa).toBe(Math.fround(isaPressurePa(-state.downM)));
  },120000);
  it('lets the contact fall at its configured gravity and refuses a mismatched model', async () => {
    const t=newBodyTruth();t.positionNedM[2]=-50;
    const contact=await GroundContact.create(t,1,0.1,0,0.5,{gravityMps2:9.7803253359}),w=new Float64Array(6);
    for(let i=0;i<10;i++)expect(contact.stepInto(w,1/400,t)).toBe(true);
    expect(Math.abs(t.accelerationNedMps2[2]!-9.7803253359)).toBeLessThan(1e-9);
    contact.dispose();
    await expect(GroundContact.create(newBodyTruth(),1,0.1,0,0.5,{gravityMps2:Number.NaN})).rejects.toThrow('Invalid contact gravity');
    const mismatched=grounded(9.79,undefined);delete mismatched.gravityMps2;
    expect(()=>new BetFlightDynamics(module,mismatched,400)).toThrow('Contact gravity differs from the model');
    mismatched.contact?.dispose();
    const outside=grounded(undefined,{temperatureK:400,pressurePa:90000});
    expect(()=>new BetFlightDynamics(module,outside,400)).toThrow('The origin air lies outside the atmosphere envelope');
    outside.contact?.dispose();
  },120000);
});
