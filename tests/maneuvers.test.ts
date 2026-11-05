import { describe, expect, test } from 'vitest';
import { GroundStation } from '@mirage/autopilot/ground-station';
import { taskCommandInto } from '@mirage/autopilot/guided';
import { MavParser, type MavFrame } from '@mirage/mavlink/codec';
import {
  FlightTaskRunner, flightTaskProblems, flightTaskSchemaVersion, parseFlightTask, planFlightTask, wrapDeg,
  type AttitudeTarget, type AutopilotModeName, type FlightTaskCommand, type FlightTaskDefinition, type FlightTaskStep, type FlightTaskType, type GuidanceLimits, type GuidedTarget,
} from '@mirage/scenarios/flight-tasks';
import {
  BASELINE_S, MANEUVER_TYPES, attitudeManeuverRefusal, edgeResponse, edgesOf, eulerDegOf, isManeuverType, maneuverResponse, maneuverTimeline, offsetAt, unwrapDeg, type ManeuverEdge, type ResponseSeries,
} from '@mirage/scenarios/maneuvers';
import { formOf, formProblems, newTaskForm, parameterLabel, planLines, taskOfForm } from '../apps/web/src/tasks/flight-task-form.ts';

// The fixture is the unit-step response of a second-order system, in closed form. The oracle
// for overshoot is its formula; the oracles for rise and settling are found here by bisecting
// that same closed form, and never read the implementation. Tolerances were set before the
// implementation, from the error of linear interpolation between samples, ω²h²/8 divided by the
// slope at the crossing, plus a margin: h = 1 ms and 20 ms against ω up to 12 rad/s.
const TOLERANCE = {
  1000: { riseS: 1e-4, settleS: 1e-4, overshootPoints: 0.01, delayS: 1e-4 },
  50: { riseS: 3e-3, settleS: 5e-3, overshootPoints: 0.2, delayS: 3e-3 },
} as const;

/** y(t) of ÿ + 2ζω ẏ + ω² y = ω², from rest, for t ≥ 0. */
function secondOrder(zeta: number, omega: number): (t: number) => number {
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta), ratio = zeta / Math.sqrt(1 - zeta * zeta);
    return t => 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ratio * Math.sin(damped * t));
  }
  if (zeta === 1) return t => 1 - Math.exp(-omega * t) * (1 + omega * t);
  const root = omega * Math.sqrt(zeta * zeta - 1), a = -zeta * omega + root, b = -zeta * omega - root;
  return t => 1 - (b * Math.exp(a * t) - a * Math.exp(b * t)) / (b - a);
}
/** The moment `y` crosses `level` between two times that bracket it. */
function bisect(y: (t: number) => number, level: number, low: number, high: number): number {
  let a = low, b = high;
  const rising = y(b) > y(a);
  for (let i = 0; i < 80; i++) {
    const middle = (a + b) / 2;
    if ((y(middle) < level) === rising) a = middle; else b = middle;
  }
  return (a + b) / 2;
}
const firstCrossing = (y: (t: number) => number, level: number, end: number): number => {
  for (let t = 0; t < end; t += 1e-4) if (y(t + 1e-4) >= level) return bisect(y, level, t, t + 1e-4);
  throw new Error(`The fixture never reaches ${level}`);
};
const lastOutside = (y: (t: number) => number, band: number, end: number): number => {
  for (let t = end; t > 0; t -= 1e-4) if (Math.abs(y(t - 1e-4) - 1) > band) return bisect(t2 => Math.abs(y(t2) - 1), band, t - 1e-4, t);
  return 0;
};
/** Samples value(t) from startS to endS at `hz`, on a grid that does not fall on any edge. */
function sampled(hz: number, startS: number, endS: number, value: (t: number) => number): ResponseSeries {
  const timeS: number[] = [], values: number[] = [];
  for (let i = 0; ; i++) {
    const t = startS + (i + 0.37) / hz;
    if (t > endS) break;
    timeS.push(t);
    values.push(value(t));
  }
  return { timeS, value: values };
}

describe('the response of one edge against an analytic second-order system', () => {
  // [ζ, ω rad/s]: underdamped at three dampings, critically damped, overdamped.
  const SYSTEMS = [[0.3, 8], [0.5, 10], [0.7, 12], [1, 6], [1.5, 6]] as const;
  const RATES = [1000, 50] as const;
  for (const [zeta, omega] of SYSTEMS) {
    for (const hz of RATES) {
      for (const band of [0.05, 0.02]) {
        test(`ζ ${zeta}, ω ${omega} rad/s, ${hz} Hz, band ${band * 100} %`, () => {
          const y = secondOrder(zeta, omega), edgeS = 2, deadS = 0.03, windowS = 8, amplitude = 10, from = 3, to = from + amplitude;
          const actual = sampled(hz, 0, edgeS + windowS, t => from + amplitude * (t <= edgeS + deadS ? 0 : y(t - edgeS - deadS)));
          const result = edgeResponse(actual, { timeS: edgeS, from, to }, edgeS + windowS, band);

          const t10 = firstCrossing(y, 0.1, windowS), t90 = firstCrossing(y, 0.9, windowS);
          const tolerance = TOLERANCE[hz];
          expect(result.missing).toBeNull();
          expect(Math.abs((result.delayS ?? Number.NaN) - (deadS + t10))).toBeLessThanOrEqual(tolerance.delayS);
          expect(Math.abs((result.riseTimeS ?? Number.NaN) - (t90 - t10))).toBeLessThanOrEqual(tolerance.riseS);
          const overshoot = zeta < 1 ? 100 * Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta)) : 0;
          expect(Math.abs((result.overshootPercent ?? Number.NaN) - overshoot)).toBeLessThanOrEqual(tolerance.overshootPoints);
          const settle = deadS + lastOutside(y, band, windowS - deadS);
          expect(Math.abs((result.settlingTimeS ?? Number.NaN) - settle)).toBeLessThanOrEqual(tolerance.settleS);
          expect(Math.abs(result.endError ?? Number.NaN)).toBeLessThanOrEqual(1e-3);
        });
      }
    }
  }
  test('the peak is where the formula puts it', () => {
    const zeta = 0.5, omega = 10, y = secondOrder(zeta, omega), edgeS = 2;
    const actual = sampled(1000, 0, 8, t => (t <= edgeS ? 0 : 10 * y(t - edgeS)));
    const result = edgeResponse(actual, { timeS: edgeS, from: 0, to: 10 }, 8, 0.05);
    // tp = π/ωd, and the peak is 1 + overshoot.
    const peakAtS = Math.PI / (omega * Math.sqrt(1 - zeta * zeta));
    expect(Math.abs((result.peakTimeS ?? Number.NaN) - (edgeS + peakAtS))).toBeLessThanOrEqual(1e-3);
    expect(Math.abs((result.peak ?? Number.NaN) - 10 * (1 + Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta))))).toBeLessThanOrEqual(1e-3);
  });
  test('a step down gives the same numbers as a step up', () => {
    const y = secondOrder(0.5, 10), edgeS = 2;
    const up = edgeResponse(sampled(1000, 0, 8, t => 15 + 10 * (t <= edgeS ? 0 : y(t - edgeS))), { timeS: edgeS, from: 15, to: 25 }, 8, 0.05);
    const down = edgeResponse(sampled(1000, 0, 8, t => 15 - 10 * (t <= edgeS ? 0 : y(t - edgeS))), { timeS: edgeS, from: 15, to: 5 }, 8, 0.05);
    expect(down.riseTimeS).toBeCloseTo(up.riseTimeS ?? Number.NaN, 9);
    expect(down.overshootPercent).toBeCloseTo(up.overshootPercent ?? Number.NaN, 9);
    expect(down.settlingTimeS).toBeCloseTo(up.settlingTimeS ?? Number.NaN, 9);
    expect(down.peak).toBeCloseTo(5 - ((up.peak ?? Number.NaN) - 25), 9);
  });
});

describe('what an edge cannot say', () => {
  const edge: ManeuverEdge = { timeS: 1, from: 0, to: 10 };
  test('a response that never stops oscillating has no settling time', () => {
    const result = edgeResponse(sampled(200, 0, 6, t => (t <= 1 ? 0 : 10 - 10 * Math.cos(10 * (t - 1)))), edge, 6, 0.05);
    expect(result.settlingTimeS).toBeNull();
    expect(result.overshootPercent).toBeCloseTo(100, 0);
    expect(result.riseTimeS).not.toBeNull();
    expect(result.missing).toBeNull();
  });
  test('a response too slow for its window has no rise time and no settling time', () => {
    const result = edgeResponse(sampled(200, 0, 2, t => (t <= 1 ? 0 : 10 * (1 - Math.exp(-(t - 1) / 5)))), edge, 2, 0.05);
    expect(result.riseTimeS).toBeNull();
    expect(result.settlingTimeS).toBeNull();
    expect(result.overshootPercent).toBe(0);
    // 10 % was reached, at 5·ln(1/0.9) = 0.527 s.
    expect(Math.abs((result.delayS ?? Number.NaN) - 5 * Math.log(1 / 0.9))).toBeLessThanOrEqual(1e-3);
  });
  test('a response that settles short of the request says how far short, and does not settle', () => {
    const result = edgeResponse(sampled(200, 0, 11, t => (t <= 1 ? 0 : 8 * (1 - Math.exp(-(t - 1) / 0.2)))), edge, 11, 0.05);
    expect(result.settlingTimeS).toBeNull();
    expect(result.riseTimeS).toBeNull();
    expect(Math.abs((result.endError ?? Number.NaN) - -2)).toBeLessThanOrEqual(1e-3);
  });
  test('an edge starting away from where the last one left it rises from where it actually was', () => {
    // A doublet's second edge asks +5 to -5, and the aircraft is still at +4.
    const y = secondOrder(0.7, 12), result = edgeResponse(sampled(1000, 0, 5, t => (t <= 2 ? 4 : 4 - 9 * y(t - 2))), { timeS: 2, from: 5, to: -5 }, 5, 0.05);
    expect(result.startActual).toBeCloseTo(4, 9);
    expect(Math.abs((result.riseTimeS ?? Number.NaN) - (firstCrossing(y, 0.9, 3) - firstCrossing(y, 0.1, 3)))).toBeLessThanOrEqual(1e-4);
    // Overshoot and the settling band count against the 10 that was requested, not the 9 that was flown.
    expect(Math.abs((result.overshootPercent ?? Number.NaN) - 9 * 100 * Math.exp(-Math.PI * 0.7 / Math.sqrt(1 - 0.49)) / 10)).toBeLessThanOrEqual(0.01);
  });
  test('no recorded values at the edge is shown as missing, never as a number', () => {
    const before = edgeResponse({ timeS: [0, 0.5], value: [0, 0] }, edge, 6, 0.05);
    expect(before.missing).toContain('no actual values');
    expect(before.riseTimeS).toBeNull();
    expect(before.overshootPercent).toBeNull();
    const after = edgeResponse({ timeS: [2, 3, 4], value: [5, 9, 10] }, edge, 6, 0.05);
    expect(after.missing).toContain('no actual values');
    expect(edgeResponse({ timeS: [], value: [] }, edge, 6, 0.05).missing).toContain('no actual values');
  });
  test('a hole in the recorded values inside the window is shown as missing', () => {
    const series = sampled(200, 0, 6, t => (t <= 1 ? 0 : 10));
    const holed: ResponseSeries = { timeS: series.timeS.filter(t => t < 1.2 || t > 2.2), value: series.value.filter((_, i) => (series.timeS[i] ?? 0) < 1.2 || (series.timeS[i] ?? 0) > 2.2) };
    const result = edgeResponse(holed, edge, 6, 0.05);
    expect(result.missing).toContain('gap');
    expect(result.settlingTimeS).toBeNull();
  });
  test('refuses a band that is not a fraction', () => {
    expect(() => edgeResponse({ timeS: [0, 1], value: [0, 0] }, edge, 6, 0)).toThrow('band');
    expect(() => edgeResponse({ timeS: [0, 1], value: [0, 0] }, edge, 6, 1)).toThrow('band');
  });
});

describe('a maneuver on its timeline', () => {
  test('a roll step leans, holds, and returns level, because a lean held on keeps accelerating', () => {
    const line = maneuverTimeline('roll', 'step', 10, 3);
    expect(line.edges).toEqual([{ timeS: BASELINE_S, from: 0, to: 10 }, { timeS: BASELINE_S + 3, from: 10, to: 0 }]);
    expect(line.lengthS).toBe(BASELINE_S + 6);
  });
  test('a heading or altitude step stays where it went', () => {
    for (const axis of ['heading', 'altitude'] as const) {
      const line = maneuverTimeline(axis, 'step', -4, 5);
      expect(line.edges).toEqual([{ timeS: BASELINE_S, from: 0, to: -4 }]);
      expect(line.lengthS).toBe(BASELINE_S + 5);
    }
  });
  test('a doublet goes one way, the other way, and back', () => {
    const line = maneuverTimeline('pitch', 'doublet', 5, 2);
    expect(line.edges).toEqual([{ timeS: BASELINE_S, from: 0, to: 5 }, { timeS: BASELINE_S + 2, from: 5, to: -5 }, { timeS: BASELINE_S + 4, from: -5, to: 0 }]);
    expect(line.lengthS).toBe(BASELINE_S + 6);
  });
  test('the command at a moment is the last edge reached', () => {
    const line = maneuverTimeline('pitch', 'doublet', 5, 2);
    expect([0, 1.99, 2, 3.99, 4, 5.99, 6, 100].map(t => offsetAt(line, t))).toEqual([0, 0, 5, 5, -5, -5, 0, 0]);
    // A rounding error before a moment is that moment; a real difference is not.
    expect(offsetAt(line, 2 - 1e-9)).toBe(5);
    expect(offsetAt(line, 2 - 1e-3)).toBe(0);
  });
  test('every type names one axis and one shape, and nothing else is a maneuver', () => {
    expect(Object.keys(MANEUVER_TYPES)).toHaveLength(8);
    for (const type of Object.keys(MANEUVER_TYPES)) expect(isManeuverType(type)).toBe(true);
    for (const type of ['hover', 'route', 'roll', 'roll-sweep', '']) expect(isManeuverType(type)).toBe(false);
  });
});

describe('edges from the recorded requests', () => {
  test('an edge is the first recorded row of a new value', () => {
    const requested: ResponseSeries = { timeS: [10, 10.1, 10.2, 10.3, 10.4, 10.5], value: [0, 0, 7, 7, -7, -7] };
    expect(edgesOf(requested)).toEqual([{ timeS: 10.2, from: 0, to: 7 }, { timeS: 10.4, from: 7, to: -7 }]);
  });
  test('headings unwrap through north, so a step across it is a step of its own size', () => {
    expect(unwrapDeg([350, 350, 20, 20, 340])).toEqual([350, 350, 380, 380, 340]);
    expect(unwrapDeg([10, 350, 10])).toEqual([10, -10, 10]);
    expect(edgesOf({ timeS: [0, 1, 2], value: unwrapDeg([350, 350, 20]) })).toEqual([{ timeS: 2, from: 350, to: 380 }]);
  });
  test('a whole response has one result per edge, each window ending at the next edge', () => {
    const requested: ResponseSeries = { timeS: [0, 1, 2, 3, 4], value: [0, 5, 5, -5, -5] };
    const y = secondOrder(0.7, 12);
    const actual = sampled(500, 0, 4, t => (t <= 1 ? 0 : t <= 3 ? 5 * y(t - 1) : 5 - 10 * y(t - 3)));
    const results = maneuverResponse(requested, actual, 0.05);
    expect(results.map(r => [r.edgeTimeS, r.endS, r.from, r.to])).toEqual([[1, 3, 0, 5], [3, 4, 5, -5]]);
    expect(results.every(r => r.missing === null)).toBe(true);
    expect(Math.abs((results[0]?.riseTimeS ?? Number.NaN) - (firstCrossing(y, 0.9, 3) - firstCrossing(y, 0.1, 3)))).toBeLessThanOrEqual(1e-3);
  });
});

// ---- flown as a flight task ------------------------------------------------------------------------------------------------------------

const GROUND = { northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 1 };
const LIMITS: GuidanceLimits = { verticalAccelerationMps2: 1, verticalJerkMps3: 5, horizontalJerkMps3: 5, yawAccelerationDegS2: 270 };
const maneuver = (type: FlightTaskType, parameters: Record<string, number>, edit: Partial<FlightTaskDefinition> = {}): FlightTaskDefinition =>
  ({ schemaVersion: flightTaskSchemaVersion(type), type, parameters, route: null, initial: { ground: GROUND, air: null }, finish: 'land', ...edit });
const ROLL = { altitudeM: 10, headingDeg: 30, amplitudeDeg: 10, holdS: 2 };

describe('a maneuver as a task definition', () => {
  test('schema 2 is the maneuvers, and an earlier type stays schema 1', () => {
    expect(flightTaskSchemaVersion('roll-step')).toBe(2);
    expect(flightTaskSchemaVersion('hover')).toBe(1);
    expect(parseFlightTask(maneuver('roll-step', ROLL)).schemaVersion).toBe(2);
    expect(flightTaskProblems({ ...maneuver('roll-step', ROLL), schemaVersion: 1 })).toContain('The task is not schema version 2');
    expect(flightTaskProblems({ ...maneuver('hover', { altitudeM: 5, durationS: 3 }), schemaVersion: 2 })).toContain('The task is not schema version 1');
    expect(flightTaskProblems({ ...maneuver('hover', { altitudeM: 5, durationS: 3 }), schemaVersion: 3, type: 'unknown' }).join()).toContain('schema version 1 or 2');
  });
  test.each([
    ['roll-step', { ...ROLL, amplitudeDeg: 0 }, 'amplitude cannot be 0'],
    ['pitch-doublet', { ...ROLL, amplitudeDeg: 31 }, 'amplitudeDeg must be a number from -30 to 30'],
    ['roll-step', { ...ROLL, holdS: 0.4 }, 'holdS must be a number from 0.5 to 10'],
    ['roll-step', { ...ROLL, holdS: 11 }, 'holdS must be a number from 0.5 to 10'],
    ['heading-step', { ...ROLL, amplitudeDeg: 171 }, 'amplitudeDeg must be a number from -170 to 170'],
    // A doublet's middle change is twice its amplitude, and a heading goes the shortest way round.
    ['heading-doublet', { ...ROLL, amplitudeDeg: 86 }, 'amplitudeDeg must be a number from -85 to 85'],
    ['altitude-step', { altitudeM: 10, amplitudeM: 0, holdS: 5 }, 'amplitude cannot be 0'],
    ['altitude-step', { altitudeM: 10, amplitudeM: -10, holdS: 5 }, 'would go to 0 m'],
    ['altitude-step', { altitudeM: 90, amplitudeM: 11, holdS: 5 }, 'would go to 101 m'],
    // Going the other way too.
    ['altitude-doublet', { altitudeM: 5, amplitudeM: 5, holdS: 5 }, 'would go to 0 m'],
    ['altitude-step', { altitudeM: 10, amplitudeDeg: 5, holdS: 5 }, 'unknown field amplitudeDeg'],
  ] as const)('%s with %o is refused', (type, parameters, reason) => {
    expect(flightTaskProblems(maneuver(type, parameters)).join('; ')).toContain(reason);
  });
  test('an amplitude says what its sign does on that axis', () => {
    expect(parameterLabel('roll-step', 'amplitudeDeg')).toContain('rolls right');
    expect(parameterLabel('pitch-doublet', 'amplitudeDeg')).toContain('nose up');
    expect(parameterLabel('heading-step', 'amplitudeDeg')).toContain('clockwise');
    expect(parameterLabel('altitude-step', 'amplitudeM')).toContain('climbs');
    expect(parameterLabel('hover', 'durationS')).toBe('Duration (s)');
  });
  test('every maneuver type comes through the form unchanged, and starts valid', () => {
    for (const type of Object.keys(MANEUVER_TYPES) as FlightTaskType[]) {
      const form = newTaskForm(type);
      expect(formProblems(form), type).toEqual([]);
      const task = taskOfForm(form);
      expect(task.schemaVersion).toBe(2);
      expect(taskOfForm(formOf(task))).toEqual(task);
      expect(planLines(task).filter(line => line.measured)).toHaveLength(1);
    }
  });
  test('a task of an earlier type comes through the form as schema 1, so saving it adds no version', () => {
    const task = taskOfForm(newTaskForm('hover'));
    expect(task.schemaVersion).toBe(1);
    expect(JSON.stringify(taskOfForm(formOf(task)))).toBe(JSON.stringify(task));
  });
});

describe('a maneuver in the plan', () => {
  test('a roll flies to its height and heading, leans on its clock, and stops on the way to the landing', () => {
    const plan = planFlightTask(parseFlightTask(maneuver('roll-step', ROLL)));
    expect(plan.map(item => [item.stage.kind, item.measured])).toEqual([['arm', false], ['takeoff', false], ['heading', false], ['maneuver', true], ['recover', false], ['land', false]]);
    expect(plan[3]?.stage).toEqual({ kind: 'maneuver', axis: 'roll', altitudeM: 10, headingDeg: 30, timeline: maneuverTimeline('roll', 'step', 10, 2) });
    expect(plan[4]?.stage).toEqual({ kind: 'recover', altitudeM: 10, headingDeg: 30 });
  });
  test('a heading or altitude maneuver stays at rest, so nothing needs stopping', () => {
    expect(planFlightTask(parseFlightTask(maneuver('heading-step', { ...ROLL, amplitudeDeg: 45 }))).map(item => item.stage.kind)).toEqual(['arm', 'takeoff', 'heading', 'maneuver', 'land']);
    expect(planFlightTask(parseFlightTask(maneuver('altitude-doublet', { altitudeM: 10, amplitudeM: 2, holdS: 5 }))).map(item => item.stage.kind)).toEqual(['arm', 'takeoff', 'maneuver', 'land']);
  });
  test('holding where it ends leaves out the landing', () => {
    expect(planFlightTask(parseFlightTask(maneuver('roll-step', ROLL, { finish: 'hold' }))).at(-1)?.stage.kind).toBe('recover');
  });
  test('an airborne start arrives first, and the clock starts on arrival', () => {
    const plan = planFlightTask(parseFlightTask(maneuver('pitch-step', ROLL, { initial: { ground: GROUND, air: { altitudeM: 8, headingDeg: 30, speedMps: 0 } } })));
    expect(plan.filter(item => item.measured).map(item => item.stage.kind)).toEqual(['vertical', 'maneuver']);
  });
});

/** Does what it is commanded and reports it, as ArduPilot and the physics together would, with no dynamics: the runner's commands are what is tested here. */
class Obedient {
  simTimeS = 100; northM = 0; eastM = 0; altitudeM = 0.1; northMps = 0; eastMps = 0; downMps = 0; headingDeg = 0; rollDeg = 0; pitchDeg = 0; armed = false; mode: AutopilotModeName = 'other';
  climbingToM: number | null = null;
  apply(command: FlightTaskCommand): void {
    switch (command.kind) {
      case 'set-mode': this.mode = command.mode; break;
      case 'arm': this.armed = true; break;
      case 'takeoff': this.climbingToM = 0.1 + command.heightM; break;
      case 'target': this.flyTo(command.target); break;
      case 'attitude': this.lean(command.target); break;
      case 'upload-route': throw new Error('A maneuver has no route');
      default: { const never: never = command; throw new Error(String(never)); }
    }
  }
  private flyTo(t: GuidedTarget): void {
    this.climbingToM = null;
    this.northM = t.northM; this.eastM = t.eastM; this.altitudeM = 0.1 - t.downM; this.northMps = t.northMps; this.eastMps = t.eastMps; this.downMps = t.downMps; this.headingDeg = wrapDeg(t.yawRad * 180 / Math.PI);
    this.rollDeg = 0; this.pitchDeg = 0;
  }
  private lean(t: AttitudeTarget): void {
    this.rollDeg = t.rollRad * 180 / Math.PI; this.pitchDeg = t.pitchRad * 180 / Math.PI; this.headingDeg = wrapDeg(t.yawRad * 180 / Math.PI);
  }
  step(dt: number): void {
    this.simTimeS += dt;
    if (this.mode === 'land') { this.altitudeM = Math.max(0.1, this.altitudeM - dt); if (this.altitudeM <= 0.1) this.armed = false; }
    if (this.climbingToM !== null) this.altitudeM = Math.min(this.climbingToM, this.altitudeM + 2.5 * dt);
  }
}
function fly(task: FlightTaskDefinition, dt = 0.1, vehicle = new Obedient()): { steps: FlightTaskStep[]; sent: { simTimeS: number; command: FlightTaskCommand }[]; vehicle: Obedient } {
  const runner = new FlightTaskRunner(parseFlightTask(task), LIMITS), steps: FlightTaskStep[] = [], sent: { simTimeS: number; command: FlightTaskCommand }[] = [];
  for (let i = 0; i < 3000; i++) {
    const step = runner.observe({ simTimeS: vehicle.simTimeS, northM: vehicle.northM, eastM: vehicle.eastM, altitudeM: vehicle.altitudeM, northMps: vehicle.northMps, eastMps: vehicle.eastMps, downMps: vehicle.downMps,
      headingDeg: vehicle.headingDeg, rollDeg: vehicle.rollDeg, pitchDeg: vehicle.pitchDeg, armed: vehicle.armed, mode: vehicle.mode, mission: 'idle', routePointReached: -1 });
    steps.push(step);
    for (const command of step.commands) { sent.push({ simTimeS: vehicle.simTimeS, command }); vehicle.apply(command); }
    if (step.progress.state !== 'running') break;
    vehicle.step(dt);
  }
  return { steps, sent, vehicle };
}
const measuredSteps = (steps: readonly FlightTaskStep[]) => steps.filter(step => step.stage === 'maneuver');

describe('a maneuver in the runner', () => {
  test('a roll doublet asks for each lean at its moment, level before, and the heading throughout', () => {
    const { steps, sent } = fly(maneuver('roll-doublet', { altitudeM: 10, headingDeg: 30, amplitudeDeg: 10, holdS: 2 }));
    expect(steps.at(-1)?.progress).toEqual({ state: 'done' });
    const rows = measuredSteps(steps);
    expect(rows.length).toBeGreaterThan(70);
    for (const row of rows) {
      const t = row.taskTimeS ?? Number.NaN;
      expect(row.requested.rollDeg, `at ${t}`).toBe(t < 2 - 1e-6 ? 0 : t < 4 - 1e-6 ? 10 : t < 6 - 1e-6 ? -10 : 0);
      expect(row.requested.pitchDeg).toBe(0);
      expect(row.requested.headingDeg).toBe(30);
      expect(row.requested.altitudeM).toBeNull();
      expect(row.requested.verticalSpeedMps).toBe(0);
      expect(row.measured).toBe(true);
    }
    // Attitude goes out at every observation of the maneuver, and nothing else does.
    const attitudes = sent.filter(item => item.command.kind === 'attitude');
    expect(attitudes.length).toBe(rows.length);
    const during = rows[0]?.taskTimeS === 0 ? sent.filter(item => item.simTimeS >= (attitudes[0]?.simTimeS ?? 0) && item.simTimeS <= (attitudes.at(-1)?.simTimeS ?? 0)) : [];
    expect(during.every(item => item.command.kind === 'attitude')).toBe(true);
    const lean = attitudes.find(item => item.command.kind === 'attitude' && item.command.target.rollRad > 0)?.command;
    expect(lean).toEqual({ kind: 'attitude', target: { rollRad: 10 * Math.PI / 180, pitchRad: 0, yawRad: 30 * Math.PI / 180 } });
  });
  test('the recorded requests give back the timeline of the definition', () => {
    const { steps } = fly(maneuver('pitch-doublet', { ...ROLL, amplitudeDeg: -8, holdS: 3 }));
    const rows = measuredSteps(steps);
    const edges = edgesOf({ timeS: rows.map(row => row.taskTimeS ?? 0), value: rows.map(row => row.requested.pitchDeg ?? 0) });
    expect(edges.map(edge => [edge.from, edge.to])).toEqual([[0, -8], [-8, 8], [8, 0]]);
    // The first request is time zero, and at an observation every 0.1 s each change falls on its moment on the timeline, as the Flight tasks tab lists it.
    expect(rows[0]?.taskTimeS).toBe(0);
    edges.forEach((edge, i) => expect(Math.abs(edge.timeS - (BASELINE_S + i * 3))).toBeLessThanOrEqual(1e-6));
  });
  test('a heading step sends the new heading across north, and stays at rest', () => {
    const { steps, sent } = fly(maneuver('heading-step', { altitudeM: 10, headingDeg: 350, amplitudeDeg: 45, holdS: 5 }));
    expect(steps.at(-1)?.progress).toEqual({ state: 'done' });
    const rows = measuredSteps(steps);
    expect(rows[0]?.requested.headingDeg).toBe(350);
    expect(rows.at(-1)?.requested.headingDeg).toBe(35);
    expect(rows.every(row => row.requested.speedMps === 0 && row.requested.altitudeM === 10 && row.requested.rollDeg === null)).toBe(true);
    // A target of no speed: the step is the only thing that changes, and it is left sharp on purpose.
    const targets = sent.filter(item => item.command.kind === 'target').map(item => (item.command.kind === 'target' ? item.command.target : null));
    const yaws = new Set(targets.slice(-20).map(target => Math.round((target?.yawRad ?? 0) * 180 / Math.PI)));
    expect(yaws.has(35)).toBe(true);
    expect(targets.at(-1)).toMatchObject({ northMps: 0, eastMps: 0, downMps: 0, northMps2: 0, eastMps2: 0, downMps2: 0, yawRateRadS: 0 });
  });
  test('an altitude step moves only the height of its target, and a doublet comes back', () => {
    const { steps } = fly(maneuver('altitude-doublet', { altitudeM: 10, amplitudeM: 3, holdS: 4 }));
    const rows = measuredSteps(steps);
    expect(edgesOf({ timeS: rows.map(row => row.taskTimeS ?? 0), value: rows.map(row => row.requested.altitudeM ?? 0) }).map(edge => [edge.from, edge.to])).toEqual([[10, 13], [13, 7], [7, 10]]);
    expect(rows.every(row => row.requested.verticalSpeedMps === null && row.requested.speedMps === 0)).toBe(true);
    expect(steps.at(-1)?.progress).toEqual({ state: 'done' });
  });
  test('a recovery starts where the aircraft is, and stops along the way it was going', () => {
    const vehicle = new Obedient();
    const runner = new FlightTaskRunner(parseFlightTask(maneuver('roll-step', { ...ROLL, holdS: 0.5 }, { finish: 'hold' })), LIMITS);
    let step: FlightTaskStep | null = null;
    const moving = { northMps: 3, eastMps: 4 };
    for (let i = 0; i < 3000; i++) {
      step = runner.observe({ simTimeS: vehicle.simTimeS, northM: vehicle.northM, eastM: vehicle.eastM, altitudeM: vehicle.altitudeM, northMps: vehicle.northMps, eastMps: vehicle.eastMps, downMps: vehicle.downMps,
        headingDeg: vehicle.headingDeg, rollDeg: vehicle.rollDeg, pitchDeg: vehicle.pitchDeg, armed: vehicle.armed, mode: vehicle.mode, mission: 'idle', routePointReached: -1 });
      if (step.stage === 'recover') break;
      for (const command of step.commands) vehicle.apply(command);
      // As if the lean had carried it off.
      if (step.stage === 'maneuver') { vehicle.northM = 20; vehicle.eastM = -7; vehicle.northMps = moving.northMps; vehicle.eastMps = moving.eastMps; }
      vehicle.step(0.1);
    }
    expect(step?.stage).toBe('recover');
    const target = step?.commands.find(command => command.kind === 'target');
    if (target?.kind !== 'target') throw new Error('The recovery sent no target');
    // At 5 m/s along (0.6, 0.8), from the moment its motion starts.
    expect(target.target.northMps / target.target.eastMps).toBeCloseTo(3 / 4, 9);
    expect(Math.hypot(target.target.northMps, target.target.eastMps)).toBeLessThanOrEqual(5);
    expect(Math.hypot(target.target.northM - 20, target.target.eastM + 7)).toBeLessThanOrEqual(5 * 0.2);
    expect(target.target.yawRad).toBeCloseTo(30 * Math.PI / 180, 9);
  });
  test('the actual roll and pitch are reported beside the request', () => {
    const { steps } = fly(maneuver('roll-step', ROLL));
    const leaning = measuredSteps(steps).find(step => (step.taskTimeS ?? 0) > 3);
    expect(leaning?.actual.rollDeg).toBeCloseTo(10, 9);
    expect(leaning?.requested.rollDeg).toBe(10);
  });
});

describe('the attitude as MAVLink', () => {
  /** The frame the ground station packs, through the parser that reads the autopilot's. */
  function packed(target: AttitudeTarget): MavFrame {
    const out = new Uint8Array(280), frames: MavFrame[] = [];
    const n = taskCommandInto({ kind: 'attitude', target }, new GroundStation(), out);
    expect(n).toBeGreaterThan(0);
    new MavParser(frame => frames.push(frame)).push(out.subarray(0, n));
    const [frame] = frames;
    if (!frame) throw new Error('No frame');
    return frame;
  }
  const quaternion = (frame: MavFrame) => [4, 8, 12, 16].map(offset => frame.view.getFloat32(offset, true)) as [number, number, number, number];
  test('is SET_ATTITUDE_TARGET with only the attitude, and the height held', () => {
    const frame = packed({ rollRad: 0.2, pitchRad: -0.1, yawRad: 1 });
    expect(frame.id).toBe(82);
    // Thrust at 32 is exactly 0.5 (GCS_MAVLink_Copter.cpp: a climb rate of none), and the type mask at 38 ignores the three body rates.
    expect(frame.view.getFloat32(32, true)).toBe(0.5);
    expect(frame.view.getUint8(38)).toBe(7);
    for (const offset of [20, 24, 28]) expect(frame.view.getFloat32(offset, true)).toBe(0);
  });
  test.each([[10, 0, 30], [0, -10, 30], [-25, 12, 350], [5, 5, 180], [0, 0, 0]])('roll %d, pitch %d, yaw %d° comes back from its quaternion', (roll, pitch, yaw) => {
    const deg = Math.PI / 180, [w, x, y, z] = quaternion(packed({ rollRad: roll * deg, pitchRad: pitch * deg, yawRad: yaw * deg }));
    // ArduPilot refuses a quaternion further than 1e-3 from unit length.
    expect(Math.abs(w * w + x * x + y * y + z * z - 1)).toBeLessThan(1e-6);
    const back = eulerDegOf(w, x, y, z);
    expect(back.rollDeg).toBeCloseTo(roll, 4);
    expect(back.pitchDeg).toBeCloseTo(pitch, 4);
    expect(wrapDeg(back.yawDeg)).toBeCloseTo(wrapDeg(yaw), 4);
  });
  test('a positive roll tips the body\'s right side down, and a positive pitch its nose up', () => {
    // The rotation of a body vector into north, east, down by q.
    const rotate = ([w, x, y, z]: readonly [number, number, number, number], [a, b, c]: readonly [number, number, number]) => [
      a * (1 - 2 * (y * y + z * z)) + b * 2 * (x * y - w * z) + c * 2 * (x * z + w * y),
      a * 2 * (x * y + w * z) + b * (1 - 2 * (x * x + z * z)) + c * 2 * (y * z - w * x),
      a * 2 * (x * z - w * y) + b * 2 * (y * z + w * x) + c * (1 - 2 * (x * x + y * y)),
    ] as const;
    expect(rotate(quaternion(packed({ rollRad: 0.2, pitchRad: 0, yawRad: 0 })), [0, 1, 0])[2]).toBeGreaterThan(0);
    expect(rotate(quaternion(packed({ rollRad: 0, pitchRad: 0.2, yawRad: 0 })), [1, 0, 0])[2]).toBeLessThan(0);
  });
});

describe('what the autopilot must allow', () => {
  const reports = (value: number | undefined) => (name: string) => (name === 'GUID_OPTIONS' ? value : undefined);
  test('a roll or pitch maneuver needs thrust read as a climb rate', () => {
    expect(attitudeManeuverRefusal('roll-step', reports(0))).toBeNull();
    expect(attitudeManeuverRefusal('pitch-doublet', reports(7))).toBeNull();
    expect(attitudeManeuverRefusal('roll-doublet', reports(8))).toContain('half thrust');
    expect(attitudeManeuverRefusal('pitch-step', reports(9))).toContain('half thrust');
    expect(attitudeManeuverRefusal('roll-step', reports(undefined))).toContain('does not report GUID_OPTIONS');
  });
  test('nothing else asks', () => {
    for (const type of ['heading-step', 'altitude-doublet', 'hover', 'route']) expect(attitudeManeuverRefusal(type, reports(8))).toBeNull();
  });
});
