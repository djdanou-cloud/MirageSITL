/** Production-built bound rotor ABI v1; no hot-path host objects or views. */
import type { BetRotorConfig } from './arena.ts';

export interface BoundPolar {
  alphaRad: readonly number[]; reynolds: readonly number[]; mach: readonly number[];
  cl: readonly number[]; cd: readonly number[]; confidence: readonly number[];
}
export interface BoundRotorDefinition {
  geometry: BetRotorConfig; polar: BoundPolar; initialOmegaRadS: number;
  inflowTauS: number; inflowLimitMps: number; minimumConfidence: number;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Expected a finite rotor parameter');
  return value;
}
function array(value: unknown, cap: number): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > cap) throw Error('Invalid polar array shape');
  return value.map((v: unknown) => finite(v));
}
/** Cold parser. Mach=0 predictions may be explicitly used as an incompressible
 * approximation up to maxMach<=0.3; values outside it remain flagged. */
export function parseNeuralFoilPolar(value: unknown, maxMach = 0.3): BoundPolar {
  if (!record(value) || value.schemaVersion !== 1 || value.provenance !== 'neural-surrogate' ||
      typeof value.airfoil !== 'string' || !Array.isArray(value.mach) || value.mach.length !== 1 || value.mach[0] !== 0 ||
      !Number.isFinite(maxMach) || maxMach < 0 || maxMach > 0.3) throw Error('Invalid NeuralFoil polar identity');
  const alpha = array(value.alphaDeg,361), re = array(value.reynolds,32);
  for (const axis of [alpha,re]) for (let i=1;i<axis.length;i++)
    if (!(axis[i]! > axis[i-1]!)) throw Error('Polar axes must increase');
  if (!(re[0]! > 0)) throw Error('Invalid Reynolds axis');
  const grid = (raw: unknown, kind: 'cl'|'cd'|'confidence'): number[] => {
    if (!Array.isArray(raw) || raw.length !== re.length) throw Error('Invalid polar row count');
    const flat: number[]=[];
    for (const row of raw) {
      const values=array(row,361);
      if (values.length!==alpha.length) throw Error('Invalid polar column count');
      for (const v of values) {
        if ((kind==='cd' && v<0) || (kind==='confidence' && (v<0 || v>1))) throw Error('Invalid polar coefficient');
        flat.push(v);
      }
    }
    return maxMach===0 ? flat : flat.concat(flat);
  };
  return {alphaRad:alpha.map(v=>v*Math.PI/180),reynolds:re,mach:maxMach===0?[0]:[0,maxMach],
    cl:grid(value.cl,'cl'),cd:grid(value.cd,'cd'),confidence:grid(value.analysisConfidence,'confidence')};
}

/** Converts a synthetic span distribution to explicit midpoint geometry. */
export function syntheticRotor(config: unknown, polarValue: unknown, options: {
  spinSign: 1|-1; initialOmegaRadS: number; shaftInertiaKgM2: number;
  bearingViscousNmPerRadS: number; inflowTauS: number; inflowLimitMps: number;
}): BoundRotorDefinition {
  if (!record(config) || !record(config.rotor) || !record(polarValue) || config.airfoil!==polarValue.airfoil)
    throw Error('Synthetic rotor/polar identity mismatch');
  const r=config.rotor, radius=finite(r.radiusM), rootRatio=finite(r.rootRadiusRatio), root=rootRatio*radius;
  const n=finite(r.strips), blades=finite(r.bladeCount), azimuth=finite(r.azimuthSamples);
  if (!Number.isInteger(n) || n<1 || n>64 || radius<=0 || root<0 || root>=radius ||
      !Array.isArray(r.span) || r.span.length<2 || r.span.length>64) throw Error('Invalid synthetic rotor geometry');
  const span=r.span.map((row: unknown)=>array(row,3));
  for (let i=0;i<span.length;i++) {
    const row=span[i]!; // shape and count validated above
    if (row.length!==3 || row[1]!<=0 || (i>0 && row[0]!<=span[i-1]![0]!)) throw Error('Invalid span distribution');
  }
  if (span[0]![0]!==rootRatio || span[span.length-1]![0]!==1) throw Error('Span must cover active radius');
  const radialStationM:number[]=[],chordM:number[]=[],twistRad:number[]=[],quadratureWidthM:number[]=[];
  const width=(radius-root)/n;
  for(let i=0;i<n;i++) {
    const station=root+(i+0.5)*width, ratio=station/radius;
    let k=0;while(k+1<span.length-1 && span[k+1]![0]!<ratio)k++;
    const left=span[k]!,right=span[k+1]!,t=(ratio-left[0]!)/(right[0]!-left[0]!);
    radialStationM.push(station);chordM.push(radius*(left[1]!+t*(right[1]!-left[1]!)));
    twistRad.push((left[2]!+t*(right[2]!-left[2]!))*Math.PI/180);quadratureWidthM.push(width);
  }
  return {geometry:{id:0,bladeCount:blades,spinSign:options.spinSign,azimuthSamples:azimuth,polarId:0,
    radiusM:radius,rootCutoutM:root,hubPositionBodyM:[0,0,0],hubToBody:[1,0,0,0],
    shaftInertiaKgM2:options.shaftInertiaKgM2,bearingViscousNmPerRadS:options.bearingViscousNmPerRadS,
    radialStationM,chordM,twistRad,quadratureWidthM},polar:parseNeuralFoilPolar(polarValue),
    initialOmegaRadS:options.initialOmegaRadS,inflowTauS:options.inflowTauS,
    inflowLimitMps:options.inflowLimitMps,minimumConfidence:0.9};
}

/** Fixed little-endian payload, validated semantically by the native initializer. */
export function encodeBoundRotor(d: BoundRotorDefinition, dtS: number): Uint8Array<ArrayBuffer> {
  const g=d.geometry,p=d.polar,ns=g.radialStationM.length,na=p.alphaRad.length,nr=p.reynolds.length,nm=p.mach.length;
  const count=na*nr*nm;
  if (ns<1 || ns>64 || na<1 || na>361 || nr<1 || nr>32 || nm<1 || nm>8 || count>16384 ||
      g.chordM.length!==ns || g.twistRad.length!==ns || g.quadratureWidthM.length!==ns ||
      p.cl.length!==count || p.cd.length!==count || p.confidence.length!==count ||
      !Number.isInteger(g.bladeCount) || !Number.isInteger(g.azimuthSamples) || ![1,-1].includes(g.spinSign))
    throw Error('Invalid bound rotor payload shape');
  const bytes=new Uint8Array(128+(ns*4+na+nr+nm+count*3)*8),v=new DataView(bytes.buffer);
  const integers=[1,bytes.length,na,nr,nm,ns,g.bladeCount,g.spinSign,g.azimuthSamples];
  for(let i=0;i<integers.length;i++)v.setUint32(i*4,integers[i]!,true);
  const scalars=[g.radiusM,g.rootCutoutM,g.shaftInertiaKgM2,g.bearingViscousNmPerRadS,dtS,
    d.initialOmegaRadS,d.inflowTauS,d.inflowLimitMps,d.minimumConfidence];
  for(let i=0;i<scalars.length;i++)v.setFloat64(40+i*8,scalars[i]!,true);
  let at=128;
  for(const values of [g.radialStationM,g.chordM,g.twistRad,g.quadratureWidthM,p.alphaRad,p.reynolds,p.mach,p.cl,p.cd,p.confidence])
    for(const x of values){v.setFloat64(at,x,true);at+=8;}
  return bytes;
}
function callable(value: unknown): value is (...args:number[])=>number {return typeof value==='function';}
/** A dedicated WASM instance owns up to 32 independent bound rotor handles.
 * Input rows (13 doubles): rho,mu,sound,air[3],rate[3],collective,cos,sin,motor.
 * Output rows (16 doubles) match the native 128-byte record; slot14 is numeric flags.
 */
export class BetRotorEngine {
  readonly count:number;
  readonly input:Float64Array;
  readonly output:Float64Array;
  readonly dtS:number;
  private readonly memory:WebAssembly.Memory;
  private readonly buffer:ArrayBuffer;
  private readonly view:DataView;
  private readonly handles:Uint32Array;
  private readonly inputs:Uint32Array;
  private readonly outputs:Uint32Array;
  private readonly initial:Float64Array;
  private readonly nativeStep:(...args:number[])=>number;
  private readonly nativeReset:(...args:number[])=>number;
  private readonly nativeDispose:(...args:number[])=>number;
  private disposed=false;
  constructor(module:WebAssembly.Module,definitions:readonly BoundRotorDefinition[],hz:400|800|1200|4800) {
    if (![400,800,1200,4800].includes(hz) || definitions.length<1 || definitions.length>32) throw Error('Invalid bound rotor count/rate');
    const e=new WebAssembly.Instance(module,{}).exports;
    if (!(e.memory instanceof WebAssembly.Memory) || !(e.__heap_base instanceof WebAssembly.Global) ||
        typeof e.__heap_base.value!=='number' || !callable(e.bet_bound_version) || e.bet_bound_version()!==1 ||
        !callable(e.bet_bound_init) || !callable(e.bet_bound_step) || !callable(e.bet_bound_reset) || !callable(e.bet_bound_dispose))
      throw Error('Missing bound rotor ABI v1');
    this.count=definitions.length;this.dtS=1/hz;this.memory=e.memory;
    this.nativeStep=e.bet_bound_step;this.nativeReset=e.bet_bound_reset;this.nativeDispose=e.bet_bound_dispose;
    this.handles=new Uint32Array(this.count);this.inputs=new Uint32Array(this.count);this.outputs=new Uint32Array(this.count);
    this.initial=new Float64Array(this.count);this.input=new Float64Array(this.count*13);this.output=new Float64Array(this.count*16);
    const payloads=definitions.map(d=>encodeBoundRotor(d,this.dtS));
    let at=Math.ceil(e.__heap_base.value/64)*64;
    const configs:number[]=[];
    for(let i=0;i<this.count;i++) {
      const bytes=payloads[i]!;configs.push(at);at+=Math.ceil(bytes.length/64)*64;
      this.handles[i]=at;at+=Math.ceil((bytes.length+64)/64)*64;
      this.inputs[i]=at;at+=128;this.outputs[i]=at;at+=128;
      this.initial[i]=definitions[i]!.initialOmegaRadS;
      this.input[i*13]=1.225;this.input[i*13+1]=1.789e-5;this.input[i*13+2]=340;
    }
    if (at>64*1024*1024) throw Error('Bound rotor memory budget exceeded');
    if(this.memory.buffer.byteLength<at)this.memory.grow(Math.ceil((at-this.memory.buffer.byteLength)/65536));
    this.buffer=this.memory.buffer;this.view=new DataView(this.buffer);
    for(let i=0;i<this.count;i++) {
      const bytes=payloads[i]!,cp=configs[i]!,handle=this.handles[i]!,ip=this.inputs[i]!;
      new Uint8Array(this.buffer,cp,bytes.length).set(bytes);
      const status=e.bet_bound_init(cp,bytes.length,handle,bytes.length+64);
      if(status!==0)throw Error(`Invalid bound rotor configuration: ${status}`);
      this.view.setUint32(ip,1,true);this.output[i*16+9]=this.initial[i]!;
    }
  }
  get memoryStable():boolean{return this.memory.buffer===this.buffer;}
  get memoryBytes():number{return this.buffer.byteLength;}
  stepInto():boolean {
    if(this.disposed || !this.memoryStable)return false;
    for(let i=0;i<this.input.length;i++)if(!Number.isFinite(this.input[i]))return false;
    for(let i=0;i<this.count;i++) {
      const ip=this.inputs[i]!,op=this.outputs[i]!,base=i*13,out=i*16;
      for(let j=0;j<13;j++)this.view.setFloat64(ip+8+j*8,this.input[base+j]!,true);
      if(this.nativeStep(this.handles[i]!,ip,op,this.dtS)!==0)return false;
      for(let j=0;j<14;j++)this.output[out+j]=this.view.getFloat64(op+j*8,true);
      this.output[out+14]=this.view.getUint32(op+112,true);this.output[out+15]=this.view.getFloat64(op+120,true);
    }
    return true;
  }
  reset():void {
    if(this.disposed || !this.memoryStable)throw Error('Cannot reset an invalid bound rotor engine');
    this.output.fill(0);
    for(let i=0;i<this.count;i++) {
      if(this.nativeReset(this.handles[i]!)!==0)throw Error('Bound rotor reset failed');
      this.output[i*16+9]=this.initial[i]!;
    }
  }
  dispose():void {if(!this.disposed && this.memoryStable)for(let i=0;i<this.count;i++)this.nativeDispose(this.handles[i]!);this.disposed=true;}
}
