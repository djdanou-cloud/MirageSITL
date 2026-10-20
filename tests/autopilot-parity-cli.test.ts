import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
it('reports missing parity inputs separately from invalid evidence',()=>{
  const missing=spawnSync(process.execPath,['scripts/compare-autopilot.mjs'],{encoding:'utf8'});
  expect(missing.status).toBe(2);expect(missing.stdout).toContain('BLOCKED_EXTERNAL');
  const directory=mkdtempSync(join(tmpdir(),'mirage-parity-cli-'));
  try {
    const input=join(directory,'unverified.json');writeFileSync(input,'{"schemaVersion":1,"status":"PASS"}');
    const invalid=spawnSync(process.execPath,['scripts/compare-autopilot.mjs','--native',input,'--wasm',input,'--output',join(directory,'result.json')],{encoding:'utf8'});
    expect(invalid.status).toBe(1);expect(invalid.stderr).toContain('provenance-bound capture bundles');
  }finally{
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('mirage-parity-cli-'))throw Error('Unexpected temporary cleanup target');
    rmSync(directory,{recursive:true});
  }
});
