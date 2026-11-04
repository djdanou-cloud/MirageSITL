// Sequential user-defined parameter batches (TASK-176, S12): the record of a batch. The user supplies the sets; one
// scenario runs once for each, in order, with every other input identical, and the results are collected here.
// The system never chooses values, searches for new ones, retries a failed run or says that a set is fit for flight.
// A batch is a versioned `experiment-batch` item: a new version after each run, naming the experiments so far.
// Payloads start as unknown and become these types only here. Configuration-time code only.
import { SHA256_HEX, type StoredVersion } from './schema.ts';

export const BATCH_SCHEMA_VERSION = 1;
/** A batch is run by a person watching it; more sets than this is another kind of tool. */
export const MAX_BATCH_SETS = 32;
/** Parameters in one set: a set changes a few values, and the rest stay as the aircraft profile and ArduPilot give them. */
export const MAX_BATCH_SET_PARAMETERS = 512;
const PARAMETER_NAME = /^[\x21-\x7e]{1,16}$/;
const MAX_TEXT = 256;

export interface BatchParameter { readonly name: string; readonly value: number }
export interface BatchSet {
  readonly name: string;
  /** Sorted by name, unique; an empty set runs the scenario as it stands, for comparison. */
  readonly parameters: readonly BatchParameter[];
}
/** What every run of the batch has in common. The recording setup is the Logging tab's when the batch starts, and the record of each run holds it. */
export interface BatchScenario {
  /** The aircraft profile version. */
  readonly profileSha256: string;
  /** The flight task's version. */
  readonly flightTaskSha256: string;
  readonly firmwareId: string;
  readonly speedup: number;
  readonly physicsHz: 800 | 1200;
  readonly home: readonly [number, number, number, number];
}
export type BatchRun =
  | { readonly setIndex: number; readonly state: 'done'; readonly experimentSha256: string }
  /** The experiment record is null when the run failed before it had one. A failed run is recorded, and is never retried. */
  | { readonly setIndex: number; readonly state: 'failed'; readonly experimentSha256: string | null; readonly reason: string };
export interface ExperimentBatch {
  readonly schemaVersion: typeof BATCH_SCHEMA_VERSION;
  readonly scenario: BatchScenario;
  readonly sets: readonly BatchSet[];
  /** In run order; at most one per set. */
  readonly runs: readonly BatchRun[];
  /** Why the batch stopped before its last set; null while it runs or when it ran them all. */
  readonly stopped: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function fail(message: string): never { throw new Error(`Invalid experiment batch: ${message}`); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(value).filter(key => !keys.includes(key)), missing = keys.filter(key => !(key in value));
  if (extra.length > 0 || missing.length > 0) fail(`${what} must hold exactly ${keys.join(', ')}`);
}
const sha = (value: unknown, what: string): string => (typeof value === 'string' && SHA256_HEX.test(value) ? value : fail(`${what} must be a SHA-256`));
const text = (value: unknown, what: string): string => (typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : fail(`${what} must be text of 1 to ${MAX_TEXT} characters`));

function setOf(value: unknown, index: number): BatchSet {
  const what = `set ${index + 1}`;
  if (!isRecord(value)) fail(`${what} is not an object`);
  exactKeys(value, ['name', 'parameters'], what);
  const entries = value.parameters;
  if (!Array.isArray(entries) || entries.length > MAX_BATCH_SET_PARAMETERS) fail(`${what} holds at most ${MAX_BATCH_SET_PARAMETERS} parameters`);
  const raw: readonly unknown[] = entries;
  let previous = '';
  const parameters = raw.map((entry): BatchParameter => {
    if (!isRecord(entry)) fail(`${what}: a parameter is not an object`);
    exactKeys(entry, ['name', 'value'], `${what}: a parameter`);
    const { name, value: number } = entry;
    if (typeof name !== 'string' || !PARAMETER_NAME.test(name)) fail(`${what}: a parameter has an invalid name`);
    if (name <= previous) fail(`${what}: parameters must be sorted by name, each once`);
    previous = name;
    if (typeof number !== 'number' || !Number.isFinite(number)) fail(`${what}: ${name} must be a finite number`);
    return { name, value: number };
  });
  return { name: text(value.name, `${what} name`), parameters };
}
/** A value as a batch record, or the reason it is not one. */
export function validateExperimentBatch(input: unknown): ExperimentBatch {
  if (!isRecord(input)) fail('not an object');
  exactKeys(input, ['schemaVersion', 'scenario', 'sets', 'runs', 'stopped'], 'the batch');
  if (input.schemaVersion !== BATCH_SCHEMA_VERSION) fail(`schema version must be ${BATCH_SCHEMA_VERSION}`);
  const s = input.scenario;
  if (!isRecord(s)) fail('the scenario is not an object');
  exactKeys(s, ['profileSha256', 'flightTaskSha256', 'firmwareId', 'speedup', 'physicsHz', 'home'], 'the scenario');
  if (typeof s.speedup !== 'number' || !(s.speedup > 0)) fail('the speed must be above 0');
  if (s.physicsHz !== 800 && s.physicsHz !== 1200) fail('the physics rate must be 800 or 1200 Hz');
  const home: unknown = s.home;
  if (!Array.isArray(home) || home.length !== 4 || !home.every(item => typeof item === 'number' && Number.isFinite(item))) fail('the home must be four numbers');
  const [latitudeDeg, longitudeDeg, altitudeM, headingDeg] = home as [number, number, number, number];
  const scenario: BatchScenario = { profileSha256: sha(s.profileSha256, 'the profile'), flightTaskSha256: sha(s.flightTaskSha256, 'the flight task'), firmwareId: text(s.firmwareId, 'the build'), speedup: s.speedup, physicsHz: s.physicsHz, home: [latitudeDeg, longitudeDeg, altitudeM, headingDeg] };
  const rawSets: unknown = input.sets;
  if (!Array.isArray(rawSets) || rawSets.length < 1 || rawSets.length > MAX_BATCH_SETS) fail(`a batch holds 1 to ${MAX_BATCH_SETS} sets`);
  const sets = (rawSets as readonly unknown[]).map(setOf);
  if (new Set(sets.map(set => set.name)).size !== sets.length) fail('each set needs its own name');
  const rawRuns: unknown = input.runs;
  if (!Array.isArray(rawRuns)) fail('the runs must be a list');
  const seen = new Set<number>();
  const runs = (rawRuns as readonly unknown[]).map((run): BatchRun => {
    if (!isRecord(run)) fail('a run is not an object');
    const { setIndex, state } = run;
    if (typeof setIndex !== 'number' || !Number.isInteger(setIndex) || setIndex < 0 || setIndex >= sets.length) fail('a run must name one of the sets');
    if (seen.has(setIndex)) fail(`set ${setIndex + 1} ran twice: a batch runs each set once and never retries one`);
    seen.add(setIndex);
    if (state === 'done') {
      exactKeys(run, ['setIndex', 'state', 'experimentSha256'], 'a finished run');
      return { setIndex, state, experimentSha256: sha(run.experimentSha256, 'a run\'s experiment') };
    }
    if (state !== 'failed') fail('a run is done or failed');
    exactKeys(run, ['setIndex', 'state', 'experimentSha256', 'reason'], 'a failed run');
    return { setIndex, state, experimentSha256: run.experimentSha256 === null ? null : sha(run.experimentSha256, 'a run\'s experiment'), reason: text(run.reason, 'a failed run\'s reason') };
  });
  if (input.stopped !== null && typeof input.stopped !== 'string') fail('why it stopped must be text or null');
  return { schemaVersion: BATCH_SCHEMA_VERSION, scenario, sets, runs, stopped: input.stopped };
}
/** The record's dependencies: its aircraft profile and the experiments so far; a task is named as data, as an experiment names one. */
export function batchDependencies(batch: ExperimentBatch): string[] {
  const experiments = batch.runs.flatMap(run => (run.experimentSha256 === null ? [] : [run.experimentSha256]));
  return [...new Set([batch.scenario.profileSha256, ...experiments])].sort();
}
/** The set a batch runs next, or null when it has run them all or was stopped. Runs go in the order given. */
export function nextSetIndex(batch: ExperimentBatch): number | null {
  if (batch.stopped !== null) return null;
  return batch.runs.length < batch.sets.length ? batch.runs.length : null;
}
export function readExperimentBatch(stored: StoredVersion): ExperimentBatch {
  if (stored.record.kind !== 'experiment-batch') throw new Error(`Record ${stored.sha256} is of kind ${stored.record.kind}, not an experiment batch`);
  return validateExperimentBatch(stored.record.payload);
}
