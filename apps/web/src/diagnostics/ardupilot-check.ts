import manifest from '../../../../native/ardupilot/wasm-artifact.manifest.json';
import {MavParser} from '../../../../packages/mavlink/src/codec';
import {EepromStore,storageIdentity} from '../../../../packages/autopilot/src/wasm-storage';
interface Diagnostic {
  start(profile:string,overrideManifest?:unknown):void;send(bytes:number[]):void;checkpoint():void;stop():void;terminate():void;
  events:unknown[];serial:number[];heartbeats:number;parameters:Record<string,number>;worker:Worker|null;
}
declare global{interface Window{ardupilotCheck:Diagnostic;ardupilotStorage:{EepromStore:typeof EepromStore;storageIdentity:typeof storageIdentity}}}
const status=document.querySelector('output');
let deadline:ReturnType<typeof setTimeout>|null=null;
function clearDeadline():void{if(deadline!==null){clearTimeout(deadline);deadline=null;}}
function armDeadline(ms:number):void{
 clearDeadline();deadline=setTimeout(()=>{diagnostic.terminate();diagnostic.events.push({type:'error',reason:'Firmware Worker deadline exceeded'});if(status)status.textContent='error';},ms);
}
const parser=new MavParser(frame=>{
  if(frame.systemId!==1||frame.componentId!==1)return;
  if(frame.id===0)diagnostic.heartbeats++;
  if(frame.id===22){const name=new TextDecoder().decode(frame.payload.subarray(8,24)).replace(/\0.*$/,'');diagnostic.parameters[name]=frame.view.getFloat32(0,true);}
});
const diagnostic:Diagnostic={events:[],serial:[],heartbeats:0,parameters:{},worker:null,
 start(profile,overrideManifest){
  if(this.worker)throw Error('Diagnostic Worker already exists');
  this.events=[];this.serial=[];this.heartbeats=0;this.parameters={};parser.reset();
  this.worker=new Worker(new URL('../ardupilot.worker.ts',import.meta.url),{type:'module'});
  this.worker.onmessage=(event:MessageEvent<unknown>)=>{
    const data=event.data;this.events.push(data);
    if(data!==null&&typeof data==='object'&&'type' in data){
      if(status)status.textContent=String(data.type);
      if(data.type==='serial'&&'bytes' in data&&data.bytes instanceof Uint8Array){
        if(this.serial.length+data.bytes.length>4*1024*1024)throw Error('Diagnostic capture exceeded budget');
        this.serial.push(...data.bytes);parser.push(data.bytes);
      }
      if(data.type==='booted')clearDeadline();
      if(data.type==='stopped'||data.type==='error'){clearDeadline();this.worker?.terminate();this.worker=null;}
    }
  };
  this.worker.onerror=event=>{this.events.push({type:'error',reason:event.message});if(status)status.textContent=event.message;this.worker?.terminate();this.worker=null;};
  armDeadline(30000);
  this.worker.postMessage({protocolVersion:1,type:'start',baseUrl:location.origin+'/__local-ardupilot/',manifest:overrideManifest??manifest,profile});
 },send(bytes){this.worker?.postMessage({protocolVersion:1,type:'serial',bytes:new Uint8Array(bytes)});},
 checkpoint(){this.worker?.postMessage({protocolVersion:1,type:'checkpoint'});},stop(){armDeadline(20000);this.worker?.postMessage({protocolVersion:1,type:'stop'});},
 terminate(){clearDeadline();this.worker?.terminate();this.worker=null;},
};
window.ardupilotCheck=diagnostic;
window.ardupilotStorage={EepromStore,storageIdentity};
