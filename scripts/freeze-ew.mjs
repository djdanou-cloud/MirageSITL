// One-time empirical baseline acquisition. Never overwrite an existing envelope.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {EW_CASES} from './report-ekf.mjs';
import {auditEwCapture} from './sitl/audit-ew.mjs';
import {PLAN} from './sitl/ew-observations.ts';
import {sha256} from './validation/evidence.mjs';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--calibration')throw Error('Expected --calibration CAPTURE_ROOT');
const path=new URL('../tests/fixtures/scenarios/ew-matrix.json',import.meta.url);
if(JSON.parse(readFileSync(path)).envelopes)throw Error('Refusing to overwrite frozen envelopes; investigate failures');
const cases=[];
for(const id of EW_CASES)cases.push(await auditEwCapture(join(args[1],id)));
const first=cases[0];
for(const c of cases)for(const key of ['firmwareSha256','parameterSha256','modelSha256','planSha256','sourceInputs'])
  if(JSON.stringify(c[key])!==JSON.stringify(first[key]))throw Error(`Calibration matrix identity differs: ${key}`);
const control=first.metrics;
if(control.maxPositionErrorM>1||control.maxTruthDisplacementM>1||control.maxInnovationRatio>=1||control.unhealthyRows||
  control.modes.length!==1||control.modes[0]!==4)throw Error('Control violates independent 1 m healthy hold gate');
const envelopes={},calibrationCaptureSha256={};
for(const c of cases) {
  const m=c.metrics,r=PLAN.envelopeRule;
  envelopes[c.id]={maxPositionErrorM:Math.ceil((m.maxPositionErrorM*r.factor+r.positionMarginM)*100)/100,
    maxInnovationRatio:Math.ceil((m.maxInnovationRatio*r.factor+r.innovationMargin)*100)/100,
    maxTruthDisplacementM:Math.ceil((m.maxTruthDisplacementM*r.factor+r.positionMarginM)*100)/100,allowedModes:m.modes};
  calibrationCaptureSha256[c.id]=c.captureSha256;
}
const frozen={schemaVersion:2,status:'FROZEN_FOR_VALIDATION',firmwareCommit:'8ab6afde107a91df1b5f60ade8f333cb8a61b190',
  firmwareSha256:first.firmwareSha256,parameterSha256:first.parameterSha256,modelSha256:first.modelSha256,
  planSha256:first.planSha256,sourceInputs:first.sourceInputs,requiredCases:EW_CASES,plan:PLAN,
  frozenAt:new Date().toISOString(),calibrationCaptureSha256,envelopes,
  scope:'Empirical native synthetic quad regression limits, not measured aircraft fidelity or promised fallback behavior',
  calibration:cases};
writeFileSync(path,JSON.stringify(frozen,null,2)+'\n');
console.log(`Frozen calibration matrix SHA-256 ${sha256(readFileSync(path))}; acquire new validation runs now`);
