// TASK-159: the native evidence of scripts/check-param-sitl.mjs. Its judge
// must reject false evidence independently of the run that produced it, and
// a host without an installed, verified firmware is BLOCKED_EXTERNAL rather
// than a pass. The run itself needs the TASK-152 installation:
//   node scripts/check-param-sitl.mjs --home <launcher home>
import { it } from "vitest";
import { nodeCheck } from "../support/node-evidence";

const REPORT = `
const list=(n,extra=[])=>({download:{kind:'complete',total:n+extra.length},
 parameters:[...Array.from({length:n},(_,i)=>({name:'P'+i,value:i,type:9,index:i})),...extra.map((p,j)=>({...p,index:n+j}))]});
const confirmed=(name,value,extra={})=>({name,state:{kind:'confirmed',value:Math.fround(value),rebootRequired:false,...extra},shown:null});
const baseline=()=>{
 const values=[{name:'ATC_RAT_RLL_I',value:Math.fround(0.00017),type:9},{name:'SERIAL1_PROTOCOL',value:1,type:2},{name:'BARO1_DEVID',value:65540,type:6}];
 const second=list(4,[...values,{name:'GRIP_TYPE',value:0,type:2}]);
 return {
  first:list(6),
  writes:[{...confirmed('ATC_RAT_RLL_I',0.00017),shown:'0.00017'},confirmed('SERIAL1_PROTOCOL',1,{rebootRequired:true}),
   {name:'BARO1_DEVID',state:{kind:'refused',by:'autopilot',reported:65540}},{name:'MIRAGE_NO_PARAM',state:{kind:'refused',by:'service',reported:null}},
   {name:'FRAME_CLASS',state:{kind:'refused',by:'service',reported:null}}],
  pause:{wallMs:5001,simAdvancedS:0,duringPause:'requested',after:'confirmed'},
  renumber:{staleAfterEnable:true},
  second,
  lossy:{...structuredClone(second),dropped:2,indexReads:2},
  metadata:{covered:6,volatile:[]},
 };
};
`;

it("passes a consistent report and rejects each false claim", () => nodeCheck(`
import {assessParamRun} from './scripts/check-param-sitl.mjs';
${REPORT}
assert.deepEqual(assessParamRun(baseline()),[]);
const broken=[
 ['incomplete first list',r=>{r.first.download={kind:'downloading',received:5,total:6};}],
 ['missing index',r=>{r.first.parameters[3].index=9;}],
 ['repeated name',r=>{r.first.parameters[2].name='P1';}],
 ['value not float32',r=>{r.first.parameters[0].value=0.1;}],
 ['confirmed at another value',r=>{r.writes[0].state.value=0.00017;}],
 ['shown rounded',r=>{r.writes[0].shown='0.00';}],
 ['reboot flag missing',r=>{r.writes[1].state.rebootRequired=false;}],
 ['refused by the wrong party',r=>{r.writes[2].state.by='service';}],
 ['refusal not in the list',r=>{r.writes[2].state.reported=1;}],
 ['unknown name sent',r=>{r.writes[3].state={kind:'timeout'};}],
 ['write absent',r=>{r.writes.pop();}],
 ['confirmed value not read back',r=>{r.second.parameters.find(p=>p.name==='ATC_RAT_RLL_I').value=0.125;}],
 ['timed out while paused',r=>{r.pause.duringPause='timeout';}],
 ['simulated time moved while paused',r=>{r.pause.simAdvancedS=0.0025;}],
 ['short pause',r=>{r.pause.wallMs=1000;}],
 ['never resumed',r=>{r.pause.after='requested';}],
 ['not stale after enable',r=>{r.renumber.staleAfterEnable=false;}],
 ['second list not longer',r=>{r.second.download.total=6;r.second.parameters=r.second.parameters.slice(0,6);}],
 ['nothing lost',r=>{r.lossy.dropped=0;}],
 ['lost entries not read',r=>{r.lossy.indexReads=1;}],
 ['lossy list differs',r=>{r.lossy.parameters[0].value=99;}],
 ['no metadata',r=>{r.metadata.covered=0;}],
];
for(const [label,change] of broken){const r=baseline();change(r);assert.notDeepEqual(assessParamRun(r),[],label);}
const volatile=baseline();volatile.lossy.parameters[0].value=99;volatile.metadata.volatile=['P0'];
assert.deepEqual(assessParamRun(volatile),[]);
`));

it("is BLOCKED_EXTERNAL without an installed firmware, and writes no report", () => nodeCheck(`
import {spawnSync} from 'node:child_process';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'mirage-param-home-'));
try{
 const out=join(home,'report.json');
 const r=spawnSync(process.execPath,['scripts/check-param-sitl.mjs','--home',home,'--out',out],{encoding:'utf8'});
 assert.equal(r.status,2,r.stderr+r.stdout);
 assert.match(r.stderr,/^BLOCKED_EXTERNAL: no single installed firmware/);
 assert.equal(existsSync(out),false);
}finally{rmSync(home,{recursive:true,force:true});}
`), 30_000);
