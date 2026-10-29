// TASK-129 bounded native experiment; all children belong to runOwned's group.
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runOwned} from './run-sitl.mjs';
const [mode,speed,output]=process.argv.slice(2);
if(!['holds','continuous'].includes(mode)||!['2','20'].includes(speed)||!output||process.argv.length!==5)throw Error('Expected holds|continuous 2|20 NEW_CAPTURE_DIRECTORY');
const directory=resolve(output),cwd=mkdtempSync(join(tmpdir(),'mirage-pause-'));
if(existsSync(directory))throw Error('Capture directory must be new');
const source=process.env.MIRAGE_SITL_SOURCE,binary=process.env.MIRAGE_SITL_BINARY,python=process.env.MIRAGE_SITL_PYTHON;
if(!source||!binary||!python)throw Error('Set MIRAGE_SITL_SOURCE, MIRAGE_SITL_BINARY and MIRAGE_SITL_PYTHON');
try{
 const result=await runOwned(process.execPath,['--experimental-transform-types',fileURLToPath(new URL('./sitl/pause-probe.mjs',import.meta.url)),'--child','--binary',resolve(binary),'--parameters',fileURLToPath(new URL('../tests/fixtures/sitl/parameters.parm',import.meta.url))],{
  cwd,timeoutMs:300000,env:{...process.env,MIRAGE_SITL_SOURCE:resolve(source),MIRAGE_SITL_PYTHON:resolve(python),
   MIRAGE_SITL_FRAME:'quad-x',MIRAGE_SITL_FRAME_PHASE:'flight',MIRAGE_SITL_CAPTURE_DIR:directory,
   MIRAGE_SITL_PAUSE_MODE:mode,MIRAGE_SITL_PAUSE_SPEEDUP:speed,MIRAGE_SITL_IMU_NOISE_FLOOR:'ardupilot',MIRAGE_EW_CASE:''}});
 const run=JSON.parse(readFileSync(join(directory,'run.json')));
 if(run.status!=='captured'||run.task!=='TASK-129')throw Error('Native pause capture failed');
 console.log(result.toString());
}finally{rmSync(cwd,{recursive:true,force:true});}
