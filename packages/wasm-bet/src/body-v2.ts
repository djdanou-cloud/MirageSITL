/** Rigid-body step interface v2 (TASK-088); accepts an already aggregated body wrench. */
import type { BodyTruth } from './backend.ts';

/** Byte offsets of the 448-byte input and 256-byte output records (SPECS_SIMULATION_ENGINES.md). */
export const BODY_V2 = {
  version: 2, inputBytes: 448, outputBytes: 256, unsupported: -8,
  input: { version: 0, gravityModel: 4, flags: 8, mass: 16, inertiaCg: 24, position: 96, velocity: 120, quaternion: 144,
    omega: 176, force: 200, moment: 224, gravityDown: 248, gravityNed: 256, cgOffsetBody: 280, massRate: 304,
    inertiaRate: 312 },
  output: { position: 0, velocity: 24, quaternion: 48, omega: 80, acceleration: 104, specificForceBody: 128,
    angularAccelerationBody: 152, referencePosition: 176, validity: 200 },
  gravityConstantDown: 0, gravityNedVector: 1, gravityWgs84: 2, massRates: 1,
  validSpecificForce: 1, validAngularAcceleration: 2, validReferencePosition: 4,
} as const;

export interface BodyTruthV2 extends BodyTruth {
  /** Accelerometer truth at the CG, body FRD; valid when `validity` has bit 0. */
  specificForceBodyMps2: Float64Array;
  /** Angular acceleration at the end of the step, body FRD (TASK-094, validity bit 1). */
  angularAccelerationBodyRadS2: Float64Array;
  /** Position of the body reference point O, NED (TASK-094, validity bit 2); the CG when there is no offset. */
  referencePositionNedM: Float64Array;
  /** Bits of `BODY_V2.valid*`; quantities without their bit are zero and unavailable. */
  validity: number;
}
export function newBodyTruthV2(): BodyTruthV2 {
  return { positionNedM: new Float64Array(3), velocityNedMps: new Float64Array(3), quaternionBodyToNed: new Float64Array([1, 0, 0, 0]),
    angularVelocityBodyRadS: new Float64Array(3), accelerationNedMps2: new Float64Array(3), specificForceBodyMps2: new Float64Array(3),
    angularAccelerationBodyRadS2: new Float64Array(3), referencePositionNedM: new Float64Array(3), validity: 0 };
}
function callable(value: unknown): value is (...args: number[]) => number { return typeof value === 'function'; }
/** Each backend writes its records at the instance heap base, so an instance serves one backend. */
const ownedMemories = new WeakSet<WebAssembly.Memory>();

/**
 * One WASM integrator owns motion through interface v2; the state feeds back after each step.
 * The state is the CG's. `cgOffsetBodyM` (TASK-094) is the CG's position from the body reference
 * point O, about which `stepInto` takes the moment; zero runs the v1 step bit for bit.
 */
export class BetRigidBodyBackendV2 {
  lastStatus = 0;
  private readonly memory: WebAssembly.Memory;
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly input: number;
  private readonly output: number;
  private readonly stepNative: (...args: number[]) => number;
  constructor(instance: WebAssembly.Instance, massKg: number, inertia: readonly number[], gravityMps2 = 9.80665,
    cgOffsetBodyM: readonly number[] = [0, 0, 0]) {
    const e = instance.exports, step = e.bet_body_step_v2, version = e.bet_body_v2_version, heap = e.__heap_base;
    if (!(e.memory instanceof WebAssembly.Memory) || !callable(step) || !callable(version) || version() !== BODY_V2.version ||
        !(heap instanceof WebAssembly.Global) || typeof heap.value !== 'number' || inertia.length !== 9 ||
        !Number.isFinite(massKg) || massKg <= 0 || !Number.isFinite(gravityMps2) || gravityMps2 < 0 ||
        cgOffsetBodyM.length !== 3 || !cgOffsetBodyM.every(Number.isFinite))
      throw new Error('Invalid body interface v2 or parameters');
    if (ownedMemories.has(e.memory)) throw new Error('Body backend v2 requires a dedicated WASM memory instance');
    this.memory = e.memory;
    this.input = Math.ceil(heap.value / 64) * 64;
    this.output = this.input + BODY_V2.inputBytes;
    const pages = Math.ceil((this.output + BODY_V2.outputBytes) / 65536);
    if (this.memory.buffer.byteLength < pages * 65536) this.memory.grow(pages - this.memory.buffer.byteLength / 65536);
    this.buffer = this.memory.buffer;
    this.view = new DataView(this.buffer);
    this.stepNative = step;
    new Uint8Array(this.buffer, this.input, BODY_V2.inputBytes).fill(0);
    this.view.setUint32(this.input, BODY_V2.version, true);
    this.view.setFloat64(this.input + BODY_V2.input.mass, massKg, true);
    for (let i = 0; i < 9; i++) this.view.setFloat64(this.input + BODY_V2.input.inertiaCg + i * 8, inertia[i]!, true);
    this.view.setFloat64(this.input + BODY_V2.input.gravityDown, gravityMps2, true);
    for (let i = 0; i < 3; i++) this.view.setFloat64(this.input + BODY_V2.input.cgOffsetBody + 8 * i, cgOffsetBodyM[i]!, true);
    this.reset(newBodyTruthV2());
    if (!this.stepInto(new Float64Array(6), 1 / 400, newBodyTruthV2())) throw new Error('Invalid mass or SPD inertia');
    this.reset(newBodyTruthV2());
    ownedMemories.add(this.memory);
  }
  get memoryStable(): boolean { return this.memory.buffer === this.buffer; }
  /** Configuration/reset path; validates the state shape and quaternion norm. */
  reset(state: BodyTruth): void {
    const q = state.quaternionBodyToNed;
    if (state.positionNedM.length !== 3 || state.velocityNedMps.length !== 3 || q.length !== 4 || state.angularVelocityBodyRadS.length !== 3)
      throw new Error('Invalid body reset shape');
    let sum = 0;
    for (let i = 0; i < 4; i++) { const c = q[i]!; if (!Number.isFinite(c)) throw new Error('Invalid body reset quaternion'); sum += c * c; }
    if (Math.abs(Math.sqrt(sum) - 1) > 1e-6) throw new Error('Invalid body reset quaternion');
    const a = this.input, f = BODY_V2.input;
    for (let i = 0; i < 3; i++) {
      if (!Number.isFinite(state.positionNedM[i]) || !Number.isFinite(state.velocityNedMps[i]) || !Number.isFinite(state.angularVelocityBodyRadS[i]))
        throw new Error('Non-finite body reset');
      this.view.setFloat64(a + f.position + 8 * i, state.positionNedM[i]!, true);
      this.view.setFloat64(a + f.velocity + 8 * i, state.velocityNedMps[i]!, true);
      this.view.setFloat64(a + f.omega + 8 * i, state.angularVelocityBodyRadS[i]!, true);
    }
    for (let i = 0; i < 4; i++) this.view.setFloat64(a + f.quaternion + 8 * i, q[i]!, true);
  }
  /** Wrench is [Fx,Fy,Fz,Mx,My,Mz] in body FRD, the moment about the reference point O (the CG without an offset). Allocation-free. */
  stepInto(wrench: Float64Array, dt: number, out: BodyTruthV2): boolean {
    if (this.memory.buffer !== this.buffer || wrench.length !== 6 || out.positionNedM.length !== 3 || out.velocityNedMps.length !== 3 ||
        out.quaternionBodyToNed.length !== 4 || out.angularVelocityBodyRadS.length !== 3 || out.accelerationNedMps2.length !== 3 ||
        out.specificForceBodyMps2.length !== 3 || out.angularAccelerationBodyRadS2.length !== 3 || out.referencePositionNedM.length !== 3) return false;
    for (let i = 0; i < 6; i++) if (!Number.isFinite(wrench[i])) { this.lastStatus = -3; return false; }
    for (let i = 0; i < 6; i++) this.view.setFloat64(this.input + BODY_V2.input.force + i * 8, wrench[i]!, true);
    const status = this.stepNative(this.input, this.output, dt);
    this.lastStatus = status;
    if (status !== 0) return false;
    const o = this.output, a = this.input, f = BODY_V2.input, g = BODY_V2.output;
    for (let i = 0; i < 3; i++) {
      out.positionNedM[i] = this.view.getFloat64(o + g.position + i * 8, true);
      out.velocityNedMps[i] = this.view.getFloat64(o + g.velocity + i * 8, true);
      out.angularVelocityBodyRadS[i] = this.view.getFloat64(o + g.omega + i * 8, true);
      out.accelerationNedMps2[i] = this.view.getFloat64(o + g.acceleration + i * 8, true);
      out.specificForceBodyMps2[i] = this.view.getFloat64(o + g.specificForceBody + i * 8, true);
      out.angularAccelerationBodyRadS2[i] = this.view.getFloat64(o + g.angularAccelerationBody + i * 8, true);
      out.referencePositionNedM[i] = this.view.getFloat64(o + g.referencePosition + i * 8, true);
      this.view.setFloat64(a + f.position + i * 8, out.positionNedM[i]!, true);
      this.view.setFloat64(a + f.velocity + i * 8, out.velocityNedMps[i]!, true);
      this.view.setFloat64(a + f.omega + i * 8, out.angularVelocityBodyRadS[i]!, true);
    }
    for (let i = 0; i < 4; i++) {
      out.quaternionBodyToNed[i] = this.view.getFloat64(o + g.quaternion + i * 8, true);
      this.view.setFloat64(a + f.quaternion + i * 8, out.quaternionBodyToNed[i]!, true);
    }
    out.validity = this.view.getUint32(o + g.validity, true);
    return true;
  }
}
