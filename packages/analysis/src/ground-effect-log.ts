import type { DataFlashColumn, DataFlashGroup, DataFlashLog } from "@mirage/dataflash/reader";

// Logged ground effect (TASK-100; SPECS_SIMULATION_ENGINES "Logged ground effect"): thrust per squared rotor speed against the
// rotors' height in a real log with a downward rangefinder and every motor's speed. The rotors' specific force (the accelerometer)
// over the motors' mean squared speed needs neither the mass nor the battery. The method's constants were declared in the
// specification before the model's prediction was computed. Cold path.

export const GROUND_EFFECT_METHOD = Object.freeze({
  binS: 0.1,
  /** A bin counts with all four motors, this many ESC rows and this mean speed (airborne). */
  motors: 4,
  minEscRows: 8,
  minMeanRpm: 8000,
  /** Bins with a rangefinder reading at least this are the reference, m. */
  referenceMinM: 0.6,
  /** Reported bins of the rangefinder reading, m; below the first the ground's push enters the specific force. */
  binsM: Object.freeze([0.1, 0.15, 0.2, 0.3, 0.45, 0.6]),
});

export interface GroundEffectBin {
  readonly fromM: number;
  readonly toM: number;
  /** Mean thrust per squared speed over the reference's, and the standard error of that mean. */
  readonly ratio: number | null;
  readonly standardError: number | null;
  readonly samples: number;
  /** Mean rotor height, m: the tilted reading plus the offset. */
  readonly rotorHeightM: number | null;
}
export interface GroundEffectMeasurement {
  readonly offsetM: number;
  readonly referenceSamples: number;
  readonly bins: readonly GroundEffectBin[];
}
interface Bin { rpm2: number; rows: number; motors: Set<number>; acc: number; accRows: number; range: number; rangeRows: number; tilt: number; tiltRows: number }

const groupOf = (log: DataFlashLog, name: string): DataFlashGroup | null => log.groups.find(item => item.name === name && item.count > 0) ?? null;
const columnOf = (group: DataFlashGroup, name: string): DataFlashColumn | null => group.columns.find(item => item.name === name) ?? null;
const valueAt = (column: DataFlashColumn, row: number): number => Number(column.values[row]) * column.valueScale;
function need<T extends string>(group: DataFlashGroup | null, groupName: string, ...names: T[]): { group: DataFlashGroup; columns: Record<T, DataFlashColumn> } {
  if (!group) throw new Error(`The log has no ${groupName} messages`);
  const columns = {} as Record<T, DataFlashColumn>;
  for (const name of names) { const c = columnOf(group, name); if (!c) throw new Error(`The log has no ${groupName}.${name}`); columns[name] = c; }
  return { group, columns };
}

/** Each 0.1 s bin's thrust per squared speed and rangefinder height, over the bins that count. */
function binsOf(log: DataFlashLog): { k: number; readingM: number; cosTilt: number }[] {
  const m = GROUND_EFFECT_METHOD, bins = new Map<number, Bin>();
  const at = (timeUs: number): Bin => {
    const key = Math.floor(timeUs * 1e-6 / m.binS);
    let bin = bins.get(key);
    if (!bin) { bin = { rpm2: 0, rows: 0, motors: new Set(), acc: 0, accRows: 0, range: 0, rangeRows: 0, tilt: 0, tiltRows: 0 }; bins.set(key, bin); }
    return bin;
  };
  const esc = need(groupOf(log, "ESC"), "ESC", "TimeUS", "RPM"), instance = columnOf(esc.group, "Instance") ?? columnOf(esc.group, "I");
  if (!instance) throw new Error("The log has no ESC.Instance");
  for (let row = 0; row < esc.group.count; row++) {
    const bin = at(Number(esc.columns.TimeUS.values[row])), r = valueAt(esc.columns.RPM, row);
    bin.rpm2 += r * r; bin.rows++; bin.motors.add(valueAt(instance, row));
  }
  const imu = need(groupOf(log, "IMU"), "IMU", "TimeUS", "AccZ"), imuInstance = columnOf(imu.group, "I");
  for (let row = 0; row < imu.group.count; row++) {
    if (imuInstance && valueAt(imuInstance, row) !== 0) continue;
    const bin = at(Number(imu.columns.TimeUS.values[row])); bin.acc += valueAt(imu.columns.AccZ, row); bin.accRows++;
  }
  const rf = need(groupOf(log, "RFND"), "RFND", "TimeUS", "Dist", "Stat"), rfInstance = columnOf(rf.group, "Instance");
  for (let row = 0; row < rf.group.count; row++) {
    if ((rfInstance && valueAt(rfInstance, row) !== 0) || valueAt(rf.columns.Stat, row) !== 4) continue;
    const bin = at(Number(rf.columns.TimeUS.values[row])); bin.range += valueAt(rf.columns.Dist, row); bin.rangeRows++;
  }
  const att = need(groupOf(log, "ATT"), "ATT", "TimeUS", "Roll", "Pitch");
  for (let row = 0; row < att.group.count; row++) {
    const bin = at(Number(att.columns.TimeUS.values[row]));
    bin.tilt += Math.cos(valueAt(att.columns.Roll, row) * Math.PI / 180) * Math.cos(valueAt(att.columns.Pitch, row) * Math.PI / 180); bin.tiltRows++;
  }
  const out: { k: number; readingM: number; cosTilt: number }[] = [];
  for (const [, bin] of [...bins].sort((a, b) => a[0] - b[0])) {
    if (bin.motors.size < m.motors || bin.rows < m.minEscRows || bin.accRows === 0 || bin.rangeRows === 0 || bin.tiltRows === 0) continue;
    const rpm2 = bin.rpm2 / bin.rows;
    if (rpm2 < m.minMeanRpm ** 2) continue;
    out.push({ k: -(bin.acc / bin.accRows) / rpm2, readingM: bin.range / bin.rangeRows, cosTilt: bin.tilt / bin.tiltRows });
  }
  return out;
}

/** Thrust per squared rotor speed by rangefinder height, over its value at `referenceMinM` and above, for one rotor offset. */
export function measureGroundEffect(log: DataFlashLog, offsetM: number): GroundEffectMeasurement {
  if (!Number.isFinite(offsetM) || offsetM < 0) throw new Error("The rotors' offset above the rangefinder must be a finite non-negative length");
  const m = GROUND_EFFECT_METHOD, rows = binsOf(log);
  const reference = rows.filter(row => row.readingM >= m.referenceMinM);
  if (reference.length < 2) throw new Error(`The log has fewer than two bins at ${m.referenceMinM} m or higher`);
  const kRef = reference.reduce((sum, row) => sum + row.k, 0) / reference.length;
  const bins = m.binsM.slice(0, -1).map((fromM, i): GroundEffectBin => {
    const toM = m.binsM[i + 1]!, inside = rows.filter(row => row.readingM >= fromM && row.readingM < toM);
    if (inside.length === 0) return { fromM, toM, ratio: null, standardError: null, samples: 0, rotorHeightM: null };
    const ratios = inside.map(row => row.k / kRef), mean = ratios.reduce((a, x) => a + x, 0) / ratios.length;
    const sd = ratios.length > 1 ? Math.sqrt(ratios.reduce((a, x) => a + (x - mean) ** 2, 0) / (ratios.length - 1)) : null;
    const height = inside.reduce((a, row) => a + row.readingM * row.cosTilt, 0) / inside.length + offsetM;
    return { fromM, toM, ratio: mean, standardError: sd === null ? null : sd / Math.sqrt(ratios.length), samples: ratios.length, rotorHeightM: height };
  });
  return { offsetM, referenceSamples: reference.length, bins };
}

/** Whether a measured ratio is reproduced: within the model's range, widened by two standard errors and 2 percentage points. */
export function groundEffectReproduced(measured: number, standardError: number | null, modelLow: number, modelHigh: number): boolean {
  const widen = 2 * (standardError ?? 0) + 0.02;
  return measured >= Math.min(modelLow, modelHigh) - widen && measured <= Math.max(modelLow, modelHigh) + widen;
}
