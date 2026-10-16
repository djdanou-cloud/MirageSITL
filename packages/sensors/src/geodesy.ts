// WGS84 geodesy (TASK-036), docs/SPECS_SIMULATION_ENGINES.md section 5.
//
// float64 conversions between geodetic (latitude, longitude, ellipsoidal
// height h), ECEF, and a local NED tangent frame frozen at an origin. Offsets
// go through ECEF, so nothing divides by cos(latitude): poles and the
// antimeridian need no special cases. Ellipsoidal h is not MSL height; see
// geoid.ts for H = h - N. All *Into functions write caller-owned outputs.
// High-rate callers use the *FromInto forms, which take Float64Array inputs:
// V8 boxes float arguments of non-inlined calls into HeapNumbers, so the scalar
// signatures are low-rate conveniences only.

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

/** Writes ECEF [x, y, z] (m) for geodetic [latRad, lonRad, heightM]. Allocation-free. */
export function geodeticToEcefFromInto(geodetic: Float64Array, out: Float64Array): void {
  const latRad = geodetic[0]!, lonRad = geodetic[1]!, heightM = geodetic[2]!; // length >= 3 by contract
  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const n = WGS84_A_M / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  out[0] = (n + heightM) * cosLat * Math.cos(lonRad);
  out[1] = (n + heightM) * cosLat * Math.sin(lonRad);
  out[2] = (n * (1 - WGS84_E2) + heightM) * sinLat;
}

/**
 * Writes geodetic [latRad, lonRad, heightM] for ECEF [x, y, z] (m). Bowring's
 * parametric start with three refinements, then the height formula
 * h = p cos(lat) + z sin(lat) - a sqrt(1 - e2 sin^2 lat), which stays
 * well-conditioned at the poles (no division by cos(lat)). Converges to
 * float64 resolution for |h| up to tens of kilometres. On the polar axis the
 * longitude is undefined and reported as 0. Longitude is in (-pi, pi].
 * `ecef` and `out` may be the same array. Allocation-free.
 */
export function ecefToGeodeticFromInto(ecef: Float64Array, out: Float64Array): void {
  const x = ecef[0]!, y = ecef[1]!, z = ecef[2]!; // length >= 3 by contract
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

const scalarInput = new Float64Array(3);
/** Scalar convenience for geodeticToEcefFromInto (low rate: arguments may be boxed). */
export function geodeticToEcefInto(latRad: number, lonRad: number, heightM: number, out: Float64Array): void {
  scalarInput[0] = latRad; scalarInput[1] = lonRad; scalarInput[2] = heightM;
  geodeticToEcefFromInto(scalarInput, out);
}
/** Scalar convenience for ecefToGeodeticFromInto (low rate: arguments may be boxed). */
export function ecefToGeodeticInto(x: number, y: number, z: number, out: Float64Array): void {
  scalarInput[0] = x; scalarInput[1] = y; scalarInput[2] = z;
  ecefToGeodeticFromInto(scalarInput, out);
}

/**
 * Local north-east-down tangent frame at a geodetic origin. The origin ECEF
 * position and the ECEF-to-NED rotation are computed when the origin is set;
 * setOriginFrom re-origins in place for per-sample use.
 */
export class LocalTangentFrame {
  /** Origin ECEF, m. */
  readonly originEcefM = new Float64Array(3);
  /** Row-major ECEF-to-NED rotation; rows are north, east, down unit vectors in ECEF. */
  readonly ecefToNed = new Float64Array(9);
  /** Origin [latRad, lonRad in [-pi, pi), heightM]. */
  readonly originGeodetic = new Float64Array(3);
  private readonly scratch = new Float64Array(3);
  private readonly input = new Float64Array(3);

  constructor(originLatRad: number, originLonRad: number, originHeightM: number) {
    if (!this.setOrigin(originLatRad, originLonRad, originHeightM)) throw new Error("Invalid tangent-frame origin");
  }

  get originLatRad(): number { return this.originGeodetic[0]!; }
  get originLonRad(): number { return this.originGeodetic[1]!; }
  get originHeightM(): number { return this.originGeodetic[2]!; }

  /**
   * Re-origins the frame in place from [latRad, lonRad, heightM]. Returns
   * false and keeps the previous origin for an invalid input. Allocation-free.
   */
  setOriginFrom(geodetic: Float64Array): boolean {
    const lat = geodetic[0]!, rawLon = geodetic[1]!, height = geodetic[2]!; // length >= 3 by contract
    if (!(Math.abs(lat) <= HALF_PI) || !Number.isFinite(rawLon) || !(Math.abs(height) <= 100_000)) return false;
    // Inline wrap into [-pi, pi) (a double-returning call could box a HeapNumber).
    let lon = rawLon - 2 * Math.PI * Math.floor((rawLon + Math.PI) / (2 * Math.PI));
    if (lon >= Math.PI) lon -= 2 * Math.PI;
    const g = this.originGeodetic;
    g[0] = lat; g[1] = lon; g[2] = height;
    geodeticToEcefFromInto(g, this.originEcefM);
    const sLat = Math.sin(lat), cLat = Math.cos(lat), sLon = Math.sin(lon), cLon = Math.cos(lon);
    const r = this.ecefToNed;
    r[0] = -sLat * cLon; r[1] = -sLat * sLon; r[2] = cLat; // north
    r[3] = -sLon; r[4] = cLon; r[5] = 0; // east
    r[6] = -cLat * cLon; r[7] = -cLat * sLon; r[8] = -sLat; // down
    return true;
  }
  /** Scalar convenience for setOriginFrom. */
  setOrigin(originLatRad: number, originLonRad: number, originHeightM: number): boolean {
    const i = this.input;
    i[0] = originLatRad; i[1] = originLonRad; i[2] = originHeightM;
    return this.setOriginFrom(i);
  }

  /** NED offset (m) of an ECEF point [x, y, z] from the origin. */
  ecefToNedFromInto(ecef: Float64Array, out: Float64Array): void {
    const o = this.originEcefM, r = this.ecefToNed; // fixed length-3/9 arrays
    const dx = ecef[0]! - o[0]!, dy = ecef[1]! - o[1]!, dz = ecef[2]! - o[2]!;
    out[0] = r[0]! * dx + r[1]! * dy + r[2]! * dz;
    out[1] = r[3]! * dx + r[4]! * dy + r[5]! * dz;
    out[2] = r[6]! * dx + r[7]! * dy + r[8]! * dz;
  }

  /** ECEF (m) of a NED offset [n, e, d] from the origin (transpose rotation). `ned` and `out` must differ. */
  nedToEcefFromInto(ned: Float64Array, out: Float64Array): void {
    const o = this.originEcefM, r = this.ecefToNed, n = ned[0]!, e = ned[1]!, d = ned[2]!;
    out[0] = o[0]! + r[0]! * n + r[3]! * e + r[6]! * d;
    out[1] = o[1]! + r[1]! * n + r[4]! * e + r[7]! * d;
    out[2] = o[2]! + r[2]! * n + r[5]! * e + r[8]! * d;
  }

  /** Geodetic [latRad, lonRad in [-pi, pi), ellipsoidal heightM] of a NED offset. Allocation-free. */
  nedToGeodeticFromInto(ned: Float64Array, out: Float64Array): void {
    const e = this.scratch;
    this.nedToEcefFromInto(ned, e);
    ecefToGeodeticFromInto(e, out);
    const lon = out[1]!; // atan2 range (-pi, pi]: only +pi needs wrapping
    if (lon >= Math.PI) out[1] = lon - 2 * Math.PI;
  }

  /** NED offset (m) of a geodetic point [latRad, lonRad, heightM]. Allocation-free. */
  geodeticToNedFromInto(geodetic: Float64Array, out: Float64Array): void {
    const e = this.scratch;
    geodeticToEcefFromInto(geodetic, e);
    this.ecefToNedFromInto(e, out);
  }

  /** Scalar conveniences (low rate). */
  ecefToNedInto(x: number, y: number, z: number, out: Float64Array): void {
    const i = this.input; i[0] = x; i[1] = y; i[2] = z;
    this.ecefToNedFromInto(i, out);
  }
  nedToEcefInto(northM: number, eastM: number, downM: number, out: Float64Array): void {
    const i = this.input; i[0] = northM; i[1] = eastM; i[2] = downM;
    this.nedToEcefFromInto(i, out);
  }
  nedToGeodeticInto(northM: number, eastM: number, downM: number, out: Float64Array): void {
    const i = this.input; i[0] = northM; i[1] = eastM; i[2] = downM;
    this.nedToGeodeticFromInto(i, out);
  }
  geodeticToNedInto(latRad: number, lonRad: number, heightM: number, out: Float64Array): void {
    const i = this.input; i[0] = latRad; i[1] = lonRad; i[2] = heightM;
    this.geodeticToNedFromInto(i, out);
  }
}
