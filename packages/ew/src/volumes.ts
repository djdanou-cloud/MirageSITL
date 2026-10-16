/** Dimensionless training exposure, never an RF link budget. Configuration is cold. */
export interface SphereVolume {
  readonly id: number;
  readonly shape: "sphere";
  readonly centerNedM: readonly [number, number, number];
  readonly radiusM: number;
  readonly power: number;
  readonly referenceM: number;
  readonly minimumM: number;
}
export interface ConeVolume extends Omit<SphereVolume, "shape"> {
  readonly shape: "cone";
  readonly axisNed: readonly [number, number, number];
  readonly halfAngleRad: number;
}
export type HazardVolume = SphereVolume | ConeVolume;
export class HazardVolumes {
  private readonly data: Float64Array;
  private readonly result = new Float64Array(1);
  private readonly position = new Float64Array(3);
  constructor(
    volumes: readonly HazardVolume[],
    private readonly onset: number,
    private readonly full: number,
  ) {
    if (
      volumes.length > 64 ||
      !Number.isFinite(onset) ||
      !Number.isFinite(full) ||
      onset < 0 ||
      full <= onset ||
      full > 1e12
    )
      throw new Error("Invalid exposure thresholds/capacity");
    this.data = new Float64Array(volumes.length * 12);
    const ordered = [...volumes].sort((a, b) => a.id - b.id);
    for (let i = 0; i < ordered.length; i++) {
      const v = ordered[i]!;
      if (
        !Number.isSafeInteger(v.id) ||
        v.id < 0 ||
        (i > 0 && ordered[i - 1]!.id === v.id) ||
        v.centerNedM.length !== 3 ||
        !v.centerNedM.every(Number.isFinite) ||
        !Number.isFinite(v.radiusM) ||
        v.radiusM <= 0 ||
        v.radiusM > 1e6 ||
        !Number.isFinite(v.power) ||
        v.power < 0 ||
        v.power > 1e6 ||
        !Number.isFinite(v.referenceM) ||
        v.referenceM <= 0 ||
        v.referenceM > 1e6 ||
        !Number.isFinite(v.minimumM) ||
        v.minimumM < 1e-6 ||
        v.minimumM > v.radiusM
      )
        throw new Error("Invalid hazard volume");
      const o = i * 12;
      this.data.set(v.centerNedM, o);
      this.data[o + 3] = v.radiusM * v.radiusM;
      this.data[o + 4] = v.power * v.referenceM * v.referenceM;
      this.data[o + 5] = v.minimumM * v.minimumM;
      if (v.shape === "cone") {
        if (
          v.axisNed.length !== 3 ||
          !v.axisNed.every(Number.isFinite) ||
          Math.abs(Math.hypot(...v.axisNed) - 1) > 1e-9 ||
          !Number.isFinite(v.halfAngleRad) ||
          v.halfAngleRad < 1e-6 ||
          v.halfAngleRad > Math.PI / 2
        )
          throw new Error("Invalid cone");
        this.data[o + 6] = 1;
        this.data.set(v.axisNed, o + 7);
        this.data[o + 10] = Math.cos(v.halfAngleRad);
      } else if (v.shape !== "sphere") throw new Error("Unknown volume shape");
    }
  }
  /** Low-rate convenience. Physics callers use severityInto to avoid boxed numeric returns. */
  severity(northM: number, eastM: number, downM: number): number {
    return this.severityInto(northM, eastM, downM, this.result)
      ? this.result[0]!
      : NaN;
  }
  severityInto(
    northM: number,
    eastM: number,
    downM: number,
    out: Float64Array,
  ): boolean {
    this.position[0] = northM;
    this.position[1] = eastM;
    this.position[2] = downM;
    return this.severityFromNedInto(this.position, out);
  }
  /** Hot boundary: dynamically computed positions stay in preallocated numeric storage. */
  severityFromNedInto(position: Float64Array, out: Float64Array): boolean {
    if (
      position.length !== 3 ||
      (position.buffer === out.buffer &&
        position.byteOffset < out.byteOffset + out.byteLength &&
        out.byteOffset < position.byteOffset + position.byteLength)
    )
      return false;
    const northM = position[0]!,
      eastM = position[1]!,
      downM = position[2]!;
    if (
      out.length !== 1 ||
      !Number.isFinite(northM) ||
      !Number.isFinite(eastM) ||
      !Number.isFinite(downM)
    )
      return false;
    let sum = 0;
    for (let o = 0; o < this.data.length; o += 12) {
      const n = northM - this.data[o]!,
        e = eastM - this.data[o + 1]!,
        d = downM - this.data[o + 2]!,
        r2 = n * n + e * e + d * d;
      if (r2 > this.data[o + 3]!) continue;
      let gain = 1;
      if (this.data[o + 6] === 1 && r2 > 0) {
        const cosine =
          (n * this.data[o + 7]! +
            e * this.data[o + 8]! +
            d * this.data[o + 9]!) /
          Math.sqrt(r2);
        const x = Math.max(
          0,
          Math.min(1, (cosine - this.data[o + 10]!) / (1 - this.data[o + 10]!)),
        );
        gain = x * x * (3 - 2 * x);
      }
      sum = Math.min(
        1e12,
        sum + (gain * this.data[o + 4]!) / Math.max(r2, this.data[o + 5]!),
      );
    }
    out[0] = Math.max(
      0,
      Math.min(1, (sum - this.onset) / (this.full - this.onset)),
    );
    return true;
  }
}
