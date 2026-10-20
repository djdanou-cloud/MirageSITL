// Prepare owned local inputs; no firmware download, rebuild or redistribution.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--defaults'||args[2]!=='--output')throw Error('Expected --defaults UPSTREAM_COPTER.parm --output NEW_DIRECTORY');
const root=fileURLToPath(new URL('../',import.meta.url)),out=resolve(args[3]);
if(existsSync(out))throw Error('Select a new output directory; preserve previous evidence');
const bytes=readFileSync(resolve(args[1]));if(bytes.length>65536)throw Error('Defaults exceed budget');
const map=new Map();
for(const line of bytes.toString('utf8').split(/\r?\n/)) {
  const text=line.split('#')[0].trim();if(!text)continue;
  const fields=text.split(/\s+/);if(fields.length!==2||!Number.isFinite(Number(fields[1])))throw Error('Invalid upstream parameter line');map.set(fields[0],fields[1]);
}
const overrides={FRAME_CLASS:1,FRAME_TYPE:1,MOT_PWM_MIN:1000,MOT_PWM_MAX:2000,SIM_RATE_HZ:800,AHRS_EKF_TYPE:3,EK3_ENABLE:1,
  ARMING_CHECK:1,FS_GCS_ENABLE:5,FS_OPTIONS:0,MOT_BAT_VOLT_MIN:0,MOT_BAT_VOLT_MAX:0,LOG_BACKEND_TYPE:0};
for(let i=1;i<=3;i++)for(const axis of ['X','Y','Z'])overrides['COMPASS_OFS'+(i===1?'':i)+'_'+axis]=0;
for(const [key,value] of Object.entries(overrides))map.set(key,String(value));
mkdirSync(out,{recursive:true});const defaultsText=[...map].map(([k,v])=>k+' '+v).join('\n')+'\n';
writeFileSync(join(out,'defaults.parm'),defaultsText);
const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('vite/package.json'))('esbuild');
await build({entryPoints:[join(root,'tests/support/parity-native.ts')],bundle:true,platform:'node',format:'esm',target:'node24',outfile:join(out,'native-driver.mjs')});
writeFileSync(join(out,'prepare.json'),JSON.stringify({schemaVersion:1,upstreamDefaultsSha256:createHash('sha256').update(bytes).digest('hex'),
  defaultsSha256:createHash('sha256').update(defaultsText).digest('hex'),overrides,node:process.version},null,2)+'\n');
console.log(out);
