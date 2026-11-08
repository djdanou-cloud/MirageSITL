// Motor heat against wind-tunnel runs (TASK-105; SPECS_SIMULATION_ENGINES "Motor heat against wind-tunnel runs"): the
// Texas A&M thermal runs of Saemi, Whitson and Benedict (CC BY 4.0) read from their archive's text files, the loss law fitted to
// the measured power balance, the two-node network's five thermal values fitted to the fit runs' stator temperatures, and the
// held-out runs predicted. The network is never reimplemented here: the caller passes a factory of the repository's own heated
// motor (BetMotorV2 over bet_motor_thermal_step), which this module drives through its input and output arrays. The method's
// constants were declared in the specification before the first run. Cold path.

export const MOTOR_THERMAL_METHOD = Object.freeze({
  /** The network's step rate, Hz: one heated motor at the flight's lowest rate. */
  hz: 400,
  /** The record's own temperature laws (native/bet/src/motor.rs), used only by the loss law's fit and its oracle. */
  copperCoefficientPerK: 0.00393,
  magnetCoefficientPerK: -0.0012,
  /** k₂₀ is the median torque per rms current over the fit rows with at least this current, A. */
  torqueConstantMinCurrentA: 5,
  /** Nelder–Mead on the logarithms of (C_w J/K, C_h J/K, R_wh K/W, R_ha K/W, c s/m). */
  start: Object.freeze([30, 100, 0.5, 1, 0.1]),
  initialStepLn: Math.LN2,
  restartImprovement: 1e-9,
  maxRestarts: 20,
  maxEvaluations: 2000,
  gasConstantJPerKgK: 287.05,
  /** A held-out run is reproduced when its RMS and last-sample difference are within max(toleranceK, fraction·rise). */
  toleranceK: 2.5,
  toleranceFraction: 0.1,
  /** Motors with transients and a propeller in their names. */
  motors: Object.freeze(['M02', 'M03', 'M05']),
});

const RAW_COLUMNS = ['t [s]', 'N [rpm]', 'throttle [%]', 'Pdc [W]', 'Vdc [V]', 'Pac [W]', 'Vac [Vrms]', 'Iac [Irms]', 'Vfz [V]', 'Vmz [V]',
  'Tstat [degC]', 'Tesc [degC]', 'V_pitot [V]'] as const;
const SUMMARY_COLUMNS = ['# Index', 'RPM', 'Thrust [g]', 'Torque [mN.m]', 'Vac [Vrms]', 'Iac [Arms]', 'Pac [W]', 'Vdc [V]', 'Pdc [W]',
  'Tmot [degC]', 'Tamb [degC]', 'u [m/s]'] as const;

/** What a transient's file name states. */
export interface RunName {
  readonly motor: string;
  /** "u070 RPM4829": target tunnel speed in dm/s and target speed in rev/min, as the specification names runs. */
  readonly key: string;
  readonly targetTunnelMps: number;
  readonly targetRpm: number;
  readonly supplyV: number;
  readonly propellerDiameterM: number;
  readonly blades: number;
  readonly date: string;
  readonly ambientC: number;
  readonly pressurePa: number;
  readonly humidityPct: number;
}
const INCH_M = 0.0254;
const RAW_NAME = /^wtRaw_(M\d\d)_P\d+_u(\d{3})_RPM(\d+)_VDC(\d{3})_Pr(\d{3})x(\d)_Dt(\d{4}-\d\d-\d\d-\d\d-\d\d)_Ta(\d+)_Pa(\d{4})_Hmd(\d+)\.txt$/;

/** Reads a `wtRaw_` file name (README of the thermal archive); null when it does not follow the scheme. */
export function parseRunName(fileName: string): RunName | null {
  const m = RAW_NAME.exec(fileName);
  if (!m) return null;
  const [, motor = '', u = '', rpm = '', vdc = '', prop = '', blades = '', date = '', ta = '', pa = '', hmd = ''] = m;
  return {
    motor, key: `u${u} RPM${rpm}`, targetTunnelMps: Number(u) / 10, targetRpm: Number(rpm), supplyV: Number(vdc) / 10,
    propellerDiameterM: (Number(prop) / 10) * INCH_M, blades: Number(blades), date, ambientC: Number(ta), pressurePa: Number(pa) * 100,
    humidityPct: Number(hmd),
  };
}
/** The summary file of a transient: `wtSummary_M02_u070_RPM4683.txt`. */
export function summaryFileName(name: RunName): string {
  const [u = '', rpm = ''] = name.key.split(' ');
  return `wtSummary_${name.motor}_${u}_${rpm}.txt`;
}

function table(text: string, columns: readonly string[], fileName: string): number[][] {
  const lines = text.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim() !== '');
  const header = (lines[0] ?? '').split('\t').filter(cell => cell !== '');
  if (header.length !== columns.length || header.some((cell, i) => cell !== columns[i])) throw new Error(`Unexpected columns in ${fileName}`);
  return lines.slice(1).map((line, row) => {
    const cells = line.split('\t').filter(cell => cell !== '');
    const values = cells.map(Number);
    if (values.length !== columns.length || !values.every(Number.isFinite)) throw new Error(`Invalid row ${row + 1} in ${fileName}`);
    return values;
  });
}

/** A transient at 1 Hz: time s, speed rev/min, AC power W, rms current A and stator temperature °C. */
export interface RawRun {
  readonly timeS: Float64Array;
  readonly rpm: Float64Array;
  readonly acPowerW: Float64Array;
  readonly currentA: Float64Array;
  readonly statorC: Float64Array;
}
export function parseRawRun(text: string, fileName: string): RawRun {
  const rows = table(text, RAW_COLUMNS, fileName);
  if (rows.length < 2) throw new Error(`Too few rows in ${fileName}`);
  const column = (i: number) => Float64Array.from(rows, row => row[i]!);
  const run = { timeS: column(0), rpm: column(1), acPowerW: column(5), currentA: column(7), statorC: column(10) };
  for (let k = 1; k < run.timeS.length; k++) if (!(run.timeS[k]! > run.timeS[k - 1]!)) throw new Error(`Time does not increase in ${fileName}`);
  if (run.rpm.some(v => v < 0) || run.currentA.some(v => v < 0)) throw new Error(`Negative speed or current in ${fileName}`);
  return run;
}

/** One summary row: at spool-up (the first) or at thermal steady state (the second). */
export interface SummaryRow {
  /** The transient's 0-based row, or −1 for its last row. */
  readonly index: number;
  readonly rpm: number;
  readonly thrustN: number;
  readonly torqueNm: number;
  readonly currentA: number;
  readonly acPowerW: number;
  readonly motorC: number;
  readonly airC: number;
  readonly tunnelMps: number;
}
const STANDARD_GRAVITY = 9.80665;
export function parseSummary(text: string, fileName: string): readonly [SummaryRow, SummaryRow] {
  const rows = table(text, SUMMARY_COLUMNS, fileName);
  if (rows.length !== 2) throw new Error(`Expected two rows in ${fileName}`);
  const row = (v: readonly number[]): SummaryRow => ({
    index: v[0]!, rpm: v[1]!, thrustN: (v[2]! / 1000) * STANDARD_GRAVITY, torqueNm: v[3]! / 1000, currentA: v[5]!, acPowerW: v[6]!,
    motorC: v[9]!, airC: v[10]!, tunnelMps: v[11]!,
  });
  return [row(rows[0]!), row(rows[1]!)];
}

export interface ThermalRun {
  readonly name: RunName;
  readonly raw: RawRun;
  readonly summary: readonly [SummaryRow, SummaryRow];
}

/** The declared split: by the steady-state row's AC power, largest first; odd places fitted, even places held out. */
export function splitRuns<T extends ThermalRun>(runs: readonly T[]): { fit: T[]; holdOut: T[] } {
  const sorted = [...runs].sort((a, b) => b.summary[1].acPowerW - a.summary[1].acPowerW);
  return { fit: sorted.filter((_, i) => i % 2 === 0), holdOut: sorted.filter((_, i) => i % 2 === 1) };
}

const rpmToRadS = (rpm: number) => (rpm * 2 * Math.PI) / 60;
/** The measured motor loss of a summary row, W: AC input less shaft power. */
export const measuredLossW = (row: SummaryRow) => row.acPowerW - row.torqueNm * rpmToRadS(row.rpm);

export interface LossLaw {
  /** R₂₀ Ω such that R(T)·I_ac² is the copper loss; (k·I₀)₂₀ N·m. */
  readonly resistance20cOhm: number;
  readonly noLoadTorque20cNm: number;
  readonly torqueConstant20cNmPerA: number;
  readonly noLoadCurrentA: number;
}
/** The loss law at a row's motor temperature, W. */
export function lawLossW(law: LossLaw, row: SummaryRow): number {
  const d = row.motorC - 20, m = MOTOR_THERMAL_METHOD;
  return law.resistance20cOhm * (1 + m.copperCoefficientPerK * d) * row.currentA ** 2
    + law.noLoadTorque20cNm * (1 + m.magnetCoefficientPerK * d) * rpmToRadS(row.rpm);
}
/** Least squares without intercept of P_loss = R₂₀·(1 + α·ΔT)·I² + (k·I₀)₂₀·(1 + β·ΔT)·Ω over the rows; throws on a coefficient ≤ 0. */
export function fitLossLaw(rows: readonly SummaryRow[]): LossLaw {
  const m = MOTOR_THERMAL_METHOD;
  let s11 = 0, s12 = 0, s22 = 0, b1 = 0, b2 = 0;
  for (const row of rows) {
    const d = row.motorC - 20, x1 = (1 + m.copperCoefficientPerK * d) * row.currentA ** 2, x2 = (1 + m.magnetCoefficientPerK * d) * rpmToRadS(row.rpm);
    const y = measuredLossW(row);
    s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2; b1 += x1 * y; b2 += x2 * y;
  }
  const det = s11 * s22 - s12 * s12;
  const r20 = (b1 * s22 - b2 * s12) / det, kI0 = (s11 * b2 - s12 * b1) / det;
  if (!(r20 > 0) || !(kI0 > 0) || !Number.isFinite(r20) || !Number.isFinite(kI0)) throw new Error('The loss law has a coefficient that is not positive');
  const ratios = rows.filter(row => row.currentA >= m.torqueConstantMinCurrentA).map(row => row.torqueNm / row.currentA).sort((a, b) => a - b);
  if (ratios.length === 0) throw new Error('No fit row has the current for the torque constant');
  const mid = ratios.length >> 1, k20 = ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  return { resistance20cOhm: r20, noLoadTorque20cNm: kI0, torqueConstant20cNmPerA: k20, noLoadCurrentA: kI0 / k20 };
}

/** The five thermal values the fit varies, in the record's units. */
export interface ThermalValues {
  readonly windingHeatCapacityJPerK: number;
  readonly housingHeatCapacityJPerK: number;
  readonly windingToHousingKPerW: number;
  readonly housingToAirKPerW: number;
  readonly airflowCoolingPerMps: number;
}
/** The heated motor's values (BetMotorV2's `MotorHeat`). */
export interface HeatValues extends ThermalValues {
  readonly resistance20cOhm: number;
  readonly torqueConstant20cNmPerA: number;
  readonly noLoadCurrentA: number;
}
/** The surface of BetMotorV2 this module drives; the columns are its `ThermalInput` and `ThermalOutput`. */
export interface HeatedMotor {
  readonly thermalInput: Float64Array;
  readonly thermalOutput: Float64Array;
  readonly lastStatus: number;
  readonly dtS: number;
  heatFromInput(): boolean;
  reset(airC: number): void;
}
export type HeatedMotorFactory = (heat: HeatValues) => HeatedMotor;
const IN = { copper: 0, speed: 1, air: 2, airspeed: 3 } as const;
const OUT = { winding: 0, housing: 1, resistance: 2 } as const;

/** The inputs of a run the network is driven with, per sample. */
export interface RunDrive {
  readonly airC: number;
  readonly airspeedMps: Float64Array;
  readonly densityKgM3: number;
}
/** The flight path's airspeed past the motor: the tunnel speed plus the hover induced velocity of the thrust scaled by N². */
export function runDrive(run: ThermalRun): RunDrive {
  const [a, b] = run.summary, m = MOTOR_THERMAL_METHOD;
  const airC = (a.airC + b.airC) / 2, u = (a.tunnelMps + b.tunnelMps) / 2, thrust = (a.thrustN + b.thrustN) / 2, rpm = (a.rpm + b.rpm) / 2;
  const density = run.name.pressurePa / (m.gasConstantJPerKgK * (run.name.ambientC + 273.15));
  const radius = run.name.propellerDiameterM / 2, area = Math.PI * radius * radius;
  const airspeed = Float64Array.from(run.raw.rpm, n => u + Math.sqrt(Math.abs(thrust * (n / rpm) ** 2) / (2 * density * area)));
  return { airC, airspeedMps: airspeed, densityKgM3: density };
}

export interface RunSimulation {
  readonly housingC: Float64Array;
  readonly windingC: Float64Array;
}
/** Drives one heated motor through a run: both nodes start at the first stator temperature, sample k's inputs held to sample k+1. */
export function simulateRun(motor: HeatedMotor, run: ThermalRun, drive: RunDrive): RunSimulation {
  const { timeS, rpm, currentA, statorC } = run.raw, n = timeS.length, hz = Math.round(1 / motor.dtS);
  const housing = new Float64Array(n), winding = new Float64Array(n), input = motor.thermalInput, out = motor.thermalOutput;
  motor.reset(statorC[0]!);
  housing[0] = out[OUT.housing]!; winding[0] = out[OUT.winding]!;
  input[IN.air] = drive.airC;
  for (let k = 0; k + 1 < n; k++) {
    const steps = Math.round(hz * timeS[k + 1]!) - Math.round(hz * timeS[k]!), i2 = currentA[k]! ** 2;
    input[IN.speed] = rpmToRadS(rpm[k]!); input[IN.airspeed] = drive.airspeedMps[k]!;
    for (let s = 0; s < steps; s++) {
      input[IN.copper] = out[OUT.resistance]! * i2;
      if (!motor.heatFromInput()) throw new Error(`Motor thermal step failed (status ${motor.lastStatus}) in ${run.name.motor} ${run.name.key}`);
    }
    housing[k + 1] = out[OUT.housing]!; winding[k + 1] = out[OUT.winding]!;
  }
  return { housingC: housing, windingC: winding };
}

/** Mean squared difference between the housing node and the stator temperature over the samples after the first, K². */
export function meanSquareK2(simulation: RunSimulation, run: ThermalRun): number {
  let sum = 0;
  const n = run.raw.statorC.length;
  for (let k = 1; k < n; k++) sum += (simulation.housingC[k]! - run.raw.statorC[k]!) ** 2;
  return sum / (n - 1);
}

export const heatValues = (thermal: ThermalValues, law: LossLaw): HeatValues => ({
  ...thermal, resistance20cOhm: law.resistance20cOhm, torqueConstant20cNmPerA: law.torqueConstant20cNmPerA, noLoadCurrentA: law.noLoadCurrentA,
});
const fromLog = (x: readonly number[]): ThermalValues => ({
  windingHeatCapacityJPerK: Math.exp(x[0]!), housingHeatCapacityJPerK: Math.exp(x[1]!), windingToHousingKPerW: Math.exp(x[2]!),
  housingToAirKPerW: Math.exp(x[3]!), airflowCoolingPerMps: Math.exp(x[4]!),
});

/** Nelder–Mead (reflection 1, expansion 2, contraction 1/2, shrink 1/2) from `start` with equal initial steps. */
export function nelderMead(f: (x: readonly number[]) => number, start: readonly number[], step: number, maxEvaluations: number): { x: number[]; value: number; evaluations: number } {
  const dim = start.length;
  let evaluations = 0;
  const evaluate = (x: number[]) => { evaluations++; const v = f(x); return Number.isFinite(v) ? v : Infinity; };
  const points: { x: number[]; v: number }[] = [{ x: [...start], v: evaluate([...start]) }];
  for (let i = 0; i < dim; i++) { const x = [...start]; x[i]! += step; points.push({ x, v: evaluate(x) }); }
  const along = (centroid: number[], worst: number[], t: number) => centroid.map((c, i) => c + t * (worst[i]! - c));
  while (evaluations < maxEvaluations) {
    points.sort((a, b) => a.v - b.v);
    const best = points[0]!, worst = points[dim]!, second = points[dim - 1]!;
    if (Math.abs(worst.v - best.v) <= 1e-12 * Math.abs(best.v) + 1e-15) break;
    const centroid = new Array<number>(dim).fill(0);
    for (let p = 0; p < dim; p++) for (let i = 0; i < dim; i++) centroid[i]! += points[p]!.x[i]! / dim;
    const reflected = along(centroid, worst.x, -1), vr = evaluate(reflected);
    if (vr < best.v) {
      const expanded = along(centroid, worst.x, -2), ve = evaluate(expanded);
      points[dim] = ve < vr ? { x: expanded, v: ve } : { x: reflected, v: vr };
    } else if (vr < second.v) {
      points[dim] = { x: reflected, v: vr };
    } else {
      const outside = vr < worst.v, contracted = along(centroid, worst.x, outside ? -0.5 : 0.5), vc = evaluate(contracted);
      if (vc < (outside ? vr : worst.v)) points[dim] = { x: contracted, v: vc };
      else for (let p = 1; p <= dim; p++) { const x = points[p]!.x.map((xi, i) => best.x[i]! + 0.5 * (xi - best.x[i]!)); points[p] = { x, v: evaluate(x) }; }
    }
  }
  points.sort((a, b) => a.v - b.v);
  return { x: points[0]!.x, value: points[0]!.v, evaluations };
}

export interface ThermalFit {
  readonly values: ThermalValues;
  /** RMS over the fit runs: the square root of the objective, K. */
  readonly rmsK: number;
  readonly evaluations: number;
  readonly restarts: number;
}
/** The declared fit: Nelder–Mead on the logarithms, restarted from its best point until a restart improves by less than 1e-9 of it. */
export function fitThermal(factory: HeatedMotorFactory, runs: readonly ThermalRun[], law: LossLaw, start: readonly number[] = MOTOR_THERMAL_METHOD.start): ThermalFit {
  const m = MOTOR_THERMAL_METHOD, drives = runs.map(runDrive);
  const objective = (x: readonly number[]) => {
    let motor: HeatedMotor;
    try { motor = factory(heatValues(fromLog(x), law)); } catch { return Infinity; }
    let sum = 0;
    for (let r = 0; r < runs.length; r++) {
      try { sum += meanSquareK2(simulateRun(motor, runs[r]!, drives[r]!), runs[r]!); } catch { return Infinity; }
    }
    return sum / runs.length;
  };
  let best = nelderMead(objective, start.map(Math.log), m.initialStepLn, m.maxEvaluations), evaluations = best.evaluations, restarts = 0;
  while (restarts < m.maxRestarts) {
    const next = nelderMead(objective, best.x, m.initialStepLn, m.maxEvaluations);
    evaluations += next.evaluations; restarts++;
    const improvement = best.value - next.value;
    if (next.value < best.value) best = next;
    if (!(improvement >= m.restartImprovement * best.value)) break;
  }
  return { values: fromLog(best.x), rmsK: Math.sqrt(best.value), evaluations, restarts };
}

export interface RunComparison {
  readonly motor: string;
  readonly run: string;
  readonly role: 'fit' | 'holdOut';
  readonly file: string;
  readonly samples: number;
  readonly durationS: number;
  readonly airC: number;
  readonly meanAirspeedMps: number;
  readonly rmsK: number;
  readonly maxAbsK: number;
  readonly last: { readonly measuredC: number; readonly modelHousingC: number; readonly modelWindingC: number; readonly measuredRiseK: number; readonly modelRiseK: number; readonly differenceK: number };
  readonly toleranceK: number;
  /** For a held-out run: both the RMS and the last-sample difference within the tolerance; null for a fitted run. */
  readonly reproduced: boolean | null;
  /** Every tenth sample: time s, measured stator, model housing and model winding temperatures °C. */
  readonly series: readonly (readonly [number, number, number, number])[];
}
export function compareRun(motor: HeatedMotor, run: ThermalRun, role: 'fit' | 'holdOut', file: string): RunComparison {
  const drive = runDrive(run), simulation = simulateRun(motor, run, drive), { timeS, statorC } = run.raw, n = timeS.length;
  let maxAbs = 0;
  for (let k = 1; k < n; k++) maxAbs = Math.max(maxAbs, Math.abs(simulation.housingC[k]! - statorC[k]!));
  const measuredC = statorC[n - 1]!, modelHousingC = simulation.housingC[n - 1]!, rms = Math.sqrt(meanSquareK2(simulation, run));
  const measuredRise = measuredC - drive.airC, m = MOTOR_THERMAL_METHOD;
  const tolerance = Math.max(m.toleranceK, m.toleranceFraction * Math.abs(measuredRise)), difference = modelHousingC - measuredC;
  const series: [number, number, number, number][] = [];
  for (let k = 0; k < n; k += 10) series.push([timeS[k]!, statorC[k]!, simulation.housingC[k]!, simulation.windingC[k]!]);
  if ((n - 1) % 10 !== 0) series.push([timeS[n - 1]!, measuredC, modelHousingC, simulation.windingC[n - 1]!]);
  return {
    motor: run.name.motor, run: run.name.key, role, file, samples: n, durationS: timeS[n - 1]! - timeS[0]!, airC: drive.airC,
    meanAirspeedMps: drive.airspeedMps.reduce((s, v) => s + v, 0) / n, rmsK: rms, maxAbsK: maxAbs,
    last: { measuredC, modelHousingC, modelWindingC: simulation.windingC[n - 1]!, measuredRiseK: measuredRise, modelRiseK: modelHousingC - drive.airC, differenceK: difference },
    toleranceK: tolerance, reproduced: role === 'holdOut' ? rms <= tolerance && Math.abs(difference) <= tolerance : null, series,
  };
}
