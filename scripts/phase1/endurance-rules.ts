// TASK-189 (S19): what the 16-motor hour must show, apart from running it so that it is tested directly. The limits are the stakeholder's
// decisions in docs/decisions/phase1-acceptance.md: one continuous simulated hour with every signal at the default rate, wind and repeatable
// gusts on (A-07, A-09); at most 2 GB per simulated hour (A-08); the whole application under 8 GB of memory (A-12). The actual rate is
// reported and never judged (A-05: an automated lockstep run may run slower than real time). A failure is a FAIL, never hidden.

export const ENDURANCE_TASK = 'TASK-189';
export const ENDURANCE_RUN_SCHEMA = 'mirage-phase1-endurance-run/1';
export const ENDURANCE_CONFIGURATION = 'octo-paired-16', ENDURANCE_FIXTURE = 'octa-coaxial-16', ENDURANCE_WORKFLOW = 'one-hour-recording';
export const ENDURANCE_REPORT_DIRECTORY = 'test-results/validation/phase1-endurance';
export const ENDURANCE_CRITERIA = Object.freeze({
  /** S19: at least one continuous hour of simulated time. */
  simulatedS: 3600,
  /** A-04 as amended: a run with ArduPilot SITL steps at 800 Hz. */
  physicsHz: 800,
  /** The configuration's motors. */
  motors: 16,
  /** A-09: every signal at the default rate. */
  commonRateHz: 50,
  /** A signal may keep one row fewer than its rate over the duration, for where the run started and stopped in its period. */
  rowCountTolerance: 0.001,
  /** A-08. */
  bytesPerSimHour: 2e9,
  /** A-12. */
  memoryBytes: 8e9,
  /** The circuit's altitude, m, and how far a sample in flight may be from it: the aircraft flew the hour, it did not land early. */
  altitudeM: 20,
  altitudeToleranceM: 10,
  /** A flight this short after arming is still climbing, s: samples before it say nothing. */
  climbS: 120,
  /** The charge left at the end: the battery lasted the hour. */
  minimumStateOfCharge: 0.05,
});

export interface EnduranceRun {
  readonly schema: typeof ENDURANCE_RUN_SCHEMA;
  readonly configuration: typeof ENDURANCE_CONFIGURATION;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly chrome: string;
  readonly profileSha256: string;
  readonly experimentSha256: string;
  readonly physicsHz: number;
  readonly workload: {
    readonly routePoints: number; readonly sideM: number; readonly speedMps: number; readonly altitudeM: number;
    readonly batteryCapacityAh: number;
    readonly weather: readonly string[];
  };
  /** What the Run tab's meter and lockstep counters showed at the end. */
  readonly rate: {
    readonly mode: string; readonly averageRatio: number; readonly simElapsedS: number; readonly runningWallS: number; readonly executedHz: number;
    readonly droppedIntervals: number; readonly steps: number; readonly lost: number; readonly resent: number; readonly held: number;
  };
  /** The stage when the hour was over: `running` unless it ended early, with the failure it shows. */
  readonly stage: string;
  readonly failure: string | null;
  readonly pauses: number;
  readonly accidents: number;
  readonly recording: {
    readonly status: string; readonly bytes: number; readonly chunks: number; readonly droppedChunks: number; readonly droppedRows: number; readonly producerLost: number;
    readonly durationS: number; readonly rows: Readonly<Record<string, number>>; readonly rates: Readonly<Record<string, number>>;
  };
  readonly memory: { readonly samples: number; readonly peakBytes: number; readonly lastBytes: number };
  /** What the Run tab showed through the hour, sampled with the memory; `samples` counts those past the climb. */
  readonly flight: {
    readonly samples: number; readonly minimumAltitudeM: number; readonly maximumAltitudeM: number;
    readonly taskState: string; readonly armed: boolean; readonly stateOfCharge: number;
  };
}

export interface EnduranceJudgement { readonly verdict: 'PASS' | 'FAIL'; readonly reasons: readonly string[] }

/** Every limit, each failure named. */
export function judgeEndurance(run: EnduranceRun): EnduranceJudgement {
  const c = ENDURANCE_CRITERIA, reasons: string[] = [];
  if (run.failure !== null) reasons.push(`The run failed: ${run.failure}`);
  if (run.stage !== 'running') reasons.push(`The run was ${run.stage}, not running, when the hour was over`);
  if (run.pauses !== 0) reasons.push(`The run paused ${run.pauses} times, so its hour was not continuous`);
  if (run.accidents !== 0) reasons.push(`${run.accidents} accidents`);
  if (run.physicsHz !== c.physicsHz) reasons.push(`It stepped at ${run.physicsHz} Hz, not ${c.physicsHz} Hz`);
  if (!(run.rate.simElapsedS >= c.simulatedS)) reasons.push(`${run.rate.simElapsedS.toFixed(1)} s of simulated time, not ${c.simulatedS} s`);
  if (run.rate.lost !== 0) reasons.push(`${run.rate.lost} lockstep frames were lost`);
  if (run.workload.weather.length < 2) reasons.push(`The weather was ${run.workload.weather.join(', ') || 'none'}, not wind and repeatable gusts`);
  const r = run.recording;
  if (r.status !== 'closed') reasons.push(`The recording is ${r.status}, not closed`);
  if (r.droppedChunks !== 0 || r.droppedRows !== 0) reasons.push(`The recording dropped ${r.droppedChunks} chunks and ${r.droppedRows} rows`);
  if (r.producerLost !== 0) reasons.push(`The recording lost ${r.producerLost} rows at the producer`);
  if (!(r.durationS >= c.simulatedS)) reasons.push(`The recording holds ${r.durationS.toFixed(1)} s, not ${c.simulatedS} s`);
  // Every physics signal at the rate its plan gives, so that a gap in one shows even when the others run on.
  for (const [name, hz] of Object.entries(r.rates)) {
    if (hz > c.commonRateHz) reasons.push(`${name} is planned at ${hz} Hz, not the default ${c.commonRateHz} Hz`);
    const expected = hz * r.durationS, kept = r.rows[name] ?? 0;
    if (kept < expected * (1 - c.rowCountTolerance)) reasons.push(`${name} kept ${kept} rows of about ${Math.round(expected)}`);
  }
  for (const name of ['truth.position', 'motors.speed', 'battery', 'truth.contact']) if (!(name in r.rates)) reasons.push(`${name} is not in the recording's plan`);
  const perHour = r.bytes * 3600 / Math.max(r.durationS, 1);
  if (perHour > c.bytesPerSimHour) reasons.push(`The recording takes ${(perHour / 1e9).toFixed(2)} GB per simulated hour, over A-08's 2 GB`);
  const f = run.flight;
  if (f.samples === 0) reasons.push('The flight was not sampled');
  if (f.minimumAltitudeM < c.altitudeM - c.altitudeToleranceM || f.maximumAltitudeM > c.altitudeM + c.altitudeToleranceM) {
    reasons.push(`The altitude went from ${f.minimumAltitudeM.toFixed(1)} m to ${f.maximumAltitudeM.toFixed(1)} m, not the circuit's ${c.altitudeM} m within ${c.altitudeToleranceM} m`);
  }
  if (f.taskState !== 'running') reasons.push(`The flight task was ${f.taskState} when the hour was over, so the circuit did not last it`);
  if (!f.armed) reasons.push('The aircraft was disarmed when the hour was over');
  if (!(f.stateOfCharge >= c.minimumStateOfCharge)) reasons.push(`The battery was at ${(f.stateOfCharge * 100).toFixed(1)} % when the hour was over`);
  if (run.memory.samples === 0) reasons.push('The memory was not sampled');
  if (run.memory.peakBytes >= c.memoryBytes) reasons.push(`The application peaked at ${(run.memory.peakBytes / 1e9).toFixed(2)} GB, over A-12's 8 GB`);
  return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A run file from unknown: its schema and the fields the judgement reads, or an Error. */
export function parseEnduranceRun(value: unknown): EnduranceRun {
  if (!isRecord(value) || value.schema !== ENDURANCE_RUN_SCHEMA) throw new Error(`The run file is not ${ENDURANCE_RUN_SCHEMA}`);
  if (value.configuration !== ENDURANCE_CONFIGURATION) throw new Error(`The run file is of ${String(value.configuration)}`);
  for (const key of ['workload', 'rate', 'recording', 'memory', 'flight']) if (!isRecord(value[key])) throw new Error(`The run file has no ${key}`);
  for (const key of ['startedAt', 'finishedAt', 'chrome', 'profileSha256', 'experimentSha256', 'stage']) if (typeof value[key] !== 'string') throw new Error(`The run file has no ${key}`);
  for (const key of ['physicsHz', 'pauses', 'accidents']) if (typeof value[key] !== 'number') throw new Error(`The run file has no ${key}`);
  return value as unknown as EnduranceRun;
}

/** The matrix with the hour's verdict in its one cell, citing the report; every other cell and field is kept as it was. */
export function writeEnduranceCell(matrix: unknown, verdict: 'PASS' | 'FAIL', evidence: { readonly path: string; readonly sha256: string }): Record<string, unknown> {
  if (!isRecord(matrix) || matrix.schemaVersion !== 1 || !Array.isArray(matrix.cells)) throw new Error('The matrix is not schema version 1');
  if (!/^[0-9a-f]{64}$/.test(evidence.sha256)) throw new Error('The evidence has no SHA-256');
  const cells: readonly unknown[] = matrix.cells;
  const at = cells.flatMap((cell, i) => (isRecord(cell) && cell.configuration === ENDURANCE_CONFIGURATION && cell.workflow === ENDURANCE_WORKFLOW ? [i] : []));
  if (at.length !== 1) throw new Error(`The matrix has ${at.length} cells for ${ENDURANCE_CONFIGURATION} × ${ENDURANCE_WORKFLOW}`);
  return { ...matrix, cells: cells.map((cell, i) => (i === at[0] ? { configuration: ENDURANCE_CONFIGURATION, workflow: ENDURANCE_WORKFLOW, verdict, evidence } : cell)) };
}
