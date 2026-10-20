/** Configurable rigid-rotor BET flight dynamics; one WASM body integrator owns truth. */
import { ControlFlag, INPUT_TIMEOUT_MS, StateFlag, ActuatorFlagV2, newState,
  type PilotInput, type PhysicsHz, type ActuatorFrameV2 } from '@mirage/protocol';
import { BetRotorEngine, type BoundPolar } from '../../wasm-bet/src/rotor.ts';
import { BetRigidBodyBackend, newBodyTruth, type BodyTruth } from '../../wasm-bet/src/backend.ts';
import { validateModelManifest } from './model-manifest.ts';
import { FrameLayout } from './frame.ts';

export interface BetFlightConfiguration {
  manifest: unknown; polars: ReadonlyMap<number, BoundPolar>;
  initialOmegaRadS: readonly number[]; motorMaxTorqueNm: readonly number[];
  inflowTauS: readonly number[]; inflowLimitMps: readonly number[];
  /** Per rotor [throttle,roll,pitch,yaw] coefficients; explicit caller-supplied mixer. */
  pilotMix: readonly number[]; motorMapId: number;
  initialBody: BodyTruth; minimumConfidence: number;
  densityKgM3: number; viscosityPaS: number; soundMps: number;
  /** Defaults to Earth gravity; zero is useful for inertial/support allocation fixtures. */
  gravityMps2?: number;
  /** Opt-in synthetic flat pad: inelastic, no-slip support at this NED down.
   * This numerical fixture is independent of Rapier/measured landing fidelity. */
  syntheticGroundDownM?: number;
}

export class BetFlightDynamics<H extends PhysicsHz|4800 = PhysicsHz> {
  readonly state=newState();
  readonly hz:H;
  readonly modelId:number;
  readonly rotorCount:number;
  readonly engine:BetRotorEngine;
  readonly windNedMps=new Float64Array(3);
  readonly atmosphere:Float64Array;
  nowMs=0.5;
  validityFlags=0;
  referenceRotorRpm=0;
  fault='';
  externalArmed=false;
  private readonly dt:number;
  private readonly body:BetRigidBodyBackend;
  private readonly truth=newBodyTruth();
  private readonly initial:BodyTruth;
  private readonly frame:FrameLayout;
  private readonly rotations:Float64Array;
  private readonly positions:Float64Array;
  private readonly channels:Uint32Array;
  private readonly mix:Float64Array;
  private readonly torque:Float64Array;
  private readonly actuator=new Float64Array(16);
  private readonly hub:Float64Array;
  private readonly wrench=new Float64Array(6);
  private readonly angularAcceleration=new Float64Array(3);
  private readonly motorMapId:number;
  private pendingActuator=false;
  private readonly groundDown:number|undefined;
  constructor(module:WebAssembly.Module,configuration:BetFlightConfiguration,hz:H) {
    const model=validateModelManifest(configuration.manifest),n=model.rotorCount;
    if(configuration.syntheticGroundDownM!==undefined&&!Number.isFinite(configuration.syntheticGroundDownM))throw Error('Invalid synthetic ground plane');
    this.groundDown=configuration.syntheticGroundDownM;
    if (model.kind!=='bet' || ![400,800,1200,4800].includes(hz) ||
        configuration.initialOmegaRadS.length!==n || configuration.motorMaxTorqueNm.length!==n ||
        configuration.inflowTauS.length!==n || configuration.inflowLimitMps.length!==n ||
        configuration.pilotMix.length!==n*4 || (configuration.motorMapId>>>0)!==configuration.motorMapId ||
        !Number.isFinite(configuration.minimumConfidence) || configuration.minimumConfidence<0 || configuration.minimumConfidence>1)
      throw Error('Invalid BET flight configuration');
    const definitions=model.rotors.map((r,i)=>{
      const polar=configuration.polars.get(r.polarId);
      if(!polar)throw Error('Missing rotor polar binding');
      return {geometry:r,polar,initialOmegaRadS:configuration.initialOmegaRadS[i]!,
        inflowTauS:configuration.inflowTauS[i]!,inflowLimitMps:configuration.inflowLimitMps[i]!,minimumConfidence:configuration.minimumConfidence};
    });
    this.hz=hz;this.dt=1/hz;this.rotorCount=n;this.modelId=model.modelId;this.motorMapId=configuration.motorMapId;
    this.engine=new BetRotorEngine(module,definitions,hz);
    this.body=new BetRigidBodyBackend(new WebAssembly.Instance(module,{}),model.massKg,model.inertiaBodyKgM2,configuration.gravityMps2??9.80665);
    this.initial=structuredClone(configuration.initialBody);
    this.frame=new FrameLayout(model);this.rotations=new Float64Array(n*9);this.positions=new Float64Array(n*3);
    this.channels=new Uint32Array(n);this.hub=new Float64Array(n*6);
    this.mix=new Float64Array(configuration.pilotMix);this.torque=new Float64Array(configuration.motorMaxTorqueNm);
    if(!this.mix.every(Number.isFinite) || !this.torque.every(v=>Number.isFinite(v)&&v>=0))throw Error('Invalid BET mixer/torque');
    this.atmosphere=new Float64Array([configuration.densityKgM3,configuration.viscosityPaS,configuration.soundMps]);
    if(!this.atmosphere.every(Number.isFinite) || this.atmosphere[0]!<0.05 || this.atmosphere[0]!>2 ||
        this.atmosphere[1]!<=0 || this.atmosphere[2]!<=0)throw Error('Invalid BET atmosphere');
    for(let i=0;i<n;i++) {
      const r=model.rotors[i]!,q=r.hubToBody,norm=Math.sqrt(q[0]!**2+q[1]!**2+q[2]!**2+q[3]!**2);
      const w=q[0]!/norm,x=q[1]!/norm,y=q[2]!/norm,z=q[3]!/norm;
      // Model validation establishes all tuple lengths, station bounds and channels.
      this.channels[i]=r.motorChannel;this.positions.set(r.hubPositionBodyM,i*3);
      this.rotations.set([1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y),
        2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x),2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)],i*9);
    }
    this.reset();
  }
  reset():void {
    this.engine.reset();this.body.reset(this.initial);
    this.truth.positionNedM.set(this.initial.positionNedM);this.truth.velocityNedMps.set(this.initial.velocityNedMps);
    this.truth.quaternionBodyToNed.set(this.initial.quaternionBodyToNed);this.truth.angularVelocityBodyRadS.set(this.initial.angularVelocityBodyRadS);
    this.truth.accelerationNedMps2.fill(0);this.angularAcceleration.fill(0);Object.assign(this.state,newState());this.state.batteryVoltage=0;
    this.state.flags=StateFlag.InputFailsafe;this.pendingActuator=false;this.externalArmed=false;this.fault='';this.validityFlags=0;
    this.referenceRotorRpm=this.engine.output[9]!*60/(2*Math.PI);
    this.copyTruth();
  }
  useActuators(frame:ActuatorFrameV2):void {
    if(frame.motorMapId!==this.motorMapId){this.fault='BET actuator map mismatch';return;}
    for(let i=0;i<this.rotorCount;i++)if(this.channels[i]!>=frame.actuatorCount){this.fault='BET actuator channel missing';return;}
    this.actuator.set(frame.normalizedActuators);this.pendingActuator=true;
    this.externalArmed=(frame.actuatorFlags&ActuatorFlagV2.Armed)!==0;
  }
  stepNow(pilot:PilotInput):void {
    if(this.fault!=='')return;
    const s=this.state,q=this.truth.quaternionBodyToNed,r=this.rotations,p=this.positions,v=this.truth.velocityNedMps;
    const rates=this.truth.angularVelocityBodyRadS,oldRx=rates[0]!,oldRy=rates[1]!,oldRz=rates[2]!;
    const rx=oldRx+0.5*this.dt*this.angularAcceleration[0]!,ry=oldRy+0.5*this.dt*this.angularAcceleration[1]!,
      rz=oldRz+0.5*this.dt*this.angularAcceleration[2]!;
    const h=this.dt*0.25,mw=q[0]!+h*(-q[1]!*rx-q[2]!*ry-q[3]!*rz),
      mx=q[1]!+h*(q[0]!*rx+q[2]!*rz-q[3]!*ry),my=q[2]!+h*(q[0]!*ry-q[1]!*rz+q[3]!*rx),
      mz=q[3]!+h*(q[0]!*rz+q[1]!*ry-q[2]!*rx),norm=Math.sqrt(mw*mw+mx*mx+my*my+mz*mz);
    const w=mw/norm,x=-mx/norm,y=-my/norm,z=-mz/norm;
    const acceleration=this.truth.accelerationNedMps2;
    const vx=this.windNedMps[0]!-v[0]!-0.5*this.dt*acceleration[0]!,
      vy=this.windNedMps[1]!-v[1]!-0.5*this.dt*acceleration[1]!,vz=this.windNedMps[2]!-v[2]!-0.5*this.dt*acceleration[2]!;
    const cx=y*vz-z*vy,cy=z*vx-x*vz,cz=x*vy-y*vx;
    const fx=vx+2*(w*cx+y*cz-z*cy),fy=vy+2*(w*cy+z*cx-x*cz),fz=vz+2*(w*cz+x*cy-y*cx);
    const age=this.nowMs-pilot.wallTimeMs;
    const valid=(pilot.flags&(ControlFlag.Connected|ControlFlag.Armed))===3 && age>=0 && age<=INPUT_TIMEOUT_MS &&
      Number.isFinite(pilot.throttle) && Number.isFinite(pilot.roll) && Number.isFinite(pilot.pitch) && Number.isFinite(pilot.yaw);
    const external=this.pendingActuator;let sum=0;
    if(!external)this.externalArmed=false;
    for(let i=0;i<this.rotorCount;i++) {
      const a=i*9,b=i*13,c=i*3,m=i*4;
      const ax=fx-(ry*p[c+2]!-rz*p[c+1]!),ay=fy-(rz*p[c]!-rx*p[c+2]!),az=fz-(rx*p[c+1]!-ry*p[c]!);
      const input=this.engine.input;
      input[b]=this.atmosphere[0]!;input[b+1]=this.atmosphere[1]!;input[b+2]=this.atmosphere[2]!;
      input[b+3]=r[a]!*ax+r[a+3]!*ay+r[a+6]!*az;input[b+4]=r[a+1]!*ax+r[a+4]!*ay+r[a+7]!*az;
      input[b+5]=r[a+2]!*ax+r[a+5]!*ay+r[a+8]!*az;
      input[b+6]=r[a]!*rx+r[a+3]!*ry+r[a+6]!*rz;input[b+7]=r[a+1]!*rx+r[a+4]!*ry+r[a+7]!*rz;
      input[b+8]=r[a+2]!*rx+r[a+5]!*ry+r[a+8]!*rz;
      let duty=external?(this.externalArmed?this.actuator[this.channels[i]!]!:0):valid?
        this.mix[m]!*pilot.throttle+this.mix[m+1]!*pilot.roll+this.mix[m+2]!*pilot.pitch+this.mix[m+3]!*pilot.yaw:0;
      duty=Math.max(0,Math.min(1,duty));sum+=duty;input[b+12]=duty*this.torque[i]!;
    }
    if(!this.engine.stepInto()){this.fault='BET rotor step failed';return;}
    this.validityFlags=0;
    for(let i=0;i<this.rotorCount;i++) {
      const a=i*16,b=i*6;
      for(let j=0;j<3;j++){this.hub[b+j]=this.engine.output[a+j]!;this.hub[b+3+j]=this.engine.output[a+6+j]!;}
      this.validityFlags|=this.engine.output[a+14]!;
    }
    if(!this.frame.sumInto(this.hub,this.wrench) || !this.body.stepInto(this.wrench,this.dt,this.truth)){
      this.fault='BET body integration failed';return;
    }
    if(this.groundDown!==undefined&&this.truth.positionNedM[2]!>this.groundDown) {
      this.truth.positionNedM[2]=this.groundDown;
      // Explicit infinite-friction pad. No support acts above the plane.
      this.truth.velocityNedMps.fill(0);this.truth.angularVelocityBodyRadS.fill(0);
      this.truth.quaternionBodyToNed.set(this.initial.quaternionBodyToNed);
      this.truth.accelerationNedMps2.fill(0);this.body.reset(this.truth);
    }
    this.angularAcceleration[0]=(rates[0]!-oldRx)/this.dt;this.angularAcceleration[1]=(rates[1]!-oldRy)/this.dt;
    this.angularAcceleration[2]=(rates[2]!-oldRz)/this.dt;
    s.tick++;s.simTime=s.tick/this.hz;s.wallTimeMs=this.nowMs;s.spool=sum/this.rotorCount;
    s.flags=(external?this.externalArmed:valid)?0:StateFlag.InputFailsafe;
    this.referenceRotorRpm=this.engine.output[9]!*60/(2*Math.PI);this.pendingActuator=false;
    this.copyTruth();
  }
  private copyTruth():void {
    const s=this.state,t=this.truth;
    s.north=t.positionNedM[0]!;s.east=t.positionNedM[1]!;s.down=t.positionNedM[2]!;
    s.vn=t.velocityNedMps[0]!;s.ve=t.velocityNedMps[1]!;s.vd=t.velocityNedMps[2]!;
    s.qw=t.quaternionBodyToNed[0]!;s.qx=t.quaternionBodyToNed[1]!;s.qy=t.quaternionBodyToNed[2]!;s.qz=t.quaternionBodyToNed[3]!;
    s.p=t.angularVelocityBodyRadS[0]!;s.q=t.angularVelocityBodyRadS[1]!;s.r=t.angularVelocityBodyRadS[2]!;
    s.an=t.accelerationNedMps2[0]!;s.ae=t.accelerationNedMps2[1]!;s.ad=t.accelerationNedMps2[2]!;
  }
  dispose():void {this.engine.dispose();}
}
