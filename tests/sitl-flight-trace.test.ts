import { it } from "vitest";
import { nodeCheck } from "./support/node-evidence";

it("checks v2 schema with synthetic observations, actual frame offsets and independent health fields", () => nodeCheck(`
import {assessFlight} from './scripts/run-sitl.mjs';
const samples=Array.from({length:1005},(_,i)=>({
 timeS:50+i/100,stage:i===0?'arm':i===1?'takeoff':i===1004?'land':'hold',
 armed:i!==1004,altitudeM:i===0||i===1004?0:10,mode:i===1004?9:4,ekfHealthy:true,
 servoFrame:40000+8*i,pwmUs:[1200,1200,1200,1200],
 heartbeatAgeS:0.2,ekfAgeS:0.2,ekfFlags:831,innovationRatios:[0.1,0.1,0.1,0.1,0],
 autopilotAltitudeM:i===0||i===1004?0:10,altitudeAgeS:0.2
}));
const trace={schemaVersion:2,physicsHz:800,captureStride:8,
 provenance:{source:'native-sitl',operator:'synthetic-schema-test-only',recordedAt:'2026-10-19T00:00:00Z',firmwareSha256:'a'.repeat(64),modelSha256:'b'.repeat(64)},samples};
assert.equal(assessFlight(trace).status,'PASS');
for(const mutation of [{ekfFlags:167},{ekfFlags:1855},{innovationRatios:[1,0,0,0,0]},{heartbeatAgeS:1.01},{ekfAgeS:-1},{altitudeAgeS:NaN},{ekfHealthy:false},{autopilotAltitudeM:12},{servoFrame:1},{timeS:1}]) {
 const next={...trace,samples:samples.map((s,i)=>i===20?{...s,...mutation}:s)};
 assert.throws(()=>assessFlight(next),JSON.stringify(mutation));
}
assert.throws(()=>assessFlight({...trace,captureStride:16}));
assert.throws(()=>assessFlight({...trace,samples:samples.filter((_,i)=>i!==30)}));
`));
