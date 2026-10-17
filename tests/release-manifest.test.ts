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
 symlinkSync(join(root,'package-lock.json'),join(root,'apps/web/dist/alias.json'));
 // An alias within the checkout is still outside allowed artifact roots once resolved.
 assert.throws(()=>buildReleaseManifest({...input,artifacts:[{...input.artifacts[0],path:'apps/web/dist/alias.json'}]},root));
}finally{rmSync(root,{recursive:true,force:true})}
`));
