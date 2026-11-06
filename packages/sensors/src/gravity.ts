// WGS84 normal gravity (TASK-148): the gravity of the WGS84 level ellipsoid, after NIMA TR8350.2
// (3rd edition, amendment 1, 2000). On the ellipsoid it is Somigliana's closed formula
// (equation 4-1); above or below it, the closed form in ellipsoidal-harmonic coordinates
// (equations 4-4 to 4-7), which is exact for the normal field at any height. The second-order
// series of equation 4-3 is not used: its free-air gradient is 3.5e-5 too small at the
// equator, which is already 1e-8 relative at 1 km (TASK-148 evidence).
// Normal gravity has no anomalies or deflection of the vertical (TASK-108's anomaly fields,
// deferred in Phase 1). Sessions take its magnitude along the local down axis; its component
// along the reduced latitude, which tilts it from the ellipsoid normal, is returned apart.

/** WGS84 defining and derived gravity constants, TR8350.2 Tables 3.1 and 3.4. */
export const WGS84_GRAVITY = Object.freeze({
  semiMajorAxisM: 6378137,
  flattening: 1 / 298.257223563,
  /** GM including the atmosphere, m³/s². */
  gravitationalConstantM3S2: 3.986004418e14,
  angularVelocityRadS: 7.292115e-5,
  /** Normal gravity at the equator and the poles, m/s² (Table 3.4). */
  gammaEquatorMps2: 9.7803253359,
  gammaPoleMps2: 9.8321849378,
  /** Somigliana's constant k = b·gamma_p / (a·gamma_e) − 1. */
  somiglianaK: 0.00193185265241,
  eccentricitySquared: 6.69437999014e-3,
});
/** Heights accepted, metres above the ellipsoid (declared envelope). */
export const NORMAL_GRAVITY_HEIGHT_RANGE_M = Object.freeze({ min: -1000, max: 20000 });

const A = WGS84_GRAVITY.semiMajorAxisM, B = A * (1 - WGS84_GRAVITY.flattening);
const E = Math.sqrt(A * A - B * B), GM = WGS84_GRAVITY.gravitationalConstantM3S2, OMEGA2 = WGS84_GRAVITY.angularVelocityRadS ** 2;
const E2 = (A * A - B * B) / (A * A);
/** q(u) of the ellipsoidal harmonics, TR8350.2 equation 4-6; q0 = q(b). */
function q(u: number): number { return 0.5 * ((1 + 3 * u * u / (E * E)) * Math.atan(E / u) - 3 * u / E); }
const Q0 = q(B);

function checkLatitude(latitudeRad: number): void {
  if (!Number.isFinite(latitudeRad) || Math.abs(latitudeRad) > Math.PI / 2 + 1e-12) throw new Error('Latitude must be within ±90 degrees');
}

/** gamma(phi) = gamma_e (1 + k sin²phi) / sqrt(1 − e² sin²phi), m/s², at geodetic latitude phi (rad). */
export function surfaceNormalGravityMps2(latitudeRad: number): number {
  checkLatitude(latitudeRad);
  const g = WGS84_GRAVITY, s2 = Math.sin(latitudeRad) ** 2;
  return g.gammaEquatorMps2 * (1 + g.somiglianaK * s2) / Math.sqrt(1 - g.eccentricitySquared * s2);
}

/** Components of normal gravity in ellipsoidal-harmonic coordinates, m/s² (TR8350.2 equations 4-4, 4-5). */
export interface NormalGravity {
  /** Magnitude, m/s². */
  magnitudeMps2: number;
  /** Component along the ellipsoidal coordinate u (inward, negative), m/s². */
  uMps2: number;
  /** Component along the reduced latitude beta, m/s². */
  betaMps2: number;
}

/** Normal gravity at geodetic latitude (rad) and ellipsoidal height (m), closed form. */
export function normalGravity(latitudeRad: number, ellipsoidalHeightM: number): NormalGravity {
  checkLatitude(latitudeRad);
  const range = NORMAL_GRAVITY_HEIGHT_RANGE_M;
  if (!Number.isFinite(ellipsoidalHeightM) || ellipsoidalHeightM < range.min || ellipsoidalHeightM > range.max) {
    throw new Error(`Ellipsoidal height must be within ${range.min} to ${range.max} m`);
  }
  const s = Math.sin(latitudeRad), c = Math.cos(latitudeRad), n = A / Math.sqrt(1 - E2 * s * s), h = ellipsoidalHeightM;
  const p = (n + h) * c, z = (n * (1 - E2) + h) * s, r2 = p * p + z * z, d = r2 - E * E;
  // u² (TR8350.2 equation 4-7), in a form that stays accurate when z = 0.
  const u2 = 0.5 * d * (1 + Math.sqrt(1 + 4 * E * E * z * z / (d * d)));
  const u = Math.sqrt(u2), beta = Math.atan2(z * Math.sqrt(u2 + E * E), u * p);
  const sb = Math.sin(beta), cb = Math.cos(beta), w = Math.sqrt((u2 + E * E * sb * sb) / (u2 + E * E));
  const qPrime = 3 * (1 + u2 / (E * E)) * (1 - (u / E) * Math.atan(E / u)) - 1;
  const gu = -(GM / (u2 + E * E) + OMEGA2 * A * A * E / (u2 + E * E) * (qPrime / Q0) * (0.5 * sb * sb - 1 / 6) - OMEGA2 * u * cb * cb) / w;
  const gb = -(-OMEGA2 * A * A / Math.sqrt(u2 + E * E) * (q(u) / Q0) + OMEGA2 * Math.sqrt(u2 + E * E)) * sb * cb / w;
  return { magnitudeMps2: Math.sqrt(gu * gu + gb * gb), uMps2: gu, betaMps2: gb };
}

/** |normal gravity| at geodetic latitude (rad) and ellipsoidal height (m), m/s²; Somigliana on the ellipsoid. */
export function normalGravityMps2(latitudeRad: number, ellipsoidalHeightM: number): number {
  return ellipsoidalHeightM === 0 ? surfaceNormalGravityMps2(latitudeRad) : normalGravity(latitudeRad, ellipsoidalHeightM).magnitudeMps2;
}
