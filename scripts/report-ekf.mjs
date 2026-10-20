import { readFileSync,writeFileSync,mkdirSync } from "node:fs";
import { execFileSync } from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { exact, provenance, finite, report, hash,loadJson,sha256 } from "./validation/evidence.mjs";
export const EW_CASES = ["control", "jamming", "position-step", "velocity-drift", "magnetic", "motor-loss"];
/** Records actual EKF/mode responses; there is no promised forced mode transition. */
export function assessEkf(v, frozen = JSON.parse(readFileSync(new URL("../tests/fixtures/scenarios/ew-matrix.json", import.meta.url)))) {
  if(v?.schemaVersion===2)return assessNativeEkf(v,frozen);
  exact(v, ["schemaVersion", "provenance", "parameterSha256", "cases"]);
  if (v.schemaVersion !== 1 || !hash(v.parameterSha256) || !Array.isArray(v.cases) || v.cases.length !== EW_CASES.length) throw new Error("Incomplete EW control/fault matrix");
  provenance(v.provenance, "native-sitl");
  const metrics = {}; let passed = true;
  for (let i = 0; i < EW_CASES.length; i++) {
    const c = v.cases[i]; exact(c, ["id", "samples", "envelope"]);
    if (c.id !== EW_CASES[i] || !Array.isArray(c.samples) || c.samples.length < 2 || c.samples.length > 100000) throw new Error("Missing ordered EW case");
    exact(c.envelope, ["maxPositionErrorM", "maxInnovationRatio"]);
    finite(c.envelope.maxPositionErrorM, 0, 10000); finite(c.envelope.maxInnovationRatio, 0, 10000);
    let previous = -1, changed = false, error = 0, innovation = 0;
    for (const s of c.samples) {
      exact(s, ["timeS", "truthSha256", "baselineTruthSha256", "observedChanged", "positionErrorM", "innovationRatio", "mode", "ekfFlags"]);
      finite(s.timeS, 0); finite(s.positionErrorM, 0); finite(s.innovationRatio, 0); finite(s.mode, 0, 0xffffffff); finite(s.ekfFlags, 0, 0xffffffff);
      if (s.timeS <= previous || !hash(s.truthSha256) || s.truthSha256 !== s.baselineTruthSha256 || typeof s.observedChanged !== "boolean") throw new Error("EW trace altered truth or reversed time");
      previous = s.timeS; changed ||= s.observedChanged;
      error = Math.max(error, s.positionErrorM); innovation = Math.max(innovation, s.innovationRatio);
    }
    const ok = changed === (c.id !== "control") && error <= c.envelope.maxPositionErrorM && innovation <= c.envelope.maxInnovationRatio;
    passed &&= ok; metrics[c.id] = { maxPositionErrorM: error, maxInnovationRatio: innovation, changedObservations: changed };
  }
  if (frozen.schemaVersion!==1 || !frozen.envelopes || frozen.firmwareSha256 !== v.provenance.firmwareSha256 || frozen.parameterSha256 !== v.parameterSha256)
    return report("ekf-report", "BLOCKED_EXTERNAL", ["Missing independently frozen firmware/parameter-specific response envelopes"], metrics);
  for (const c of v.cases) {
    const e = frozen.envelopes[c.id];
    if (!e || e.maxPositionErrorM !== c.envelope.maxPositionErrorM || e.maxInnovationRatio !== c.envelope.maxInnovationRatio) throw new Error("EW response envelope differs from frozen baseline");
  }
  // Envelopes are version-specific operator evidence, never rewritten to force a PASS.
  return report("ekf-report", passed ? "PASS" : "FAIL", passed ? [] : ["Observation isolation or frozen response envelope failed"], metrics);
}
export async function assessNativeEkf(v,frozen) {
  exact(v,['schemaVersion','caseDirectories']);
  if(!Array.isArray(v.caseDirectories)||v.caseDirectories.length!==EW_CASES.length||new Set(v.caseDirectories).size!==EW_CASES.length)throw Error('Incomplete native capture matrix');
  const {auditEwCapture}=await import('./sitl/audit-ew.mjs');
  const cases=[];
  for(let i=0;i<EW_CASES.length;i++) {
    if(typeof v.caseDirectories[i]!=='string')throw Error('Invalid capture directory');
    const c=await auditEwCapture(v.caseDirectories[i]);if(c.id!==EW_CASES[i])throw Error('Unordered native cases');cases.push(c);
  }
  return evaluateResponses(cases,frozen);
}
/** Pure envelope comparison; its unit fixtures are never acquisition evidence. */
export function evaluateResponses(cases,frozen) {
  if(cases.length!==EW_CASES.length||cases.some((c,i)=>c.id!==EW_CASES[i]))throw Error('Incomplete ordered native responses');
  if(frozen.schemaVersion!==2||!frozen.envelopes)return report('ekf-report','BLOCKED_EXTERNAL',['Missing frozen native calibration matrix'],{cases});
  const reasons=[];
  for(const c of cases) {
    for(const key of ['firmwareSha256','parameterSha256','modelSha256','planSha256'])if(c[key]!==frozen[key])throw Error(`Frozen native identity mismatch: ${key}`);
    if(JSON.stringify(c.sourceInputs)!==JSON.stringify(frozen.sourceInputs))throw Error('Frozen source closure mismatch');
    if(Object.values(frozen.calibrationCaptureSha256).includes(c.captureSha256))throw Error('Calibration capture cannot validate its own envelope');
    const e=frozen.envelopes[c.id];if(!e)throw Error('Missing case envelope');
    if(c.id==='control'&&(c.metrics.maxPositionErrorM>1||c.metrics.maxTruthDisplacementM>1||c.metrics.maxInnovationRatio>=1||c.metrics.unhealthyRows))reasons.push('Control violated independent healthy 1 m hold gate');
    for(const [metric,limit] of [['maxPositionErrorM',e.maxPositionErrorM],['maxInnovationRatio',e.maxInnovationRatio],['maxTruthDisplacementM',e.maxTruthDisplacementM]]) {
      finite(limit,0,10000);if(c.metrics[metric]>limit)reasons.push(`${c.id}: ${metric} exceeded independently frozen limit`);
    }
    if(!Array.isArray(e.allowedModes)||c.metrics.modes.some(m=>!e.allowedModes.includes(m)))reasons.push(`${c.id}: unexpected flight mode requires investigation`);
  }
  return report('ekf-report',reasons.length?'FAIL':'PASS',reasons,{cases});
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  let result;
  try {
    if(process.argv.length===2)result=report('ekf-report','BLOCKED_EXTERNAL',['Provide a native capture matrix using --input PATH --sha256 HEX']);
    else {
      if(process.argv.length!==6||process.argv[2]!=='--input'||process.argv[4]!=='--sha256')throw Error('Expected --input PATH --sha256 HEX');
      result=await assessEkf(loadJson(process.argv[3],process.argv[5]));result.inputSha256=process.argv[5];
    }
  }catch(error){result=report('ekf-report','FAIL',[error.message]);}
  result.sourceRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  result.validatorSha256=sha256(readFileSync(fileURLToPath(import.meta.url)));
  mkdirSync('test-results/validation',{recursive:true});
  writeFileSync('test-results/validation/ekf-report.json',JSON.stringify(result,null,2)+'\n');
  console.log(`ekf-report: ${result.status}`);process.exitCode=result.status==='PASS'?0:result.status==='FAIL'?1:2;
}
