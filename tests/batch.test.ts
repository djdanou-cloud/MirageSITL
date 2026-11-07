import { describe, expect, test } from 'vitest';
import { BatchRunner, type BatchPorts, type RunObservation } from '../apps/web/src/experiments/batch-runner.ts';
import { batchSetOfText } from '../apps/web/src/experiments/batch-form.ts';
import { MAX_BATCH_SETS, batchDependencies, nextSetIndex, readExperimentBatch, validateExperimentBatch, type BatchSet, type ExperimentBatch } from '@mirage/project/batch';
import { MemoryBackend, ProjectStore } from '@mirage/project/store';

// A batch: one scenario, once for each set the user supplied, in order, with a failed run recorded and never retried. The run is
// scripted here, its views written out; the real runs are in tests/browser/batch.spec.ts.

const SHA = (digit: string) => digit.repeat(64);
const SCENARIO = { profileSha256: SHA('a'), flightTaskSha256: SHA('b'), firmwareId: 'arducopter-fb773567', speedup: 4, physicsHz: 800 as const, home: [-35.363261, 149.16523, 584, 0] as const };
const set = (name: string, value = 1): BatchSet => ({ name, parameters: [{ name: 'ATC_ANG_RLL_P', value }] });
const batchOf = (sets: readonly BatchSet[]): ExperimentBatch => ({ schemaVersion: 1, scenario: SCENARIO, sets, runs: [], stopped: null });
const observe = (state: RunObservation['state'], edit: Partial<RunObservation> = {}): RunObservation => ({ state, failure: null, task: null, accident: false, recordSha256: null, ...edit });

/** Records what the batch asked of the run. */
class Script implements BatchPorts {
  readonly started: BatchSet[] = [];
  readonly saves: ExperimentBatch[] = [];
  flown = 0; stops = 0;
  /** What each start in turn answers; none left means it starts. */
  startRefusals: (string | null)[] = []; flyRefusal: string | null = null;
  start(next: BatchSet): Promise<string | null> { this.started.push(next); return Promise.resolve(this.startRefusals.shift() ?? null); }
  runTask(): string | null { if (this.flyRefusal === null) this.flown++; return this.flyRefusal; }
  stop(): Promise<void> { this.stops++; return Promise.resolve(); }
  save(batch: ExperimentBatch): Promise<void> { this.saves.push(batch); return Promise.resolve(); }
  current(): RunObservation | null { return null; }
}
const tick = () => new Promise(done => setTimeout(done, 0));
/** One run that goes well, up to its stop. */
async function flyWell(runner: BatchRunner, record: string): Promise<void> {
  await tick();
  runner.observe(observe('starting'));
  runner.observe(observe('warming', { recordSha256: record }));
  runner.observe(observe('ready', { recordSha256: record, task: { state: 'waiting', reason: null } }));
  runner.observe(observe('running', { recordSha256: record, task: { state: 'running', reason: null } }));
  runner.observe(observe('ready', { recordSha256: record, task: { state: 'done', reason: null } }));
  runner.observe(observe('idle', { recordSha256: record, task: { state: 'done', reason: null } }));
  await tick();
}

describe('a batch runs the sets it was given', () => {
  test('N sets give N experiments, in the order given, each set once', async () => {
    const script = new Script(), sets = [set('A', 1), set('B', 2), set('C', 3)], runner = new BatchRunner(batchOf(sets), script);
    runner.begin();
    await flyWell(runner, SHA('1')); await flyWell(runner, SHA('2')); await flyWell(runner, SHA('3'));
    await runner.settled();
    expect(script.started).toEqual(sets);
    expect(script.flown).toBe(3);
    expect(script.stops).toBe(3);
    expect(runner.state).toBe('finished');
    expect(runner.batch.runs).toEqual([{ setIndex: 0, state: 'done', experimentSha256: SHA('1') }, { setIndex: 1, state: 'done', experimentSha256: SHA('2') }, { setIndex: 2, state: 'done', experimentSha256: SHA('3') }]);
    expect(runner.batch.stopped).toBeNull();
  });
  test('it stores the batch after each run, so a closed page keeps what finished', async () => {
    const script = new Script(), runner = new BatchRunner(batchOf([set('A'), set('B')]), script);
    runner.begin();
    await flyWell(runner, SHA('1'));
    await runner.settled();
    expect(script.saves.at(-1)?.runs).toHaveLength(1);
    await flyWell(runner, SHA('2'));
    await runner.settled();
    expect(script.saves.at(-1)?.runs).toHaveLength(2);
  });
  test('it never changes a set, and nothing it reads of a result chooses what runs next', async () => {
    const script = new Script(), sets = [set('A', 1), set('B', 2)], frozen = structuredClone(sets), runner = new BatchRunner(batchOf(sets), script);
    runner.begin();
    await flyWell(runner, SHA('1')); await flyWell(runner, SHA('2'));
    expect(script.started).toEqual(frozen);
    expect(runner.batch.sets).toEqual(frozen);
  });
});

describe('one failed run does not take the others with it', () => {
  async function secondFails(fail: (runner: BatchRunner) => void, expected: Record<string, unknown>) {
    const script = new Script(), runner = new BatchRunner(batchOf([set('A'), set('B'), set('C')]), script);
    runner.begin();
    await flyWell(runner, SHA('1'));
    await tick();
    fail(runner);
    await tick();
    await flyWell(runner, SHA('3'));
    await runner.settled();
    // Never retried: each set started once.
    expect(script.started.map(item => item.name)).toEqual(['A', 'B', 'C']);
    expect(runner.batch.runs[0]).toMatchObject({ state: 'done', experimentSha256: SHA('1') });
    expect(runner.batch.runs[1]).toEqual({ setIndex: 1, ...expected });
    expect(runner.batch.runs[2]).toMatchObject({ state: 'done', experimentSha256: SHA('3') });
    expect(runner.state).toBe('finished');
  }
  test('a run that fails while starting, with no record yet', () => secondFails(runner => {
    runner.observe(observe('starting'));
    runner.observe(observe('failed', { failure: 'ArduPilot did not confirm the initial parameters: NO_SUCH_PARAM' }));
  }, { state: 'failed', experimentSha256: null, reason: 'ArduPilot did not confirm the initial parameters: NO_SUCH_PARAM' }));
  test('a run that fails in flight, with its record', () => secondFails(runner => {
    runner.observe(observe('ready', { recordSha256: SHA('2') }));
    runner.observe(observe('running', { recordSha256: SHA('2') }));
    runner.observe(observe('failed', { recordSha256: SHA('2'), failure: 'The SITL exited' }));
  }, { state: 'failed', experimentSha256: SHA('2'), reason: 'The SITL exited' }));
  test('a task that ends early is stopped and recorded with its reason', () => secondFails(runner => {
    runner.observe(observe('ready', { recordSha256: SHA('2') }));
    runner.observe(observe('running', { recordSha256: SHA('2'), task: { state: 'failed', reason: 'The takeoff stage did not finish within 65 s of simulated time' } }));
    runner.observe(observe('idle', { recordSha256: SHA('2') }));
  }, { state: 'failed', experimentSha256: SHA('2'), reason: 'The takeoff stage did not finish within 65 s of simulated time' }));
  test('an accident ends that run', () => secondFails(runner => {
    runner.observe(observe('ready', { recordSha256: SHA('2') }));
    runner.observe(observe('paused', { recordSha256: SHA('2'), accident: true }));
    runner.observe(observe('idle', { recordSha256: SHA('2') }));
  }, { state: 'failed', experimentSha256: SHA('2'), reason: 'An accident paused the run' }));
  test('a task the autopilot refuses is stopped and recorded', async () => {
    const script = new Script(), runner = new BatchRunner(batchOf([set('A')]), script);
    script.flyRefusal = 'ArduPilot reports WP_ACC_Z as 0';
    runner.begin();
    await tick();
    runner.observe(observe('ready', { recordSha256: SHA('1') }));
    runner.observe(observe('idle', { recordSha256: SHA('1') }));
    await tick();
    expect(runner.batch.runs).toEqual([{ setIndex: 0, state: 'failed', experimentSha256: SHA('1'), reason: 'ArduPilot reports WP_ACC_Z as 0' }]);
    expect(script.stops).toBe(1);
  });
  test('a run that cannot begin is that set\'s result, and the next set runs', async () => {
    const script = new Script(), runner = new BatchRunner(batchOf([set('A'), set('B')]), script);
    script.startRefusals = ['The set names FRAME_CLASS, which the aircraft profile sets'];
    runner.begin();
    await flyWell(runner, SHA('2'));
    expect(runner.batch.runs[0]).toEqual({ setIndex: 0, state: 'failed', experimentSha256: null, reason: 'The set names FRAME_CLASS, which the aircraft profile sets' });
    expect(runner.batch.runs[1]).toMatchObject({ state: 'done' });
  });
});

describe('stopping a batch', () => {
  test('cancelling stops the run under way, records it, and starts nothing more', async () => {
    const script = new Script(), runner = new BatchRunner(batchOf([set('A'), set('B')]), script);
    runner.begin();
    await tick();
    runner.observe(observe('ready', { recordSha256: SHA('1') }));
    runner.cancel('You stopped the batch');
    runner.observe(observe('idle', { recordSha256: SHA('1') }));
    await tick();
    await runner.settled();
    expect(runner.state).toBe('finished');
    expect(script.started).toHaveLength(1);
    expect(runner.batch.stopped).toBe('You stopped the batch');
    expect(runner.batch.runs).toEqual([{ setIndex: 0, state: 'failed', experimentSha256: SHA('1'), reason: 'You stopped the batch' }]);
  });
  test('a run stopped on the Run tab stops the batch, rather than start another under the user', async () => {
    const script = new Script(), runner = new BatchRunner(batchOf([set('A'), set('B')]), script);
    runner.begin();
    await tick();
    runner.observe(observe('running', { recordSha256: SHA('1') }));
    runner.observe(observe('ready', { recordSha256: SHA('1') }));
    runner.observe(observe('idle', { recordSha256: SHA('1') }));
    await tick();
    expect(script.started).toHaveLength(1);
    expect(runner.batch.stopped).toContain('stopped on the Run tab');
    expect(runner.state).toBe('finished');
  });
  test('a run\'s stop finishing ends it, even if no view ever says so again', async () => {
    const script = new Script(), runner = new BatchRunner(batchOf([set('A')]), script);
    runner.begin();
    await tick();
    runner.observe(observe('ready', { recordSha256: SHA('1') }));
    runner.observe(observe('running', { recordSha256: SHA('1'), task: { state: 'done', reason: null } }));
    await tick();
    expect(runner.state).toBe('finished');
    expect(runner.batch.runs).toEqual([{ setIndex: 0, state: 'done', experimentSha256: SHA('1') }]);
  });
  test('a stop that fails is that run\'s result', async () => {
    const script = new Script(), runner = new BatchRunner(batchOf([set('A')]), script);
    script.stop = () => Promise.reject(new Error('The launcher did not answer'));
    runner.begin();
    await tick();
    runner.observe(observe('ready', { recordSha256: SHA('1') }));
    runner.observe(observe('running', { recordSha256: SHA('1'), task: { state: 'done', reason: null } }));
    await tick();
    expect(runner.batch.runs).toEqual([{ setIndex: 0, state: 'failed', experimentSha256: SHA('1'), reason: 'The run could not be stopped: The launcher did not answer' }]);
  });
  test('the view of the last run does not count while a start is on its way', async () => {
    const script = new Script(), runner = new BatchRunner(batchOf([set('A'), set('B')]), script);
    let release: (answer: string | null) => void = () => undefined;
    runner.begin();
    await tick();
    script.start = next => { script.started.push(next); return new Promise(done => { release = done; }); };
    runner.observe(observe('ready', { recordSha256: SHA('1') }));
    runner.observe(observe('running', { recordSha256: SHA('1'), task: { state: 'done', reason: null } }));
    await tick();
    // The second start is on its way and the last run's session has not been replaced: it fails late, after it was recorded.
    expect(script.started).toHaveLength(2);
    runner.observe(observe('failed', { failure: 'A late failure of the last run', recordSha256: SHA('1') }));
    expect(runner.batch.runs).toHaveLength(1);
    release(null);
    await flyWell(runner, SHA('2'));
    expect(runner.batch.runs[1]).toMatchObject({ state: 'done', experimentSha256: SHA('2') });
  });
  test('the idle view of a fresh session before its start does not read as stopped', async () => {
    const script = new Script(), runner = new BatchRunner(batchOf([set('A')]), script);
    runner.begin();
    await tick();
    runner.observe(observe('idle'));
    expect(runner.batch.runs).toEqual([]);
    expect(runner.state).toBe('starting');
  });
});

describe('the batch record', () => {
  const valid = (): ExperimentBatch => ({ ...batchOf([set('A'), set('B')]), runs: [{ setIndex: 0, state: 'done', experimentSha256: SHA('1') }, { setIndex: 1, state: 'failed', experimentSha256: null, reason: 'It failed' }] });
  test('round trips, and depends on its profile and its experiments', () => {
    expect(validateExperimentBatch(structuredClone(valid()))).toEqual(valid());
    expect(batchDependencies(valid())).toEqual([SHA('1'), SHA('a')]);
  });
  test('the next set is the first without a run, in order', () => {
    expect(nextSetIndex(batchOf([set('A'), set('B')]))).toBe(0);
    expect(nextSetIndex({ ...batchOf([set('A'), set('B')]), runs: [{ setIndex: 0, state: 'done', experimentSha256: SHA('1') }] })).toBe(1);
    expect(nextSetIndex(valid())).toBeNull();
    expect(nextSetIndex({ ...batchOf([set('A')]), stopped: 'Stopped' })).toBeNull();
  });
  test.each([
    ['no sets', { sets: [] }, '1 to'],
    ['too many sets', { sets: Array.from({ length: MAX_BATCH_SETS + 1 }, (_, i) => set(`S${i}`)) }, '1 to'],
    ['two sets of one name', { sets: [set('A'), set('A')] }, 'its own name'],
    ['a set run twice', { runs: [{ setIndex: 0, state: 'done', experimentSha256: SHA('1') }, { setIndex: 0, state: 'failed', experimentSha256: null, reason: 'Again' }] }, 'never retries'],
    ['a run of no set', { runs: [{ setIndex: 5, state: 'done', experimentSha256: SHA('1') }] }, 'one of the sets'],
    ['a failure with no reason', { runs: [{ setIndex: 0, state: 'failed', experimentSha256: null, reason: '' }] }, 'reason'],
    ['an unsorted set', { sets: [{ name: 'A', parameters: [{ name: 'B', value: 1 }, { name: 'A', value: 1 }] }] }, 'sorted'],
    ['a value that is no number', { sets: [{ name: 'A', parameters: [{ name: 'A', value: null }] }] }, 'finite'],
    ['an unknown field', { objective: 'lowest current' }, 'exactly'],
  ])('refuses %s', (_label, edit, reason) => {
    expect(() => validateExperimentBatch({ ...batchOf([set('A')]), ...edit })).toThrow(reason);
  });
});

describe('the batch in the project store', () => {
  test('is a versioned item: a new version after each run, and the first stays as it was', async () => {
    const store = new ProjectStore(new MemoryBackend(), { storage: null, validators: { 'experiment-batch': validateExperimentBatch } });
    const project = await store.createProject('Batches');
    const first = batchOf([set('A'), set('B')]);
    const stored = await store.createItem(project.record.id, 'experiment-batch', { name: 'A batch', payload: first, dependencies: [] });
    const next = await store.saveVersion(stored.record.id, stored.sha256, { name: 'A batch', payload: { ...first, runs: [{ setIndex: 0, state: 'failed', experimentSha256: null, reason: 'It failed' }] }, dependencies: [] });
    expect(next.record.version).toBe(2);
    expect(readExperimentBatch(await store.get(stored.sha256)).runs).toEqual([]);
    const listed = await store.listItems(project.record.id, 'experiment-batch');
    expect(listed.map(item => item.record.version)).toEqual([2]);
    expect(readExperimentBatch(listed[0] as (typeof listed)[number]).runs).toHaveLength(1);
    await expect(store.createItem(project.record.id, 'experiment-batch', { name: 'Not a batch', payload: { objective: 'lowest current' }, dependencies: [] })).rejects.toThrow('Invalid experiment batch');
  });
});

describe('a set as the user types it', () => {
  const OWNED = new Set(['FRAME_CLASS', 'SERVO1_FUNCTION', 'COMPASS_DEC']);
  test('reads a parameter file\'s lines, sorted by name', () => {
    expect(batchSetOfText('Softer', '# a comment\nATC_RAT_RLL_P, 0.1\nATC_ANG_RLL_P 4.5\n', OWNED)).toEqual({ set: { name: 'Softer', parameters: [{ name: 'ATC_ANG_RLL_P', value: 4.5 }, { name: 'ATC_RAT_RLL_P', value: expect.closeTo(0.1, 6) as number }] }, problem: null });
  });
  test('an empty set is the scenario as it stands, for comparison', () => {
    expect(batchSetOfText('As it stands', '', OWNED)).toEqual({ set: { name: 'As it stands', parameters: [] }, problem: null });
  });
  test('a name is needed', () => {
    expect(batchSetOfText('  ', 'A 1', OWNED).problem).toContain('name');
  });
  test('a line it cannot read says which', () => {
    expect(batchSetOfText('Bad', 'ATC_ANG_RLL_P 1\nnot a number here\n', OWNED).problem).toContain('2');
  });
  test('a parameter the aircraft profile sets is refused, by name', () => {
    expect(batchSetOfText('Frame', 'FRAME_CLASS 2\n', OWNED).problem).toContain('FRAME_CLASS');
    expect(batchSetOfText('Frame', 'FRAME_CLASS 2\n', OWNED).set).toBeNull();
  });
});
