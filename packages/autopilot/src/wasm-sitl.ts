/** TASK-046: checked, allocation-free host side of the real firmware HAL. */
import {type PhysicsHz,type ActuatorFrameV2,type FlightState,type PilotInput,
  ActuatorFlagV2,newActuatorFrameV2,newSensorFrameV2,newInput,SensorKindV2} from '@mirage/protocol';
import {IdealSensors,type SensorTruth} from '@mirage/sensors/ideal';
import {LocalTangentFrame} from '@mirage/sensors/geodesy';
import {BrowserWasmSession,type BrowserFirmwareEvent,type BrowserWasmConfiguration} from './wasm-browser.ts';
import {parseArdupilotWasmManifest} from './wasm-loader.ts';

export const HAL_BYTES=1024;
export const HAL_MAGIC=0x4d48414c;
export const HAL_VERSION=1;
export const HalState={initial:0,requested:1,supplied:2,stop:3,stopped:4,fault:5} as const;
export const HAL_EXPORTS=['mirage_hal_version','mirage_hal_mailbox','mirage_hal_configure','mirage_hal_notify','mirage_hal_stop'] as const;
interface HalModule {
  HEAPU8:Uint8Array;
  _mirage_hal_version():number; _mirage_hal_mailbox():number;
  _mirage_hal_configure(hz:number,epoch:number):number;
  _mirage_hal_notify():void; _mirage_hal_stop():void;
}
function record(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object';}
function moduleShape(v:unknown):v is HalModule {
  return record(v)&&v.HEAPU8 instanceof Uint8Array&&HAL_EXPORTS.every(k=>typeof v['_'+k]==='function');
}
export interface WasmHalOptions {
  hz:PhysicsHz;epoch:number;motorMapId:number;
  /** Zero-based firmware PWM channels in physical motor order, 1..16 entries. */
  motorChannels:readonly number[];
  pwmMinUs?:number;pwmMaxUs?:number;
}
/** Sensor fields are defined in native/ardupilot/hal/browser_hal.h (SI/FRD).
 * The host fills all 40 values before submit; the final two stay zero. */
export function newWasmSensorInput():Float64Array {
  const values=new Float64Array(40);values[12]=1;return values;
}

export class WasmHalPort {
  readonly input=newWasmSensorInput();
  readonly diagnostics=new Float64Array(16);
  private readonly words:Int32Array;
  private readonly floatScratch=new Float64Array(1);
  private readonly wordScratch:Int32Array;
  private readonly buffer:SharedArrayBuffer;
  private readonly channels:Uint32Array;
  private readonly module:HalModule;
  private readonly hz:PhysicsHz;
  private readonly epoch:number;
  private readonly motorMapId:number;
  private readonly pwmMin:number;
  private readonly pwmRange:number;
  private sent=0;
  private stopped=false;
  fault='';
  constructor(value:unknown,options:WasmHalOptions) {
    if(!moduleShape(value)||!(value.HEAPU8.buffer instanceof SharedArrayBuffer)||value._mirage_hal_version()!==1)
      throw Error('HAL-enabled firmware ABI v1 required');
    if(![400,800,1200].includes(options.hz)||(options.epoch>>>0)!==options.epoch||options.epoch===0||
        (options.motorMapId>>>0)!==options.motorMapId||options.motorChannels.length<1||options.motorChannels.length>16||
        !options.motorChannels.every(c=>Number.isInteger(c)&&c>=0&&c<32)||new Set(options.motorChannels).size!==options.motorChannels.length)
      throw Error('Invalid WASM HAL configuration');
    this.pwmMin=options.pwmMinUs??1000;const max=options.pwmMaxUs??2000;
    if(!Number.isFinite(this.pwmMin)||!Number.isFinite(max)||this.pwmMin<800||max>2200||max<=this.pwmMin)throw Error('Invalid HAL PWM range');
    const address=value._mirage_hal_mailbox();this.buffer=value.HEAPU8.buffer;
    if(!Number.isInteger(address)||address<0||address%64!==0||address+HAL_BYTES>this.buffer.byteLength)throw Error('Invalid HAL mailbox pointer');
    this.words=new Int32Array(this.buffer,address,HAL_BYTES/4);
    if(Atomics.load(this.words,0)!==HAL_MAGIC||Atomics.load(this.words,1)!==1||Atomics.load(this.words,2)!==HAL_BYTES)
      throw Error('HAL mailbox identity mismatch');
    this.module=value;this.hz=options.hz;this.epoch=options.epoch;this.motorMapId=options.motorMapId;
    this.pwmRange=max-this.pwmMin;this.channels=new Uint32Array(options.motorChannels);
    this.wordScratch=new Int32Array(this.floatScratch.buffer);
    if(value._mirage_hal_configure(this.hz,this.epoch)!==0)throw Error('Firmware HAL already advanced or misconfigured');
  }
  get state():number{return Atomics.load(this.words,3);}
  get steps():number{return this.sent;}
  get rateHz():PhysicsHz{return this.hz;}
  get memoryStable():boolean{return this.module.HEAPU8.buffer===this.buffer;}
  /** Never clears a firmware fault or advances a paused firmware. */
  private ready():boolean {
    if(this.stopped||this.fault!=='')return false;
    if(!this.memoryStable){this.fault='HAL memory grew after binding';return false;}
    if(this.state===HalState.fault){this.fault='Firmware rejected HAL sensor input';return false;}
    if(this.state!==HalState.requested)return false;
    const w=this.words;
    if(Atomics.load(w,0)!==HAL_MAGIC||Atomics.load(w,1)!==HAL_VERSION||Atomics.load(w,2)!==HAL_BYTES||
        Atomics.load(w,4)!==this.hz||(Atomics.load(w,5)>>>0)!==this.epoch||
        (Atomics.load(w,6)>>>0)!==this.sent>>>0||(Atomics.load(w,7)>>>0)!==Math.floor(this.sent/4294967296)||
        (Atomics.load(w,9)>>>0)!==this.sent>>>0||Atomics.load(w,10)!==0||Atomics.load(w,11)!==32||
        (Atomics.load(w,12)!==0&&Atomics.load(w,12)!==1)) {this.fault='HAL sequence, epoch or actuator count mismatch';return false;}
    return true;
  }
  /** Motor commands for the next physics tick. Output is untouched on failure. */
  readActuatorsInto(out:ActuatorFrameV2):boolean {
    if(!this.ready())return false;
    if(out.normalizedActuators.length!==16)return false;
    for(let i=0;i<this.channels.length;i++) {
      const pwm=Atomics.load(this.words,128+this.channels[i]!);
      if(pwm!==0&&(pwm<800||pwm>2200)){this.fault='HAL PWM outside supported range';return false;}
    }
    const tick=this.sent+1,time=Math.floor(tick*1000000/this.hz);
    out.epoch=this.epoch;out.tickId.lo=tick>>>0;out.tickId.hi=Math.floor(tick/4294967296);
    out.actuatorTimeUs.lo=time>>>0;out.actuatorTimeUs.hi=Math.floor(time/4294967296);
    out.actuatorCount=this.channels.length;out.motorMapId=this.motorMapId;
    out.actuatorFlags=Atomics.load(this.words,12)===1?ActuatorFlagV2.Armed:0;
    out.normalizedActuators.fill(0);
    for(let i=0;i<this.channels.length;i++) {
      const pwm=Atomics.load(this.words,128+this.channels[i]!);
      out.normalizedActuators[i]=Math.max(0,Math.min(1,(pwm-this.pwmMin)/this.pwmRange));
    }
    return true;
  }
  /** Submit one whole sensor state; false never publishes a partial frame. */
  submit():boolean {
    if(!this.ready())return false;
    const v=this.input;
    for(let i=0;i<40;i++)if(!Number.isFinite(v[i])||Math.abs(v[i]!)>1e9)return false;
    let norm=0;for(let i=12;i<16;i++)norm+=v[i]!*v[i]!;
    if(Math.abs(v[0]!)>90||Math.abs(v[1]!)>180||Math.abs(v[2]!)>100000||Math.abs(norm-1)>1e-6||
        v[19]!<0||v[20]!<0||v[21]!<0||v[22]!<0||!Object.is(v[38],0)||!Object.is(v[39],0)||this.sent>=9007199254)return false;
    for(let i=23;i<35;i++)if(v[i]!<0||v[i]!>1)return false;
    for(let i=0;i<40;i++) {
      this.floatScratch[0]=v[i]!;Atomics.store(this.words,16+i*2,this.wordScratch[0]!);Atomics.store(this.words,17+i*2,this.wordScratch[1]!);
    }
    const time=Math.floor((this.sent+1)*1000000/this.hz);
    Atomics.store(this.words,14,time|0);Atomics.store(this.words,15,Math.floor(time/4294967296));
    Atomics.store(this.words,8,(this.sent+1)|0);Atomics.store(this.words,3,HalState.supplied);
    this.sent++;this.module._mirage_hal_notify();return true;
  }
  readDiagnosticsInto():boolean {
    if(!this.ready())return false;
    for(let i=0;i<16;i++) {
      this.wordScratch[0]=Atomics.load(this.words,192+i*2);this.wordScratch[1]=Atomics.load(this.words,193+i*2);
      this.diagnostics[i]=this.floatScratch[0]!;
    }
    return true;
  }
  stop():void {if(!this.stopped&&this.memoryStable)this.module._mirage_hal_stop();this.stopped=true;}
}

export interface WasmSitlPhysics {
  readonly state:FlightState;readonly hz:PhysicsHz;nowMs:number;readonly fault:string;
  readonly windNedMps:Float64Array;
  /** [state of charge, bus voltage V, bus current A] (TASK-092); absent for dynamics without an electrical drive. */
  readonly electrical?:Float64Array;
  useActuators(frame:ActuatorFrameV2):void;stepNow(input:PilotInput):void;
}
export interface WasmSitlOrigin {
  latitudeRad:number;longitudeRad:number;altitudeMslM:number;
  /** Explicit constant geoid offset; use zero only for a declared synthetic origin. */
  geoidOffsetM:number;magneticNedGauss:readonly [number,number,number];
}
/** One firmware actuator request advances exactly one real physics step and then
 * publishes its ideal observations. The owner controls when stepInto is called;
 * a paused owner performs no step and supplies no synthetic wall-clock ticks. */
export class WasmSitlCoupling {
  private readonly actuator=newActuatorFrameV2();
  private readonly sensor=newSensorFrameV2();
  private readonly pilot=newInput();
  private readonly geo=new Float64Array(3);
  private readonly frame:LocalTangentFrame;
  private readonly ideal:IdealSensors;
  private readonly geoid:number;
  private readonly truth:SensorTruth={epoch:1,tickId:{lo:0,hi:0},sampleTimeUs:{lo:0,hi:0},
    positionNedM:new Float64Array(3),velocityNedMps:new Float64Array(3),quaternionBodyToNed:new Float64Array(4),
    angularVelocityBodyRadS:new Float64Array(3),accelerationNedMps2:new Float64Array(3),windNedMps:new Float64Array(3)};
  fault='';
  constructor(private readonly port:WasmHalPort,private readonly physics:WasmSitlPhysics,origin:WasmSitlOrigin) {
    if(physics.hz!==port.rateHz||physics.state.tick!==0||port.steps!==0||
        !Number.isFinite(origin.geoidOffsetM)||!Number.isFinite(origin.altitudeMslM)||origin.altitudeMslM<0||origin.altitudeMslM>11000)
      throw Error('Invalid HAL physics/origin binding');
    this.geoid=origin.geoidOffsetM;
    this.frame=new LocalTangentFrame(origin.latitudeRad,origin.longitudeRad,origin.altitudeMslM+this.geoid);
    this.ideal=new IdealSensors(origin.magneticNedGauss,origin.altitudeMslM);
  }
  stepInto():boolean {
    if(this.fault!=='')return false;
    if(!this.port.readActuatorsInto(this.actuator)){
      if(this.port.fault)this.fault=this.port.fault;return false;
    }
    this.physics.useActuators(this.actuator);this.physics.nowMs=(this.port.steps+1)*1000/this.port.rateHz;
    this.physics.stepNow(this.pilot);
    const s=this.physics.state,t=this.truth,v=this.port.input;
    if(this.physics.fault||s.tick!==this.port.steps+1){this.fault='HAL physics step or tick failed';this.port.stop();return false;}
    t.epoch=this.actuator.epoch;t.tickId.lo=this.actuator.tickId.lo;t.tickId.hi=this.actuator.tickId.hi;
    t.sampleTimeUs.lo=this.actuator.actuatorTimeUs.lo;t.sampleTimeUs.hi=this.actuator.actuatorTimeUs.hi;
    t.positionNedM[0]=s.north;t.positionNedM[1]=s.east;t.positionNedM[2]=s.down;
    t.velocityNedMps[0]=s.vn;t.velocityNedMps[1]=s.ve;t.velocityNedMps[2]=s.vd;
    t.quaternionBodyToNed[0]=s.qw;t.quaternionBodyToNed[1]=s.qx;t.quaternionBodyToNed[2]=s.qy;t.quaternionBodyToNed[3]=s.qz;
    t.angularVelocityBodyRadS[0]=s.p;t.angularVelocityBodyRadS[1]=s.q;t.angularVelocityBodyRadS[2]=s.r;
    t.accelerationNedMps2[0]=s.an;t.accelerationNedMps2[1]=s.ae;t.accelerationNedMps2[2]=s.ad;
    t.windNedMps.set(this.physics.windNedMps);
    this.frame.nedToGeodeticFromInto(t.positionNedM,this.geo);
    v[0]=this.geo[0]!*180/Math.PI;v[1]=this.geo[1]!*180/Math.PI;v[2]=this.geo[2]!-this.geoid;
    v[3]=s.vn;v[4]=s.ve;v[5]=s.vd;
    if(!this.ideal.sampleInto(SensorKindV2.Imu,t,this.sensor)){this.fault='HAL IMU sampling failed';this.port.stop();return false;}
    for(let i=0;i<6;i++)v[6+i]=this.sensor.values[i]!;
    v[12]=s.qw;v[13]=s.qx;v[14]=s.qy;v[15]=s.qz;
    if(!this.ideal.sampleInto(SensorKindV2.Magnetometer,t,this.sensor)){this.fault='HAL magnetic sampling failed';this.port.stop();return false;}
    for(let i=0;i<3;i++)v[16+i]=this.sensor.values[i]!;
    if(!this.ideal.sampleInto(SensorKindV2.Airspeed,t,this.sensor)){this.fault='HAL airspeed sampling failed';this.port.stop();return false;}
    // Sensor queue airspeed is dynamic pressure (Pa); SITL expects EAS (m/s).
    // Value 21 is a unipolar power-module reading (TASK-092): regenerative bus current reads 0.
    v[19]=Math.sqrt(2*this.sensor.values[0]!/1.225);v[20]=s.batteryVoltage;v[21]=this.physics.electrical?Math.max(0,this.physics.electrical[2]!):0;v[22]=Math.max(0,-s.down);
    v[35]=t.windNedMps[0]!;v[36]=t.windNedMps[1]!;v[37]=t.windNedMps[2]!;
    if(!this.port.submit()){this.fault='HAL sensor publication failed';this.port.stop();return false;}
    return true;
  }
}

/** Cold boot/storage lifecycle reuses TASK-045; HAL stepping stays synchronous. */
export class WasmSitlSession {
  port:WasmHalPort|null=null;
  private readonly firmware:BrowserWasmSession;
  constructor(options:WasmHalOptions,emit:(event:BrowserFirmwareEvent)=>void,fail:(error:Error)=>void,configuration?:BrowserWasmConfiguration) {
    this.firmware=new BrowserWasmSession(emit,fail,value=>{this.port=new WasmHalPort(value,options);},configuration);
  }
  async start(baseUrl:string,manifest:unknown,profile:string):Promise<void> {
    const parsed=parseArdupilotWasmManifest(manifest);
    if(!HAL_EXPORTS.every(name=>parsed.requiredExports.includes(name)))throw Error('Manifest does not admit the HAL-enabled artifact');
    await this.firmware.start(baseUrl,parsed,profile);
    if(!this.port)throw Error('Firmware HAL was not bound');
  }
  writeSerial(bytes:Uint8Array):void {this.firmware.write(bytes);}
  checkpoint():ReturnType<BrowserWasmSession['checkpoint']> {return this.firmware.checkpoint();}
  async dispose():Promise<{terminatedPthreads:number}> {
    this.port?.stop();return this.firmware.dispose(false);
  }
}
