import { describe, expect, it } from 'vitest';
import { normalGravityMps2, surfaceNormalGravityMps2, WGS84_GRAVITY } from '../packages/sensors/src/gravity.ts';

// TASK-148: WGS84 normal gravity. The oracles are independent of the implementation:
// - NIMA TR8350.2 (3rd edition, amendment 1, 2000), Table 3.4: gamma_e, gamma_p and the mean value;
// - the closed-form normal gravity of the level ellipsoid in ellipsoidal-harmonic coordinates
//   (TR8350.2 equations 4-4 to 4-7), evaluated here from the four defining constants only;
// - above and below the ellipsoid, the gradient of the closed-form normal potential U,
//   differentiated numerically in ECEF (it shares no gravity formula with the implementation).
// Tolerance, declared before the implementation: 1e-9 relative throughout. The second-order
// height series (TR8350.2 equation 4-3) failed it (1.04e-8 at 1 km), so the implementation uses
// the closed form at height.
const A = 6378137, F = 1 / 298.257223563, GM = 3.986004418e14, OMEGA = 7.292115e-5;
const B = A * (1 - F), E = Math.sqrt(A * A - B * B), E2 = (A * A - B * B) / (A * A);
const TR8350 = { gammaEquator: 9.7803253359, gammaPole: 9.8321849378, gammaMean: 9.7976432222 };

function qOf(u: number): number { return 0.5 * ((1 + 3 * u * u / (E * E)) * Math.atan(E / u) - 3 * u / E); }
/** |gamma| at geodetic latitude and ellipsoidal height, from (a, f, GM, omega) alone. */
function exactGravity(latitudeRad: number, heightM: number): number {
  const s = Math.sin(latitudeRad), c = Math.cos(latitudeRad), n = A / Math.sqrt(1 - E2 * s * s);
  const p = (n + heightM) * c, z = (n * (1 - E2) + heightM) * s, r2 = p * p + z * z;
  const u2 = 0.5 * (r2 - E * E) * (1 + Math.sqrt(1 + 4 * E * E * z * z / ((r2 - E * E) ** 2)));
  const u = Math.sqrt(u2), beta = Math.atan2(z * Math.sqrt(u2 + E * E), u * p);
  const sb = Math.sin(beta), cb = Math.cos(beta), w = Math.sqrt((u2 + E * E * sb * sb) / (u2 + E * E));
  const q0 = qOf(B), qPrime = 3 * (1 + u2 / (E * E)) * (1 - (u / E) * Math.atan(E / u)) - 1, q = qOf(u);
  const gu = -(GM / (u2 + E * E) + OMEGA * OMEGA * A * A * E / (u2 + E * E) * (qPrime / q0) * (0.5 * sb * sb - 1 / 6) - OMEGA * OMEGA * u * cb * cb) / w;
  const gb = -(-OMEGA * OMEGA * A * A / Math.sqrt(u2 + E * E) * (q / q0) + OMEGA * OMEGA * Math.sqrt(u2 + E * E)) * sb * cb / w;
  return Math.hypot(gu, gb);
}
/** U(x, z) of the normal field at an ECEF point in the x-z meridian plane (TR8350.2 equation 4-2 form). */
function normalPotential(x: number, z: number): number {
  const r2 = x * x + z * z, d = r2 - E * E, u2 = 0.5 * d * (1 + Math.sqrt(1 + 4 * E * E * z * z / (d * d)));
  const u = Math.sqrt(u2), beta = Math.atan2(z * Math.sqrt(u2 + E * E), u * x), sb = Math.sin(beta), cb = Math.cos(beta);
  return GM / E * Math.atan(E / u) + 0.5 * OMEGA * OMEGA * A * A * (qOf(u) / qOf(B)) * (sb * sb - 1 / 3) + 0.5 * OMEGA * OMEGA * (u2 + E * E) * cb * cb;
}
/**
 * |grad U| by central differences with Richardson extrapolation (steps of 2 km and 4 km, which
 * cancels the h² term). Roundoff in U over the step leaves about 1e-10 relative (measured against
 * Somigliana); the h⁴ remainder is near 1e-13. A 20 m step left 2e-8 of roundoff.
 */
function potentialGravity(latitudeRad: number, heightM: number): number {
  const s = Math.sin(latitudeRad), c = Math.cos(latitudeRad), n = A / Math.sqrt(1 - E2 * s * s);
  const x = (n + heightM) * c, z = (n * (1 - E2) + heightM) * s;
  const d = (step: number, dx: number, dz: number) => (normalPotential(x + step * dx, z + step * dz) - normalPotential(x - step * dx, z - step * dz)) / (2 * step);
  const gx = (4 * d(2000, 1, 0) - d(4000, 1, 0)) / 3, gz = (4 * d(2000, 0, 1) - d(4000, 0, 1)) / 3;
  return Math.hypot(gx, gz);
}
const relative = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const DEG = Math.PI / 180;

describe('WGS84 normal gravity (TASK-148)', () => {
  it('derives the TR8350.2 equatorial and polar values from the defining constants', () => {
    // The closed form at the equator and the pole reproduces Table 3.4.
    expect(relative(exactGravity(0, 0), TR8350.gammaEquator)).toBeLessThan(1e-9);
    expect(relative(exactGravity(90 * DEG, 0), TR8350.gammaPole)).toBeLessThan(1e-9);
    expect(relative(WGS84_GRAVITY.gammaEquatorMps2, TR8350.gammaEquator)).toBeLessThan(1e-12);
    expect(relative(WGS84_GRAVITY.gammaPoleMps2, TR8350.gammaPole)).toBeLessThan(1e-12);
    expect(relative(surfaceNormalGravityMps2(0), TR8350.gammaEquator)).toBeLessThan(1e-9);
    expect(relative(surfaceNormalGravityMps2(90 * DEG), TR8350.gammaPole)).toBeLessThan(1e-9);
    expect(relative(surfaceNormalGravityMps2(-90 * DEG), TR8350.gammaPole)).toBeLessThan(1e-9);
  });
  it('is exact on the ellipsoid at every latitude', () => {
    for (let deg = -90; deg <= 90; deg += 2.5) {
      expect(relative(surfaceNormalGravityMps2(deg * DEG), exactGravity(deg * DEG, 0))).toBeLessThan(1e-9);
      expect(normalGravityMps2(deg * DEG, 0)).toBe(surfaceNormalGravityMps2(deg * DEG));
    }
  });
  it('averages to the TR8350.2 mean normal gravity over the ellipsoid surface', () => {
    // Area-weighted mean over the reduced latitude beta: dA ∝ cos(beta) sqrt(a² sin²beta + b² cos²beta) dbeta.
    // Composite Simpson on [-pi/2, pi/2] with 20,000 panels; its error is far below 1e-9.
    const panels = 20000, h = Math.PI / panels;
    let weighted = 0, area = 0;
    for (let i = 0; i <= panels; i++) {
      const beta = -Math.PI / 2 + i * h, k = i === 0 || i === panels ? 1 : i % 2 === 1 ? 4 : 2;
      const dA = Math.cos(beta) * Math.sqrt(A * A * Math.sin(beta) ** 2 + B * B * Math.cos(beta) ** 2);
      const phi = Math.atan2(A * Math.sin(beta), B * Math.cos(beta));
      weighted += k * dA * surfaceNormalGravityMps2(phi); area += k * dA;
    }
    expect(relative(weighted / area, TR8350.gammaMean)).toBeLessThan(1e-9);
  });
  it('equals the gradient of the normal potential at every height in its envelope', () => {
    // The potential oracle first reproduces Somigliana on the ellipsoid, which shares nothing with it.
    // The poles are left out: there a 4 km step in x would cross the rotation axis.
    let oracle = 0, worst = 0;
    for (let deg = -85; deg <= 85; deg += 5) {
      oracle = Math.max(oracle, relative(potentialGravity(deg * DEG, 0), surfaceNormalGravityMps2(deg * DEG)));
      for (const h of [-1000, -500, 1, 250, 1000, 3000, 6000, 10000, 20000]) {
        worst = Math.max(worst, relative(normalGravityMps2(deg * DEG, h), potentialGravity(deg * DEG, h)));
      }
    }
    expect(oracle).toBeLessThan(1e-9);
    expect(worst).toBeLessThan(1e-9);
    for (const h of [1, 1000, 20000]) expect(relative(normalGravityMps2(Math.PI / 2, h), exactGravity(Math.PI / 2, h))).toBeLessThan(1e-12);
    // About 3.086 mGal per metre near sea level: the free-air gradient.
    const gradient = (normalGravityMps2(45 * DEG, 0) - normalGravityMps2(45 * DEG, 100)) / 100;
    expect(gradient).toBeGreaterThan(3.07e-6);
    expect(gradient).toBeLessThan(3.10e-6);
  });
  it('rejects latitudes, heights and values outside its envelope', () => {
    for (const [lat, h] of [[Number.NaN, 0], [91 * DEG, 0], [0, Number.POSITIVE_INFINITY], [0, -1001], [0, 20001]] as const) {
      expect(() => normalGravityMps2(lat, h)).toThrow();
    }
  });
});
