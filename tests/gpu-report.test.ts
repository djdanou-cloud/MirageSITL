import { it } from "vitest";
import { nodeCheck } from "./support/node-evidence";
it("GPU analysis enforces full duration, real hardware, features and unchanged frame/memory limits", () => nodeCheck(`
import {assessGpu} from './scripts/bench-render.mjs';
const v={schemaVersion:1,source:'hardware',device:'M4',gpu:'Apple M4',os:'macOS',browser:'schema-test-only',powerMode:'AC',backend:'webgl2',fps:60,width:1920,height:1080,dpr:1,warmupS:60,durationS:600,visible:true,production:true,terrain:true,fpv:true,thermal:true,frameMs:Array(40000).fill(15),gpuBytes:1000000,cpuBytes:1000000};
assert.equal(assessGpu(v).metrics.p99FrameMs,15);
assert.equal(assessGpu({...v,gpu:'SwiftShader'}).status,'BLOCKED_EXTERNAL');
assert.equal(assessGpu({...v,frameMs:Array(30000).fill(20)}).status,'FAIL');
assert.throws(()=>assessGpu({...v,frameMs:[15]}));
assert.throws(()=>assessGpu({...v,thermal:false}));
assert.equal(assessGpu({...v,gpuBytes:3*1024**3}).status,'FAIL');
`));
