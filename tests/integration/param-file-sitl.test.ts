// TASK-161: the native evidence of scripts/check-param-file-sitl.mjs. Its
// judge must reject false evidence independently of the run that produced
// it; the committed report must pass it; and a host without an installed,
// verified firmware is BLOCKED_EXTERNAL rather than a pass. The run itself
// needs the TASK-152 installation:
//   node scripts/check-param-file-sitl.mjs --home <launcher home>
import { it } from "vitest";
import { nodeCheck } from "../support/node-evidence";

it("accepts the committed report and rejects each false claim", () => nodeCheck(`
import {readFileSync} from 'node:fs';
import {assessParamFileRun} from './scripts/check-param-file-sitl.mjs';
const committed=JSON.parse(readFileSync('test-results/validation/param-file-sitl.json','utf8'));
assert.equal(committed.status,'PASS');
assert.deepEqual(assessParamFileRun(committed),[]);
const broken=[
 ['a write not confirmed',r=>{r.writes[0].state.kind='timeout';}],
 ['a write not in the exported list',r=>{r.exported.parameters.find(p=>p.name==='RTL_ALT_M').value=20;}],
 ['a value that does not read back',r=>{r.loaded.parameters.find(p=>p.name==='ATC_RAT_RLL_I').value=0.00017;}],
 ['a parameter missing after loading',r=>{r.loaded.parameters=r.loaded.parameters.filter(p=>p.name!=='LAND_SPD_MS');r.loaded.download.total--;}],
 ['an incomplete list',r=>{r.loaded.download={kind:'failed'};}],
 ['a write hidden as autopilot-owned',r=>{r.autopilotOwned.push('GPS1_DELAY_MS');}],
 ['a file that does not hold the list',r=>{r.file.lines--;}],
 ['a file whose text was changed',r=>{r.file.text=r.file.text.replace('RTL_ALT_M,20.25','RTL_ALT_M,20');}],
 ['a stored parameter store',r=>{r.loadedFresh=false;}],
 ['everything excluded',r=>{r.autopilotOwned=r.exported.parameters.map(p=>p.name).filter(n=>!['ATC_RAT_RLL_I','RTL_ALT_M','LAND_SPD_MS','GPS1_DELAY_MS'].includes(n));}],
];
for(const [label,change] of broken){const r=structuredClone(committed);change(r);assert.notDeepEqual(assessParamFileRun(r),[],label);}
`));

it("is BLOCKED_EXTERNAL without an installed firmware, and writes no report", () => nodeCheck(`
import {spawnSync} from 'node:child_process';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'mirage-param-file-home-'));
try{
 const out=join(home,'report.json');
 const r=spawnSync(process.execPath,['scripts/check-param-file-sitl.mjs','--home',home,'--out',out],{encoding:'utf8'});
 assert.equal(r.status,2,r.stderr+r.stdout);
 assert.match(r.stderr,/^BLOCKED_EXTERNAL: no single installed firmware/);
 assert.equal(existsSync(out),false);
}finally{rmSync(home,{recursive:true,force:true});}
`), 30_000);
