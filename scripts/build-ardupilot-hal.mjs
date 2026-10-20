// Local-only HAL-enabled firmware; preserve the unchanged TASK-045 artifact.
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readMemoryImport} from '../packages/autopilot/src/wasm-loader.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const cache=resolve(root,'.cache/task-046');mkdirSync(cache,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const wslPath=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replaceAll('\\','/');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
if(process.platform!=='win32')throw Error('This local builder currently requires the configured Windows/WSL toolchain');
const source=process.env.MIRAGE_ARDUPILOT_SOURCE??'/home/dadu/mirage/ardupilot';
const sdk=process.env.MIRAGE_EMSDK_DIR??'/home/dadu/mirage/emsdk';
const venv=process.env.MIRAGE_ARDUPILOT_VENV??'/home/dadu/mirage/venv';
const run=s=>execFileSync('wsl.exe',['-e','bash','-lc',s],{encoding:'utf8',timeout:300000});
const lock=JSON.parse(readFileSync(resolve(root,'native/ardupilot/source.lock.json')));
const toolchain=JSON.parse(readFileSync(resolve(root,'native/ardupilot/toolchain.lock.json')));
if(run(`git -C ${quote(sdk)} rev-parse HEAD`).trim()!==toolchain.emsdk.commit ||
    run(`sha256sum ${quote(sdk+'/emsdk_manifest.json')}`).split(/\s+/)[0]!==toolchain.emsdk.sdkManifestSha256)
  throw Error('HAL SDK source/manifest pin mismatch');
const compilerBanner=run(`. ${quote(sdk+'/emsdk_env.sh')} >/dev/null 2>&1; emcc --version | head -1`).trim();
if(!compilerBanner.includes(toolchain.emsdk.version)||!compilerBanner.includes(toolchain.emsdk.emscriptenCommit))throw Error('HAL compiler pin mismatch');
if(run(`git -C ${quote(source)} rev-parse HEAD`).trim()!==lock.commit || run(`git -C ${quote(source)} status --porcelain --untracked-files=no`).trim())throw Error('Pinned upstream source is not clean');
for(const f of lock.files)if(run(`sha256sum ${quote(source+'/'+f.path)}`).split(' ')[0]!==f.sha256)throw Error('Locked upstream bytes changed: '+f.path);
for(const [path,commit] of Object.entries(toolchain.ardupilot.submodules))
  if(run(`git -C ${quote(source+'/'+path)} rev-parse HEAD`).trim()!==commit)throw Error('HAL submodule pin mismatch: '+path);
const inputs=['native/ardupilot/hal/browser_hal.h','native/ardupilot/hal/browser_hal.cpp','native/ardupilot/hal/sitl-state.patch',
  'native/ardupilot/source.lock.json','native/ardupilot/toolchain.lock.json','scripts/build-ardupilot-hal.mjs'];
const sourceInputs=inputs.map(file=>({file,sha256:sha(readFileSync(resolve(root,file)))}));
const resume=process.argv.includes('--resume');
const copy=resume?readFileSync(resolve(cache,'build-directory.txt'),'utf8').trim():run('mktemp -d /tmp/mirage-task-046-XXXXXX').trim();
if(!/^\/tmp\/mirage-task-046-[A-Za-z0-9]+$/.test(copy))throw Error('Unexpected build directory');
writeFileSync(resolve(cache,'build-directory.txt'),copy+'\n');
const repo=wslPath(root),out=wslPath(cache);
const prepare=resume?`test "$(git -C ${quote(copy)} rev-parse HEAD)" = ${quote(lock.commit)}
cd ${quote(copy)}
git apply --reverse --check ${quote(repo+'/native/ardupilot/hal/sitl-state.patch')}
git apply --reverse ${quote(repo+'/native/ardupilot/hal/sitl-state.patch')}
test -z "$(git diff --name-only)"
git apply ${quote(repo+'/native/ardupilot/hal/sitl-state.patch')}`:
  `cp -a --reflink=auto ${quote(source+'/.')} ${quote(copy+'/')}\ncd ${quote(copy)}\ngit apply --check ${quote(repo+'/native/ardupilot/hal/sitl-state.patch')}\ngit apply ${quote(repo+'/native/ardupilot/hal/sitl-state.patch')}`;
const script=`set -eu
${prepare}
cd ${quote(copy)}
cp ${quote(repo+'/native/ardupilot/hal/browser_hal.h')} libraries/AP_HAL_SITL/browser_hal.h
cp ${quote(repo+'/native/ardupilot/hal/browser_hal.cpp')} libraries/AP_HAL_SITL/MirageBrowserHal.cpp
. ${quote(sdk+'/emsdk_env.sh')}
. ${quote(venv+'/bin/activate')}
em++ --version
./waf configure --board wasm
./waf copter -j 6
cp build/wasm/bin/arducopter.js ${quote(out+'/arducopter.js')}
cp build/wasm/bin/arducopter.wasm ${quote(out+'/arducopter.wasm')}
`;
writeFileSync(resolve(cache,'build.sh'),script);
const result=spawnSync('wsl.exe',['-e','bash',wslPath(resolve(cache,'build.sh'))],{encoding:'utf8',timeout:900000,maxBuffer:16*1024*1024});
writeFileSync(resolve(cache,'build.log'),(result.stdout??'')+(result.stderr??''));
if(result.status!==0)throw Error('HAL firmware build failed; see .cache/task-046/build.log');
for(const f of sourceInputs)if(sha(readFileSync(resolve(root,f.file)))!==f.sha256)throw Error('HAL sources changed during build; rebuild before admission');
if(run(`git -C ${quote(source)} rev-parse HEAD`).trim()!==lock.commit || run(`git -C ${quote(source)} status --porcelain --untracked-files=no`).trim())throw Error('Pinned source changed during HAL build');
const actualPatch=run(`git -C ${quote(copy)} diff -- libraries/AP_HAL_SITL/SITL_State.cpp`);
if(!actualPatch.includes('MirageHal::exchange'))throw Error('HAL integration patch is absent');
const wasm=readFileSync(resolve(cache,'arducopter.wasm')),glue=readFileSync(resolve(cache,'arducopter.js'));
const module=new WebAssembly.Module(wasm),names=WebAssembly.Module.exports(module).map(e=>e.name);
const pinned=JSON.parse(readFileSync(resolve(root,'native/ardupilot/wasm-artifact.manifest.json')));
const required=[...pinned.requiredExports,'mirage_hal_version','mirage_hal_mailbox','mirage_hal_configure','mirage_hal_notify','mirage_hal_stop'];
if(!required.every(n=>names.includes(n)))throw Error('Missing real HAL exports');
const memory=readMemoryImport(wasm);
if(!memory?.shared || memory.initialPages!==256)throw Error('Invalid HAL memory');
const manifest={...pinned,module:{file:'arducopter.wasm',sha256:sha(wasm),bytes:wasm.length},
  glue:{file:'arducopter.js',sha256:sha(glue),bytes:glue.length},requiredExports:required};
writeFileSync(resolve(cache,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
writeFileSync(resolve(cache,'build-identity.json'),JSON.stringify({schemaVersion:1,sourceCommit:lock.commit,sourceCopy:copy,
  sourceInputs,compilerBanner,manifest},null,2)+'\n');
console.log(`HAL firmware built locally: ${wasm.length} bytes; ${manifest.module.sha256}`);
