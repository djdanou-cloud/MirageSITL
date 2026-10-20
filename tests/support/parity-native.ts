/** Local Linux capture driver. Bundle with esbuild before execution in WSL. */
import {spawn,execFileSync} from 'node:child_process';
import {createSocket} from 'node:dgram';
import {createServer,createConnection,type Socket} from 'node:net';
import {once} from 'node:events';
import {readFileSync,writeFileSync,mkdtempSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {BetFlightDynamics} from '../../packages/physics/src/bet-dynamics.ts';
import {newActuatorFrameV2,newInput,newSensorFrameV2,SensorKindV2} from '../../packages/protocol/src/index.ts';
import {newBodyTruth} from '../../packages/wasm-bet/src/backend.ts';
import {IdealSensors,type SensorTruth} from '../../packages/sensors/src/ideal.ts';
import {parityAircraft,PARITY_HZ,PARITY_ORIGIN} from '../../tests/support/autopilot-parity.ts';
import {ParityTelemetry,ParityCommands} from '../../tests/support/parity-mavlink.ts';
import {parityIdentity} from './parity-identity.ts';

const [rootArg,binaryArg,sourceArg,defaultsArg,outputArg]=process.argv.slice(2);
if(process.platform!=='linux'||!rootArg||!binaryArg||!sourceArg||!defaultsArg||!outputArg)throw Error('Expected Linux ROOT ELF SOURCE DEFAULTS OUTPUT');
const root=resolve(rootArg),binary=resolve(binaryArg),source=resolve(sourceArg),output=resolve(outputArg);
const sourceCommit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(sourceCommit!=='8ab6afde107a91df1b5f60ade8f333cb8a61b190'||execFileSync('git',['-C',source,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Pinned native source not clean');
const bytes=readFileSync(binary);if(bytes.subarray(0,4).toString('hex')!=='7f454c46')throw Error('Native ELF required');
const bodyBytes=readFileSync(join(root,'packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
const defaultsText=readFileSync(resolve(defaultsArg),'utf8'),identity=parityIdentity(root,defaultsText);
const physics=new BetFlightDynamics(new WebAssembly.Module(bodyBytes),parityAircraft(),PARITY_HZ);
const ideal=new IdealSensors(PARITY_ORIGIN.magneticNedGauss,584),sensor=newSensorFrameV2();
const truth:SensorTruth={...newBodyTruth(),epoch:47,tickId:{lo:0,hi:0},sampleTimeUs:{lo:0,hi:0},windNedMps:new Float64Array(3)};
const actuator=newActuatorFrameV2(),pilot=newInput();actuator.epoch=47;actuator.motorMapId=42;actuator.actuatorCount=4;
const telemetry=new ParityTelemetry(),samples:unknown[]=[],raw:Buffer[]=[];
const wireChunks:{tick:number;bytes:number[]}[]=[],transmitted:{tick:number;bytes:number[]}[]=[];
const physicsSocket=createSocket('udp4');physicsSocket.bind(0,'127.0.0.1');await once(physicsSocket,'listening');
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const address=probe.address();if(!address||typeof address==='string')throw Error('No owned port');const port=address.port;
await new Promise<void>(resolve=>probe.close(()=>resolve()));
const cwd=mkdtempSync(join(tmpdir(),'mirage-task-047-')),log=openSync(join(cwd,'firmware.log'),'w');
const firmware=spawn(binary,['--model','JSON:127.0.0.1','--speedup','2','--rate','800','--home','-35.362938,149.165085,584,0',
  '--sim-port-out',String(physicsSocket.address().port),'--serial0',`tcp:${port}`,'--serial1','none','--serial2','none',
  '--defaults',resolve(defaultsArg)],{cwd,stdio:['ignore',log,log]});
let finished=false,steps=0;
const connection:{serial:Socket|null;failure:Error|null}={serial:null,failure:null};
const fail=(e:unknown)=>{connection.failure=e instanceof Error?e:Error(String(e));finished=true;};
firmware.on('error',fail);firmware.on('exit',code=>{if(!finished)fail(Error('Owned firmware exited '+String(code)));});
const deadline=setTimeout(()=>fail(Error('Native parity flight deadline')),180000);
let connecting=false;
const connectTimer=setInterval(()=>{
  if(connection.serial||connecting||finished)return;connecting=true;
  const attempt=createConnection({host:'127.0.0.1',port});
  attempt.on('error',()=>{connecting=false;attempt.destroy();});
  attempt.on('connect',()=>{connection.serial=attempt;connecting=false;
    attempt.on('data',b=>{raw.push(Buffer.from(b));wireChunks.push({tick:steps,bytes:Array.from(b)});telemetry.parser.push(b);});});
},100);
const failsafe=process.env.MIRAGE_PARITY_FAILSAFE==='1';
const commands=new ParityCommands(bytes=>{if(connection.serial){connection.serial.write(bytes);transmitted.push({tick:steps,bytes:Array.from(bytes)});}},failsafe);
physicsSocket.on('error',fail);
physicsSocket.on('message',(packet,peer)=>{
  if(finished)return;
  try {
    if(peer.address!=='127.0.0.1'||![40,72].includes(packet.length)||![18458,29569].includes(packet.readUInt16LE(0))||packet.readUInt32LE(4)!==steps)throw Error('Invalid/gapped native actuator packet');
    const tick=steps;telemetry.simS=tick/PARITY_HZ;
    commands.tick(tick);
    const s=physics.state;
    if(tick%8===0) {
      samples.push({tick,positionNedM:[s.north,s.east,s.down],quaternionWxyz:[s.qw,s.qx,s.qy,s.qz],armed:telemetry.armed,mode:telemetry.mode,
        ekfFlags:telemetry.ekfFlags,innovationRatios:[...telemetry.innovations],heartbeatAgeS:telemetry.heartbeatS<0?null:telemetry.simS-telemetry.heartbeatS,
        ekfAgeS:telemetry.ekfS<0?null:telemetry.simS-telemetry.ekfS,validityFlags:physics.validityFlags});
      if(tick%8000===0)process.stderr.write(JSON.stringify(samples.at(-1))+'\n');
    }
    if(tick>=96000){finished=true;return;}
    actuator.actuatorFlags=telemetry.armed?1:0;
    for(let i=0;i<4;i++)actuator.normalizedActuators[i]=Math.max(0,Math.min(1,(packet.readUInt16LE(8+i*2)-1000)/1000));
    physics.useActuators(actuator);physics.nowMs=(tick+1)*1000/PARITY_HZ;physics.stepNow(pilot);
    if(physics.fault)throw Error(physics.fault);
    const t=truth;steps++;
    t.tickId.lo=steps;t.sampleTimeUs.lo=Math.floor(steps*1e6/PARITY_HZ);
    t.positionNedM.set([s.north,s.east,s.down]);t.velocityNedMps.set([s.vn,s.ve,s.vd]);
    t.quaternionBodyToNed.set([s.qw,s.qx,s.qy,s.qz]);t.angularVelocityBodyRadS.set([s.p,s.q,s.r]);
    t.accelerationNedMps2.set([s.an,s.ae,s.ad]);
    if(!ideal.sampleInto(SensorKindV2.Imu,t,sensor))throw Error('Native ideal IMU failed');
    const imu={gyro:Array.from(sensor.values.subarray(3,6)),accel_body:Array.from(sensor.values.subarray(0,3))};
    const state={timestamp:steps/PARITY_HZ,imu,position:Array.from(t.positionNedM),quaternion:Array.from(t.quaternionBodyToNed),
      velocity:Array.from(t.velocityNedMps),velocity_wind:[0,0,0],battery:{voltage:0,current:0},airspeed:Math.hypot(s.vn,s.ve,s.vd),
      rc:{rc_1:1500,rc_2:1500,rc_3:1000,rc_4:1500,rc_5:1000,rc_6:1000,rc_7:1000,rc_8:1000,rc_9:1000,rc_10:1000,rc_11:1000,rc_12:1000}};
    physicsSocket.send('\n'+JSON.stringify(state)+'\n',peer.port,peer.address);
  }catch(error){fail(error);}
});
try{while(!finished)await new Promise(resolve=>setTimeout(resolve,20));}
finally {
  clearTimeout(deadline);clearInterval(connectTimer);physicsSocket.close();connection.serial?.destroy();
  if(firmware.exitCode===null&&firmware.signalCode===null){firmware.kill('SIGTERM');const hard=setTimeout(()=>firmware.kill('SIGKILL'),500);await once(firmware,'close');clearTimeout(hard);}
  closeSync(log);physics.dispose();
  if(JSON.stringify(parityIdentity(root,defaultsText))!==JSON.stringify(identity))connection.failure??=Error('Sources changed during native capture');
  writeFileSync(output,JSON.stringify({status:connection.failure?'FAIL':'captured',failure:connection.failure?.message??null,sourceCommit,identity,defaultsText,
    caseId:failsafe?'gcs-failsafe':'takeoff-land',firmwareSha256:createHash('sha256').update(bytes).digest('hex'),cwd,samples,raw:Array.from(Buffer.concat(raw)),wireChunks,transmitted})+'\n');
}
if(connection.failure)throw connection.failure;
