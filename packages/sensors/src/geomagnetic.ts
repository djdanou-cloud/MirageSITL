// World Magnetic Model main field (TASK-148), after "The US/UK World Magnetic Model for
// 2025-2030: Technical Report" (NOAA NCEI and BGS). Inputs are geodetic: WGS84 latitude and
// longitude, height above the ellipsoid and a decimal year. The geodetic point is converted
// to geocentric spherical coordinates, the degree-12 spherical-harmonic expansion with
// Schmidt semi-normalized associated Legendre functions gives the field, and the result is
// rotated back to the geodetic north-east-down frame. Secular variation is linear in time.
// This is the main (core) field only: crustal anomalies, external fields and vehicle
// interference are not modeled (TASK-108, deferred in Phase 1).

/** SHA-256 of data/geomagnetic/WMM_2025.COF, the coefficient file this module is checked against. */
export const WMM2025_SHA256 = 'dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f';

/** Slots of the `fieldInto` output. Field in nT, angles in rad, rates per year. */
export const FIELD = Object.freeze({
  northNt: 0, eastNt: 1, downNt: 2, horizontalNt: 3, totalNt: 4, declinationRad: 5, inclinationRad: 6,
  northRateNtPerYear: 7, eastRateNtPerYear: 8, downRateNtPerYear: 9, horizontalRateNtPerYear: 10, totalRateNtPerYear: 11,
  declinationRateRadPerYear: 12, inclinationRateRadPerYear: 13,
  count: 14,
});

/** Coefficients of one WMM release, indexed [n * (maxDegree + 1) + m]. */
export interface WmmCoefficients {
  readonly name: string;
  /** Model epoch, decimal year; the model is valid from it for five years. */
  readonly epoch: number;
  readonly releaseDate: string;
  readonly maxDegree: number;
  readonly g: Float64Array;
  readonly h: Float64Array;
  readonly gRate: Float64Array;
  readonly hRate: Float64Array;
}

const MAX_DEGREE = 12, SIZE = (MAX_DEGREE + 1) * (MAX_DEGREE + 1);
/** Geomagnetic reference radius, m (technical report, section 1.2). */
const REFERENCE_RADIUS_M = 6371200;
/** WGS84 semi-major axis and first eccentricity squared. */
const WGS84_A_M = 6378137, WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
/** Declared envelope: the five-year validity and the technical report's heights, −1 km to 850 km. */
export const WMM_ENVELOPE = Object.freeze({ years: 5, minHeightM: -1000, maxHeightM: 850000 });

/**
 * Parses a WMM .COF file: a header line `epoch name date`, then one line `n m g h gdot hdot`
 * for every n = 1..12 and m = 0..n in order, then the 9s terminator. Anything else throws.
 */
export function parseWmmCoefficients(text: string): WmmCoefficients {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '');
  const header = lines[0]?.split(/\s+/) ?? [];
  if (header.length !== 3 || header[1] !== 'WMM-2025' || !/^\d{2}\/\d{2}\/\d{4}$/.test(header[2] ?? '')) throw new Error('Not a WMM2025 coefficient file');
  const epoch = Number(header[0]);
  if (epoch !== 2025) throw new Error('Unexpected WMM epoch');
  const g = new Float64Array(SIZE), h = new Float64Array(SIZE), gRate = new Float64Array(SIZE), hRate = new Float64Array(SIZE);
  let index = 1;
  for (let n = 1; n <= MAX_DEGREE; n++) for (let m = 0; m <= n; m++, index++) {
    const fields = lines[index]?.split(/\s+/) ?? [];
    const values = fields.map(Number);
    if (fields.length !== 6 || values[0] !== n || values[1] !== m || !values.every(Number.isFinite)) throw new Error(`Malformed WMM coefficient row for n=${n}, m=${m}`);
    const k = n * (MAX_DEGREE + 1) + m;
    // Six numeric fields are present (checked above).
    g[k] = values[2]!; h[k] = values[3]!; gRate[k] = values[4]!; hRate[k] = values[5]!;
    if (m === 0 && (h[k] !== 0 || hRate[k] !== 0)) throw new Error('WMM h coefficients of order 0 must be zero');
  }
  const rest = lines.slice(index);
  if (rest.length !== 2 || !rest.every(line => /^9{20,}$/.test(line))) throw new Error('Missing or extra lines after the WMM coefficients');
  return Object.freeze({ name: 'WMM-2025', epoch, releaseDate: header[2] ?? '', maxDegree: MAX_DEGREE, g, h, gRate, hRate });
}

/** Evaluates one WMM release. Construction allocates; `fieldInto` reuses preallocated scratch. */
export class WorldMagneticModel {
  readonly coefficients: WmmCoefficients;
  private readonly p = new Float64Array(SIZE);
  private readonly dp = new Float64Array(SIZE);
  private readonly schmidt = new Float64Array(SIZE);
  private readonly k = new Float64Array(SIZE);
  private readonly cosM = new Float64Array(MAX_DEGREE + 1);
  private readonly sinM = new Float64Array(MAX_DEGREE + 1);

  constructor(coefficients: WmmCoefficients) {
    if (coefficients.maxDegree !== MAX_DEGREE || coefficients.g.length !== SIZE) throw new Error('Unsupported WMM degree');
    this.coefficients = coefficients;
    const s = this.schmidt, k = this.k, w = MAX_DEGREE + 1;
    // Schmidt semi-normalization factors relative to Gauss-normalized functions, and the
    // recursion constants K(n, m) = ((n−1)² − m²) / ((2n−1)(2n−3)).
    s[0] = 1;
    for (let n = 1; n <= MAX_DEGREE; n++) {
      s[n * w] = s[(n - 1) * w]! * (2 * n - 1) / n;
      for (let m = 1; m <= n; m++) s[n * w + m] = s[n * w + m - 1]! * Math.sqrt((n - m + 1) * (m === 1 ? 2 : 1) / (n + m));
      for (let m = 0; m <= n; m++) k[n * w + m] = n > 1 ? ((n - 1) ** 2 - m * m) / ((2 * n - 1) * (2 * n - 3)) : 0;
    }
  }

  /**
   * Field at geodetic latitude and longitude (rad), height above the WGS84 ellipsoid (m) and
   * decimal year, into `out` (the FIELD slots): north, east and down components, horizontal
   * intensity, total intensity, declination and inclination, and their yearly rates.
   */
  fieldInto(latitudeRad: number, longitudeRad: number, heightM: number, decimalYear: number, out: Float64Array): void {
    const c = this.coefficients, env = WMM_ENVELOPE;
    if (out.length < FIELD.count) throw new Error('Field output needs FIELD.count slots');
    if (!Number.isFinite(latitudeRad) || !Number.isFinite(longitudeRad) || !Number.isFinite(heightM) || !Number.isFinite(decimalYear)) throw new Error('Non-finite WMM input');
    if (decimalYear < c.epoch || decimalYear > c.epoch + env.years) throw new Error(`WMM2025 is valid from ${c.epoch} to ${c.epoch + env.years}`);
    if (heightM < env.minHeightM || heightM > env.maxHeightM) throw new Error('Height outside the WMM envelope (−1 km to 850 km)');
    // Off the geographic poles, where the east component's 1/cos(latitude) is singular.
    if (Math.abs(latitudeRad) > Math.PI / 2 - 1e-9) throw new Error('Latitude must be off the geographic poles');
    // Geodetic to geocentric spherical (technical report equation 7).
    const sinLat = Math.sin(latitudeRad), cosLat = Math.cos(latitudeRad);
    const rc = WGS84_A_M / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const px = (rc + heightM) * cosLat, pz = (rc * (1 - WGS84_E2) + heightM) * sinLat;
    const r = Math.sqrt(px * px + pz * pz), latC = Math.asin(pz / r);
    const cosT = Math.sin(latC), sinT = Math.cos(latC); // colatitude theta = pi/2 − geocentric latitude
    const w = MAX_DEGREE + 1, p = this.p, dp = this.dp, k = this.k, s = this.schmidt;
    // Gauss-normalized associated Legendre functions of cos(theta) and their theta derivatives.
    p[0] = 1; dp[0] = 0;
    for (let n = 1; n <= MAX_DEGREE; n++) for (let m = 0; m <= n; m++) {
      const at = n * w + m;
      if (n === m) {
        const prev = (n - 1) * w + m - 1;
        p[at] = sinT * p[prev]!; dp[at] = sinT * dp[prev]! + cosT * p[prev]!;
      } else {
        const one = (n - 1) * w + m, two = n > 1 ? (n - 2) * w + m : 0, kk = k[at]!;
        p[at] = cosT * p[one]! - (n > 1 && m <= n - 2 ? kk * p[two]! : 0);
        dp[at] = cosT * dp[one]! - sinT * p[one]! - (n > 1 && m <= n - 2 ? kk * dp[two]! : 0);
      }
    }
    for (let m = 0; m <= MAX_DEGREE; m++) { this.cosM[m] = Math.cos(m * longitudeRad); this.sinM[m] = Math.sin(m * longitudeRad); }
    const t = decimalYear - c.epoch, ratio = REFERENCE_RADIUS_M / r;
    let north = 0, east = 0, down = 0, northRate = 0, eastRate = 0, downRate = 0;
    let power = ratio * ratio; // (a/r)^(n+2), starting at n = 0
    for (let n = 1; n <= MAX_DEGREE; n++) {
      power *= ratio;
      for (let m = 0; m <= n; m++) {
        const at = n * w + m, schmidtP = s[at]! * p[at]!, schmidtDp = s[at]! * dp[at]!;
        const cm = this.cosM[m]!, sm = this.sinM[m]!;
        const gnm = c.g[at]! + t * c.gRate[at]!, hnm = c.h[at]! + t * c.hRate[at]!;
        const gd = c.gRate[at]!, hd = c.hRate[at]!;
        const along = gnm * cm + hnm * sm, across = m * (gnm * sm - hnm * cm);
        const alongRate = gd * cm + hd * sm, acrossRate = m * (gd * sm - hd * cm);
        // North X' = −B_theta = (1/r) dV/dtheta, east Y' = B_phi = −(1/(r sin theta)) dV/dlambda and
        // down Z' = −B_r = dV/dr, for V = a sum (a/r)^(n+1) sum (g cos m lambda + h sin m lambda) P(n, m) (report equation 10).
        north += power * along * schmidtDp; east += power * across * schmidtP; down -= (n + 1) * power * along * schmidtP;
        northRate += power * alongRate * schmidtDp; eastRate += power * acrossRate * schmidtP; downRate -= (n + 1) * power * alongRate * schmidtP;
      }
    }
    const xC = north, yC = east / sinT, zC = down, xR = northRate, yR = eastRate / sinT, zR = downRate;
    // Rotate from geocentric to geodetic by the latitude difference (report equation 17).
    const d = latC - latitudeRad, cd = Math.cos(d), sd = Math.sin(d);
    const x = xC * cd - zC * sd, y = yC, z = xC * sd + zC * cd;
    const xDot = xR * cd - zR * sd, yDot = yR, zDot = xR * sd + zR * cd;
    const hH = Math.sqrt(x * x + y * y), f = Math.sqrt(hH * hH + z * z);
    out[FIELD.northNt] = x; out[FIELD.eastNt] = y; out[FIELD.downNt] = z; out[FIELD.horizontalNt] = hH; out[FIELD.totalNt] = f;
    out[FIELD.declinationRad] = Math.atan2(y, x); out[FIELD.inclinationRad] = Math.atan2(z, hH);
    const hDot = (x * xDot + y * yDot) / hH;
    out[FIELD.northRateNtPerYear] = xDot; out[FIELD.eastRateNtPerYear] = yDot; out[FIELD.downRateNtPerYear] = zDot;
    out[FIELD.horizontalRateNtPerYear] = hDot; out[FIELD.totalRateNtPerYear] = (x * xDot + y * yDot + z * zDot) / f;
    out[FIELD.declinationRateRadPerYear] = (x * yDot - y * xDot) / (hH * hH);
    out[FIELD.inclinationRateRadPerYear] = (hH * zDot - z * hDot) / (f * f);
  }
}
