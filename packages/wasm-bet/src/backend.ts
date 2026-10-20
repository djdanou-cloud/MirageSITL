/** Independent rigid-body ABI v1; accepts an already aggregated body wrench.
 * Aerodynamics/actuator models remain separate. The rotor arena ABI is unchanged.
 */
export const BODY_ABI = {
  version: 1,
  inputBytes: 256,
  outputBytes: 128,
  mass: 0,
  inertia: 8,
  position: 80,
  velocity: 104,
  quaternion: 128,
  omega: 160,
  force: 184,
  moment: 208,
  gravity: 232,
  header: 240,
} as const;
export interface BodyTruth {
  positionNedM: Float64Array;
  velocityNedMps: Float64Array;
  quaternionBodyToNed: Float64Array;
  angularVelocityBodyRadS: Float64Array;
  accelerationNedMps2: Float64Array;
}
export function newBodyTruth(): BodyTruth {
  return {
    positionNedM: new Float64Array(3),
    velocityNedMps: new Float64Array(3),
    quaternionBodyToNed: new Float64Array([1, 0, 0, 0]),
    angularVelocityBodyRadS: new Float64Array(3),
    accelerationNedMps2: new Float64Array(3),
  };
}
function callable(value: unknown): value is (...args: number[]) => number {
  return typeof value === "function";
}
/** One native/WASM integrator owns motion. Cannot coexist with a second body solver. */
const ownedMemories = new WeakSet<WebAssembly.Memory>();
export class BetRigidBodyBackend {
  private readonly memory: WebAssembly.Memory;
  private readonly buffer: ArrayBuffer;
  private readonly view: DataView;
  private readonly input: number;
  private readonly output: number;
  private readonly stepNative: (...args: number[]) => number;
  constructor(
    instance: WebAssembly.Instance,
    massKg: number,
    inertia: readonly number[],
    gravityMps2 = 9.80665,
  ) {
    const e = instance.exports,
      step = e.bet_body_step,
      version = e.bet_body_abi_version,
      heap = e.__heap_base;
    if (
      !(e.memory instanceof WebAssembly.Memory) ||
      !callable(step) ||
      !callable(version) ||
      version() !== 1 ||
      !(heap instanceof WebAssembly.Global) ||
      typeof heap.value !== "number" ||
      inertia.length !== 9 ||
      !Number.isFinite(massKg) ||
      massKg <= 0 ||
      !Number.isFinite(gravityMps2) ||
      gravityMps2 < 0
    )
      throw new Error("Invalid body ABI or parameters");
    if (ownedMemories.has(e.memory))
      throw new Error("Body backend requires a dedicated WASM memory instance");
    this.memory = e.memory;
    this.input = Math.ceil(heap.value / 64) * 64;
    this.output = this.input + 256;
    const pages = Math.ceil((this.output + 128) / 65536);
    if (this.memory.buffer.byteLength < pages * 65536)
      this.memory.grow(pages - this.memory.buffer.byteLength / 65536);
    this.buffer = this.memory.buffer;
    this.view = new DataView(this.buffer);
    this.stepNative = step;
    this.view.setFloat64(this.input, massKg, true);
    for (let i = 0; i < 9; i++)
      this.view.setFloat64(this.input + 8 + i * 8, inertia[i]!, true);
    this.view.setFloat64(this.input + 232, gravityMps2, true);
    this.view.setUint32(this.input + 240, 1, true);
    this.reset(newBodyTruth());
    const out = newBodyTruth();
    if (!this.stepInto(new Float64Array(6), 1 / 400, out))
      throw new Error("Invalid mass or SPD inertia");
    this.reset(newBodyTruth());
    ownedMemories.add(this.memory);
  }
  /** Config/reset path; the native state remains in caller-owned linear memory. */
  reset(state: BodyTruth): void {
    if (
      state.positionNedM.length !== 3 ||
      state.velocityNedMps.length !== 3 ||
      state.quaternionBodyToNed.length !== 4 ||
      state.angularVelocityBodyRadS.length !== 3
    )
      throw new Error("Invalid body reset shape");
    for (let i = 0; i < 3; i++)
      if (
        !Number.isFinite(state.positionNedM[i]) ||
        !Number.isFinite(state.velocityNedMps[i]) ||
        !Number.isFinite(state.angularVelocityBodyRadS[i])
      )
        throw new Error("Non-finite body reset");
    const q = state.quaternionBodyToNed;
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const component = q[i]!;
      if (!Number.isFinite(component)) throw new Error("Invalid body reset quaternion");
      sum += component * component;
    }
    if (Math.abs(Math.sqrt(sum) - 1) > 1e-6)
      throw new Error("Invalid body reset quaternion");
    const a = this.input;
    for (let i = 0; i < 3; i++) {
      this.view.setFloat64(a + 80 + 8 * i, state.positionNedM[i]!, true);
      this.view.setFloat64(a + 104 + 8 * i, state.velocityNedMps[i]!, true);
      this.view.setFloat64(
        a + 160 + 8 * i,
        state.angularVelocityBodyRadS[i]!,
        true,
      );
    }
    for (let i = 0; i < 4; i++)
      this.view.setFloat64(
        a + 128 + 8 * i,
        state.quaternionBodyToNed[i]!,
        true,
      );
  }
  /** Wrench is [Fx,Fy,Fz,Mx,My,Mz] in body FRD. Output arrays allocated once. */
  stepInto(wrench: Float64Array, dt: number, out: BodyTruth): boolean {
    if (
      this.memory.buffer !== this.buffer ||
      wrench.length !== 6 ||
      out.positionNedM.length !== 3 ||
      out.velocityNedMps.length !== 3 ||
      out.quaternionBodyToNed.length !== 4 ||
      out.angularVelocityBodyRadS.length !== 3 ||
      out.accelerationNedMps2.length !== 3
    )
      return false;
    for (let i = 0; i < 6; i++) if (!Number.isFinite(wrench[i])) return false;
    for (let i = 0; i < 6; i++)
      this.view.setFloat64(this.input + 184 + i * 8, wrench[i]!, true);
    if (this.stepNative(this.input, this.output, dt) !== 0) return false;
    for (let i = 0; i < 3; i++) {
      out.positionNedM[i] = this.view.getFloat64(this.output + i * 8, true);
      out.velocityNedMps[i] = this.view.getFloat64(
        this.output + 24 + i * 8,
        true,
      );
      out.angularVelocityBodyRadS[i] = this.view.getFloat64(
        this.output + 80 + i * 8,
        true,
      );
      out.accelerationNedMps2[i] = this.view.getFloat64(
        this.output + 104 + i * 8,
        true,
      );
      this.view.setFloat64(this.input + 80 + i * 8, out.positionNedM[i]!, true);
      this.view.setFloat64(
        this.input + 104 + i * 8,
        out.velocityNedMps[i]!,
        true,
      );
      this.view.setFloat64(
        this.input + 160 + i * 8,
        out.angularVelocityBodyRadS[i]!,
        true,
      );
    }
    for (let i = 0; i < 4; i++) {
      out.quaternionBodyToNed[i] = this.view.getFloat64(
        this.output + 48 + i * 8,
        true,
      );
      this.view.setFloat64(
        this.input + 128 + i * 8,
        out.quaternionBodyToNed[i]!,
        true,
      );
    }
    return true;
  }
}
