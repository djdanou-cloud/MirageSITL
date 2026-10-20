// Local artifact boot/storage boundary; TASK-046 may cold-bind its HAL adapter.
// Boot/storage events never admit autopilot READY.
import {admitArdupilotWasm,parseArdupilotWasmManifest} from './wasm-loader.ts';
import {EepromStore,storageIdentity,type EepromCheckpoint} from './wasm-storage.ts';
import {MavParser} from '../../mavlink/src/codec.ts';

interface FirmwareFs {readFile(path:string):Uint8Array;writeFile(path:string,bytes:Uint8Array):void}
interface FirmwareModule {
  HEAPU8:Uint8Array;FS:FirmwareFs;
  _ardupilot_malloc(n:number):number;_ardupilot_free(p:number):void;
  _ardupilot_serial_read(port:number,p:number,n:number):number;
  _ardupilot_serial_write(port:number,p:number,n:number):number;
}
interface FactoryOptions {
  arguments:string[];wasmBinary:Uint8Array;mainScriptUrlOrBlob:string;locateFile:(name:string)=>string;
  preRun:Array<(module:unknown)=>void>;print:(line:string)=>void;printErr:(line:string)=>void;
}
type Factory=(options:FactoryOptions)=>Promise<unknown>;
export type BrowserFirmwareEvent=
 | {type:'initialized';restoredRevision:number;memoryBytes:number;maximumMemoryBytes:number}
 | {type:'booted';heartbeats:number;memoryBytes:number;ownedPthreads:number}
 | {type:'serial';bytes:Uint8Array}
 | {type:'log';text:string}
 | {type:'checkpoint';revision:number;sha256:string;bytes:number};
function record(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object';}
export type BrowserFirmwareCommand=
 | {protocolVersion:1;type:'start';baseUrl:string;profile:string;manifest:unknown}
 | {protocolVersion:1;type:'serial';bytes:Uint8Array}
 | {protocolVersion:1;type:'checkpoint'|'stop'};
export function isBrowserFirmwareCommand(v:unknown):v is BrowserFirmwareCommand {
  if(!record(v)||v.protocolVersion!==1)return false;
  if(v.type==='start')return Object.keys(v).length===5&&typeof v.baseUrl==='string'&&v.baseUrl.length<=2048&&
    typeof v.profile==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(v.profile)&&Object.hasOwn(v,'manifest');
  if(v.type==='serial')return Object.keys(v).length===3&&v.bytes instanceof Uint8Array&&
    v.bytes.buffer instanceof ArrayBuffer&&v.bytes.length>0&&v.bytes.length<=4096;
  return (v.type==='checkpoint'||v.type==='stop')&&Object.keys(v).length===2;
}
function isFactory(v:unknown):v is Factory{return typeof v==='function';}
function isFs(v:unknown):v is FirmwareFs{return record(v)&&typeof v.readFile==='function'&&typeof v.writeFile==='function';}
function isModule(v:unknown):v is FirmwareModule {
  return record(v)&&v.HEAPU8 instanceof Uint8Array&&isFs(v.FS)&&
   ['_ardupilot_malloc','_ardupilot_free','_ardupilot_serial_read','_ardupilot_serial_write'].every(k=>typeof v[k]==='function');
}
async function fetchBytes(url:URL,expectedBytes:number):Promise<Uint8Array<ArrayBuffer>> {
  const response=await fetch(url,{cache:'no-store',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok||!response.body)throw Error('Local firmware fetch failed');
  const reader=response.body.getReader(),bytes=new Uint8Array(expectedBytes);let offset=0;
  try {for(;;){const {value,done}=await reader.read();if(done)break;
    if(offset+value.length>bytes.length)throw Error('Firmware response exceeds manifest size');bytes.set(value,offset);offset+=value.length;}}
  finally{await reader.cancel();reader.releaseLock();}
  if(offset!==expectedBytes)throw Error('Truncated firmware response');return bytes;
}
async function acquireProfile(identity:string):Promise<()=>Promise<void>> {
  if(!navigator.locks)throw Error('Exclusive firmware profile locks unavailable');
  let release=()=>{},lockTask:Promise<void>|undefined;
  const released=new Promise<void>(resolve=>{release=resolve;});
  await new Promise<void>((resolve,reject)=>{
    lockTask=navigator.locks.request('mirage-ardupilot:'+identity,{mode:'exclusive',ifAvailable:true},async lock=>{
      if(!lock){reject(Error('Firmware profile is already in use'));return;}resolve();await released;
    }).catch(reject).then(()=>undefined);
  });
  return async()=>{release();await lockTask;};
}
export class BrowserWasmSession {
  private module:FirmwareModule|null=null;
  private store:EepromStore|null=null;
  private releaseProfile:(()=>Promise<void>)|null=null;
  private glueUrl:string|null=null;
  private pointer=0;
  private timer:ReturnType<typeof setInterval>|null=null;
  private checkpointBusy=false;
  private saved:EepromCheckpoint|null=null;
  private readonly children=new Set<Worker>();
  private readonly emit:(event:BrowserFirmwareEvent)=>void;
  private readonly fail:(error:Error)=>void;
  private stopped=false;
  private booted=false;
  private heartbeats=0;
  private lastSaveMs=0;
  private readonly parser:MavParser;
  constructor(emit:(event:BrowserFirmwareEvent)=>void,fail:(error:Error)=>void,
    private readonly bindFirmware?: (value:unknown)=>void){
    this.emit=emit;this.fail=fail;
    this.parser=new MavParser(frame=>{
      if(frame.id!==0||frame.systemId!==1||frame.componentId!==1)return;
      this.heartbeats++;
      if(!this.booted&&this.heartbeats>=3){this.booted=true;this.emit({type:'booted',heartbeats:this.heartbeats,memoryBytes:this.memoryBytes,ownedPthreads:this.children.size});}
    });
  }
  get memoryBytes():number{return this.module?.HEAPU8.buffer.byteLength??0;}
  async start(baseUrl:string,unknownManifest:unknown,profile:string):Promise<void> {
    if(this.module||this.stopped)throw Error('Firmware session already initialized/disposed');
    if(typeof DedicatedWorkerGlobalScope==='undefined'||!(globalThis instanceof DedicatedWorkerGlobalScope))throw Error('Firmware runtime must execute in a dedicated Worker');
    if(!globalThis.crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw Error('Firmware requires cross-origin isolation');
    const manifest=parseArdupilotWasmManifest(unknownManifest),base=new URL(baseUrl,location.href);
    if(manifest.module.bytes>64*1024*1024||manifest.glue.bytes>4*1024*1024)throw Error('Firmware artifact size exceeds local boot budget');
    if(base.origin!==location.origin||!base.pathname.endsWith('/'))throw Error('Firmware artifacts must be same-origin');
    const identity=storageIdentity(manifest.sourceCommit,manifest.module.sha256,profile);
    this.releaseProfile=await acquireProfile(identity);
    try {
      const [wasm,glue]=await Promise.all([fetchBytes(new URL(manifest.module.file,base),manifest.module.bytes),fetchBytes(new URL(manifest.glue.file,base),manifest.glue.bytes)]);
      const admission=await admitArdupilotWasm(wasm,glue,manifest);if(!admission.ok)throw Error(admission.reason);
      this.store=await EepromStore.open(identity);this.saved=await this.store.load();
      // Execute precisely the admitted glue, including the pthread entrypoint.
      // Using its URL again would allow a second unverified network response.
      this.glueUrl=URL.createObjectURL(new Blob([glue],{type:'text/javascript'}));
      const imported:unknown=await import(/* @vite-ignore */ this.glueUrl);
      if(!record(imported)||!isFactory(imported.default))throw Error('Invalid firmware factory');
      const OriginalWorker=globalThis.Worker,children=this.children,canSpawn=()=>!this.stopped;
      globalThis.Worker=class extends OriginalWorker {
        constructor(url:string|URL,options?:WorkerOptions){
          if(!canSpawn())throw Error('Firmware session disposed before pthread creation');
          if(children.size>=16)throw Error('Firmware pthread budget exceeded');
          super(url,options);children.add(this);
        }
      };
      const value:unknown=await imported.default({
        arguments:['--model','quad','--serial0','wasm','--serial1','none','--serial2','none'],wasmBinary:wasm,
        mainScriptUrlOrBlob:this.glueUrl,locateFile:name=>new URL(name,base).href,
        preRun:[module=>{
          if(!record(module)||!isFs(module.FS))throw Error('Firmware filesystem unavailable before boot');
          if(this.saved)module.FS.writeFile('/eeprom.bin',this.saved.image);
        }],print:text=>this.emit({type:'log',text}),printErr:text=>this.emit({type:'log',text}),
      });
      if(!isModule(value))throw Error('Firmware runtime exports invalid');this.module=value;
      if(!(value.HEAPU8.buffer instanceof SharedArrayBuffer))throw Error('Firmware runtime memory is not shared');
      this.bindFirmware?.(value);
      this.pointer=value._ardupilot_malloc(4096);if(!this.pointer)throw Error('Firmware serial buffer allocation failed');
      this.emit({type:'initialized',restoredRevision:this.saved?.revision??0,memoryBytes:this.memoryBytes,maximumMemoryBytes:manifest.memory.maximumPages*65536});
      this.timer=setInterval(()=>{
        try {
          const m=this.module;if(!m||this.stopped)return;
          const count=m._ardupilot_serial_read(0,this.pointer,4096);
          if(!Number.isInteger(count)||count<0||count>4096)throw Error('Invalid firmware serial read');
          if(count){const bytes=m.HEAPU8.slice(this.pointer,this.pointer+count);this.parser.push(bytes);this.emit({type:'serial',bytes});}
          if(this.booted&&!this.checkpointBusy&&performance.now()-this.lastSaveMs>2000)void this.checkpoint().catch(error=>this.fail(error instanceof Error?error:Error(String(error))));
        }catch(error){this.fail(error instanceof Error?error:Error(String(error)));}
      },25);
    }catch(error){await this.dispose(false);throw error;}
  }
  write(bytes:Uint8Array):void {
    const m=this.module;if(!m||this.stopped||bytes.length<1||bytes.length>4096)throw Error('Invalid firmware serial write');
    m.HEAPU8.set(bytes,this.pointer);
    const count=m._ardupilot_serial_write(0,this.pointer,bytes.length);
    if(count!==bytes.length)throw Error('Firmware serial write incomplete');
  }
  async checkpoint():Promise<EepromCheckpoint> {
    while(this.checkpointBusy)await new Promise(resolve=>setTimeout(resolve,10));
    if(!this.module||!this.store||this.stopped||!this.booted)throw Error('Firmware not booted for checkpoint');
    this.checkpointBusy=true;
    try {
      // AP_Param persists asynchronously. Require one second of stable file bytes;
      // never promise that an uncheckpointed change survives abrupt termination.
      let bytes=this.module.FS.readFile('/eeprom.bin'),stable=0;
      for(let i=0;i<40&&stable<4;i++){
        await new Promise(resolve=>setTimeout(resolve,250));
        const next=this.module.FS.readFile('/eeprom.bin');
        const equal=next.length===bytes.length&&next.every((v,k)=>v===bytes[k]);
        stable=equal?stable+1:0;bytes=next;
      }
      if(stable<4)throw Error('EEPROM did not stabilize before checkpoint');
      this.saved=await this.store.commit(bytes,this.saved?.revision??0);this.lastSaveMs=performance.now();
      this.emit({type:'checkpoint',revision:this.saved.revision,sha256:this.saved.sha256,bytes:this.saved.image.length});return this.saved;
    }finally{this.checkpointBusy=false;}
  }
  async dispose(checkpoint=true):Promise<{terminatedPthreads:number}> {
    if(this.timer!==null){clearInterval(this.timer);this.timer=null;}
    // Drain an owned checkpoint before releasing the profile, even after failure.
    while(this.checkpointBusy)await new Promise(resolve=>setTimeout(resolve,10));
    let failure:unknown;
    try{if(checkpoint&&this.booted&&!this.stopped)await this.checkpoint();}catch(error){failure=error;}
    this.stopped=true;
    if(this.module&&this.pointer){this.module._ardupilot_free(this.pointer);this.pointer=0;}
    this.module=null;this.store?.close();this.store=null;
    if(this.glueUrl){URL.revokeObjectURL(this.glueUrl);this.glueUrl=null;}
    await this.releaseProfile?.();this.releaseProfile=null;
    // Finish every await before killing peers. Queued runtime proxy callbacks
    // must not run in a partially terminated pthread runtime while we yield.
    const terminatedPthreads=this.children.size;
    for(const worker of this.children){
      // Terminate is asynchronous. A queued pthread message must not execute
      // a native proxy call after its peer has been killed while holding a lock.
      worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;
      worker.terminate();
    }
    this.children.clear();
    if(failure)throw failure instanceof Error?failure:Error('Firmware checkpoint failed during shutdown');return {terminatedPthreads};
  }
}
