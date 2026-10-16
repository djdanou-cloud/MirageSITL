/** Body sensor Rz*Ry*Rx rotation plus body-frame bias in gauss. */
export class MagneticAnomaly {
  private readonly matrix: Float64Array;
  private readonly bias: Float64Array;
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
