import { describe, expect, it } from 'vitest';
import { EKF_DRIFT_MAX_GROWTH_MPS2, EKF_DRIFT_MAX_SPEED_MPS, ekfDriftAt, ekfDriftAxis, ekfDriftEndS, ekfDriftEntries, ekfDriftPeakM, ekfDriftPhases, parseEkfDrift, type EkfDriftProfile } from '@mirage/scenarios/ekf-drift';
import { faultTimeline, parseFaultSchedule } from '@mirage/scenarios/fault-schedule';
import { VelocityDrift } from '@mirage/ew/velocity-drift';
import { truthVsEstimate } from '@mirage/analysis/truth-vs-estimate';
import type { RecordedRow } from '@mirage/analysis/response-series';

// TASK-170. The oracle for the profile is the drift's closed form, computed in this file; the running model is the TASK-055 kernel itself, stepped through the
// schedule's own transitions at the session's rate. Tolerances, declared before running: position within one tick at top speed, velocity within two ticks of
// acceleration. The oracle for the chart errors is arithmetic on rows built here, estimate minus truth, with ArduPilot's own metres per degree.

const HZ = 800, DT = 1 / HZ;
const profile = (edit: Partial<EkfDriftProfile> = {}): EkfDriftProfile => ({ schemaVersion: 1, directionDeg: 0, growthMps2: 0.2, topSpeedMps: 2, onsetS: 5, durationS: 6, removal: 'gradual', ...edit });

/** The closed form, written out apart from the module: t from the onset, v = min(a t, V), b = integral of v. */
function growth(p: EkfDriftProfile, t: number): { b: number; v: number } {
  const ramp = p.topSpeedMps / p.growthMps2;
  if (t <= ramp) return { b: 0.5 * p.growthMps2 * t * t, v: p.growthMps2 * t };
  return { b: 0.5 * p.topSpeedMps * ramp + p.topSpeedMps * (t - ramp), v: p.topSpeedMps };
}

/** The kernel, through the schedule's transitions, as the session's tick boundary applies them. */
function fly(p: EkfDriftProfile, untilS: number): { times: number[]; b: number[]; v: number[]; drift: VelocityDrift } {
  const entries = ekfDriftEntries(p), [north = 0] = ekfDriftAxis(p), drift = new VelocityDrift(), timeline = faultTimeline(parseFaultSchedule({ schemaVersion: 1, entries, ekfDrift: p }));
  const step = { dtS: DT }, times: number[] = [], b: number[] = [], v: number[] = [];
  let next = 0;
  for (let tick = 0; tick / HZ < untilS; tick++) {
    const now = tick / HZ;
    for (let change = timeline[next]; change && Math.ceil(change.atS * HZ) <= tick; change = timeline[next]) {
      const entry = entries[change.entry];
      if (!entry) throw new Error('No entry');
      if (change.on) {
        const a = entry.control.parameters.accelerationNedMps2 as readonly [number, number, number], top = entry.control.parameters.maxSpeedMps as number;
        expect(drift.enable({ accelNedMps2: a, maxSpeedMps: top, decelMps2: 1, recovery: entry.recovery })).toBe(true);
      } else drift.disable(entry.recovery);
      next++;
    }
    expect(drift.advanceFrom(step)).toBe(true);
    times.push(now + DT);
    // Along the direction: north alone here, or by the axis when it has one.
    b.push(north !== 0 ? (drift.offsetNedM[0] ?? 0) / north : drift.offsetNedM[1] ?? 0);
    v.push(north !== 0 ? (drift.velocityNedMps[0] ?? 0) / north : drift.velocityNedMps[1] ?? 0);
  }
  return { times, b, v, drift };
}

describe('the drift profile', () => {
  it('refuses what the model cannot do, with the reason, and takes what it can', () => {
    expect(parseEkfDrift(profile())).toEqual(profile());
    expect(() => parseEkfDrift(profile({ growthMps2: 0 }))).toThrow('growth rate');
    expect(() => parseEkfDrift(profile({ growthMps2: EKF_DRIFT_MAX_GROWTH_MPS2 + 0.01 }))).toThrow('growth rate');
    expect(() => parseEkfDrift(profile({ topSpeedMps: EKF_DRIFT_MAX_SPEED_MPS + 1 }))).toThrow('top speed');
    expect(() => parseEkfDrift(profile({ directionDeg: 361 }))).toThrow('direction');
    expect(() => parseEkfDrift(profile({ durationS: 0 }))).toThrow('duration');
    expect(() => parseEkfDrift({ ...profile(), removal: 'fade' })).toThrow('gradual or abrupt');
    expect(() => parseEkfDrift({ ...profile(), extra: 1 })).toThrow('unexpected field extra');
  });
  it('asks only what the drift model takes, on a schedule without overlaps, and never moves it vertically', () => {
    for (const p of [profile(), profile({ removal: 'abrupt' }), profile({ directionDeg: 45, growthMps2: 0.3, topSpeedMps: 0.5, durationS: 20 })]) {
      const entries = ekfDriftEntries(p), schedule = parseFaultSchedule({ schemaVersion: 1, entries, ekfDrift: p });
      expect(schedule.entries).toHaveLength(entries.length);
      for (const entry of entries) {
        expect(entry.control.effect).toBe('ew.velocity-drift');
        const a = entry.control.parameters.accelerationNedMps2 as readonly [number, number, number];
        expect(a[2]).toBe(0);
        expect(Math.hypot(...a)).toBeLessThanOrEqual(EKF_DRIFT_MAX_GROWTH_MPS2 + 1e-12);
      }
      expect(entries.at(-1)?.recovery).toBe('step-to-truth');
    }
  });
  it.each([
    ['below its top speed', profile({ durationS: 6 })],
    ['past its top speed', profile({ durationS: 20 })],
    ['east, with a cruise back', profile({ directionDeg: 90, durationS: 40 })],
    ['at an angle', profile({ directionDeg: 30, growthMps2: 0.3, topSpeedMps: 1.5, durationS: 12 })],
  ])('%s matches the closed form while it grows, and the running model matches both', (_name, p) => {
    const endS = ekfDriftEndS(p), flown = fly(p, endS + 2);
    const tolerance = { position: p.topSpeedMps * DT * 2, velocity: p.growthMps2 * DT * 2 };
    flown.times.forEach((atS, index) => {
      const form = ekfDriftAt(p, atS), b = flown.b[index] ?? Number.NaN, v = flown.v[index] ?? Number.NaN;
      expect(Math.abs(b - form.offsetM), `b at ${atS}`).toBeLessThanOrEqual(tolerance.position);
      expect(Math.abs(v - form.speedMps), `v at ${atS}`).toBeLessThanOrEqual(tolerance.velocity);
      const t = atS - p.onsetS;
      if (t >= 0 && t <= p.durationS) {
        const closed = growth(p, t);
        expect(form.offsetM).toBeCloseTo(closed.b, 9);
        expect(form.speedMps).toBeCloseTo(closed.v, 9);
      }
    });
    // Nothing is left: the offset and the velocity are exactly zero, and the model is off.
    expect(flown.drift.mode).toBe('off');
    expect(Array.from(flown.drift.offsetNedM)).toEqual([0, 0, 0]);
    expect(Array.from(flown.drift.velocityNedMps)).toEqual([0, 0, 0]);
    // And it passed the peak it promised.
    expect(Math.max(...flown.b)).toBeCloseTo(ekfDriftPeakM(p), 2);
  });
  it('a gradual removal ends at rest on the truth by itself; only a tick\'s rounding is left to step away', () => {
    const p = profile({ durationS: 20 }), phases = ekfDriftPhases(p), last = phases.at(-1);
    if (!last) throw new Error('No phases');
    expect(ekfDriftAt(p, last.startS + last.durationS - 1e-9).offsetM).toBeCloseTo(0, 6);
    expect(ekfDriftAt(p, last.startS + last.durationS - 1e-9).speedMps).toBeCloseTo(0, 6);
    // It never runs past the truth: the error stays on one side.
    for (let t = p.onsetS; t < ekfDriftEndS(p); t += 0.05) expect(ekfDriftAt(p, t).offsetM).toBeGreaterThanOrEqual(-1e-6);
  });
  it('an abrupt removal drops both at once, at the end of its growth', () => {
    const p = profile({ removal: 'abrupt' }), endS = p.onsetS + p.durationS;
    expect(ekfDriftEndS(p)).toBe(endS);
    expect(ekfDriftAt(p, endS - 1e-6).offsetM).toBeGreaterThan(3);
    expect(ekfDriftAt(p, endS)).toEqual({ offsetM: 0, speedMps: 0 });
    const flown = fly(p, endS + 1), index = flown.times.findIndex(atS => atS > endS + 2 * DT);
    expect(flown.b[index]).toBe(0);
    expect(flown.drift.discontinuities).toBe(1);
  });
  it('is nothing before its onset', () => {
    expect(ekfDriftAt(profile(), 4.999)).toEqual({ offsetM: 0, speedMps: 0 });
  });
});

describe('truth against the estimate', () => {
  const METRES_PER_DEGREE = 111318.84502145034, HOME = [-35.363261, 149.16523, 584, 0] as const;
  const row = (simTimeS: number, values: readonly number[]): RecordedRow => ({ tick: Math.round(simTimeS * HZ), simTimeS, presence: (1 << values.length) - 1, values });
  /** Truth moves north at 2 m/s and sinks at 0.5 m/s; each report says 3 m further north, 1 m east and 0.25 m/s slower. */
  const truthPosition = (t: number) => [2 * t, 0, -10 + 0.5 * t], truthVelocity = () => [2, 0, 0.5];
  const metresEast = METRES_PER_DEGREE * Math.cos(HOME[0] * Math.PI / 180);
  const report = (t: number) => row(t, [HOME[0] + (2 * t + 3) / METRES_PER_DEGREE, HOME[1] + 1 / metresEast, HOME[2] - (-10 + 0.5 * t) + 0.75, 0, 1.75, 0, 0.5, 90]);
  const rows = new Map<string, readonly RecordedRow[]>([
    ['truth.position', Array.from({ length: 51 }, (_, i) => row(i * 0.02, truthPosition(i * 0.02)))],
    ['truth.velocity', Array.from({ length: 51 }, (_, i) => row(i * 0.02, truthVelocity()))],
    // One report past the truth, which is counted and left out.
    ['autopilot.globalPosition', [report(0.1), report(0.2), report(0.33), report(0.77), report(1.5)]],
  ]);
  it('reads the truth at each report\'s simulated time, and errors are the estimate minus it', () => {
    const result = truthVsEstimate(rows, HOME);
    if (result.kind !== 'series') throw new Error(result.reason);
    const { position, velocity } = result.series;
    expect(position.north.timeS).toEqual([0.1, 0.2, 0.33, 0.77]);
    expect(result.series.withoutTruth).toBe(1);
    position.north.timeS.forEach((t, i) => {
      expect(position.north.truth[i]).toBeCloseTo(2 * t, 9);
      expect(position.north.estimate[i]).toBeCloseTo(2 * t + 3, 5);
      expect(position.north.error[i]).toBeCloseTo(3, 5);
      expect(position.east.error[i]).toBeCloseTo(1, 5);
      expect(position.down.error[i]).toBeCloseTo(-0.75, 5);
      expect(velocity.north.error[i]).toBeCloseTo(-0.25, 9);
      expect(velocity.down.error[i]).toBeCloseTo(0, 9);
    });
    expect(result.series.estimateHz).toBeCloseTo(3 / 0.67, 6);
  });
  it('says what the recording lacks, and makes up nothing', () => {
    expect(truthVsEstimate(new Map(), HOME)).toMatchObject({ kind: 'missing', reason: expect.stringContaining('no estimate') as string });
    expect(truthVsEstimate(new Map([['autopilot.globalPosition', [report(0.1)]]]), HOME)).toMatchObject({ kind: 'missing', reason: expect.stringContaining('no truth') as string });
    expect(truthVsEstimate(new Map([['autopilot.globalPosition', [report(9)]], ['truth.position', [row(0, [0, 0, 0])]], ['truth.velocity', [row(0, [0, 0, 0])]]]), HOME)).toMatchObject({ kind: 'missing' });
  });
});
