import type { DataFlashColumn, DataFlashGroup, DataFlashLog } from "@mirage/dataflash/reader";

// Logged descent (TASK-099; SPECS_SIMULATION_ENGINES "Logged descent"): thrust per squared rotor speed against the climb rate
// scaled with the hover inflow, in a real log with every motor's speed and no rangefinder or GNSS. The rotors' specific force (the
// accelerometer) over the motors' mean squared speed needs neither the battery nor the thrust coefficient; the mass enters only
// the hover inflow that scales the climb rate. Each flight is normalized by its own bins near hover. The method's constants
// were declared in the specification before the model's prediction was computed. Cold path.

export const DESCENT_METHOD = Object.freeze({
  binS: 0.1,
  motors: 4,
  /** Accepted ESC rows each motor needs in a bin. */
  minEscRowsPerMotor: 5,
  /** Airborne: every CTUN row's ThO above this (MOT_SPIN_ARM) and Alt at least this, m. */
  minThrottle: 0.05,
  minAltitudeM: 0.5,
  minMeanRpm: 8000,
  /** Specific force along the rotors' axis, m/s². */
  minSpecificForceMps2: 4.9,
  /** Tilt from level of every ATT row (ANGLE_MAX), degrees. */
  maxTiltDeg: 30,
  /** A bin counts when every bin with CTUN rows this close is airborne, s. */
  airborneWindowS: 1,
  /** Reference bins: |V_z / v_h| at most this; a flight needs this many. */
  referenceMaxScaledClimb: 0.03,
  minReferenceBins: 20,
  /** Air: the barometer's pressure at this temperature, K, and this gas constant, J/(kg K). */
  airTemperatureK: 288.15,
  gasConstant: 287.053,
  /** Reported classes of V_z / v_h, [from, to) when descending and (from, to] when climbing. */
  descentClasses: Object.freeze([[-0.7, -0.45], [-0.45, -0.3], [-0.3, -0.2], [-0.2, -0.1], [-0.1, -0.03]] as const),
  climbClasses: Object.freeze([[0.03, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.7]] as const),
  /** The bins with at most this tilt are reported again, degrees. */
  levelTiltDeg: 5,
});

export interface DescentAircraft {
  readonly massKg: number;
  readonly rotorRadiusM: number;
  /** ESC.RPM rows above this are rejected: KV times the autopilot's highest battery voltage. */
  readonly maxRpm: number;
  /**
   * Factor from the stored CTUN.CRt to m/s when the log has no FMTU unit for it; a log whose FMTU gives the unit m/s is
   * scaled by it, and any other unit is refused.
   */
  readonly unscaledClimbRateToMps?: number;
}

export interface DescentBin {
  readonly timeS: number;
  readonly climbMps: number;
  readonly hoverInflowMps: number;
  /** V_z / v_h. */
  readonly scaledClimb: number;
  /** Thrust per squared speed over the flight's reference. */
  readonly ratio: number;
  readonly tiltDeg: number;
  readonly specificForceMps2: number;
  readonly meanRpm: number;
}
export interface DescentFlight {
  readonly densityKgM3: number;
  readonly referenceBins: number;
  /** Mean k of the reference bins, (m/s²)/rpm². */
  readonly referenceK: number;
  readonly bins: readonly DescentBin[];
  /** Bins that had four motors' speeds but did not count, by the first rule they failed. */
  readonly rejected: Readonly<Record<"not-airborne" | "airborne-window" | "no-climb-rate", number>>;
  readonly rejectedEscRows: number;
}
export interface DescentClass {
  readonly fromScaledClimb: number;
  readonly toScaledClimb: number;
  readonly samples: number;
  readonly ratio: number | null;
  readonly standardError: number | null;
  readonly meanScaledClimb: number | null;
  readonly meanClimbMps: number | null;
  readonly meanTiltDeg: number | null;
  readonly flights: readonly string[];
}

interface Bin {
  rpm2: number[]; rows: number[]; acc: number; accRows: number; ctunRows: number; lowThrottle: boolean; lowAltitude: boolean; climb: number;
  tiltRows: number; tiltSum: number; steep: boolean; pressure: number; pressureRows: number;
}

const groupOf = (log: DataFlashLog, name: string): DataFlashGroup | null => log.groups.find(item => item.name === name && item.count > 0) ?? null;
const columnOf = (group: DataFlashGroup, name: string): DataFlashColumn | null => group.columns.find(item => item.name === name) ?? null;
const valueAt = (column: DataFlashColumn, row: number): number => Number(column.values[row]) * column.valueScale;
function need<T extends string>(group: DataFlashGroup | null, groupName: string, ...names: T[]): { group: DataFlashGroup; columns: Record<T, DataFlashColumn> } {
  if (!group) throw new Error(`The log has no ${groupName} messages`);
  const columns = {} as Record<T, DataFlashColumn>;
  for (const name of names) { const c = columnOf(group, name); if (!c) throw new Error(`The log has no ${groupName}.${name}`); columns[name] = c; }
  return { group, columns };
}

/** The counted bins of one flight, normalized by its own reference. */
export function measureDescent(log: DataFlashLog, aircraft: DescentAircraft): DescentFlight {
  const m = DESCENT_METHOD;
  for (const [name, value] of [["massKg", aircraft.massKg], ["rotorRadiusM", aircraft.rotorRadiusM], ["maxRpm", aircraft.maxRpm]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
  }
  const bins = new Map<number, Bin>();
  const keyOf = (timeUs: number) => Math.floor(timeUs * 1e-6 / m.binS);
  const at = (timeUs: number): Bin => {
    const key = keyOf(timeUs);
    let bin = bins.get(key);
    if (!bin) {
      bin = { rpm2: new Array<number>(m.motors).fill(0), rows: new Array<number>(m.motors).fill(0), acc: 0, accRows: 0, ctunRows: 0, lowThrottle: false,
        lowAltitude: false, climb: 0, tiltRows: 0, tiltSum: 0, steep: false, pressure: 0, pressureRows: 0 };
      bins.set(key, bin);
    }
    return bin;
  };
  const esc = need(groupOf(log, "ESC"), "ESC", "TimeUS", "RPM"), instance = columnOf(esc.group, "Instance") ?? columnOf(esc.group, "I");
  if (!instance) throw new Error("The log has no ESC.Instance");
  let rejectedEscRows = 0;
  for (let row = 0; row < esc.group.count; row++) {
    const motor = valueAt(instance, row), rpm = valueAt(esc.columns.RPM, row);
    if (!Number.isInteger(motor) || motor < 0 || motor >= m.motors) continue;
    if (!Number.isFinite(rpm) || rpm < 0 || rpm > aircraft.maxRpm) { rejectedEscRows++; continue; }
    const bin = at(Number(esc.columns.TimeUS.values[row]));
    bin.rpm2[motor]! += rpm * rpm; bin.rows[motor]!++;
  }
  const imu = need(groupOf(log, "IMU"), "IMU", "TimeUS", "AccZ"), imuInstance = columnOf(imu.group, "I");
  for (let row = 0; row < imu.group.count; row++) {
    if (imuInstance && valueAt(imuInstance, row) !== 0) continue;
    const bin = at(Number(imu.columns.TimeUS.values[row])); bin.acc += valueAt(imu.columns.AccZ, row); bin.accRows++;
  }
  const ctun = need(groupOf(log, "CTUN"), "CTUN", "TimeUS", "ThO", "Alt", "CRt"), crt = ctun.columns.CRt;
  let climbScale: number;
  if (crt.unit === "m/s") climbScale = crt.valueScale;
  else if (crt.unit === "" && aircraft.unscaledClimbRateToMps !== undefined) climbScale = aircraft.unscaledClimbRateToMps;
  else throw new Error(`CTUN.CRt has the unit "${crt.unit}"; m/s by its FMTU, or a stated factor without FMTU, is required`);
  for (let row = 0; row < ctun.group.count; row++) {
    const bin = at(Number(ctun.columns.TimeUS.values[row]));
    bin.ctunRows++; bin.climb += Number(crt.values[row]) * climbScale;
    if (!(valueAt(ctun.columns.ThO, row) > m.minThrottle)) bin.lowThrottle = true;
    if (!(valueAt(ctun.columns.Alt, row) >= m.minAltitudeM)) bin.lowAltitude = true;
  }
  const att = need(groupOf(log, "ATT"), "ATT", "TimeUS", "Roll", "Pitch");
  for (let row = 0; row < att.group.count; row++) {
    const bin = at(Number(att.columns.TimeUS.values[row]));
    const c = Math.cos(valueAt(att.columns.Roll, row) * Math.PI / 180) * Math.cos(valueAt(att.columns.Pitch, row) * Math.PI / 180);
    const tilt = Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI;
    bin.tiltSum += tilt; bin.tiltRows++;
    if (!(tilt <= m.maxTiltDeg)) bin.steep = true;
  }
  const baro = need(groupOf(log, "BARO"), "BARO", "TimeUS", "Press"), baroInstance = columnOf(baro.group, "I");
  for (let row = 0; row < baro.group.count; row++) {
    if (baroInstance && valueAt(baroInstance, row) !== 0) continue;
    const bin = at(Number(baro.columns.TimeUS.values[row])); bin.pressure += valueAt(baro.columns.Press, row); bin.pressureRows++;
  }

  const keys = [...bins.keys()].sort((a, b) => a - b);
  const meanRpm2 = (bin: Bin): number | null => {
    let sum = 0;
    for (let i = 0; i < m.motors; i++) { if (bin.rows[i]! < m.minEscRowsPerMotor) return null; sum += bin.rpm2[i]! / bin.rows[i]!; }
    return sum / m.motors;
  };
  const airborne = new Map<number, boolean>();
  for (const key of keys) {
    const bin = bins.get(key)!, rpm2 = meanRpm2(bin);
    if (bin.ctunRows === 0) continue;
    const force = bin.accRows > 0 ? -bin.acc / bin.accRows : NaN;
    airborne.set(key, !bin.lowThrottle && !bin.lowAltitude && !bin.steep && bin.tiltRows > 0 && rpm2 !== null && rpm2 >= m.minMeanRpm ** 2 && force >= m.minSpecificForceMps2);
  }
  const window = Math.round(m.airborneWindowS / m.binS);
  const candidates: { key: number; bin: Bin; rpm2: number; force: number }[] = [];
  const rejected = { "not-airborne": 0, "airborne-window": 0, "no-climb-rate": 0 };
  for (const key of keys) {
    const bin = bins.get(key)!, rpm2 = meanRpm2(bin);
    if (rpm2 === null || bin.accRows === 0) continue;
    const state = airborne.get(key);
    if (state === undefined) { rejected["no-climb-rate"]++; continue; }
    if (!state) { rejected["not-airborne"]++; continue; }
    let around = true;
    for (let k = key - window; k <= key + window && around; k++) if (airborne.get(k) === false) around = false;
    if (!around) { rejected["airborne-window"]++; continue; }
    candidates.push({ key, bin, rpm2, force: -bin.acc / bin.accRows });
  }
  let pressure = 0, pressureRows = 0;
  for (const c of candidates) if (c.bin.pressureRows > 0) { pressure += c.bin.pressure / c.bin.pressureRows; pressureRows++; }
  if (pressureRows === 0) throw new Error("The log has no counted bin with a barometer reading");
  const density = pressure / pressureRows / (m.gasConstant * m.airTemperatureK), area = Math.PI * aircraft.rotorRadiusM ** 2;
  const raw = candidates.map(c => {
    const hover = Math.sqrt(aircraft.massKg * c.force / (8 * density * area)), climb = c.bin.climb / c.bin.ctunRows;
    return { timeS: c.key * m.binS, climbMps: climb, hoverInflowMps: hover, scaledClimb: climb / hover, k: c.force / c.rpm2,
      tiltDeg: c.bin.tiltSum / c.bin.tiltRows, specificForceMps2: c.force, meanRpm: Math.sqrt(c.rpm2) };
  });
  const reference = raw.filter(b => Math.abs(b.scaledClimb) <= m.referenceMaxScaledClimb);
  const referenceK = reference.length > 0 ? reference.reduce((s, b) => s + b.k, 0) / reference.length : NaN;
  const out = reference.length >= m.minReferenceBins
    ? raw.map(({ k, ...rest }): DescentBin => ({ ...rest, ratio: k / referenceK }))
    : [];
  return { densityKgM3: density, referenceBins: reference.length, referenceK, bins: out, rejected, rejectedEscRows };
}

/** The declared classes over the counted bins of several flights, optionally only those at most `maxTiltDeg` from level. */
export function descentClasses(flights: readonly { readonly name: string; readonly flight: DescentFlight }[], maxTiltDeg = Infinity): DescentClass[] {
  const m = DESCENT_METHOD, all = flights.flatMap(f => f.flight.bins.filter(b => b.tiltDeg <= maxTiltDeg).map(b => ({ name: f.name, b })));
  const classOf = (from: number, to: number, inside: (x: number) => boolean): DescentClass => {
    const s = all.filter(item => inside(item.b.scaledClimb)), n = s.length;
    if (n === 0) return { fromScaledClimb: from, toScaledClimb: to, samples: 0, ratio: null, standardError: null, meanScaledClimb: null, meanClimbMps: null, meanTiltDeg: null, flights: [] };
    const mean = (f: (b: DescentBin) => number) => s.reduce((a, item) => a + f(item.b), 0) / n;
    const ratio = mean(b => b.ratio);
    const sd = n > 1 ? Math.sqrt(s.reduce((a, item) => a + (item.b.ratio - ratio) ** 2, 0) / (n - 1)) : null;
    return { fromScaledClimb: from, toScaledClimb: to, samples: n, ratio, standardError: sd === null ? null : sd / Math.sqrt(n),
      meanScaledClimb: mean(b => b.scaledClimb), meanClimbMps: mean(b => b.climbMps), meanTiltDeg: mean(b => b.tiltDeg), flights: [...new Set(s.map(item => item.name))].sort() };
  };
  return [
    ...m.descentClasses.map(([from, to]) => classOf(from, to, x => x >= from && x < to)),
    ...m.climbClasses.map(([from, to]) => classOf(from, to, x => x > from && x <= to)),
  ];
}

/** Whether a measured class is reproduced: within the model's range, widened by two standard errors and 2 percentage points. */
export function descentReproduced(measured: number, standardError: number | null, modelLow: number, modelHigh: number): boolean {
  const widen = 2 * (standardError ?? 0) + 0.02;
  return measured >= Math.min(modelLow, modelHigh) - widen && measured <= Math.max(modelLow, modelHigh) + widen;
}
