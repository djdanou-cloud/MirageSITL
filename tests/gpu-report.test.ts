import { it } from "vitest";
import { nodeCheck } from "./support/node-evidence";

// User decision 2026-10-23: only a 1920 x 1080 canvas at 1x on an integrated GPU decides TASK-073;
// every other machine, screen and GPU is rated out of 100. The least performant integrated GPU decides.
it("classifies GPUs, rates every valid run and gates only the integrated 1080p 1x profile", () => nodeCheck(`
import {assertDisplaySurface,classifyGpu,decideRun,displayRefreshHz,flightAirborne,frameMetrics,gateIneligibility,missedRefreshes,profileFitsDisplay,rateRun,ratingBand} from './scripts/gpu-trace.mjs';
import {assessGpu,TRACE_FIELDS} from './scripts/bench-render.mjs';
const sum=a=>a.reduce((s,x)=>s+x,0);
assert.equal(classifyGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)','Apple M5'),'integrated');
assert.equal(classifyGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)','Apple M4'),'integrated');
assert.equal(classifyGpu('ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11 vs_5_0 ps_5_0, D3D11)','13th Gen Intel'),'integrated');
assert.equal(classifyGpu('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)','Intel Core i5'),'integrated');
assert.equal(classifyGpu('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)','AMD Ryzen 7'),'integrated');
assert.equal(classifyGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11)','13th Gen Intel'),'discrete');
assert.equal(classifyGpu('ANGLE (AMD, AMD Radeon RX 7600 Direct3D11)','AMD Ryzen 7'),'discrete');
assert.equal(classifyGpu('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11)','Intel Core i7'),'discrete');
assert.equal(classifyGpu('Google SwiftShader','Apple M4'),'software');
assert.equal(classifyGpu('Mystery GPU','x'),'unknown');
// Missed refreshes count empty refresh slots; the target interval is the display or the profile rate, whichever is slower.
assert.equal(missedRefreshes([16.7,33.4,16.7,50.1,16.7],16.7),3);
assert.equal(frameMetrics(Array(200).fill(7),144,60).missedRefreshes,0);
// Rating: 50 pacing + 20 sustain + 10 median + 10 features + 10 memory.
const t=1000/60, ideal={refreshHz:60,fps:60,p50FrameMs:t,p99FrameMs:t,missedRefreshes:0,expectedFrames:36000,featuresHeld:true,airborne:true,gpuBytes:0,cpuBytes:0};
assert.equal(rateRun(ideal).score,100);
assert.equal(rateRun({...ideal,p99FrameMs:2*t}).score,50);
assert.equal(rateRun({...ideal,missedRefreshes:1800}).score,80);
assert.equal(rateRun({...ideal,p50FrameMs:1.5*t}).score,90);
assert.equal(rateRun({...ideal,airborne:false}).score,90);
assert.equal(rateRun({...ideal,gpuBytes:1024**3}).score,95);
const partial=rateRun({...ideal,airborne:null,gpuBytes:undefined,missedRefreshes:null});
assert.equal(partial.score,60); assert.equal(partial.provisional.upperBound,100);
assert.deepEqual(partial.provisional.unknown,['missed refreshes','flight','memory']);
assert.equal(ratingBand(90),'excellent'); assert.equal(ratingBand(75),'good'); assert.equal(ratingBand(50),'usable'); assert.equal(ratingBand(49),'poor');
// Scripted flight must stay airborne with live input for every sample after the warmup.
assert.equal(flightAirborne([{s:30,altitude:'0.0m',inputFailsafe:false},{s:61,altitude:'30.0m',inputFailsafe:false}],60),true);
assert.equal(flightAirborne([{s:61,altitude:'30.0m',inputFailsafe:false},{s:62,altitude:'0.0m',inputFailsafe:true}],60),false);
assert.equal(flightAirborne([],60),false);
// Per-run decision.
const frames=Array(36000).fill(16.67), run={gpu:'ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11)',hostModel:'13th Gen Intel',backend:'webgl2',fps:60,refreshHz:60,
  width:1920,height:1080,dpr:1,scale:1,warmupS:60,measuredS:sum(frames)/1000,visible:true,sleepSkewMs:3,canvasStable:true,featuresHeld:true,airborne:true,frameMs:frames,gpuBytes:1000,cpuBytes:1000};
const pass=decideRun(run);
assert.equal(pass.status,'PASS'); assert.equal(pass.metrics.gpuKind,'integrated'); assert.equal(pass.metrics.rating.score,100);
assert.equal(decideRun({...run,backend:'webgpu'}).status,'PASS');
const slow=Array(36000).fill(16.67); for (let i=0;i<720;i++) slow[i]=25;
const fail=decideRun({...run,frameMs:slow,measuredS:sum(slow)/1000});
assert.equal(fail.status,'FAIL'); assert.match(fail.reasons[0],/p99/); assert.ok(fail.metrics.rating.score<100);
assert.equal(decideRun({...run,airborne:false}).status,'FAIL');
assert.equal(decideRun({...run,featuresHeld:false}).status,'FAIL');
assert.equal(decideRun({...run,gpuBytes:3*1024**3}).status,'FAIL');
// Other GPUs, canvases and profiles are rated but never decide.
const nv=decideRun({...run,gpu:'ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU Direct3D11)'});
assert.equal(nv.status,'INFO'); assert.match(nv.reasons[0],/integrated GPU/); assert.equal(nv.metrics.rating.score,100);
const retina=decideRun({...run,gpu:'ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)',hostModel:'Apple M5',width:2880,height:1864,dpr:2});
assert.equal(retina.status,'INFO'); assert.match(retina.reasons[0],/2880 x 1864 at 2x/);
// The renderers fix their pixel ratio at 1; a 2x display scale still makes the run ineligible.
const scaled=decideRun({...run,gpu:'ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)',hostModel:'Apple M5',scale:2});
assert.equal(scaled.status,'INFO'); assert.match(scaled.reasons[0],/display scale 2x/);
const fast=Array(72000).fill(8.34);
assert.equal(decideRun({...run,fps:120,refreshHz:144,frameMs:fast,measuredS:sum(fast)/1000}).status,'INFO');
assert.deepEqual(gateIneligibility({gpuKind:'integrated',fps:60,width:1920,height:1080,dpr:1,scale:1}),[]);
// Unusable evidence is blocked and never rated.
for (const bad of [{gpu:'Google SwiftShader'},{backend:'webgl1'},{warmupS:10},{measuredS:60,frameMs:Array(3600).fill(16.67)},{visible:false},{sleepSkewMs:60000},{canvasStable:false},{refreshHz:30}]) {
  const r=decideRun({...run,...bad}); assert.equal(r.status,'BLOCKED_EXTERNAL'); assert.equal(r.metrics.rating,undefined);
}
// Accepted 60 FPS boundary after rounding to 0.001 ms.
const n=35971, edge=Array(n).fill(16.679999999993015); for (let i=Math.ceil(n*0.99)-1;i<n;i++) edge[i]=17.665000000037253;
assert.equal(decideRun({...run,frameMs:edge,measuredS:sum(edge)/1000}).status,'PASS');
const over=edge.map((x,i)=>i>=Math.ceil(n*0.99)-1?17.666:x);
assert.equal(decideRun({...run,frameMs:over,measuredS:sum(over)/1000}).status,'FAIL');
// The saved trace replays through the same decision.
const trace={schemaVersion:2,source:'hardware',gpu:run.gpu,hostModel:run.hostModel,os:'win32',browser:'schema-test-only',powerMode:'AC',backend:'webgl2',fps:60,refreshHz:60,
  width:1920,height:1080,dpr:1,scale:1,warmupS:60,durationS:run.measuredS,visible:true,sleepSkewMs:3,canvasStable:true,featuresHeld:true,airborne:true,frameMs:frames,gpuBytes:1000,cpuBytes:1000};
assert.deepEqual(Object.keys(trace),TRACE_FIELDS);
assert.equal(assessGpu(trace).status,'PASS');
assert.throws(()=>assessGpu({...trace,schemaVersion:1}));
assert.throws(()=>assessGpu({...trace,extra:1}));
// Display admission.
assert.ok(Math.abs(displayRefreshHz(Array(90).fill(1000/59.94))-59.94)<1e-9);
assert.equal(profileFitsDisplay(59.88,60),true); assert.equal(profileFitsDisplay(58,60),false);
assert.equal(profileFitsDisplay(60,120),false); assert.equal(profileFitsDisplay(120,120),true);
assert.throws(()=>displayRefreshHz([16.6]));
assert.throws(()=>assertDisplaySurface({innerWidth:0,innerHeight:800,screenWidth:1280,screenHeight:800,dpr:2}));
assert.doesNotThrow(()=>assertDisplaySurface({innerWidth:1920,innerHeight:1080,screenWidth:1920,screenHeight:1080,dpr:1}));
`));

it("decides TASK-073 from the least performant tested integrated GPU", () => nodeCheck(`
import {addRun,buildRunRecord,comboRatings,decideTask073,loadRegistry,markdownCombos,markdownRows,screenLabel} from './scripts/gpu-ratings.mjs';
const rec=(machine,renderer,kind,backend,status,score,p99,extra={})=>({schemaVersion:1,source:'harness',recordedAt:'2026-10-23T00:00:00Z',
  machine:{label:machine,hostModel:machine,os:'x'},screen:{label:'1920 x 1080 @ 60.00 Hz, 1x scale',refreshHz:60,widthPx:1920,heightPx:1080,scale:1},
  gpu:{renderer,kind},browser:'b',powerMode:'AC',terrain:'geodata',view:'chase',backend,fps:60,canvas:{width:1920,height:1080,dpr:1},status,reasons:status==='PASS'?[]:['p99'],
  metrics:{frames:36000,measuredS:600,p50FrameMs:16.66,p99FrameMs:p99,maxFrameMs:p99,missedRefreshes:0,featuresHeld:true,airborne:true,gpuBytes:1,cpuBytes:1},
  rating:{score,band:'x',components:{}},traceSha256:machine+backend+score,...extra});
assert.equal(decideTask073([]).status,'BLOCKED_EXTERNAL');
const strong=[rec('Mac','Apple M5','integrated','webgl2','PASS',98,17),rec('Mac','Apple M5','integrated','webgpu','PASS',97,17)];
const weak=[rec('Win','Intel(R) Graphics','integrated','webgl2','FAIL',61,22),rec('Win','Intel(R) Graphics','integrated','webgpu','PASS',80,17.5)];
const dgpu=[rec('Win','RTX 4050','discrete','webgl2','FAIL',30,27)];
// The weaker integrated GPU decides even though the stronger one passes; discrete GPUs never decide.
const d=decideTask073([...strong,...weak,...dgpu]);
assert.equal(d.status,'FAIL'); assert.equal(d.metrics.gateDevice,'Win | Intel(R) Graphics'); assert.equal(d.metrics.ranking.length,2);
assert.equal(decideTask073([...strong,...dgpu]).status,'PASS');
// An integrated GPU missing a backend leaves the least performant one unknown.
const b=decideTask073([...strong,weak[0]]);
assert.equal(b.status,'BLOCKED_EXTERNAL'); assert.match(b.reasons[1],/Intel\\(R\\) Graphics: no gate-eligible webgpu run/);
// Historical or INFO records count as tested GPUs but cannot decide.
assert.equal(decideTask073([...strong,{...weak[0],source:'historical'},{...weak[1],status:'INFO'}]).status,'BLOCKED_EXTERNAL');
// The latest gate-eligible run per backend counts.
const rerun=rec('Win','Intel(R) Graphics','integrated','webgl2','PASS',85,17.4,{recordedAt:'2026-10-24T00:00:00Z'});
assert.equal(decideTask073([...strong,...weak,rerun]).metrics.gateDevice,'Win | Intel(R) Graphics');
assert.equal(decideTask073([...strong,...weak,rerun]).status,'PASS');
// One rating per machine + screen + GPU: mean of the latest 60 FPS WebGL2 and WebGPU runs.
const combos=comboRatings([...strong,...weak,rerun]);
assert.equal(combos.length,2); assert.equal(combos[0].rating60.score,98); assert.equal(combos[1].rating60.score,83); assert.equal(combos[0].rating120,null);
const prov=comboRatings([{...weak[0],rating:{score:50,band:'usable',components:{},provisional:{unknown:['memory'],upperBound:60}}}]);
assert.equal(prov[0].rating60.provisional,true); assert.equal(prov[0].rating60.upperBound,60);
assert.match(markdownCombos([...strong]),/98 \\(excellent\\)/);
// Registry hygiene and the committed registry.
const reg={schemaVersion:1,runs:[]};
const added=addRun(reg,strong[0]); assert.equal(added.runs.length,1);
assert.throws(()=>addRun(added,strong[0]),/already/);
assert.throws(()=>addRun(reg,{...strong[0],source:'historical'}));
const committed=loadRegistry();
assert.ok(committed.runs.length>=1);
assert.equal(decideTask073(committed.runs).status,'BLOCKED_EXTERNAL');
assert.match(markdownRows(committed.runs),/\\| Machine \\| Screen \\|/);
assert.equal(screenLabel({screenWidth:1710,screenHeight:1107,dpr:2},59.88),'3420 x 2214 @ 59.88 Hz, 2x scale');
const record=buildRunRecord({trace:{hostModel:'Apple M5',os:'macOS',refreshHz:60,gpu:'Apple M5',browser:'b',powerMode:'AC',backend:'webgl2',fps:60,width:1920,height:1080,dpr:1,scale:1},
  result:{status:'BLOCKED_EXTERNAL',reasons:['slept'],metrics:{gpuKind:'integrated'}},labels:{machine:'',screen:''},screen:{screenWidth:1920,screenHeight:1080,dpr:1},
  terrain:'fixture',view:'chase',traceSha256:'a'.repeat(64),recordedAt:'2026-10-23T00:00:00Z'});
assert.equal(record.machine.label,'Apple M5'); assert.equal(record.metrics,null); assert.equal(record.rating,null);
`));
