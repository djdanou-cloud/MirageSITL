import { VehicleFlagV2 } from "@mirage/protocol";
/** Stable manifest motor IDs, not wire channel numbers. Cold topology, tick-boundary faults. */
export class MotorFaults {
  private syntheticCount = 0;
  private readonly torqueInput = new Float64Array(1);
  private readonly remainingInput = new Float64Array(1);
  get vehicleFlags(): number {
    return this.syntheticCount > 0 ? VehicleFlagV2.ModelOutsideValidity : 0;
  }
  private readonly present = new Uint8Array(32);
  private readonly modes = new Uint8Array(32);
  private readonly fraction = new Float64Array(32);
  constructor(ids: readonly number[]) {
    if (ids.length < 1 || ids.length > 32)
      throw new Error("Invalid motor count");
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id > 31 || this.present[id])
        throw new Error("Invalid/duplicate motor ID");
      this.present[id] = 1;
    }
    this.reset();
  }
  reset(): void {
    this.syntheticCount = 0;
    this.modes.fill(0);
    this.fraction.fill(1);
  }
  /** Low-rate convenience for setFromArray (a float argument may be boxed). */
  set(
    id: number,
    mode: "none" | "power-cut" | "instant-thrust-loss",
    remaining: number,
  ): boolean {
    this.remainingInput[0] = remaining;
    return this.setFromArray(id, mode, this.remainingInput);
  }
  /** Sets a motor fault with the remaining thrust fraction in `remainingSource[0]`; tick-boundary commands pass no float argument. */
  setFromArray(
    id: number,
    mode: "none" | "power-cut" | "instant-thrust-loss",
    remainingSource: Float64Array,
  ): boolean {
    const remaining = remainingSource[0];
    if (
      remaining === undefined ||
      !Number.isInteger(id) ||
      this.present[id] !== 1 ||
      !Number.isFinite(remaining) ||
      remaining < 0 ||
      remaining > 1 ||
      (mode !== "none" &&
        mode !== "power-cut" &&
        mode !== "instant-thrust-loss")
    )
      return false;
    if (this.modes[id] === 2) this.syntheticCount--;
    if (mode === "instant-thrust-loss") this.syntheticCount++;
    this.modes[id] = mode === "none" ? 0 : mode === "power-cut" ? 1 : 2;
    this.fraction[id] = mode === "none" ? 1 : remaining;
    return true;
  }
  driveTorque(id: number, baselineNm: number): number {
    if (
      !Number.isInteger(id) ||
      this.present[id] !== 1 ||
      !Number.isFinite(baselineNm) ||
      baselineNm < 0
    )
      return NaN;
    return baselineNm * (this.modes[id] === 1 ? this.fraction[id]! : 1);
  }
  driveTorqueInto(id: number, baselineNm: number, out: Float64Array): boolean {
    this.torqueInput[0] = baselineNm;
    return this.driveTorqueFromArrayInto(id, this.torqueInput, out);
  }
  driveTorqueFromArrayInto(
    id: number,
    sourceNm: Float64Array,
    out: Float64Array,
  ): boolean {
    if (sourceNm.length !== 1) return false;
    const baselineNm = sourceNm[0]!;
    if (
      out.length !== 1 ||
      !Number.isInteger(id) ||
      this.present[id] !== 1 ||
      !Number.isFinite(baselineNm) ||
      baselineNm < 0
    )
      return false;
    out[0] = baselineNm * (this.modes[id] === 1 ? this.fraction[id]! : 1);
    return true;
  }
  outsideValidity(id: number): boolean {
    return this.present[id] === 1 && this.modes[id] === 2;
  }
  wrenchInto(id: number, source: Float64Array, target: Float64Array): boolean {
    if (
      !Number.isInteger(id) ||
      this.present[id] !== 1 ||
      source.length !== 6 ||
      target.length !== 6
    )
      return false;
    for (let i = 0; i < 6; i++) if (!Number.isFinite(source[i])) return false;
    const fraction = this.modes[id] === 2 ? this.fraction[id]! : 1;
    // Partial overlapping views would corrupt future reads; exact in-place use is safe.
    if (
      source.buffer === target.buffer &&
      source.byteOffset !== target.byteOffset &&
      source.byteOffset < target.byteOffset + target.byteLength &&
      target.byteOffset < source.byteOffset + source.byteLength
    )
      return false;
    for (let i = 0; i < 6; i++) target[i] = source[i]! * fraction;
    return true;
  }
}
