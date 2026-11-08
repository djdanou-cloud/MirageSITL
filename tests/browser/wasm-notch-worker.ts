/// <reference lib="webworker" />
// TASK-105 notch-tracking check (SPECS_SIMULATION_ENGINES "Notch tracking in the browser firmware"): the real HAL-enabled firmware,
// disarmed and stationary, with four motors' speeds published through HAL mailbox version 2 in three phases of simulated time;
// afterwards its own DataFlash logs are copied out of its file system and posted to the page.
import {WasmSitlSession,HalState} from '../../packages/autopilot/src/wasm-sitl.ts';
import {newActuatorFrameV2} from '@mirage/protocol';

const HZ=800;
/** Phases, by simulated time: [end s, speeds rpm of motors 1..4]. The last runs on to `END_S` so the logger flushes the phase. */
const PHASES:readonly (readonly [number,readonly number[]])[]=[[9,[4800,4800,4800,4800]],[12,[7200,7200,7200,7200]],[15,[4000,5000,6000,7000]]];
const END_S=17;
const DEFAULTS=['INS_HNTCH_ENABLE 1','INS_HNTCH_MODE 3','INS_HNTCH_REF 1','INS_HNTCH_FREQ 40','INS_HNTCH_BW 20','LOG_DISARMED 1'].join('\n')+'\n';
let session:WasmSitlSession|null=null,timer:ReturnType<typeof setTimeout>|undefined,serialBytes=0,startedMs=0;
const actuator=newActuatorFrameV2();
function record(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object';}
function speedsAt(step:number):readonly number[] {
  const t=step/HZ;
  for(const [end,speeds] of PHASES)if(t<end)return speeds;
  return PHASES[PHASES.length-1]![1];
}
function finish():void {
  const s=session,p=s?.port;if(!s||!p)return;
  const logs=s.readLogs();
  postMessage({type:'complete',steps:p.steps,fault:p.fault,serialBytes,memoryStable:p.memoryStable,
    logs:logs.map(log=>({name:log.name,bytes:Array.from(log.bytes)}))});
}
function pump():void {
  try {
    const p=session?.port;if(!p)return;
    if(p.fault)throw Error(p.fault);
    const deadline=performance.now()+4;
    do {
      // Paced to real time, as the application runs it: faster, the firmware's log writer falls behind and its file ends early
      // (the first run's log stopped at 7.86 s of 17 s).
      if(p.steps>=(performance.now()-startedMs)*HZ/1000)break;
      if(p.state===HalState.requested) {
        if(!p.readDiagnosticsInto()||!p.readActuatorsInto(actuator))throw Error('HAL output read failed');
        if(p.steps>=END_S*HZ){finish();return;}
        const speeds=speedsAt(p.steps+1);
        for(let i=0;i<4;i++)p.motorRpm[i]=speeds[i]!;
        if(!p.submit())throw Error('HAL sensor submission failed');
      }
    } while(performance.now()<deadline);
    timer=setTimeout(pump,1);
  }catch(error){postMessage({type:'error',message:String(error)});}
}
self.onmessage=(event:MessageEvent<unknown>)=>{
  const v=event.data;
  if(!record(v))return;
  if(v.type==='stop'){
    clearTimeout(timer);
    void session?.dispose().then(result=>{postMessage({type:'stopped',...result});close();}).catch(error=>postMessage({type:'error',message:String(error)}));return;
  }
  if(v.type!=='start'||typeof v.baseUrl!=='string')return;
  session=new WasmSitlSession({hz:HZ,epoch:9,motorMapId:42,motorChannels:[0,1,2,3]},event=>{
    if(event.type==='serial')serialBytes+=event.bytes.length;
  },error=>postMessage({type:'error',message:error.message}),
  {defaultsText:DEFAULTS,home:{latitudeDeg:32,longitudeDeg:35,altitudeMslM:100,yawDeg:0}});
  void session.start(v.baseUrl,v.manifest,'notch-'+Date.now()).then(()=>{
    const p=session?.port;if(!p)throw Error('HAL did not bind');
    // A stationary, level aircraft: the same sensor state as tests/browser/wasm-hal-worker.ts.
    const input=p.input;input[0]=32;input[1]=35;input[2]=100;
    input[8]=-9.80665;input[12]=1;input[16]=0.21;input[17]=-0.03;input[18]=0.43;
    input[20]=16;input[22]=2;input[23]=0.5;input[24]=0.5;input[26]=0.5;
    startedMs=performance.now();pump();
  }).catch(error=>postMessage({type:'error',message:String(error)}));
};
