/// <reference lib="webworker" />
import {WasmSitlSession,WasmSitlCoupling,HalState} from '../../packages/autopilot/src/wasm-sitl.ts';
import {BetFlightDynamics} from '../../packages/physics/src/bet-dynamics.ts';
import {flightConfiguration} from '../bet-runtime-fixture.ts';
import {newActuatorFrameV2,type PhysicsHz} from '@mirage/protocol';
let session:WasmSitlSession|null=null;
let timer:ReturnType<typeof setTimeout>|undefined;
let paused=false,pausedOnce=false,target=0;
let heartbeats=0,serialBytes=0,initialBytes=0;
let coupling:WasmSitlCoupling|undefined,physics:BetFlightDynamics|undefined;
const actuator=newActuatorFrameV2();
function record(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object';}
function snapshot() {
  const p=session?.port;if(!p)throw Error('Missing HAL port');
  return {steps:p.steps,state:p.state,diagnostics:Array.from(p.diagnostics),memoryStable:p.memoryStable,
    heartbeats,serialBytes,initialBytes,fault:p.fault,isolated:crossOriginIsolated,actuators:Array.from(actuator.normalizedActuators),
    body:physics?{tick:physics.state.tick,downM:physics.state.down,validityFlags:physics.validityFlags,modelId:physics.modelId}:null};
}
function pump():void {
  try {
    const p=session?.port;if(!p||paused)return;
    if(p.fault)throw Error(p.fault);
    // Bound test-only batches so timer granularity does not pace each sample.
    // All firmware/physics exchanges remain synchronous in this Worker.
    const deadline=performance.now()+4;
    do {
      if(p.state===HalState.requested) {
        if(!p.readDiagnosticsInto()||!p.readActuatorsInto(actuator))throw Error('HAL output read failed');
        if(p.steps===200&&!pausedOnce){paused=pausedOnce=true;postMessage({type:'paused',...snapshot()});return;}
        if(p.steps>=target){paused=true;postMessage({type:'complete',...snapshot()});return;}
        if(coupling?!coupling.stepInto():!p.submit())throw Error('Real firmware/physics sensor submission failed: '+(coupling?.fault??''));
      }
    } while(performance.now()<deadline);
    timer=setTimeout(pump,0);
  }catch(error){postMessage({type:'error',message:String(error)});}
}
self.onmessage=(event:MessageEvent<unknown>)=>{
  const v=event.data;
  if(!record(v))return;
  if(v.type==='continue'){paused=false;pump();return;}
  if(v.type==='snapshot'){session?.port?.readDiagnosticsInto();postMessage({type:'snapshot',...snapshot()});return;}
  if(v.type==='stop'){
    clearTimeout(timer);paused=true;
    void session?.dispose().then(result=>{postMessage({type:'stopped',...result});close();}).catch(error=>postMessage({type:'error',message:String(error)}));return;
  }
  if(v.type!=='start'||typeof v.baseUrl!=='string'||(v.hz!==400&&v.hz!==800&&v.hz!==1200))return;
  const hz:PhysicsHz=v.hz,bodyBytes=v.bodyBytes;target=hz*(bodyBytes instanceof Uint8Array?1:8);
  session=new WasmSitlSession({hz,epoch:7,motorMapId:42,motorChannels:[0,1,2,3]},event=>{
    if(event.type==='initialized')initialBytes=event.memoryBytes;
    if(event.type==='booted')heartbeats=event.heartbeats;
    if(event.type==='serial')serialBytes+=event.bytes.length;
  },error=>postMessage({type:'error',message:error.message}));
  void session.start(v.baseUrl,v.manifest,'hal-'+hz+'-'+Date.now()).then(()=>{
    const p=session?.port;if(!p)throw Error('HAL did not bind');
    const input=p.input;input[0]=32;input[1]=35;input[2]=100;
    input[6]=0.25;input[7]=-0.5;input[8]=-9.80665;input[9]=0.1;input[10]=-0.2;input[11]=0.3;
    input[12]=Math.cos(0.25);input[15]=Math.sin(0.25);input[16]=0.21;input[17]=-0.03;input[18]=0.43;
    input[20]=16;input[22]=2;input[23]=0.5;input[24]=0.5;input[26]=0.5;
    if(bodyBytes instanceof Uint8Array) {
      const configuration=flightConfiguration(0,4);configuration.initialOmegaRadS=[0,0,0,0];
      physics=new BetFlightDynamics(new WebAssembly.Module(new Uint8Array(bodyBytes)),configuration,hz);
      coupling=new WasmSitlCoupling(p,physics,{latitudeRad:32*Math.PI/180,longitudeRad:35*Math.PI/180,
        altitudeMslM:100,geoidOffsetM:0,magneticNedGauss:[0.21,-0.03,0.43]});
    }
    pump();
  }).catch(error=>postMessage({type:'error',message:String(error)}));
};
