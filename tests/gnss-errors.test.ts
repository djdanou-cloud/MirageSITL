import { describe, expect, it } from 'vitest';
import {
  CA_CHIP_RATE, GPS_EARTH_RATE_RADS, GPS_MU, almanacEcefInto, dilution, effectiveCn0DbHz, gnssSolution, klobucharDelayS, lineOfSightClear, positionError,
  saastamoinenDelayM, walkerConstellation, GNSS_WANDER_TAU_S, HorizontalWander, type AlmanacSatellite, type SatelliteView,
} from '@mirage/sensors/gnss';

// TASK-117: the GNSS v2 building blocks against closed forms worked by hand. Tolerances, declared before the first run: 1e-9
// relative for the arithmetic of a formula, 1e-6 m for an orbit position (a few operations on 26,000 km).

const deg = Math.PI / 180;
const los = (elevation: number, azimuth: number): [number, number, number] =>
  [Math.cos(elevation) * Math.sin(azimuth), Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation)];
/** One satellite at the zenith and three on the horizon 120° apart. */
const STAR = [los(90 * deg, 0), los(0, 0), los(0, 120 * deg), los(0, 240 * deg)];
const near = (actual: number, expected: number, relative = 1e-9) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(relative * Math.max(1, Math.abs(expected)));

describe('geometry', () => {
  it('dilutions of a zenith satellite and three on the horizon: HDOP = VDOP = √(4/3), TDOP = √(1/3), GDOP = √3', () => {
    // GᵀG: east and north 1.5 each; up 1, clock 4, up–clock −1. Its inverse: 2/3, 2/3, and (1/3)·[[4, 1], [1, 1]].
    const d = dilution(STAR);
    if (!d) throw new Error('No solution');
    near(d.hdop, Math.sqrt(4 / 3)); near(d.vdop, Math.sqrt(4 / 3)); near(d.tdop, Math.sqrt(1 / 3)); near(d.gdop, Math.sqrt(3)); near(d.pdop, Math.sqrt(8 / 3));
    expect(dilution(STAR.slice(0, 3))).toBeNull();
    // Four satellites on one cone leave height and clock inseparable.
    expect(dilution([los(30 * deg, 0), los(30 * deg, 90 * deg), los(30 * deg, 180 * deg), los(30 * deg, 270 * deg)])).toBeNull();
  });

  it('a bias every range shares goes into the clock; a bias on the zenith satellite alone moves the fix down by that much', () => {
    const common = positionError(STAR, [7, 7, 7, 7]);
    for (const value of common ?? [NaN]) expect(Math.abs(value)).toBeLessThan(1e-12);
    const zenith = positionError(STAR, [2.5, 0, 0, 0]);
    near(zenith?.[0] ?? NaN, 0); near(zenith?.[1] ?? NaN, 0); near(zenith?.[2] ?? NaN, -2.5);
    expect(positionError(STAR, [1, 2])).toBeNull();
  });

  it('propagates an almanac orbit: a circular orbit stays at its radius, turning at its mean motion in an Earth-fixed frame', () => {
    const satellite: AlmanacSatellite = { prn: 1, health: 0, eccentricity: 0, toaS: 0, inclinationRad: 55 * deg, rateOfRightAscensionRadS: 0,
      sqrtA: 5153.795, rightAscensionRad: 0.3, argumentOfPerigeeRad: 0, meanAnomalyRad: 0.2, week: 2400 };
    const a = 5153.795 ** 2, n = Math.sqrt(GPS_MU / a ** 3), out = new Float64Array(3);
    for (const t of [0, 3600, 43082]) {
      almanacEcefInto(satellite, 2400, t, out);
      expect(Math.abs(Math.hypot(out[0]!, out[1]!, out[2]!) - a)).toBeLessThan(1e-6);
      // Independently: R3(−Ω)·R1(−i)·[a cos u, a sin u, 0] with u = M0 + n·t and Ω = Ω0 − ω_e·t.
      const u = 0.2 + n * t, node = 0.3 - GPS_EARTH_RATE_RADS * t, i = 55 * deg;
      const x = a * Math.cos(u), y = a * Math.sin(u) * Math.cos(i), z = a * Math.sin(u) * Math.sin(i);
      expect(Math.abs(out[0]! - (x * Math.cos(node) - y * Math.sin(node)))).toBeLessThan(1e-6);
      expect(Math.abs(out[1]! - (x * Math.sin(node) + y * Math.cos(node)))).toBeLessThan(1e-6);
      expect(Math.abs(out[2]! - z)).toBeLessThan(1e-6);
    }
    // A GPS orbit of 26,560 km takes half a sidereal day: 43,082 s.
    expect(2 * Math.PI / n).toBeCloseTo(43082, -1);
  });
});

describe('atmosphere and jamming', () => {
  const klobuchar = { alpha: [1.1176e-8, 7.4506e-9, -5.9605e-8, -5.9605e-8] as [number, number, number, number],
    beta: [90112, 0, -196610, -65536] as [number, number, number, number] };
  it('Klobuchar: at night only the 5 ns floor, times the obliquity F = 1 + 16·(0.53 − E)³', () => {
    const zenith = klobucharDelayS(klobuchar, { latRad: 0, lonRad: 0, heightM: 0 }, 90 * deg, 0, 0);
    near(zenith, (1 + 16 * 0.03 ** 3) * 5e-9);
    const low = klobucharDelayS(klobuchar, { latRad: 0, lonRad: 0, heightM: 0 }, 10 * deg, 0, 0);
    near(low, (1 + 16 * (0.53 - 10 / 180) ** 3) * 5e-9);
  });
  it('Klobuchar: at 14:00 local time at the pierce point the cosine term is at its peak, the floor plus the amplitude', () => {
    // At the zenith over (0, 0): ψ = 0.0137/0.61 − 0.022, the pierce point is the receiver, φ_m = 0.064·cos(−1.617π).
    const phiM = 0.064 * Math.cos(-1.617 * Math.PI), a = klobuchar.alpha;
    const amplitude = a[0] + phiM * (a[1] + phiM * (a[2] + phiM * a[3]));
    near(klobucharDelayS(klobuchar, { latRad: 0, lonRad: 0, heightM: 0 }, 90 * deg, 0, 50400), (1 + 16 * 0.03 ** 3) * (5e-9 + amplitude));
  });
  it('Saastamoinen: 2.3070 m dry at the zenith at sea level and 45°, and 1/sin(el) away from it', () => {
    const sea = { latRad: 45 * deg, lonRad: 0, heightM: 0 };
    near(saastamoinenDelayM(sea, 90 * deg, 0), 0.0022768 * 1013.25, 1e-12);
    near(saastamoinenDelayM(sea, 30 * deg, 0), 2 * 0.0022768 * 1013.25);
    expect(saastamoinenDelayM(sea, 90 * deg)).toBeGreaterThan(2.3);
    expect(saastamoinenDelayM(sea, 0)).toBe(0);
  });
  it('jamming: 45 dB-Hz under 40 dB J/S with Q = 1 leaves 20.08 dB-Hz', () => {
    const expected = -10 * Math.log10(1 / 10 ** 4.5 + 1e4 / CA_CHIP_RATE);
    near(effectiveCn0DbHz(45, 40, 1), expected);
    expect(effectiveCn0DbHz(45, 40, 1)).toBeCloseTo(20.08, 2);
    // No jamming leaves C/N0 as it is.
    near(effectiveCn0DbHz(45, -200, 1), 45);
  });
});

describe('terrain', () => {
  // A ridge 50 m high from 100 m to 110 m east of the receiver, which stands on flat ground at height 0.
  const ridge = (east: number): number => (east >= 100 && east <= 110 ? 50 : 0);
  const view = (elevationDeg: number, azimuthDeg = 90): SatelliteView => ({ prn: 1, elevationRad: elevationDeg * deg, azimuthRad: azimuthDeg * deg, lineOfSight: los(elevationDeg * deg, azimuthDeg * deg) });
  it('hides a satellite at 20° behind it (36.4 m at 100 m) and not one at 30° (57.7 m), nor one in another direction', () => {
    expect(lineOfSightClear(ridge, 0, 0, 0, view(20))).toBe(false);
    expect(lineOfSightClear(ridge, 0, 0, 0, view(30))).toBe(true);
    expect(lineOfSightClear(ridge, 0, 0, 0, view(5, 270))).toBe(true);
    // Without terrain data nothing is hidden.
    expect(lineOfSightClear(() => Number.NaN, 0, 0, 0, view(1))).toBe(true);
  });
});

describe('a solution on the synthetic constellation', () => {
  const almanac = walkerConstellation(2400);
  const receiver = { latRad: -35.363261 * deg, lonRad: 149.16523 * deg, heightM: 584, eastM: 0, northM: 0 };
  const none = { constellation: null, atmosphere: null, terrain: null, jamming: null };
  const sky = { ...none, constellation: { maskRad: 10 * deg, uereM: 1.5 } };
  const at = (secondsOfWeek: number, effects: Parameters<typeof gnssSolution>[4] = sky) => gnssSolution(almanac, receiver, 2400, secondsOfWeek, effects);
  it('sees four to twelve of the 24 satellites above 10° through a day, every one with a fix and no error of its own', () => {
    for (let t = 0; t < 86400; t += 3600) {
      const s = at(t);
      expect(s.visible, `t ${t}`).toBeGreaterThanOrEqual(4);
      expect(s.visible).toBeLessThanOrEqual(12);
      expect(s.fix).toBe(true);
      expect(s.errorEnuM).toEqual([0, 0, 0]);
      // The accuracy the receiver reports is σ·HDOP.
      expect(s.accuracyM).toBeCloseTo(1.5 * (s.dilution?.hdop ?? NaN), 12);
    }
    expect(almanac).toHaveLength(24);
  });
  it('the atmosphere\'s residual moves the fix, mostly up and down, and in proportion to the residual', () => {
    const half = at(43200, { ...sky, atmosphere: { ionosphereResidual: 0.5, troposphereResidual: 0.1 } });
    const full = at(43200, { ...sky, atmosphere: { ionosphereResidual: 1, troposphereResidual: 0.2 } });
    expect(Math.abs(half.errorEnuM[2])).toBeGreaterThan(Math.hypot(half.errorEnuM[0], half.errorEnuM[1]));
    for (let i = 0; i < 3; i++) expect(full.errorEnuM[i]!).toBeCloseTo(2 * half.errorEnuM[i]!, 9);
    expect(at(43200, { ...sky, atmosphere: { ionosphereResidual: 0, troposphereResidual: 0 } }).errorEnuM).toEqual([0, 0, 0].map(() => expect.closeTo(0, 12) as unknown));
  });
  it('a wall to the east hides the eastern sky: lost, or tracked as non-line-of-sight with its excess path', () => {
    const wall = (east: number) => (east > 20 && east < 40 ? 2000 : 0);
    const open = at(7200);
    const lost = at(7200, { ...sky, terrain: { heightAt: wall, nlosExcessM: 0 } });
    expect(lost.tracked).toBeLessThan(open.tracked);
    const reflected = at(7200, { ...sky, terrain: { heightAt: wall, nlosExcessM: 30 } });
    expect(reflected.tracked).toBe(open.tracked);
    expect(reflected.nonLineOfSight).toBe(open.tracked - lost.tracked);
    expect(Math.hypot(...reflected.errorEnuM)).toBeGreaterThan(1);
  });
  it('jamming above the link budget loses every satellite and the fix; below it nothing changes', () => {
    const jammed = at(7200, { ...sky, jamming: { jammingToSignalDb: 60, spectralSeparation: 1.5, thresholdDbHz: 28 } });
    expect([jammed.tracked, jammed.fix, jammed.accuracyM]).toEqual([0, false, null]);
    const quiet = at(7200, { ...sky, jamming: { jammingToSignalDb: 0, spectralSeparation: 1.5, thresholdDbHz: 28 } });
    expect(quiet.tracked).toBe(at(7200).tracked);
  });
});

describe('the horizontal wander of the Sensors tab (mapping 4)', () => {
  // Declared before the first run: over 1,000,000 steps of 0.2 s (55 hours, 3,333 correlation times) the variance within 5 % of σ²
  // and the lag-one correlation within 0.005 of e^(−0.2/60), each axis; the same seed gives the same wander, bit for bit.
  it('is a first-order Gauss–Markov process of standard deviation σ and correlation time 60 s, repeated by its seed', () => {
    expect(GNSS_WANDER_TAU_S).toBe(60);
    const wander = new HorizontalWander(2.5, 42), n = 1_000_000, dt = 0.2;
    const sums = [0, 0], squares = [0, 0], lagged = [0, 0], previous = [wander.errorEnM[0]!, wander.errorEnM[1]!];
    for (let i = 0; i < n; i++) {
      wander.step(dt);
      for (let axis = 0; axis < 2; axis++) {
        const x = wander.errorEnM[axis]!;
        sums[axis]! += x; squares[axis]! += x * x; lagged[axis]! += x * previous[axis]!; previous[axis] = x;
      }
    }
    for (let axis = 0; axis < 2; axis++) {
      const mean = sums[axis]! / n, variance = squares[axis]! / n - mean * mean;
      expect(Math.abs(variance / 6.25 - 1)).toBeLessThan(0.05);
      expect(Math.abs((lagged[axis]! / n - mean * mean) / variance - Math.exp(-dt / 60))).toBeLessThan(0.005);
    }
    const a = new HorizontalWander(2.5, 7), b = new HorizontalWander(2.5, 7), c = new HorizontalWander(2.5, 8);
    for (let i = 0; i < 100; i++) { a.step(0.2); b.step(0.2); c.step(0.2); }
    expect([...a.errorEnM]).toEqual([...b.errorEnM]);
    expect([...a.errorEnM]).not.toEqual([...c.errorEnM]);
    // Zero σ stays at zero; a bad σ is refused.
    const still = new HorizontalWander(0, 1);
    still.step(1);
    expect([...still.errorEnM].every(value => value === 0)).toBe(true);
    expect(() => new HorizontalWander(-1, 1)).toThrow('Invalid GNSS wander');
  });
});
