/**
 * Open-circuit voltage curves of a battery card (TASK-104, SPECS_SIMULATION_ENGINES "Battery v2"): the 21-point
 * pack table at charges 0, 0.05, ..., 1 that the shared bus input v2 takes. Cold code.
 */

/** Curves a battery card may name. */
export const OPEN_CIRCUIT_CURVES = ['linear', 'chen-2006'] as const;
export type OpenCircuitCurve = (typeof OPEN_CIRCUIT_CURVES)[number];
export function isOpenCircuitCurve(value: unknown): value is OpenCircuitCurve {
  return typeof value === 'string' && (OPEN_CIRCUIT_CURVES as readonly string[]).includes(value);
}
/** Points of the table. */
export const TABLE_POINTS = 21;

/**
 * Chen and Rincón-Mora, IEEE Trans. Energy Conversion 21(2), 2006, eq. (2): the open-circuit voltage of their
 * 850 mAh TCL PL-383562 polymer Li-ion cell at room temperature, V, at charge z in [0, 1].
 */
export function chen2006CellV(z: number): number {
  return -1.031 * Math.exp(-35 * z) + 3.685 + 0.2156 * z - 0.1178 * z * z + 0.3201 * z * z * z;
}
/** The charge at which eq. (2) reaches 3.3 V, by bisection to the last bit (the curve rises on [0, 0.2]). */
function chenEmptyCharge(): number {
  let low = 0, high = 0.2;
  for (let i = 0; i < 200 && high - low > 0; i++) {
    const middle = 0.5 * (low + high);
    if (middle === low || middle === high) break;
    if (chen2006CellV(middle) < 3.3) low = middle; else high = middle;
  }
  return low;
}
/** z_e of the declaration: eq. (2) at 3.3 V. */
export const CHEN_2006_EMPTY_CHARGE = chenEmptyCharge();

/** Chen and Rincón-Mora 2006, eq. (3): the series resistance of their cell, ohm, at charge z in [0, 1]. */
export function chen2006SeriesOhm(z: number): number {
  return 0.1562 * Math.exp(-24.37 * z) + 0.07446;
}
/**
 * The series resistance's charge multiplier of a curve (TASK-104, second increment): for `chen-2006` eq. (3) under the curve's own
 * mapping z = z_e + (1 − z_e)·s, normalised to 1 at full charge; `linear` has none (null), a constant resistance.
 */
export function seriesResistanceTable(curve: OpenCircuitCurve): number[] | null {
  if (curve === 'linear') return null;
  const ze = CHEN_2006_EMPTY_CHARGE, full = chen2006SeriesOhm(1), table: number[] = [];
  for (let i = 0; i < TABLE_POINTS; i++) table.push(chen2006SeriesOhm(ze + (1 - ze) * (i / (TABLE_POINTS - 1))) / full);
  table[TABLE_POINTS - 1] = 1;
  return table;
}

/**
 * The pack table of a curve for `cells` in series between the card's empty and full cell voltages. Its ends are
 * exactly cells·empty and cells·full, the resolver's open-circuit voltages, so the manifest's check holds bit for bit.
 * `chen-2006` maps s to z = z_e + (1 − z_e)·s and scales eq. (2) between its values at z_e and 1 onto that window.
 */
export function openCircuitTableV(curve: OpenCircuitCurve, cells: number, cellEmptyV: number, cellFullV: number): number[] {
  if (!Number.isInteger(cells) || cells < 1 || !(cellEmptyV > 0) || !(cellFullV > cellEmptyV)) throw new Error('Invalid open-circuit window');
  const ze = CHEN_2006_EMPTY_CHARGE, low = chen2006CellV(ze), high = chen2006CellV(1);
  const table: number[] = [];
  for (let i = 0; i < TABLE_POINTS; i++) {
    const s = i / (TABLE_POINTS - 1);
    const shape = curve === 'linear' ? s : (chen2006CellV(ze + (1 - ze) * s) - low) / (high - low);
    table.push(cells * (cellEmptyV + (cellFullV - cellEmptyV) * shape));
  }
  table[0] = cells * cellEmptyV;
  table[TABLE_POINTS - 1] = cells * cellFullV;
  return table;
}
