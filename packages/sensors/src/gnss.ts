import { SeededRandom } from '@mirage/test-support/prng';
import { geodeticToEcefInto } from './geodesy.ts';

// GNSS v2 (TASK-117): GNSS errors and outages tied to satellite geometry, the terrain that hides satellites, the atmosphere
// and jamming. By the stakeholder's decision of 2026-11-07 the result reaches ArduPilot as its own simulated receiver's
// parameters (SIM_GPS1_GLTCH position offset, SIM_GPS1_NUMSATS, SIM_GPS1_ACC), written about five times a second by the run
// controller, off the physics Worker. ArduPilot's receiver keeps its own rate, lag and noise.
//
// * Orbits: the GPS almanac (YUMA) propagated by IS-GPS-200 Table 20-VI, with its WGS 84 constants; Galileo and BeiDou broadcast
//   Keplerian ephemerides by their ICDs' user algorithms (BeiDou GEO by its own); GLONASS broadcast state vectors as osculating
//   elements with first-order J2 secular rates (SPECS_SIMULATION_ENGINES "Multi-GNSS broadcast sky").
// * Geometry: each satellite's elevation and azimuth at the receiver, above an elevation mask; the dilutions of precision
//   from the line-of-sight matrix G with rows [−e_east, −e_north, −e_up, c₁ … c_k], one receiver clock per system, Q = (GᵀG)⁻¹.
// * Ionosphere: the Klobuchar model (IS-GPS-200 20.3.3.5.2.5) gives the L1 delay; the receiver removes it with the same
//   model, so what remains is a stated fraction of it.
// * Troposphere: the Saastamoinen zenith delays of a standard atmosphere at the receiver's height, mapped by 1/sin(el);
//   likewise a stated fraction remains.
// * Terrain: a satellite whose line of sight passes below the terrain is lost, or tracked as non-line-of-sight with an
//   excess path delay.
// * Jamming: (C/N0)_eff⁻¹ = (C/N0)⁻¹ + (J/S)/(Q·R_c) (Kaplan and Hegarty, Understanding GPS, 2nd ed., section 9.2); a satellite
//   whose effective C/N0 falls below the tracking threshold is lost.
// * Position error: the least-squares solution δx = (GᵀG)⁻¹Gᵀδρ of the satellites' remaining biases δρ, in local
//   east, north, up; the accuracy the receiver reports is the user range error times HDOP.
// * Since 2026-11-09 (SPECS_SIMULATION_ENGINES "Receiver timing, tracking noise, multipath and jammers"): each satellite's code
//   tracking noise from its C/N0 by the DLL thermal-noise formula, a synthetic elevation-dependent multipath error (RTCA DO-229's
//   airborne form), both seeded unit Gauss–Markov processes per sky satellite, and a placed jammer whose received power lowers
//   every satellite's C/N0 by the same 10·log10(1 + J/(N0·Q·R_c)) dB.
//
// Configuration-time and control-loop code, never in a physics step.

/** IS-GPS-200 constants: μ (m³/s²), the Earth's rotation rate (rad/s), the speed of light (m/s). */
export const GPS_MU = 3.986005e14, GPS_EARTH_RATE_RADS = 7.2921151467e-5, SPEED_OF_LIGHT_MPS = 299792458;
/** The C/A code chip rate, chips/s. */
export const CA_CHIP_RATE = 1.023e6;
const SECONDS_PER_WEEK = 604800;
/** Galileo OS SIS ICD (issue 2.1, section 5.1.1): μ (m³/s²) and the Earth's rotation rate (rad/s). */
export const GALILEO_MU = 3.986004418e14, GALILEO_EARTH_RATE_RADS = 7.2921151467e-5;
/** BDS-SIS-ICD-B1I-3.0, CGCS2000: μ (m³/s²) and the Earth's rotation rate (rad/s). */
export const BEIDOU_MU = 3.986004418e14, BEIDOU_EARTH_RATE_RADS = 7.2921150e-5;
/** BeiDou time is GPS time − 14 s, and its week the GPS week − 1356 (BDT began 2006-01-01, GPS week 1356). */
export const BEIDOU_WEEK_OFFSET = 1356, BEIDOU_SECONDS_BEHIND_GPS = 14;
/** GLONASS ICD edition 5.1, PZ-90: GM (m³/s²), the equatorial radius (m), J2 and the Earth's rotation rate (rad/s). */
export const GLONASS_MU = 398600.4418e9, GLONASS_RADIUS_M = 6378136, GLONASS_J2 = 1082625.75e-9, GLONASS_EARTH_RATE_RADS = 7.292115e-5;

/** The GNSS systems by their RINEX letters: GPS, Galileo, GLONASS, BeiDou. A solution's clocks follow this order. */
export type GnssSystem = 'G' | 'E' | 'R' | 'C';
export const GNSS_SYSTEMS: readonly GnssSystem[] = Object.freeze<GnssSystem[]>(['G', 'E', 'R', 'C']);

/** One satellite of a YUMA almanac, its angles in radians as YUMA states them. */
export interface AlmanacSatellite {
  readonly system: 'G';
  readonly prn: number;
  readonly health: number;
  readonly eccentricity: number;
  /** Time of applicability, s of the GPS week. */
  readonly toaS: number;
  readonly inclinationRad: number;
  readonly rateOfRightAscensionRadS: number;
  readonly sqrtA: number;
  /** Right ascension at the week's start. */
  readonly rightAscensionRad: number;
  readonly argumentOfPerigeeRad: number;
  readonly meanAnomalyRad: number;
  /** The almanac's GPS week, full (not modulo 1024). */
  readonly week: number;
}

/** Parses a YUMA almanac. Throws on a missing or non-finite field. Cold. */
export function parseYumaAlmanac(text: string, fullWeekOf: (week: number) => number): AlmanacSatellite[] {
  const satellites: AlmanacSatellite[] = [];
  for (const block of text.split(/\*{8}[^\n]*\n/).slice(1)) {
    const field = (label: string): number => {
      const line = block.split('\n').find(item => item.trim().startsWith(label));
      const value = line === undefined ? Number.NaN : Number(line.slice(line.indexOf(':') + 1).trim());
      if (!Number.isFinite(value)) throw new Error(`The almanac has no ${label}`);
      return value;
    };
    satellites.push({
      system: 'G', prn: field('ID'), health: field('Health'), eccentricity: field('Eccentricity'), toaS: field('Time of Applicability'),
      inclinationRad: field('Orbital Inclination'), rateOfRightAscensionRadS: field('Rate of Right Ascen'), sqrtA: field('SQRT(A)'),
      rightAscensionRad: field('Right Ascen at Week'), argumentOfPerigeeRad: field('Argument of Perigee'), meanAnomalyRad: field('Mean Anom'),
      week: fullWeekOf(field('week')),
    });
  }
  if (satellites.length === 0) throw new Error('The almanac has no satellites');
  return satellites;
}

/**
 * A satellite's ECEF position at GPS time (week, seconds of week), m: IS-GPS-200 Table 20-VI with the almanac's elements,
 * Kepler's equation solved by Newton's method to 1e-15 rad.
 */
export function almanacEcefInto(satellite: AlmanacSatellite, week: number, secondsOfWeek: number, out: Float64Array): void {
  const a = satellite.sqrtA * satellite.sqrtA, n = Math.sqrt(GPS_MU / (a * a * a));
  const tk = (week - satellite.week) * SECONDS_PER_WEEK + secondsOfWeek - satellite.toaS;
  const m = satellite.meanAnomalyRad + n * tk, e = satellite.eccentricity;
  let anomaly = m;
  for (let i = 0; i < 20; i++) {
    const step = (anomaly - e * Math.sin(anomaly) - m) / (1 - e * Math.cos(anomaly));
    anomaly -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  const trueAnomaly = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(anomaly), Math.cos(anomaly) - e);
  const argument = trueAnomaly + satellite.argumentOfPerigeeRad, radius = a * (1 - e * Math.cos(anomaly));
  const xp = radius * Math.cos(argument), yp = radius * Math.sin(argument);
  const node = satellite.rightAscensionRad + (satellite.rateOfRightAscensionRadS - GPS_EARTH_RATE_RADS) * tk - GPS_EARTH_RATE_RADS * satellite.toaS;
  const ci = Math.cos(satellite.inclinationRad), si = Math.sin(satellite.inclinationRad), cn = Math.cos(node), sn = Math.sin(node);
  out[0] = xp * cn - yp * ci * sn; out[1] = xp * sn + yp * ci * cn; out[2] = yp * si;
}

/** Kepler's equation M = E − e sin E by Newton's method to 1e-15 rad. */
function eccentricAnomaly(meanAnomalyRad: number, e: number): number {
  let anomaly = meanAnomalyRad;
  for (let i = 0; i < 20; i++) {
    const step = (anomaly - e * Math.sin(anomaly) - meanAnomalyRad) / (1 - e * Math.cos(anomaly));
    anomaly -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  return anomaly;
}

/**
 * One Galileo or BeiDou broadcast ephemeris record, as RINEX 3.04 gives it: angles in radians, rates in rad/s, the harmonic
 * corrections in radians (Cuc, Cus, Cic, Cis) and metres (Crc, Crs). Its week and toe are the system's own.
 */
export interface KeplerEphemeris {
  readonly system: 'E' | 'C';
  readonly prn: number;
  readonly health: number;
  /** A BeiDou GEO satellite (PRN 1 to 5, 59 to 63), propagated by the B1I ICD's GEO algorithm. */
  readonly geo: boolean;
  readonly week: number;
  readonly toeS: number;
  readonly sqrtA: number;
  readonly eccentricity: number;
  readonly inclinationRad: number;
  readonly inclinationRateRadS: number;
  /** Ω0, the longitude of the node at the week's start. */
  readonly rightAscensionRad: number;
  readonly rateOfRightAscensionRadS: number;
  readonly argumentOfPerigeeRad: number;
  readonly meanAnomalyRad: number;
  readonly meanMotionDifferenceRadS: number;
  readonly cuc: number; readonly cus: number; readonly crc: number; readonly crs: number; readonly cic: number; readonly cis: number;
}

/**
 * A Galileo or BeiDou satellite's ECEF position at GPS time (week, seconds of week), m: the user algorithm of the Galileo OS SIS
 * ICD or of BDS-SIS-ICD-B1I-3.0 with that system's μ and Ω̇e; for a BeiDou GEO the node without the Earth's rotation, the orbit
 * turned by −5° about x and by Ω̇e·tk about z.
 */
export function broadcastKeplerEcefInto(satellite: KeplerEphemeris, week: number, secondsOfWeek: number, out: Float64Array): void {
  const beidou = satellite.system === 'C';
  const mu = beidou ? BEIDOU_MU : GALILEO_MU, earthRate = beidou ? BEIDOU_EARTH_RATE_RADS : GALILEO_EARTH_RATE_RADS;
  const tk = (week - satellite.week - (beidou ? BEIDOU_WEEK_OFFSET : 0)) * SECONDS_PER_WEEK + secondsOfWeek - (beidou ? BEIDOU_SECONDS_BEHIND_GPS : 0) - satellite.toeS;
  const a = satellite.sqrtA * satellite.sqrtA, n = Math.sqrt(mu / (a * a * a)) + satellite.meanMotionDifferenceRadS, e = satellite.eccentricity;
  const anomaly = eccentricAnomaly(satellite.meanAnomalyRad + n * tk, e);
  const latitude = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(anomaly), Math.cos(anomaly) - e) + satellite.argumentOfPerigeeRad;
  const s2 = Math.sin(2 * latitude), c2 = Math.cos(2 * latitude);
  const argument = latitude + satellite.cus * s2 + satellite.cuc * c2;
  const radius = a * (1 - e * Math.cos(anomaly)) + satellite.crs * s2 + satellite.crc * c2;
  const inclination = satellite.inclinationRad + satellite.inclinationRateRadS * tk + satellite.cis * s2 + satellite.cic * c2;
  const xp = radius * Math.cos(argument), yp = radius * Math.sin(argument), ci = Math.cos(inclination), si = Math.sin(inclination);
  if (!satellite.geo) {
    const node = satellite.rightAscensionRad + (satellite.rateOfRightAscensionRadS - earthRate) * tk - earthRate * satellite.toeS;
    const cn = Math.cos(node), sn = Math.sin(node);
    out[0] = xp * cn - yp * ci * sn; out[1] = xp * sn + yp * ci * cn; out[2] = yp * si;
    return;
  }
  const node = satellite.rightAscensionRad + satellite.rateOfRightAscensionRadS * tk - earthRate * satellite.toeS;
  const cn = Math.cos(node), sn = Math.sin(node);
  const x = xp * cn - yp * ci * sn, y = xp * sn + yp * ci * cn, z = yp * si;
  // R_X(−5°), then R_Z(Ω̇e·tk), as the ICD writes them.
  const c5 = Math.cos((-5 * Math.PI) / 180), s5 = Math.sin((-5 * Math.PI) / 180), ct = Math.cos(earthRate * tk), st = Math.sin(earthRate * tk);
  const y1 = y * c5 + z * s5, z1 = -y * s5 + z * c5;
  out[0] = x * ct + y1 * st; out[1] = -x * st + y1 * ct; out[2] = z1;
}

/** One GLONASS broadcast record: tb in GPS time, the PZ-90 position (m) and velocity (m/s) at tb, its health and channel. */
export interface GlonassEphemeris {
  readonly system: 'R';
  readonly prn: number;
  readonly health: number;
  readonly frequencyChannel: number;
  /** tb as GPS week and seconds of week. */
  readonly week: number;
  readonly tbS: number;
  readonly positionM: readonly [number, number, number];
  readonly velocityMps: readonly [number, number, number];
}

/**
 * A GLONASS satellite's ECEF position at GPS time (week, seconds of week), m. The broadcast state vector becomes osculating
 * Keplerian elements in the inertial frame aligned with PZ-90 at tb (velocity plus ω₃ × r), propagated with the first-order J2
 * secular rates of the node, the perigee and the mean anomaly; the rates take the mean motion of the mean semi-major axis
 * ā = a − (3/2)(J2·a_e²/a) sin²i cos 2u, the short-period term of a near-circular orbit. At tb it returns the broadcast position.
 * The broadcast luni-solar accelerations, valid ±15 min, are not used.
 */
export function glonassEcefInto(satellite: GlonassEphemeris, week: number, secondsOfWeek: number, out: Float64Array): void {
  const mu = GLONASS_MU, w = GLONASS_EARTH_RATE_RADS, re = GLONASS_RADIUS_M, j2 = GLONASS_J2;
  const dt = (week - satellite.week) * SECONDS_PER_WEEK + secondsOfWeek - satellite.tbS;
  const [x, y, z] = satellite.positionM, [vxe, vye, vz] = satellite.velocityMps;
  const vx = vxe - w * y, vy = vye + w * x;
  const r = Math.hypot(x, y, z), v2 = vx * vx + vy * vy + vz * vz, rv = x * vx + y * vy + z * vz;
  const hx = y * vz - z * vy, hy = z * vx - x * vz, hz = x * vy - y * vx;
  const inclination = Math.acos(hz / Math.hypot(hx, hy, hz)), node0 = Math.atan2(hx, -hy);
  const a = 1 / (2 / r - v2 / mu);
  const ex = ((v2 - mu / r) * x - rv * vx) / mu, ey = ((v2 - mu / r) * y - rv * vy) / mu, ez = ((v2 - mu / r) * z - rv * vz) / mu;
  const e = Math.hypot(ex, ey, ez);
  const ci = Math.cos(inclination), si = Math.sin(inclination), cn0 = Math.cos(node0), sn0 = Math.sin(node0);
  // The orbit plane's axes: P towards the node, Q 90° ahead of it in the plane.
  const latitude0 = Math.atan2(-x * sn0 * ci + y * cn0 * ci + z * si, x * cn0 + y * sn0);
  const perigee0 = Math.atan2(-ex * sn0 * ci + ey * cn0 * ci + ez * si, ex * cn0 + ey * sn0);
  const trueAnomaly0 = latitude0 - perigee0;
  const anomaly0 = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(trueAnomaly0), e + Math.cos(trueAnomaly0));
  const meanAnomaly0 = anomaly0 - e * Math.sin(anomaly0);
  const meanA = a - 1.5 * (j2 * re * re / a) * si * si * Math.cos(2 * latitude0);
  const p = meanA * (1 - e * e), n = Math.sqrt(mu / (meanA * meanA * meanA)), k = j2 * (re / p) * (re / p);
  const nodeRate = -1.5 * n * k * ci, perigeeRate = 0.75 * n * k * (5 * ci * ci - 1), meanRate = n * (1 + 0.75 * k * Math.sqrt(1 - e * e) * (3 * ci * ci - 1));
  const anomaly = eccentricAnomaly(meanAnomaly0 + meanRate * dt, e);
  const argument = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(anomaly), Math.cos(anomaly) - e) + perigee0 + perigeeRate * dt;
  const radius = a * (1 - e * Math.cos(anomaly)), node = node0 + nodeRate * dt;
  const cu = Math.cos(argument), su = Math.sin(argument), cn = Math.cos(node), sn = Math.sin(node);
  const xi = radius * (cu * cn - su * ci * sn), yi = radius * (cu * sn + su * ci * cn), zi = radius * su * si;
  const ct = Math.cos(w * dt), st = Math.sin(w * dt);
  out[0] = xi * ct + yi * st; out[1] = -xi * st + yi * ct; out[2] = zi;
}

/** A satellite of the sky: a GPS almanac entry, a Galileo or BeiDou broadcast ephemeris, or a GLONASS broadcast state. */
export type SkySatellite = AlmanacSatellite | KeplerEphemeris | GlonassEphemeris;
/** Any sky satellite's ECEF position at GPS time (week, seconds of week), m. */
export function satelliteEcefInto(satellite: SkySatellite, week: number, secondsOfWeek: number, out: Float64Array): void {
  switch (satellite.system) {
    case 'G': almanacEcefInto(satellite, week, secondsOfWeek, out); return;
    case 'E': case 'C': broadcastKeplerEcefInto(satellite, week, secondsOfWeek, out); return;
    case 'R': glonassEcefInto(satellite, week, secondsOfWeek, out); return;
    default: { const unknown: never = satellite; throw new Error(`Unknown satellite ${String(unknown)}`); }
  }
}

/**
 * A synthetic GPS-like constellation, not any day's real orbits: the Walker 24/6/1 pattern (24 satellites in 6 planes 60° apart,
 * 4 per plane, neighbouring planes phased by 15°) at 55° inclination on circular orbits of half a sidereal day (√A 5153.795 m^½),
 * referred to `week` with a time of applicability 0. A real almanac (parseYumaAlmanac) replaces it where one is available.
 */
export function walkerConstellation(week: number): AlmanacSatellite[] {
  const satellites: AlmanacSatellite[] = [];
  for (let plane = 0; plane < 6; plane++) {
    for (let slot = 0; slot < 4; slot++) {
      satellites.push({ system: 'G', prn: plane * 4 + slot + 1, health: 0, eccentricity: 0, toaS: 0, inclinationRad: (55 * Math.PI) / 180, rateOfRightAscensionRadS: 0,
        sqrtA: 5153.795, rightAscensionRad: (plane * Math.PI) / 3, argumentOfPerigeeRad: 0,
        meanAnomalyRad: (slot * Math.PI) / 2 + (plane * Math.PI) / 12, week });
    }
  }
  return satellites;
}

/** A receiver: geodetic latitude and longitude (rad), height above the ellipsoid (m). */
export interface ReceiverPosition { readonly latRad: number; readonly lonRad: number; readonly heightM: number }
export interface SatelliteView {
  readonly system: GnssSystem;
  readonly prn: number;
  readonly elevationRad: number;
  readonly azimuthRad: number;
  /** Unit line of sight from the receiver, east, north, up. */
  readonly lineOfSight: readonly [number, number, number];
}

/** Every healthy satellite of the sky above the mask, with its elevation and azimuth at the receiver. */
export function visibleSatellites(almanac: readonly SkySatellite[], receiver: ReceiverPosition, week: number, secondsOfWeek: number, maskRad: number): SatelliteView[] {
  return visibleIndexed(almanac, receiver, week, secondsOfWeek, maskRad, null);
}
/** As `visibleSatellites`; `indices`, when given, receives each view's index in the sky. */
function visibleIndexed(almanac: readonly SkySatellite[], receiver: ReceiverPosition, week: number, secondsOfWeek: number, maskRad: number, indices: number[] | null): SatelliteView[] {
  const r = new Float64Array(3), s = new Float64Array(3);
  geodeticToEcefInto(receiver.latRad, receiver.lonRad, receiver.heightM, r);
  const sl = Math.sin(receiver.latRad), cl = Math.cos(receiver.latRad), so = Math.sin(receiver.lonRad), co = Math.cos(receiver.lonRad);
  const views: SatelliteView[] = [];
  for (let index = 0; index < almanac.length; index++) {
    const satellite = almanac[index]!;
    if (satellite.health !== 0) continue;
    satelliteEcefInto(satellite, week, secondsOfWeek, s);
    const dx = s[0]! - r[0]!, dy = s[1]! - r[1]!, dz = s[2]! - r[2]!, range = Math.hypot(dx, dy, dz);
    const east = (-so * dx + co * dy) / range, north = (-sl * co * dx - sl * so * dy + cl * dz) / range, up = (cl * co * dx + cl * so * dy + sl * dz) / range;
    const elevationRad = Math.asin(up);
    if (elevationRad < maskRad) continue;
    let azimuthRad = Math.atan2(east, north);
    if (azimuthRad < 0) azimuthRad += 2 * Math.PI;
    views.push({ system: satellite.system, prn: satellite.prn, elevationRad, azimuthRad, lineOfSight: [east, north, up] });
    indices?.push(index);
  }
  return views;
}

export interface Dilution {
  readonly gdop: number; readonly pdop: number; readonly hdop: number; readonly vdop: number;
  /** The first clock's: the first system present in the order GPS, Galileo, GLONASS, BeiDou. */
  readonly tdop: number;
  /** Every clock's, in its index order. */
  readonly clocks: readonly number[];
}
/**
 * Q = (GᵀG)⁻¹ of the line-of-sight matrix with one clock column per clock index (0 … k − 1, each used), by Gauss–Jordan elimination
 * with partial pivoting; null below 3 + k satellites or when singular. With one clock it is the four-unknown arithmetic.
 */
function covariance(lines: readonly (readonly [number, number, number])[], clocks: readonly number[] | undefined): { readonly q: number[]; readonly size: number } | null {
  let k = 1;
  if (clocks) {
    if (clocks.length !== lines.length) return null;
    for (const clock of clocks) { if (!Number.isInteger(clock) || clock < 0) return null; k = Math.max(k, clock + 1); }
  }
  const size = 3 + k;
  if (lines.length < size) return null;
  const m = new Array<number>(size * size).fill(0), row = new Array<number>(size).fill(0);
  lines.forEach(([e, n, u], index) => {
    row.fill(0); row[0] = -e; row[1] = -n; row[2] = -u; row[3 + (clocks?.[index] ?? 0)] = 1;
    for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) m[i * size + j] = m[i * size + j]! + row[i]! * row[j]!;
  });
  const inv = new Array<number>(size * size).fill(0);
  for (let i = 0; i < size; i++) inv[i * size + i] = 1;
  for (let c = 0; c < size; c++) {
    let p = c;
    for (let r = c + 1; r < size; r++) if (Math.abs(m[r * size + c]!) > Math.abs(m[p * size + c]!)) p = r;
    const pivot = m[p * size + c]!;
    if (!(Math.abs(pivot) > 1e-12)) return null;
    for (let k2 = 0; k2 < size; k2++) {
      [m[c * size + k2], m[p * size + k2]] = [m[p * size + k2]!, m[c * size + k2]!];
      [inv[c * size + k2], inv[p * size + k2]] = [inv[p * size + k2]!, inv[c * size + k2]!];
    }
    for (let k2 = 0; k2 < size; k2++) { m[c * size + k2] = m[c * size + k2]! / pivot; inv[c * size + k2] = inv[c * size + k2]! / pivot; }
    for (let r = 0; r < size; r++) {
      if (r === c) continue;
      const f = m[r * size + c]!;
      for (let k2 = 0; k2 < size; k2++) { m[r * size + k2] = m[r * size + k2]! - f * m[c * size + k2]!; inv[r * size + k2] = inv[r * size + k2]! - f * inv[c * size + k2]!; }
    }
  }
  return { q: inv, size };
}
/**
 * The dilutions of precision of a set of lines of sight, each with its clock index (one receiver clock per system; all 0, or
 * omitted, for one system); null below 3 + k satellites or for a degenerate geometry.
 */
export function dilution(lines: readonly (readonly [number, number, number])[], clocks?: readonly number[]): Dilution | null {
  const solved = covariance(lines, clocks);
  if (!solved) return null;
  const { q, size } = solved;
  const e = q[0]!, n = q[size + 1]!, u = q[2 * size + 2]!;
  const clockVariances: number[] = [];
  for (let j = 3; j < size; j++) clockVariances.push(q[j * size + j]!);
  let trace = e + n + u;
  for (const variance of clockVariances) trace += variance;
  return { gdop: Math.sqrt(trace), pdop: Math.sqrt(e + n + u), hdop: Math.sqrt(e + n), vdop: Math.sqrt(u), tdop: Math.sqrt(clockVariances[0]!),
    clocks: clockVariances.map(variance => Math.sqrt(variance)) };
}
/** The least-squares position error, m east, north, up, of range biases δρ (m, positive is a longer range); null as for `dilution`. */
export function positionError(lines: readonly (readonly [number, number, number])[], biasesM: readonly number[], clocks?: readonly number[]): [number, number, number] | null {
  const solved = covariance(lines, clocks);
  if (!solved || biasesM.length !== lines.length) return null;
  const { q, size } = solved;
  const g = new Array<number>(size).fill(0);
  lines.forEach(([e, n, u], i) => {
    const b = biasesM[i]!, clock = 3 + (clocks?.[i] ?? 0);
    g[0] = g[0]! - e * b; g[1] = g[1]! - n * b; g[2] = g[2]! - u * b; g[clock] = g[clock]! + b;
  });
  const x = [0, 0, 0];
  for (let i = 0; i < 3; i++) { let sum = 0; for (let j = 0; j < size; j++) sum += q[i * size + j]! * g[j]!; x[i] = sum; }
  return [x[0]!, x[1]!, x[2]!];
}

/** Klobuchar coefficients as broadcast: α in s, s/semicircle, ...; β in s, s/semicircle, .... */
export interface KlobucharCoefficients { readonly alpha: readonly [number, number, number, number]; readonly beta: readonly [number, number, number, number] }
/** The L1 ionospheric delay of the Klobuchar model, s (IS-GPS-200 20.3.3.5.2.5, Figure 20-4). */
export function klobucharDelayS(k: KlobucharCoefficients, receiver: ReceiverPosition, elevationRad: number, azimuthRad: number, gpsSecondsOfDay: number): number {
  const el = elevationRad / Math.PI, phiU = receiver.latRad / Math.PI, lamU = receiver.lonRad / Math.PI;
  const psi = 0.0137 / (el + 0.11) - 0.022;
  let phiI = phiU + psi * Math.cos(azimuthRad);
  phiI = Math.max(-0.416, Math.min(0.416, phiI));
  const lamI = lamU + (psi * Math.sin(azimuthRad)) / Math.cos(phiI * Math.PI);
  const phiM = phiI + 0.064 * Math.cos((lamI - 1.617) * Math.PI);
  let t = 43200 * lamI + gpsSecondsOfDay;
  t = ((t % 86400) + 86400) % 86400;
  const f = 1 + 16 * (0.53 - el) ** 3;
  let amplitude = k.alpha[0] + phiM * (k.alpha[1] + phiM * (k.alpha[2] + phiM * k.alpha[3]));
  let period = k.beta[0] + phiM * (k.beta[1] + phiM * (k.beta[2] + phiM * k.beta[3]));
  amplitude = Math.max(0, amplitude); period = Math.max(72000, period);
  const x = (2 * Math.PI * (t - 50400)) / period;
  return Math.abs(x) < 1.57 ? f * (5e-9 + amplitude * (1 - (x * x) / 2 + (x * x * x * x) / 24)) : f * 5e-9;
}

/**
 * The Saastamoinen tropospheric delay, m, of the standard atmosphere at the receiver's height: pressure, temperature and
 * 70 % relative humidity of the formulas RTKLIB's tropmodel uses (Saastamoinen 1972), the zenith delays mapped by 1/cos z.
 */
export function saastamoinenDelayM(receiver: ReceiverPosition, elevationRad: number, relativeHumidity = 0.7): number {
  if (elevationRad <= 0) return 0;
  const h = Math.max(0, receiver.heightM);
  const pressureHpa = 1013.25 * (1 - 2.2557e-5 * h) ** 5.2568, temperatureK = 15 - 6.5e-3 * h + 273.16;
  const vapourHpa = 6.108 * relativeHumidity * Math.exp((17.15 * temperatureK - 4684) / (temperatureK - 38.45));
  const z = Math.PI / 2 - elevationRad;
  const hydrostatic = (0.0022768 * pressureHpa) / ((1 - 0.00266 * Math.cos(2 * receiver.latRad) - 0.00028 * (h / 1000)) * Math.cos(z));
  const wet = (0.002277 * (1255 / temperatureK + 0.05) * vapourHpa) / Math.cos(z);
  return hydrostatic + wet;
}

/** The effective carrier-to-noise density under jamming, dB-Hz: (C/N0)_eff⁻¹ = (C/N0)⁻¹ + (J/S)/(Q·R_c). */
export function effectiveCn0DbHz(cn0DbHz: number, jammingToSignalDb: number, spectralSeparation: number, chipRate = CA_CHIP_RATE): number {
  const cn0 = 10 ** (cn0DbHz / 10), js = 10 ** (jammingToSignalDb / 10);
  return -10 * Math.log10(1 / cn0 + js / (spectralSeparation * chipRate));
}

/** The terrain height above the ellipsoid under a local east, north position, m; NaN where there is none. */
export type TerrainHeight = (eastM: number, northM: number) => number;
/**
 * Whether the line of sight leaves the receiver unblocked: it is marched from the receiver in steps of `stepM` horizontally out
 * to `rangeM`, and is blocked where the terrain stands above it. Flat-Earth over that range, which holds while the drop of the
 * Earth's curvature, d²/(2R), stays small against the terrain: 3 m at 6 km.
 */
export function lineOfSightClear(terrain: TerrainHeight, receiverEastM: number, receiverNorthM: number, receiverHeightM: number, view: SatelliteView, rangeM = 3000, stepM = 2): boolean {
  const tanEl = Math.tan(view.elevationRad), se = Math.sin(view.azimuthRad), ce = Math.cos(view.azimuthRad);
  for (let d = stepM; d <= rangeM; d += stepM) {
    const ground = terrain(receiverEastM + d * se, receiverNorthM + d * ce);
    if (Number.isFinite(ground) && ground > receiverHeightM + d * tanEl) return false;
  }
  return true;
}

/** A representative broadcast Klobuchar set: RTKLIB's `ion_default`, the GPS broadcast coefficients of 2004-01-01, for runs without their own. */
export const DEFAULT_KLOBUCHAR: KlobucharCoefficients = Object.freeze({
  alpha: [0.1118e-7, -0.7451e-8, -0.5961e-7, 0.1192e-6] as const, beta: [0.1167e6, -0.2294e6, -0.1311e6, 0.1049e7] as const,
});

/** What the GNSS v2 effects ask for; null leaves an effect off. Intensity is applied by the caller. */
export interface GnssEffects {
  /** Satellite geometry: the elevation mask, rad, and the user range error σ, m, that sets the accuracy. */
  readonly constellation: { readonly maskRad: number; readonly uereM: number } | null;
  /** The fractions of the Klobuchar and Saastamoinen delays the receiver's corrections leave. */
  readonly atmosphere: { readonly ionosphereResidual: number; readonly troposphereResidual: number } | null;
  /** Terrain blocks lines of sight; a blocked satellite is lost, or with a positive excess tracked with that extra path, m. */
  readonly terrain: { readonly heightAt: TerrainHeight; readonly nlosExcessM: number } | null;
  /** Jamming at the receiver: J/S dB, the spectral separation Q, and the tracking threshold, dB-Hz. */
  readonly jamming: { readonly jammingToSignalDb: number; readonly spectralSeparation: number; readonly thresholdDbHz: number } | null;
  /**
   * A placed jammer: the power it delivers at the receiver, dBW (`jammerReceivedPowerDbW`), Q and the tracking threshold. Each
   * satellite's own J/S, J − C_i with C_i = (C/N0)_i + N0, enters the link budget. Absent or null: none.
   */
  readonly jammer?: { readonly receivedPowerDbW: number; readonly spectralSeparation: number; readonly thresholdDbHz: number } | null;
  /**
   * Code tracking noise: the DLL's noise bandwidth B_n (Hz) and correlator spacing D (chips), σ multiplied by `scale`, and one unit
   * process value per sky satellite (`GnssRangeProcess.values`). Absent or null: none.
   */
  readonly codeNoise?: { readonly bandwidthHz: number; readonly spacingChips: number; readonly scale: number; readonly unit: Float64Array } | null;
  /** Multipath: σ = a + b·e^(−θ/θ₀), m, and one unit process value per sky satellite. Absent or null: none. */
  readonly multipath?: { readonly floorM: number; readonly lowElevationM: number; readonly elevationScaleRad: number; readonly unit: Float64Array } | null;
}
/** The receiver's position for a solution: geodetic, and its local east, north and height for the terrain. */
export interface GnssReceiver extends ReceiverPosition { readonly eastM: number; readonly northM: number }
export interface GnssSolution {
  /** Satellites above the mask, and those tracked after terrain and jamming. */
  readonly visible: number;
  /** The satellites above the mask of each system. */
  readonly visibleBySystem: Readonly<Record<GnssSystem, number>>;
  readonly tracked: number;
  /** Tracked satellites whose signal arrives only by reflection (non-line-of-sight). */
  readonly nonLineOfSight: number;
  readonly dilution: Dilution | null;
  /** The position error, m east, north, up; zero without a fix. */
  readonly errorEnuM: readonly [number, number, number];
  /** The horizontal accuracy the receiver reports: σ·HDOP, m; null without a fix. */
  readonly accuracyM: number | null;
  readonly fix: boolean;
}
/** C/N0 of open sky by elevation, dB-Hz: 45 at the zenith falling to 35 at the horizon as 1 − sin(el); typical, not a measured antenna. */
export function openSkyCn0DbHz(elevationRad: number): number {
  return 45 - 10 * (1 - Math.sin(Math.max(0, elevationRad)));
}
const NO_ERROR: readonly [number, number, number] = Object.freeze<[number, number, number]>([0, 0, 0]);

/** The C/A code's chip length, m: c/R_c. */
export const CA_CHIP_LENGTH_M = SPEED_OF_LIGHT_MPS / CA_CHIP_RATE;
/** The coherent integration time of the DLL noise formula, s: one C/A navigation data bit at 50 bit/s. */
export const DLL_INTEGRATION_S = 0.02;
/**
 * The thermal-noise code tracking jitter of a noncoherent early-minus-late power DLL, m (Kaplan and Hegarty, eds., Understanding GPS,
 * 2nd ed., chapter 5): λ_c·√((B_n·D/(2·c/n0))·(1 + 2/(T·c/n0·(2 − D)))), c/n0 the carrier-to-noise density as a ratio.
 */
export function dllJitterM(cn0DbHz: number, bandwidthHz: number, spacingChips: number): number {
  const cn0 = 10 ** (cn0DbHz / 10);
  return CA_CHIP_LENGTH_M * Math.sqrt(((bandwidthHz * spacingChips) / (2 * cn0)) * (1 + 2 / (DLL_INTEGRATION_S * cn0 * (2 - spacingChips))));
}
/** The multipath σ at elevation θ, m: a + b·e^(−θ/θ₀), the form of RTCA DO-229's airborne model (a 0.13 m, b 0.53 m, θ₀ 10°). */
export function multipathSigmaM(elevationRad: number, floorM: number, lowElevationM: number, elevationScaleRad: number): number {
  return floorM + lowElevationM * Math.exp(-elevationRad / elevationScaleRad);
}
/** GPS L1, Hz, and its wavelength, m. */
export const GPS_L1_HZ = 1575.42e6, GPS_L1_WAVELENGTH_M = SPEED_OF_LIGHT_MPS / GPS_L1_HZ;
/** The receiver's noise density N0 = k·290 K, dBW/Hz: thermal noise at the reference temperature, no noise figure. */
export const RECEIVER_NOISE_DENSITY_DBW_HZ = 10 * Math.log10(1.380649e-23 * 290);
/** The C/N0 every satellite loses to a jammer delivering J dBW: 10·log10(1 + J/(N0·Q·R_c)), dB. */
export function jammerCn0LossDb(receivedPowerDbW: number, spectralSeparation: number, chipRate = CA_CHIP_RATE): number {
  return 10 * Math.log10(1 + 10 ** ((receivedPowerDbW - RECEIVER_NOISE_DENSITY_DBW_HZ) / 10) / (spectralSeparation * chipRate));
}

/** The random streams of the per-satellite code noise and multipath processes. */
export const GNSS_CODE_NOISE_STREAM = 0x00117002, GNSS_MULTIPATH_STREAM = 0x00117003;
/**
 * One unit first-order Gauss–Markov process per sky satellite, x ← φ·x + √(1 − φ²)·w, starting from its stationary distribution and
 * advanced a whole number of epochs at a time, one draw per satellite per epoch in sky order. Seeded, so a seed repeats it.
 * Control-loop code: it allocates nothing after construction.
 */
export class GnssRangeProcess {
  readonly values: Float64Array;
  private readonly draw = new Float64Array(1);
  private readonly random: SeededRandom;
  constructor(count: number, seed: number, stream: number) {
    if (!Number.isInteger(count) || count < 1) throw new Error('Invalid GNSS range process');
    this.values = new Float64Array(count);
    this.random = new SeededRandom(seed >>> 0, stream);
    for (let i = 0; i < count; i++) { this.random.nextGaussianInto(this.draw, 0); this.values[i] = this.draw[0]!; }
  }
  /** Advances every satellite `epochs` epochs with the per-epoch coefficient φ = e^(−Δt/τ). */
  advance(epochs: number, phi: number): void {
    const scale = Math.sqrt(1 - phi * phi), values = this.values;
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (let i = 0; i < values.length; i++) {
        this.random.nextGaussianInto(this.draw, 0);
        values[i] = phi * values[i]! + scale * this.draw[0]!;
      }
    }
  }
}

/**
 * One GNSS v2 solution at GPS time (week, seconds of week), one receiver clock per system among the tracked satellites. With the
 * constellation off it reports the satellites above 5° and no error, as the other effects alone change nothing a stock SITL
 * receiver could show without geometry.
 */
export function gnssSolution(almanac: readonly SkySatellite[], receiver: GnssReceiver, week: number, secondsOfWeek: number, effects: GnssEffects): GnssSolution {
  const mask = effects.constellation?.maskRad ?? (5 * Math.PI) / 180;
  const indices: number[] = [];
  const views = visibleIndexed(almanac, receiver, week, secondsOfWeek, mask, indices);
  const visibleBySystem: Record<GnssSystem, number> = { G: 0, E: 0, R: 0, C: 0 };
  for (const view of views) visibleBySystem[view.system]++;
  const lines: (readonly [number, number, number])[] = [], biases: number[] = [], systems: GnssSystem[] = [];
  let nonLineOfSight = 0;
  const secondsOfDay = ((secondsOfWeek % 86400) + 86400) % 86400;
  const jammer = effects.jammer ?? null, codeNoise = effects.codeNoise ?? null, multipath = effects.multipath ?? null;
  for (let v = 0; v < views.length; v++) {
    const view = views[v]!, index = indices[v]!;
    let bias = 0;
    const terrain = effects.terrain;
    if (terrain && !lineOfSightClear(terrain.heightAt, receiver.eastM, receiver.northM, receiver.heightM, view)) {
      if (!(terrain.nlosExcessM > 0)) continue;
      bias += terrain.nlosExcessM;
      nonLineOfSight++;
    }
    const jamming = effects.jamming;
    if (jamming && effectiveCn0DbHz(openSkyCn0DbHz(view.elevationRad), jamming.jammingToSignalDb, jamming.spectralSeparation) < jamming.thresholdDbHz) continue;
    // A placed jammer: this satellite's own J/S against its received power C_i = (C/N0)_i + N0.
    let cn0DbHz = 0;
    if (jammer || codeNoise) {
      const open = openSkyCn0DbHz(view.elevationRad);
      cn0DbHz = jamming ? effectiveCn0DbHz(open, jamming.jammingToSignalDb, jamming.spectralSeparation)
        : jammer ? effectiveCn0DbHz(open, jammer.receivedPowerDbW - (open + RECEIVER_NOISE_DENSITY_DBW_HZ), jammer.spectralSeparation) : open;
      if (jammer && cn0DbHz < jammer.thresholdDbHz) continue;
    }
    const atmosphere = effects.atmosphere;
    if (atmosphere) {
      bias += atmosphere.ionosphereResidual * SPEED_OF_LIGHT_MPS * klobucharDelayS(DEFAULT_KLOBUCHAR, receiver, view.elevationRad, view.azimuthRad, secondsOfDay);
      bias += atmosphere.troposphereResidual * saastamoinenDelayM(receiver, view.elevationRad);
    }
    if (codeNoise) bias += codeNoise.scale * dllJitterM(cn0DbHz, codeNoise.bandwidthHz, codeNoise.spacingChips) * (codeNoise.unit[index] ?? 0);
    if (multipath) bias += multipathSigmaM(view.elevationRad, multipath.floorM, multipath.lowElevationM, multipath.elevationScaleRad) * (multipath.unit[index] ?? 0);
    lines.push(view.lineOfSight);
    biases.push(bias);
    systems.push(view.system);
  }
  // Clock indices in the order GPS, Galileo, GLONASS, BeiDou of the systems tracked.
  const present = GNSS_SYSTEMS.filter(system => systems.includes(system));
  const clocks = systems.map(system => present.indexOf(system));
  const d = dilution(lines, clocks), fix = d !== null;
  const error = fix ? positionError(lines, biases, clocks) ?? NO_ERROR : NO_ERROR;
  const sigma = effects.constellation?.uereM ?? null;
  return { visible: views.length, visibleBySystem, tracked: lines.length, nonLineOfSight, dilution: d, errorEnuM: error,
    accuracyM: fix && sigma !== null && d ? sigma * d.hdop : null, fix };
}

/**
 * The correlation time of the horizontal GNSS wander, s: a modelling choice. Code-phase GNSS position errors drift over tens of
 * seconds rather than jumping between fixes; the first-order Gauss–Markov form is the usual model of such an error, and 60 s
 * sits in the range its correlation times are quoted in. Logged open-sky data would fit it (BLOCKED_EXTERNAL).
 */
export const GNSS_WANDER_TAU_S = 60;
/** The random stream of the horizontal wander, one per axis after it. */
export const GNSS_WANDER_STREAM = 0x00117001;

/**
 * The Sensors tab's horizontal GNSS error (mapping 4): an east and a north first-order Gauss–Markov wander of standard deviation σ,
 * x ← φ·x + σ·√(1 − φ²)·w with φ = e^(−Δt/τ), exact for any step, starting from its stationary distribution. Seeded, so a seed
 * repeats it. Control-loop code: it allocates nothing after construction.
 */
export class HorizontalWander {
  /** East and north, m. */
  readonly errorEnM = new Float64Array(2);
  private readonly draw = new Float64Array(1);
  private readonly random: SeededRandom;
  constructor(readonly sigmaM: number, seed: number, readonly tauS: number = GNSS_WANDER_TAU_S) {
    if (!Number.isFinite(sigmaM) || sigmaM < 0 || !Number.isFinite(tauS) || tauS <= 0) throw new Error('Invalid GNSS wander');
    this.random = new SeededRandom(seed >>> 0, GNSS_WANDER_STREAM);
    for (let axis = 0; axis < 2; axis++) { this.random.nextGaussianInto(this.draw, 0); this.errorEnM[axis] = sigmaM * this.draw[0]!; }
  }
  /** Advances both axes by `dtS` seconds. */
  step(dtS: number): void {
    if (!(dtS > 0)) return;
    const phi = Math.exp(-dtS / this.tauS), scale = this.sigmaM * Math.sqrt(1 - phi * phi);
    for (let axis = 0; axis < 2; axis++) {
      this.random.nextGaussianInto(this.draw, 0);
      this.errorEnM[axis] = phi * this.errorEnM[axis]! + scale * this.draw[0]!;
    }
  }
}
