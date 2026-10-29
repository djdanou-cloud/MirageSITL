import { atmosphereFromState, isaTroposphere } from './atmosphere.ts';

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

// Bench CSV v2 (TASK-140): one set of conditions for the whole file and only
// the quantities that were measured. Layout:
//   mirage-bench-csv,2
//   diameterM,<propeller diameter>
//   airDensityKgM3,<value>          or  airTemperatureK,<value> then airPressurePa,<value>
//   supplyVoltageV,<value>          (optional)
//   rpm,thrustN[,torqueNm][,voltageV][,currentA]
//   <one row per operating point>
// A quantity that was not measured is an absent column, never an empty field
// or a filled-in value.

/** Optional measured columns, in their fixed order after rpm and thrustN. */
export const BENCH_OPTIONAL_QUANTITIES = ['torqueNm', 'voltageV', 'currentA'] as const;
export type BenchOptionalQuantity = typeof BENCH_OPTIONAL_QUANTITIES[number];
/** Points in one bench file or measurement set. */
export const MAX_BENCH_POINTS = 4096;
/**
 * |C_T| or |C_P| above this is refused. The largest static coefficients of the
 * 14 measured UIUC propellers in tests/fixtures/rotors/uiuc-propellers.json are
 * C_T = 0.254 and C_P = 0.193; a thrust in grams, a torque in N·mm or a speed
 * in rad/s multiplies a coefficient by about 100 or more.
 */
export const MAX_BENCH_COEFFICIENT = 1;

/** Conditions of one bench run: the air density, or the temperature and pressure it follows from, and the nominal supply voltage. */
export interface BenchConditions {
  readonly airDensityKgM3: number | null;
  readonly airTemperatureK: number | null;
  readonly airPressurePa: number | null;
  /** Null when not recorded. */
  readonly supplyVoltageV: number | null;
}
/** Measured values by quantity; an optional quantity that was not measured is null. */
export interface BenchColumns {
  readonly rpm: readonly number[];
  readonly thrustN: readonly number[];
  readonly torqueNm: readonly number[] | null;
  readonly voltageV: readonly number[] | null;
  readonly currentA: readonly number[] | null;
}
export type BenchMeasurementFlag = BenchFlag | 'electrical-power-below-shaft-power';
export interface BenchMeasurementPoint {
  readonly rpm: number; readonly thrustN: number;
  readonly torqueNm: number | null; readonly voltageV: number | null; readonly currentA: number | null;
  readonly ct: number; readonly cq: number | null; readonly cp: number | null;
  /** Thrust and torque scaled to ISA sea-level density at the same rpm. */
  readonly thrustIsaN: number; readonly torqueIsaNm: number | null;
  /** Q·ω, with torque. */
  readonly shaftPowerW: number | null;
  /** V·I, with voltage and current. */
  readonly electricalPowerW: number | null;
  /** √(2/π)·CT^(3/2)/CP, with torque and positive CT and CP. */
  readonly figureOfMerit: number | null;
  readonly flags: readonly BenchMeasurementFlag[];
}
export interface BenchMeasurements {
  readonly diameterM: number;
  readonly conditions: BenchConditions;
  /** The density the coefficients use: as measured, or p/(R·T). */
  readonly airDensityKgM3: number;
  /** What the data does not contain: unmeasured columns, then the supply voltage. */
  readonly missing: readonly string[];
  readonly points: readonly BenchMeasurementPoint[];
}

interface Bound { readonly min: number; readonly max: number; readonly minOpen: boolean; readonly unit: string }
/**
 * Parser bounds that catch unit mistakes, not physical envelopes: a
 * temperature in °C, a pressure in hPa or kPa and a density in lb/ft³ fall
 * outside them. The temperature range stays inside `atmosphereFromState`.
 */
const BOUNDS = {
  diameterM: { min: 0, max: 10, minOpen: true, unit: 'm' },
  rpm: { min: 0, max: 100000, minOpen: true, unit: 'rpm' },
  thrustN: { min: -10000, max: 10000, minOpen: false, unit: 'N' },
  torqueNm: { min: -1000, max: 1000, minOpen: false, unit: 'N·m' },
  voltageV: { min: 0, max: 1000, minOpen: true, unit: 'V' },
  currentA: { min: 0, max: 10000, minOpen: false, unit: 'A' },
  airDensityKgM3: { min: 0.3, max: 1.6, minOpen: false, unit: 'kg/m³' },
  airTemperatureK: { min: 233.15, max: 323.15, minOpen: false, unit: 'K' },
  airPressurePa: { min: 30000, max: 110000, minOpen: false, unit: 'Pa' },
  supplyVoltageV: { min: 0, max: 1000, minOpen: true, unit: 'V' },
} as const satisfies { readonly [name: string]: Bound };

function checkBound(name: keyof typeof BOUNDS, value: number, where: string): void {
  const bound: Bound = BOUNDS[name];
  const inside = (bound.minOpen ? value > bound.min : value >= bound.min) && value <= bound.max;
  if (!Number.isFinite(value) || !inside) {
    throw new Error(`${where}${name} ${value} is outside ${bound.minOpen ? '(' : '['}${bound.min}, ${bound.max}] ${bound.unit}`);
  }
}

/**
 * Checks bench data against the v2 rules and computes its coefficients.
 * `where` prefixes condition errors and `locate(i)` the errors of point i.
 */
export function benchMeasurements(diameterM: number, conditions: BenchConditions, columns: BenchColumns,
  where = 'Bench data: ', locate: (index: number) => string = index => `Bench point ${index + 1}: `): BenchMeasurements {
  checkBound('diameterM', diameterM, where);
  const { airDensityKgM3, airTemperatureK, airPressurePa, supplyVoltageV } = conditions;
  let density: number;
  if (airDensityKgM3 !== null && airTemperatureK === null && airPressurePa === null) {
    checkBound('airDensityKgM3', airDensityKgM3, where);
    density = airDensityKgM3;
  } else if (airDensityKgM3 === null && airTemperatureK !== null && airPressurePa !== null) {
    checkBound('airTemperatureK', airTemperatureK, where);
    checkBound('airPressurePa', airPressurePa, where);
    density = atmosphereFromState({ temperatureK: airTemperatureK, pressurePa: airPressurePa }).densityKgM3;
  } else {
    throw new Error(`${where}the conditions need airDensityKgM3, or airTemperatureK and airPressurePa, but not both`);
  }
  if (supplyVoltageV !== null) checkBound('supplyVoltageV', supplyVoltageV, where);
  const count = columns.rpm.length;
  if (count < 1 || count > MAX_BENCH_POINTS) throw new Error(`${where}bench data needs 1..${MAX_BENCH_POINTS} data rows`);
  for (const key of ['thrustN', ...BENCH_OPTIONAL_QUANTITIES] as const) {
    const column = columns[key];
    if (column !== null && column.length !== count) throw new Error(`${where}the ${key} column needs one value per rpm value`);
  }
  const d4 = diameterM ** 4, d5 = diameterM ** 5, ratio = ISA_SEA_LEVEL_DENSITY_KG_M3 / density;
  const points: BenchMeasurementPoint[] = [];
  for (let i = 0; i < count; i++) {
    const at = locate(i);
    // Array lengths were checked above.
    const rpm = columns.rpm[i]!, thrustN = columns.thrustN[i]!;
    const torqueNm = columns.torqueNm?.[i] ?? null, voltageV = columns.voltageV?.[i] ?? null, currentA = columns.currentA?.[i] ?? null;
    checkBound('rpm', rpm, at);
    checkBound('thrustN', thrustN, at);
    if (torqueNm !== null) checkBound('torqueNm', torqueNm, at);
    if (voltageV !== null) checkBound('voltageV', voltageV, at);
    if (currentA !== null) checkBound('currentA', currentA, at);
    const n = rpm / 60, ct = thrustN / (density * n * n * d4);
    const cq = torqueNm === null ? null : torqueNm / (density * n * n * d5), cp = cq === null ? null : 2 * Math.PI * cq;
    if (Math.abs(ct) > MAX_BENCH_COEFFICIENT) {
      throw new Error(`${at}the thrust coefficient ${ct.toPrecision(3)} is above ${MAX_BENCH_COEFFICIENT} in magnitude; check that thrust is in newtons and speed in rev/min`);
    }
    if (cp !== null && Math.abs(cp) > MAX_BENCH_COEFFICIENT) {
      throw new Error(`${at}the power coefficient ${cp.toPrecision(3)} is above ${MAX_BENCH_COEFFICIENT} in magnitude; check that torque is in N·m and speed in rev/min`);
    }
    const shaftPowerW = torqueNm === null ? null : torqueNm * 2 * Math.PI * n;
    const electricalPowerW = voltageV === null || currentA === null ? null : voltageV * currentA;
    const figureOfMerit = cp !== null && ct > 0 && cp > 0 ? Math.sqrt(2 / Math.PI) * ct ** 1.5 / cp : null;
    const flags: BenchMeasurementFlag[] = [];
    if (thrustN < 0) flags.push('negative-thrust');
    if (torqueNm !== null && torqueNm < 0) flags.push('negative-torque');
    if (figureOfMerit !== null && figureOfMerit > 1) flags.push('figure-of-merit-above-one');
    // A motor and ESC cannot deliver more shaft power than they draw.
    if (shaftPowerW !== null && electricalPowerW !== null && shaftPowerW > electricalPowerW) flags.push('electrical-power-below-shaft-power');
    points.push(Object.freeze({
      rpm, thrustN, torqueNm, voltageV, currentA, ct, cq, cp, thrustIsaN: thrustN * ratio,
      torqueIsaNm: torqueNm === null ? null : torqueNm * ratio, shaftPowerW, electricalPowerW, figureOfMerit, flags: Object.freeze(flags),
    }));
  }
  const missing: string[] = BENCH_OPTIONAL_QUANTITIES.filter(key => columns[key] === null);
  if (supplyVoltageV === null) missing.push('supplyVoltageV');
  return Object.freeze({
    diameterM, conditions: Object.freeze({ airDensityKgM3, airTemperatureK, airPressurePa, supplyVoltageV }),
    airDensityKgM3: density, missing: Object.freeze(missing), points: Object.freeze(points),
  });
}

const CONDITION_SEQUENCES = ['airDensityKgM3', 'airTemperatureK,airPressurePa'];

/**
 * Parses bench CSV v2, or v1 when its rows share one air density, into bench
 * measurements. Rows keep their file order.
 */
export function importBenchMeasurements(text: string): BenchMeasurements {
  if (text.length > 4 * 1024 * 1024) throw new Error('Bench CSV exceeds 4 MiB');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] === 'mirage-bench-csv,1') {
    const v1 = importBenchCsv(text);
    const density = v1.points[0]!.airDensityKgM3;
    if (v1.points.some(point => point.airDensityKgM3 !== density)) {
      throw new Error('Bench CSV v1 rows have different air densities; one bench run has one set of conditions, so split the file or write bench CSV v2');
    }
    return benchMeasurements(v1.diameterM, { airDensityKgM3: density, airTemperatureK: null, airPressurePa: null, supplyVoltageV: null }, {
      rpm: v1.points.map(point => point.rpm), thrustN: v1.points.map(point => point.thrustN), torqueNm: v1.points.map(point => point.torqueNm),
      voltageV: null, currentA: null,
    }, 'Bench CSV: ', index => `Bench CSV line ${index + 4}: `);
  }
  if (lines[0] !== 'mirage-bench-csv,2') throw new Error('Bench CSV must start with mirage-bench-csv,1 or mirage-bench-csv,2');
  const diameter = lines[1]?.split(',');
  if (!diameter || diameter.length !== 2 || diameter[0] !== 'diameterM') throw new Error('Bench CSV line 2 must be diameterM,<value>');
  const diameterM = parseNumber(diameter[1]!, 'diameterM', 2);
  const texts = new Map<string, { text: string; line: number }>();
  let index = 2;
  for (; index < lines.length && !lines[index]!.startsWith('rpm,'); index++) {
    const fields = lines[index]!.split(',');
    if (fields.length !== 2 || texts.has(fields[0]!)) throw new Error(`Bench CSV line ${index + 1}: expected one condition as name,value`);
    texts.set(fields[0]!, { text: fields[1]!, line: index + 1 });
  }
  const names = [...texts.keys()];
  const supply = names.at(-1) === 'supplyVoltageV';
  if (!CONDITION_SEQUENCES.includes((supply ? names.slice(0, -1) : names).join(','))) {
    throw new Error('Bench CSV v2 conditions must be airDensityKgM3, or airTemperatureK then airPressurePa, optionally followed by supplyVoltageV');
  }
  const values = new Map([...texts].map(([name, { text, line }]) => [name, parseNumber(text, name, line)]));
  const header = lines[index]?.split(',') ?? [];
  const optional = header.slice(2);
  const ordered = BENCH_OPTIONAL_QUANTITIES.filter(key => optional.includes(key));
  if (header[0] !== 'rpm' || header[1] !== 'thrustN' || optional.join(',') !== ordered.join(',')) {
    throw new Error(`Bench CSV line ${index + 1}: the column header must be rpm,thrustN followed by any of ${BENCH_OPTIONAL_QUANTITIES.join(', ')} in this order`);
  }
  const first = index + 2, rows = lines.slice(index + 1);
  if (rows.length < 1 || rows.length > MAX_BENCH_POINTS) throw new Error(`Bench CSV needs 1..${MAX_BENCH_POINTS} data rows`);
  const table = header.map((): number[] => []);
  rows.forEach((row, rowIndex) => {
    const fields = row.split(','), line = first + rowIndex;
    if (fields.length !== header.length) throw new Error(`Bench CSV line ${line}: expected ${header.length} fields`);
    fields.forEach((field, column) => table[column]!.push(parseNumber(field, header[column]!, line)));
  });
  const column = (key: string): number[] | null => {
    const position = header.indexOf(key);
    return position < 0 ? null : table[position]!;
  };
  return benchMeasurements(diameterM, {
    airDensityKgM3: values.get('airDensityKgM3') ?? null, airTemperatureK: values.get('airTemperatureK') ?? null,
    airPressurePa: values.get('airPressurePa') ?? null, supplyVoltageV: values.get('supplyVoltageV') ?? null,
  }, {
    rpm: table[0]!, thrustN: table[1]!, torqueNm: column('torqueNm'), voltageV: column('voltageV'), currentA: column('currentA'),
  }, 'Bench CSV: ', point => `Bench CSV line ${first + point}: `);
}

/** Canonical bench CSV v2 text for checked bench data; numbers use the shortest round-trip form. */
export function formatBenchCsv(diameterM: number, conditions: BenchConditions, columns: BenchColumns): string {
  benchMeasurements(diameterM, conditions, columns);
  const lines = ['mirage-bench-csv,2', `diameterM,${diameterM}`];
  if (conditions.airDensityKgM3 !== null) lines.push(`airDensityKgM3,${conditions.airDensityKgM3}`);
  else lines.push(`airTemperatureK,${conditions.airTemperatureK}`, `airPressurePa,${conditions.airPressurePa}`);
  if (conditions.supplyVoltageV !== null) lines.push(`supplyVoltageV,${conditions.supplyVoltageV}`);
  const present = BENCH_OPTIONAL_QUANTITIES.filter(key => columns[key] !== null);
  lines.push(['rpm', 'thrustN', ...present].join(','));
  columns.rpm.forEach((rpm, i) => {
    lines.push([rpm, columns.thrustN[i], ...present.map(key => columns[key]?.[i])].join(','));
  });
  return `${lines.join('\n')}\n`;
}
