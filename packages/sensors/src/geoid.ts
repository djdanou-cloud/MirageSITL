// Geoid undulation and MSL height (TASK-036). MSL height H = h - N, where h is
// WGS84 ellipsoidal height and N the geoid undulation. N comes only from an
// authoritative grid with a recorded source, license, and SHA-256; without
// one, MSL values are provisional (N = 0) and the absolute-MSL accuracy gate
// reports BLOCKED_EXTERNAL instead of passing.

/** Provenance a geoid grid must carry before it can satisfy the accuracy gate. */
export interface GeoidProvenance {
  /** Model identifier, e.g. "EGM2008-2.5min". */
  model: string;
  /** Distribution source (URL or document reference). */
  source: string;
  license: string;
  /** SHA-256 of the exact grid payload as distributed. */
  sha256: string;
}

/**
 * Regular latitude/longitude grid of undulations in metres, row-major from
 * `latStartDeg` (north-most row first when `latStepDeg` < 0) and longitudes
 * from `lonStartDeg` eastward by `lonStepDeg`, covering 360 degrees.
 */
export interface GeoidGridSpec {
  latStartDeg: number;
  latStepDeg: number;
  latCount: number;
  lonStartDeg: number;
  lonStepDeg: number;
  lonCount: number;
  undulationM: Float64Array;
  provenance: GeoidProvenance;
}

export interface GeoidModel {
  readonly provenance: GeoidProvenance | null;
  /** Undulation N in metres at a geodetic position. */
  undulationM(latRad: number, lonRad: number): number;
}

const DEG = 180 / Math.PI;

/** Bilinear grid geoid; longitude wraps, latitude clamps to the grid rows. */
export class GridGeoid implements GeoidModel {
  readonly provenance: GeoidProvenance;
  private readonly spec: GeoidGridSpec;

  constructor(spec: GeoidGridSpec) {
    const { latStartDeg, latStepDeg, latCount, lonStartDeg, lonStepDeg, lonCount, undulationM, provenance } = spec;
    const latEnd = latStartDeg + latStepDeg * (latCount - 1);
    if (!Number.isInteger(latCount) || !Number.isInteger(lonCount) || latCount < 2 || lonCount < 2 ||
      ![latStartDeg, latStepDeg, lonStartDeg, lonStepDeg].every(Number.isFinite) || latStepDeg === 0 || lonStepDeg <= 0 ||
      Math.abs(latStartDeg) > 90 || Math.abs(latEnd) > 90 || Math.abs(lonStepDeg * lonCount - 360) > 1e-9 ||
      undulationM.length !== latCount * lonCount || !undulationM.every(v => Number.isFinite(v) && Math.abs(v) < 200)) {
      throw new Error("Invalid geoid grid");
    }
    if (!/^[0-9a-f]{64}$/.test(provenance.sha256) || !provenance.model || !provenance.source || !provenance.license) {
      throw new Error("Geoid grid provenance must name model, source, license, and SHA-256");
    }
    this.spec = spec;
    this.provenance = provenance;
  }

  undulationM(latRad: number, lonRad: number): number {
    const s = this.spec;
    const latDeg = latRad * DEG, lonDeg = lonRad * DEG;
    let row = (latDeg - s.latStartDeg) / s.latStepDeg;
    row = row < 0 ? 0 : row > s.latCount - 1 ? s.latCount - 1 : row;
    let col = (lonDeg - s.lonStartDeg) / s.lonStepDeg;
    col -= s.lonCount * Math.floor(col / s.lonCount); // wrap into [0, lonCount)
    const r0 = Math.min(Math.floor(row), s.latCount - 2), c0 = Math.floor(col) % s.lonCount;
    const r1 = r0 + 1, c1 = (c0 + 1) % s.lonCount;
    const tr = row - r0, tc = col - Math.floor(col);
    // In range by construction: 0 <= r0 < r1 <= latCount - 1 and 0 <= c0, c1 < lonCount, and the
    // constructor checked undulationM.length === latCount * lonCount. A `?? NaN` fallback would
    // widen the loads to tagged values and box a HeapNumber per read (see arena.ts).
    const v = s.undulationM, n = s.lonCount;
    const v00 = v[r0 * n + c0] as number, v01 = v[r0 * n + c1] as number;
    const v10 = v[r1 * n + c0] as number, v11 = v[r1 * n + c1] as number;
    const top = v00 + tc * (v01 - v00);
    const bottom = v10 + tc * (v11 - v10);
    return top + tr * (bottom - top);
  }
}

/** No authoritative geoid available: N = 0, and MSL accuracy is not established. */
export const NO_GEOID: GeoidModel = { provenance: null, undulationM: () => 0 };

/** MSL height H = h - N (m). */
export function mslHeightM(geoid: GeoidModel, latRad: number, lonRad: number, ellipsoidalHeightM: number): number {
  return ellipsoidalHeightM - geoid.undulationM(latRad, lonRad);
}
/** Ellipsoidal height h = H + N (m). */
export function ellipsoidalHeightM(geoid: GeoidModel, latRad: number, lonRad: number, mslM: number): number {
  return mslM + geoid.undulationM(latRad, lonRad);
}

export type MslAccuracyGate =
  | { status: "AVAILABLE"; model: string; sha256: string }
  | { status: "BLOCKED_EXTERNAL"; reason: string };

/**
 * Absolute-MSL accuracy gate. Only a geoid with recorded provenance whose hash
 * matches the expected authoritative payload passes; anything else blocks.
 */
export function mslAccuracyGate(geoid: GeoidModel, expectedSha256?: string): MslAccuracyGate {
  const p = geoid.provenance;
  if (!p) {
    return { status: "BLOCKED_EXTERNAL", reason: "No authoritative geoid grid (source, license, SHA-256) is installed; MSL heights are provisional with N = 0" };
  }
  if (expectedSha256 !== undefined && p.sha256 !== expectedSha256) {
    return { status: "BLOCKED_EXTERNAL", reason: `Geoid ${p.model} hash ${p.sha256} does not match the pinned ${expectedSha256}` };
  }
  return { status: "AVAILABLE", model: p.model, sha256: p.sha256 };
}
