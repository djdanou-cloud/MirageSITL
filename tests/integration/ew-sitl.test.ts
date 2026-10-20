import { it } from "vitest";
import { nodeCheck } from "../support/node-evidence";
it("EW rejects missing cases, changed truth and synthetic source; no envelopes cannot certify fidelity", () => nodeCheck(`
import {assessEkf,EW_CASES} from './scripts/report-ekf.mjs';
const samples=[0,1].map(timeS=>({timeS,truthSha256:'a'.repeat(64),baselineTruthSha256:'a'.repeat(64),observedChanged:false,positionErrorM:0,innovationRatio:0,mode:5,ekfFlags:31}));
const v={schemaVersion:1,provenance:{source:'native-sitl',operator:'schema-test-only',recordedAt:'2026-10-17T00:00:00Z',firmwareSha256:'a'.repeat(64),modelSha256:'b'.repeat(64)},parameterSha256:'c'.repeat(64),cases:EW_CASES.map(id=>({id,envelope:{maxPositionErrorM:1,maxInnovationRatio:1},samples:samples.map(s=>({...s,observedChanged:id!=='control'}))}))};
assert.equal(assessEkf(v).status,'BLOCKED_EXTERNAL');
assert.throws(()=>assessEkf({...v,cases:[]}));
v.cases[0].samples[0].truthSha256='b'.repeat(64);assert.throws(()=>assessEkf(v),/truth/);
`));
it('native limits reject calibration reuse, altered identities, exceeded bounds and unanticipated modes', () => nodeCheck(`
import {evaluateResponses,EW_CASES} from './scripts/report-ekf.mjs';
// Synthetic comparison-only fixture. It does not call acquisition/audit or claim native execution.
const keys=['firmwareSha256','modelSha256','parameterSha256','planSha256'];
const identities=Object.fromEntries(keys.map(k=>[k,'a'.repeat(64)]));
const cases=EW_CASES.map(id=>({id,...identities,sourceInputs:[],captureSha256:'b'.repeat(64),metrics:{maxPositionErrorM:.1,maxInnovationRatio:.1,maxTruthDisplacementM:.1,modes:[4],unhealthyRows:0}}));
const frozen={schemaVersion:2,...identities,sourceInputs:[],calibrationCaptureSha256:{control:'c'.repeat(64)},envelopes:Object.fromEntries(EW_CASES.map(id=>[id,{maxPositionErrorM:1,maxInnovationRatio:1,maxTruthDisplacementM:1,allowedModes:[4]}]))};
assert.equal(evaluateResponses(cases,frozen).status,'PASS');
cases[1].metrics.maxInnovationRatio=2;assert.equal(evaluateResponses(cases,frozen).status,'FAIL');cases[1].metrics.maxInnovationRatio=.1;
cases[1].metrics.modes=[9];assert.equal(evaluateResponses(cases,frozen).status,'FAIL');cases[1].metrics.modes=[4];
cases[0].captureSha256='c'.repeat(64);assert.throws(()=>evaluateResponses(cases,frozen),/own envelope/);cases[0].captureSha256='b'.repeat(64);
cases[0].firmwareSha256='d'.repeat(64);assert.throws(()=>evaluateResponses(cases,frozen),/identity/);cases[0].firmwareSha256='a'.repeat(64);
cases[0].sourceInputs=[{file:'changed'}];assert.throws(()=>evaluateResponses(cases,frozen),/closure/);
assert.throws(()=>evaluateResponses(cases.slice(1),frozen),/Incomplete/);
`));
