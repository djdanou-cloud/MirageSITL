import { it } from "vitest";
import { nodeCheck } from "../support/node-evidence";
it("owns actual child processes, caps output/deadlines, and blocks absent flight drivers", () => nodeCheck(`
import {runOwned,runSitl,assessFlight} from './scripts/run-sitl.mjs';
assert.equal((await runOwned(process.execPath,['-e','process.stdout.write("owned")'])).toString(),'owned');
await assert.rejects(runOwned(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:50}),/deadline/);
await assert.rejects(runOwned(process.execPath,['-e','process.stdout.write("x".repeat(10000))'],{maxBytes:10}),/budget/);
if(process.platform!=='win32') {
 const childCode='process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
 const parentCode='const c=require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(childCode)+'],{stdio:["ignore","inherit","inherit"]});console.log(c.pid);setTimeout(()=>process.exit(0),100)';
 const started=performance.now();
 const bytes=await runOwned(process.execPath,['-e',parentCode],{timeoutMs:2000});
 assert(/^\\d+\\s*$/.test(bytes.toString()));assert(performance.now()-started<1800);
}
assert.equal((await runSitl({})).status,'BLOCKED_EXTERNAL');
assert.throws(()=>assessFlight({schemaVersion:1,provenance:{source:'synthetic'},samples:[]}));
const samples=Array.from({length:104},(_,i)=>{const stage=i===0?'arm':i===1?'takeoff':i===103?'land':'hold';return {timeS:i/10,stage,armed:i!==103,altitudeM:i===0||i===103?0:10,mode:i===103?9:4,ekfHealthy:true,servoFrame:i,pwmUs:[1200,1200,1200,1200]}});
const trace={schemaVersion:1,provenance:{source:'native-sitl',operator:'schema-test-only',recordedAt:'2026-10-17T00:00:00Z',firmwareSha256:'a'.repeat(64),modelSha256:'b'.repeat(64)},samples};
assert.equal(assessFlight(trace).metrics.holdDurationS,10);
assert.throws(()=>assessFlight({...trace,samples:samples.map(s=>({...s,mode:99}))}),/mode/);
assert.throws(()=>assessFlight({...trace,samples:samples.filter(s=>s.servoFrame!==10)}));
`));
