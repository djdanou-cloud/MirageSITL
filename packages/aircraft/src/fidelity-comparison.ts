import type { StoredVersion } from '@mirage/project/schema';
import type { ProjectStore } from '@mirage/project/store';

// Fidelity comparisons (TASK-184, S15; SPECS_SIMULATION_ENGINES "Fidelity assessment: TASK-184"): what `assessFidelity` gave for a
// real flight log beside the log of a simulated run of one aircraft profile version, kept as a `fidelity-comparison` record of the
// project store with that version as its one dependency. It holds every number and no limit and no verdict (SA-01, F-05). A profile
// version shows the TASK-133 label `flight-checked` only while it has a comparison with a real log; a new version has none, so a change
// of geometry, mass, motor or propeller resets it (F-06). Configuration-time code only.

export const FIDELITY_COMPARISON_SCHEMA_VERSION = 1;
export const COMPARISON_REGIMES = ['ground', 'hover', 'climb', 'descent', 'forward'] as const;
export type ComparisonRegime = typeof COMPARISON_REGIMES[number];
export interface ComparedLogFile {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  /** `logOrigin` of the log: real hardware, or a simulation. */
  readonly origin: 'real' | 'simulated';
  readonly originReason: string;
}
export interface ComparisonSummary { readonly mean: number; readonly min: number; readonly max: number }
export interface ComparisonRow {
  readonly quantity: string; readonly label: string; readonly unit: string;
  readonly regime: ComparisonRegime | 'all';
  readonly status: 'compared' | 'missing';
  readonly reason: string | null;
  readonly samples: number;
  readonly rms: number | null; readonly bias: number | null; readonly theil: number | null; readonly maxAbs: number | null;
  readonly real: ComparisonSummary | null; readonly simulated: ComparisonSummary | null;
}
export interface ComparisonScalar {
  readonly quantity: string; readonly label: string; readonly unit: string;
  readonly real: number | null; readonly simulated: number | null; readonly reason: string | null;
}
export interface ComparisonPath {
  readonly comparedS: number; readonly samples: number;
  readonly horizontalRmsM: number; readonly horizontalMaxM: number; readonly heightRmsM: number; readonly heightMaxM: number;
}
export interface FidelityComparison {
  readonly schemaVersion: typeof FIDELITY_COMPARISON_SCHEMA_VERSION;
  /** The profile version the simulated run flew, which is the record's dependency. */
  readonly profile: { readonly sha256: string; readonly name: string; readonly version: number };
  /** The experiment record of the simulated run, named as data. */
  readonly experimentSha256: string;
  readonly real: ComparedLogFile;
  readonly simulated: ComparedLogFile;
  /** The real log's interval and the simulated log's offset: t_sim = t_real + offset. */
  readonly interval: { readonly fromS: number; readonly toS: number; readonly simulatedOffsetS: number };
  readonly regimes: readonly { readonly regime: ComparisonRegime; readonly seconds: number }[];
  readonly rows: readonly ComparisonRow[];
  readonly scalars: readonly ComparisonScalar[];
  readonly path: ComparisonPath | null;
  readonly pathReason: string | null;
}

const fail = (message: string): never => { throw new Error(`Invalid fidelity comparison: ${message}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) return fail(`${label} must be an object`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} lacks ${key}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} has an unexpected field ${key}`);
  return value;
}
const sha256 = (value: unknown, label: string): string => (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : fail(`${label} must be a lowercase SHA-256`));
const text = (value: unknown, label: string, max = 256): string => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : fail(`${label} must be text of 1 to ${max} characters`));
const finite = (value: unknown, label: string): number => (typeof value === 'number' && Number.isFinite(value) ? value : fail(`${label} must be a finite number`));
const orNull = <T>(value: unknown, read: (value: unknown) => T): T | null => (value === null ? null : read(value));
const whole = (value: unknown, label: string): number => { const n = finite(value, label); return Number.isInteger(n) && n >= 0 ? n : fail(`${label} must be a whole number`); };
const list = (value: unknown, label: string, max: number): readonly unknown[] => (Array.isArray(value) && value.length <= max ? value : fail(`${label} must be a list of at most ${max}`));

function logFile(value: unknown, label: string): ComparedLogFile {
  const v = exact(value, ['name', 'sha256', 'bytes', 'origin', 'originReason'], label);
  const origin = v.origin === 'real' || v.origin === 'simulated' ? v.origin : fail(`${label}.origin must be real or simulated`);
  return { name: text(v.name, `${label}.name`, 128), sha256: sha256(v.sha256, `${label}.sha256`), bytes: whole(v.bytes, `${label}.bytes`), origin, originReason: text(v.originReason, `${label}.originReason`) };
}
function summary(value: unknown, label: string): ComparisonSummary {
  const v = exact(value, ['mean', 'min', 'max'], label);
  return { mean: finite(v.mean, `${label}.mean`), min: finite(v.min, `${label}.min`), max: finite(v.max, `${label}.max`) };
}
const regimeOf = (value: unknown, label: string): ComparisonRegime => COMPARISON_REGIMES.find(regime => regime === value) ?? fail(`${label} must be one of ${COMPARISON_REGIMES.join(', ')}`);
function row(value: unknown, label: string): ComparisonRow {
  const v = exact(value, ['quantity', 'label', 'unit', 'regime', 'status', 'reason', 'samples', 'rms', 'bias', 'theil', 'maxAbs', 'real', 'simulated'], label);
  const status = v.status === 'compared' || v.status === 'missing' ? v.status : fail(`${label}.status must be compared or missing`);
  const number = (key: string) => orNull(v[key], x => finite(x, `${label}.${key}`));
  const out: ComparisonRow = {
    quantity: text(v.quantity, `${label}.quantity`, 64), label: text(v.label, `${label}.label`, 128), unit: text(v.unit, `${label}.unit`, 16),
    regime: v.regime === 'all' ? 'all' : regimeOf(v.regime, `${label}.regime`), status, reason: orNull(v.reason, x => text(x, `${label}.reason`, 512)),
    samples: whole(v.samples, `${label}.samples`), rms: number('rms'), bias: number('bias'), theil: number('theil'), maxAbs: number('maxAbs'),
    real: orNull(v.real, x => summary(x, `${label}.real`)), simulated: orNull(v.simulated, x => summary(x, `${label}.simulated`)),
  };
  // A missing row carries its reason and no number; a compared one its samples and metrics.
  if (status === 'missing' && (out.reason === null || out.rms !== null || out.real !== null)) fail(`${label} is missing, so it holds a reason and no number`);
  if (status === 'compared' && (out.reason !== null || out.rms === null || out.samples < 2)) fail(`${label} is compared, so it holds at least two samples and its metrics`);
  return out;
}
function scalar(value: unknown, label: string): ComparisonScalar {
  const v = exact(value, ['quantity', 'label', 'unit', 'real', 'simulated', 'reason'], label);
  return { quantity: text(v.quantity, `${label}.quantity`, 64), label: text(v.label, `${label}.label`, 128), unit: text(v.unit, `${label}.unit`, 16),
    real: orNull(v.real, x => finite(x, `${label}.real`)), simulated: orNull(v.simulated, x => finite(x, `${label}.simulated`)), reason: orNull(v.reason, x => text(x, `${label}.reason`, 512)) };
}

/** A fidelity comparison from unknown; registered for the `fidelity-comparison` kind. */
export function validateFidelityComparison(value: unknown): FidelityComparison {
  const v = exact(value, ['schemaVersion', 'profile', 'experimentSha256', 'real', 'simulated', 'interval', 'regimes', 'rows', 'scalars', 'path', 'pathReason'], 'the payload');
  if (v.schemaVersion !== FIDELITY_COMPARISON_SCHEMA_VERSION) fail(`schemaVersion must be ${FIDELITY_COMPARISON_SCHEMA_VERSION}`);
  const p = exact(v.profile, ['sha256', 'name', 'version'], 'profile');
  const i = exact(v.interval, ['fromS', 'toS', 'simulatedOffsetS'], 'interval');
  const interval = { fromS: finite(i.fromS, 'interval.fromS'), toS: finite(i.toS, 'interval.toS'), simulatedOffsetS: finite(i.simulatedOffsetS, 'interval.simulatedOffsetS') };
  if (!(interval.toS > interval.fromS)) fail('interval must end after it starts');
  const regimes = list(v.regimes, 'regimes', COMPARISON_REGIMES.length).map((item, k) => {
    const r = exact(item, ['regime', 'seconds'], `regimes[${k}]`);
    return { regime: regimeOf(r.regime, `regimes[${k}].regime`), seconds: finite(r.seconds, `regimes[${k}].seconds`) };
  });
  const real = logFile(v.real, 'real'), simulated = logFile(v.simulated, 'simulated');
  if (real.sha256 === simulated.sha256) fail('the real and the simulated log are the same file');
  const path = orNull(v.path, x => {
    const q = exact(x, ['comparedS', 'samples', 'horizontalRmsM', 'horizontalMaxM', 'heightRmsM', 'heightMaxM'], 'path');
    return { comparedS: finite(q.comparedS, 'path.comparedS'), samples: whole(q.samples, 'path.samples'), horizontalRmsM: finite(q.horizontalRmsM, 'path.horizontalRmsM'),
      horizontalMaxM: finite(q.horizontalMaxM, 'path.horizontalMaxM'), heightRmsM: finite(q.heightRmsM, 'path.heightRmsM'), heightMaxM: finite(q.heightMaxM, 'path.heightMaxM') };
  });
  const pathReason = orNull(v.pathReason, x => text(x, 'pathReason', 512));
  if ((path === null) === (pathReason === null)) fail('a comparison holds either the path or the reason it has none');
  return {
    schemaVersion: FIDELITY_COMPARISON_SCHEMA_VERSION,
    profile: { sha256: sha256(p.sha256, 'profile.sha256'), name: text(p.name, 'profile.name', 128), version: whole(p.version, 'profile.version') },
    experimentSha256: sha256(v.experimentSha256, 'experimentSha256'), real, simulated, interval, regimes,
    rows: list(v.rows, 'rows', 256).map((item, k) => row(item, `rows[${k}]`)), scalars: list(v.scalars, 'scalars', 64).map((item, k) => scalar(item, `scalars[${k}]`)),
    path, pathReason,
  };
}
export const readFidelityComparison = (stored: StoredVersion): FidelityComparison => validateFidelityComparison(stored.record.payload);

/** Stores a comparison against its profile version, which must be in the project. */
export async function saveFidelityComparison(store: ProjectStore, projectId: string, comparison: FidelityComparison): Promise<StoredVersion> {
  const payload = validateFidelityComparison(comparison);
  const name = `${payload.real.name} and ${payload.simulated.name}`.slice(0, 128);
  return store.createItem(projectId, 'fidelity-comparison', { name, payload, dependencies: [payload.profile.sha256] });
}

/** A profile version's `flight-checked` label: earned by its comparisons with real logs, in the regimes they compared. */
export interface FlightCheck {
  readonly label: 'flight-checked';
  /** The comparisons with a real log of this version. */
  readonly comparisons: readonly string[];
  /** The regimes in which at least one quantity was compared, in COMPARISON_REGIMES order. */
  readonly regimes: readonly ComparisonRegime[];
}
/**
 * The label of one profile version from the stored comparisons: null unless one of them compared a real log with a run of exactly this
 * version. Comparisons of other versions stay theirs, so a new version starts without the label.
 */
export function flightCheckOf(profileSha256: string, comparisons: readonly StoredVersion[]): FlightCheck | null {
  const own = comparisons.map(stored => ({ sha256: stored.sha256, comparison: readFidelityComparison(stored) }))
    .filter(item => item.comparison.profile.sha256 === profileSha256 && item.comparison.real.origin === 'real');
  if (own.length === 0) return null;
  const regimes = COMPARISON_REGIMES.filter(regime => own.some(item => item.comparison.rows.some(r => r.regime === regime && r.status === 'compared')));
  return { label: 'flight-checked', comparisons: own.map(item => item.sha256).sort(), regimes };
}
