import { it } from "vitest";
import { nodeCheck } from "./support/node-evidence";
it("HITL analysis rejects gaps, timing failures, synthetic provenance and unapplied unplug failsafe", () => nodeCheck(`
import {assessHitl} from './scripts/bench-hitl.mjs';
const v={schemaVersion:1,provenance:{source:'hardware',operator:'schema-test-only',recordedAt:'2026-10-17T00:00:00Z',firmwareSha256:'a'.repeat(64),modelSha256:'b'.repeat(64)},board:'schema-test',hz:200,durationS:60,overflow:0,lost:0,unplugActuatorsDisabled:true,samples:Array.from({length:12000},(_,i)=>({sequence:i,scheduledUs:i*5000,sentUs:i*5000+1000,actuatorUs:i*5000+2000}))};
assert.equal(assessHitl(v).metrics.p99LatenessMs,1);
assert.equal(assessHitl({...v,unplugActuatorsDisabled:false}).status,'FAIL');
assert.equal(assessHitl({...v,samples:v.samples.map(s=>({...s,sentUs:s.scheduledUs+6000,actuatorUs:s.scheduledUs+7000}))}).status,'FAIL');
assert.throws(()=>assessHitl({...v,samples:v.samples.slice(1)}));
assert.throws(()=>assessHitl({...v,provenance:{...v.provenance,source:'synthetic'}}));
`));
