// WGS84 geodesy (TASK-036), docs/SPECS_SIMULATION_ENGINES.md section 5.
//
// float64 conversions between geodetic (latitude, longitude, ellipsoidal
// height h), ECEF, and a local NED tangent frame frozen at an origin. Offsets
// go through ECEF, so nothing divides by cos(latitude): poles and the
// antimeridian need no special cases. Ellipsoidal h is not MSL height; see
// geoid.ts for H = h - N. All *Into functions write caller-owned outputs and
// allocate nothing.

/** WGS84 semi-major axis, m (NIMA TR8350.2). */
export const WGS84_A_M = 6378137;
/** WGS84 flattening (NIMA TR8350.2). */
export const WGS84_F = 1 / 298.257223563;
/** First eccentricity squared. */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
/** Semi-minor axis, m. */
export const WGS84_B_M = WGS84_A_M * (1 - WGS84_F);
/** Second eccentricity squared. */
const EP2 = WGS84_E2 / (1 - WGS84_E2);
const HALF_PI = Math.PI / 2;

/** Wraps longitude into [-pi, pi). */
export function wrapLongitudeRad(lon: number): number {
  const twoPi = 2 * Math.PI;
  const wrapped = lon - twoPi * Math.floor((lon + Math.PI) / twoPi);
  return wrapped >= Math.PI ? wrapped - twoPi : wrapped;
}

/** Prime-vertical radius of curvature N(lat), m. */
export function primeVerticalRadiusM(latRad: number): number {
  const s = Math.sin(latRad);
  return WGS84_A_M / Math.sqrt(1 - WGS84_E2 * s * s);
}

/** Writes ECEF [x, y, z] in metres. */
export function geodeticToEcefInto(latRad: number, lonRad: number, heightM: number, out: Float64Array): void {
  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const n = WGS84_A_M / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  out[0] = (n + heightM) * cosLat * Math.cos(lonRad);
  out[1] = (n + heightM) * cosLat * Math.sin(lonRad);
  out[2] = (n * (1 - WGS84_E2) + heightM) * sinLat;
}

/**
 * Writes geodetic [latRad, lonRad, heightM] for ECEF metres. Bowring's
 * parametric start with two refinements, then the height formula
 * h = p cos(lat) + z sin(lat) - a sqrt(1 - e2 sin^2 lat), which stays
 * well-conditioned at the poles (no division by cos(lat)). Converges to
 * float64 resolution for |h| up to tens of kilometres. On the polar axis
 * the longitude is undefined and reported as 0.
 */
export function ecefToGeodeticInto(x: number, y: number, z: number, out: Float64Array): void {
  const p = Math.sqrt(x * x + y * y);
  const lon = p > 0 ? Math.atan2(y, x) : 0;
  let lat: number;
  if (p === 0) {
    lat = z >= 0 ? HALF_PI : -HALF_PI;
  } else {
    // Parametric latitude start (Bowring 1976), then fixed-point refinement.
    let beta = Math.atan2(z * WGS84_A_M, p * WGS84_B_M);
    lat = 0;
    for (let i = 0; i < 3; i++) {
      const sb = Math.sin(beta), cb = Math.cos(beta);
      lat = Math.atan2(z + EP2 * WGS84_B_M * sb * sb * sb, p - WGS84_E2 * WGS84_A_M * cb * cb * cb);
      beta = Math.atan2((1 - WGS84_F) * Math.sin(lat), Math.cos(lat));
    }
  }
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  out[0] = lat;
  out[1] = lon;
  out[2] = p * cosLat + z * sinLat - WGS84_A_M * Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
}

/**
 * Local north-east-down tangent frame frozen at a geodetic origin. The
 * origin ECEF position and the ECEF-to-NED rotation are computed once.
 */
export class LocalTangentFrame {
  /** Origin ECEF, m. */
  readonly originEcefM = new Float64Array(3);
  /** Row-major ECEF-to-NED rotation; rows are north, east, down unit vectors in ECEF. */
  readonly ecefToNed = new Float64Array(9);
  private readonly scratch = new Float64Array(3);
  private latRad = 0;
  private lonRad = 0;
  private heightM = 0;

  constructor(originLatRad: number, originLonRad: number, originHeightM: number) {
    if (!this.setOrigin(originLatRad, originLonRad, originHeightM)) throw new Error("Invalid tangent-frame origin");
  }

  get originLatRad(): number { return this.latRad; }
  get originLonRad(): number { return this.lonRad; }
  get originHeightM(): number { return this.heightM; }

  /**
   * Re-origins the frame in place (allocation-free, for per-sample use).
   * Returns false and keeps the previous origin for an invalid input.
   */
  setOrigin(originLatRad: number, originLonRad: number, originHeightM: number): boolean {
    if (!(Math.abs(originLatRad) <= HALF_PI) || !Number.isFinite(originLonRad) || !(Math.abs(originHeightM) <= 100_000)) {
      return false;
    }
    this.latRad = originLatRad;
    this.lonRad = wrapLongitudeRad(originLonRad);
    this.heightM = originHeightM;
    geodeticToEcefInto(originLatRad, this.lonRad, originHeightM, this.originEcefM);
    const sLat = Math.sin(originLatRad), cLat = Math.cos(originLatRad);
    const sLon = Math.sin(this.lonRad), cLon = Math.cos(this.lonRad);
    const r = this.ecefToNed;
    r[0] = -sLat * cLon; r[1] = -sLat * sLon; r[2] = cLat; // north
    r[3] = -sLon; r[4] = cLon; r[5] = 0; // east
    r[6] = -cLat * cLon; r[7] = -cLat * sLon; r[8] = -sLat; // down
    return true;
  }

  /** NED offset (m) of an ECEF point from the origin. */
  ecefToNedInto(x: number, y: number, z: number, out: Float64Array): void {
    const o = this.originEcefM, r = this.ecefToNed;
    const dx = x - o[0]!, dy = y - o[1]!, dz = z - o[2]!; // indices 0..2 exist: fixed length-3 arrays
    out[0] = r[0]! * dx + r[1]! * dy + r[2]! * dz;
    out[1] = r[3]! * dx + r[4]! * dy + r[5]! * dz;
    out[2] = r[6]! * dx + r[7]! * dy + r[8]! * dz;
  }

  /** ECEF (m) of a NED offset from the origin (transpose rotation). */
  nedToEcefInto(northM: number, eastM: number, downM: number, out: Float64Array): void {
    const o = this.originEcefM, r = this.ecefToNed;
    out[0] = o[0]! + r[0]! * northM + r[3]! * eastM + r[6]! * downM;
    out[1] = o[1]! + r[1]! * northM + r[4]! * eastM + r[7]! * downM;
    out[2] = o[2]! + r[2]! * northM + r[5]! * eastM + r[8]! * downM;
  }

  /** Geodetic [latRad, lonRad in [-pi, pi), ellipsoidal heightM] of a NED offset. */
  nedToGeodeticInto(northM: number, eastM: number, downM: number, out: Float64Array): void {
    const e = this.scratch;
    this.nedToEcefInto(northM, eastM, downM, e);
    ecefToGeodeticInto(e[0]!, e[1]!, e[2]!, out);
    out[1] = wrapLongitudeRad(out[1]!);
  }

  /** NED offset (m) of a geodetic point. */
  geodeticToNedInto(latRad: number, lonRad: number, heightM: number, out: Float64Array): void {
    const e = this.scratch;
    geodeticToEcefInto(latRad, lonRad, heightM, e);
    this.ecefToNedInto(e[0]!, e[1]!, e[2]!, out);
  }
}
