import type { BodyTruth } from "@mirage/wasm-bet/backend";
/** Adapter requires an already checksum-verified Emscripten module and reviewed
 * model assets. It cannot claim readiness from a manifest or timer alone.
 */
export interface JsbsimModule {
  HEAPU8: Uint8Array;
  HEAPF64: Float64Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _jsb_abi_version(): number;
  _jsb_create(root: number, model: number, dt: number): number;
  _jsb_step(
    handle: number,
    input: number,
    inputCount: number,
    out: number,
    outCount: number,
  ): number;
  _jsb_dispose(handle: number): void;
  _jsb_trim?(handle: number, controls: number, count: number): number;
}
export interface JsbsimTruth extends BodyTruth {
  specificForceBodyMps2: Float64Array;
  timeS: number;
  altitudeAslM: number;
}
export const JSBSIM_ABI = {
  version: 1,
  inputCount: 4,
  outputCount: 22,
  feetToMetres: 0.3048,
} as const;
/** Single integration owner. Contact impulse exchange is not enabled/certified. */
export class JsbsimBackend {
  readonly integrationOwner = "jsbsim" as const;
  readonly highRateCertified = false;
  private handle = 0;
  private input = 0;
  private output = 0;
  private readonly buffer: ArrayBufferLike;
  private disposed = false;
  private stepped = false;
  constructor(
    private readonly module: JsbsimModule,
    root: string,
    model: string,
    readonly dt: number,
  ) {
    if (
      module.HEAPU8.byteOffset !== 0 ||
      module.HEAPF64.byteOffset !== 0 ||
      module.HEAPU8.buffer !== module.HEAPF64.buffer ||
      module.HEAPU8.byteLength !== module.HEAPF64.byteLength ||
      module._jsb_abi_version() !== 1 ||
      !/^\/[A-Za-z0-9_/-]{1,200}$/.test(root) ||
      root.includes("..") ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(model) ||
      ![1 / 400, 1 / 800, 1 / 1200].includes(dt)
    )
      throw new Error("Invalid JSBSim configuration");
    const encoder = new TextEncoder(),
      rootBytes = encoder.encode(root + "\0"),
      modelBytes = encoder.encode(model + "\0");
    let rp = 0,
      mp = 0;
    try {
      rp = module._malloc(rootBytes.length);
      mp = module._malloc(modelBytes.length);
      if (!rp || !mp) throw new Error("JSBSim string allocation failed");
      module.HEAPU8.set(rootBytes, rp);
      module.HEAPU8.set(modelBytes, mp);
      this.handle = module._jsb_create(rp, mp, dt);
      if (!this.handle)
        throw new Error("JSBSim failed to load reviewed aircraft assets");
    } finally {
      if (rp) module._free(rp);
      if (mp) module._free(mp);
    }
    this.input = module._malloc(32);
    this.output = module._malloc(176);
    const bytes = module.HEAPU8.byteLength;
    if (
      !Number.isSafeInteger(this.input) ||
      !Number.isSafeInteger(this.output) ||
      this.input <= 0 ||
      this.output <= 0 ||
      this.input % 8 !== 0 ||
      this.output % 8 !== 0 ||
      this.input + 32 > bytes ||
      this.output + 176 > bytes ||
      (this.input < this.output + 176 && this.output < this.input + 32)
    ) {
      this.dispose();
      throw new Error("JSBSim frame allocation failed");
    }
    this.buffer = module.HEAPU8.buffer;
  }
  /** Cold setup only: upstream trimming may allocate. The body origin resets on success. */
  trimInto(controls: Float64Array): boolean {
    if (
      this.disposed ||
      this.stepped ||
      controls.length !== 4 ||
      this.module.HEAPU8.buffer !== this.buffer ||
      !this.module._jsb_trim
    )
      return false;
    if (
      this.module._jsb_trim(this.handle, this.input, 4) !== 0 ||
      this.module.HEAPU8.buffer !== this.buffer
    )
      return false;
    const start = this.input / 8,
      heap = this.module.HEAPF64;
    for (let i = 0; i < 4; i++)
      if (
        !Number.isFinite(heap[start + i]) ||
        heap[start + i]! < (i === 0 ? 0 : -1) ||
        heap[start + i]! > 1
      )
        return false;
    for (let i = 0; i < 4; i++) controls[i] = heap[start + i]!;
    return true;
  }
  stepInto(controls: Float64Array, out: JsbsimTruth): boolean {
    if (
      out.positionNedM.length !== 3 ||
      out.velocityNedMps.length !== 3 ||
      out.quaternionBodyToNed.length !== 4 ||
      out.angularVelocityBodyRadS.length !== 3 ||
      out.accelerationNedMps2.length !== 3 ||
      out.specificForceBodyMps2.length !== 3 ||
      this.disposed ||
      !this.handle ||
      this.module.HEAPU8.buffer !== this.buffer ||
      controls.length !== 4
    )
      return false;
    for (let i = 0; i < 4; i++)
      if (
        !Number.isFinite(controls[i]) ||
        controls[i]! < (i === 0 ? 0 : -1) ||
        controls[i]! > 1
      )
        return false;
    this.stepped = true;
    const heap = this.module.HEAPF64,
      start = this.input / 8,
      offset = this.output / 8;
    for (let i = 0; i < 4; i++) heap[start + i] = controls[i]!;
    if (
      this.module._jsb_step(this.handle, this.input, 4, this.output, 22) !== 0
    )
      return false;
    if (this.module.HEAPU8.buffer !== this.buffer) return false;
    for (let i = 0; i < 22; i++)
      if (!Number.isFinite(heap[offset + i])) return false;
    for (let i = 0; i < 3; i++) {
      out.positionNedM[i] = heap[offset + i]!;
      out.velocityNedMps[i] = heap[offset + 3 + i]!;
      out.angularVelocityBodyRadS[i] = heap[offset + 10 + i]!;
      out.specificForceBodyMps2[i] = heap[offset + 13 + i]!;
      out.accelerationNedMps2[i] = heap[offset + 19 + i]!;
    }
    for (let i = 0; i < 4; i++)
      out.quaternionBodyToNed[i] = heap[offset + 6 + i]!;
    out.timeS = heap[offset + 16]!;
    out.altitudeAslM = heap[offset + 17]!;
    return true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.handle) {
      this.module._jsb_dispose(this.handle);
      this.handle = 0;
    }
    if (this.input) this.module._free(this.input);
    if (this.output) this.module._free(this.output);
  }
}
