import { describe, expect, it } from 'vitest';
import {
  CA_CHIP_RATE, GPS_EARTH_RATE_RADS, GPS_MU, almanacEcefInto, dilution, effectiveCn0DbHz, gnssSolution, klobucharDelayS, lineOfSightClear, positionError,
  saastamoinenDelayM, walkerConstellation, GNSS_WANDER_TAU_S, HorizontalWander, type AlmanacSatellite, type SatelliteView,
  CA_CHIP_LENGTH_M, GNSS_CODE_NOISE_STREAM, GNSS_MULTIPATH_STREAM, GNSS_SYSTEMS, GnssRangeProcess, dllJitterM, jammerCn0LossDb, multipathSigmaM, visibleSatellites,
} from '@mirage/sensors/gnss';
import { GNSS_SKY, GNSS_SKY_EPOCH } from '@mirage/sensors/gnss-sky';
import { freeSpaceLossL1Db, jammerReceivedPowerDbW } from '@mirage/ew/gnss-emitter';

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

  // SPECS_SIMULATION_ENGINES "Multi-GNSS broadcast sky", check 6, declared before the implementation.
  it('one clock per system: GPS at the zenith, north and south, Galileo at the zenith, east and west, by hand', () => {
    // GᵀG: east and north 2 each, apart; the block (up, clock G, clock E) [[2, −1, −1], [−1, 3, 0], [−1, 0, 3]], determinant 12, so
    // up 9/12, each clock 5/12. HDOP 1, VDOP √(3/4), PDOP √(7/4), GDOP √(1/2 + 1/2 + 3/4 + 5/12 + 5/12) = √(31/12). (The declaration
    // wrote √(8/3), an addition error in the hand case; the sum is 31/12.)
    const lines = [los(90 * deg, 0), los(0, 0), los(0, 180 * deg), los(90 * deg, 0), los(0, 90 * deg), los(0, 270 * deg)];
    const d = dilution(lines, [0, 0, 0, 1, 1, 1]);
    if (!d) throw new Error('No solution');
    near(d.hdop, 1); near(d.vdop, Math.sqrt(3 / 4)); near(d.pdop, Math.sqrt(7 / 4)); near(d.gdop, Math.sqrt(31 / 12));
    expect(d.clocks).toHaveLength(2);
    near(d.clocks[0]!, Math.sqrt(5 / 12)); near(d.clocks[1]!, Math.sqrt(5 / 12)); near(d.tdop, Math.sqrt(5 / 12));
    // Two clocks make five unknowns: four satellites give none.
    expect(dilution(lines.slice(0, 4), [0, 0, 0, 1])).toBeNull();
    // A clock index without a satellite leaves its column empty: singular.
    expect(dilution(STAR, [0, 0, 0, 2])).toBeNull();
  });

  it('a second system with one satellite leaves the position dilutions unchanged, and its own bias moves only its clock', () => {
    const one = dilution(STAR), two = dilution([...STAR, los(40 * deg, 75 * deg)], [0, 0, 0, 0, 1]);
    if (!one || !two) throw new Error('No solution');
    near(two.hdop, one.hdop); near(two.vdop, one.vdop); near(two.pdop, one.pdop); near(two.tdop, one.tdop);
    // One clock is the four-unknown arithmetic, bit for bit.
    expect(dilution(STAR, [0, 0, 0, 0])).toEqual(one);
    expect(positionError(STAR, [2.5, 0, 0, 0], [0, 0, 0, 0])).toEqual(positionError(STAR, [2.5, 0, 0, 0]));
    // A bias common to the Galileo satellites of the hand case goes into the Galileo clock alone.
    const lines = [los(90 * deg, 0), los(0, 0), los(0, 180 * deg), los(90 * deg, 0), los(0, 90 * deg), los(0, 270 * deg)];
    const error = positionError(lines, [0, 0, 0, 4.2, 4.2, 4.2], [0, 0, 0, 1, 1, 1]);
    for (const value of error ?? [NaN]) expect(Math.abs(value)).toBeLessThan(1e-9);
  });

  it('propagates an almanac orbit: a circular orbit stays at its radius, turning at its mean motion in an Earth-fixed frame', () => {
    const satellite: AlmanacSatellite = { system: 'G', prn: 1, health: 0, eccentricity: 0, toaS: 0, inclinationRad: 55 * deg, rateOfRightAscensionRadS: 0,
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
  const view = (elevationDeg: number, azimuthDeg = 90): SatelliteView => ({ system: 'G', prn: 1, elevationRad: elevationDeg * deg, azimuthRad: azimuthDeg * deg, lineOfSight: los(elevationDeg * deg, azimuthDeg * deg) });
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

describe('receiver noise, multipath and a placed jammer (declared 2026-11-09)', () => {
  // SPECS_SIMULATION_ENGINES "Receiver timing, tracking noise, multipath and jammers", checks 1 to 5, limits declared before the first run.
  const home = { latRad: -35.363261 * deg, lonRad: 149.16523 * deg, heightM: 584, eastM: 0, northM: 0 };
  const sky = { constellation: { maskRad: 10 * deg, uereM: 1.5 }, atmosphere: null, terrain: null, jamming: null };
  const week = GNSS_SKY_EPOCH.week, start = GNSS_SKY_EPOCH.secondsOfWeek;

  it('1. the DLL jitter and the multipath σ against their closed forms', () => {
    // Worked independently of the module: λ_c = 299792458/1.023e6, T = 20 ms, B_n 0.5 Hz, D 1 chip.
    for (const [cn0, sigma] of [[45, 0.825279], [40, 1.472569], [35, 2.646522], [28, 6.278575]] as const) {
      expect(Math.abs(dllJitterM(cn0, 0.5, 1) - sigma)).toBeLessThanOrEqual(1e-6);
    }
    expect(CA_CHIP_LENGTH_M).toBeCloseTo(293.0522561, 6);
    expect(dllJitterM(46, 0.5, 1)).toBeLessThan(dllJitterM(45, 0.5, 1));
    expect(dllJitterM(45, 0.5, 0.1)).toBeLessThan(dllJitterM(45, 0.5, 0.5));
    expect(dllJitterM(45, 0.5, 0.5)).toBeLessThan(dllJitterM(45, 0.5, 1));
    for (const [elevation, sigma] of [[0, 0.66], [10, 0.32498], [90, 0.130065]] as const) {
      expect(Math.abs(multipathSigmaM(elevation * deg, 0.13, 0.53, 10 * deg) - sigma)).toBeLessThanOrEqual(1e-5);
    }
  });

  it('2. each unit process is first-order Gauss–Markov of variance 1, repeated by its seed, and steps the same in batches', () => {
    for (const tauS of [0.5, 10]) {
      const process = new GnssRangeProcess(1, 117, GNSS_CODE_NOISE_STREAM), n = 1_000_000, phi = Math.exp(-0.2 / tauS);
      let sum = 0, square = 0, lagged = 0, previous = process.values[0]!;
      for (let i = 0; i < n; i++) {
        process.advance(1, phi);
        const x = process.values[0]!;
        sum += x; square += x * x; lagged += x * previous; previous = x;
      }
      const mean = sum / n, variance = square / n - mean * mean;
      expect(Math.abs(variance - 1), `τ ${tauS}`).toBeLessThan(0.05);
      expect(Math.abs((lagged / n - mean * mean) / variance - phi), `τ ${tauS}`).toBeLessThan(0.005);
    }
    const a = new GnssRangeProcess(121, 7, GNSS_MULTIPATH_STREAM), b = new GnssRangeProcess(121, 7, GNSS_MULTIPATH_STREAM), c = new GnssRangeProcess(121, 8, GNSS_MULTIPATH_STREAM);
    a.advance(10, 0.98);
    for (let i = 0; i < 10; i++) b.advance(1, 0.98);
    c.advance(10, 0.98);
    expect([...a.values]).toEqual([...b.values]);
    expect([...a.values]).not.toEqual([...c.values]);
    expect(() => new GnssRangeProcess(0, 1, 1)).toThrow('Invalid GNSS range process');
  });

  it('3. with every new effect absent or null a solution is the former one, bit for bit', () => {
    for (const t of [0, 3600, 20000]) {
      const former = gnssSolution(GNSS_SKY, home, week, start + t, { ...sky, atmosphere: { ionosphereResidual: 0.5, troposphereResidual: 0.1 } });
      const nulls = gnssSolution(GNSS_SKY, home, week, start + t, { ...sky, atmosphere: { ionosphereResidual: 0.5, troposphereResidual: 0.1 }, jammer: null, codeNoise: null, multipath: null });
      expect(nulls).toEqual(former);
      for (let i = 0; i < 3; i++) expect(Object.is(nulls.errorEnuM[i], former.errorEnuM[i])).toBe(true);
      expect(Object.is(nulls.accuracyM, former.accuracyM)).toBe(true);
    }
  });

  it('4. code noise reaches the least-squares solution with the variance its satellites\' σ give', () => {
    // B_n 10 Hz: τ = 25 ms against epochs of 0.2 s, so the unit process is white to e^(−8).
    const t = start + 7200, process = new GnssRangeProcess(GNSS_SKY.length, 2026, GNSS_CODE_NOISE_STREAM), phi = Math.exp(-0.2 / (1 / 40)), n = 200_000;
    const effects = { ...sky, codeNoise: { bandwidthHz: 10, spacingChips: 1, scale: 1, unit: process.values } };
    // The prediction: Σ σ_i²·x_i², x_i the error a unit bias on satellite i alone gives, from the views' own lines and clocks.
    const views = visibleSatellites(GNSS_SKY, home, week, t, 10 * deg);
    const present = GNSS_SYSTEMS.filter(system => views.some(view => view.system === system)), clocks = views.map(view => present.indexOf(view.system));
    const lines = views.map(view => view.lineOfSight);
    let eastVariance = 0, northVariance = 0;
    views.forEach((view, i) => {
      const unit = views.map((_, j) => (j === i ? 1 : 0)), x = positionError(lines, unit, clocks);
      if (!x) throw new Error('No solution');
      const sigma = dllJitterM(45 - 10 * (1 - Math.sin(view.elevationRad)), 10, 1);
      eastVariance += sigma * sigma * x[0] * x[0]; northVariance += sigma * sigma * x[1] * x[1];
    });
    let e = 0, ee = 0, nn = 0, no = 0;
    for (let i = 0; i < n; i++) {
      process.advance(1, phi);
      const [east, north] = gnssSolution(GNSS_SKY, home, week, t, effects).errorEnuM;
      e += east; ee += east * east; no += north; nn += north * north;
    }
    expect(Math.abs((ee / n - (e / n) ** 2) / eastVariance - 1)).toBeLessThan(0.03);
    expect(Math.abs((nn / n - (no / n) ** 2) / northVariance - 1)).toBeLessThan(0.03);
    expect(views.length).toBeGreaterThan(20);
  }, 300_000);

  it('5. a placed jammer: free-space power, one C/N0 loss for every satellite, and the fix lost on the way in', () => {
    const lambda = 299792458 / 1575.42e6, n0 = 10 * Math.log10(1.380649e-23 * 290);
    expect(Math.abs(freeSpaceLossL1Db(100) - 20 * Math.log10(4 * Math.PI * 100 / lambda))).toBeLessThanOrEqual(1e-9);
    expect(freeSpaceLossL1Db(0.2)).toBe(freeSpaceLossL1Db(1));
    const emitter = { positionNedM: [400, 0, -2] as const, eirpDbW: -48.8 };
    expect(Math.abs(jammerReceivedPowerDbW(emitter, 100, 0, -2) - (-48.8 - 20 * Math.log10(4 * Math.PI * 300 / lambda)))).toBeLessThanOrEqual(1e-9);
    for (const j of [-140, -130, -125]) {
      const loss = 10 * Math.log10(1 + 10 ** ((j - n0) / 10) / (1.5 * CA_CHIP_RATE));
      expect(Math.abs(jammerCn0LossDb(j, 1.5) - loss)).toBeLessThanOrEqual(1e-9);
      for (const open of [35, 40, 45]) expect(Math.abs(effectiveCn0DbHz(open, j - (open + n0), 1.5) - (open - loss))).toBeLessThanOrEqual(1e-9);
    }
    // Straight in from 1000 m at 10 m up, one solution per metre of range, the sky held at one moment.
    const t = start + 3600, clear = gnssSolution(GNSS_SKY, home, week, t, sky);
    let previous = Infinity, lostAtM: number | null = null;
    for (let range = 1000; range >= 20; range -= 1) {
      const j = jammerReceivedPowerDbW(emitter, 400 - range, 0, -10);
      const s = gnssSolution(GNSS_SKY, home, week, t, { ...sky, jammer: { receivedPowerDbW: j, spectralSeparation: 1.5, thresholdDbHz: 28 } });
      const d = Math.hypot(range, 8);
      expect(s.tracked, `${d} m`).toBeLessThanOrEqual(previous);
      previous = s.tracked;
      if (d > 350.2) expect(s.tracked, `${d} m`).toBe(clear.tracked);
      if (d < 100.1) expect(s.tracked, `${d} m`).toBe(0);
      if (!s.fix && lostAtM === null) lostAtM = d;
    }
    expect(lostAtM).not.toBeNull();
    expect(lostAtM ?? 0).toBeGreaterThan(100.1);
    expect(lostAtM ?? Infinity).toBeLessThan(350.2);
  });
});
