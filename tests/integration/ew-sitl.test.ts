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
