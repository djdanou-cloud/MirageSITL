/** Configurable rigid-rotor BET flight dynamics; one WASM body integrator owns truth. */
import { AccidentMonitor, type ContactShapePart } from './accident.ts';
import { ControlFlag, INPUT_CLOCK_TOLERANCE_MS, INPUT_TIMEOUT_MS, StateFlag, ActuatorFlagV2, newState,
  type PilotInput, type PhysicsHz, type ActuatorFrameV2 } from '@mirage/protocol';
import { BetRotorEngine, ROTOR_FLAG_HOVER_SAMPLING, ROTOR_FLAG_REDUCED_PREDICTOR, type BoundPolar } from '../../wasm-bet/src/rotor.ts';
import { BOUND_V2, BOUND_V2_DRIVE_DOUBLES, BOUND_V2_INPUT_DOUBLES, BOUND_V2_OUTPUT_SLOTS, BetRotorEngineV2 } from '../../wasm-bet/src/rotor-v2.ts';
import { BetBus, type BusBattery } from '../../wasm-bet/src/bus.ts';
import { BetRigidBodyBackend, newBodyTruth, type BodyTruth } from '../../wasm-bet/src/backend.ts';
import type { MotorFaults } from './motor-fault.ts';
import { validateModelManifest } from './model-manifest.ts';
import { FrameLayout } from './frame.ts';
import { AIR_DENSITY, AIR_HEIGHT, AIR_REFERENCE_PRESSURE, AIR_REFERENCE_TEMPERATURE, AIR_SOUND, AIR_VISCOSITY, WEATHER_GUST_RMS, WEATHER_PRESSURE,
  WEATHER_SEED, WEATHER_TEMPERATURE, atmosphereAtHeightInto } from './atmosphere.ts';
import { Wind } from './wind.ts';
import { BatteryColumn, LimitMonitor, MotorColumn, MotorLimited, BatteryLimited, PowerTelemetry, type LimitRatings } from './limit-monitor.ts';

/** One motor and its ESC for the production drive (TASK-092); SI units, k_t = k_e. */
export interface EscDriveMotor {
  readonly resistanceOhm: number; readonly torqueConstantNmPerA: number; readonly currentLimitA: number;
  readonly brakeCurrentLimitA: number; readonly noLoadTorqueNm: number; readonly commandTauS: number;
  /** ESC update period; 0 updates every physics step. */
  readonly updatePeriodS: number;
}
/**
 * Airframe drag (TASK-096): the airframe without its rotors, whose momentum drag the BET rotors produce themselves.
 * F = −½·ρ·|v_a|·(C_D·A)·v_a in body FRD, v_a the velocity relative to the air, and the moment r_cp × F about the CG.
 */
export interface AirframeDragConfiguration {
  /** Row-major symmetric positive-definite drag-area tensor (C_D·A), body FRD, m². */
  readonly dragAreaBodyM2: readonly number[];
  /** The center of pressure relative to the CG, body FRD, m. */
  readonly centerOfPressureCgM: readonly number[];
  /** The top of the source data's airspeed range, m/s; beyond it a step sets VALIDITY_FLAG_DRAG_OUTSIDE_RANGE. Infinity states none. */
  readonly maxAirspeedMps: number;
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
  /**
   * TASK-148: the air at the ground origin (the location's effective conditions). With it the rotors
   * and drag meet ISA air at the CG's height above the origin every step, and the session publishes
   * that pressure; a weather.set replaces it until the next reset. Absent, the air is the configured
   * constant state, bit for bit as before.
   */
  originAir?: { readonly temperatureK: number; readonly pressurePa: number };
  /** Opt-in synthetic flat pad: inelastic, no-slip support at this NED down.
   * This numerical fixture is independent of Rapier/measured landing fidelity. */
  syntheticGroundDownM?: number;
  /** The production drive (TASK-092). Absent, each rotor gets duty·motorMaxTorqueNm, bit for bit as before. */
  drive?: EscDriveConfiguration;
  /** TASK-096 airframe drag. Absent, the rotors alone meet the air, bit for bit as before. */
  airframeDrag?: AirframeDragConfiguration;
  /**
   * Configuration-level validity flags (TASK-144), ORed into `validityFlags`
   * every step, for model parts declared but not modeled; 0 by default.
   * Bits 16 and up, so they never alias rotor output flags.
   */
  configurationFlags?: number;
  /**
   * TASK-091 opt-in rotor kernel options for every rotor (`KERNEL_OPTION_*`
   * of @mirage/wasm-bet/rotor); 0 by default, which keeps the full kernel.
   * Steps that used them are reported in `samplingFlags`, not as validity breaches.
   */
  kernelOptions?: number;
  /**
   * TASK-146 component ratings checked every step with the ESC drive; null or
   * absent checks none, and the modeled clamps are reported either way.
   */
  limitRatings?: LimitRatings | null;
  /**
   * TASK-095: compliant Rapier contact as this model's body integrator, in place of the
   * BET rigid body and of `syntheticGroundDownM` (the two exclude each other). Its vehicle
   * mass, inertia and gravity must equal the model's (`GroundContact.forVehicle` builds such
   * a contact). The dynamics takes ownership: `reset` restarts it, `dispose` disposes it.
   */
  contact?: FlightContact;
  /**
   * TASK-149: what each of the contact's shapes stands for, in its shape order. With it the
   * dynamics checks every step's shape reports against decision F-09 (`accidents`).
   */
  contactParts?: readonly ContactShapePart[];
}
/** What `BetFlightDynamics` needs of its contact; `GroundContact` provides it. */
export interface FlightContact {
  readonly integrationOwner: 'rapier';
  readonly gravityMps2: number;
  readonly vehicleMassKg: number;
  readonly vehicleInertiaKgM2: Float64Array;
  stepInto(wrenchBody: Float64Array, dt: number, out: BodyTruth): boolean;
  reset(state: BodyTruth): void;
  dispose(): void;
  /** Hull and propeller shapes and their last-step contact reports (TASK-095, `GroundContact`). */
  readonly shapeCount?: number;
  shapeStateInto?(index: number, out: Float64Array): boolean;
}
/** Rotor output flags of the TASK-091 opt-in modes: informational, never validity breaches. */
const SAMPLING_FLAGS=ROTOR_FLAG_HOVER_SAMPLING|ROTOR_FLAG_REDUCED_PREDICTOR;
/** A vehicle declares rotor-wake pairs that the dynamics does not model until TASK-101. */
export const CONFIGURATION_FLAG_WAKE_UNMODELED = 1 << 16;
/** A step's airspeed exceeded the airframe drag data's range (TASK-096); a step flag, never a configuration flag. */
export const VALIDITY_FLAG_DRAG_OUTSIDE_RANGE = 1 << 17;

/**
 * The bandwidth of a weather.set's synthetic gust (TASK-093): the first-order Gauss-Markov wind of TASK-032, which is
 * not a Dryden model; TASK-106 brings the Dryden, von Kármán and Kaimal spectra.
 */
export const WEATHER_GUST_BANDWIDTH_HZ = 1;
const WIND_OUT_OF_ENVELOPE='The wind lies outside the gust model envelope (mean within 200 m/s per axis, RMS 0 to 50 m/s, a uint32 seed)';
const AIR_OUT_OF_ENVELOPE='The weather lies outside the atmosphere envelope (180 to 330 K, 1 to 120 kPa, 0.05 to 2 kg/m3) at the origin or the vehicle';
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
  /** The wind every rotor's inflow sees this step, NED m/s: zero, or a weather.set's mean wind and gust (TASK-093). */
  readonly windNedMps=new Float64Array(3);
  /** TASK-096: the airframe drag force and moment of the last step, body FRD about the CG [N, N, N, N m, N m, N m]; zero without drag. */
  readonly dragWrenchBody=new Float64Array(6);
  /** [density kg/m³, dynamic viscosity Pa s, speed of sound m/s] the rotors see this step. */
  readonly atmosphere:Float64Array;
  /** A weather.set is in effect (TASK-093); until one is, the configured atmosphere and no wind stay, bit for bit. */
  weatherActive=false;
  /** Gravity the body integrator applies, m/s² down (the configuration's, 9.80665 by default). */
  readonly gravityMps2:number;
  /** True when the air follows the CG's height: a weather.set is in effect, or the configuration has an origin air. */
  get airActive():boolean {return this.weatherActive||this.originAir!==null;}
  /** TASK-148: the configured air at the origin (atmosphereAtHeightInto's input with height 0), or null. */
  private readonly originAir:Float64Array|null;
  /** While airActive, the ISA air at the CG after the last step: atmosphereAtHeightInto's output (AIR_* slots). */
  readonly air=new Float64Array(5);
  nowMs=0.5;
  validityFlags=0;
  /** TASK-091: the opt-in kernel modes the last step used (`ROTOR_FLAG_HOVER_SAMPLING`, `ROTOR_FLAG_REDUCED_PREDICTOR`). */
  samplingFlags=0;
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
  /** The configured atmosphere, which reset() restores. */
  private readonly baseAtmosphere:Float64Array;
  /** TASK-093: the air at the origin and the CG's height above it (atmosphereAtHeightInto's input), a weather.set's
   * candidate and its air while it is checked, and the seeded synthetic gust. */
  private readonly airReference=new Float64Array(3);
  private readonly candidate=new Float64Array(3);
  private readonly candidateAir=new Float64Array(5);
  private readonly gust:Wind;
  /** TASK-096: the drag-area tensor (row-major), the center of pressure from the CG and the airspeed range, or null without drag. */
  private readonly dragArea:Float64Array|null;
  private readonly dragCenter=new Float64Array(3);
  private readonly dragMaxAirspeedMps:number;
  private readonly groundDown:number|undefined;
  private readonly contact:FlightContact|null;
  private readonly bus:BetBus|null;
  private readonly initialSoc:number;
  private readonly housePowerW:number;
  private readonly configurationFlags:number;
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
  /** TASK-146 electrical telemetry of the last step, with the ESC drive; null without one. */
  readonly power:PowerTelemetry|null;
  /** TASK-146 rating and clamp monitor over `power`; null without the ESC drive. */
  readonly limits:LimitMonitor|null;
  /** TASK-149 accident monitor over the contact's shape reports; null without contact shapes. */
  readonly accidents:AccidentMonitor|null;
  private readonly capacityAh:number;
  constructor(module:WebAssembly.Module,configuration:BetFlightConfiguration,hz:H) {
    const model=validateModelManifest(configuration.manifest),n=model.rotorCount;
    if(configuration.syntheticGroundDownM!==undefined&&!Number.isFinite(configuration.syntheticGroundDownM))throw Error('Invalid synthetic ground plane');
    this.groundDown=configuration.syntheticGroundDownM;
    const contact=configuration.contact??null;
    if(contact) {
      const m=model.inertiaBodyKgM2,t=contact.vehicleInertiaKgM2,scale=Math.max(...m.map(Math.abs));
      if(configuration.syntheticGroundDownM!==undefined)throw Error('A contact and the synthetic pad exclude each other');
      if(contact.gravityMps2!==(configuration.gravityMps2??9.80665))throw Error('Contact gravity differs from the model');
      if(Math.abs(contact.vehicleMassKg-model.massKg)>1e-12*model.massKg || t.length!==9 ||
          m.some((v,i)=>Math.abs(t[i]!-v)>1e-12*scale))
        throw Error('Contact vehicle mass properties differ from the model');
    }
    this.contact=contact;
    const flags=configuration.configurationFlags??0;
    if((flags>>>0)!==flags || (flags&0xffff)!==0)throw Error('Configuration flags must use bits 16 to 31');
    if((flags&VALIDITY_FLAG_DRAG_OUTSIDE_RANGE)!==0)throw Error('Bit 17 is the airframe drag step flag, not a configuration flag');
    const drag=configuration.airframeDrag;
    if(drag) {
      const c=drag.dragAreaBodyM2,r=drag.centerOfPressureCgM;
      // Symmetric and positive definite (leading principal minors), as the vehicle manifest requires.
      const symmetric=c.length===9&&c.every(Number.isFinite)&&c[1]===c[3]&&c[2]===c[6]&&c[5]===c[7];
      const m1=c[0]!,m2=c[0]!*c[4]!-c[1]!*c[3]!,
        m3=c[0]!*(c[4]!*c[8]!-c[5]!*c[7]!)-c[1]!*(c[3]!*c[8]!-c[5]!*c[6]!)+c[2]!*(c[3]!*c[7]!-c[4]!*c[6]!);
      if(!symmetric||!(m1>0&&m2>0&&m3>0)||r.length!==3||!r.every(Number.isFinite)||!(drag.maxAirspeedMps>0))
        throw Error('Invalid airframe drag');
      this.dragArea=new Float64Array(c);this.dragCenter.set(r);this.dragMaxAirspeedMps=drag.maxAirspeedMps;
    } else {this.dragArea=null;this.dragMaxAirspeedMps=Infinity;}
    this.configurationFlags=flags;
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
        inflowTauS:configuration.inflowTauS[i]!,inflowLimitMps:configuration.inflowLimitMps[i]!,minimumConfidence:configuration.minimumConfidence,
        kernelOptions:configuration.kernelOptions??0};
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
      this.power=new PowerTelemetry(n);this.capacityAh=drive.battery.capacityAh;
      this.limits=new LimitMonitor(n,configuration.limitRatings??null,drive.motors.map(m=>m.currentLimitA),
        drive.motors.map(m=>m.brakeCurrentLimitA),drive.battery.currentLimitA,hz);
      this.input=this.escEngine.input;this.output=this.escEngine.output;this.inputStride=BOUND_V2_INPUT_DOUBLES;this.outputStride=BOUND_V2_OUTPUT_SLOTS;
    } else {
      if(configuration.limitRatings)throw Error('Limit ratings need the ESC drive');
      this.engine=new BetRotorEngine(module,definitions,hz);this.escEngine=null;this.bus=null;this.initialSoc=1;this.housePowerW=0;
      this.power=null;this.limits=null;this.capacityAh=0;
      this.input=this.engine.input;this.output=this.engine.output;this.inputStride=13;this.outputStride=16;
    }
    this.body=new BetRigidBodyBackend(new WebAssembly.Instance(module,{}),model.massKg,model.inertiaBodyKgM2,configuration.gravityMps2??9.80665);
    const parts=configuration.contactParts;
    if(parts&&(!contact||parts.length!==(contact.shapeCount??0)))throw Error('Contact parts must name every contact shape');
    this.accidents=parts&&parts.length>0?new AccidentMonitor(this,parts,model.rotors.map(r=>r.id),model.massKg):null;
    this.initial=structuredClone(configuration.initialBody);
    this.frame=new FrameLayout(model);this.rotations=new Float64Array(n*9);this.positions=new Float64Array(n*3);
    this.channels=new Uint32Array(n);this.hub=new Float64Array(n*6);
    this.mix=new Float64Array(configuration.pilotMix);this.torque=new Float64Array(configuration.motorMaxTorqueNm);
    if(!this.mix.every(Number.isFinite) || !this.torque.every(v=>Number.isFinite(v)&&v>=0))throw Error('Invalid BET mixer/torque');
    this.atmosphere=new Float64Array([configuration.densityKgM3,configuration.viscosityPaS,configuration.soundMps]);
    if(!this.atmosphere.every(Number.isFinite) || this.atmosphere[0]!<0.05 || this.atmosphere[0]!>2 ||
        this.atmosphere[1]!<=0 || this.atmosphere[2]!<=0)throw Error('Invalid BET atmosphere');
    this.gravityMps2=configuration.gravityMps2??9.80665;
    const origin=configuration.originAir;
    if(origin) {
      const reference=new Float64Array([origin.temperatureK,origin.pressurePa,0]),probe=new Float64Array(5);
      if(!atmosphereAtHeightInto(reference,probe))throw Error('The origin air lies outside the atmosphere envelope');
      this.originAir=reference;
    } else this.originAir=null;
    this.baseAtmosphere=new Float64Array(this.atmosphere);
    this.gust=new Wind({meanNedMps:[0,0,0],gustRmsMps:0,bandwidthHz:WEATHER_GUST_BANDWIDTH_HZ,hz},0);
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
    this.engine?.reset();this.escEngine?.reset();this.body.reset(this.initial);this.contact?.reset(this.initial);
    const e=this.electrical;e[0]=this.initialSoc;e[2]=0;this.busLimited=false;this.driveLimited=false;
    // Before the first bus step the motors see the unloaded pack.
    e[1]=this.bus?this.bus.openCircuitV(this.initialSoc):0;
    this.truth.positionNedM.set(this.initial.positionNedM);this.truth.velocityNedMps.set(this.initial.velocityNedMps);
    this.truth.quaternionBodyToNed.set(this.initial.quaternionBodyToNed);this.truth.angularVelocityBodyRadS.set(this.initial.angularVelocityBodyRadS);
    this.truth.accelerationNedMps2.fill(0);this.angularAcceleration.fill(0);Object.assign(this.state,newState());this.state.batteryVoltage=e[1]!;
    this.state.flags=StateFlag.InputFailsafe;this.pendingActuator=false;this.externalArmed=false;this.fault='';this.validityFlags=this.configurationFlags;
    this.referenceRotorRpm=this.output[9]!*60/(2*Math.PI);
    this.limits?.reset();this.accidents?.reset();
    // A new epoch starts without weather, as configured; with an origin air (TASK-148) at the initial CG height.
    this.weatherActive=false;this.windNedMps.fill(0);this.atmosphere.set(this.baseAtmosphere);
    if(this.originAir){this.airReference.set(this.originAir);this.updateAir();}
    this.dragWrenchBody.fill(0);
    const t=this.power;
    if(t) {
      t.clear();
      for(let i=0;i<this.rotorCount;i++)t.motors[i*MotorColumn.stride+MotorColumn.Rpm]=this.output[i*this.outputStride+9]!*60/(2*Math.PI);
      t.battery[BatteryColumn.StateOfCharge]=e[0]!;t.battery[BatteryColumn.VoltageV]=e[1]!;
      t.battery[BatteryColumn.RemainingAh]=e[0]*this.capacityAh;t.battery[BatteryColumn.CapacityAh]=this.capacityAh;
    }
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
  /**
   * Applies a weather.set at its tick boundary (TASK-093) from `weather` (the WEATHER_* slots of atmosphere.ts): the mean
   * wind and a seeded synthetic gust in the envelope of Wind, and the air at the origin, which must lie in the atmosphere
   * envelope there and at the CG. Returns why not, or null; a refused weather changes nothing. Allocation-free.
   */
  setWeather(weather:Float64Array):string|null {
    const rms=weather[WEATHER_GUST_RMS]!,seed=weather[WEATHER_SEED]!,c=this.candidate,air=this.candidateAir;
    for(let axis=0;axis<3;axis++)if(!(Math.abs(weather[axis]!)<=200))return WIND_OUT_OF_ENVELOPE;
    if(!(rms>=0&&rms<=50)||!(seed>=0&&seed<=0xffffffff&&seed===Math.floor(seed)))return WIND_OUT_OF_ENVELOPE;
    c[AIR_REFERENCE_TEMPERATURE]=weather[WEATHER_TEMPERATURE]!;c[AIR_REFERENCE_PRESSURE]=weather[WEATHER_PRESSURE]!;
    c[AIR_HEIGHT]=0;if(!atmosphereAtHeightInto(c,air))return AIR_OUT_OF_ENVELOPE;
    c[AIR_HEIGHT]=-this.truth.positionNedM[2]!;if(!atmosphereAtHeightInto(c,air))return AIR_OUT_OF_ENVELOPE;
    this.airReference.set(c);this.air.set(air);
    const a=this.atmosphere;a[0]=air[AIR_DENSITY]!;a[1]=air[AIR_VISCOSITY]!;a[2]=air[AIR_SOUND]!;
    this.gust.configure(weather);
    this.weatherActive=true;
    return null;
  }
  stepNow(pilot:PilotInput):void {
    if(this.fault!=='')return;
    // TASK-093: the wind of this tick, one uniform field at the CG and every rotor hub; the air was set for this height.
    if(this.weatherActive)this.gust.stepInto(this.windNedMps);
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
    this.validityFlags=this.configurationFlags;this.samplingFlags=0;
    const output=this.output,stride=this.outputStride;let terminalPowerW=0;this.driveLimited=false;
    for(let i=0;i<this.rotorCount;i++) {
      const a=i*stride,b=i*6;
      for(let j=0;j<3;j++){this.hub[b+j]=output[a+j]!;this.hub[b+3+j]=output[a+6+j]!;}
      const flags=output[a+14]!;
      if(esc) {
        terminalPowerW+=output[a+21]!; // electrical_power (record byte 160)
        if((flags&BOUND_V2.flagCurrentLimited)!==0)this.driveLimited=true;
        this.validityFlags|=flags&~(BOUND_V2.flagCurrentLimited|SAMPLING_FLAGS);
      } else this.validityFlags|=flags&~SAMPLING_FLAGS;
      this.samplingFlags|=flags&SAMPLING_FLAGS;
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
    if(!this.frame.sumInto(this.hub,this.wrench)){this.fault='BET body integration failed';return;}
    if(this.dragArea){
      // TASK-096: F = ½·ρ·|u|·(C_D·A)·u with u = (fx, fy, fz), the air's velocity past the body at the step's midpoint: −v_a.
      const c=this.dragArea,k=0.5*this.atmosphere[0]!*Math.sqrt(fx*fx+fy*fy+fz*fz),r=this.dragCenter,d=this.dragWrenchBody,w=this.wrench;
      const dx=k*(c[0]!*fx+c[1]!*fy+c[2]!*fz),dy=k*(c[3]!*fx+c[4]!*fy+c[5]!*fz),dz=k*(c[6]!*fx+c[7]!*fy+c[8]!*fz);
      d[0]=dx;d[1]=dy;d[2]=dz;d[3]=r[1]!*dz-r[2]!*dy;d[4]=r[2]!*dx-r[0]!*dz;d[5]=r[0]!*dy-r[1]!*dx;
      for(let i=0;i<6;i++)w[i]=w[i]!+d[i]!;
      if(fx*fx+fy*fy+fz*fz>this.dragMaxAirspeedMps*this.dragMaxAirspeedMps)this.validityFlags|=VALIDITY_FLAG_DRAG_OUTSIDE_RANGE;
    }
    // TASK-095: with a contact, Rapier alone integrates the body, gravity and ground reaction included.
    if(this.contact){
      if(!this.contact.stepInto(this.wrench,this.dt,this.truth)){this.fault='Contact step failed';return;}
    } else if(!this.body.stepInto(this.wrench,this.dt,this.truth)){
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
    if(this.power&&this.bus)this.recordPower(this.power,this.bus.output,s.tick);
    this.copyTruth();
    if((this.weatherActive||this.originAir!==null)&&!this.updateAir())this.fault='BET atmosphere outside its envelope';
  }
  /** TASK-093: the ISA air at the CG's new height, for the next step's rotors and the session's published pressure. */
  private updateAir():boolean {
    const q=this.airReference,air=this.air;q[AIR_HEIGHT]=-this.truth.positionNedM[2]!;
    if(!atmosphereAtHeightInto(q,air))return false;
    const a=this.atmosphere;a[0]=air[AIR_DENSITY]!;a[1]=air[AIR_VISCOSITY]!;a[2]=air[AIR_SOUND]!;
    return true;
  }
  /** TASK-146: electrical telemetry of this step and its limit masks; reads only, never changes physics. */
  private recordPower(t:PowerTelemetry,bus:Float64Array,tick:number):void {
    const m=t.motors,output=this.output,input=this.input,e=this.electrical,stride=this.outputStride;
    for(let i=0;i<this.rotorCount;i++) {
      const a=i*stride,b=i*MotorColumn.stride;
      m[b+MotorColumn.Rpm]=output[a+9]!*60/(2*Math.PI);
      m[b+MotorColumn.MotorCurrentA]=output[a+19]!; // motor_current (record byte 144)
      m[b+MotorColumn.BusCurrentA]=output[a+20]!; // bus_current (record byte 152)
      m[b+MotorColumn.ElectricalPowerW]=output[a+21]!; // electrical_power (record byte 160)
      m[b+MotorColumn.Command]=input[i*this.inputStride+13]!; // esc_duty as the ESC received it
      t.motorLimited[i]=(output[a+14]!&BOUND_V2.flagCurrentLimited)!==0?MotorLimited.CurrentLimit:0;
    }
    const b=t.battery;
    b[BatteryColumn.StateOfCharge]=e[0]!;b[BatteryColumn.VoltageV]=e[1]!;b[BatteryColumn.CurrentA]=e[2]!;
    b[BatteryColumn.PowerW]=e[1]!*e[2]!;b[BatteryColumn.RemainingAh]=e[0]!*this.capacityAh;
    // The bus flags word (slot 6) is read here, not passed: V8 can box a double call argument.
    const flags=bus[6]!;
    t.batteryMasks[1]=((flags&1)!==0?BatteryLimited.PackCurrent:0)|((flags&2)!==0?BatteryLimited.Charge:0);
    this.limits?.evaluate(t,tick);
  }
  private copyTruth():void {
    const s=this.state,t=this.truth;
    s.north=t.positionNedM[0]!;s.east=t.positionNedM[1]!;s.down=t.positionNedM[2]!;
    s.vn=t.velocityNedMps[0]!;s.ve=t.velocityNedMps[1]!;s.vd=t.velocityNedMps[2]!;
    s.qw=t.quaternionBodyToNed[0]!;s.qx=t.quaternionBodyToNed[1]!;s.qy=t.quaternionBodyToNed[2]!;s.qz=t.quaternionBodyToNed[3]!;
    s.p=t.angularVelocityBodyRadS[0]!;s.q=t.angularVelocityBodyRadS[1]!;s.r=t.angularVelocityBodyRadS[2]!;
    s.an=t.accelerationNedMps2[0]!;s.ae=t.accelerationNedMps2[1]!;s.ad=t.accelerationNedMps2[2]!;
  }
  /** The contact's hull and propeller shapes (TASK-095); 0 without a contact or shapes. */
  get contactShapeCount():number {return this.contact?.shapeCount??0;}
  /** Rotor `index`'s speed after the last step, rad/s; cold, as a boxed return. */
  rotorSpeedRadS(index:number):number {return this.output[index*this.outputStride+9]!;}
  /** Every rotor's speed after the last step, rad/s, into `out` in rotor order (TASK-149); allocation-free. */
  rotorSpeedsInto(out:Float64Array):void {for(let i=0;i<this.rotorCount&&i<out.length;i++)out[i]=this.output[i*this.outputStride+9]!;}
  /** Shape `index`'s contact report of the last step (`GroundContact.shapeStateInto`); false without one. */
  contactShapeStateInto(index:number,out:Float64Array):boolean {return this.contact?.shapeStateInto?.(index,out)??false;}
  dispose():void {this.engine?.dispose();this.escEngine?.dispose();this.contact?.dispose();}
}
