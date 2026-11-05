import { describe, expect, test } from 'vitest';
import { flightTaskSchemaVersion, parseFlightTask, type FlightTaskType } from '@mirage/scenarios/flight-tasks';
import { AIRBORNE_ABOVE_REST_M, experimentMetrics, flightDurationEstimate, type WindowMetrics } from '@mirage/analysis/metrics';
import type { RecordedRow } from '@mirage/analysis/response-series';
import { limitDroppedRow, limitEventRow, limitMonitorRow } from '@mirage/physics/limit-monitor';

// Every expected value here is worked out by hand from the rows written in this file, and written next to its arithmetic.

const row = (tick: number, simTimeS: number, values: readonly (number | null)[]): RecordedRow => ({
  tick, simTimeS, presence: values.reduce<number>((mask, value, i) => (value === null ? mask : mask + 2 ** i), 0), values: values.map(value => value ?? 0),
});
const GROUND = { northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 1 };
const task = (type: FlightTaskType, parameters: Record<string, number>) => parseFlightTask({ schemaVersion: flightTaskSchemaVersion(type), type, parameters, route: null, initial: { ground: GROUND, air: null }, finish: 'land' });
const seconds = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * A flight of 20 s at 1 Hz. It stands at 0.1 m until 4 s, is above 0.6 m from 5 to 14 s at 3 m (peak 5 m at 10 s), and is down by 15 s.
 * In the air the bus reads 15 V, 20 A and 300 W, except 24 A and 360 W at 10 s. On the ground it draws nothing.
 * Charge: 5 Ah in a 5 Ah pack up to 5 s, then -0.005 Ah per second to 4.955 Ah at 14 s, and it stays there.
 * Four motors spin 6000 rev/min in the air, with motor 2 at 7000 at 10 s, on a command of 0.5 (0.75 for motor 2 at 10 s).
 */
function flightRows(): Map<string, RecordedRow[]> {
  const inAir = (t: number) => t >= 5 && t <= 14;
  const position = seconds(0, 20).map(t => row(t, t, [0, 0, -(t === 10 ? 5 : inAir(t) ? 3 : 0.1)]));
  const battery = seconds(0, 20).map(t => {
    const current = inAir(t) ? (t === 10 ? 24 : 20) : 0, remaining = t <= 5 ? 5 : t >= 14 ? 4.955 : 5 - (t - 5) * 0.005;
    return row(t, t, [remaining / 5, 15, current, current * 15, remaining]);
  });
  const fourMotors = (tick: number, values: readonly number[]) => row(tick, tick, [...values, ...Array.from({ length: 12 }, () => null)]);
  const speed = seconds(0, 20).map(t => fourMotors(t, inAir(t) ? [6000, t === 10 ? 7000 : 6000, 6000, 6000] : [0, 0, 0, 0]));
  const command = seconds(0, 20).map(t => fourMotors(t, inAir(t) ? [0.5, t === 10 ? 0.75 : 0.5, 0.5, 0.5] : [0, 0, 0, 0]));
  return new Map([['truth.position', position], ['battery', battery], ['motors.speed', speed], ['motors.command', command]]);
}
const HOVER = task('hover', { altitudeM: 3, durationS: 4 });
/** A row of events.flightTask: stage, measured, task time, north, east, altitude, speed, heading, vertical speed. */
const request = (t: number, measured: boolean, northM: number | null, eastM: number | null, altitudeM: number | null) => row(t, t, [1, measured ? 1 : 0, t, northM, eastM, altitudeM, 0, 0, 0]);
const near = (actual: number | null | undefined, expected: number, tolerance = 1e-9) => expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(tolerance);

describe('what the flight did', () => {
  test('it is airborne from the first to the last moment above its rest height by the margin', () => {
    const { flight } = experimentMetrics(flightRows(), null);
    // Rest 0.1 m; the margin makes it 0.6 m; 3 m at 5 s is the first above that, and 3 m at 14 s the last.
    expect(AIRBORNE_ABOVE_REST_M).toBe(0.5);
    expect(flight?.liftedOff).toBe(true);
    expect(flight?.startS).toBe(5);
    expect(flight?.endS).toBe(14);
    near(flight?.restAltitudeM, 0.1);
    near(flight?.highestAboveRestM, 4.9);
  });
  test('a run that never left the ground says so', () => {
    const rows = flightRows();
    rows.set('truth.position', seconds(0, 20).map(t => row(t, t, [0, 0, -0.1 - t * 0.01])));
    const metrics = experimentMetrics(rows, null);
    expect(metrics.flight?.liftedOff).toBe(false);
    expect(metrics.flight?.startS).toBeNull();
    expect(metrics.wholeFlight).toBeNull();
    near(metrics.flight?.highestAboveRestM, 0.2);
  });
  test('no recorded position leaves it missing, not zero', () => {
    const rows = flightRows();
    rows.delete('truth.position');
    expect(experimentMetrics(rows, null).flight).toBeNull();
  });
});

describe('the values over a window', () => {
  const whole = experimentMetrics(flightRows(), null).wholeFlight as WindowMetrics;
  test('its span', () => {
    expect(whole.startS).toBe(5);
    expect(whole.endS).toBe(14);
    expect(whole.durationS).toBe(9);
  });
  test('current and power are time-weighted, by trapezoids between rows', () => {
    // Current: 20 A for 9 s, with a triangle of 4 A height and 2 s base at 10 s, area 4 A·s: (180 + 4) / 9.
    near(whole.current?.mean, 184 / 9);
    expect(whole.current?.max).toBe(24);
    // Power: 300 W for 9 s, with a triangle of 60 W height and 2 s base, area 60 W·s: (2700 + 60) / 9.
    near(whole.power?.mean, 2760 / 9);
    expect(whole.power?.max).toBe(360);
    expect(whole.voltage?.min).toBe(15);
  });
  test('energy is the power integrated, and charge the difference of what remains', () => {
    // 2760 W·s / 3600.
    near(whole.energyWh, 2760 / 3600);
    // 4.955 Ah remain at 14 s of the 5 Ah at 5 s.
    near(whole.chargeUsedAh, 0.045);
  });
  test('rotor speed and command average over the motors, then over time, and the largest is any motor\'s', () => {
    // The mean of four motors is 6250 at 10 s and 6000 otherwise: a triangle of 250 height and 2 s base, area 250, over 9 s.
    near(whole.rpm?.mean, (6000 * 9 + 250) / 9);
    expect(whole.rpm?.max).toBe(7000);
    // 0.5625 at 10 s: a triangle of 0.0625 height and 2 s base, area 0.0625, over 9 s.
    near(whole.command?.mean, (0.5 * 9 + 0.0625) / 9);
    expect(whole.command?.max).toBe(0.75);
  });
  test('a motor count of four reads four motors, not the sixteen channels a row has', () => {
    expect(whole.rpm?.mean).toBeGreaterThan(5000);
  });
  test('a signal the recording lacks is missing, not zero', () => {
    const rows = flightRows();
    rows.delete('battery');
    const metrics = experimentMetrics(rows, null).wholeFlight;
    expect(metrics?.current).toBeNull();
    expect(metrics?.power).toBeNull();
    expect(metrics?.energyWh).toBeNull();
    expect(metrics?.chargeUsedAh).toBeNull();
    expect(metrics?.rpm).not.toBeNull();
  });
});

describe('the task\'s measured part', () => {
  const rows = () => {
    const all = flightRows();
    all.set('events.flightTask', [request(6, false, 0, 0, 3), request(7, true, 0, 0, 3), request(8, true, 0, 0, 3), request(9, true, 0, 0, 3), request(10, true, 0, 0, 3), request(11, true, 0, 0, 3), request(12, false, 0, 0, 3)]);
    return all;
  };
  test('it is the measured rows only', () => {
    const metrics = experimentMetrics(rows(), HOVER);
    expect(metrics.task?.startS).toBe(7);
    expect(metrics.task?.endS).toBe(11);
    expect(metrics.task?.durationS).toBe(4);
    // Over 7 to 11 s: 20 A with a triangle of area 4 A·s on 9, 10 and 11 s: (80 + 4) / 4.
    near(metrics.task?.current?.mean, 84 / 4);
  });
  test('position differences are against the truth at each request', () => {
    const all = rows();
    // At 7, 8, 9, 10 and 11 s the truth stands 0, 3, 0, 4 and 0 m from the request horizontally.
    all.set('truth.position', seconds(0, 20).map(t => row(t, t, [t === 8 ? 3 : t === 10 ? 3 : 0, t === 10 ? 4 : 0, -3])));
    const position = experimentMetrics(all, HOVER).position;
    expect(position?.samples).toBe(5);
    near(position?.horizontalMaxM, 5);
    // Differences 0, 3, 0, 5, 0: √((9 + 25) / 5).
    near(position?.horizontalRmsM, Math.sqrt(34 / 5));
    near(position?.altitudeMaxM, 0);
  });
  test('without a task there is no measured part, and no position against a request', () => {
    const metrics = experimentMetrics(flightRows(), null);
    expect(metrics.task).toBeNull();
    expect(metrics.position).toBeNull();
    expect(metrics.response).toBeNull();
  });
  test('a maneuver reports its response, not a position difference from a request that jumps on purpose', () => {
    const maneuver = task('altitude-step', { altitudeM: 3, amplitudeM: 2, holdS: 4 });
    const all = flightRows();
    // arm, take-off, then the maneuver, stage 2: the request goes from 3 to 5 m at 8 s.
    all.set('events.flightTask', seconds(6, 12).map(t => row(t, t, [2, 1, t - 6, 0, 0, t < 8 ? 3 : 5, 0, 0, null])));
    all.set('truth.position', seconds(0, 20).map(t => row(t, t, [0, 0, -(t < 8 ? 3 : t < 9 ? 3 : 5)])));
    const metrics = experimentMetrics(all, maneuver);
    expect(metrics.position).toBeNull();
    expect(metrics.response).toHaveLength(1);
    expect(metrics.response?.[0]).toMatchObject({ from: 3, to: 5, edgeTimeS: 8 });
  });
});

describe('the flight duration estimate', () => {
  const whole = experimentMetrics(flightRows(), null).wholeFlight as WindowMetrics;
  test('it is the charge above the reserve at the window\'s mean current', () => {
    // 5 Ah at the start, a 20 % reserve of a 5 Ah pack leaves 4 Ah, at 184/9 A.
    const estimate = flightDurationEstimate(whole, { remainingAh: 5, capacityAh: 5 }, 20);
    near(estimate.minutes, 4 / (184 / 9) * 60);
    expect(estimate.reservePercent).toBe(20);
    near(estimate.usableAh, 4);
    near(estimate.meanCurrentA, 184 / 9);
  });
  test('a run starting part charged has less above the reserve', () => {
    // 3 Ah less the 1 Ah reserve.
    near(flightDurationEstimate(whole, { remainingAh: 3, capacityAh: 5 }, 20).usableAh, 2);
  });
  test('no reserve is a valid assumption', () => {
    near(flightDurationEstimate(whole, { remainingAh: 5, capacityAh: 5 }, 0).usableAh, 5);
  });
  test('a start at or below the reserve has no estimate, and says why', () => {
    const estimate = flightDurationEstimate(whole, { remainingAh: 1, capacityAh: 5 }, 20);
    expect(estimate.minutes).toBeNull();
    expect(estimate.missing).toContain('reserve');
  });
  test('a window with no current has no estimate', () => {
    const estimate = flightDurationEstimate({ ...whole, current: null }, { remainingAh: 5, capacityAh: 5 }, 20);
    expect(estimate.minutes).toBeNull();
    expect(estimate.missing).toContain('current');
  });
  test('refuses a reserve outside 0 to 100', () => {
    expect(() => flightDurationEstimate(whole, { remainingAh: 5, capacityAh: 5 }, -1)).toThrow('reserve');
    expect(() => flightDurationEstimate(whole, { remainingAh: 5, capacityAh: 5 }, 100)).toThrow('reserve');
  });
  test('the pack comes from the recording\'s first battery row', () => {
    const { pack } = experimentMetrics(flightRows(), null);
    expect(pack).toEqual({ remainingAh: 5, capacityAh: 5 });
  });
});

/** A row of events.limit: code, subject, quantity, edge, value, limit. Code 0: the monitor reports into this recording; 1: an event; 2: events lost. */
const limitOn = row(0, 0, [0, null, null, null, null, null]);
const limit = (t: number, subject: number, quantity: number, edge: 0 | 1, value: number, rating: number | null) => row(t, t, [1, subject, quantity, edge, value, rating]);

describe('component limit exceedances', () => {
  test('what the monitor reports reads back through the rows the recorder writes', () => {
    const on = (tick: number, values: readonly (number | null)[]) => row(tick, tick, values);
    const summary = withLimits([on(0, limitMonitorRow()),
      on(6, limitEventRow({ tick: 6, simTimeS: 6, subject: 1, quantity: 'motor-current', kind: 'warning', edge: 'start', value: 31, limit: 30 })),
      on(8, limitEventRow({ tick: 8, simTimeS: 8, subject: 1, quantity: 'motor-current', kind: 'warning', edge: 'end', value: 29, limit: 30 })),
      on(9, limitEventRow({ tick: 9, simTimeS: 9, subject: 'battery', quantity: 'pack-current-limit', kind: 'limited', edge: 'start', value: 80, limit: Number.NaN })),
      on(10, limitDroppedRow(4))]);
    expect(summary.dropped).toBe(4);
    expect(summary.entries).toEqual([
      { subject: 'battery', quantity: 'pack-current-limit', kind: 'limited', episodes: 1, totalS: 11, firstS: 9, limit: null, open: true },
      { subject: 1, quantity: 'motor-current', kind: 'warning', episodes: 1, totalS: 2, firstS: 6, limit: 30, open: false },
    ]);
  });
  const withLimits = (rows: readonly RecordedRow[]) => { const all = flightRows(); all.set('events.limit', [...rows]); return experimentMetrics(all, null).limits; };
  test('a recording made before limits were recorded says it does not know, not that there were none', () => {
    expect(experimentMetrics(flightRows(), null).limits).toEqual({ recorded: false, dropped: 0, entries: [] });
  });
  test('a recording that holds the monitor and no event had none', () => {
    expect(withLimits([limitOn])).toEqual({ recorded: true, dropped: 0, entries: [] });
  });
  test('episodes of one quantity on one motor add up, with its rating', () => {
    // Motor 1, motor current (quantity 0): 6 to 8 s and 10 to 11 s, against 30 A.
    const { entries } = withLimits([limitOn, limit(6, 1, 0, 1, 31, 30), limit(8, 1, 0, 0, 29, 30), limit(10, 1, 0, 1, 33, 30), limit(11, 1, 0, 0, 29, 30)]);
    expect(entries).toEqual([{ subject: 1, quantity: 'motor-current', kind: 'warning', episodes: 2, totalS: 3, firstS: 6, limit: 30, open: false }]);
  });
  test('the battery is its own subject, and a modeled clamp is kept apart from a rating', () => {
    // Battery voltage (5), a warning; the pack current limit (7), a clamp.
    const { entries } = withLimits([limitOn, limit(6, -1, 7, 1, 80, 80), limit(7, -1, 7, 0, 79, 80), limit(9, -1, 5, 1, 13, 13.2), limit(12, -1, 5, 0, 14, 13.2)]);
    expect(entries).toEqual([
      { subject: 'battery', quantity: 'battery-voltage', kind: 'warning', episodes: 1, totalS: 3, firstS: 9, limit: 13.2, open: false },
      { subject: 'battery', quantity: 'pack-current-limit', kind: 'limited', episodes: 1, totalS: 1, firstS: 6, limit: 80, open: false },
    ]);
  });
  test('an exceedance still on at the end of the recording counts to its last row, and says so', () => {
    const { entries } = withLimits([limitOn, limit(18, 0, 1, 1, 500, 450)]);
    // The recording's last rows are at 20 s.
    expect(entries).toEqual([{ subject: 0, quantity: 'motor-power', kind: 'warning', episodes: 1, totalS: 2, firstS: 18, limit: 450, open: true }]);
  });
  test('a clamp with no stated limit has none', () => {
    const { entries } = withLimits([limitOn, limit(6, 2, 6, 1, 40, null), limit(7, 2, 6, 0, 39, null)]);
    expect(entries[0]).toMatchObject({ quantity: 'current-limit', kind: 'limited', limit: null });
  });
  test('events the monitor could not hold are counted', () => {
    expect(withLimits([limitOn, row(9, 9, [2, null, null, null, 7, null]), row(11, 11, [2, null, null, null, 3, null])]).dropped).toBe(10);
  });
});
