// Cold bundle assembly. The comparator independently rechecks raw files/audits.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
if(args.length!==8||args[0]!=='--native'||args[3]!=='--wasm'||args[6]!=='--output')throw Error('Expected --native NOMINAL FAILSAFE --wasm NOMINAL FAILSAFE --output DIRECTORY');
const out=resolve(args[7]);mkdirSync(out,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
for(const [backend,paths] of [['native',args.slice(1,3)],['wasm',args.slice(4,6)]]) {
  const evidence=[],scenarios=[];let comparison=null;
  for(const path of paths) {
    const captureFile=resolve(path),bytes=readFileSync(captureFile),value=JSON.parse(bytes),c=value.capture??value;
    const auditFile=captureFile+'.audit.json',auditBytes=readFileSync(auditFile);
    if((c.type??c.status)!==(backend==='wasm'?'complete':'captured'))throw Error('Incomplete firmware capture');
    const identity=value.identity;
    if(!comparison) {
      const {sourceInputs,bodyWasmSha256,...common}=identity;
      if(!Array.isArray(sourceInputs)||!bodyWasmSha256)throw Error('Capture identity missing');
      comparison={...common,backend,firmwareSha256:backend==='wasm'?value.manifest.module.sha256:value.firmwareSha256};
    }
    const samples=c.samples.filter(p=>p.tick>=72000&&p.tick<=96000).map(({validityFlags,...sample})=>{
      if(!Number.isInteger(validityFlags))throw Error('Missing BET validity flags');return sample;});
    scenarios.push({id:value.caseId,referenceStartTick:72000,failsafeTick:value.caseId==='gcs-failsafe'?72000:null,samples});
    evidence.push({id:value.caseId,captureFile,captureSha256:sha(bytes),auditFile,auditSha256:sha(auditBytes)});
  }
  writeFileSync(join(out,backend+'.json'),JSON.stringify({comparison:{...comparison,scenarios},evidence})+'\n');
}
