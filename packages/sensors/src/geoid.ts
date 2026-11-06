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
  /** Writes N (m) at geodetic [latRad, lonRad, ...] into out[0]; allocation-free for per-sample callers. */
  undulationFromInto(geodetic: Float64Array, out: Float64Array): void;
}

const DEG = 180 / Math.PI;

/** Bilinear grid geoid; longitude wraps, latitude clamps to the grid rows. */
export class GridGeoid implements GeoidModel {
  readonly provenance: GeoidProvenance;
  private readonly spec: GeoidGridSpec;
  private readonly one = new Float64Array(1);
  private readonly input = new Float64Array(2);

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
    this.input[0] = latRad; this.input[1] = lonRad;
    this.undulationFromInto(this.input, this.one);
    return this.one[0] as number; // length 1
  }

  undulationFromInto(geodetic: Float64Array, out: Float64Array): void {
    const s = this.spec, latRad = geodetic[0] as number, lonRad = geodetic[1] as number; // length >= 2 by contract
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
    out[0] = top + tr * (bottom - top);
  }
}

/** No authoritative geoid available: N = 0, and MSL accuracy is not established. */
export const NO_GEOID: GeoidModel = { provenance: null, undulationM: () => 0, undulationFromInto: (_geodetic, out) => { out[0] = 0; } };

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

/** SHA-256 of data/geoid/WW15MGH.DAC, NGA's EGM96 15-minute grid as distributed (TASK-148). */
export const EGM96_15_SHA256 = "9dcaf4efd6857aaa2e1e2e2c574d3f5264eacf47024cdcd5291c40ddad5e5acc";
/** WW15MGH.DAC layout: 721 rows from 90 N to 90 S, 1440 columns from 0 E eastward, 15 minutes, big-endian int16 centimetres. */
export const EGM96_15_LAYOUT = Object.freeze({ rows: 721, columns: 1440, latitudeStartDeg: 90, stepDeg: 0.25, longitudeStartDeg: 0, bytes: 721 * 1440 * 2 });

/**
 * The EGM96 15-minute grid from NGA's WW15MGH.DAC bytes (TASK-148). The bytes must match the pinned
 * SHA-256 before they are decoded, so the absolute-MSL gate opens only for the authoritative payload.
 */
export async function loadEgm96Geoid(bytes: Uint8Array<ArrayBuffer>): Promise<GridGeoid> {
  const layout = EGM96_15_LAYOUT;
  if (bytes.byteLength !== layout.bytes) throw new Error(`WW15MGH.DAC must be ${layout.bytes} bytes`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
  if (sha256 !== EGM96_15_SHA256) throw new Error("WW15MGH.DAC does not match the pinned EGM96 SHA-256");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), undulationM = new Float64Array(layout.rows * layout.columns);
  for (let i = 0; i < undulationM.length; i++) undulationM[i] = view.getInt16(2 * i, false) / 100;
  return new GridGeoid({
    latStartDeg: layout.latitudeStartDeg, latStepDeg: -layout.stepDeg, latCount: layout.rows,
    lonStartDeg: layout.longitudeStartDeg, lonStepDeg: layout.stepDeg, lonCount: layout.columns, undulationM,
    provenance: { model: "EGM96-15min", source: "US National Geospatial-Intelligence Agency, WW15MGH.DAC (data/geoid/inventory.json)",
      license: "Public domain (United States Government work)", sha256 },
  });
}
