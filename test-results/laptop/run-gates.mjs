import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const node = process.execPath, directory = 'test-results/laptop';
const env = { ...process.env, CI: 'true', CHROMIUM_PATH: 'C:/Program Files/Google/Chrome/Application/chrome.exe', MIRAGE_BROWSER_GPU: 'software', MIRAGE_BROWSER_HEADED: '0', RUSTUP_TOOLCHAIN: '1.97.0' };
const commands = [
  ['unit-final', ['node_modules/vitest/vitest.mjs','run','--maxWorkers=2','--reporter=json','--outputFile=test-results/laptop/unit-final.json']],
  ['browser-final', ['node_modules/@playwright/test/cli.js','test','--reporter=json']],
  ['typecheck-final', ['node_modules/typescript/bin/tsc','--noEmit']],
  ['lint-final', ['node_modules/eslint/bin/eslint.js','.','--max-warnings=0','--no-inline-config']],
  ['docs-final', ['scripts/check-docs.mjs']],
  ['build-final', ['node_modules/vite/bin/vite.js','build','apps/web']],
];
for (const hz of [400,800,1200]) {
  commands.push([`physics-${hz}-idle`, ['scripts/bench-physics.mjs','--hz',String(hz),'--steps','1000000','--realtime-seconds','5','--out',`${directory}/physics-${hz}-idle.json`]]);
  commands.push([`links-ew-${hz}`, ['scripts/bench-links-ew.mjs','all',String(hz)]]);
  commands.push([`aar-${hz}`, ['scripts/bench-aar.mjs',String(hz)]]);
  commands.push([`terrain-${hz}`, ['scripts/bench-terrain-scenarios.mjs',String(hz)]]);
}
commands.push(['sensors-all', ['scripts/bench-sensors.mjs','all']], ['wind', ['scripts/bench-wind.mjs']], ['model-validation', ['scripts/validate-models.mjs']]);
const results = [];
for (const [name,args] of commands) {
  const startedAt = new Date().toISOString(), start = performance.now();
  console.log(`START ${name}`);
  const r = spawnSync(node,args,{env,encoding:'utf8',timeout:600000,maxBuffer:32*1024*1024});
  const extension = name === 'browser-final' ? 'json' : 'log';
  writeFileSync(`${directory}/${name}.${extension}`,r.stdout ?? '');
  if (r.stderr) writeFileSync(`${directory}/${name}.stderr.log`,r.stderr);
  results.push({name,command:['node',...args],startedAt,elapsedS:(performance.now()-start)/1000,exit:r.status,signal:r.signal,error:r.error?.message});
  writeFileSync(`${directory}/command-results.json`,JSON.stringify({sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),results},null,2)+'\n');
  console.log(`END ${name}: exit=${r.status}; ${(performance.now()-start).toFixed(0)} ms`);
}
// Record counts without treating deliberately failed fidelity gates as software success.
for (const name of ['unit-final','browser-final']) {
  const r=JSON.parse(readFileSync(`${directory}/${name}.json`));
  console.log(name === 'unit-final' ? {name,passed:r.numPassedTests,failed:r.numFailedTests,pending:r.numPendingTests} : {name,...r.stats});
}
