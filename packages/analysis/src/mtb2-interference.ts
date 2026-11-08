// Measured rotor wakes (TASK-101; SPECS_SIMULATION_ENGINES "Measured rotor wakes: NASA MTB2"): the rear rotor of NASA's
// Multirotor Test Bed behind its front rotor in the 7- by 10-Foot Wind Tunnel against the same rotors alone. The tables give
// each rotor's thrust on its own load cell. Everything here was declared in the specification before the model's prediction
// was computed. Cold path; the workbooks are read by the caller and handed over as text rows.

export const MTB2_METHOD = Object.freeze({
  /** The downloaded files (NASA/TM-20250004795 and its tables), SHA-256 taken at download on 2026-11-08; NASA publishes none. */
  sources: Object.freeze([
    { file: 'MTB2_Data_Report_05222025.pdf', sha256: '8c034a713441dba7f45353d4ed7f5ecbc5bd421916a5f85d76ebec6fb652febf' },
    { file: 'mtbii_data_tables_v2.xlsx', sha256: 'ab82069b7d3e1131d67233a44928b51019530ab395612d21755d9ec39141749c' },
    { file: 'MTB2_Rotor_Positions_public_v1.xlsx', sha256: 'd811f54b69c37c2697bcc532b9a36343d011aa15517eca62be24359b181372bd' },
    { file: 'MTB2_Test_Matrix_Configuration.xlsx', sha256: '129dc2d22e4e19f339cfd6ae3612044d82a4e89d4fdde9357abb9d22ff2e98dc' },
    { file: 'MTB2_Test_Matrix_Chronological.xlsx', sha256: '9cecc71e96b524b12f995eae889dd9370e7555a37a35d04e9437eecb80d9eaa2' },
    { file: 'MTB2ReadMe.xlsx', sha256: 'a30a072af87d96bec8650a37a591e268985dc2de0cd30b2e88b4937db3ca3fca' },
  ]),
  /** Unit conversions: exact by definition, the slug from the pound-force and the foot. */
  newtonPerLb: 4.4482216152605, metrePerInch: 0.0254, metrePerFoot: 0.3048, kgM3PerSlugFt3: 515.378818393,
  /** q levels, psf: below the first a point is wind-off, below the second it is the 20 ft/s level, else 40 ft/s. */
  windOffBelowPsf: 0.1, lowBelowPsf: 1.0, qLevelsPsf: Object.freeze([0, 0.48, 1.9]),
  /** A point's speed is the largest of its four RPM columns rounded to this; below `minRpm` the rotors stand. */
  rpmStep: 500, minRpm: 1000,
  /** Wind-off points count only at the housekeeping condition. */
  housekeeping: Object.freeze({ pitchDeg: 0, tiltDeg: 0, rpm: 2000 }),
  /** Rotor 1 (front starboard) and rotor 3 (rear starboard), columns 1 and 3 of the tables. */
  frontRotor: 1, rearRotor: 3,
  /** Rotor 1 alone; its position is the same in all three configurations. */
  frontAloneRun: 102,
  configurations: Object.freeze([
    { id: 'concept', dzOverR: 0.33, positions: 'dz/R = 0.33', tandemRun: 113, phase90Run: 116, rearAloneRun: 103 },
    { id: 'equal-height', dzOverR: 0, positions: 'dz/R = 0', tandemRun: 143, phase90Run: 144, rearAloneRun: 141 },
    { id: 'tall', dzOverR: 0.57, positions: 'dz/R = 0.57', tandemRun: 151, phase90Run: 151, rearAloneRun: 147 },
  ] as const),
  /** The isolated rear-rotor runs whose spread is the data's own scatter s. */
  scatterRuns: Object.freeze([103, 141, 147]),
  /** The isolated runs the model's collective offset is fitted on: rotor 1 in 102 and rotor 3 in 103, forward flight only. */
  fitRuns: Object.freeze([{ run: 102, rotor: 1 }, { run: 103, rotor: 3 }]),
  /** The measured interval is widened by this many s. */
  bandScatters: 2,
  /**
   * The rotor radius of the thrust coefficient, in (NASA/TM-20250004795 table 7.2.2). Correction of 2026-11-08, after the first
   * comparison: the runs were made at densities from 0.00220 to 0.00244 slug/ft³, so a ratio of thrusts between two runs carries
   * their density ratio; the corrected basis is the report's own C_T = Fz/(rho A (Omega R)^2) (its table 5.2.2).
   */
  rotorRadiusIn: 12.245,
});
/** `thrust`: the ratios of thrusts first declared; `coefficient`: the ratios of thrust coefficients that correct them for density and speed. */
export type Mtb2Basis = 'thrust' | 'coefficient';
export type Mtb2ConfigurationId = typeof MTB2_METHOD.configurations[number]['id'];

/** One row of the MTB2 data tables, in the tables' units (lb, in-lb, ft/s, psf, slug/ft³, deg, °F). */
export interface Mtb2Point {
  readonly run: number; readonly point: number;
  /** Rotors 1..4 at indices 0..3. */
  readonly thrustLb: readonly number[]; readonly torqueInLb: readonly number[]; readonly rpm: readonly number[];
  /** null where the table has '-' (no phase control). */
  readonly phaseDeg: readonly (number | null)[];
  readonly speedFps: number; readonly qPsf: number; readonly densitySlugFt3: number;
  readonly pitchDeg: number; readonly tiltDeg: number; readonly totalTemperatureF: number;
}

function finite(text: string | undefined, what: string): number {
  const value = Number((text ?? '').trim());
  if ((text ?? '').trim() === '' || !Number.isFinite(value)) throw new Error(`MTB2 table: ${what} is not a number (${JSON.stringify(text)})`);
  return value;
}
/** The data table's rows from its header row on; any row with a run number must have every value the comparison reads. */
export function parseMtb2Table(rows: readonly (readonly string[])[]): Mtb2Point[] {
  const headerAt = rows.findIndex(row => row[0]?.trim() === 'Run');
  const header = rows[headerAt];
  if (!header) throw new Error('MTB2 table: no header row');
  const column = (name: string): number => {
    const index = header.findIndex(cell => cell.trim() === name);
    if (index < 0) throw new Error(`MTB2 table: no column ${name}`);
    return index;
  };
  const at = { Run: column('Run'), Point: column('Point'), VFPS: column('VFPS'), Q: column('Q'), RHO: column('RHO'), Pitch: column('Pitch'),
    Tilt: column('Tilt'), 'T. Temp': column('T. Temp') };
  const rotorColumns = [1, 2, 3, 4].map(n => ({ fz: column(`Fz${n}_H`), mz: column(`Mz${n}_H`), rpm: column(`RPM_${n}`), phase: column(`Phase_${n}`) }));
  const points: Mtb2Point[] = [];
  for (const row of rows.slice(headerAt + 1)) {
    if ((row[at.Run] ?? '').trim() === '') continue;
    const run = finite(row[at.Run], 'Run'), point = finite(row[at.Point], `run ${run} Point`), where = `run ${run} point ${point}`;
    points.push({
      run, point,
      thrustLb: rotorColumns.map((c, i) => finite(row[c.fz], `${where} Fz${i + 1}_H`)),
      torqueInLb: rotorColumns.map((c, i) => finite(row[c.mz], `${where} Mz${i + 1}_H`)),
      rpm: rotorColumns.map((c, i) => finite(row[c.rpm], `${where} RPM_${i + 1}`)),
      phaseDeg: rotorColumns.map((c, i) => ((row[c.phase] ?? '').trim() === '-' ? null : finite(row[c.phase], `${where} Phase_${i + 1}`))),
      speedFps: finite(row[at.VFPS], `${where} VFPS`), qPsf: finite(row[at.Q], `${where} Q`), densitySlugFt3: finite(row[at.RHO], `${where} RHO`),
      pitchDeg: finite(row[at.Pitch], `${where} Pitch`), tiltDeg: finite(row[at.Tilt], `${where} Tilt`),
      totalTemperatureF: finite(row[at['T. Temp']], `${where} T. Temp`),
    });
  }
  return points;
}

/** A test condition: q level (psf), pitch and tilt (deg), RPM and phase (deg, null without phase control). */
export interface Mtb2Condition {
  readonly qLevelPsf: number; readonly pitchDeg: number; readonly tiltDeg: number; readonly rpm: number; readonly phaseDeg: number | null;
}
export function conditionOf(point: Mtb2Point): Mtb2Condition | null {
  const m = MTB2_METHOD, rpm = Math.round(Math.max(...point.rpm) / m.rpmStep) * m.rpmStep;
  if (rpm < m.minRpm) return null;
  const qLevelPsf = point.qPsf < m.windOffBelowPsf ? 0 : point.qPsf < m.lowBelowPsf ? m.qLevelsPsf[1]! : m.qLevelsPsf[2]!;
  const pitchDeg = Math.round(point.pitchDeg) + 0, tiltDeg = Math.round(point.tiltDeg) + 0;
  if (qLevelPsf === 0 && (pitchDeg !== m.housekeeping.pitchDeg || tiltDeg !== m.housekeeping.tiltDeg || rpm !== m.housekeeping.rpm)) return null;
  const phases = point.phaseDeg.filter((value): value is number => value !== null);
  return { qLevelPsf, pitchDeg, tiltDeg, rpm, phaseDeg: phases.length ? Math.min(...phases) + 0 : null };
}
/** The key of a condition without its phase. */
export const conditionKey = (c: Omit<Mtb2Condition, 'phaseDeg'>): string => `${c.qLevelPsf}|${c.pitchDeg}|${c.tiltDeg}|${c.rpm}`;

/** A point's thrust coefficient per rotor, C_T = Fz/(rho pi R^2 (Omega R)^2), Omega from the largest RPM column. */
export function thrustCoefficients(point: Mtb2Point): number[] {
  const radiusFt = MTB2_METHOD.rotorRadiusIn / 12, omega = Math.max(...point.rpm) * Math.PI / 30;
  const scale = point.densitySlugFt3 * Math.PI * radiusFt * radiusFt * (omega * radiusFt) ** 2;
  return point.thrustLb.map(t => t / scale);
}
/** One run's points at one condition, averaged. */
export interface Mtb2Average {
  readonly condition: Mtb2Condition; readonly count: number;
  readonly thrustLb: readonly number[]; readonly thrustCoefficient: readonly number[]; readonly torqueInLb: readonly number[];
  readonly speedFps: number; readonly densitySlugFt3: number; readonly totalTemperatureF: number;
}
/** A run's points averaged per condition (phase included when `phaseDeg` is given: only points at that phase count). */
export function averagesOf(points: readonly Mtb2Point[], run: number, phaseDeg?: number | null): Map<string, Mtb2Average> {
  const groups = new Map<string, { condition: Mtb2Condition; points: Mtb2Point[] }>();
  for (const point of points) {
    if (point.run !== run) continue;
    const condition = conditionOf(point);
    if (!condition || (phaseDeg !== undefined && condition.phaseDeg !== phaseDeg)) continue;
    const key = conditionKey(condition), group = groups.get(key);
    if (group) group.points.push(point); else groups.set(key, { condition, points: [point] });
  }
  const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  return new Map([...groups].map(([key, { condition, points: group }]) => [key, {
    condition, count: group.length,
    thrustLb: [0, 1, 2, 3].map(i => mean(group.map(p => p.thrustLb[i]!))), thrustCoefficient: [0, 1, 2, 3].map(i => mean(group.map(p => thrustCoefficients(p)[i]!))),
    torqueInLb: [0, 1, 2, 3].map(i => mean(group.map(p => p.torqueInLb[i]!))),
    speedFps: mean(group.map(p => p.speedFps)), densitySlugFt3: mean(group.map(p => p.densitySlugFt3)), totalTemperatureF: mean(group.map(p => p.totalTemperatureF)),
  }]));
}

/** The measured side of one tandem condition (SPECS_SIMULATION_ENGINES "Measured rotor wakes: NASA MTB2"). */
export interface Mtb2Measured {
  readonly configuration: Mtb2ConfigurationId; readonly basis: Mtb2Basis; readonly key: string; readonly condition: Mtb2Condition;
  readonly tandem: Mtb2Average;
  /** In the basis's unit: thrust in lb, or the thrust coefficient. */
  readonly frontTandem: number; readonly rearTandem: number; readonly frontAlone: number; readonly rearAlone: number;
  readonly frontAloneCount: number; readonly rearAloneCount: number;
  /** r = T3_tandem / T3_alone; r_c with the front rotor's change as a common offset; r_front = T1_tandem / T1_alone. */
  readonly r: number; readonly rc: number; readonly rFront: number;
  /** The rear rotor's ratio at −90° phase, where the phase run has the condition; measured only. */
  readonly rPhase90: number | null;
}
const valuesOf = (a: Mtb2Average, basis: Mtb2Basis): readonly number[] => (basis === 'thrust' ? a.thrustLb : a.thrustCoefficient);
/** Every phase-0 tandem condition of a configuration that both isolated runs also hold. */
export function measureTandem(points: readonly Mtb2Point[], configurationId: Mtb2ConfigurationId, basis: Mtb2Basis): Mtb2Measured[] {
  const m = MTB2_METHOD, configuration = m.configurations.find(c => c.id === configurationId);
  if (!configuration) throw new Error(`Unknown MTB2 configuration ${configurationId}`);
  const front = m.frontRotor - 1, rear = m.rearRotor - 1;
  const tandem = averagesOf(points, configuration.tandemRun, 0), phase90 = averagesOf(points, configuration.phase90Run, -90);
  const rearAloneRun = averagesOf(points, configuration.rearAloneRun), frontAloneRun = averagesOf(points, m.frontAloneRun);
  const out: Mtb2Measured[] = [];
  for (const [key, t] of [...tandem].sort(([a], [b]) => a.localeCompare(b))) {
    const r3 = rearAloneRun.get(key), r1 = frontAloneRun.get(key);
    if (!r3 || !r1) continue;
    const frontTandem = valuesOf(t, basis)[front]!, rearTandem = valuesOf(t, basis)[rear]!, frontAlone = valuesOf(r1, basis)[front]!, rearAlone = valuesOf(r3, basis)[rear]!;
    const p90 = phase90.get(key);
    out.push({
      configuration: configurationId, basis, key, condition: t.condition, tandem: t,
      frontTandem, rearTandem, frontAlone, rearAlone, frontAloneCount: r1.count, rearAloneCount: r3.count,
      r: rearTandem / rearAlone, rc: (rearTandem - (frontTandem - frontAlone)) / rearAlone, rFront: frontTandem / frontAlone,
      rPhase90: p90 ? valuesOf(p90, basis)[rear]! / rearAlone : null,
    });
  }
  return out;
}

/** The data's own scatter s: the RMS of each isolated rear-rotor run over the mean of those runs, where two or more share a condition. */
export function isolatedScatter(points: readonly Mtb2Point[], basis: Mtb2Basis): { readonly rms: number; readonly max: number; readonly deviations: number; readonly conditions: number } {
  const rear = MTB2_METHOD.rearRotor - 1, runs = MTB2_METHOD.scatterRuns.map(run => averagesOf(points, run));
  const keys = new Set(runs.flatMap(run => [...run.keys()]));
  let sum = 0, max = 0, deviations = 0, conditions = 0;
  for (const key of keys) {
    const values = runs.flatMap(run => { const a = run.get(key); return a ? [valuesOf(a, basis)[rear]!] : []; });
    if (values.length < 2) continue;
    conditions++;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    for (const value of values) { const d = value / mean - 1; sum += d * d; max = Math.max(max, Math.abs(d)); deviations++; }
  }
  if (deviations === 0) throw new Error('MTB2: the isolated rear-rotor runs share no condition');
  return { rms: Math.sqrt(sum / deviations), max, deviations, conditions };
}

/** Where the model's ratio falls against the measured interval [min(r, r_c), max(r, r_c)] widened by `bandScatters` s. */
export function withinMeasured(modelRatio: number, r: number, rc: number, scatter: number): boolean {
  const widen = MTB2_METHOD.bandScatters * scatter;
  return modelRatio >= Math.min(r, rc) - widen && modelRatio <= Math.max(r, rc) + widen;
}

/** A rotor's hub in the tunnel's coordinate system (inches; x downstream, y starboard, z up), from the rotor-positions workbook. */
export interface Mtb2RotorPosition { readonly configuration: string; readonly pitchDeg: number; readonly tiltDeg: number; readonly rotor: number; readonly xyzIn: readonly number[] }
export function parseMtb2Positions(rows: readonly (readonly string[])[]): Mtb2RotorPosition[] {
  const headerAt = rows.findIndex(row => row[0]?.trim() === 'Config');
  if (headerAt < 0) throw new Error('MTB2 positions: no header row');
  const out: Mtb2RotorPosition[] = [];
  for (const row of rows.slice(headerAt + 1)) {
    const configuration = (row[0] ?? '').trim();
    if (!configuration.startsWith('dz/R')) continue;
    const where = `positions ${configuration}`;
    out.push({ configuration, pitchDeg: finite(row[1], `${where} Alpha`), tiltDeg: finite(row[2], `${where} Tilt`), rotor: finite(row[3], `${where} Rotor`),
      xyzIn: [finite(row[4], `${where} x`), finite(row[5], `${where} y`), finite(row[6], `${where} z`)] });
  }
  return out;
}
