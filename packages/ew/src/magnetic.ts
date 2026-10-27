/** Body sensor Rz*Ry*Rx rotation plus body-frame bias in gauss. */
export class MagneticAnomaly {
  private readonly matrix: Float64Array;
  private readonly bias: Float64Array;
  private readonly rotationInput: [number, number, number] = [0, 0, 0];
  private readonly biasInput: [number, number, number] = [0, 0, 0];
  constructor(
    rotationRad: readonly [number, number, number],
    biasBodyGauss: readonly [number, number, number],
  ) {
    if (
      !rotationRad.every(Number.isFinite) ||
      !biasBodyGauss.every(Number.isFinite)
    )
      throw new Error("Invalid magnetic anomaly");
    const [r, p, y] = rotationRad,
      cr = Math.cos(r),
      sr = Math.sin(r),
      cp = Math.cos(p),
      sp = Math.sin(p),
      cy = Math.cos(y),
      sy = Math.sin(y);
    this.matrix = new Float64Array([
      cy * cp,
      cy * sp * sr - sy * cr,
      cy * sp * cr + sy * sr,
      sy * cp,
      sy * sp * sr + cy * cr,
      sy * sp * cr - cy * sr,
      -sp,
      cp * sr,
      cp * cr,
    ]);
    this.bias = new Float64Array(biasBodyGauss);
  }
  /** Low-rate convenience for configureFrom (float arguments may be boxed). */
  configure(roll: number, pitch: number, yaw: number, bx: number, by: number, bz: number): boolean {
    const r = this.rotationInput, b = this.biasInput;
    r[0] = roll; r[1] = pitch; r[2] = yaw;
    b[0] = bx; b[1] = by; b[2] = bz;
    return this.configureFrom(r, b);
  }
  /**
   * Reconfigures rotation (rad) and body bias (gauss) in place for
   * tick-boundary fault commands. Both are read from arrays, so no float
   * crosses a call and nothing is allocated. False (unchanged) if any value
   * is non-finite.
   */
  configureFrom(rotationRad: readonly [number, number, number], biasBodyGauss: readonly [number, number, number]): boolean {
    const roll = rotationRad[0], pitch = rotationRad[1], yaw = rotationRad[2];
    const bx = biasBodyGauss[0], by = biasBodyGauss[1], bz = biasBodyGauss[2];
    if (!Number.isFinite(roll) || !Number.isFinite(pitch) || !Number.isFinite(yaw) ||
      !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) return false;
    const cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch),
      cy = Math.cos(yaw), sy = Math.sin(yaw), m = this.matrix;
    m[0] = cy * cp; m[1] = cy * sp * sr - sy * cr; m[2] = cy * sp * cr + sy * sr;
    m[3] = sy * cp; m[4] = sy * sp * sr + cy * cr; m[5] = sy * sp * cr - cy * sr;
    m[6] = -sp; m[7] = cp * sr; m[8] = cp * cr;
    this.bias[0] = bx; this.bias[1] = by; this.bias[2] = bz;
    return true;
  }
  distortInto(source: Float64Array, target: Float64Array): boolean {
    if (
      source.length !== 3 ||
      target.length !== 3 ||
      (source.buffer === target.buffer &&
        source.byteOffset < target.byteOffset + target.byteLength &&
        target.byteOffset < source.byteOffset + source.byteLength)
    )
      return false;
    const x = source[0]!,
      y = source[1]!,
      z = source[2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      return false;
    const m = this.matrix,
      b = this.bias,
      a = m[0]! * x + m[1]! * y + m[2]! * z + b[0]!,
      c = m[3]! * x + m[4]! * y + m[5]! * z + b[1]!,
      d = m[6]! * x + m[7]! * y + m[8]! * z + b[2]!;
    if (!Number.isFinite(a) || !Number.isFinite(c) || !Number.isFinite(d))
      return false;
    target[0] = a;
    target[1] = c;
    target[2] = d;
    return true;
  }
}
