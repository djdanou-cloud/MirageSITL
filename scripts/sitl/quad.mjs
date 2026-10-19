// Synthetic integration aircraft, not measured BET aerodynamics or a browser backend.
import { BetRigidBodyBackend, newBodyTruth } from '../../packages/wasm-bet/src/backend.ts';
export const configuration = Object.freeze({
  id: 'synthetic-quad-x-integration-v1', massKg: 1.5,
  inertiaKgM2: [0.03,0,0,0,0.03,0,0,0,0.05], armM: 0.2,
  maxRotorThrustN: 10, yawMomentPerThrustM: 0.017, motorTimeConstantS: 0.04,
  thrustExpo: 0.65, gravityMps2: 9.80665,
  assumptions: 'User-independent synthetic parameters; six-DOF Rust RK4; no aerodynamic drag; inelastic horizontal floor projection; no measured calibration or high-rate certification',
});
// ArduPilot pinned AP_MotorsMatrix quad X: FR, RL, FL, RR. FRD wrench.
const x=[1,-1,1,-1],y=[1,-1,-1,1],yaw=[1,1,-1,-1];
export function quadWrench(throttles, out=new Float64Array(6)) {
  if(throttles.length!==4 || !throttles.every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error('Invalid quad throttle');
  out.fill(0);
  const arm=configuration.armM/Math.sqrt(2);
  for(let m=0;m<4;m++) {
    const u=throttles[m],t=configuration.maxRotorThrustN*((1-configuration.thrustExpo)*u+configuration.thrustExpo*u*u);
    out[2]-=t;out[3]-=y[m]*arm*t;out[4]+=x[m]*arm*t;out[5]+=yaw[m]*configuration.yawMomentPerThrustM*t;
  }
  return out;
}
export function toBody(q,v,out) {
  const [w,x,y,z]=q;
  out[0]=(1-2*(y*y+z*z))*v[0]+2*(x*y+w*z)*v[1]+2*(x*z-w*y)*v[2];
  out[1]=2*(x*y-w*z)*v[0]+(1-2*(x*x+z*z))*v[1]+2*(y*z+w*x)*v[2];
  out[2]=2*(x*z+w*y)*v[0]+2*(y*z-w*x)*v[1]+(1-2*(x*x+y*y))*v[2];
  return out;
}
export class QuadReference {
  constructor(instance) {
    this.body=new BetRigidBodyBackend(instance,configuration.massKg,configuration.inertiaKgM2);
    this.truth=newBodyTruth();this.specificForce=new Float64Array([0,0,-configuration.gravityMps2]);
    this.motors=new Float64Array(4);this.wrench=new Float64Array(6);this.previousVelocity=new Float64Array(3);this.acceleration=new Float64Array(3);
  }
  step(throttles,dt) {
    quadWrench(throttles,this.wrench); // validate before mutating model state
    if(!Number.isFinite(dt)||dt<=0||dt>0.01)throw Error('Invalid quad timestep');
    this.previousVelocity.set(this.truth.velocityNedMps);
    const blend=1-Math.exp(-dt/configuration.motorTimeConstantS);
    for(let i=0;i<4;i++)this.motors[i]+=blend*(throttles[i]-this.motors[i]);
    quadWrench(this.motors,this.wrench);
    if(!this.body.stepInto(this.wrench,dt,this.truth))throw Error('Rigid-body step rejected');
    const t=this.truth;
    if(t.positionNedM[2]>0) {
      t.positionNedM[2]=0;t.velocityNedMps[2]=Math.min(0,t.velocityNedMps[2]);
      // Inelastic floor constrains only penetration; it never supplies flight control.
      this.body.reset(t);
    }
    for(let i=0;i<3;i++)this.acceleration[i]=(t.velocityNedMps[i]-this.previousVelocity[i])/dt;
    this.acceleration[2]-=configuration.gravityMps2;
    toBody(t.quaternionBodyToNed,this.acceleration,this.specificForce);
  }
}
