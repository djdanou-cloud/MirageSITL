/// <reference lib="webworker" />
// Use the production firmware owner and actual profile lock. Stretch only the
// release Promise so queued runtime messages run during the teardown boundary.
import '../../apps/web/src/ardupilot.worker.ts';
let profileReleased=false;
const OriginalWorker=Worker;
globalThis.Worker=class extends OriginalWorker {
  override terminate():void {
    postMessage({type:'pthread-termination-order',profileReleased});
    super.terminate();
  }
};
const request=navigator.locks.request.bind(navigator.locks);
navigator.locks.request=new Proxy(request,{
  apply(target,thisArg,args:unknown[]):unknown {
    const result:unknown=Reflect.apply(target,thisArg,args);
    if(!(result instanceof Promise))throw Error('Web Lock request must return a Promise');
    return result.then(async(value:unknown)=>{
      await new Promise(resolve=>setTimeout(resolve,100));
      profileReleased=true;
      postMessage({type:'profile-release-delayed',delayMs:100});
      return value;
    });
  },
});
