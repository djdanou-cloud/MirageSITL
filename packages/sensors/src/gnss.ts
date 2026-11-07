import { SeededRandom } from '@mirage/test-support/prng';
import { geodeticToEcefInto } from './geodesy.ts';

// GNSS v2 (TASK-117): GNSS errors and outages tied to satellite geometry, the terrain that hides satellites, the atmosphere
// and jamming. By the stakeholder's decision of 2026-11-07 the result reaches ArduPilot as its own simulated receiver's
// parameters (SIM_GPS1_GLTCH position offset, SIM_GPS1_NUMSATS, SIM_GPS1_ACC), written about five times a second by the run
// controller, off the physics Worker. ArduPilot's receiver keeps its own rate, lag and noise.
//
// * Orbits: the GPS almanac (YUMA) propagated by IS-GPS-200 Table 20-VI, with its WGS 84 constants.
// * Geometry: each satellite's elevation and azimuth at the receiver, above an elevation mask; the dilutions of precision
//   from the line-of-sight matrix G with rows [−e_east, −e_north, −e_up, 1], Q = (GᵀG)⁻¹.
// * Ionosphere: the Klobuchar model (IS-GPS-200 20.3.3.5.2.5) gives the L1 delay; the receiver removes it with the same
//   model, so what remains is a stated fraction of it.
// * Troposphere: the Saastamoinen zenith delays of a standard atmosphere at the receiver's height, mapped by 1/sin(el);
//   likewise a stated fraction remains.
// * Terrain: a satellite whose line of sight passes below the terrain is lost, or tracked as non-line-of-sight with an
//   excess path delay.
// * Jamming: (C/N0)_eff⁻¹ = (C/N0)⁻¹ + (J/S)/(Q·R_c) (Kaplan and Hegarty, Understanding GPS, 2nd ed., section 9.2); a satellite
//   whose effective C/N0 falls below the tracking threshold is lost.
// * Position error: the weighted least-squares solution δx = (GᵀG)⁻¹Gᵀδρ of the satellites' remaining biases δρ, in local
//   east, north, up; the accuracy the receiver reports is the user range error times HDOP.
//
// Configuration-time and control-loop code, never in a physics step.

/** IS-GPS-200 constants: μ (m³/s²), the Earth's rotation rate (rad/s), the speed of light (m/s). */
export const GPS_MU = 3.986005e14, GPS_EARTH_RATE_RADS = 7.2921151467e-5, SPEED_OF_LIGHT_MPS = 299792458;
/** The C/A code chip rate, chips/s. */
export const CA_CHIP_RATE = 1.023e6;
const SECONDS_PER_WEEK = 604800;

/** One satellite of a YUMA almanac, its angles in radians as YUMA states them. */
export interface AlmanacSatellite {
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
      prn: field('ID'), health: field('Health'), eccentricity: field('Eccentricity'), toaS: field('Time of Applicability'),
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

/**
 * A synthetic GPS-like constellation, not any day's real orbits: the Walker 24/6/1 pattern (24 satellites in 6 planes 60° apart,
 * 4 per plane, neighbouring planes phased by 15°) at 55° inclination on circular orbits of half a sidereal day (√A 5153.795 m^½),
 * referred to `week` with a time of applicability 0. A real almanac (parseYumaAlmanac) replaces it where one is available.
 */
export function walkerConstellation(week: number): AlmanacSatellite[] {
  const satellites: AlmanacSatellite[] = [];
  for (let plane = 0; plane < 6; plane++) {
    for (let slot = 0; slot < 4; slot++) {
      satellites.push({ prn: plane * 4 + slot + 1, health: 0, eccentricity: 0, toaS: 0, inclinationRad: (55 * Math.PI) / 180, rateOfRightAscensionRadS: 0,
        sqrtA: 5153.795, rightAscensionRad: (plane * Math.PI) / 3, argumentOfPerigeeRad: 0,
        meanAnomalyRad: (slot * Math.PI) / 2 + (plane * Math.PI) / 12, week });
    }
  }
  return satellites;
}

/** A receiver: geodetic latitude and longitude (rad), height above the ellipsoid (m). */
export interface ReceiverPosition { readonly latRad: number; readonly lonRad: number; readonly heightM: number }
export interface SatelliteView {
  readonly prn: number;
  readonly elevationRad: number;
  readonly azimuthRad: number;
  /** Unit line of sight from the receiver, east, north, up. */
  readonly lineOfSight: readonly [number, number, number];
}

/** Every healthy satellite above the mask, with its elevation and azimuth at the receiver. */
export function visibleSatellites(almanac: readonly AlmanacSatellite[], receiver: ReceiverPosition, week: number, secondsOfWeek: number, maskRad: number): SatelliteView[] {
  const r = new Float64Array(3), s = new Float64Array(3);
  geodeticToEcefInto(receiver.latRad, receiver.lonRad, receiver.heightM, r);
  const sl = Math.sin(receiver.latRad), cl = Math.cos(receiver.latRad), so = Math.sin(receiver.lonRad), co = Math.cos(receiver.lonRad);
  const views: SatelliteView[] = [];
  for (const satellite of almanac) {
    if (satellite.health !== 0) continue;
    almanacEcefInto(satellite, week, secondsOfWeek, s);
    const dx = s[0]! - r[0]!, dy = s[1]! - r[1]!, dz = s[2]! - r[2]!, range = Math.hypot(dx, dy, dz);
    const east = (-so * dx + co * dy) / range, north = (-sl * co * dx - sl * so * dy + cl * dz) / range, up = (cl * co * dx + cl * so * dy + sl * dz) / range;
    const elevationRad = Math.asin(up);
    if (elevationRad < maskRad) continue;
    let azimuthRad = Math.atan2(east, north);
    if (azimuthRad < 0) azimuthRad += 2 * Math.PI;
    views.push({ prn: satellite.prn, elevationRad, azimuthRad, lineOfSight: [east, north, up] });
  }
  return views;
}

export interface Dilution { readonly gdop: number; readonly pdop: number; readonly hdop: number; readonly vdop: number; readonly tdop: number }
/** Q = (GᵀG)⁻¹ of the line-of-sight matrix, by Gauss–Jordan elimination with partial pivoting; null below four satellites or when singular. */
function covariance(lines: readonly (readonly [number, number, number])[]): number[] | null {
  if (lines.length < 4) return null;
  const m = new Array<number>(16).fill(0);
  for (const [e, n, u] of lines) {
    const row = [-e, -n, -u, 1];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) m[i * 4 + j] = m[i * 4 + j]! + row[i]! * row[j]!;
  }
  const inv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(m[r * 4 + c]!) > Math.abs(m[p * 4 + c]!)) p = r;
    const pivot = m[p * 4 + c]!;
    if (!(Math.abs(pivot) > 1e-12)) return null;
    for (let k = 0; k < 4; k++) {
      [m[c * 4 + k], m[p * 4 + k]] = [m[p * 4 + k]!, m[c * 4 + k]!];
      [inv[c * 4 + k], inv[p * 4 + k]] = [inv[p * 4 + k]!, inv[c * 4 + k]!];
    }
    for (let k = 0; k < 4; k++) { m[c * 4 + k] = m[c * 4 + k]! / pivot; inv[c * 4 + k] = inv[c * 4 + k]! / pivot; }
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = m[r * 4 + c]!;
      for (let k = 0; k < 4; k++) { m[r * 4 + k] = m[r * 4 + k]! - f * m[c * 4 + k]!; inv[r * 4 + k] = inv[r * 4 + k]! - f * inv[c * 4 + k]!; }
    }
  }
  return inv;
}
/** The dilutions of precision of a set of lines of sight; null below four satellites or for a degenerate geometry. */
export function dilution(lines: readonly (readonly [number, number, number])[]): Dilution | null {
  const q = covariance(lines);
  if (!q) return null;
  const e = q[0]!, n = q[5]!, u = q[10]!, t = q[15]!;
  return { gdop: Math.sqrt(e + n + u + t), pdop: Math.sqrt(e + n + u), hdop: Math.sqrt(e + n), vdop: Math.sqrt(u), tdop: Math.sqrt(t) };
}
/** The least-squares position error, m east, north, up, of range biases δρ (m, positive is a longer range); null as for `dilution`. */
export function positionError(lines: readonly (readonly [number, number, number])[], biasesM: readonly number[]): [number, number, number] | null {
  const q = covariance(lines);
  if (!q || biasesM.length !== lines.length) return null;
  const g = [0, 0, 0, 0];
  lines.forEach(([e, n, u], i) => { const b = biasesM[i]!; g[0] = g[0]! - e * b; g[1] = g[1]! - n * b; g[2] = g[2]! - u * b; g[3] = g[3]! + b; });
  const x = [0, 1, 2].map(i => q[i * 4]! * g[0]! + q[i * 4 + 1]! * g[1]! + q[i * 4 + 2]! * g[2]! + q[i * 4 + 3]! * g[3]!);
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
}
/** The receiver's position for a solution: geodetic, and its local east, north and height for the terrain. */
export interface GnssReceiver extends ReceiverPosition { readonly eastM: number; readonly northM: number }
export interface GnssSolution {
  /** Satellites above the mask, and those tracked after terrain and jamming. */
  readonly visible: number;
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

/**
 * One GNSS v2 solution at GPS time (week, seconds of week). With the constellation off it reports the satellites above 5° and
 * no error, as the other effects alone change nothing a stock SITL receiver could show without geometry.
 */
export function gnssSolution(almanac: readonly AlmanacSatellite[], receiver: GnssReceiver, week: number, secondsOfWeek: number, effects: GnssEffects): GnssSolution {
  const mask = effects.constellation?.maskRad ?? (5 * Math.PI) / 180;
  const views = visibleSatellites(almanac, receiver, week, secondsOfWeek, mask);
  const lines: (readonly [number, number, number])[] = [], biases: number[] = [];
  let nonLineOfSight = 0;
  const secondsOfDay = ((secondsOfWeek % 86400) + 86400) % 86400;
  for (const view of views) {
    let bias = 0;
    const terrain = effects.terrain;
    if (terrain && !lineOfSightClear(terrain.heightAt, receiver.eastM, receiver.northM, receiver.heightM, view)) {
      if (!(terrain.nlosExcessM > 0)) continue;
      bias += terrain.nlosExcessM;
      nonLineOfSight++;
    }
    const jamming = effects.jamming;
    if (jamming && effectiveCn0DbHz(openSkyCn0DbHz(view.elevationRad), jamming.jammingToSignalDb, jamming.spectralSeparation) < jamming.thresholdDbHz) continue;
    const atmosphere = effects.atmosphere;
    if (atmosphere) {
      bias += atmosphere.ionosphereResidual * SPEED_OF_LIGHT_MPS * klobucharDelayS(DEFAULT_KLOBUCHAR, receiver, view.elevationRad, view.azimuthRad, secondsOfDay);
      bias += atmosphere.troposphereResidual * saastamoinenDelayM(receiver, view.elevationRad);
    }
    lines.push(view.lineOfSight);
    biases.push(bias);
  }
  const d = dilution(lines), fix = d !== null;
  const error = fix ? positionError(lines, biases) ?? NO_ERROR : NO_ERROR;
  const sigma = effects.constellation?.uereM ?? null;
  return { visible: views.length, tracked: lines.length, nonLineOfSight, dilution: d, errorEnuM: error,
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
