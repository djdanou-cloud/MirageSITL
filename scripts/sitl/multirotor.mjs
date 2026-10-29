// TASK-128 synthetic allocation/transport reference, not BET/coaxial fidelity.
import catalog from '../../tests/fixtures/sitl/frames.json' with {type:'json'};
import {BetRigidBodyBackend,newBodyTruth} from '../../packages/wasm-bet/src/backend.ts';
for(const frame of catalog.frames){
  for(const motor of frame.motors)Object.freeze(motor);
  Object.freeze(frame.motors);Object.freeze(frame);
}
export function frameById(id){
  const frame=catalog.frames.find(frame=>frame.id===id);
  if(!frame)throw Error('Unsupported pinned frame ID');
  return frame;
}
export function frameParameters(id){
  const frame=frameById(id);
  let text=`FRAME_CLASS ${frame.frameClass}\nFRAME_TYPE ${frame.frameType}\nARMING_SKIPCHK 0\nMOT_PWM_MIN 1000\nMOT_PWM_MAX 2000\nSIM_RATE_HZ 800\nSERVO_32_ENABLE ${frame.servoPacketChannels===32?1:0}\n`;
  if(frame.kind==='stock-scripting')text+='SCR_ENABLE 1\n';
  for(let output=1;output<=frame.servoPacketChannels;output++){
    const motor=frame.motors.find(motor=>motor.output===output);
    text+=`SERVO${output}_FUNCTION ${motor?.function??0}\n`;
  }
  return text;
}
export function frameScript(id){
  const frame=frameById(id);
  if(frame.kind!=='stock-scripting')return null;
  let script='-- Synthetic TASK-128 frame configuration through stock Lua bindings.\n';
  for(const motor of frame.motors){
    script+=`MotorsMatrix:add_motor_raw(${motor.motor-1}, math.cos(math.rad(${motor.azimuthDeg}+90)), math.cos(math.rad(${motor.azimuthDeg})), ${motor.yawFactor}, ${motor.testOrder})\n`;
  }
  script+=`assert(MotorsMatrix:init(${frame.motorCount}), "Mirage frame init failed")\n`;
  script+=`motors:set_frame_string("Mirage paired16")\ngcs:send_text(6, "Mirage paired-16 ready: 16")\n`;
  return script;
}
export function referenceConfiguration(id){
  const frame=frameById(id),scale=frame.motorCount/4;
  return Object.freeze({id:`synthetic-${id}-allocation-v1`,frameId:id,motorCount:frame.motorCount,
    massKg:1.5*scale,inertiaKgM2:[0.03*scale,0,0,0,0.03*scale,0,0,0,0.05*scale],
    armM:0.2,maxRotorThrustN:10,yawMomentPerThrustM:0.017,motorTimeConstantS:0.04,
    thrustExpo:0.65,gravityMps2:9.80665,
    assumptions:'Synthetic isolated rotor thrust, no coaxial/wake or body aerodynamics; Rust rigid body and inelastic pad; output-path feasibility only'});
}
export class MultirotorReference {
  constructor(instance,id){
    this.frame=frameById(id);this.configuration=referenceConfiguration(id);
    const c=this.configuration;
    this.body=new BetRigidBodyBackend(instance,c.massKg,c.inertiaKgM2);
    this.truth=newBodyTruth();this.specificForce=new Float64Array([0,0,-c.gravityMps2]);
    this.motors=new Float64Array(this.frame.motorCount);this.wrench=new Float64Array(6);
    this.xM=new Float64Array(this.frame.motorCount);this.yM=new Float64Array(this.frame.motorCount);
    this.yaw=new Float64Array(this.frame.motorCount);
    for(let i=0;i<this.frame.motorCount;i++){
      const motor=this.frame.motors[i],angle=motor.azimuthDeg*Math.PI/180;
      this.xM[i]=c.armM*Math.cos(angle);this.yM[i]=c.armM*Math.sin(angle);this.yaw[i]=motor.yawFactor;
    }
    this.previousVelocity=new Float64Array(3);this.acceleration=new Float64Array(3);
  }
  wrenchInto(throttles,out){
    if(throttles.length!==this.frame.motorCount||out.length!==6)return false;
    for(let i=0;i<throttles.length;i++)if(!Number.isFinite(throttles[i])||throttles[i]<0||throttles[i]>1)return false;
    out.fill(0);
    const c=this.configuration;
    for(let i=0;i<throttles.length;i++){
      const u=throttles[i],t=c.maxRotorThrustN*((1-c.thrustExpo)*u+c.thrustExpo*u*u);
      out[2]-=t;out[3]-=this.yM[i]*t;out[4]+=this.xM[i]*t;out[5]+=this.yaw[i]*c.yawMomentPerThrustM*t;
    }
    return true;
  }
  step(throttles,dt){
    if(!Number.isFinite(dt)||dt<=0||dt>0.01||!this.wrenchInto(throttles,this.wrench))throw Error('Invalid multirotor reference step');
    const c=this.configuration,t=this.truth;
    this.previousVelocity.set(t.velocityNedMps);
    const blend=1-Math.exp(-dt/c.motorTimeConstantS);
    for(let i=0;i<this.motors.length;i++)this.motors[i]+=blend*(throttles[i]-this.motors[i]);
    this.wrenchInto(this.motors,this.wrench);
    if(!this.body.stepInto(this.wrench,dt,t))throw Error('Multirotor body step rejected');
    if(t.positionNedM[2]>0){t.positionNedM[2]=0;t.velocityNedMps[2]=Math.min(0,t.velocityNedMps[2]);this.body.reset(t);}
    for(let i=0;i<3;i++)this.acceleration[i]=(t.velocityNedMps[i]-this.previousVelocity[i])/dt;
    this.acceleration[2]-=c.gravityMps2;
    const q=t.quaternionBodyToNed,w=q[0],x=q[1],y=q[2],z=q[3],a=this.acceleration,out=this.specificForce;
    out[0]=(1-2*(y*y+z*z))*a[0]+2*(x*y+w*z)*a[1]+2*(x*z-w*y)*a[2];
    out[1]=2*(x*y-w*z)*a[0]+(1-2*(x*x+z*z))*a[1]+2*(y*z+w*x)*a[2];
    out[2]=2*(x*z+w*y)*a[0]+2*(y*z-w*x)*a[1]+(1-2*(x*x+y*y))*a[2];
  }
}
