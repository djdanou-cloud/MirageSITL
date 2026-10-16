import { validateModelManifest } from "./model-manifest";
/** Cold configuration + reusable six-component body-wrench accumulator. */
export class FrameLayout {
  readonly count: number;
  readonly rotorIds: Uint32Array;
  private readonly rotations: Float64Array;
  private readonly positions: Float64Array;
  private readonly sum = new Float64Array(6);
  constructor(input: unknown) {
    const model = validateModelManifest(input);
    this.count = model.rotorCount;
    this.rotorIds = new Uint32Array(this.count);
    this.rotations = new Float64Array(this.count * 9);
    this.positions = new Float64Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const rotor = model.rotors[i]!; // Schema established count and all tuple lengths.
      const q = rotor.hubToBody,
        norm = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
      const w = q[0]! / norm,
        x = q[1]! / norm,
        y = q[2]! / norm,
        z = q[3]! / norm,
        a = i * 9;
      this.rotorIds[i] = rotor.id;
      this.positions.set(rotor.hubPositionBodyM, i * 3);
      this.rotations.set(
        [
          1 - 2 * (y * y + z * z),
          2 * (x * y - w * z),
          2 * (x * z + w * y),
          2 * (x * y + w * z),
          1 - 2 * (x * x + z * z),
          2 * (y * z - w * x),
          2 * (x * z - w * y),
          2 * (y * z + w * x),
          1 - 2 * (x * x + y * y),
        ],
        a,
      );
    }
  }
  /** Order follows rotorIds; every hub record is [Fx,Fy,Fz,Mx,My,Mz]. */
  sumInto(hub: Float64Array, out: Float64Array): boolean {
    if (hub.length !== this.count * 6 || out.length !== 6) return false;
    for (let i = 0; i < hub.length; i++)
      if (!Number.isFinite(hub[i])) return false;
    this.sum.fill(0);
    for (let i = 0; i < this.count; i++) {
      const a = i * 9,
        h = i * 6,
        p = i * 3,
        r = this.rotations;
      const fx =
        r[a]! * hub[h]! + r[a + 1]! * hub[h + 1]! + r[a + 2]! * hub[h + 2]!;
      const fy =
        r[a + 3]! * hub[h]! + r[a + 4]! * hub[h + 1]! + r[a + 5]! * hub[h + 2]!;
      const fz =
        r[a + 6]! * hub[h]! + r[a + 7]! * hub[h + 1]! + r[a + 8]! * hub[h + 2]!;
      this.sum[0] = this.sum[0]! + fx;
      this.sum[1] = this.sum[1]! + fy;
      this.sum[2] = this.sum[2]! + fz;
      this.sum[3] =
        this.sum[3]! +
        this.positions[p + 1]! * fz -
        this.positions[p + 2]! * fy +
        r[a]! * hub[h + 3]! +
        r[a + 1]! * hub[h + 4]! +
        r[a + 2]! * hub[h + 5]!;
      this.sum[4] =
        this.sum[4]! +
        this.positions[p + 2]! * fx -
        this.positions[p]! * fz +
        r[a + 3]! * hub[h + 3]! +
        r[a + 4]! * hub[h + 4]! +
        r[a + 5]! * hub[h + 5]!;
      this.sum[5] =
        this.sum[5]! +
        this.positions[p]! * fy -
        this.positions[p + 1]! * fx +
        r[a + 6]! * hub[h + 3]! +
        r[a + 7]! * hub[h + 4]! +
        r[a + 8]! * hub[h + 5]!;
    }
    for (let i = 0; i < 6; i++) if (!Number.isFinite(this.sum[i])) return false;
    out.set(this.sum);
    return true;
  }
}
