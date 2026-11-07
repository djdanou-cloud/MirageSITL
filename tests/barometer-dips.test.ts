import { describe, expect, it } from 'vitest';
import { readDataFlash } from '../packages/dataflash/src/reader.ts';
import { DIP_METHOD, fitGroundCushion, inducedPressurePa, measureBarometerDips, predictNearGroundPa, withinDipTolerance,
  type DipAircraft } from '../packages/analysis/src/barometer-dips.ts';
import { syntheticLog, type SyntheticMessage, type SyntheticValue } from './support/synthetic-log.ts';

// TASK-116: the logged-dip measurement against flights built here, whose excess pressure is known in closed form. Declared before the
// implementation, with float32 storage as the only error (pressure near 1e5 Pa stored to 0.008 Pa, heights to 1e-5 m):
//  - a landing whose barometer reads q_i·(k·exp(−h/(λR)) + c) above the static pressure of its GNSS height gives that excess at every
//    motors-on sample within 0.02 Pa, the near-ground mean of the samples below 0.3 m, and a reference noise of 0;
//  - the fit to it recovers λ on the grid exactly and k and c within 1e-3 (half a float32 step of 95,000 Pa is 0.004 Pa, 2.7e-4 of
//    q_i per sample; 1e-4, first written here, ignored that), and the model's own prediction (BarometerErrors) of the
//    near-ground mean equals the measured one within 0.02 Pa;
//  - a stop with the motors running again within the reference window, and a stop 3 m above the ground, are skipped with their reasons,
//    and so is a spin-up that never leaves the ground (a rule added after the first run on the real logs);
//  - the declared tolerance is 5 Pa or 30 %, whichever is larger;
//  - with the rangefinder as the height source (declared 2026-11-07), the same landing measured against RFND.Dist (status 4) gives
//    the same excess within 0.02 Pa, and barometer samples farther than 0.25 s from a good reading are left out.
const MESSAGES: readonly SyntheticMessage[] = [
  { type: 70, name: 'CTUN', format: 'Qf', columns: ['TimeUS', 'ThO'] },
  { type: 71, name: 'BARO', format: 'QBf', columns: ['TimeUS', 'I', 'Press'] },
  { type: 72, name: 'GPS', format: 'QBf', columns: ['TimeUS', 'I', 'Alt'] },
  { type: 73, name: 'RFND', format: 'QBfB', columns: ['TimeUS', 'Instance', 'Dist', 'Stat'] },
];
const AIRCRAFT: DipAircraft = { massKg: 7, rotorCount: 4, rotorRadiusM: 0.3048 };
const { min, max, count } = DIP_METHOD.decayGrid;
const LAMBDA = min * (max / min) ** (80 / (count - 1)), GAIN = 2, WASH = -0.3;
const P0 = 95000, H0 = 500, RHO_G = P0 / (287.05 * 288.15) * 9.80665;

/** A descent from 5 m to the ground at 0.5 m/s ending at t = 30 s, motors stopping at 30 s, then 10 s on the ground. */
function landing(options: { restartAtS?: number; groundM?: number; groundOnly?: boolean; rangefinderOutS?: readonly [number, number] } = {}): Uint8Array {
  const rows: { message: string; values: SyntheticValue[] }[] = [];
  const q = inducedPressurePa(AIRCRAFT)!, ground = options.groundM ?? 0;
  const height = (t: number) => (options.groundOnly ? 0 : t < 20 ? 5 : t < 30 ? 5 - 0.5 * (t - 20) : 0) + ground;
  const on = (t: number) => t < 30 || (options.restartAtS !== undefined && t >= options.restartAtS);
  for (let k = 0; k <= 4000; k++) {
    const t = k * 0.01, us = Math.round(t * 1e6);
    if (k % 10 === 0) rows.push({ message: 'CTUN', values: [us, on(t) ? 0.35 : 0] });
    if (k % 5 === 0) {
      const h = height(t), excess = on(t) && t > 1 ? q * (GAIN * Math.exp(-(h - ground) / (LAMBDA * AIRCRAFT.rotorRadiusM)) + WASH) : 0;
      rows.push({ message: 'BARO', values: [us + 1, 0, P0 - RHO_G * h + excess] });
    }
    if (k % 20 === 0) rows.push({ message: 'GPS', values: [us + 2, 0, H0 + height(t)] });
    // The rangefinder reads the height above its landed reading of 0.02 m; out of range (status 1) in rangefinderOutS.
    const out = options.rangefinderOutS && t >= options.rangefinderOutS[0] && t < options.rangefinderOutS[1];
    if (k % 5 === 0) rows.push({ message: 'RFND', values: [us + 3, 0, 0.02 + height(t), out ? 1 : 4] });
  }
  return syntheticLog(MESSAGES, rows);
}

describe('logged barometer dips', () => {
  it('measures a landing\'s excess against the GNSS height, fits the cushion and predicts it with the model itself', () => {
    const measured = measureBarometerDips(readDataFlash(landing()), AIRCRAFT);
    const q = measured.inducedPressurePa!;
    expect(q).toBeCloseTo(7 * 9.80665 / (4 * 4 * Math.PI * 0.3048 ** 2), 12);
    expect(measured.skipped).toEqual([]);
    expect(measured.events).toHaveLength(1);
    const [event] = measured.events;
    expect(event!.kind).toBe('landing');
    expect(event!.motorTimeS).toBeCloseTo(29.9, 6);
    expect(event!.noisePa).toBeLessThan(0.02);
    expect(event!.samples.length).toBeGreaterThan(250);
    for (const s of event!.samples) {
      const expected = q * (GAIN * Math.exp(-Math.max(0, s.heightM) / (LAMBDA * AIRCRAFT.rotorRadiusM)) + WASH);
      expect(Math.abs(s.deltaPa - expected)).toBeLessThan(0.02);
    }
    const near = event!.samples.filter(s => s.heightM < 0.3);
    expect(event!.nearGroundSamples).toBe(near.length);
    expect(event!.nearGroundPa).toBeCloseTo(near.reduce((sum, s) => sum + s.deltaPa, 0) / near.length, 9);
    const fit = fitGroundCushion(measured.events, AIRCRAFT);
    expect(fit.decayRadii).toBeCloseTo(LAMBDA, 12);
    expect(Math.abs(fit.gain - GAIN)).toBeLessThan(1e-3);
    expect(Math.abs(fit.washCoefficient - WASH)).toBeLessThan(1e-3);
    expect(fit.rmsPa).toBeLessThan(0.02);
    const predicted = predictNearGroundPa(event!, fit, AIRCRAFT)!;
    expect(Math.abs(predicted - event!.nearGroundPa!)).toBeLessThan(0.02);
    expect(withinDipTolerance(event!.nearGroundPa!, predicted)).toBe(true);
  });

  it('skips a stop whose reference window has the motors running, or that is not on the ground', () => {
    const restarted = measureBarometerDips(readDataFlash(landing({ restartAtS: 33 })), AIRCRAFT);
    expect(restarted.events.filter(e => e.kind === 'landing')).toEqual([]);
    expect(restarted.skipped[0]?.kind).toBe('landing');
    expect(restarted.skipped[0]?.motorTimeS).toBeCloseTo(29.9, 6);
    expect(restarted.skipped[0]?.reason).toBe('the motors run in the motors-off window');
    // A takeoff at 33 s has its motors-off window from 28.5 s, while they still run.
    expect(restarted.skipped.map(s => s.kind)).toEqual(['landing', 'takeoff']);
    const high = measureBarometerDips(readDataFlash(syntheticAloft()), AIRCRAFT);
    expect(high.events).toEqual([]);
    expect(high.skipped[0]?.reason).toBe('the GNSS height at the motor stop is 3.00 m from the motors-off reference, not on the ground');
    const ground = measureBarometerDips(readDataFlash(landing({ groundOnly: true })), AIRCRAFT);
    expect(ground.events).toEqual([]);
    expect(ground.skipped.map(s => s.reason)).toEqual(['the vehicle stayed below 1 m within 15 s of the motor stop: a spin-up on the ground, not a flight']);
  });

  it('measures the same landing against the rangefinder, leaving out samples without a good reading nearby', () => {
    const gnss = measureBarometerDips(readDataFlash(landing()), AIRCRAFT).events[0]!;
    const ranged = measureBarometerDips(readDataFlash(landing()), AIRCRAFT, 'rangefinder').events[0]!;
    expect(ranged.samples.length).toBe(gnss.samples.length);
    ranged.samples.forEach((s, i) => {
      // The GNSS altitude near 505 m is stored to half a float32 step, 1.5e-5 m.
      expect(Math.abs(s.heightM - gnss.samples[i]!.heightM)).toBeLessThan(2e-5);
      expect(Math.abs(s.deltaPa - gnss.samples[i]!.deltaPa)).toBeLessThan(0.02);
    });
    // Out of range from 25 s to 26 s: the good readings around the gap are at 24.95 s and 26.00 s, so barometer samples more than
    // 0.25 s from both, from 25.25 s to 25.75 s, are left out.
    const gap = measureBarometerDips(readDataFlash(landing({ rangefinderOutS: [25, 26] })), AIRCRAFT, 'rangefinder').events[0]!;
    const dropped = gnss.samples.filter(s => s.timeS - 24.950003 > 0.25 && 26.000003 - s.timeS > 0.25).length;
    expect(dropped).toBe(11);
    expect(gap.samples.length).toBe(gnss.samples.length - dropped);
    expect(gap.samples.some(s => s.timeS > 25.24 && s.timeS < 25.76)).toBe(false);
  });

  it('applies the declared tolerance: 5 Pa or 30 %, whichever is larger', () => {
    expect(withinDipTolerance(10, 15)).toBe(true);
    expect(withinDipTolerance(10, 15.01)).toBe(false);
    expect(withinDipTolerance(40, 52)).toBe(true);
    expect(withinDipTolerance(40, 52.01)).toBe(false);
    expect(withinDipTolerance(-20, -26)).toBe(true);
  });
});

/** Motors stop at 30 s while the GNSS height is 3 m above where it then settles 1 s later (a drop after the stop). */
function syntheticAloft(): Uint8Array {
  const rows: { message: string; values: SyntheticValue[] }[] = [];
  for (let k = 0; k <= 4000; k++) {
    const t = k * 0.01, us = Math.round(t * 1e6), h = t < 30.5 ? 3 : 0;
    if (k % 10 === 0) rows.push({ message: 'CTUN', values: [us, t < 30 ? 0.35 : 0] });
    if (k % 5 === 0) rows.push({ message: 'BARO', values: [us + 1, 0, P0 - RHO_G * h] });
    if (k % 20 === 0) rows.push({ message: 'GPS', values: [us + 2, 0, H0 + h] });
  }
  return syntheticLog(MESSAGES, rows);
}
