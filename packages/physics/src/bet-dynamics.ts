/** Configurable rigid-rotor BET flight dynamics; one WASM body integrator owns truth. */
import { AccidentMonitor, type ContactShapePart } from './accident.ts';
import { BarometerErrors, BarometerInput, type BarometerEffectIndex } from './barometer.ts';
import { ControlFlag, INPUT_CLOCK_TOLERANCE_MS, INPUT_TIMEOUT_MS, StateFlag, ActuatorFlagV2, newState,
  type PilotInput, type PhysicsHz, type ActuatorFrameV2 } from '@mirage/protocol';
import { BetRotorEngine, ROTOR_FLAG_HOVER_SAMPLING, ROTOR_FLAG_REDUCED_PREDICTOR, type BoundPolar, type BoundRotorDefinition } from '../../wasm-bet/src/rotor.ts';
import { BOUND_V2, BOUND_V2_DRIVE_DOUBLES, BOUND_V2_INPUT_DOUBLES, BOUND_V2_OUTPUT_SLOTS, BetRotorEngineV2 } from '../../wasm-bet/src/rotor-v2.ts';
import type { RotorMapTable } from '../../wasm-bet/src/rotor-map.ts';
import { BetBus, type BusBattery } from '../../wasm-bet/src/bus.ts';
import { BetMotorV2, ThermalInput, ThermalOutput, type EscShaping, type MotorHeat } from '../../wasm-bet/src/motor-v2.ts';
import { EscDesync } from './esc-desync.ts';
import { BetRigidBodyBackend, newBodyTruth, type BodyTruth } from '../../wasm-bet/src/backend.ts';
import type { MotorFaults } from './motor-fault.ts';
import { validateModelManifest } from './model-manifest.ts';
import { FrameLayout } from './frame.ts';
import { RotorWakeCoupler, type RotorWakeConfiguration } from './rotor-wake.ts';
import { TERRAIN_REJECTED, standOnPlane, type GroundLattice, type TerrainContactCoupler } from './terrain-contact.ts';
import { AIR_DENSITY, AIR_HEIGHT, AIR_REFERENCE_PRESSURE, AIR_REFERENCE_TEMPERATURE, AIR_SOUND, AIR_VISCOSITY, WEATHER_AIR_KEEP, WEATHER_GUST_BANDWIDTH, WEATHER_GUST_RMS, WEATHER_PRESSURE, WEATHER_TURBULENCE_INTENSITY, WEATHER_TURBULENCE_KEEP, WEATHER_TURBULENCE_SEED, WEATHER_TURBULENCE_W20,
  WEATHER_SEED, WEATHER_TEMPERATURE, atmosphereAtHeightInto } from './atmosphere.ts';
import { Wind } from './wind.ts';
import { DiscreteGust } from './discrete-gust.ts';
import { DRYDEN_HEIGHT, DRYDEN_INPUT_SLOTS, DRYDEN_MAX_W20_MPS, DRYDEN_MEAN_EAST, DRYDEN_MEAN_NORTH, DRYDEN_RELATIVE_DOWN, DRYDEN_RELATIVE_EAST, DRYDEN_RELATIVE_NORTH, DrydenTurbulence } from './turbulence.ts';
import { BatteryColumn, LimitMonitor, MotorColumn, MotorLimited, BatteryLimited, PowerTelemetry, type LimitRatings } from './limit-monitor.ts';

/** One motor and its ESC for the production drive (TASK-092); SI units, k_t = k_e. */
export interface EscDriveMotor {
  readonly resistanceOhm: number; readonly torqueConstantNmPerA: number; readonly currentLimitA: number;
  readonly brakeCurrentLimitA: number; readonly noLoadTorqueNm: number; readonly commandTauS: number;
  /** ESC update period; 0 updates every physics step. */
  readonly updatePeriodS: number;
  /**
   * TASK-105: the ESC's command path, with `updatePeriodS` (above 0) as its frame period; the drive record then samples every
   * step. Absent, the ESC is the TASK-092 one, bit for bit.
   */
  readonly shaping?: EscShapingValues;
  /** TASK-105: the motor's heat, scaling this motor's R, k_t and no-load torque, taken as their 20 °C values. Absent, it does not heat. */
  readonly heat?: MotorHeatValues;
}
/** TASK-105: what an ESC does to its command beyond sampling it (SPECS_SIMULATION_ENGINES "ESC shaper record v1"). */
export type EscShapingValues = Omit<EscShaping, 'framePeriodS'>;
/** TASK-105: a motor's two-node thermal network (SPECS_SIMULATION_ENGINES "Motor thermal record v1"). */
export type MotorHeatValues = Omit<MotorHeat, 'resistance20cOhm' | 'torqueConstant20cNmPerA' | 'noLoadCurrentA'>;
/** The specific gas constant of dry air J/(kg K) and its ratio of specific heats, which give the air temperature a²/(γR) from the speed of sound. */
const AIR_GAS_CONSTANT = 287.05, AIR_GAMMA = 1.4;
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
   * TASK-145: the measured envelope of each calibrated rotor. A step outside any of them sets VALIDITY_FLAG_CALIBRATION_EXTRAPOLATION;
   * absent, no step checks one, bit for bit as before.
   */
  calibrationEnvelopes?: readonly CalibrationEnvelopeConfiguration[];
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
  /** TASK-098: Pitt-Peters dynamic inflow with annular tip and hub losses on every rotor. */
  dynamicInflow?: boolean;
  /** TASK-099, with `dynamicInflow`: Johnson's vortex ring state; each rotor's thrust fluctuation is seeded from this and its index. */
  vortexRingSeed?: number;
  /** TASK-103: per rotor, the table it takes its loads from, or null for the blade-element kernel. Absent is the BET on every rotor. */
  rotorMaps?: readonly (RotorMapTable | null)[];
  /** TASK-101: the wakes between rotors and on the airframe. Without it every rotor sees free-stream air. Needs the ESC drive. */
  rotorWake?: RotorWakeConfiguration;
  /** TASK-100: the ground the rotor ground effect sees; without it a flat plane at the session's ground. */
  groundPlanes?: GroundPlaneSource;
  /**
   * TASK-100: K_b of the fountain's lift on the body (Sanchez-Cuevas et al. 2017, equation (4)), switched with the ground effect;
   * 2 when absent (their thrust-stand quadrotor), 0 for none.
   */
  groundBodyLiftCoefficient?: number;
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
  /** TASK-187: makes the contact's coupler to published terrain, `attachGround`'s; without it a contact stands on level ground. */
  contactGround?: (ground: GroundLattice) => TerrainContactCoupler;
}
const copyBody=(from:BodyTruth,to:BodyTruth):void=>{
  to.positionNedM.set(from.positionNedM);to.velocityNedMps.set(from.velocityNedMps);to.quaternionBodyToNed.set(from.quaternionBodyToNed);
  to.angularVelocityBodyRadS.set(from.angularVelocityBodyRadS);to.accelerationNedMps2.set(from.accelerationNedMps2);
};
/** TASK-187: each support's normal load after the last step, N, for the recording and its contact events. */
export interface ContactLoads { readonly count: number; readonly normalN: Float64Array }
/**
 * Where the ground is under a point (TASK-100): `out` is [nN, nE, nD, offset], the unit normal pointing out of the ground and
 * `n.p - offset` the height above it; a NaN offset means no ground there. `@mirage/terrain` CollisionChunks provides it.
 */
export interface GroundPlaneSource { planeInto(position: Float64Array, out: Float64Array): void }
/**
 * TASK-100: each rotor's correction `(R/4z)^2` at its axial height, with each neighbour's
 * `(R_j^2/2) z / (D^2 + 4 z^2)^(3/2)` (Sanchez-Cuevas et al. 2017, whose quadrotor has two adjacent rotors and one diagonal).
 * `lateral` holds n x n squared lateral distances; a negative one is not a neighbour. Arrays only: a double crossing a call boxes.
 */
export function groundEffectCorrectionsInto(n:number,radius:Float64Array,heightM:Float64Array,lateral:Float64Array,out:Float64Array):void {
  for(let i=0;i<n;i++){
    const zM=heightM[i]!,own=radius[i]!/(4*zM);
    let term=own*own;
    for(let j=0;j<n;j++){
      const d2=lateral[i*n+j]!;
      if(d2<0)continue;
      const s=d2+4*zM*zM;
      term+=0.5*radius[j]!*radius[j]!*zM/(s*Math.sqrt(s));
    }
    out[i]=term;
  }
}
/**
 * TASK-100: each rotor's fountain share `K_b · 2 R^2 z / (b^2 + 4 z^2)^(3/2)` at its axial height, held at half a radius below that,
 * `opposite2` the squared distance b to the opposite rotor axis; an infinite height (no ground) gives 0. Arrays only, as above.
 */
export function bodyLiftFractionsInto(n:number,radius:Float64Array,heightM:Float64Array,opposite2:Float64Array,coefficient:number,out:Float64Array):void {
  for(let i=0;i<n;i++){
    const R=radius[i]!,h=heightM[i]!;
    if(!(h<Infinity)){out[i]=0;continue;}
    const zM=h<0.5*R?0.5*R:h,s=opposite2[i]!+4*zM*zM;
    out[i]=coefficient*2*R*R*zM/(s*Math.sqrt(s));
  }
}
/** What `BetFlightDynamics` needs of its contact; `GroundContact` provides it. */
export interface FlightContact {
  /** The contact engine's last status, for a failed step's message. */
  readonly lastStatus?:number;
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
  /** The supports and their last-step reports, slot 2 the normal load, N (TASK-187, `GroundContact`). */
  readonly wheelCount?: number;
  wheelStateInto?(index: number, out: Float64Array): boolean;
}
/** Rotor output flags of the TASK-091 opt-in modes: informational, never validity breaches. */
const SAMPLING_FLAGS=ROTOR_FLAG_HOVER_SAMPLING|ROTOR_FLAG_REDUCED_PREDICTOR;
/** A vehicle declares rotor-wake pairs that the dynamics does not model until TASK-101. */
export const CONFIGURATION_FLAG_WAKE_UNMODELED = 1 << 16;
/** The rotor flag for an inflow outside its validity; a wake outside its own says so the same way (TASK-101). */
const FLAG_INFLOW_OUTSIDE_VALIDITY = 8;
/** A step's airspeed exceeded the airframe drag data's range (TASK-096); a step flag, never a configuration flag. */
export const VALIDITY_FLAG_DRAG_OUTSIDE_RANGE = 1 << 17;
/** TASK-145: a calibrated rotor ran outside its bench data's RPM range, density or (near-zero) advance ratio, with their margins. */
export const VALIDITY_FLAG_CALIBRATION_EXTRAPOLATION = 1 << 18;

/**
 * Rotor `index` of a configuration exactly as the flight binds it: geometry, polar, inflow settings, kernel options, dynamic inflow,
 * the vortex ring seed (configuration seed plus index) and a rotor table. The flight and every off-line static solve of the same rotor
 * (TASK-145 calibration, TASK-090 bench captures) take it from here, so they cannot drift apart. Cold.
 */
export function flightRotorDefinition(configuration:BetFlightConfiguration,model:ReturnType<typeof validateModelManifest>,index:number):BoundRotorDefinition {
  const r=model.rotors[index];
  if(!r)throw Error(`The build has no rotor ${index}`);
  const polar=configuration.polars.get(r.polarId),rotorMap=configuration.rotorMaps?.[index]??null;
  if(!polar)throw Error('Missing rotor polar binding');
  const initialOmegaRadS=configuration.initialOmegaRadS[index],inflowTauS=configuration.inflowTauS[index],inflowLimitMps=configuration.inflowLimitMps[index];
  if(initialOmegaRadS===undefined||inflowTauS===undefined||inflowLimitMps===undefined)throw Error('Invalid BET flight configuration');
  return {geometry:r,polar,initialOmegaRadS,inflowTauS,inflowLimitMps,minimumConfidence:configuration.minimumConfidence,
    kernelOptions:configuration.kernelOptions??0,dynamicInflow:configuration.dynamicInflow===true,
    ...(configuration.vortexRingSeed===undefined?{}:{vortexRingSeed:configuration.vortexRingSeed+index}),
    ...(rotorMap?{rotorModel:'map' as const,rotorMap}:{})};
}
/** One calibrated rotor's envelope, margins included (SPECS_SIMULATION_ENGINES "Propulsion calibration: TASK-145"). */
export interface CalibrationEnvelopeConfiguration {
  /** Index of the rotor in the manifest's rotor order. */
  readonly rotorIndex: number;
  readonly rpmLow: number; readonly rpmHigh: number;
  readonly densityLowKgM3: number; readonly densityHighKgM3: number;
  /** The largest advance ratio V/(nD) of the airspeed at the CG. */
  readonly advanceRatioMax: number;
}

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
  /** TASK-166: the air comes from a weather's temperature and pressure rather than the configured air. */
  private weatherAir=false;
  /** True when the air follows the CG's height: a weather's air (TASK-166) is in effect, or the configuration has an origin air (TASK-148). */
  get airActive():boolean {return this.weatherAir||this.originAir!==null;}
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
  /** TASK-187: where the configuration stands on level ground, from which a start on terrain is worked out. */
  private readonly levelInitial:BodyTruth;
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
  /** TASK-106: Dryden turbulence on top of the gust, while a weather holds a W20, with its inputs in slots. */
  private readonly turbulence:DrydenTurbulence;
  /** TASK-167: the discrete gust's one-minus-cosine pulse. */
  private readonly discreteGust:DiscreteGust;
  private readonly turbulenceInput=new Float64Array(DRYDEN_INPUT_SLOTS);
  private turbulenceActive=false;
  /** TASK-096: the drag-area tensor (row-major), the center of pressure from the CG and the airspeed range, or null without drag. */
  private readonly dragArea:Float64Array|null;
  private readonly dragCenter=new Float64Array(3);
  private readonly dragMaxAirspeedMps:number;
  /** TASK-145: per calibrated rotor [index, rpm low, rpm high, density low, density high, J max, diameter]; empty without calibrations. */
  private readonly envelopes:Float64Array;
  private readonly groundDown:number|undefined;
  private readonly contact:FlightContact|null;
  /** TASK-100: the ground effect's intensity, 0 for off, and what it needs: hub lateral distances squared (negative: not a neighbour). */
  private groundIntensity=0;
  private groundPlanes:GroundPlaneSource;
  private readonly levelGround:GroundPlaneSource;
  private readonly contactGround:((ground:GroundLattice)=>TerrainContactCoupler)|null;
  private terrain:TerrainContactCoupler|null=null;
  /** TASK-187: the supports' normal loads; null without a contact that has supports. */
  readonly contactLoads:ContactLoads|null;
  private readonly supportState=new Float64Array(8);
  /** The step's midpoint attitude and each rotor's correction, in slots: a double crossing a call boxes. */
  private readonly groundAttitude=new Float64Array(4);
  private readonly groundCorrection:Float64Array;
  private readonly groundLateral:Float64Array;
  private readonly groundRadius:Float64Array;
  private readonly groundZ:Float64Array;
  private readonly groundCos:Float64Array;
  private readonly groundQuery=new Float64Array(3);
  /** TASK-100: the fountain's coefficient, each rotor's squared opposite-axis distance, unit ground normal in body axes, thrust and share. */
  private readonly groundBodyLift:number;
  private readonly groundOpposite2:Float64Array;
  private readonly groundNormalBody:Float64Array;
  private readonly groundThrust:Float64Array;
  private readonly groundLiftShare:Float64Array;
  /** TASK-100: the fountain's force on the body of the last step, N in body axes (zero without it). */
  readonly bodyLiftBodyN=new Float64Array(3);
  /** TASK-100: each rotor's height along its axis above the ground of the last ground query, m (infinite without ground). Read only. */
  get groundHeightsM():Float64Array {return this.groundZ;}
  private readonly groundPlane=new Float64Array(4);
  /** TASK-116: the pressure errors at the barometer's static port, worked out after each step while one of them is on. */
  readonly barometer=new BarometerErrors();
  private readonly barometerQuery=new Float64Array(3);
  private readonly barometerPlane=new Float64Array(4);
  private barometerDiscAreaM2=0;
  private barometerMeanRadiusM=0;
  private readonly bus:BetBus|null;
  private readonly initialSoc:number;
  private readonly housePowerW:number;
  private readonly configurationFlags:number;
  private readonly inputStride:number;
  /** TASK-101: the wakes between rotors and on the airframe, or null without any. */
  private readonly wake:RotorWakeCoupler|null;
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
  /** TASK-104: a dynamic pack's [branch 1 V, branch 2 V, temperature K]; zeros for a TASK-092 pack. */
  readonly packState=new Float64Array(3);
  /** TASK-104: the pack has dynamics. */
  private packDynamic=false;
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
  /**
   * TASK-105: the shaped ESCs and heated motors, or null with neither. Its `thermalOutput` holds each heated motor's
   * temperatures, R, k and no-load torque after the last step, in the order of `heatedIndex`.
   */
  readonly motorV2:BetMotorV2|null;
  /** TASK-105: per rotor, its record in `motorV2`'s shapers and networks, or −1. */
  readonly shapedIndex:Int32Array;
  readonly heatedIndex:Int32Array;
  /**
   * TASK-105: ESC desynchronization on the ESC drive, null without one (SPECS_SIMULATION_ENGINES "ESC desynchronization"). Its
   * `events` and `remaining` are for cold readers; the switch is `setEscDesync`.
   */
  readonly escDesync:EscDesync|null;
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
    if((flags&VALIDITY_FLAG_CALIBRATION_EXTRAPOLATION)!==0)throw Error('Bit 18 is the calibration step flag, not a configuration flag');
    const envelopes=configuration.calibrationEnvelopes??[];
    this.envelopes=new Float64Array(envelopes.length*7);
    envelopes.forEach((e,k)=>{
      const rotor=model.rotors[e.rotorIndex];
      if(!rotor||!Number.isInteger(e.rotorIndex)||envelopes.findIndex(other=>other.rotorIndex===e.rotorIndex)!==k||
          !(e.rpmLow>=0&&e.rpmHigh>e.rpmLow&&e.densityLowKgM3>0&&e.densityHighKgM3>e.densityLowKgM3&&e.advanceRatioMax>=0))
        throw Error('Invalid calibration envelope');
      this.envelopes.set([e.rotorIndex,e.rpmLow,e.rpmHigh,e.densityLowKgM3,e.densityHighKgM3,e.advanceRatioMax,2*rotor.radiusM],k*7);
    });
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
    if(configuration.rotorMaps&&configuration.rotorMaps.length!==n)throw Error('Rotor maps need one entry per rotor');
    const definitions=model.rotors.map((_,i)=>flightRotorDefinition(configuration,model,i));
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
      // TASK-105: the ESC shaper samples the frames, so a shaped rotor's drive record samples every step.
      const shaping:EscShaping[]=[],heat:MotorHeat[]=[];
      this.shapedIndex=new Int32Array(n).fill(-1);this.heatedIndex=new Int32Array(n).fill(-1);
      drive.motors.forEach((m,i)=>{
        if(m.shaping){
          if(!(m.updatePeriodS>0))throw Error('ESC shaping needs an ESC update period');
          this.shapedIndex[i]=shaping.length;shaping.push({framePeriodS:m.updatePeriodS,...m.shaping});
          esc.drive[i*BOUND_V2_DRIVE_DOUBLES+6]=0;
        }
        if(m.heat){
          this.heatedIndex[i]=heat.length;
          heat.push({...m.heat,resistance20cOhm:m.resistanceOhm,torqueConstant20cNmPerA:m.torqueConstantNmPerA,noLoadCurrentA:m.noLoadTorqueNm/m.torqueConstantNmPerA});
        }
      });
      this.motorV2=shaping.length+heat.length>0?new BetMotorV2(module,shaping,heat,hz):null;
      this.escDesync=new EscDesync(n,hz);
      this.escEngine=esc;this.engine=null;
      this.bus=new BetBus(module,drive.battery,hz);esc.attachBattery(drive.battery);this.initialSoc=soc;this.housePowerW=house;
      this.packDynamic=drive.battery.dynamics!==undefined;
      this.power=new PowerTelemetry(n);this.capacityAh=drive.battery.capacityAh;
      this.limits=new LimitMonitor(n,configuration.limitRatings??null,drive.motors.map(m=>m.currentLimitA),
        drive.motors.map(m=>m.brakeCurrentLimitA),drive.battery.currentLimitA,hz);
      this.input=this.escEngine.input;this.output=this.escEngine.output;this.inputStride=BOUND_V2_INPUT_DOUBLES;this.outputStride=BOUND_V2_OUTPUT_SLOTS;
    } else {
      if(configuration.limitRatings)throw Error('Limit ratings need the ESC drive');
      this.motorV2=null;this.shapedIndex=new Int32Array(n).fill(-1);this.heatedIndex=new Int32Array(n).fill(-1);this.escDesync=null;
      this.engine=new BetRotorEngine(module,definitions,hz);this.escEngine=null;this.bus=null;this.initialSoc=1;this.housePowerW=0;
      this.power=null;this.limits=null;this.capacityAh=0;
      this.input=this.engine.input;this.output=this.engine.output;this.inputStride=13;this.outputStride=16;
    }
    this.body=new BetRigidBodyBackend(new WebAssembly.Instance(module,{}),model.massKg,model.inertiaBodyKgM2,configuration.gravityMps2??9.80665);
    const parts=configuration.contactParts;
    if(parts&&(!contact||parts.length!==(contact.shapeCount??0)))throw Error('Contact parts must name every contact shape');
    this.accidents=parts&&parts.length>0?new AccidentMonitor(this,parts,model.rotors.map(r=>r.id),model.massKg):null;
    this.initial=structuredClone(configuration.initialBody);this.levelInitial=structuredClone(configuration.initialBody);
    const supports=contact?.wheelCount??0;
    this.contactLoads=supports>0?{count:supports,normalN:new Float64Array(supports)}:null;
    this.contactGround=configuration.contactGround??null;
    this.frame=new FrameLayout(model);this.rotations=new Float64Array(n*9);this.positions=new Float64Array(n*3);
    const flatDown=configuration.syntheticGroundDownM??0;
    this.levelGround=configuration.groundPlanes??{planeInto:(_position,out)=>{out[0]=0;out[1]=0;out[2]=-1;out[3]=-flatDown;}};
    this.groundPlanes=this.levelGround;
    this.groundLateral=new Float64Array(n*n);this.groundRadius=new Float64Array(n);this.groundZ=new Float64Array(n);this.groundCos=new Float64Array(n);this.groundCorrection=new Float64Array(n);
    const bodyLift=configuration.groundBodyLiftCoefficient??2;
    if(!Number.isFinite(bodyLift)||bodyLift<0)throw Error('Invalid ground body lift coefficient');
    this.groundBodyLift=bodyLift;
    this.groundOpposite2=new Float64Array(n);this.groundNormalBody=new Float64Array(n*3);this.groundThrust=new Float64Array(n);this.groundLiftShare=new Float64Array(n);
    {
      // b = 2 rho, rho the hub's lateral distance from the hubs' centroid: the paper's diagonal on a symmetric quadrotor.
      let cx=0,cy=0;
      for(const rotor of model.rotors){cx+=rotor.hubPositionBodyM[0]!/n;cy+=rotor.hubPositionBodyM[1]!/n;}
      model.rotors.forEach((rotor,i)=>{const dx=rotor.hubPositionBodyM[0]!-cx,dy=rotor.hubPositionBodyM[1]!-cy;this.groundOpposite2[i]=4*(dx*dx+dy*dy);});
    }
    model.rotors.forEach((rotor,i)=>{
      this.groundRadius[i]=rotor.radiusM;
      this.barometerDiscAreaM2+=Math.PI*rotor.radiusM*rotor.radiusM;this.barometerMeanRadiusM+=rotor.radiusM/n;
      model.rotors.forEach((other,j)=>{
        const dx=rotor.hubPositionBodyM[0]!-other.hubPositionBodyM[0]!,dy=rotor.hubPositionBodyM[1]!-other.hubPositionBodyM[1]!,d2=dx*dx+dy*dy;
        // A rotor nearer than half a radius, a coaxial partner among them, is not a neighbour here (TASK-101 owns that pair).
        this.groundLateral[i*n+j]=i!==j&&d2>=0.25*rotor.radiusM*rotor.radiusM?d2:-1;
      });
    });
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
    this.turbulence=new DrydenTurbulence(hz);
    this.discreteGust=new DiscreteGust(hz);
    for(let i=0;i<n;i++) {
      const r=model.rotors[i]!,q=r.hubToBody,norm=Math.sqrt(q[0]!**2+q[1]!**2+q[2]!**2+q[3]!**2);
      const w=q[0]!/norm,x=q[1]!/norm,y=q[2]!/norm,z=q[3]!/norm;
      // Model validation establishes all tuple lengths, station bounds and channels.
      this.channels[i]=r.motorChannel;this.positions.set(r.hubPositionBodyM,i*3);
      this.rotations.set([1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y),
        2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x),2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)],i*9);
    }
    const wakes=configuration.rotorWake;
    if(wakes&&!this.escEngine)throw Error('Rotor wakes need the ESC drive');
    this.wake=wakes?new RotorWakeCoupler({hubPositionsBodyM:this.positions,hubToBody:this.rotations,radiiM:Float64Array.from(model.rotors,r=>r.radiusM)},wakes):null;
    this.reset();
  }
  /** TASK-101: the rotor wakes, read by tests and by the capacity report's reader. */
  get rotorWakes():RotorWakeCoupler|null {return this.wake;}
  /**
   * TASK-105: ESC desynchronization from this tick, from the slots of `EscDesyncSlot`; false, changing nothing, for values outside its
   * ranges. Only the ESC drive has it. Allocation-free.
   */
  get setEscDesync():((values:Float64Array)=>boolean)|undefined {return this.escDesync?this.applyEscDesync:undefined;}
  private readonly applyEscDesync=(values:Float64Array):boolean=>this.escDesync!.set(values);
  /** TASK-100: the ground effect's intensity now, 0 for off. */
  get groundEffectIntensity():number {return this.groundIntensity;}
  /** TASK-100: the rotor ground effect's intensity from this step, 0 for off. Only the ESC drive's interface has its fields. */
  get setGroundEffect():((intensity:number)=>void)|undefined {return this.escEngine?this.applyGroundEffect:undefined;}
  private readonly applyGroundEffect=(intensity:number):void=>{
    this.groundIntensity=intensity;
    if(intensity===0)this.clearGroundEffect();
  };
  /** Back to neutral fields, so that off is what a run without the effect does. */
  private clearGroundEffect():void {
    this.groundIntensity=0;
    this.bodyLiftBodyN.fill(0);this.groundLiftShare.fill(0);
    const esc=this.escEngine;
    if(!esc)return;
    for(let i=0;i<this.rotorCount;i++){
      esc.inputFlags[i]=0;
      const b=i*this.inputStride;
      for(let k=18;k<22;k++)this.input[b+k]=0;
    }
  }
  /** The ground plane under each hub, the effect's height and the normal in hub axes, written to the rotor records. */
  /**
   * TASK-187: the published terrain a real-terrain run stands on, or null for level ground. Its planes reach the contact and the rotor
   * ground effect, and a start stands on the slope under it. Before a run: this resets the dynamics. Cold path.
   */
  attachGround(ground:GroundLattice|null):void {
    this.terrain=ground&&this.contact&&this.contactGround?this.contactGround(ground):null;
    this.groundPlanes=ground??this.levelGround;
    copyBody(this.levelInitial,this.initial);
    if(ground&&this.terrain){
      const start=this.levelInitial.positionNedM,plane=new Float64Array(4);
      ground.planeInto(Float64Array.of(start[0]!,start[1]!,0),plane);
      if(Number.isFinite(plane[3]))standOnPlane(this.levelInitial,plane,this.initial);
    }
    this.reset();
  }
  private groundInto():void {
    const esc=this.escEngine,n=this.rotorCount,p=this.positions,r=this.rotations,input=this.input,plane=this.groundPlane,query=this.groundQuery;
    const position=this.truth.positionNedM,lateral=this.groundLateral,radius=this.groundRadius,heights=this.groundZ,cosines=this.groundCos,corrections=this.groundCorrection;
    const attitude=this.groundAttitude,w=attitude[0]!,x=attitude[1]!,y=attitude[2]!,z=attitude[3]!;
    if(!esc)return;
    // (w, x, y, z) turns NED into body, as for the air's velocity in the step; the body-to-NED matrix is its transpose.
    for(let i=0;i<n;i++){
      const c=i*3,bx=p[c]!,by=p[c+1]!,bz=p[c+2]!;
      // The conjugate of (w, x, y, z) turns body into NED: v + 2 w s + 2 q x s, with s = q x v.
      const qx=-x,qy=-y,qz=-z,sx=qy*bz-qz*by,sy=qz*bx-qx*bz,sz=qx*by-qy*bx;
      query[0]=position[0]!+bx+2*(w*sx+qy*sz-qz*sy);query[1]=position[1]!+by+2*(w*sy+qz*sx-qx*sz);query[2]=position[2]!+bz+2*(w*sz+qx*sy-qy*sx);
      this.groundPlanes.planeInto(query,plane);
      const offset=plane[3]!;
      if(!Number.isFinite(offset)){cosines[i]=0;heights[i]=Infinity;esc.inputFlags[i]=0;for(let k=18;k<22;k++)input[i*this.inputStride+k]=0;continue;}
      const nN=plane[0]!,nE=plane[1]!,nD=plane[2]!,height=nN*query[0]+nE*query[1]+nD*query[2]-offset;
      // The normal in body axes, then in hub axes.
      const cx=y*nD-z*nE,cy=z*nN-x*nD,cz=x*nE-y*nN;
      const fx=nN+2*(w*cx+y*cz-z*cy),fy=nE+2*(w*cy+z*cx-x*cz),fz=nD+2*(w*cz+x*cy-y*cx);
      const a=i*9,b=i*this.inputStride;
      const hx=r[a]!*fx+r[a+3]!*fy+r[a+6]!*fz,hy=r[a+1]!*fx+r[a+4]!*fy+r[a+7]!*fz,hz=r[a+2]!*fx+r[a+5]!*fy+r[a+8]!*fz;
      input[b+18]=hx;input[b+19]=hy;input[b+20]=hz;
      const nb=this.groundNormalBody;nb[c]=fx;nb[c+1]=fy;nb[c+2]=fz;
      cosines[i]=hz;
      heights[i]=hz>0?height/hz:Infinity;
      esc.inputFlags[i]=1;
    }
    // The height whose (R/4z)^2 is the correction: the rotor's own, the neighbours' (Sanchez-Cuevas et al. 2017), and the intensity.
    const intensity=this.groundIntensity;
    groundEffectCorrectionsInto(n,radius,heights,lateral,corrections);
    for(let i=0;i<n;i++){
      if(esc.inputFlags[i]===0)continue;
      const b=i*this.inputStride,R=radius[i]!,zi=heights[i]!;
      const term=intensity*corrections[i]!;
      const effective=term>0?R/(4*Math.sqrt(term)):Infinity;
      // Below the envelope the record says so, whatever the intensity.
      const reported=zi<0.5*R?Math.min(effective,zi):effective;
      input[b+21]=Number.isFinite(reported)?reported*cosines[i]!:1e9;
    }
    // The fountain's share of each rotor's thrust, scaled by the intensity; a rotor without ground under it has an infinite height.
    if(this.groundBodyLift>0){
      const share=this.groundLiftShare;
      bodyLiftFractionsInto(n,radius,heights,this.groundOpposite2,this.groundBodyLift,share);
      for(let i=0;i<n;i++)share[i]=esc.inputFlags[i]===0?0:intensity*share[i]!;
    }
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
    this.limits?.reset();this.accidents?.reset();this.contactLoads?.normalN.fill(0);this.barometer.reset();
    this.clearGroundEffect();
    if(this.wake){this.wake.reset();for(let i=0;i<this.rotorCount;i++){const b=i*this.inputStride;this.input[b+15]=0;this.input[b+16]=0;this.input[b+17]=0;}}
    // A new epoch starts without weather, as configured; with an origin air (TASK-148) at the initial CG height.
    this.turbulenceActive=false;this.weatherActive=false;this.windNedMps.fill(0);this.discreteGust.stop();this.restoreConfiguredAir();
    // TASK-104: a dynamic pack starts relaxed, at the air's temperature.
    const air=this.atmosphere[2]!;this.packState[0]=0;this.packState[1]=0;this.packState[2]=this.packDynamic?air*air/(AIR_GAMMA*AIR_GAS_CONSTANT):0;
    this.dragWrenchBody.fill(0);
    this.resetMotorV2();
    this.escDesync?.reset();
    const t=this.power;
    if(t) {
      t.clear();
      for(let i=0;i<this.rotorCount;i++)t.motors[i*MotorColumn.stride+MotorColumn.Rpm]=this.output[i*this.outputStride+9]!*60/(2*Math.PI);
      t.battery[BatteryColumn.StateOfCharge]=e[0]!;t.battery[BatteryColumn.VoltageV]=e[1]!;
      t.battery[BatteryColumn.RemainingAh]=e[0]*this.capacityAh;t.battery[BatteryColumn.CapacityAh]=this.capacityAh;
      t.battery[BatteryColumn.TemperatureK]=this.packState[2]!;
    }
    this.copyTruth();
  }
  /** TASK-105: the motors at the air's temperature and their drive records at it; the shapers at rest. Cold. */
  private resetMotorV2():void {
    const mv=this.motorV2,esc=this.escEngine;
    if(!mv||!esc)return;
    const a=this.atmosphere[2]!;
    mv.reset(a*a/(AIR_GAMMA*AIR_GAS_CONSTANT)-273.15);
    this.applyHeat();
  }
  /** TASK-105: each heated motor's R, k_t and no-load torque from its network into its drive record, for the next step. */
  private applyHeat():void {
    const mv=this.motorV2!,drive=this.escEngine!.drive,out=mv.thermalOutput,index=this.heatedIndex;
    for(let i=0;i<this.rotorCount;i++){
      const k=index[i]!;
      if(k<0)continue;
      const o=k*ThermalOutput.Stride,d=i*BOUND_V2_DRIVE_DOUBLES;
      drive[d]=out[o+ThermalOutput.ResistanceOhm]!;drive[d+1]=out[o+ThermalOutput.TorqueConstantNmPerA]!;drive[d+4]=out[o+ThermalOutput.NoLoadTorqueNm]!;
    }
  }
  /**
   * TASK-105: each heated motor's network over the step just taken: its copper loss, its shaft speed, the air's temperature from its
   * speed of sound, and the air past it, the hub's air plus the hover induced velocity of the rotor's thrust.
   */
  private heatMotors():boolean {
    const mv=this.motorV2!,ti=mv.thermalInput,output=this.output,input=this.input,index=this.heatedIndex,stride=this.outputStride;
    const a=this.atmosphere[2]!,rho=this.atmosphere[0]!,airC=a*a/(AIR_GAMMA*AIR_GAS_CONSTANT)-273.15,radius=this.groundRadius;
    for(let i=0;i<this.rotorCount;i++){
      const k=index[i]!;
      if(k<0)continue;
      const o=i*stride,b=i*this.inputStride,t=k*ThermalInput.Stride,r=radius[i]!;
      const ax=input[b+3]!,ay=input[b+4]!,az=input[b+5]!,thrust=Math.abs(output[o+2]!);
      ti[t+ThermalInput.CopperLossW]=output[o+22]!; // copper_loss (record byte 168)
      ti[t+ThermalInput.ShaftSpeedRadS]=Math.abs(output[o+9]!);
      ti[t+ThermalInput.AirC]=airC;
      ti[t+ThermalInput.AirspeedMps]=Math.sqrt(ax*ax+ay*ay+az*az)+Math.sqrt(thrust/(2*rho*Math.PI*r*r));
    }
    if(!mv.heatFromInput())return false;
    this.applyHeat();
    return true;
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
    const rms=weather[WEATHER_GUST_RMS]!,seed=weather[WEATHER_SEED]!,bandwidth=weather[WEATHER_GUST_BANDWIDTH]!,c=this.candidate,air=this.candidateAir;
    for(let axis=0;axis<3;axis++)if(!(Math.abs(weather[axis]!)<=200))return WIND_OUT_OF_ENVELOPE;
    if(!(rms>=0&&rms<=50)||!(seed>=0&&seed<=0xffffffff&&seed===Math.floor(seed)))return WIND_OUT_OF_ENVELOPE;
    // Zero keeps the bandwidth; otherwise the first-order filter must be resolvable and below Nyquist, as the gust model's constructor requires.
    if(!(bandwidth>=0&&bandwidth<this.hz/2)||(bandwidth>0&&!(Math.exp(-2*Math.PI*bandwidth/this.hz)<1)))return WIND_OUT_OF_ENVELOPE;
    const w20=weather[WEATHER_TURBULENCE_W20]!,turbulenceSeed=weather[WEATHER_TURBULENCE_SEED]!;
    if(!(w20>=0&&w20*weather[WEATHER_TURBULENCE_INTENSITY]!<=DRYDEN_MAX_W20_MPS&&w20<=DRYDEN_MAX_W20_MPS)||!(turbulenceSeed>=0&&turbulenceSeed<=0xffffffff&&turbulenceSeed===Math.floor(turbulenceSeed)))return WIND_OUT_OF_ENVELOPE;
    // TASK-167: the discrete gust's peak and duration.
    if(!DiscreteGust.admits(weather))return WIND_OUT_OF_ENVELOPE;
    if(weather[WEATHER_AIR_KEEP]===1){
      // TASK-166: the weather leaves the air as configured: the location's origin air (TASK-148) or the configured atmosphere.
      this.restoreConfiguredAir();
    }else{
      c[AIR_REFERENCE_TEMPERATURE]=weather[WEATHER_TEMPERATURE]!;c[AIR_REFERENCE_PRESSURE]=weather[WEATHER_PRESSURE]!;
      c[AIR_HEIGHT]=0;if(!atmosphereAtHeightInto(c,air))return AIR_OUT_OF_ENVELOPE;
      c[AIR_HEIGHT]=-this.truth.positionNedM[2]!;if(!atmosphereAtHeightInto(c,air))return AIR_OUT_OF_ENVELOPE;
      this.airReference.set(c);this.air.set(air);
      const a=this.atmosphere;a[0]=air[AIR_DENSITY]!;a[1]=air[AIR_VISCOSITY]!;a[2]=air[AIR_SOUND]!;
      this.weatherAir=true;
    }
    this.gust.configure(weather);
    if(w20>0){
      this.turbulence.setStrengthFrom(weather,WEATHER_TURBULENCE_W20,WEATHER_TURBULENCE_INTENSITY);
      if(!this.turbulenceActive||weather[WEATHER_TURBULENCE_KEEP]!==1)this.turbulence.restartFrom(weather,WEATHER_TURBULENCE_SEED);
      this.turbulenceActive=true;
    }else this.turbulenceActive=false;
    this.discreteGust.configure(weather);
    this.weatherActive=true;
    return null;
  }
  /** TASK-116: one barometer effect on, with its values (intensity applied), or off, from this tick. Allocation-free. */
  setBarometer(effect:BarometerEffectIndex,active:boolean,values:ArrayLike<number>):void {this.barometer.set(effect,active,values);}
  /**
   * The barometer's inputs after a step: the air at the CG, the vehicle's velocity through the air in body axes (the
   * step's midpoint, as the drag uses, written by the caller), the CG's height above the ground below it, and the rotors' thrust. The static
   * port is taken at the CG. Allocation-free.
   */
  private stepBarometer():void {
    const x=this.barometer.input,a=this.atmosphere,position=this.truth.positionNedM,query=this.barometerQuery,plane=this.barometerPlane;
    x[BarometerInput.DensityKgM3]=a[0]!;
    // T = a²/(γR) with atmosphere.ts's γ = 1.4 and R = 287.05287 J/(kg·K).
    x[BarometerInput.TemperatureK]=a[2]!*a[2]!/(1.4*287.05287);
    query[0]=position[0]!;query[1]=position[1]!;query[2]=position[2]!;
    this.groundPlanes.planeInto(query,plane);
    const offset=plane[3]!;
    x[BarometerInput.HeightM]=Number.isFinite(offset)?plane[0]!*query[0]+plane[1]!*query[1]+plane[2]!*query[2]-offset:Infinity;
    let thrust=0;const output=this.output,stride=this.outputStride;
    for(let i=0;i<this.rotorCount;i++){const f=output[i*stride+2]!;if(f>0)thrust+=f;}
    x[BarometerInput.ThrustN]=thrust;x[BarometerInput.DiscAreaM2]=this.barometerDiscAreaM2;x[BarometerInput.MeanRadiusM]=this.barometerMeanRadiusM;
    x[BarometerInput.TimeS]=this.state.tick/this.hz;
    this.barometer.step();
  }
  /** TASK-166: back to no weather at a tick boundary: still air and the configured air, as an epoch that never had any. */
  clearWeather():void {
    this.turbulenceActive=false;this.weatherActive=false;this.windNedMps.fill(0);this.discreteGust.stop();this.restoreConfiguredAir();
  }
  /**
   * The air as configured, without a weather's: the location's origin air at the CG's height (TASK-148), or the
   * configured atmosphere. Allocation-free.
   */
  private restoreConfiguredAir():void {
    this.weatherAir=false;
    if(this.originAir){this.airReference.set(this.originAir);this.updateAir();}else this.atmosphere.set(this.baseAtmosphere);
  }
  stepNow(pilot:PilotInput):void {
    if(this.fault!=='')return;
    // TASK-093: the wind of this tick, one uniform field at the CG and every rotor hub; the air was set for this height.
    if(this.weatherActive){
      this.gust.stepInto(this.windNedMps);
      if(this.turbulenceActive){
        // The speed it is carried past at is relative to this tick's mean flow, before the turbulence is added.
        const t=this.turbulenceInput,air=this.windNedMps,ground=this.truth.velocityNedMps,mean=this.gust.mean;
        t[DRYDEN_HEIGHT]=-this.truth.positionNedM[2]!;t[DRYDEN_RELATIVE_NORTH]=air[0]!-ground[0]!;t[DRYDEN_RELATIVE_EAST]=air[1]!-ground[1]!;t[DRYDEN_RELATIVE_DOWN]=air[2]!-ground[2]!;
        t[DRYDEN_MEAN_NORTH]=mean[0]!;t[DRYDEN_MEAN_EAST]=mean[1]!;
        this.turbulence.stepAddInto(t,air);
      }
      // TASK-167: a discrete gust's pulse, on the tick count since it took effect.
      this.discreteGust.stepAddInto(this.windNedMps);
    }
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
    const input=this.input,esc=this.escEngine,faults=this.faults,wake=this.wake;
    if(this.groundIntensity>0){const a=this.groundAttitude;a[0]=w;a[1]=x;a[2]=y;a[3]=z;this.groundInto();}
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
        input[b+12]=0;input[b+13]=duty*fraction;
        esc.driveFlags[i]=fraction===0?BOUND_V2.drivePowerCut:0;
      } else input[b+12]=faults?duty*this.torque[i]!*fraction:duty*this.torque[i]!;
    }
    // TASK-105: the shaped ESCs' commands through their quantization, frames, latency, ramp and start duty.
    const mv=this.motorV2;
    if(mv&&mv.shaped>0){
      const shaped=this.shapedIndex,targets=mv.targets,duties=mv.duties;
      for(let i=0;i<this.rotorCount;i++){const k=shaped[i]!;if(k>=0)targets[k]=input[i*this.inputStride+13]!;}
      if(!mv.shapeFromInput()){this.fault='ESC shaper step failed';return;}
      for(let i=0;i<this.rotorCount;i++){const k=shaped[i]!;if(k>=0)input[i*this.inputStride+13]=duties[k]!;}
    }
    // TASK-105: ESC desynchronization, from each rotor's drive margin d − k·|Ω|/V with the last tick's speed and motor voltage.
    const desync=this.escDesync;
    if(desync!==null&&desync.active){
      const margin=desync.margin,drive=esc!.drive,output=this.output,stride=this.outputStride,cut=desync.cut;
      for(let i=0;i<this.rotorCount;i++){
        const b=i*this.inputStride,volts=input[b+14]!,omega=output[i*stride+9]!;
        margin[i]=volts>0?input[b+13]!-drive[i*BOUND_V2_DRIVE_DOUBLES+1]!*(omega<0?-omega:omega)/volts:0;
      }
      desync.step();
      for(let i=0;i<this.rotorCount;i++)if(cut[i]===1)esc!.driveFlags[i]=BOUND_V2.drivePowerCut;
    }
    if(wake){
      // TASK-101: each rotor's last thrust and this step's air give what it blows onto the others on this step.
      const air=wake.airHubMps,density=wake.densityKgM3,blown=wake.wakeHubMps;
      for(let i=0;i<this.rotorCount;i++){
        const b=i*this.inputStride,c=i*3;
        air[c]=input[b+3]!+input[b+15]!;air[c+1]=input[b+4]!+input[b+16]!;air[c+2]=input[b+5]!+input[b+17]!;density[i]=input[b]!;
      }
      wake.step();
      for(let i=0;i<this.rotorCount;i++){const b=i*this.inputStride,c=i*3;input[b+15]=blown[c]!;input[b+16]=blown[c+1]!;input[b+17]=blown[c+2]!;}
    }
    if(esc){
      // TASK-197: the motors and the bus agree within this step, as they physically do, and a pack at its limit holds the motors back.
      const q=esc.busState;q[0]=this.electrical[0]!;q[1]=this.housePowerW;
      if(this.packDynamic){
        // TASK-104: the pack's state, the air's temperature and the body's speed through the air at the step's midpoint.
        const ps=this.packState,a=this.atmosphere[2]!;q[2]=ps[0]!;q[3]=ps[1]!;q[4]=ps[2]!;
        q[5]=a*a/(AIR_GAMMA*AIR_GAS_CONSTANT);q[6]=Math.sqrt(fx*fx+fy*fy+fz*fz);
      }
      if(!esc.solveBusInto()){this.fault='Battery bus solve failed';return;}
      const voltage=esc.busSolution;
      for(let i=0;i<this.rotorCount;i++)input[i*this.inputStride+14]=voltage[0]!;
    }
    if(esc?!esc.stepInto():!this.engine!.stepInto()){this.fault='BET rotor step failed';return;}
    this.validityFlags=this.configurationFlags|(wake?.outsideValidity?FLAG_INFLOW_OUTSIDE_VALIDITY:0);this.samplingFlags=0;
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
      // TASK-100: the fountain lifts the body with a share of what this rotor gave, before TASK-101's download.
      this.groundThrust[i]=this.hub[b+2]!;
      // TASK-101: the next step's wake is what this rotor gave; its download leaves the wrench at its hub.
      if(wake){const thrust=this.hub[b+2]!;wake.thrustN[i]=thrust;this.hub[b+2]=thrust-wake.downloadN[i]!;}
    }
    if(mv&&mv.heated>0&&!this.heatMotors()){this.fault='Motor thermal step failed';return;}
    if(this.bus) {
      // The bus delivers the summed terminal power of these motors, which ran on the voltage solved above.
      const e=this.electrical,o=this.bus.output;
      // Through the bus's input slots: as call arguments, V8 boxes these doubles once this step is too large to inline the call.
      const bi=this.bus.input;bi[0]=e[0]!;bi[1]=terminalPowerW;bi[2]=this.housePowerW;
      if(this.packDynamic){const q=esc!.busState;bi[3]=q[2]!;bi[4]=q[3]!;bi[5]=q[4]!;bi[6]=q[5]!;bi[7]=q[6]!;}
      if(!this.bus.stepFromInput()){this.fault='Battery bus step failed';return;}
      e[0]=o[0]!;e[1]=o[1]!;e[2]=o[2]!;
      if(this.packDynamic){const ps=this.packState;ps[0]=o[7]!;ps[1]=o[8]!;ps[2]=o[9]!;}
      this.busLimited=this.bus.output[6]!!==0||esc!.busLimited;
    }
    if(!this.frame.sumInto(this.hub,this.wrench)){this.fault='BET body integration failed';return;}
    if(this.groundIntensity>0&&this.groundBodyLift>0){
      // TASK-100: the fountain's lift along each rotor's ground normal, at the body's origin: no moment.
      const share=this.groundLiftShare,thrust=this.groundThrust,nb=this.groundNormalBody,lift=this.bodyLiftBodyN,w=this.wrench;
      let lx=0,ly=0,lz=0;
      for(let i=0;i<this.rotorCount;i++){
        const t=thrust[i]!,f=(t>0?t:0)*share[i]!,c=i*3;
        lx+=f*nb[c]!;ly+=f*nb[c+1]!;lz+=f*nb[c+2]!;
      }
      lift[0]=lx;lift[1]=ly;lift[2]=lz;
      w[0]=w[0]!+lx;w[1]=w[1]!+ly;w[2]=w[2]!+lz;
    }
    if(this.dragArea){
      // TASK-096: F = ½·ρ·|u|·(C_D·A)·u with u = (fx, fy, fz), the air's velocity past the body at the step's midpoint: −v_a.
      const c=this.dragArea,k=0.5*this.atmosphere[0]!*Math.sqrt(fx*fx+fy*fy+fz*fz),r=this.dragCenter,d=this.dragWrenchBody,w=this.wrench;
      const dx=k*(c[0]!*fx+c[1]!*fy+c[2]!*fz),dy=k*(c[3]!*fx+c[4]!*fy+c[5]!*fz),dz=k*(c[6]!*fx+c[7]!*fy+c[8]!*fz);
      d[0]=dx;d[1]=dy;d[2]=dz;d[3]=r[1]!*dz-r[2]!*dy;d[4]=r[2]!*dx-r[0]!*dz;d[5]=r[0]!*dy-r[1]!*dx;
      for(let i=0;i<6;i++)w[i]=w[i]!+d[i]!;
      if(fx*fx+fy*fy+fz*fz>this.dragMaxAirspeedMps*this.dragMaxAirspeedMps)this.validityFlags|=VALIDITY_FLAG_DRAG_OUTSIDE_RANGE;
    }
    // TASK-145: a calibrated rotor outside its bench data: its speed, the air's density, or an advance ratio a static bench never held.
    const env=this.envelopes;
    if(env.length>0){
      const speed=Math.sqrt(fx*fx+fy*fy+fz*fz),density=this.atmosphere[0]!;
      for(let k=0;k<env.length;k+=7){
        const rpm=Math.abs(output[env[k]!*stride+9]!)*30/Math.PI;
        // A rotor at rest is not operating, inside or outside its data.
        if(rpm>=1&&(rpm<env[k+1]!||rpm>env[k+2]!||density<env[k+3]!||density>env[k+4]!||speed*60>env[k+5]!*rpm*env[k+6]!))this.validityFlags|=VALIDITY_FLAG_CALIBRATION_EXTRAPOLATION;
      }
    }
    // TASK-095: with a contact, Rapier alone integrates the body, gravity and ground reaction included.
    if(this.contact){
      // On terrain a step with no ground under a support does not run: the state stands, and the session pauses on this tick.
      const terrain=this.terrain;
      if(terrain){if(terrain.stepInto(this.truth,this.wrench,this.dt)===TERRAIN_REJECTED){this.fault=`Contact step failed (status ${this.contact.lastStatus??'unknown'})`;return;}}
      else if(!this.contact.stepInto(this.wrench,this.dt,this.truth)){this.fault=`Contact step failed (status ${this.contact.lastStatus??'unknown'})`;return;}
      const loads=this.contactLoads;
      if(loads!==null){
        const report=this.supportState,normal=loads.normalN;
        for(let i=0;i<loads.count;i++){this.contact.wheelStateInto?.(i,report);normal[i]=report[2]!;}
      }
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
    // TASK-116: the barometer's errors from this step's truth; nothing at all while every barometer effect is off.
    if(this.barometer.active){
      // Through the model's input slots: as call arguments, V8 boxes doubles once this step is too large to inline the call.
      const x=this.barometer.input;x[BarometerInput.AirForwardMps]=-fx;x[BarometerInput.AirRightMps]=-fy;x[BarometerInput.AirDownMps]=-fz;
      this.stepBarometer();
    }
    if(this.power&&this.bus)this.recordPower(this.power,this.bus.output,s.tick);
    this.copyTruth();
    if(this.airActive&&!this.updateAir())this.fault='BET atmosphere outside its envelope';
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
      // Over the pack's voltage, not the rotor's bus_current over the motors': at a limit those differ, and these must sum to the pack's current.
      m[b+MotorColumn.BusCurrentA]=e[1]!>0?output[a+21]!/e[1]!:0;
      m[b+MotorColumn.ElectricalPowerW]=output[a+21]!; // electrical_power (record byte 160)
      m[b+MotorColumn.Command]=input[i*this.inputStride+13]!; // esc_duty as the ESC received it
      t.motorLimited[i]=(output[a+14]!&BOUND_V2.flagCurrentLimited)!==0?MotorLimited.CurrentLimit:0;
    }
    const b=t.battery;
    b[BatteryColumn.StateOfCharge]=e[0]!;b[BatteryColumn.VoltageV]=e[1]!;b[BatteryColumn.CurrentA]=e[2]!;
    b[BatteryColumn.PowerW]=e[1]!*e[2]!;b[BatteryColumn.RemainingAh]=e[0]!*this.capacityAh;
    b[BatteryColumn.TemperatureK]=this.packState[2]!;
    // The bus flags word (slot 6) is read here, not passed: V8 can box a double call argument.
    const flags=bus[6]!;
    t.batteryMasks[1]=((flags&1)!==0||this.escEngine!.busLimited?BatteryLimited.PackCurrent:0)|((flags&2)!==0?BatteryLimited.Charge:0);
    this.limits?.evaluate(t,tick);
  }
  /** The voltage the motors ran on in the last step, V (TASK-197): the bus voltage, below it only while the pack is limited. Cold, as a boxed return. */
  get motorBusVoltageV():number {return this.input[14]!;}
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
  /** TASK-101: a rotor's own thrust from the last step, along its axis, N. Not for a high-rate caller: the number boxes. */
  rotorThrustN(index:number):number {return this.output[index*this.outputStride+2]!;}
  /** Every rotor's speed after the last step, rad/s, into `out` in rotor order (TASK-149); allocation-free. */
  rotorSpeedsInto(out:Float64Array):void {for(let i=0;i<this.rotorCount&&i<out.length;i++)out[i]=this.output[i*this.outputStride+9]!;}
  /** Shape `index`'s contact report of the last step (`GroundContact.shapeStateInto`); false without one. */
  contactShapeStateInto(index:number,out:Float64Array):boolean {return this.contact?.shapeStateInto?.(index,out)??false;}
  dispose():void {this.engine?.dispose();this.escEngine?.dispose();this.contact?.dispose();}
}
