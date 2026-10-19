/// <reference lib="webworker" />
import {BrowserWasmSession,isBrowserFirmwareCommand} from '../../../packages/autopilot/src/wasm-browser';
const scope=self as DedicatedWorkerGlobalScope;
let session:BrowserWasmSession|null=null,failed=false;
async function fail(error:unknown):Promise<void>{
  if(failed)return;failed=true;
  try{await session?.dispose(false);}finally{scope.postMessage({type:'error',reason:error instanceof Error?error.message:String(error)});scope.close();}
}
scope.onmessage=(event:MessageEvent<unknown>)=>{
  const data=event.data;
  void (async()=>{
    if(!isBrowserFirmwareCommand(data))throw Error('Invalid firmware Worker message');
    if(data.type==='start'){
      if(session||typeof data.baseUrl!=='string'||typeof data.profile!=='string')throw Error('Invalid firmware start');
      session=new BrowserWasmSession(message=>scope.postMessage(message),error=>{void fail(error);});
      await session.start(data.baseUrl,data.manifest,data.profile);
    }else if(data.type==='serial'){
      if(!(data.bytes instanceof Uint8Array)||!session)throw Error('Invalid serial bytes');session.write(data.bytes);
    }else if(data.type==='checkpoint'){
      if(!session)throw Error('No firmware session');await session.checkpoint();
    }else if(data.type==='stop'){
      const result=await session?.dispose();scope.postMessage({type:'stopped',...result});scope.close();
    }else throw Error('Unknown firmware Worker message');
  })().catch(error=>{void fail(error);});
};
