import { describe, expect, it } from 'vitest';
import { NO_ALIGNMENT, alignStarts, intervalOf, overlapS, plottedS, secondS, validateLogComparison, viewerAlignment, type LogAlignment } from '../apps/web/src/analysis/log-alignment';

// TASK-181. The fixture is written by hand: a maneuver starts at 72.5 s in the first flight and at 41.25 s in the second, each lasting 10 s.

const first = { fromS: 72.5, toS: 82.5 }, second = { fromS: 41.25, toS: 51.25 };
const aligned: LogAlignment = { mode: 'overlay', first, second, secondOffsetS: 31.25 };
const log = (name: string, digit: string) => ({ name, sha256: digit.repeat(64), experimentSha256: null });

describe('aligning two logs', () => {
  it('moves the second start onto the first', () => {
    expect(alignStarts(first, second)).toBe(31.25);
    expect(plottedS(aligned, 41.25)).toBe(72.5);
    expect(plottedS(aligned, 51.25)).toBe(82.5);
    expect(secondS(aligned, 72.5)).toBe(41.25);
    expect(overlapS(aligned)).toBe(10);
  });
  it('a manual shift on top moves the overlap by exactly that much', () => {
    const shifted = { ...aligned, secondOffsetS: aligned.secondOffsetS + 1.5 };
    expect(plottedS(shifted, 41.25)).toBe(74);
    expect(overlapS(shifted)).toBe(8.5);
    expect(overlapS({ ...aligned, secondOffsetS: aligned.secondOffsetS + 20 })).toBe(0);
  });
  it('two intervals of one flight are the same arithmetic', () => {
    expect(alignStarts({ fromS: 10, toS: 20 }, { fromS: 40, toS: 50 })).toBe(-30);
  });
  it('without an interval a log starts at its own zero, and overlap says nothing', () => {
    expect(alignStarts(null, null)).toBe(0);
    expect(alignStarts(null, second)).toBe(-41.25);
    expect(overlapS(NO_ALIGNMENT)).toBeNull();
  });
  it('tells the viewer in milliseconds', () => {
    expect(viewerAlignment({ ...aligned, mode: 'side-by-side' })).toEqual({ mode: 'side-by-side', first: [72500, 82500], second: [41250, 51250], secondOffsetMs: 31250 });
    expect(viewerAlignment(NO_ALIGNMENT)).toEqual({ mode: 'overlay', first: null, second: null, secondOffsetMs: 0 });
  });
  it('reads an interval from a form, or says why not', () => {
    expect(intervalOf('', '')).toBeNull();
    expect(intervalOf('1', '2')).toEqual({ fromS: 1, toS: 2 });
    expect(intervalOf('1', '')).toContain('both');
    expect(intervalOf('2', '1')).toContain('before it ends');
    expect(intervalOf('a', '2')).toContain('both');
  });
});

describe('a saved comparison', () => {
  const comparison = { schemaVersion: 1, first: log('a.bin', 'a'), second: log('b.bin', 'b'), alignment: aligned };
  it('keeps the offset of each source and the intervals', () => {
    expect(validateLogComparison(JSON.parse(JSON.stringify(comparison)))).toEqual(comparison);
  });
  it('refuses what is not one', () => {
    expect(() => validateLogComparison({ ...comparison, schemaVersion: 2 })).toThrow('schemaVersion');
    expect(() => validateLogComparison({ ...comparison, alignment: { ...aligned, mode: 'stacked' } })).toThrow('mode');
    expect(() => validateLogComparison({ ...comparison, alignment: { ...aligned, secondOffsetS: 'x' } })).toThrow('secondOffsetS');
    expect(() => validateLogComparison({ ...comparison, alignment: { ...aligned, first: { fromS: 2, toS: 1 } } })).toThrow('before it ends');
    expect(() => validateLogComparison({ ...comparison, first: { ...comparison.first, sha256: 'x' } })).toThrow('SHA-256');
  });
});
