import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BENCH_CSV_HEADER, ISA_SEA_LEVEL_DENSITY_KG_M3, importBenchCsv } from '@mirage/physics/bench-import';

const fixture = readFileSync(new URL('./fixtures/validation/bench-synthetic.csv', import.meta.url), 'utf8');
const relative = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected);
const file = (rows: readonly string[], diameter = '0.254') =>
  ['mirage-bench-csv,1', `diameterM,${diameter}`, BENCH_CSV_HEADER, ...rows].join('\n') + '\n';

describe('bench CSV v1 import', () => {
  it('recovers the constant coefficients of the synthetic sweep with density correction', () => {
    // Fixture rows: T = CT·ρ·n²·D⁴, Q = CP/(2π)·ρ·n²·D⁵ with CT = 0.11, CP = 0.045, D = 0.254 m,
    // printed with 12 significant digits, so 1e-10 relative bounds the recovery.
    const bench = importBenchCsv(fixture), D = 0.254;
    expect(bench.diameterM).toBe(D);
    expect(bench.points.map(point => point.rpm)).toEqual([2000, 3000, 4000, 5000, 6000, 7000, 8000]);
    for (const point of bench.points) {
      const n = point.rpm / 60;
      expect(relative(point.ct, 0.11)).toBeLessThan(1e-10);
      expect(relative(point.cp, 0.045)).toBeLessThan(1e-10);
      expect(relative(point.cq, 0.045 / (2 * Math.PI))).toBeLessThan(1e-10);
      // Scaled to ISA sea level, every row matches the coefficient at the reference density.
      expect(relative(point.thrustIsaN, 0.11 * ISA_SEA_LEVEL_DENSITY_KG_M3 * n * n * D ** 4)).toBeLessThan(1e-10);
      expect(relative(point.torqueIsaNm, 0.045 / (2 * Math.PI) * ISA_SEA_LEVEL_DENSITY_KG_M3 * n * n * D ** 5)).toBeLessThan(1e-10);
      expect(relative(point.figureOfMerit, Math.sqrt(2 / Math.PI) * 0.11 ** 1.5 / 0.045)).toBeLessThan(1e-9);
      expect(point.flags).toEqual([]);
    }
    expect(bench.points[3]?.airDensityKgM3).toBe(1.1);
    expect(Object.isFrozen(bench.points[0])).toBe(true);
  });

  it('uses the US Standard Atmosphere 1976 sea-level density', () => {
    expect(ISA_SEA_LEVEL_DENSITY_KG_M3).toBeCloseTo(1.225, 4);
  });

  it('accepts CRLF line endings and a missing final newline', () => {
    const crlf = importBenchCsv(fixture.replace(/\n/g, '\r\n'));
    expect(crlf).toEqual(importBenchCsv(fixture));
    expect(importBenchCsv(fixture.slice(0, -1)).points.length).toBe(7);
  });

  it('flags physically inconsistent rows without discarding them', () => {
    // CT = 0.2, CP = 0.05 gives FM = √(2/π)·0.2^1.5/0.05 ≈ 1.43 > 1.
    const n = 5000 / 60, D = 0.254, rho = 1.2;
    const strong = `5000,${0.2 * rho * n * n * D ** 4},${0.05 / (2 * Math.PI) * rho * n * n * D ** 5},${rho}`;
    const bench = importBenchCsv(file(['3000,-0.5,0.02,1.2', '4000,2.4,-0.04,1.2', strong]));
    expect(bench.points.map(point => point.flags)).toEqual([['negative-thrust'], ['negative-torque'], ['figure-of-merit-above-one']]);
    expect(Number.isNaN(bench.points[0]?.figureOfMerit)).toBe(true);
    expect(Number.isNaN(bench.points[1]?.figureOfMerit)).toBe(true);
    expect(bench.points[2]?.figureOfMerit).toBeCloseTo(Math.sqrt(2 / Math.PI) * 0.2 ** 1.5 / 0.05, 9);
  });

  it('rejects malformed files and values outside the envelope', () => {
    const row = '3000,1.37,0.0227,1.2';
    const invalid: [string, string][] = [
      ['version', fixture.replace('mirage-bench-csv,1', 'mirage-bench-csv,2')],
      ['missing diameter', ['mirage-bench-csv,1', BENCH_CSV_HEADER, row].join('\n')],
      ['zero diameter', file([row], '0')],
      ['diameter above 10 m', file([row], '12')],
      ['column order', ['mirage-bench-csv,1', 'diameterM,0.254', 'rpm,torqueNm,thrustN,airDensityKgM3', row].join('\n')],
      ['no rows', file([])],
      ['extra field', file(['3000,1.37,0.0227,1.2,12.6'])],
      ['missing field', file(['3000,1.37,0.0227'])],
      ['hex value', file(['0x10,1.37,0.0227,1.2'])],
      ['infinite value', file(['3000,Infinity,0.0227,1.2'])],
      ['empty value', file(['3000,,0.0227,1.2'])],
      ['dangling exponent', file(['3000,1e,0.0227,1.2'])],
      ['leading plus', file(['+3000,1.37,0.0227,1.2'])],
      ['blank row', file([row, '', row])],
      ['zero rpm', file(['0,1.37,0.0227,1.2'])],
      ['density below 0.05', file(['3000,1.37,0.0227,0.01'])],
      ['density above 2', file(['3000,1.37,0.0227,3'])],
      ['too many rows', file(Array.from({ length: 10001 }, () => row))],
    ];
    for (const [label, text] of invalid) expect(() => importBenchCsv(text), label).toThrow();
  });
});
