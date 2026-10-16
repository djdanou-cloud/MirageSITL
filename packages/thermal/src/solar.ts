// Solar geometry and clear-sky forcing for surface heat balance (TASK-070).
// Computed on the CPU at the thermal step rate, never in a shader.
//
// * Solar position: NOAA Solar Calculator equations (Meeus, "Astronomical
//   Algorithms", 1991, low-precision series). Valid 1901-2099 to roughly
//   0.01-0.03 deg away from the horizon; refraction is ignored.
// * Extraterrestrial irradiance: S0 = 1361 W/m^2 (Kopp & Lean 2011) with the
//   Spencer (1971) eccentricity factor.
// * Air mass: Kasten & Young (1989).
// * Clear-sky direct normal irradiance: Meinel & Meinel (1976),
//   DNI = S0' * 0.7^(AM^0.678); diffuse horizontal approximated as 0.1 * DNI.
// * Cloud reduction: Kasten & Czeplak (1980), factor 1 - 0.75 N^3.4 applied to
//   both components (a whole-sky approximation; per-cloud shadows are not
//   modelled).
// * Clear-sky longwave emissivity: Swinbank (1963), 9.2e-6 T_air^2, with the
//   Bolz cloud factor (1 + 0.22 N^2), capped at 1.
// These are order-of-magnitude engineering models for training visuals, not
// a validated radiative-transfer solution.

export const SOLAR_CONSTANT_WM2 = 1361;
export const STEFAN_BOLTZMANN = 5.670374419e-8;
const DEG = Math.PI / 180;

export interface SolarPosition {
  /** Zenith angle, rad (> pi/2 below the horizon). */
  zenithRad: number;
  /** Azimuth clockwise from north, rad in [0, 2 pi). */
  azimuthRad: number;
  /** Unit vector towards the sun in local east-north-up. */
  directionEnu: [number, number, number];
  declinationRad: number;
  /** Local hour angle, rad (positive after solar noon). */
  hourAngleRad: number;
}

/** Sun position for a UTC instant (ms since epoch) at geodetic latitude/longitude (deg). */
export function solarPosition(utcMs: number, latDeg: number, lonDeg: number): SolarPosition {
  if (!Number.isFinite(utcMs) || !(Math.abs(latDeg) <= 90) || !(Math.abs(lonDeg) <= 180)) throw new Error("Invalid solar position input");
  const jd = utcMs / 86_400_000 + 2440587.5;
  const t = (jd - 2451545) / 36525; // Julian centuries since J2000.0
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360; // geometric mean longitude, deg
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t); // mean anomaly, deg
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t); // orbit eccentricity
  const c = Math.sin(m * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * DEG) * 0.000289; // equation of centre, deg
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * DEG); // apparent longitude, deg
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * DEG); // corrected obliquity, deg
  const decl = Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG));
  const y = Math.tan((eps * DEG) / 2) ** 2;
  const eqTimeMin = (4 / DEG) * (y * Math.sin(2 * l0 * DEG) - 2 * e * Math.sin(m * DEG) + 4 * e * y * Math.sin(m * DEG) * Math.cos(2 * l0 * DEG) -
    0.5 * y * y * Math.sin(4 * l0 * DEG) - 1.25 * e * e * Math.sin(2 * m * DEG));
  const minutesUtc = ((utcMs % 86_400_000) + 86_400_000) % 86_400_000 / 60_000;
  const trueSolarMin = (((minutesUtc + eqTimeMin + 4 * lonDeg) % 1440) + 1440) % 1440;
  const hourAngle = (trueSolarMin / 4 - 180) * DEG;
  const lat = latDeg * DEG;
  const cosZ = Math.min(1, Math.max(-1, Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)));
  const zenith = Math.acos(cosZ);
  // Direction in ENU from hour angle and declination (exact; no azimuth branch ambiguity).
  const east = -Math.cos(decl) * Math.sin(hourAngle);
  const north = Math.cos(lat) * Math.sin(decl) - Math.sin(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const az = Math.atan2(east, north);
  return { zenithRad: zenith, azimuthRad: az < 0 ? az + 2 * Math.PI : az, directionEnu: [east, north, cosZ], declinationRad: decl, hourAngleRad: hourAngle };
}

/** Kasten & Young (1989) relative optical air mass; Infinity at or below the horizon. */
export function airMass(zenithRad: number): number {
  const zDeg = zenithRad / DEG;
  if (!(zDeg < 90)) return Infinity;
  return 1 / (Math.cos(zenithRad) + 0.50572 * (96.07995 - zDeg) ** -1.6364);
}

export interface Irradiance {
  /** Direct normal irradiance, W/m^2. */
  directNormalWm2: number;
  /** Diffuse horizontal irradiance, W/m^2. */
  diffuseHorizontalWm2: number;
}

/** Clear-sky irradiance reduced by cloud fraction (0..1) for a day of year (1..366). */
export function clearSkyIrradiance(zenithRad: number, dayOfYear: number, cloudFraction: number): Irradiance {
  if (!(cloudFraction >= 0 && cloudFraction <= 1) || !(dayOfYear >= 1 && dayOfYear <= 366)) throw new Error("Invalid irradiance input");
  const am = airMass(zenithRad);
  if (!Number.isFinite(am)) return { directNormalWm2: 0, diffuseHorizontalWm2: 0 };
  const g = (2 * Math.PI * (dayOfYear - 1)) / 365;
  const eccentricity = 1.000110 + 0.034221 * Math.cos(g) + 0.001280 * Math.sin(g) + 0.000719 * Math.cos(2 * g) + 0.000077 * Math.sin(2 * g);
  const dni = SOLAR_CONSTANT_WM2 * eccentricity * 0.7 ** (am ** 0.678);
  const cloud = 1 - 0.75 * cloudFraction ** 3.4;
  return { directNormalWm2: dni * cloud, diffuseHorizontalWm2: 0.1 * dni * cloud };
}

/** Effective sky emissivity (Swinbank 1963 clear sky, Bolz cloud factor), 0..1. */
export function skyEmissivity(airTemperatureK: number, cloudFraction: number): number {
  return Math.min(1, 9.2e-6 * airTemperatureK * airTemperatureK * (1 + 0.22 * cloudFraction * cloudFraction));
}

/** Day of year (1..366) of a UTC instant. */
export function dayOfYearUtc(utcMs: number): number {
  const d = new Date(utcMs);
  return Math.floor((utcMs - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
}

/** Local ENU incidence; angles in radians, hour angle positive after solar noon.
 * Declination/hour angle are astronomical inputs, not inferred from wall time.
 * Visibility is geometric shadow transmission, not ambient occlusion.
 */
export function solarIncidence(
  latitudeRad: number,
  declinationRad: number,
  hourAngleRad: number,
  normalEnu: readonly [number, number, number],
  directNormalWm2: number,
  visibility: number,
): number {
  if (
    ![
      latitudeRad,
      declinationRad,
      hourAngleRad,
      ...normalEnu,
      directNormalWm2,
      visibility,
    ].every(Number.isFinite) ||
    Math.abs(latitudeRad) > Math.PI / 2 ||
    Math.abs(declinationRad) > Math.PI / 2 ||
    directNormalWm2 < 0 ||
    visibility < 0 ||
    visibility > 1 ||
    Math.abs(Math.hypot(...normalEnu) - 1) > 1e-9
  )
    throw new RangeError("Invalid solar geometry");
  const east = -Math.cos(declinationRad) * Math.sin(hourAngleRad);
  const north =
    Math.cos(latitudeRad) * Math.sin(declinationRad) -
    Math.sin(latitudeRad) * Math.cos(declinationRad) * Math.cos(hourAngleRad);
  const up =
    Math.sin(latitudeRad) * Math.sin(declinationRad) +
    Math.cos(latitudeRad) * Math.cos(declinationRad) * Math.cos(hourAngleRad);
  return up <= 0
    ? 0
    : directNormalWm2 *
        visibility *
        Math.max(
          0,
          east * normalEnu[0] + north * normalEnu[1] + up * normalEnu[2],
        );
}
