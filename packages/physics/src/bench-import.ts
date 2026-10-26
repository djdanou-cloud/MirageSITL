import { isaTroposphere } from './atmosphere.ts';

// Static thrust-stand import (TASK-090). Bench CSV v1 is strict text:
//   mirage-bench-csv,1
//   diameterM,<propeller diameter>
//   rpm,thrustN,torqueNm,airDensityKgM3
//   <one row per operating point>
// Coefficients use n = rpm/60 rev/s and diameter D (propeller convention):
// CT = T/(ρ·n²·D⁴), CQ = Q/(ρ·n²·D⁵), CP = 2π·CQ.

export const BENCH_CSV_HEADER = 'rpm,thrustN,torqueNm,airDensityKgM3';
/** US Standard Atmosphere 1976 sea-level density from the repository ISA model, kg/m^3. */
export const ISA_SEA_LEVEL_DENSITY_KG_M3 = isaTroposphere(0).densityKgM3;
/** Density envelope shared with `atmosphereFromState`, kg/m^3. */
const DENSITY_MIN_KG_M3 = 0.05, DENSITY_MAX_KG_M3 = 2;
const MAX_ROWS = 10000;

export type BenchFlag = 'negative-thrust' | 'negative-torque' | 'figure-of-merit-above-one';
export interface BenchPoint {
  readonly rpm: number; readonly thrustN: number; readonly torqueNm: number; readonly airDensityKgM3: number;
  readonly ct: number; readonly cq: number; readonly cp: number;
  /** Thrust and torque scaled to ISA sea-level density at the same rpm. */
  readonly thrustIsaN: number; readonly torqueIsaNm: number;
  /** Static figure of merit √(2/π)·CT^(3/2)/CP; NaN unless CT and CP are positive. */
  readonly figureOfMerit: number;
  readonly flags: readonly BenchFlag[];
}
export interface BenchImport { readonly diameterM: number; readonly points: readonly BenchPoint[] }

const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/;
function parseNumber(text: string, label: string, line: number): number {
  if (!NUMBER.test(text)) throw new Error(`Bench CSV line ${line}: ${label} is not a decimal number`);
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`Bench CSV line ${line}: ${label} is not finite`);
  return value;
}

/** Parses and converts one bench CSV v1 file. Rows keep their file order. */
export function importBenchCsv(text: string): BenchImport {
  if (text.length > 4 * 1024 * 1024) throw new Error('Bench CSV exceeds 4 MiB');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== 'mirage-bench-csv,1') throw new Error('Bench CSV must start with mirage-bench-csv,1');
  const diameter = lines[1]?.split(',');
  if (!diameter || diameter.length !== 2 || diameter[0] !== 'diameterM') throw new Error('Bench CSV line 2 must be diameterM,<value>');
  const diameterM = parseNumber(diameter[1]!, 'diameterM', 2);
  if (diameterM <= 0 || diameterM > 10) throw new Error('Bench CSV diameter must be in (0, 10] m');
  if (lines[2] !== BENCH_CSV_HEADER) throw new Error(`Bench CSV line 3 must be ${BENCH_CSV_HEADER}`);
  const rows = lines.slice(3);
  if (rows.length < 1 || rows.length > MAX_ROWS) throw new Error(`Bench CSV needs 1..${MAX_ROWS} data rows`);
  const d4 = diameterM ** 4, d5 = diameterM ** 5;
  const points = rows.map((row, index): BenchPoint => {
    const line = index + 4, fields = row.split(',');
    if (fields.length !== 4) throw new Error(`Bench CSV line ${line}: expected four fields`);
    const rpm = parseNumber(fields[0]!, 'rpm', line), thrustN = parseNumber(fields[1]!, 'thrustN', line);
    const torqueNm = parseNumber(fields[2]!, 'torqueNm', line), airDensityKgM3 = parseNumber(fields[3]!, 'airDensityKgM3', line);
    if (rpm <= 0) throw new Error(`Bench CSV line ${line}: rpm must be positive`);
    if (airDensityKgM3 < DENSITY_MIN_KG_M3 || airDensityKgM3 > DENSITY_MAX_KG_M3) throw new Error(`Bench CSV line ${line}: density outside [0.05, 2] kg/m^3`);
    const n = rpm / 60, ct = thrustN / (airDensityKgM3 * n * n * d4), cq = torqueNm / (airDensityKgM3 * n * n * d5);
    const cp = 2 * Math.PI * cq, ratio = ISA_SEA_LEVEL_DENSITY_KG_M3 / airDensityKgM3;
    const figureOfMerit = ct > 0 && cp > 0 ? Math.sqrt(2 / Math.PI) * ct ** 1.5 / cp : NaN;
    const flags: BenchFlag[] = [];
    if (thrustN < 0) flags.push('negative-thrust');
    if (torqueNm < 0) flags.push('negative-torque');
    // Momentum theory bounds static free-air thrust per unit power: FM <= 1.
    if (figureOfMerit > 1) flags.push('figure-of-merit-above-one');
    return Object.freeze({ rpm, thrustN, torqueNm, airDensityKgM3, ct, cq, cp, thrustIsaN: thrustN * ratio,
      torqueIsaNm: torqueNm * ratio, figureOfMerit, flags: Object.freeze(flags) });
  });
  return Object.freeze({ diameterM, points: Object.freeze(points) });
}
