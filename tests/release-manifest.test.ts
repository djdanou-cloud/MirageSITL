import { it } from "vitest";
import { nodeCheck } from "./support/node-evidence";
it("release inventory rejects traversal, unsupported roots and wrong hashes before publication", () => nodeCheck(`
import {buildReleaseManifest} from './scripts/release-manifest.mjs';
const v={schemaVersion:1,artifacts:[{path:'../secret',sha256:'a'.repeat(64),license:'test-only'}],systemReportPath:'test-results/validation/system-report.json',systemReportSha256:'b'.repeat(64)};
assert.throws(()=>buildReleaseManifest(v),/outside/);
assert.throws(()=>buildReleaseManifest({...v,artifacts:[{...v.artifacts[0],path:'package-lock.json'}]}),/outside/);
assert.throws(()=>buildReleaseManifest({...v,artifacts:[]}),/inventory/);
`));

it("inventories actual bounded output bytes, retains blocked status and rejects tampering/symlink escape", () => nodeCheck(`
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {buildReleaseManifest} from './scripts/release-manifest.mjs';
import {sha256} from './scripts/validation/evidence.mjs';
const root=mkdtempSync(join(tmpdir(),'mirage-release-'));
try{
 execFileSync('git',['init','--quiet',root]);
 execFileSync('git',['-c','user.name=Schema test','-c','user.email=test@example.invalid','commit','--quiet','--allow-empty','-m','Initialize isolated test repository'],{cwd:root});
 mkdirSync(join(root,'apps/web/dist'),{recursive:true});mkdirSync(join(root,'test-results/validation'),{recursive:true});
 writeFileSync(join(root,'package-lock.json'),'{}');const bytes=Buffer.from('<html>Own-work schema fixture</html>');
 writeFileSync(join(root,'apps/web/dist/index.html'),bytes);
 const system=Buffer.from(JSON.stringify({schemaVersion:1,kind:'system-report',status:'BLOCKED_EXTERNAL',metrics:{modes:{}}}));
 writeFileSync(join(root,'test-results/validation/system-report.json'),system);
 const input={schemaVersion:1,artifacts:[{path:'apps/web/dist/index.html',sha256:sha256(bytes),license:'CC0-1.0'}],systemReportPath:'test-results/validation/system-report.json',systemReportSha256:sha256(system)};
 const result=buildReleaseManifest(input,root);assert.equal(result.status,'BLOCKED_EXTERNAL');assert.equal(result.artifacts[0].bytes,bytes.length);
 assert.equal(result.artifacts[0].sha256,sha256(bytes));assert.equal(result.dirty,true);
 writeFileSync(join(root,'apps/web/dist/index.html'),'changed');assert.throws(()=>buildReleaseManifest(input,root),/hash/);
 mkdirSync(join(root,'outside'));writeFileSync(join(root,'outside/alias.json'),'{}');
 // Directory junctions exercise realpath containment on Windows without file-symlink privileges.
 symlinkSync(join(root,'outside'),join(root,'apps/web/dist/alias'),'junction');
 // An alias within the checkout is still outside allowed artifact roots once resolved.
 assert.throws(()=>buildReleaseManifest({...input,artifacts:[{...input.artifacts[0],path:'apps/web/dist/alias/alias.json'}]},root));
}finally{rmSync(root,{recursive:true,force:true})}
`));

it("the delivery manifest blocks on an unsettled license or a pending decision, and lists what is restricted", () => nodeCheck(`
import {deliveryOpenItems} from './scripts/release-manifest.mjs';
const row=(id,licenseStatus,status,decision)=>({id,licenseStatus,status,decision});
assert.deepEqual(deliveryOpenItems([row('a','reviewed','ready'),row('b','not-applicable','pending')]),{blockers:[],restricted:[]});
assert.deepEqual(deliveryOpenItems([row('c','unreviewed','ready')]).blockers,['c: license unreviewed']);
const pending=deliveryOpenItems([row('d','restricted','pending','D-02')]);
assert.deepEqual(pending.blockers,['d: restricted, and waiting for a decision: D-02']);
assert.deepEqual(pending.restricted,[{id:'d',used:true,decision:'D-02'}]);
const settled=deliveryOpenItems([row('e','restricted','ready','taken'),row('f','restricted','not-needed-phase1','later')]);
assert.deepEqual(settled.blockers,[]);
assert.deepEqual(settled.restricted,[{id:'e',used:true,decision:'taken'},{id:'f',used:false,decision:'later'}]);
`));

it("the delivery manifest of the checkout names its sources, built files and datasets, and writes nothing else", () => nodeCheck(`
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {buildDeliveryManifest} from './scripts/release-manifest.mjs';
import {sha256} from './scripts/validation/evidence.mjs';
const root=mkdtempSync(join(tmpdir(),'mirage-delivery-'));
try{
 execFileSync('git',['init','--quiet',root]);
 mkdirSync(join(root,'config'));mkdirSync(join(root,'apps/web/dist/assets'),{recursive:true});
 const inventory={items:[{id:'web-application',category:'application',version:'repository commit',license:'Project-owned',licenseStatus:'not-applicable',status:'ready'}]};
 writeFileSync(join(root,'config/offline-inventory.json'),JSON.stringify(inventory));
 writeFileSync(join(root,'package-lock.json'),'{}');
 const page=Buffer.from('<html>Own-work schema fixture</html>');writeFileSync(join(root,'apps/web/dist/assets/index.html'),page);
 execFileSync('git',['-C',root,'add','config','package-lock.json']);
 execFileSync('git',['-C',root,'-c','user.name=Schema test','-c','user.email=test@example.invalid','commit','--quiet','-m','Initialize isolated fixture']);
 // Nothing built yet elsewhere, and a dirty tree: blocked, by name.
 const open=buildDeliveryManifest(root);
 assert.equal(open.status,'BLOCKED_EXTERNAL');
 assert.ok(open.reasons.some(reason=>reason.includes('packages/wasm-bet/dist is not built')));
 assert.deepEqual(open.artifacts,[{path:'apps/web/dist/assets/index.html',sha256:sha256(page),bytes:page.length,license:'Project-owned'}]);
 assert.equal(open.sources.locks['package-lock.json'],sha256(Buffer.from('{}')));
 assert.equal(open.datasets[0].id,'web-application');
 assert.equal(open.installed,null);
 const noHome=buildDeliveryManifest(root,{home:join(root,'nowhere')});
 assert.ok(noHome.reasons.some(reason=>reason.includes('has no installation')));
}finally{rmSync(root,{recursive:true,force:true});}
`));
