// Bounded native acquisition, separate from the healthy TASK-042 flight validator.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {runOwned} from './run-sitl.mjs';
import {sha256,hash} from './validation/evidence.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
if(process.platform==='win32'||args.length!==4||args[0]!=='--output'||args[2]!=='--case')throw Error('Linux: --output NEW_CAPTURE_DIRECTORY --case CASE_ID');
const directory=resolve(args[1]),caseId=args[3];
const cases=['control','jamming','position-step','velocity-drift','magnetic','motor-loss'];
if(caseId==='all') {
  for(const id of cases) {
    const output=await runOwned(process.execPath,[fileURLToPath(import.meta.url),'--output',join(directory,id),'--case',id],{maxBytes:32*1024*1024});
    process.stdout.write(output);
  }
  process.exit(0);
}
if(!cases.includes(caseId))throw Error('Unknown case');
const env=process.env,pin=JSON.parse(readFileSync(join(root,'scripts/sitl.lock.json')));
if(!env.MIRAGE_SITL_SOURCE||!env.MIRAGE_SITL_BINARY||!env.MIRAGE_SITL_PYTHON||!hash(env.MIRAGE_SITL_BINARY_SHA256))throw Error('Missing pinned native installation');
if(execFileSync('git',['rev-parse','HEAD'],{cwd:env.MIRAGE_SITL_SOURCE,encoding:'utf8'}).trim()!==pin.commit||
  execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:env.MIRAGE_SITL_SOURCE,encoding:'utf8'}).trim())throw Error('Firmware source pin/cleanliness mismatch');
const binary=readFileSync(env.MIRAGE_SITL_BINARY);
if(binary.subarray(0,4).toString('hex')!=='7f454c46'||sha256(binary)!==env.MIRAGE_SITL_BINARY_SHA256)throw Error('Native ELF identity mismatch');
env.MIRAGE_EW_CASE=caseId;env.MIRAGE_SITL_CAPTURE_DIR=directory;
const cwd=mkdtempSync(join(tmpdir(),'mirage-ew-run-'));
mkdirSync(directory,{recursive:true});
try {
  const output=await runOwned(process.execPath,[join(root,'scripts/sitl/driver.mjs'),'--binary',env.MIRAGE_SITL_BINARY,'--parameters',join(root,'tests/fixtures/sitl/parameters.parm')],{cwd});
  const trace=JSON.parse(output);
  if(trace.provenance.firmwareSha256!==env.MIRAGE_SITL_BINARY_SHA256)throw Error('Capture firmware mismatch');
  writeFileSync(join(directory,'acquisition.json'),JSON.stringify({status:'captured',caseId,sourceCommit:pin.commit,
    runnerSha256:sha256(readFileSync(fileURLToPath(import.meta.url))),driverSha256:sha256(readFileSync(join(root,'scripts/sitl/driver.mjs')))},null,2)+'\n');
  const {auditEwCapture}=await import('./sitl/audit-ew.mjs');
  const response=await auditEwCapture(directory);
  writeFileSync(join(directory,'response-audit.json'),JSON.stringify(response,null,2)+'\n');
  console.log(`Audited ${caseId}: ${JSON.stringify(response.metrics)}`);
} finally {rmSync(cwd,{recursive:true,force:true});}
