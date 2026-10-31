// TASK-128 owned native frame probe. Each phase uses a new capture directory.
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runOwned} from './run-sitl.mjs';
import {frameById} from './sitl/multirotor.mjs';
import {readNativeExecutable} from './sitl/native-binary.ts';
export async function runFrame(id,phase,directory,env=process.env){
  frameById(id);
  if(!['flight','motor-test'].includes(phase))throw Error('Expected flight or motor-test phase');
  if(!env.MIRAGE_SITL_SOURCE||!env.MIRAGE_SITL_BINARY||!env.MIRAGE_SITL_PYTHON)throw Error('Set MIRAGE_SITL_SOURCE, MIRAGE_SITL_BINARY and MIRAGE_SITL_PYTHON');
  const capture=resolve(directory);
  if(existsSync(capture))throw Error('Capture directory must be new');
  const binary=resolve(env.MIRAGE_SITL_BINARY);readNativeExecutable(binary);
  const cwd=mkdtempSync(join(tmpdir(),'mirage-frames-'));
  const driver=fileURLToPath(new URL('./sitl/driver.mjs',import.meta.url));
  let report;
  try{
    const stdout=await runOwned(process.execPath,[driver,'--binary',binary,'--parameters',fileURLToPath(new URL('../tests/fixtures/sitl/parameters.parm',import.meta.url))],
      {cwd,timeoutMs:120000,env:{...env,MIRAGE_SITL_SOURCE:resolve(env.MIRAGE_SITL_SOURCE),
        MIRAGE_SITL_PYTHON:resolve(env.MIRAGE_SITL_PYTHON),MIRAGE_SITL_FRAME:id,MIRAGE_SITL_FRAME_PHASE:phase,
        MIRAGE_SITL_CAPTURE_DIR:capture,MIRAGE_SITL_IMU_NOISE_FLOOR:'ardupilot',MIRAGE_EW_CASE:''}});
    report=JSON.parse(stdout);
    if(report.status!=='captured'||report.frameId!==id||report.phase!==phase)throw Error('Frame driver identity/status mismatch');
    const run=JSON.parse(readFileSync(join(capture,'run.json')));
    const digest=createHash('sha256').update(readFileSync(binary)).digest('hex');
    if(run.firmwareSha256!==digest)throw Error('Frame firmware identity mismatch');
    return report;
  }catch(error){
    mkdirSync(capture,{recursive:true});
    writeFileSync(join(capture,'harness-error.json'),JSON.stringify({status:'FAIL',frameId:id,phase,reason:error.message})+'\n');
    throw error;
  }finally{rmSync(cwd,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [id,phase,directory]=process.argv.slice(2);
  if(!id||!phase||!directory||process.argv.length!==5)throw Error('Expected FRAME_ID motor-test|flight NEW_CAPTURE_DIRECTORY');
  try{console.log(JSON.stringify(await runFrame(id,phase,directory)));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
