import { it } from "vitest";
import { nodeCheck } from "../support/node-evidence";
it("system acceptance keeps every absent requirement NOT_RUN and rejects stale or fabricated PASS", () => nodeCheck(`
import {assessSystem} from './scripts/validate-release.mjs';
const sourceRevision='a'.repeat(40),v={schemaVersion:1,sourceRevision,requirements:[]};
const result=assessSystem(v);assert.equal(result.status,'BLOCKED_EXTERNAL');
assert.ok(Object.values(result.metrics.modes).every(m=>m.gates.every(g=>g.status==='NOT_RUN')));
const requirement={id:'G3-gpu',status:'PASS',evidenceSha256:'b'.repeat(64),evidencePath:'test-results/validation/gpu-report.json',reason:'schema-test-only',sourceRevision,source:'observed'};
assert.throws(()=>assessSystem({...v,requirements:[requirement]},()=>({kind:'gpu-report',status:'BLOCKED_EXTERNAL',sourceRevision})));
assert.throws(()=>assessSystem({...v,requirements:[{...requirement,sourceRevision:'c'.repeat(40)}]}));
`));
