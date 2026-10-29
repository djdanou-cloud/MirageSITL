/** Configurable rigid-rotor BET flight dynamics; one WASM body integrator owns truth. */
import { ControlFlag, INPUT_CLOCK_TOLERANCE_MS, INPUT_TIMEOUT_MS, StateFlag, ActuatorFlagV2, newState,
  type PilotInput, type PhysicsHz, type ActuatorFrameV2 } from '@mirage/protocol';
import { BetRotorEngine, type BoundPolar } from '../../wasm-bet/src/rotor.ts';
import { BOUND_V2, BOUND_V2_DRIVE_DOUBLES, BOUND_V2_INPUT_DOUBLES, BOUND_V2_OUTPUT_SLOTS, BetRotorEngineV2 } from '../../wasm-bet/src/rotor-v2.ts';
import { BetBus, type BusBattery } from '../../wasm-bet/src/bus.ts';
import { BetRigidBodyBackend, newBodyTruth, type BodyTruth } from '../../wasm-bet/src/backend.ts';
import type { MotorFaults } from './motor-fault.ts';
import { validateModelManifest } from './model-manifest.ts';
import { FrameLayout } from './frame.ts';

/** One motor and its ESC for the production drive (TASK-092); SI units, k_t = k_e. */
export interface EscDriveMotor {
  readonly resistanceOhm: number; readonly torqueConstantNmPerA: number; readonly currentLimitA: number;
  readonly brakeCurrentLimitA: number; readonly noLoadTorqueNm: number; readonly commandTauS: number;
  /** ESC update period; 0 updates every physics step. */
  readonly updatePeriodS: number;
}
/** Voltage-driven motors on one shared battery bus (TASK-092), one motor per rotor in rotor order. */
export interface EscDriveConfiguration {
  readonly motors: readonly EscDriveMotor[];
  readonly battery: BusBattery;
  readonly initialStateOfCharge: number;
  /** Constant avionics load on the bus, W; defaults to 0. */
  readonly housePowerW?: number;
}

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
  /** The production drive (TASK-092). Absent, each rotor gets duty·motorMaxTorqueNm, bit for bit as before. */
  drive?: EscDriveConfiguration;
}

export class BetFlightDynamics<H extends PhysicsHz|4800 = PhysicsHz> {
  readonly state=newState();
  readonly hz:H;
  readonly modelId:number;
  readonly rotorCount:number;
  /** The torque-drive rotor engine (interface v1), or null with an ESC drive. */
  readonly engine:BetRotorEngine|null;
  /** The ESC-drive rotor engine (interface v2 drive mode 1), or null without one. */
  readonly escEngine:BetRotorEngineV2|null;
  /** Bus current of the last step, A; 0 without an ESC drive. */
  get batteryCurrentA():number{return this.electrical[2]!;}
  /** Bus state of charge, 1 without an ESC drive. */
  get stateOfCharge():number{return this.electrical[0]!;}
  /** The bus could not deliver or absorb the demand on the last step. */
  busLimited=false;
  /** A motor current sat at its limit on the last step: a modeled clamp, not a validity breach. */
  driveLimited=false;
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
  private readonly bus:BetBus|null;
  private readonly initialSoc:number;
  private readonly housePowerW:number;
  private readonly inputStride:number;
  private readonly outputStride:number;
  private readonly input:Float64Array;
  private readonly output:Float64Array;
  /**
   * [state of charge, bus voltage V, bus current A] of the last step (TASK-092).
   * Per-step doubles live in a typed array: V8 keeps class fields tagged, so a
   * double stored in a field or returned by a non-inlined getter can allocate.
   * Hot-path readers index this array; the getters are for cold code.
   */
  readonly electrical=new Float64Array([1,0,0]);
  private faults:MotorFaults|null=null;
  private readonly unit=new Float64Array([1]);
  private readonly fraction=new Float64Array(1);
  private readonly faultWrench=new Float64Array(6);
  private readonly faultScaled=new Float64Array(6);
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
    const drive=configuration.drive;
    if(drive) {
      const soc=drive.initialStateOfCharge,house=drive.housePowerW??0;
      if(drive.motors.length!==n || !Number.isFinite(soc) || soc<=0 || soc>1 || !Number.isFinite(house) || house<0)throw Error('Invalid ESC drive configuration');
      const esc=new BetRotorEngineV2(module,definitions,hz);
      drive.motors.forEach((m,i)=>{
        const values=[m.resistanceOhm,m.torqueConstantNmPerA,m.currentLimitA,m.brakeCurrentLimitA,m.noLoadTorqueNm,m.commandTauS,m.updatePeriodS];
        if(!values.every(Number.isFinite))throw Error('Invalid ESC drive motor');
        esc.drive.set(values,i*BOUND_V2_DRIVE_DOUBLES);esc.driveMode[i]=BOUND_V2.driveEscDuty;
      });
      this.escEngine=esc;this.engine=null;
      this.bus=new BetBus(module,drive.battery,hz);this.initialSoc=soc;this.housePowerW=house;
      this.input=this.escEngine.input;this.output=this.escEngine.output;this.inputStride=BOUND_V2_INPUT_DOUBLES;this.outputStride=BOUND_V2_OUTPUT_SLOTS;
    } else {
      this.engine=new BetRotorEngine(module,definitions,hz);this.escEngine=null;this.bus=null;this.initialSoc=1;this.housePowerW=0;
      this.input=this.engine.input;this.output=this.engine.output;this.inputStride=13;this.outputStride=16;
    }
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
    this.engine?.reset();this.escEngine?.reset();this.body.reset(this.initial);
    const e=this.electrical;e[0]=this.initialSoc;e[2]=0;this.busLimited=false;this.driveLimited=false;
    // Before the first bus step the motors see the unloaded pack.
    e[1]=this.bus?this.bus.openCircuitV(this.initialSoc):0;
    this.truth.positionNedM.set(this.initial.positionNedM);this.truth.velocityNedMps.set(this.initial.velocityNedMps);
    this.truth.quaternionBodyToNed.set(this.initial.quaternionBodyToNed);this.truth.angularVelocityBodyRadS.set(this.initial.angularVelocityBodyRadS);
    this.truth.accelerationNedMps2.fill(0);this.angularAcceleration.fill(0);Object.assign(this.state,newState());this.state.batteryVoltage=e[1]!;
    this.state.flags=StateFlag.InputFailsafe;this.pendingActuator=false;this.externalArmed=false;this.fault='';this.validityFlags=0;
    this.referenceRotorRpm=this.output[9]!*60/(2*Math.PI);
    this.copyTruth();
  }
  /**
   * Motor faults on the physical path (cold). A power cut with remaining
   * fraction r scales the drive by r: the ESC command with an ESC drive, where
   * r = 0 unpowers the bridge, and the drive torque otherwise. A synthetic
   * instant thrust loss scales the rotor's whole wrench.
   */
  useMotorFaults(faults:MotorFaults):void {this.faults=faults;}
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
    const valid=(pilot.flags&(ControlFlag.Connected|ControlFlag.Armed))===3 && age>=-INPUT_CLOCK_TOLERANCE_MS && age<=INPUT_TIMEOUT_MS &&
      Number.isFinite(pilot.throttle) && Number.isFinite(pilot.roll) && Number.isFinite(pilot.pitch) && Number.isFinite(pilot.yaw);
    const external=this.pendingActuator;let sum=0;
    if(!external)this.externalArmed=false;
    const input=this.input,esc=this.escEngine,faults=this.faults;
    for(let i=0;i<this.rotorCount;i++) {
      const a=i*9,b=i*this.inputStride,c=i*3,m=i*4;
      const ax=fx-(ry*p[c+2]!-rz*p[c+1]!),ay=fy-(rz*p[c]!-rx*p[c+2]!),az=fz-(rx*p[c+1]!-ry*p[c]!);
      input[b]=this.atmosphere[0]!;input[b+1]=this.atmosphere[1]!;input[b+2]=this.atmosphere[2]!;
      input[b+3]=r[a]!*ax+r[a+3]!*ay+r[a+6]!*az;input[b+4]=r[a+1]!*ax+r[a+4]!*ay+r[a+7]!*az;
      input[b+5]=r[a+2]!*ax+r[a+5]!*ay+r[a+8]!*az;
      input[b+6]=r[a]!*rx+r[a+3]!*ry+r[a+6]!*rz;input[b+7]=r[a+1]!*rx+r[a+4]!*ry+r[a+7]!*rz;
      input[b+8]=r[a+2]!*rx+r[a+5]!*ry+r[a+8]!*rz;
      let duty=external?(this.externalArmed?this.actuator[this.channels[i]!]!:0):valid?
        this.mix[m]!*pilot.throttle+this.mix[m+1]!*pilot.roll+this.mix[m+2]!*pilot.pitch+this.mix[m+3]!*pilot.yaw:0;
      duty=Math.max(0,Math.min(1,duty));sum+=duty;
      // The fault fraction is 1 unless a power cut is set (driveTorqueFromArrayInto of a unit baseline).
      let fraction=1;
      if(faults){if(!faults.driveTorqueFromArrayInto(i,this.unit,this.fraction)){this.fault='BET motor fault table mismatch';return;}fraction=this.fraction[0]!;}
      if(esc) {
        input[b+12]=0;input[b+13]=duty*fraction;input[b+14]=this.electrical[1]!;
        esc.driveFlags[i]=fraction===0?BOUND_V2.drivePowerCut:0;
      } else input[b+12]=faults?duty*this.torque[i]!*fraction:duty*this.torque[i]!;
    }
    if(esc?!esc.stepInto():!this.engine!.stepInto()){this.fault='BET rotor step failed';return;}
    this.validityFlags=0;
    const output=this.output,stride=this.outputStride;let terminalPowerW=0;this.driveLimited=false;
    for(let i=0;i<this.rotorCount;i++) {
      const a=i*stride,b=i*6;
      for(let j=0;j<3;j++){this.hub[b+j]=output[a+j]!;this.hub[b+3+j]=output[a+6+j]!;}
      const flags=output[a+14]!;
      if(esc) {
        terminalPowerW+=output[a+21]!; // electrical_power (record byte 160)
        if((flags&BOUND_V2.flagCurrentLimited)!==0)this.driveLimited=true;
        this.validityFlags|=flags&~BOUND_V2.flagCurrentLimited;
      } else this.validityFlags|=flags;
      if(faults&&faults.outsideValidity(i)) {
        for(let j=0;j<6;j++)this.faultWrench[j]=this.hub[b+j]!;
        if(!faults.wrenchInto(i,this.faultWrench,this.faultScaled)){this.fault='BET motor fault table mismatch';return;}
        for(let j=0;j<6;j++)this.hub[b+j]=this.faultScaled[j]!;
      }
    }
    if(this.bus) {
      // One-tick lag: these motors ran on the previous bus voltage; the bus now delivers their summed terminal power.
      const e=this.electrical,o=this.bus.output;
      if(!this.bus.stepInto(e[0]!,terminalPowerW,this.housePowerW)){this.fault='Battery bus step failed';return;}
      e[0]=o[0]!;e[1]=o[1]!;e[2]=o[2]!;
      this.busLimited=this.bus.output[6]!!==0;
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
    if(this.bus)s.batteryVoltage=this.electrical[1]!;
    this.referenceRotorRpm=output[9]!*60/(2*Math.PI);this.pendingActuator=false;
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
  dispose():void {this.engine?.dispose();this.escEngine?.dispose();}
}
