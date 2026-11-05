import { describe, expect, test } from 'vitest';
import { flightTaskSchemaVersion, parseFlightTask, type FlightTaskType } from '@mirage/scenarios/flight-tasks';
import type { ResponseSeries } from '@mirage/scenarios/maneuvers';
import { PLOT_BOX, niceTicks, plotGeometry, thinned } from '../apps/web/src/analysis/response-geometry.ts';
import { maneuverSeries, valueAt, type RecordedRow } from '@mirage/analysis/response-series';

// The series a chart and its metrics read, from rows as a recording holds them, and
// the chart's one time scale. The quaternions and rows here are written out by hand.

const GROUND = { northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 1 };
const task = (type: FlightTaskType, parameters: Record<string, number>) => parseFlightTask({ schemaVersion: flightTaskSchemaVersion(type), type, parameters, route: null, initial: { ground: GROUND, air: null }, finish: 'land' });
const ROLL_TASK = task('roll-step', { altitudeM: 10, headingDeg: 30, amplitudeDeg: 10, holdS: 2 });
/** arm, takeoff, heading, then the maneuver. */
const ROLL_STAGE = 3;
const row = (tick: number, simTimeS: number, values: readonly (number | null)[]): RecordedRow => ({
  tick, simTimeS, presence: values.reduce<number>((mask, value, i) => (value === null ? mask : mask + 2 ** i), 0), values: values.map(value => value ?? 0),
});
/** A row of events.flightTask: stage, measured, task time, north, east, altitude, speed, heading, vertical speed. */
const request = (tick: number, simTimeS: number, stage: number, altitudeM: number | null, headingDeg: number | null) => row(tick, simTimeS, [stage, 1, 0, 0, 0, altitudeM, 0, headingDeg, 0]);
const attitude = (tick: number, simTimeS: number, rollDeg: number) => {
  const half = rollDeg * Math.PI / 360;
  return row(tick, simTimeS, [Math.cos(half), Math.sin(half), 0, 0]);
};
const yawed = (tick: number, simTimeS: number, yawDeg: number) => {
  const half = yawDeg * Math.PI / 360;
  return row(tick, simTimeS, [Math.cos(half), 0, 0, Math.sin(half)]);
};

describe('a maneuver from its recording', () => {
  test('a roll reads its own requests and the truth, on the recording\'s clock', () => {
    const rows = new Map<string, RecordedRow[]>([
      // A request of the lead-in, which must not count, and the maneuver's.
      ['events.flightTask', [request(100, 50, 2, 10, 30), request(200, 51, ROLL_STAGE, null, 30), request(300, 52, ROLL_STAGE, null, 30)]],
      ['events.flightTaskAttitude', [row(200, 51, [0, 0]), row(300, 52, [10, 0])]],
      ['truth.attitude', [attitude(0, 40, 99), attitude(160, 50.5, 0.5), attitude(240, 51.5, 1), attitude(320, 52.1, 9), attitude(900, 60, 99)]],
    ]);
    const result = maneuverSeries(ROLL_TASK, rows);
    if (result.kind !== 'series') throw new Error(result.reason);
    expect(result.series.axis).toBe('roll');
    expect(result.series.unit).toBe('°');
    expect(result.series.requested).toEqual({ timeS: [51, 52], value: [0, 10] });
    expect(result.series.startS).toBe(51);
    expect(result.series.endS).toBe(52);
    // From a second before the first request, so the first change has a value to start from; nothing after the last.
    expect(result.series.actual.timeS).toEqual([50.5, 51.5]);
    result.series.actual.value.forEach((value, i) => expect(value).toBeCloseTo([0.5, 1][i] ?? Number.NaN, 9));
  });
  test('a pitch reads the second channel, and an altitude the position', () => {
    const pitch = task('pitch-step', { altitudeM: 10, headingDeg: 30, amplitudeDeg: 10, holdS: 2 });
    const half = 5 * Math.PI / 360;
    const result = maneuverSeries(pitch, new Map([
      ['events.flightTask', [request(1, 1, ROLL_STAGE, null, 30), request(2, 2, ROLL_STAGE, null, 30)]],
      ['events.flightTaskAttitude', [row(1, 1, [0, 0]), row(2, 2, [0, -8])]],
      ['truth.attitude', [row(1, 1, [Math.cos(half), 0, Math.sin(half), 0])]],
    ]));
    if (result.kind !== 'series') throw new Error(result.reason);
    expect(result.series.requested.value).toEqual([0, -8]);
    expect(result.series.actual.value[0]).toBeCloseTo(5, 9);

    const altitude = task('altitude-step', { altitudeM: 10, amplitudeM: 3, holdS: 2 });
    const up = maneuverSeries(altitude, new Map([
      // arm, takeoff, then the maneuver.
      ['events.flightTask', [request(1, 1, 2, 10, 0), request(2, 2, 2, 13, 0)]],
      ['truth.position', [row(1, 1, [0, 0, -10.2]), row(2, 2, [0, 0, -11])]],
    ]));
    if (up.kind !== 'series') throw new Error(up.reason);
    expect(up.series.requested.value).toEqual([10, 13]);
    expect(up.series.actual.value).toEqual([10.2, 11]);
    expect(up.series.unit).toBe('m');
  });
  test('a heading stays continuous through north, and actual counts the same turns as the request', () => {
    const heading = task('heading-step', { altitudeM: 10, headingDeg: 350, amplitudeDeg: 45, holdS: 2 });
    const result = maneuverSeries(heading, new Map([
      ['events.flightTask', [request(1, 1, ROLL_STAGE, 10, 350), request(2, 2, ROLL_STAGE, 10, 35)]],
      // The quaternion's yaw reads -10°, then 10°.
      ['truth.attitude', [yawed(1, 1, -10), yawed(2, 2, 10)]],
    ]));
    if (result.kind !== 'series') throw new Error(result.reason);
    expect(result.series.requested.value).toEqual([350, 395]);
    expect(result.series.actual.value[0]).toBeCloseTo(350, 9);
    expect(result.series.actual.value[1]).toBeCloseTo(370, 9);
  });
  test('what the recording lacks is said, not filled in', () => {
    const missing = (rows: Map<string, RecordedRow[]>) => { const result = maneuverSeries(ROLL_TASK, rows); return result.kind === 'missing' ? result.reason : ''; };
    expect(missing(new Map())).toContain('no requests of the maneuver');
    expect(missing(new Map([['events.flightTask', [request(1, 1, 2, 10, 30)]]]))).toContain('no requests of the maneuver');
    expect(missing(new Map([['events.flightTask', [request(1, 1, ROLL_STAGE, null, 30)]]]))).toContain('no roll requests');
    expect(missing(new Map([['events.flightTask', [request(1, 1, ROLL_STAGE, null, 30)]], ['events.flightTaskAttitude', [row(1, 1, [0, 0])]]]))).toContain('no truth.attitude');
    expect(maneuverSeries(task('hover', { altitudeM: 5, durationS: 3 }), new Map())).toMatchObject({ kind: 'missing' });
  });
  test('a request absent from its channel is not read as zero', () => {
    const rows = new Map<string, RecordedRow[]>([
      ['events.flightTask', [request(1, 1, ROLL_STAGE, null, 30)]],
      // Presence says only pitch is here.
      ['events.flightTaskAttitude', [{ tick: 1, simTimeS: 1, presence: 2, values: [0, 4] }]],
      ['truth.attitude', [attitude(1, 1, 0)]],
    ]);
    expect(maneuverSeries(ROLL_TASK, rows)).toMatchObject({ kind: 'missing' });
  });
  test('the value at a moment is the last one at or before it', () => {
    const series: ResponseSeries = { timeS: [1, 2, 3], value: [10, 20, 30] };
    expect([0.5, 1, 1.5, 2, 2.9, 3, 9].map(t => valueAt(series, t))).toEqual([null, 10, 10, 20, 20, 30, 30]);
  });
});

describe('the chart\'s one time scale', () => {
  const requested: ResponseSeries = { timeS: [10, 11, 12, 13], value: [0, 0, 10, 10] };
  // The same step, 0.25 s after the request, at 100 Hz.
  const actual: ResponseSeries = { timeS: Array.from({ length: 300 }, (_, i) => 10 + i / 100), value: Array.from({ length: 300 }, (_, i) => (10 + i / 100 < 12.25 ? 0 : 10)) };
  const plot = plotGeometry(requested, actual, 10, 13);
  const pixelsPerS = (PLOT_BOX.width - PLOT_BOX.left - PLOT_BOX.right) / 3;
  test('the ends of the time span are the ends of the plot', () => {
    expect(plot.xOfS(10)).toBe(PLOT_BOX.left);
    expect(plot.xOfS(13)).toBeCloseTo(PLOT_BOX.width - PLOT_BOX.right, 9);
  });
  test('the request\'s corner is drawn at its moment', () => {
    expect(plot.requestedPath).toContain(`H${Math.round(plot.xOfS(12) * 100) / 100}V${Math.round(plot.yOf(10) * 100) / 100}`);
  });
  test('a response 0.25 s late is drawn 0.25 s late', () => {
    // The actual line's jump, read back from its path, against the request's corner.
    const points = [...plot.actualPath.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
    const jump = points.findIndex(point => Math.abs(point.y - plot.yOf(10)) < 0.01);
    expect(jump).toBeGreaterThan(0);
    const lateS = ((points[jump]?.x ?? 0) - plot.xOfS(12)) / pixelsPerS;
    expect(Math.abs(lateS - 0.25)).toBeLessThanOrEqual(1 / 100 + 1e-3);
  });
  test('the value axis holds both lines, with round ticks', () => {
    for (const tick of plot.yTicks) expect(tick.value * 10 % 5).toBeCloseTo(0, 9);
    expect(plot.yOf(10)).toBeGreaterThanOrEqual(PLOT_BOX.top);
    expect(plot.yOf(0)).toBeLessThanOrEqual(PLOT_BOX.height - PLOT_BOX.bottom);
    expect(plot.xTicks[0]).toEqual({ value: 0, at: PLOT_BOX.left });
  });
  test('ticks stay on round numbers without binary fractions', () => {
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0, 3, 8)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);
    expect(niceTicks(9.7, 13.3, 5)).toEqual([10, 11, 12, 13]);
    expect(niceTicks(4, 4, 5)).toEqual([4]);
  });
  test('thinning keeps every extreme of a line too dense to draw', () => {
    const dense: ResponseSeries = { timeS: Array.from({ length: 48000 }, (_, i) => i / 800), value: Array.from({ length: 48000 }, (_, i) => (i === 12345 ? 99 : i === 23456 ? -99 : Math.sin(i / 50))) };
    const points = thinned(dense, t => t * 10);
    expect(points.length).toBeLessThan(2500);
    expect(Math.max(...points.map(point => point.value))).toBe(99);
    expect(Math.min(...points.map(point => point.value))).toBe(-99);
    for (let i = 1; i < points.length; i++) expect((points[i]?.x ?? 0)).toBeGreaterThanOrEqual(points[i - 1]?.x ?? 0);
  });
});
