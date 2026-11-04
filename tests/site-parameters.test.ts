import { describe, expect, test } from 'vitest';
import { compassDeclinationDeg, siteParameters } from '@mirage/aircraft/site-parameters';
import table from '../data/ardupilot/declination.json' with { type: 'json' };

// TASK-172: COMPASS_DEC from the run's home. Oracle: the values the pinned
// ArduCopter 8ab6afd itself reported (PARM in its DataFlash log) once it knew
// where it was, in runs started at those places with no COMPASS_DEC given; and the
// table's own grid points, read straight from the file.
const grid = (latitudeDeg: number, longitudeDeg: number): number => {
  const value = table.rowsDeg[(latitudeDeg + 90) / 10]?.[(longitudeDeg + 180) / 10];
  if (value === undefined) throw new Error('Not a grid point');
  return value;
};

describe('the declination at a place', () => {
  test('is what ArduCopter itself reports there', () => {
    // CMAC, Canberra, the default home. ArduPilot interpolates in float32, so its last bits differ; 1e-6 rad is 0.00006°.
    const [parameter] = siteParameters([-35.363261, 149.16523, 584, 0]);
    expect(parameter?.name).toBe('COMPASS_DEC');
    expect(parameter?.value).toBeCloseTo(0.2233572006225586, 6);
    // Zurich, started there with COMPASS_DEC not given: another cell of the table.
    expect(siteParameters([47.397742, 8.545594, 488, 0])[0]?.value).toBeCloseTo(0.05564587935805321, 6);
  });
  test('is the table at its grid points, and in between lies between them', () => {
    expect(table.rowsDeg).toHaveLength(19);
    expect(table.rowsDeg.every(row => row.length === 37)).toBe(true);
    expect(compassDeclinationDeg(-30, 150)).toBe(grid(-30, 150));
    expect(compassDeclinationDeg(40, -120)).toBe(grid(40, -120));
    // Halfway along one side of a cell, and at its centre, by hand from the corners.
    expect(compassDeclinationDeg(-30, 155)).toBeCloseTo((grid(-30, 150) + grid(-30, 160)) / 2, 12);
    expect(compassDeclinationDeg(-35, 155)).toBeCloseTo((grid(-30, 150) + grid(-30, 160) + grid(-40, 150) + grid(-40, 160)) / 4, 12);
  });
  test('holds at the ends of the table', () => {
    expect(compassDeclinationDeg(90, 180)).toBe(grid(90, 180));
    expect(compassDeclinationDeg(-90, -180)).toBe(grid(-90, -180));
    expect(compassDeclinationDeg(90, 0)).toBe(grid(90, 0));
    expect(compassDeclinationDeg(0, 180)).toBe(grid(0, 180));
  });
  test('refuses a place off the table', () => {
    expect(() => compassDeclinationDeg(91, 0)).toThrow('Latitude 91');
    expect(() => compassDeclinationDeg(0, -181)).toThrow('Longitude -181');
    expect(() => compassDeclinationDeg(Number.NaN, 0)).toThrow('Latitude');
    expect(() => siteParameters([])).toThrow('latitude and a longitude');
  });
  test('is stored as ArduPilot stores it, a float32 in radians', () => {
    const [parameter] = siteParameters([47.397742, 8.545594, 488, 0]);
    expect(parameter?.value).toBe(Math.fround(parameter?.value ?? Number.NaN));
    expect(parameter?.value).toBeCloseTo(compassDeclinationDeg(47.397742, 8.545594) * Math.PI / 180, 6);
  });
});
