import { it } from "vitest";
import { nodeCheck } from "./support/node-evidence";

it("checks quad motor order, hover balance, contact specific force and free fall", () => nodeCheck(`
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {QuadReference,quadWrench,toBody,configuration} from './scripts/sitl/quad.mjs';
const w=quadWrench([1,1,1,1]);
assert.equal(w[2],-4*configuration.maxRotorThrustN);
assert(Math.abs(w[3])+Math.abs(w[4])+Math.abs(w[5])<1e-12);
const e=configuration.thrustExpo,load=configuration.massKg*9.80665/(4*configuration.maxRotorThrustN);
const hover=(-(1-e)+Math.sqrt((1-e)**2+4*e*load))/(2*e);
assert(Math.abs(quadWrench([hover,hover,hover,hover])[2]+configuration.massKg*9.80665)<1e-12);
const rotated=toBody([Math.SQRT1_2,0,Math.SQRT1_2,0],[0,0,-9.80665],new Float64Array(3));
assert(Math.abs(rotated[0]-9.80665)<1e-12);assert(Math.abs(rotated[2])<1e-12);
for(const [m,roll,pitch,yaw] of [[0,-1,1,1],[1,1,-1,1],[2,1,1,-1],[3,-1,-1,-1]]) {
 const u=[0,0,0,0];u[m]=1;const v=quadWrench(u);
 assert.equal(Math.sign(v[3]),roll);assert.equal(Math.sign(v[4]),pitch);assert.equal(Math.sign(v[5]),yaw);
}
const output=mkdtempSync(join(tmpdir(),'mirage-sitl-quad-'));
try {
execFileSync(process.execPath,['scripts/build-wasm.mjs','--out',output],{stdio:'pipe'});
const {instance}=await WebAssembly.instantiate(readFileSync(join(output,'mirage_bet.scalar.wasm')),{});
const quad=new QuadReference(instance);
for(let i=0;i<400;i++)quad.step([0,0,0,0],1/400);
assert.equal(quad.truth.positionNedM[2],0);
assert(Math.abs(quad.specificForce[2]+9.80665)<1e-9);
quad.truth.positionNedM[2]=-10;quad.body.reset(quad.truth);
for(let i=0;i<400;i++)quad.step([0,0,0,0],1/400);
assert(Math.abs(quad.truth.positionNedM[2]-(-10+4.903325))<1e-9);
assert(Math.abs(quad.specificForce[2])<1e-9);
assert.throws(()=>quad.step([NaN,0,0,0],1/400));
} finally {rmSync(output,{recursive:true,force:true});}
`));
