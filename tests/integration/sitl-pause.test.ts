import {it,expect} from "vitest";
import {spawnSync} from "node:child_process";
import {nodeCheck} from "../support/node-evidence";
it("retains one pending lockstep boundary and rejects early/changed resume evidence",()=>nodeCheck(`
import {PauseBoundary,PAUSE_CONTRACT,parameterProbe,pauseProbeValue} from './scripts/sitl/pause-probe.mjs';
const p=new PauseBoundary();
const bytes=Buffer.alloc(40);bytes.writeUInt16LE(18458);bytes.writeUInt32LE(42,4);
const state={positionNedM:[0,0,-10],velocityNedMps:[0,0,0],quaternionWxyz:[1,0,0,0]};
p.hold('hover',bytes,{address:'127.0.0.1',port:1234},state,42/800,100);
assert.equal(p.accept(bytes),'held');assert.equal(p.accept(Buffer.alloc(40)),'changed');
assert.throws(()=>p.hold('ground',bytes,{},state,0,100));
assert.throws(()=>p.release(42/800,state,100+PAUSE_CONTRACT.minimumPauseMs-1));
assert.throws(()=>p.release(43/800,state,60100));
assert.throws(()=>p.release(42/800,{...state,positionNedM:[0,0,-9]},60100));
const result=p.release(42/800,state,60100);
assert.equal(result.durationMs,60000);assert.equal(result.repeatedFrames,1);
assert.equal(p.active,null);assert.equal(result.packet.readUInt32LE(4),42);
assert.equal(p.accept(bytes),'live');
p.noteEcho(result.packet);
assert.equal(p.accept(Buffer.from(bytes)),'echo');
const next=Buffer.from(bytes);next.writeUInt32LE(43,4);
assert.equal(p.accept(next),'live');
assert.equal(p.accept(Buffer.from(bytes)),'live');
`));

it("restores the frame parameter baseline after a deferred acknowledgement",()=>nodeCheck(`
import {parameterProbe,pauseProbeValue} from './scripts/sitl/pause-probe.mjs';
assert.equal(pauseProbeValue(10),11);
assert.deepEqual(parameterProbe('held',11,10,false),{phase:'held',write:null,sawProbe:false});
assert.deepEqual(parameterProbe('restore',10,10,false),{phase:'restore',write:null,sawProbe:false});
assert.deepEqual(parameterProbe('restore',11,10,false),{phase:'restore',write:10,sawProbe:true});
assert.deepEqual(parameterProbe('restore',11,10,true),{phase:'restore',write:10,sawProbe:true});
assert.deepEqual(parameterProbe('restore',10,10,true),{phase:'confirm',write:null,sawProbe:false});
assert.notEqual(pauseProbeValue(10),11+1);
`));

it("keeps a silent responsive bridge alive and closes a peer that stops answering pings",()=>bridgeCheck(`
import {startBridge} from './apps/bridge/src/server.ts';
import {WebSocket} from 'ws';
import {once} from 'node:events';
import {createSocket} from 'node:dgram';
const udp=createSocket('udp4');udp.bind(0,'127.0.0.1');await once(udp,'listening');
const bridge=await startBridge({port:0,origin:'http://localhost:5173',token:'a'.repeat(64),epoch:1,udp:{mavlinkPort:udp.address().port,physicsPort:udp.address().port===65535?65534:udp.address().port+1},ardupilotJson:{localPort:0}});
const connect=autoPong=>new WebSocket('ws://127.0.0.1:'+bridge.port,['mirage-v1','session.'+'a'.repeat(64)],{origin:'http://localhost:5173',autoPong});
let ws;
try{
 ws=connect(true);await once(ws,'open');let pings=0;ws.on('ping',()=>pings++);
 await new Promise(resolve=>setTimeout(resolve,6500));
 assert.equal(ws.readyState,WebSocket.OPEN);assert(pings>=5);
 ws.close();await once(ws,'close');
 ws=connect(false);await once(ws,'open');const [code]=await once(ws,'close');assert.equal(code,1008);
}finally{ws?.terminate();await bridge.close();udp.close();}
`),20000);

function bridgeCheck(code:string){
 const result=spawnSync(process.execPath,["--experimental-transform-types","--input-type=module","-e",`import assert from "node:assert/strict";${code}`],{encoding:"utf8"});
 expect(result.status,result.stderr).toBe(0);
}

it("rejects false pause evidence independently of the native producer",()=>nodeCheck(`
import {assessPauseWindow} from './scripts/check-sitl-pause.mjs';
const truth={positionNedM:[0,0,-10],velocityNedMps:[0,0,0],quaternionWxyz:[1,0,0,0]};
const p={kind:'hover',durationMs:60050,startWallMs:101,endWallMs:60151,servoFrame:1,timeS:1/800,before:truth,after:structuredClone(truth),bridgeOpen:true,bridgePingCount:60,repeatedFrames:59};
const physics=[{...truth,timeS:1/800,wallTimeMs:100},{...truth,timeS:2/800,wallTimeMs:60152}];
const replies=physics.map(r=>({wallTimeMs:r.wallTimeMs}));
const packet=Buffer.alloc(40);packet.writeUInt32LE(1,4);
const duplicates=Array.from({length:60},(_,i)=>({kind:'hover',wallTimeMs:101+i*1000,hex:packet.toString('hex')}));
const events=[{wallTimeMs:100,message:{mavpackettype:'SYSTEM_TIME',time_boot_ms:1}},
 {wallTimeMs:60152,receivedSimS:2/800,message:{mavpackettype:'PARAM_VALUE',param_id:'WP_SPD',param_value:11}},
 {wallTimeMs:60152,message:{mavpackettype:'SYSTEM_TIME',time_boot_ms:2}}];
const outgoing=[{wallMonotonicS:900,message:{mavpackettype:'PARAM_SET',param_value:11}},{wallMonotonicS:1000,message:{mavpackettype:'PARAM_SET',param_value:11}}];
for(let i=0;i<280;i++)for(const kind of ['HEARTBEAT','RC_CHANNELS_OVERRIDE'])outgoing.push({wallMonotonicS:1001+i*.2,message:{mavpackettype:kind,chan1_raw:1500,chan3_raw:1000}});
assert.equal(assessPauseWindow(p,physics,replies,duplicates,events,outgoing).settledTelemetry,0);
assert.throws(()=>assessPauseWindow({...p,durationMs:59000},physics,replies,duplicates,events,outgoing));
assert.throws(()=>assessPauseWindow({...p,after:{...truth,positionNedM:[0,0,-9]}},physics,replies,duplicates,events,outgoing));
assert.throws(()=>assessPauseWindow(p,physics,[...replies,{wallTimeMs:2000}],duplicates,events,outgoing));
assert.throws(()=>assessPauseWindow(p,physics,replies,duplicates.map((r,i)=>i===2?{...r,hex:'00'.repeat(40)}:r),events,outgoing));
assert.throws(()=>assessPauseWindow(p,physics,replies,duplicates,[...events,{wallTimeMs:2000,message:{mavpackettype:'SYSTEM_TIME',time_boot_ms:2000}}],outgoing));
assert.throws(()=>assessPauseWindow(p,physics,replies,duplicates,events,outgoing.filter(r=>r.message.mavpackettype!=='RC_CHANNELS_OVERRIDE')));
assert.throws(()=>assessPauseWindow({...p,bridgeOpen:false},physics,replies,duplicates,events,outgoing));
`));
