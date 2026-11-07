// Rules of the Phase 1 nominal flight acceptance (TASK-158, extended by TASK-188 with the parameter, recording, reopening and
// refusal workflows of each configuration), apart from its
// side effects so that they are tested directly: the five S19 configurations
// of the TASK-132 matrix, the criteria declared before the first run, the
// verdict of each workflow from a run's own facts, the host that may write
// verdicts (A-01), and the matrix cells the verdicts go into.
// tests/browser/phase1-nominal.spec.ts records the facts through the UI;
// scripts/phase1/nominal-flight.mjs runs it and writes the evidence.

export const NOMINAL_TASK = 'TASK-158';
export const RUN_SCHEMA = 'mirage-phase1-nominal-run/2';
export const REPORT_SCHEMA_VERSION = 1;
export const MATRIX_PATH = 'docs/validation/phase1-matrix.json';
export const REPORT_DIRECTORY = 'test-results/validation/phase1-nominal';

/** Declared before the first acceptance run (TASK-158 status, 2026-11-03). */
export const CRITERIA = {
  /** Decision A-04 as amended on 2026-11-03: runs with ArduPilot SITL use 800 Hz. */
  physicsHz: 800,
  /** The Run tab's Speed: real time. */
  speedup: 1,
  takeoffAltitudeM: 5,
  /** Every reading of a hold within this of the take-off altitude, as TASK-153 and TASK-156. */
  hoverBandM: 0.5,
  holdSimS: 10,
  minimumReadings: 4,
  pauseWallS: 30,
  /** Simulated time between Pause and Resume stays below this. */
  pauseSimS: 1,
  /** The landed CG's distance from the standard gear's rest height. */
  restToleranceM: 0.006,
  /**
   * Servo frames SITL may resend per pause: while paused it resends the frame it waits on every second (decision D-03), and
   * one resend still on its way when Resume answers the frame is answered again from the stored reply. None may be lost.
   */
  resentPerPause: 1,
  polar: 'naca6409-neuralfoil-v1',
  /** The flight's DataFlash file: Stop ends SITL while it writes, so its last record may be cut short; nothing inside it may be damaged. */
  dataflashStatuses: ['complete', 'truncated'],
  /** Decision A-13 (2026-11-04): each hold's body-rate standard deviation on each axis, in the flight's own log, at most this, deg/s. */
  steadinessSdDegS: 1,
} as const;

/** The write every run makes through the Parameters tab: what a flight in GUIDED that lands in LAND does not read (TASK-188). */
export const PARAMETER_CHANGE = { name: 'RTL_ALT_FINAL_M', value: 1 } as const;

/** ArduCopter V4.7.2's stock values of the settings each report names, as its logs hold them. Tolerance: float32 rounding. */
export const STOCK_SETTINGS = {
  INS_GYRO_FILTER: 20, ATC_RAT_RLL_P: 0.135, ATC_RAT_RLL_I: 0.135, ATC_RAT_RLL_D: 0.0036, ATC_RAT_PIT_P: 0.135, ATC_RAT_PIT_I: 0.135, ATC_RAT_PIT_D: 0.0036,
} as const;
const FLOAT32_TOLERANCE = 1e-6;

/**
 * `tuning` lists the settings typed into the Parameters tab after READY. Decision A-13 of 2026-11-04 gave the quad X a 40 Hz gyro
 * filter against a 10 Hz attitude oscillation; TASK-098's inflow removed that oscillation, and on 2026-11-07 the stakeholder
 * dropped the filter, so every configuration flies stock (docs/SPECS_SIMULATION_ENGINES.md).
 */
export const NOMINAL_CONFIGURATIONS = [
  { id: 'quad', fixture: 'quad-x', recipe: 'Quad X', motors: 4, tuning: [] },
  { id: 'hexa', fixture: 'hexa-x', recipe: 'Hexa X', motors: 6, tuning: [] },
  { id: 'octo', fixture: 'octa-x', recipe: 'Octa X', motors: 8, tuning: [] },
  { id: 'x8', fixture: 'coaxial-x8', recipe: 'Coaxial X8', motors: 8, tuning: [] },
  { id: 'octo-paired-16', fixture: 'octa-coaxial-16', recipe: 'Octa coaxial 16', motors: 16, tuning: [] },
] as const;
/** `acceptance` flies each configuration with its tuning; `stock` is the negative control, which never reaches the matrix. */
export const RUN_SETTINGS = ['acceptance', 'stock'] as const;
export type RunSettings = (typeof RUN_SETTINGS)[number];
export type NominalConfiguration = (typeof NOMINAL_CONFIGURATIONS)[number];
export type ConfigurationId = NominalConfiguration['id'];

/** The matrix workflows this task writes; the other per-configuration workflows belong to other tasks. */
export const NOMINAL_WORKFLOWS = ['profile-creation', 'output-mapping', 'start', 'flight-task', 'pause-resume', 'parameter-changes', 'recording', 'reopen-results', 'unsupported-refusal'] as const;
export type NominalWorkflow = (typeof NOMINAL_WORKFLOWS)[number];
/** The steps of one run, in the order the spec takes them. */
export const STEPS = ['profile', 'mapping', 'refusal', 'start', 'tuning', 'parameters', 'motorCheck', 'hold', 'pause', 'landing', 'stop', 'reopen'] as const;
export type StepId = (typeof STEPS)[number];
export const WORKFLOW_STEPS: { readonly [W in NominalWorkflow]: readonly StepId[] } = {
  'profile-creation': ['profile'],
  'output-mapping': ['mapping', 'motorCheck'],
  start: ['start', 'stop'],
  'flight-task': ['tuning', 'hold', 'landing'],
  'pause-resume': ['pause'],
  'parameter-changes': ['parameters'],
  recording: ['stop'],
  'reopen-results': ['reopen'],
  'unsupported-refusal': ['refusal'],
};
export const CARD_TYPES = ['motor', 'propeller', 'esc', 'battery'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export interface CardFacts {
  readonly type: CardType;
  readonly sha256: string;
  readonly sourceKind: string;
  /** Values that differ from the example card's. */
  readonly differences: readonly string[];
}
export interface ProfileFacts {
  readonly cards: readonly CardFacts[];
  readonly sha256: string;
  readonly version: number;
  readonly motors: number;
  /** Where the stored profile differs from the S19 fixture on these cards and the polar. */
  readonly differences: readonly string[];
}
export interface OutputPair { readonly motor: number; readonly output: number }
export interface MappingFacts {
  /** The Aircraft tab's frame line, e.g. "Stock frame: FRAME_CLASS 1, FRAME_TYPE 1, 4-channel servo packets." */
  readonly frame: string;
  readonly outputs: readonly OutputPair[];
}
/** What the Aircraft tab refused of this aircraft, and that nothing was stored for it. */
export interface RefusalFacts {
  /** Its reasons for a repeated output. */
  readonly problems: readonly string[];
  readonly saveDisabled: boolean;
  /** Its reasons for a ninth arm. */
  readonly layoutErrors: readonly string[];
  /** Versions of this profile stored afterwards. */
  readonly versions: number;
}
/** The stopped run as the Experiments tab reopens it. */
export interface ReopenFacts {
  readonly listed: number;
  readonly recordId: string;
  /** The detail's Recording line. */
  readonly recordingText: string;
  readonly profileText: string;
  /** Rows read back from the stored recording. */
  readonly truthRows: number;
  readonly missingChunks: number;
  readonly corruptChunks: number;
}
/** Each setting written through the Parameters tab, as its history row and parameter table show it. */
export interface TuningFacts {
  readonly writes: readonly {
    readonly name: string;
    readonly value: number;
    readonly outcome: string;
    readonly rebootRequired: boolean;
    /** The value the table shows from ArduPilot's read-back. */
    readonly shown: string;
  }[];
}
export interface MotorCheckFacts {
  readonly state: string;
  readonly summary: string;
  readonly rows: readonly (OutputPair & { readonly order: number; readonly pass: boolean })[];
}
export interface Firmware {
  readonly id: string;
  readonly firmwareVersion: string;
  readonly commit: string;
  readonly binarySha256: string;
  readonly defaultParametersSha256: string;
}
export interface StartFacts {
  readonly ready: string;
  readonly readyAtSimS: number;
  readonly recordSha256: string;
  /** The profile version the experiment record names. */
  readonly profileSha256: string;
  readonly physicsHz: number;
  readonly clockMode: string;
  readonly speedup: number | null;
  /** As the experiment record names it. */
  readonly firmware: Firmware;
  /** The catalog's binary and default parameters, hashed by the test. */
  readonly hashed: { readonly binarySha256: string; readonly defaultParametersSha256: string };
}
export interface HoldFacts {
  readonly stage: string;
  readonly armed: string;
  readonly mode: string;
  readonly startSimS: number;
  readonly endSimS: number;
  readonly readingsM: readonly number[];
}
export interface Snapshot { readonly simS: number; readonly altitudeM: number; readonly stepped: number }
export interface PauseFacts {
  readonly stage: string;
  readonly before: Snapshot;
  readonly after: Snapshot;
  readonly wallS: number;
  readonly resumedStage: string;
  readonly resumedAtSimS: number;
  readonly hold: HoldFacts;
  readonly failsafeMessages: readonly string[];
  readonly log: { readonly count: number; readonly reason: string; readonly wallS: number };
}
export interface LandingFacts {
  readonly mode: string;
  readonly armed: string;
  readonly state: string;
  readonly ready: string;
  readonly altitudeM: number;
  readonly restAltitudeM: number;
  readonly frames: string;
  /** The Run tab's autopilot messages at the end of the flight that name a failsafe, an EKF fault or a crash. */
  readonly failsafeMessages: readonly string[];
}
export interface StopFacts {
  readonly state: string;
  readonly text: string;
  readonly launcherState: string;
  readonly group: string;
  readonly members: readonly number[];
  readonly signalZero: string | null;
  readonly processes: number;
}
export interface StepFacts {
  readonly profile: ProfileFacts;
  readonly mapping: MappingFacts;
  readonly refusal: RefusalFacts;
  readonly start: StartFacts;
  readonly tuning: TuningFacts;
  readonly parameters: TuningFacts;
  readonly reopen: ReopenFacts;
  readonly motorCheck: MotorCheckFacts;
  readonly hold: HoldFacts;
  readonly pause: PauseFacts;
  readonly landing: LandingFacts;
  readonly stop: StopFacts;
}
/** A step the run reached: its facts, or the error that ended it (with the facts it had, if any). */
export interface StepRecord<F> { readonly facts: F | null; readonly error: string | null }
export type Steps = { readonly [S in StepId]: StepRecord<StepFacts[S]> | null };
export interface DataflashFacts {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  /** The launcher's assessment of the file, or that the file differs from the SHA-256 the launcher attached it with. */
  readonly status: string;
  readonly records: number;
  readonly truncatedBytes: number;
  /** Whether the log's VER record names the build's commit. */
  readonly firmwareMatchesBuild: boolean;
  /** Relative to the run file. */
  readonly file: string;
}
export interface RecordingFacts {
  readonly recordId: string;
  readonly status: string;
  readonly chunks: number;
  readonly bytes: number;
  readonly droppedChunks: number;
  readonly droppedRows: number;
  /** Rows the producer could not queue, each a declared gap; reported here, judged by the recording workflow's tasks. */
  readonly producerLost: number;
}
/** The Run tab's speed line after the landing: reported, not judged here (A-05 belongs to TASK-175, TASK-189 and TASK-191). */
export interface SpeedFacts {
  readonly verdict: string;
  readonly average: number | null;
  readonly dropped: number;
  readonly simElapsedS: number;
  readonly runningWallS: number;
}
/** The Run tab's power panel: in the hover, and its limit events over the flight. Reported, not judged. */
export interface PowerFacts {
  readonly hover: {
    readonly voltageV: number | null;
    readonly currentA: number | null;
    readonly powerW: number | null;
    /** Each motor's command, %. */
    readonly commandPercent: readonly (number | null)[];
  };
  readonly limitEvents: readonly string[];
}
export interface RateStatistics { readonly sdDegS: number; readonly peakDegS: number }
/**
 * How steady a hold was: the body rates in the flight's own DataFlash log (RATE records), which decision A-13 limits, since the
 * altitude criterion cannot see an attitude oscillation.
 */
export interface Steadiness {
  readonly fromS: number;
  readonly toS: number;
  readonly samples: number;
  readonly roll: RateStatistics;
  readonly pitch: RateStatistics;
  readonly yaw: RateStatistics;
}
/** The parts of a DataFlash log that steadinessOf reads, as packages/dataflash/src/reader.ts gives them. */
export interface RateLog {
  readonly groups: readonly {
    readonly name: string;
    readonly count: number;
    readonly columns: readonly { readonly name: string; readonly values: ArrayLike<number | bigint>; readonly valueScale: number }[];
  }[];
}
/** The body-rate statistics of the log's RATE records from `fromS` to `toS` of its own clock; null without any. */
export function steadinessOf(log: RateLog, fromS: number, toS: number): Steadiness | null {
  const group = log.groups.find(item => item.name === 'RATE');
  if (!group) return null;
  const column = (name: string): number[] => {
    const found = group.columns.find(item => item.name === name);
    if (!found) throw new Error(`RATE has no column ${name}`);
    return Array.from({ length: group.count }, (_, row) => Number(found.values[row]) * found.valueScale);
  };
  const rows = column('TimeUS').flatMap((timeS, row) => (timeS >= fromS && timeS <= toS ? [row] : []));
  if (rows.length === 0) return null;
  const statistics = (name: string): RateStatistics => {
    const all = column(name), values = rows.map(row => all[row] ?? Number.NaN);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return { sdDegS: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length), peakDegS: Math.max(...values.map(Math.abs)) };
  };
  return { fromS, toS, samples: rows.length, roll: statistics('R'), pitch: statistics('P'), yaw: statistics('Y') };
}

export interface NominalRun {
  readonly schema: typeof RUN_SCHEMA;
  readonly configuration: ConfigurationId;
  readonly settings: RunSettings;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** `renderer` is WebGL's unmasked renderer: the M5's GPU through ANGLE Metal, or a software renderer. */
  readonly browser: { readonly version: string; readonly userAgent: string; readonly headless: boolean; readonly renderer: string };
  readonly steps: Steps;
  readonly captures: {
    readonly launcherExperimentId: string | null;
    readonly dataflash: readonly DataflashFacts[];
    readonly recording: RecordingFacts | null;
    readonly speed: SpeedFacts | null;
    readonly power: PowerFacts | null;
    /** The two holds, from the flight's DataFlash log. */
    readonly steadiness: { readonly hold: Steadiness | null; readonly afterResume: Steadiness | null } | null;
    /** The STOCK_SETTINGS names as the flight's DataFlash log holds them at the start of the first hold; null when it does not. */
    readonly flownSettings: readonly { readonly name: string; readonly value: number | null }[];
  };
}

// Validation of a run file: it is external data until every field has been checked.
// No parameter properties: Node runs this file by stripping its types (scripts/phase1/nominal-flight.mjs).
class Shape {
  private readonly value: unknown;
  private readonly path: string;
  constructor(value: unknown, path: string) {
    this.value = value;
    this.path = path;
  }
  private fail(expected: string): never {
    throw new Error(`${this.path} is not ${expected}`);
  }
  get(key: string): Shape {
    if (typeof this.value !== 'object' || this.value === null || Array.isArray(this.value)) this.fail('an object');
    return new Shape(Reflect.get(this.value, key), `${this.path}.${key}`);
  }
  string(): string {
    return typeof this.value === 'string' ? this.value : this.fail('a string');
  }
  number(): number {
    return typeof this.value === 'number' && Number.isFinite(this.value) ? this.value : this.fail('a finite number');
  }
  boolean(): boolean {
    return typeof this.value === 'boolean' ? this.value : this.fail('a boolean');
  }
  isNull(): boolean {
    return this.value === null;
  }
  numberOrNull(): number | null {
    return this.isNull() ? null : this.number();
  }
  list<T>(item: (shape: Shape) => T): T[] {
    if (!Array.isArray(this.value)) this.fail('an array');
    const items: readonly unknown[] = this.value;
    return items.map((value, i) => item(new Shape(value, `${this.path}[${i}]`)));
  }
  oneOf<const T extends string>(values: readonly T[]): T {
    const text = this.string();
    const found = values.find(value => value === text);
    return found ?? this.fail(`one of ${values.join(', ')}`);
  }
}
const sha = (shape: Shape): string => {
  const text = shape.string();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${text} is not a SHA-256`);
  return text;
};
const strings = (shape: Shape) => shape.list(item => item.string());
const numbers = (shape: Shape) => shape.list(item => item.number());
const pair = (shape: Shape): OutputPair => ({ motor: shape.get('motor').number(), output: shape.get('output').number() });
const hold = (s: Shape): HoldFacts => ({
  stage: s.get('stage').string(), armed: s.get('armed').string(), mode: s.get('mode').string(),
  startSimS: s.get('startSimS').number(), endSimS: s.get('endSimS').number(), readingsM: numbers(s.get('readingsM')),
});
const rateStatistics = (s: Shape): RateStatistics => ({ sdDegS: s.get('sdDegS').number(), peakDegS: s.get('peakDegS').number() });
const steadiness = (s: Shape): Steadiness | null => (s.isNull() ? null : {
  fromS: s.get('fromS').number(), toS: s.get('toS').number(), samples: s.get('samples').number(),
  roll: rateStatistics(s.get('roll')), pitch: rateStatistics(s.get('pitch')), yaw: rateStatistics(s.get('yaw')),
});
const snapshot = (s: Shape): Snapshot => ({ simS: s.get('simS').number(), altitudeM: s.get('altitudeM').number(), stepped: s.get('stepped').number() });
const firmware = (s: Shape): Firmware => ({
  id: s.get('id').string(), firmwareVersion: s.get('firmwareVersion').string(), commit: s.get('commit').string(),
  binarySha256: sha(s.get('binarySha256')), defaultParametersSha256: sha(s.get('defaultParametersSha256')),
});
const FACTS: { readonly [S in StepId]: (shape: Shape) => StepFacts[S] } = {
  profile: s => ({
    cards: s.get('cards').list(card => ({ type: card.get('type').oneOf(CARD_TYPES), sha256: sha(card.get('sha256')),
      sourceKind: card.get('sourceKind').string(), differences: strings(card.get('differences')) })),
    sha256: sha(s.get('sha256')), version: s.get('version').number(), motors: s.get('motors').number(), differences: strings(s.get('differences')),
  }),
  mapping: s => ({ frame: s.get('frame').string(), outputs: s.get('outputs').list(pair) }),
  refusal: s => ({ problems: strings(s.get('problems')), saveDisabled: s.get('saveDisabled').boolean(), layoutErrors: strings(s.get('layoutErrors')), versions: s.get('versions').number() }),
  parameters: s => ({
    writes: s.get('writes').list(write => ({ name: write.get('name').string(), value: write.get('value').number(), outcome: write.get('outcome').string(),
      rebootRequired: write.get('rebootRequired').boolean(), shown: write.get('shown').string() })),
  }),
  reopen: s => ({ listed: s.get('listed').number(), recordId: s.get('recordId').string(), recordingText: s.get('recordingText').string(), profileText: s.get('profileText').string(),
    truthRows: s.get('truthRows').number(), missingChunks: s.get('missingChunks').number(), corruptChunks: s.get('corruptChunks').number() }),
  start: s => ({
    ready: s.get('ready').string(), readyAtSimS: s.get('readyAtSimS').number(), recordSha256: sha(s.get('recordSha256')),
    profileSha256: sha(s.get('profileSha256')), physicsHz: s.get('physicsHz').number(), clockMode: s.get('clockMode').string(),
    speedup: s.get('speedup').isNull() ? null : s.get('speedup').number(), firmware: firmware(s.get('firmware')),
    hashed: { binarySha256: sha(s.get('hashed').get('binarySha256')), defaultParametersSha256: sha(s.get('hashed').get('defaultParametersSha256')) },
  }),
  tuning: s => ({
    writes: s.get('writes').list(write => ({ name: write.get('name').string(), value: write.get('value').number(), outcome: write.get('outcome').string(),
      rebootRequired: write.get('rebootRequired').boolean(), shown: write.get('shown').string() })),
  }),
  motorCheck: s => ({
    state: s.get('state').string(), summary: s.get('summary').string(),
    rows: s.get('rows').list(row => ({ ...pair(row), order: row.get('order').number(), pass: row.get('pass').boolean() })),
  }),
  hold,
  pause: s => ({
    stage: s.get('stage').string(), before: snapshot(s.get('before')), after: snapshot(s.get('after')), wallS: s.get('wallS').number(),
    resumedStage: s.get('resumedStage').string(), resumedAtSimS: s.get('resumedAtSimS').number(), hold: hold(s.get('hold')),
    failsafeMessages: strings(s.get('failsafeMessages')),
    log: { count: s.get('log').get('count').number(), reason: s.get('log').get('reason').string(), wallS: s.get('log').get('wallS').number() },
  }),
  landing: s => ({
    mode: s.get('mode').string(), armed: s.get('armed').string(), state: s.get('state').string(), ready: s.get('ready').string(),
    altitudeM: s.get('altitudeM').number(), restAltitudeM: s.get('restAltitudeM').number(), frames: s.get('frames').string(),
    failsafeMessages: strings(s.get('failsafeMessages')),
  }),
  stop: s => ({
    state: s.get('state').string(), text: s.get('text').string(), launcherState: s.get('launcherState').string(), group: s.get('group').string(),
    members: numbers(s.get('members')), signalZero: s.get('signalZero').isNull() ? null : s.get('signalZero').string(),
    processes: s.get('processes').number(),
  }),
};
function step<S extends StepId>(id: S, shape: Shape): StepRecord<StepFacts[S]> | null {
  if (shape.isNull()) return null;
  const facts = shape.get('facts'), error = shape.get('error');
  const record = { facts: facts.isNull() ? null : FACTS[id](facts), error: error.isNull() ? null : error.string() };
  if (record.facts === null && record.error === null) throw new Error(`steps.${id} has neither facts nor an error`);
  return record;
}

/** A run file as the spec wrote it, every field checked; anything else is refused with the field that is wrong. */
export function parseNominalRun(value: unknown): NominalRun {
  const s = new Shape(value, 'run');
  if (s.get('schema').string() !== RUN_SCHEMA) throw new Error(`run.schema is not ${RUN_SCHEMA}`);
  const steps = s.get('steps'), captures = s.get('captures');
  const recording = captures.get('recording'), speed = captures.get('speed'), power = captures.get('power'), steady = captures.get('steadiness');
  return {
    schema: RUN_SCHEMA,
    configuration: s.get('configuration').oneOf(NOMINAL_CONFIGURATIONS.map(c => c.id)),
    settings: s.get('settings').oneOf(RUN_SETTINGS),
    startedAt: s.get('startedAt').string(), finishedAt: s.get('finishedAt').string(),
    browser: { version: s.get('browser').get('version').string(), userAgent: s.get('browser').get('userAgent').string(),
      headless: s.get('browser').get('headless').boolean(), renderer: s.get('browser').get('renderer').string() },
    steps: {
      profile: step('profile', steps.get('profile')), mapping: step('mapping', steps.get('mapping')), refusal: step('refusal', steps.get('refusal')), start: step('start', steps.get('start')),
      parameters: step('parameters', steps.get('parameters')), reopen: step('reopen', steps.get('reopen')),
      tuning: step('tuning', steps.get('tuning')), motorCheck: step('motorCheck', steps.get('motorCheck')), hold: step('hold', steps.get('hold')), pause: step('pause', steps.get('pause')),
      landing: step('landing', steps.get('landing')), stop: step('stop', steps.get('stop')),
    },
    captures: {
      launcherExperimentId: captures.get('launcherExperimentId').isNull() ? null : captures.get('launcherExperimentId').string(),
      dataflash: captures.get('dataflash').list(file => ({ name: file.get('name').string(), bytes: file.get('bytes').number(),
        sha256: sha(file.get('sha256')), status: file.get('status').string(), records: file.get('records').number(),
        truncatedBytes: file.get('truncatedBytes').number(), firmwareMatchesBuild: file.get('firmwareMatchesBuild').boolean(), file: file.get('file').string() })),
      recording: recording.isNull() ? null : {
        recordId: recording.get('recordId').string(), status: recording.get('status').string(), chunks: recording.get('chunks').number(),
        bytes: recording.get('bytes').number(), droppedChunks: recording.get('droppedChunks').number(), droppedRows: recording.get('droppedRows').number(),
        producerLost: recording.get('producerLost').number(),
      },
      speed: speed.isNull() ? null : { verdict: speed.get('verdict').string(), average: speed.get('average').isNull() ? null : speed.get('average').number(),
        dropped: speed.get('dropped').number(), simElapsedS: speed.get('simElapsedS').number(), runningWallS: speed.get('runningWallS').number() },
      power: power.isNull() ? null : {
        hover: { voltageV: power.get('hover').get('voltageV').numberOrNull(), currentA: power.get('hover').get('currentA').numberOrNull(),
          powerW: power.get('hover').get('powerW').numberOrNull(), commandPercent: power.get('hover').get('commandPercent').list(item => item.numberOrNull()) },
        limitEvents: strings(power.get('limitEvents')),
      },
      steadiness: steady.isNull() ? null : { hold: steadiness(steady.get('hold')), afterResume: steadiness(steady.get('afterResume')) },
      flownSettings: captures.get('flownSettings').list(item => ({ name: item.get('name').string(), value: item.get('value').numberOrNull() })),
    },
  };
}

export const configurationOf = (id: ConfigurationId): NominalConfiguration => {
  const found = NOMINAL_CONFIGURATIONS.find(c => c.id === id);
  if (!found) throw new Error(`Unknown configuration ${id}`);
  return found;
};

/** The settings this run types in: the configuration's tuning, or none in the stock-settings negative control. */
export function plannedTuning(run: Pick<NominalRun, 'configuration' | 'settings'>): readonly { readonly name: string; readonly value: number }[] {
  return run.settings === 'stock' ? [] : configurationOf(run.configuration).tuning;
}

// Each check returns the reasons a step's facts miss its criteria; none means it meets them.
function holdReasons(h: HoldFacts, what: string): string[] {
  const reasons: string[] = [];
  if (h.stage !== 'Flying') reasons.push(`${what}: the stage is ${h.stage}, not Flying`);
  if (h.armed !== 'Armed') reasons.push(`${what}: ${h.armed}, not Armed`);
  if (h.mode !== 'GUIDED') reasons.push(`${what}: mode ${h.mode}, not GUIDED`);
  if (!(h.endSimS - h.startSimS >= CRITERIA.holdSimS)) reasons.push(`${what}: ${(h.endSimS - h.startSimS).toFixed(2)} s simulated, below ${CRITERIA.holdSimS} s`);
  if (h.readingsM.length < CRITERIA.minimumReadings) reasons.push(`${what}: ${h.readingsM.length} readings, below ${CRITERIA.minimumReadings}`);
  const outside = h.readingsM.filter(m => !(Math.abs(m - CRITERIA.takeoffAltitudeM) <= CRITERIA.hoverBandM));
  if (outside.length > 0) reasons.push(`${what}: ${outside.length} readings outside ${CRITERIA.takeoffAltitudeM} ± ${CRITERIA.hoverBandM} m (${outside.join(', ')} m)`);
  return reasons;
}
function checks(run: NominalRun, configuration: NominalConfiguration): { readonly [S in StepId]: (facts: StepFacts[S]) => string[] } {
  const profile = run.steps.profile?.facts ?? null, mapping = run.steps.mapping?.facts ?? null;
  return {
    profile: f => {
      const reasons: string[] = [];
      for (const type of CARD_TYPES) {
        const cards = f.cards.filter(card => card.type === type);
        if (cards.length !== 1) reasons.push(`${cards.length} ${type} cards made, not 1`);
        for (const card of cards) {
          if (card.sourceKind !== 'synthetic') reasons.push(`the ${type} card's source is ${card.sourceKind}, not illustrative (synthetic)`);
          for (const difference of card.differences) reasons.push(`the ${type} card: ${difference}`);
        }
      }
      if (f.motors !== configuration.motors) reasons.push(`${f.motors} motors, not ${configuration.motors}`);
      for (const difference of f.differences) reasons.push(`the profile: ${difference}`);
      return reasons;
    },
    refusal: f => {
      const reasons: string[] = [];
      if (!f.problems.some(problem => /is assigned to motors/.test(problem))) reasons.push(`a repeated output was not refused: ${JSON.stringify(f.problems)}`);
      if (!f.saveDisabled) reasons.push('Save stayed enabled with a repeated output');
      if (!f.layoutErrors.some(error => /1 to 8 arms/.test(error))) reasons.push(`a ninth arm was not refused: ${JSON.stringify(f.layoutErrors)}`);
      if (f.versions !== 1) reasons.push(`${f.versions} versions of the profile stored after the refusals, not 1`);
      return reasons;
    },
    parameters: f => {
      const reasons: string[] = [], write = f.writes.find(item => item.name === PARAMETER_CHANGE.name);
      if (f.writes.length !== 1 || !write) return [`${f.writes.length} writes, not the one of ${PARAMETER_CHANGE.name}`];
      if (write.value !== PARAMETER_CHANGE.value) reasons.push(`${write.name} written as ${write.value}`);
      if (write.outcome !== 'confirmed') reasons.push(`${write.name} write ${write.outcome}, not confirmed`);
      if (write.rebootRequired) reasons.push(`${write.name} needs a restart`);
      if (Number.parseFloat(write.shown) !== PARAMETER_CHANGE.value) reasons.push(`the table shows ${write.name} as ${write.shown}`);
      return reasons;
    },
    reopen: f => {
      const reasons: string[] = [];
      if (f.listed !== 1) reasons.push(`${f.listed} experiments listed, not 1`);
      if (!f.recordingText.includes(f.recordId)) reasons.push(`the detail does not name the recording: ${f.recordingText}`);
      if (!f.profileText.includes(configuration.recipe)) reasons.push(`the detail names another aircraft: ${f.profileText}`);
      if (f.truthRows < 1) reasons.push('no position rows read back from the recording');
      if (f.missingChunks > 0 || f.corruptChunks > 0) reasons.push(`${f.missingChunks} missing and ${f.corruptChunks} corrupt chunks`);
      return reasons;
    },
    mapping: f => {
      const reasons: string[] = [];
      if (!/FRAME_CLASS \d+, FRAME_TYPE \d+/.test(f.frame)) reasons.push(`no ArduPilot frame: ${f.frame}`);
      if (f.outputs.length !== configuration.motors) reasons.push(`${f.outputs.length} motors mapped, not ${configuration.motors}`);
      if (new Set(f.outputs.map(o => o.output)).size !== f.outputs.length) reasons.push('two motors share an output');
      return reasons;
    },
    start: f => {
      const reasons: string[] = [];
      if (f.ready !== 'READY') reasons.push(`readiness ${f.ready}, not READY`);
      if (!(f.readyAtSimS > 0)) reasons.push(`READY at ${f.readyAtSimS} s simulated`);
      if (f.physicsHz !== CRITERIA.physicsHz) reasons.push(`physics at ${f.physicsHz} Hz, not ${CRITERIA.physicsHz} Hz (A-04)`);
      if (f.clockMode !== 'sitl-lockstep') reasons.push(`clock ${f.clockMode}, not sitl-lockstep`);
      if (f.speedup !== CRITERIA.speedup) reasons.push(`speed ${String(f.speedup)}, not real time`);
      if (profile && f.profileSha256 !== profile.sha256) reasons.push('the run flew another profile version than the one made in this run');
      if (f.firmware.binarySha256 !== f.hashed.binarySha256) reasons.push('the record names another ArduPilot binary than the catalog\'s');
      if (f.firmware.defaultParametersSha256 !== f.hashed.defaultParametersSha256) reasons.push('the record names other default parameters than the catalog\'s');
      return reasons;
    },
    tuning: f => {
      const reasons: string[] = [], planned = plannedTuning(run);
      for (const { name, value } of planned) {
        const write = f.writes.find(item => item.name === name);
        if (!write) { reasons.push(`${name} was not written`); continue; }
        if (write.outcome !== 'confirmed') reasons.push(`${name}: ${write.outcome}, not confirmed`);
        if (write.rebootRequired) reasons.push(`${name} needs a restart, so the flight would not use it`);
        if (write.shown !== String(value)) reasons.push(`${name} reads ${write.shown}, not ${value}`);
      }
      for (const write of f.writes) if (!planned.some(item => item.name === write.name)) reasons.push(`${write.name} was written, and this run plans no such setting`);
      return reasons;
    },
    motorCheck: f => {
      const reasons: string[] = [];
      if (f.state !== 'passed') reasons.push(`the motor check ended ${f.state}`);
      if (f.rows.length !== configuration.motors) reasons.push(`${f.rows.length} motors tested, not ${configuration.motors}`);
      const orders = f.rows.map(row => row.order).sort((a, b) => a - b);
      if (orders.some((order, i) => order !== i + 1)) reasons.push(`test orders ${orders.join(', ')}`);
      for (const row of f.rows) {
        if (!row.pass) reasons.push(`motor ${row.motor} (test order ${row.order}) failed`);
        const mapped = mapping?.outputs.find(o => o.motor === row.motor);
        if (mapping && mapped?.output !== row.output) reasons.push(`motor ${row.motor} turned on output ${row.output}; the Aircraft tab maps it to ${String(mapped?.output)}`);
      }
      if (new Set(f.rows.map(row => row.motor)).size !== f.rows.length) reasons.push('a motor was tested twice');
      return reasons;
    },
    hold: f => holdReasons(f, 'the hold'),
    pause: f => {
      const reasons: string[] = [];
      if (f.stage !== 'paused') reasons.push(`the stage while paused is ${f.stage}`);
      for (const key of ['simS', 'altitudeM', 'stepped'] as const) {
        if (f.after[key] !== f.before[key]) reasons.push(`${key} moved while paused: ${f.before[key]} to ${f.after[key]}`);
      }
      if (!(f.wallS >= CRITERIA.pauseWallS)) reasons.push(`paused ${f.wallS} s of wall time, below ${CRITERIA.pauseWallS} s`);
      if (f.resumedStage !== 'Flying') reasons.push(`after Resume the stage is ${f.resumedStage}`);
      if (!(f.resumedAtSimS - f.before.simS < CRITERIA.pauseSimS)) reasons.push(`${(f.resumedAtSimS - f.before.simS).toFixed(2)} s simulated between Pause and Resume`);
      reasons.push(...holdReasons(f.hold, 'the hold after Resume'));
      for (const message of f.failsafeMessages) reasons.push(`autopilot message: ${message}`);
      if (f.log.count !== 1 || f.log.reason !== 'user') reasons.push(`${f.log.count} pauses logged, reason ${f.log.reason}`);
      if (!(f.log.wallS >= CRITERIA.pauseWallS)) reasons.push(`the log gives ${f.log.wallS} s paused`);
      return reasons;
    },
    landing: f => {
      const reasons: string[] = [];
      if (f.mode !== 'LAND') reasons.push(`landed in mode ${f.mode}, not LAND`);
      if (f.armed !== 'Disarmed') reasons.push(`${f.armed} after landing`);
      if (f.state !== 'ready' || f.ready !== 'READY') reasons.push(`after landing the run is ${f.state}, ${f.ready}`);
      if (!(Math.abs(f.altitudeM - f.restAltitudeM) <= CRITERIA.restToleranceM)) {
        reasons.push(`landed at ${f.altitudeM} m, ${Math.abs(f.altitudeM - f.restAltitudeM).toFixed(4)} m from the rest height ${f.restAltitudeM.toFixed(4)} m`);
      }
      const frames = /^(\d+) stepped, (\d+) lost, (\d+) resent, (\d+) held$/.exec(f.frames);
      const pauses = run.steps.pause?.facts?.log.count ?? 0;
      for (const message of f.failsafeMessages) reasons.push(`autopilot message: ${message}`);
      if (!frames) reasons.push(`frames: ${f.frames}`);
      else {
        if (Number(frames[2]) > 0) reasons.push(`${frames[2]} servo frames lost: ${f.frames}`);
        if (Number(frames[3]) > CRITERIA.resentPerPause * pauses) reasons.push(`${frames[3]} frames resent in a run with ${pauses} pauses: ${f.frames}`);
      }
      return reasons;
    },
    stop: f => {
      const reasons: string[] = [];
      if (f.state !== 'idle' || !f.text.includes('stopped')) reasons.push(`after Stop the run is ${f.state}: ${f.text}`);
      if (f.launcherState !== 'stopped') reasons.push(`the launcher reports the run ${f.launcherState}`);
      if (f.group !== '' || f.members.length > 0 || f.signalZero !== 'ESRCH' || f.processes > 0) {
        reasons.push(`a process of the run is left: group "${f.group}", members ${f.members.join(' ')}, signal 0 ${String(f.signalZero)}, ${f.processes} naming its home`);
      }
      return reasons;
    },
  };
}

/** Why a flight's capture cannot stand as its evidence: its DataFlash file and its recording. */
function captureReasons(run: NominalRun): string[] {
  const reasons: string[] = [], { dataflash } = run.captures, allowed: readonly string[] = CRITERIA.dataflashStatuses;
  if (dataflash.length === 0) reasons.push('the run left no DataFlash file');
  for (const file of dataflash) {
    if (!allowed.includes(file.status)) reasons.push(`DataFlash ${file.name}: ${file.status}`);
    if (!file.firmwareMatchesBuild) reasons.push(`DataFlash ${file.name}: its VER record does not name the build`);
  }
  return [...reasons, ...recordingReasons(run)];
}
function recordingReasons(run: NominalRun): string[] {
  const reasons: string[] = [], { recording } = run.captures;
  if (!recording) reasons.push('the run left no recording');
  else {
    if (recording.status !== 'closed') reasons.push(`the recording is ${recording.status}, not closed`);
    if (recording.droppedChunks > 0 || recording.droppedRows > 0) reasons.push(`the recording dropped ${recording.droppedChunks} chunks and ${recording.droppedRows} rows`);
  }
  return reasons;
}

/** Why a hold misses decision A-13: its body rates vary by more than the limit, or the flight's log cannot show them. */
function steadinessReasons(held: Steadiness | null | undefined, what: string): string[] {
  if (!held) return [`${what}: no RATE records in the flight's log`];
  return (['roll', 'pitch', 'yaw'] as const).filter(axis => !(held[axis].sdDegS <= CRITERIA.steadinessSdDegS))
    .map(axis => `${what}: ${axis} rate varies by ${held[axis].sdDegS.toFixed(2)} deg/s, above the ${CRITERIA.steadinessSdDegS} deg/s limit (A-13)`);
}
/** Where the flight's own log differs from the settings this run should have flown: its tuning, and stock values for the rest. */
function flownSettingsReasons(run: NominalRun): string[] {
  const planned = plannedTuning(run), reasons: string[] = [];
  for (const [name, stock] of Object.entries(STOCK_SETTINGS)) {
    const expected = planned.find(item => item.name === name)?.value ?? stock;
    const flown = run.captures.flownSettings.find(item => item.name === name)?.value ?? null;
    if (flown === null) reasons.push(`the flight's log does not show ${name}`);
    else if (!(Math.abs(flown - expected) <= FLOAT32_TOLERANCE * Math.max(1, Math.abs(expected)))) reasons.push(`${name} flew at ${flown}, not ${expected}`);
  }
  return reasons;
}

export type Verdict = 'PASS' | 'FAIL' | 'NOT_RUN';
export interface WorkflowVerdict { readonly verdict: Verdict; readonly reasons: readonly string[] }

/** Each workflow's verdict from the run's own facts against CRITERIA: a step not reached is NOT_RUN, an error or a missed criterion FAIL. */
export function judgeRun(run: NominalRun): { readonly [W in NominalWorkflow]: WorkflowVerdict } {
  const configuration = configurationOf(run.configuration), check = checks(run, configuration);
  const firstError = STEPS.find(id => run.steps[id]?.error);
  const judge = <S extends StepId>(id: S): WorkflowVerdict => {
    const record = run.steps[id];
    if (!record) {
      return { verdict: 'NOT_RUN', reasons: [firstError ? `${id} not reached: ${firstError} failed` : `${id} not reached`] };
    }
    const reasons = [...(record.error ? [`${id}: ${record.error}`] : []), ...(record.facts ? check[id](record.facts) : [])];
    return { verdict: reasons.length > 0 ? 'FAIL' : 'PASS', reasons };
  };
  const workflow = (w: NominalWorkflow): WorkflowVerdict => {
    const verdicts = WORKFLOW_STEPS[w].map(judge);
    const reasons = verdicts.flatMap(v => v.reasons);
    if (verdicts.some(v => v.verdict === 'FAIL')) return { verdict: 'FAIL', reasons };
    if (verdicts.some(v => v.verdict === 'NOT_RUN')) return { verdict: 'NOT_RUN', reasons };
    return { verdict: 'PASS', reasons: [] };
  };
  // A flight that met its criteria still needs its capture to stand as evidence, its settings as planned, and each hold steady (A-13).
  const judged = (w: NominalWorkflow, extra: () => readonly string[]): WorkflowVerdict => {
    const verdict = workflow(w), reasons = verdict.verdict === 'PASS' ? extra() : [];
    return reasons.length > 0 ? { verdict: 'FAIL', reasons } : verdict;
  };
  const steady = run.captures.steadiness;
  return {
    'profile-creation': workflow('profile-creation'), 'output-mapping': workflow('output-mapping'), start: workflow('start'),
    'flight-task': judged('flight-task', () => [...captureReasons(run), ...flownSettingsReasons(run), ...steadinessReasons(steady?.hold, 'the hold')]),
    'pause-resume': judged('pause-resume', () => steadinessReasons(steady?.afterResume, 'the hold after Resume')),
    'parameter-changes': workflow('parameter-changes'),
    recording: judged('recording', () => recordingReasons(run)),
    'reopen-results': workflow('reopen-results'),
    'unsupported-refusal': workflow('unsupported-refusal'),
  };
}

export interface Host {
  readonly platform: string;
  readonly arch: string;
  readonly model: string;
  readonly chip: string;
  readonly memoryBytes: number;
}
/** Why a host is not the acceptance machine of A-01 (the 15-inch Apple M5 MacBook Air with 32 GB); empty when it is. */
export function acceptanceMachineReasons(host: Host): string[] {
  const reasons: string[] = [];
  if (host.platform !== 'darwin' || host.arch !== 'arm64') reasons.push(`${host.platform} ${host.arch} is not macOS on Apple Silicon`);
  if (host.chip !== 'Apple M5') reasons.push(`the chip is ${host.chip}, not the Apple M5`);
  if (!host.model.startsWith('Mac')) reasons.push(`the model ${host.model} is not a Mac`);
  if (host.memoryBytes !== 32 * 1024 ** 3) reasons.push(`${(host.memoryBytes / 1024 ** 3).toFixed(1)} GB of memory, not 32 GB`);
  return reasons;
}

/** A global workflow's cell has no configuration. */
interface MatrixCell { readonly configuration: string | null; readonly workflow: string; readonly verdict: string; readonly evidence: unknown; readonly blockedBy?: unknown }
/**
 * The matrix with this run's verdicts in its configuration's TASK-158 cells, each citing the evidence report;
 * every other cell and field is kept as it was. Refuses a matrix whose cells do not have that shape.
 */
export function writeNominalCells(matrix: unknown, configuration: ConfigurationId,
  verdicts: { readonly [W in NominalWorkflow]: WorkflowVerdict }, evidence: { readonly path: string; readonly sha256: string }): Record<string, unknown> {
  if (typeof matrix !== 'object' || matrix === null || Array.isArray(matrix) || Reflect.get(matrix, 'schemaVersion') !== 1) {
    throw new Error('The matrix is not schema version 1');
  }
  const cells: unknown = Reflect.get(matrix, 'cells');
  if (!Array.isArray(cells)) throw new Error('The matrix has no cells');
  const list: readonly unknown[] = cells;
  const typed = list.map((cell, i): MatrixCell => {
    const s = new Shape(cell, `cells[${i}]`);
    const blockedBy: unknown = typeof cell === 'object' && cell !== null ? Reflect.get(cell, 'blockedBy') : undefined;
    return { configuration: s.get('configuration').isNull() ? null : s.get('configuration').string(), workflow: s.get('workflow').string(), verdict: s.get('verdict').string(),
      evidence: typeof cell === 'object' && cell !== null ? Reflect.get(cell, 'evidence') : null, ...(blockedBy === undefined ? {} : { blockedBy }) };
  });
  for (const workflow of NOMINAL_WORKFLOWS) {
    const count = typed.filter(cell => cell.configuration === configuration && cell.workflow === workflow).length;
    if (count !== 1) throw new Error(`The matrix has ${count} cells for ${configuration} × ${workflow}`);
  }
  if (!/^[0-9a-f]{64}$/.test(evidence.sha256)) throw new Error('The evidence has no SHA-256');
  const isNominal = (workflow: string): workflow is NominalWorkflow => NOMINAL_WORKFLOWS.some(w => w === workflow);
  return {
    ...matrix,
    cells: list.map((cell, i) => {
      const c = typed[i];
      if (!c || c.configuration !== configuration || !isNominal(c.workflow)) return cell;
      return { configuration, workflow: c.workflow, verdict: verdicts[c.workflow].verdict, evidence: { path: evidence.path, sha256: evidence.sha256 } };
    }),
  };
}
