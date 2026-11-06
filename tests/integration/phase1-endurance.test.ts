import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ENDURANCE_RUN_SCHEMA, judgeEndurance, parseEnduranceRun, writeEnduranceCell, type EnduranceRun,
} from '../../scripts/phase1/endurance-rules';
import { WORKFLOWS, judgeWorkflow, playwrightCounts, vitestCounts, writeGlobalCell, type ToolRun } from '../../scripts/phase1/global-rules';

// TASK-189: the judgement of the 16-motor hour, on run files written here. A run that met every limit passes; each way of missing one
// fails by name, and none is hidden. The rate itself is reported and never judged (A-05).
const passing: EnduranceRun = {
  schema: ENDURANCE_RUN_SCHEMA, configuration: 'octo-paired-16', startedAt: '2026-11-06T00:00:00.000Z', finishedAt: '2026-11-06T00:20:00.000Z',
  chrome: '156.0.0.0', profileSha256: 'a'.repeat(64), experimentSha256: 'b'.repeat(64), physicsHz: 800,
  workload: { routePoints: 49, sideM: 500, speedMps: 6, altitudeM: 20, batteryCapacityAh: 120, weather: ['Mean wind: 3.0 m/s from 270°', 'Synthetic gust: 1.0 m/s RMS, 1.00 Hz, seed 7'] },
  rate: { mode: 'as-fast-as-possible', averageRatio: 3.1, simElapsedS: 3605, runningWallS: 1163, executedHz: 2480, droppedIntervals: 0, steps: 2884000, lost: 0, resent: 0, held: 0 },
  stage: 'running', failure: null, pauses: 0, accidents: 0,
  recording: { status: 'closed', bytes: 1.2e9, chunks: 18000, droppedChunks: 0, droppedRows: 0, producerLost: 0, durationS: 3610,
    rows: { 'truth.position': 180500, 'motors.speed': 180500, battery: 180500, 'truth.contact': 180500 },
    rates: { 'truth.position': 50, 'motors.speed': 50, battery: 50, 'truth.contact': 50 } },
  memory: { samples: 40, peakBytes: 3e9, lastBytes: 2.5e9 },
  flight: { samples: 60, minimumAltitudeM: 19.2, maximumAltitudeM: 20.9, taskState: 'running', armed: true, stateOfCharge: 0.42 },
};
const failing = (change: Partial<EnduranceRun>) => judgeEndurance({ ...passing, ...change });
const recording = (change: Partial<EnduranceRun['recording']>) => failing({ recording: { ...passing.recording, ...change } });

describe('the 16-motor hour', () => {
  it('passes a run that met every limit, whatever its rate', () => {
    expect(judgeEndurance(passing)).toEqual({ verdict: 'PASS', reasons: [] });
    expect(failing({ rate: { ...passing.rate, averageRatio: 0.4, runningWallS: 9000 } }).verdict).toBe('PASS');
  });
  it.each<[string, EnduranceRun | ReturnType<typeof failing>, RegExp]>([
    ['a short hour', failing({ rate: { ...passing.rate, simElapsedS: 3599 } }), /3599\.0 s of simulated time/],
    ['a run that failed', failing({ failure: 'SITL ended in flight', stage: 'failed' }), /The run failed: SITL ended in flight/],
    ['a pause', failing({ pauses: 1 }), /paused 1 times/],
    ['an accident', failing({ accidents: 2 }), /2 accidents/],
    ['another physics rate', failing({ physicsHz: 400 }), /400 Hz, not 800 Hz/],
    ['lost lockstep frames', failing({ rate: { ...passing.rate, lost: 3 } }), /3 lockstep frames/],
    ['no gusts', failing({ workload: { ...passing.workload, weather: ['Mean wind: 3.0 m/s from 270°'] } }), /not wind and repeatable gusts/],
    ['an open recording', recording({ status: 'recording' }), /is recording, not closed/],
    ['dropped chunks', recording({ droppedChunks: 1, droppedRows: 900 }), /dropped 1 chunks and 900 rows/],
    ['rows lost at the producer', recording({ producerLost: 12 }), /lost 12 rows at the producer/],
    ['a short recording', recording({ durationS: 3000 }), /holds 3000\.0 s/],
    ['a gap in one signal', recording({ rows: { ...passing.recording.rows, battery: 100000 } }), /battery kept 100000 rows of about 180500/],
    ['a signal above the default rate', recording({ rates: { ...passing.recording.rates, battery: 100 } }), /battery is planned at 100 Hz/],
    ['a missing contact signal', recording({ rates: { 'truth.position': 50, 'motors.speed': 50, battery: 50 } }), /truth\.contact is not in the recording's plan/],
    ['over the storage budget', recording({ bytes: 2.5e9 }), /2\.49 GB per simulated hour/],
    ['over the memory budget', failing({ memory: { samples: 40, peakBytes: 8.2e9, lastBytes: 2e9 } }), /8\.20 GB, over A-12/],
    ['no memory samples', failing({ memory: { samples: 0, peakBytes: 0, lastBytes: 0 } }), /memory was not sampled/],
    ['no flight samples', failing({ flight: { ...passing.flight, samples: 0 } }), /flight was not sampled/],
    ['a landing before the hour was over', failing({ flight: { ...passing.flight, minimumAltitudeM: 0.1 } }), /altitude went from 0\.1 m/],
    ['a climb away', failing({ flight: { ...passing.flight, maximumAltitudeM: 45 } }), /to 45\.0 m/],
    ['a circuit that ended early', failing({ flight: { ...passing.flight, taskState: 'done' } }), /flight task was done/],
    ['a disarmed aircraft', failing({ flight: { ...passing.flight, armed: false } }), /disarmed/],
    ['an empty battery', failing({ flight: { ...passing.flight, stateOfCharge: 0.01 } }), /battery was at 1\.0 %/],
  ])('fails %s, by name', (_name, judged, reason) => {
    expect('verdict' in judged && judged.verdict).toBe('FAIL');
    expect('reasons' in judged ? judged.reasons.join('; ') : '').toMatch(reason);
  });
  it('refuses a run file of another schema or configuration, or missing a part', () => {
    expect(parseEnduranceRun(JSON.parse(JSON.stringify(passing)))).toEqual(passing);
    expect(() => parseEnduranceRun({ ...passing, schema: 'other' })).toThrow('is not');
    expect(() => parseEnduranceRun({ ...passing, configuration: 'quad' })).toThrow('is of quad');
    expect(() => parseEnduranceRun({ ...passing, recording: null })).toThrow('no recording');
    expect(() => parseEnduranceRun({ ...passing, flight: null })).toThrow('no flight');
    expect(() => parseEnduranceRun({ ...passing, stage: 3 })).toThrow('no stage');
  });
  it('writes only its own cell of the matrix, citing the report', () => {
    const other = { configuration: 'quad', workflow: 'start', verdict: 'PASS', evidence: null };
    const cell = { configuration: 'octo-paired-16', workflow: 'one-hour-recording', verdict: 'NOT_RUN', evidence: null };
    const matrix = { schemaVersion: 1, task: 'TASK-132', cells: [other, cell] }, evidence = { path: 'report.json', sha256: 'c'.repeat(64) };
    expect(writeEnduranceCell(matrix, 'FAIL', evidence)).toEqual({ schemaVersion: 1, task: 'TASK-132',
      cells: [other, { configuration: 'octo-paired-16', workflow: 'one-hour-recording', verdict: 'FAIL', evidence }] });
    expect(() => writeEnduranceCell({ ...matrix, cells: [other] }, 'PASS', evidence)).toThrow('0 cells');
    expect(() => writeEnduranceCell(matrix, 'PASS', { path: 'x', sha256: 'short' })).toThrow('no SHA-256');
  });
});

describe('the global workflows (TASK-190)', () => {
  const run = (change: Partial<ToolRun> = {}): ToolRun => ({ tool: 'playwright', status: 0, passed: 3, failed: 0, skipped: 0, ...change });
  it('passes only what ran, whole', () => {
    expect(judgeWorkflow([run(), run({ tool: 'vitest' })])).toEqual({ verdict: 'PASS', reasons: [] });
    expect(judgeWorkflow([]).reasons).toEqual(['Nothing ran']);
    expect(judgeWorkflow([run({ status: 1 })]).reasons).toEqual(['playwright exited 1']);
    expect(judgeWorkflow([run({ status: null })]).reasons).toEqual(['playwright exited null']);
    expect(judgeWorkflow([run({ failed: 2 })]).reasons).toEqual(['playwright failed 2']);
    // A skipped test proves nothing, and a run of nothing even less.
    expect(judgeWorkflow([run({ skipped: 1 })]).verdict).toBe('FAIL');
    expect(judgeWorkflow([run({ passed: 0 })]).reasons).toEqual(['playwright passed nothing']);
  });
  it('reads the tools\' own reports', () => {
    expect(vitestCounts({ numPassedTests: 5, numFailedTests: 1, numPendingTests: 2, numTodoTests: 1,
      testResults: [{ assertionResults: [{ status: 'passed', fullName: 'a' }, { status: 'failed', fullName: 'b' }] }] })).toEqual({ passed: 5, failed: 1, skipped: 3, notPassed: ['failed: b'] });
    expect(playwrightCounts({ stats: { expected: 4, unexpected: 1, flaky: 1, skipped: 2 }, suites: [{ specs: [{ title: 'a', ok: true, tests: [{ status: 'expected' }] }, { title: 'b', ok: false, tests: [] }],
      suites: [{ specs: [{ title: 'c', ok: true, tests: [{ status: 'skipped' }] }] }] }] })).toEqual({ passed: 4, failed: 2, skipped: 2, notPassed: ['failed: b', 'skipped: c'] });
    expect(vitestCounts(null)).toEqual({ passed: 0, failed: 0, skipped: 0, notPassed: [] });
    expect(playwrightCounts(null)).toEqual({ passed: 0, failed: 0, skipped: 0, notPassed: [] });
  });
  it('names a real file for every test, and a cell for every workflow in the matrix', () => {
    const matrix = JSON.parse(readFileSync('docs/validation/phase1-matrix.json', 'utf8')) as { workflows: { id: string; appliesTo: unknown }[] };
    const declared = matrix.workflows.filter(item => item.appliesTo === 'global').map(item => item.id);
    expect(WORKFLOWS.map(item => item.id).sort()).toEqual([...declared].sort());
    for (const workflow of WORKFLOWS) for (const path of [...workflow.vitest, ...workflow.playwright]) expect(existsSync(path), path).toBe(true);
  });
  it('writes only its own cell of the matrix, citing the report', () => {
    const other = { configuration: 'quad', workflow: 'start', verdict: 'PASS', evidence: null };
    const cell = { configuration: null, workflow: 'comparisons', verdict: 'NOT_RUN', evidence: null };
    const evidence = { path: 'report.json', sha256: 'c'.repeat(64) };
    expect(writeGlobalCell({ schemaVersion: 1, cells: [other, cell] }, 'comparisons', 'PASS', evidence)).toEqual({ schemaVersion: 1,
      cells: [other, { configuration: null, workflow: 'comparisons', verdict: 'PASS', evidence }] });
    expect(() => writeGlobalCell({ schemaVersion: 1, cells: [other] }, 'comparisons', 'PASS', evidence)).toThrow('0 cells');
  });
});
