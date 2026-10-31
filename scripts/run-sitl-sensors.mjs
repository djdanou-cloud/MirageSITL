// TASK-147 bounded native sensor-error probe; every child belongs to runOwned's group.
//   MIRAGE_SITL_SOURCE=... MIRAGE_SITL_BINARY=... MIRAGE_SITL_PYTHON=... node scripts/run-sitl-sensors.mjs NEW_CAPTURE_DIRECTORY
// Then audit it: node scripts/check-sitl-sensors.mjs --input NEW_CAPTURE_DIRECTORY
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runOwned} from './run-sitl.mjs';
const [output]=process.argv.slice(2);
if(!output||process.argv.length!==3)throw Error('Expected NEW_CAPTURE_DIRECTORY');
const directory=resolve(output);
if(existsSync(directory))throw Error('Capture directory must be new');
const source=process.env.MIRAGE_SITL_SOURCE,binary=process.env.MIRAGE_SITL_BINARY,python=process.env.MIRAGE_SITL_PYTHON;
if(!source||!binary||!python){console.error('BLOCKED_EXTERNAL: set MIRAGE_SITL_SOURCE, MIRAGE_SITL_BINARY and MIRAGE_SITL_PYTHON');process.exit(2);}
const cwd=mkdtempSync(join(tmpdir(),'mirage-sensors-'));
try{
  await runOwned(process.execPath,['--experimental-transform-types','--no-warnings',fileURLToPath(new URL('./sitl/sensor-probe.mjs',import.meta.url)),
    '--binary',resolve(binary),'--out',directory],
    {cwd,timeoutMs:900000,env:{...process.env,MIRAGE_SITL_SOURCE:resolve(source),MIRAGE_SITL_PYTHON:resolve(python)}});
  const run=JSON.parse(readFileSync(join(directory,'run.json'),'utf8'));
  if(run.status!=='captured'||run.task!=='TASK-147')throw Error('Native sensor capture failed');
  console.log(`TASK-147 capture: ${run.cases.length} cases in ${directory}`);
}finally{rmSync(cwd,{recursive:true,force:true});}
