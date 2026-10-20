/// <reference lib="webworker" />
import {WasmSitlSession,WasmSitlCoupling,HalState} from '../../packages/autopilot/src/wasm-sitl.ts';
import {BetFlightDynamics} from '../../packages/physics/src/bet-dynamics.ts';
import {parityAircraft,PARITY_HZ,PARITY_ORIGIN} from '../support/autopilot-parity.ts';
import {ParityTelemetry,ParityCommands} from '../support/parity-mavlink.ts';
let session:WasmSitlSession|null=null,physics:BetFlightDynamics|null=null,coupling:WasmSitlCoupling|null=null;
let timer:ReturnType<typeof setTimeout>|undefined,stopped=false;
let startWallMs=0;
const telemetry=new ParityTelemetry(),samples:unknown[]=[],raw:number[]=[];
const wireChunks:{tick:number;bytes:number[]}[]=[],transmitted:{tick:number;bytes:number[]}[]=[];
let commands:ParityCommands|null=null;
function record(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object';}
function pump():void {
  try {
    const port=session?.port;if(!port||!physics||!coupling||stopped)return;
    const deadline=performance.now()+4;
    do {
      if(port.state!==HalState.requested)continue;
      const tick=port.steps;telemetry.simS=tick/PARITY_HZ;
      if(tick>(performance.now()-startWallMs)*PARITY_HZ*2/1000)break;
      commands?.tick(tick);
      if(tick%8===0) {
        const s=physics.state;samples.push({tick,positionNedM:[s.north,s.east,s.down],quaternionWxyz:[s.qw,s.qx,s.qy,s.qz],
          armed:telemetry.armed,mode:telemetry.mode,ekfFlags:telemetry.ekfFlags,innovationRatios:[...telemetry.innovations],
          heartbeatAgeS:telemetry.heartbeatS<0?null:telemetry.simS-telemetry.heartbeatS,ekfAgeS:telemetry.ekfS<0?null:telemetry.simS-telemetry.ekfS,
          validityFlags:physics.validityFlags});
        if(tick%8000===0)postMessage({type:'progress',tick,state:samples.at(-1),fault:coupling.fault});
      }
      if(tick>=96000){stopped=true;postMessage({type:'complete',samples,raw,wireChunks,transmitted});return;}
      if(!coupling.stepInto())throw Error('Parity coupling failed: '+coupling.fault+' '+port.fault);
    }while(performance.now()<deadline);
    timer=setTimeout(pump,0);
  }catch(error){postMessage({type:'error',message:String(error),samples,raw});}
}
self.onmessage=(e:MessageEvent<unknown>)=>{
  const v=e.data;if(!record(v))return;
  if(v.type==='stop') {stopped=true;clearTimeout(timer);void session?.dispose().then(result=>{postMessage({type:'stopped',...result});close();});return;}
  if(v.type!=='start'||typeof v.baseUrl!=='string'||typeof v.defaultsText!=='string'||!(v.bodyBytes instanceof Uint8Array))return;
  physics=new BetFlightDynamics(new WebAssembly.Module(new Uint8Array(v.bodyBytes)),parityAircraft(),PARITY_HZ);
  commands=new ParityCommands(bytes=>{session?.writeSerial(bytes);transmitted.push({tick:session?.port?.steps??0,bytes:Array.from(bytes)});},v.failsafe===true);
  session=new WasmSitlSession({hz:PARITY_HZ,epoch:47,motorMapId:42,motorChannels:[0,1,2,3]},event=>{
    if(event.type==='serial'){for(const b of event.bytes)raw.push(b);wireChunks.push({tick:session?.port?.steps??0,bytes:Array.from(event.bytes)});telemetry.parser.push(event.bytes);}
    if(event.type==='log')postMessage(event);
  },error=>postMessage({type:'error',message:error.message}),{defaultsText:v.defaultsText,
    home:{latitudeDeg:-35.362938,longitudeDeg:149.165085,altitudeMslM:584,yawDeg:0}});
  void session.start(v.baseUrl,v.manifest,'parity-'+Date.now()).then(()=>{
    if(!session?.port||!physics)throw Error('Missing bound parity session');
    session.port.input[23]=0.5;session.port.input[24]=0.5;session.port.input[26]=0.5;
    coupling=new WasmSitlCoupling(session.port,physics,PARITY_ORIGIN);startWallMs=performance.now();pump();
  }).catch(error=>postMessage({type:'error',message:String(error)}));
};
