import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDataFlash } from '@mirage/dataflash/reader';
import {
  CRITERIA, NOMINAL_CONFIGURATIONS, NOMINAL_WORKFLOWS, RUN_SCHEMA, STOCK_SETTINGS, acceptanceMachineReasons, judgeRun, parseNominalRun, steadinessOf, writeNominalCells,
  type NominalRun, type StepId,
} from '../../scripts/phase1/nominal-rules.ts';

// TASK-158: the rules that turn a nominal acceptance run's facts into matrix
// verdicts. Oracle: a run written out here by hand that meets every criterion
// the TASK-158 status declared before the first run, with the steadiness limit
// of decision A-13, and copies of it that each miss one criterion by a stated
// amount; the matrix is the real TASK-132 file, of which only the five TASK-158
// cells of the configuration may change.

const SHA = (digit: string) => digit.repeat(64);
const hold = (readingsM: number[], startSimS = 50) => ({ stage: 'Flying', armed: 'Armed', mode: 'GUIDED', startSimS, endSimS: startSimS + 10.2, readingsM });
const READINGS = [5.04, 5.06, 5.05, 5.07, 5.05];
const rates = (sdDegS: number, peakDegS: number) => ({ sdDegS, peakDegS });
const QUIET = { fromS: 50, toS: 60.2, samples: 102, roll: rates(0.09, 0.3), pitch: rates(0.08, 0.3), yaw: rates(0.03, 0.1) };
/** A quad run that meets every criterion. */
const PASSING = {
  schema: RUN_SCHEMA, configuration: 'quad', settings: 'acceptance', startedAt: '2026-11-03T20:00:00.000Z', finishedAt: '2026-11-03T20:03:00.000Z',
  browser: { version: '156.0.7700.12', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) HeadlessChrome/156.0.7700.12', headless: true,
    renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)' },
  steps: {
    profile: { error: null, facts: {
      cards: ['motor', 'propeller', 'esc', 'battery'].map((type, i) => ({ type, sha256: SHA(String(i + 1)), sourceKind: 'synthetic', differences: [] })),
      sha256: SHA('a'), version: 1, motors: 4, differences: [],
    } },
    mapping: { error: null, facts: { frame: 'Stock frame: FRAME_CLASS 1, FRAME_TYPE 1, 4-channel servo packets.',
      outputs: [1, 2, 3, 4].map(motor => ({ motor, output: motor })) } },
    refusal: { error: null, facts: { problems: ['Output 1 is assigned to motors 1 and 4.'], saveDisabled: true, layoutErrors: ['The layout needs 1 to 8 arms.'], versions: 1 } },
    start: { error: null, facts: {
      ready: 'READY', readyAtSimS: 41.1, recordSha256: SHA('b'), profileSha256: SHA('a'), physicsHz: 800, clockMode: 'sitl-lockstep', speedup: 1,
      firmware: { id: 'arducopter-fb773567', firmwareVersion: 'ArduCopter V4.7.2', commit: 'fb773567896014da007bca58358704d4a0d8516f',
        binarySha256: SHA('c'), defaultParametersSha256: SHA('d') },
      hashed: { binarySha256: SHA('c'), defaultParametersSha256: SHA('d') },
    } },
    // The quad's one tuned setting (decision of 2026-11-04), typed into the Parameters tab after READY.
    tuning: { error: null, facts: { writes: [{ name: 'INS_GYRO_FILTER', value: 40, outcome: 'confirmed', rebootRequired: false, shown: '40' }] } },
    parameters: { error: null, facts: { writes: [{ name: 'RTL_ALT_FINAL_M', value: 1, outcome: 'confirmed', rebootRequired: false, shown: '1' }] } },
    motorCheck: { error: null, facts: { state: 'passed', summary: 'All 4 motors turn as the profile and ArduPilot\'s frame expect.',
      rows: [[1, 1], [2, 4], [3, 2], [4, 3]].map(([order, motor]) => ({ order, motor, output: motor, pass: true })) } },
    hold: { error: null, facts: hold(READINGS) },
    pause: { error: null, facts: {
      stage: 'paused', before: { simS: 62.3, altitudeM: 5.05, stepped: 49840 }, after: { simS: 62.3, altitudeM: 5.05, stepped: 49840 }, wallS: 31.2,
      resumedStage: 'Flying', resumedAtSimS: 62.6, hold: hold(READINGS, 63), failsafeMessages: [], log: { count: 1, reason: 'user', wallS: 31.4 },
    } },
    landing: { error: null, facts: { mode: 'LAND', armed: 'Disarmed', state: 'ready', ready: 'READY', altitudeM: 0.1, restAltitudeM: 0.1012,
      frames: '81920 stepped, 0 lost, 1 resent, 25 held', failsafeMessages: [] } },
    stop: { error: null, facts: { state: 'idle', text: 'Idle: the run stopped.', launcherState: 'stopped', group: '', members: [], signalZero: 'ESRCH', processes: 0 } },
    reopen: { error: null, facts: { listed: 1, recordId: 'r1', recordingText: '50 Hz common rate, record r1', profileText: 'Quad X, version 1', truthRows: 5000, missingChunks: 0, corruptChunks: 0 } },
  },
  captures: {
    launcherExperimentId: 'e1', dataflash: [{ name: '00000001.BIN', bytes: 1048576, sha256: SHA('e'), status: 'truncated', records: 52000, truncatedBytes: 12,
      firmwareMatchesBuild: true, file: 'quad/00000001.BIN' }],
    recording: { recordId: 'r1', status: 'closed', chunks: 12, bytes: 900000, droppedChunks: 0, droppedRows: 0, producerLost: 0 },
    speed: { verdict: 'Real time', average: 0.998, dropped: 0, simElapsedS: 102.4, runningWallS: 102.6 },
    power: { hover: { voltageV: 15.8, currentA: 13.2, powerW: 208, commandPercent: [41, 41, 41, null] }, limitEvents: [] },
    steadiness: { hold: QUIET, afterResume: QUIET },
    flownSettings: [{ name: 'INS_GYRO_FILTER', value: 40 }, { name: 'ATC_RAT_RLL_P', value: 0.13500000536441803 }, { name: 'ATC_RAT_RLL_I', value: 0.13500000536441803 },
      { name: 'ATC_RAT_RLL_D', value: 0.003599999938160181 }, { name: 'ATC_RAT_PIT_P', value: 0.13500000536441803 }, { name: 'ATC_RAT_PIT_I', value: 0.13500000536441803 },
      { name: 'ATC_RAT_PIT_D', value: 0.003599999938160181 }],
  },
};
type Mutable = Record<string, unknown>;
/** A copy of the passing run with `edit` applied to one step's facts. */
function withFacts(id: StepId, edit: (facts: Mutable) => void): NominalRun {
  const copy = JSON.parse(JSON.stringify(PASSING)) as { steps: Record<string, { facts: Mutable }> };
  const record = copy.steps[id];
  if (!record) throw new Error(`No step ${id}`);
  edit(record.facts);
  return parseNominalRun(copy);
}
const verdicts = (run: NominalRun) => Object.fromEntries(Object.entries(judgeRun(run)).map(([w, v]) => [w, v.verdict]));

describe('the verdicts of a nominal run (TASK-158)', () => {
  it('passes every workflow of a run that meets every criterion', () => {
    const judged = judgeRun(parseNominalRun(PASSING));
    for (const workflow of NOMINAL_WORKFLOWS) expect(judged[workflow], workflow).toEqual({ verdict: 'PASS', reasons: [] });
  });

  it('fails the workflow whose step misses a criterion, by the stated amount, and only that workflow', () => {
    const cases: [StepId, (facts: Mutable) => void, string, RegExp][] = [
      // A reading 0.51 m above the take-off altitude is outside the 0.5 m band; 9.9 s is short of the 10 s hold.
      ['hold', f => { f.readingsM = [5.04, 5.51, 5.05, 5.06]; }, 'flight-task', /1 readings outside 5 ± 0.5 m \(5\.51 m\)/],
      ['hold', f => { f.endSimS = 59.9; }, 'flight-task', /9\.90 s simulated, below 10 s/],
      ['hold', f => { f.readingsM = [5, 5, 5]; }, 'flight-task', /3 readings, below 4/],
      ['hold', f => { f.mode = 'LOITER'; }, 'flight-task', /mode LOITER, not GUIDED/],
      // 7 mm from the rest height is beyond the 6 mm tolerance.
      ['landing', f => { f.altitudeM = 0.1082; }, 'flight-task', /0\.0070 m from the rest height/],
      ['landing', f => { f.frames = '81920 stepped, 2 lost, 1 resent, 25 held'; }, 'flight-task', /2 servo frames lost: 81920 stepped/],
      // One pause allows one resent frame (its boundary frame after Resume, decision D-03); a second is not explained by it.
      ['landing', f => { f.frames = '81920 stepped, 0 lost, 2 resent, 25 held'; }, 'flight-task', /2 frames resent in a run with 1 pauses/],
      ['landing', f => { f.frames = 'None'; }, 'flight-task', /frames: None/],
      ['landing', f => { f.failsafeMessages = ['Battery Failsafe']; }, 'flight-task', /autopilot message: Battery Failsafe/],
      ['pause', f => { f.wallS = 29.9; }, 'pause-resume', /paused 29\.9 s of wall time, below 30 s/],
      ['pause', f => { f.after = { simS: 62.4, altitudeM: 5.05, stepped: 49920 }; }, 'pause-resume', /simS moved while paused: 62\.3 to 62\.4/],
      ['pause', f => { f.resumedAtSimS = 63.4; }, 'pause-resume', /1\.10 s simulated between Pause and Resume/],
      ['pause', f => { f.failsafeMessages = ['GPS Glitch or Compass error']; }, 'pause-resume', /autopilot message: GPS Glitch/],
      ['pause', f => { f.hold = hold([5.04, 4.49, 5.05, 5.06], 63); }, 'pause-resume', /the hold after Resume: 1 readings outside/],
      ['motorCheck', f => { f.rows = [[1, 1], [2, 4], [3, 2], [4, 3]].map(([order, motor]) => ({ order, motor, output: motor, pass: motor !== 2 })); },
        'output-mapping', /motor 2 \(test order 3\) failed/],
      ['motorCheck', f => { f.rows = [[1, 1], [2, 4], [3, 2], [4, 3]].map(([order, motor]) => ({ order, motor, output: motor === 2 ? 3 : motor, pass: true })); },
        'output-mapping', /motor 2 turned on output 3; the Aircraft tab maps it to 2/],
      ['motorCheck', f => { f.state = 'failed'; }, 'output-mapping', /the motor check ended failed/],
      ['mapping', f => { f.outputs = [1, 2, 3, 4].map(motor => ({ motor, output: motor === 4 ? 3 : motor })); }, 'output-mapping', /two motors share an output/],
      ['tuning', f => { f.writes = []; }, 'flight-task', /INS_GYRO_FILTER was not written/],
      ['tuning', f => { f.writes = [{ name: 'INS_GYRO_FILTER', value: 40, outcome: 'refused', rebootRequired: false, shown: '20' }]; }, 'flight-task', /INS_GYRO_FILTER: refused, not confirmed/],
      ['tuning', f => { f.writes = [{ name: 'INS_GYRO_FILTER', value: 40, outcome: 'confirmed', rebootRequired: true, shown: '40' }]; }, 'flight-task', /INS_GYRO_FILTER needs a restart/],
      ['tuning', f => { f.writes = [{ name: 'INS_GYRO_FILTER', value: 40, outcome: 'confirmed', rebootRequired: false, shown: '20' }]; }, 'flight-task', /INS_GYRO_FILTER reads 20, not 40/],
      ['start', f => { f.physicsHz = 400; }, 'start', /physics at 400 Hz, not 800 Hz \(A-04\)/],
      ['start', f => { f.speedup = 4; }, 'start', /speed 4, not real time/],
      ['start', f => { f.profileSha256 = SHA('f'); }, 'start', /another profile version/],
      ['start', f => { f.hashed = { binarySha256: SHA('0'), defaultParametersSha256: SHA('d') }; }, 'start', /another ArduPilot binary/],
      ['stop', f => { f.members = [4242]; f.signalZero = null; }, 'start', /a process of the run is left: group "", members 4242/],
      ['stop', f => { f.launcherState = 'running'; }, 'start', /the launcher reports the run running/],
      ['profile', f => { f.motors = 3; }, 'profile-creation', /3 motors, not 4/],
      ['profile', f => { f.differences = ['fields other than angles differ']; }, 'profile-creation', /the profile: fields other than angles differ/],
      ['profile', f => {
        const cards = f.cards as Mutable[];
        cards[0] = { ...cards[0], differences: ['kvRpmPerV 720 != 700'] };
        cards[1] = { ...cards[1], sourceKind: 'specification' };
      }, 'profile-creation', /the motor card: kvRpmPerV 720 != 700/],
    ];
    for (const [id, edit, workflow, reason] of cases) {
      const judged = judgeRun(withFacts(id, edit));
      expect(judged[workflow as keyof typeof judged].verdict, `${id} → ${workflow}`).toBe('FAIL');
      expect(judged[workflow as keyof typeof judged].reasons.join(' | '), `${id} → ${workflow}`).toMatch(reason);
      // A run that does not stop cleanly also leaves its recording in doubt, so that step stands behind both.
      for (const other of NOMINAL_WORKFLOWS) if (other !== workflow && !(id === 'stop' && other === 'recording')) expect(judged[other].verdict, `${id}: ${other}`).toBe('PASS');
    }
    // The card made with a datasheet source instead of the example's illustrative one also fails.
    expect(judgeRun(withFacts('profile', f => { (f.cards as Mutable[])[3] = { ...(f.cards as Mutable[])[3], sourceKind: 'measured' }; }))['profile-creation'].reasons)
      .toContain("the battery card's source is measured, not illustrative (synthetic)");
  });

  it('fails a step that ended in an error and leaves the steps it never reached NOT_RUN', () => {
    const copy = JSON.parse(JSON.stringify(PASSING)) as { steps: Record<string, unknown> };
    copy.steps.hold = { facts: null, error: 'Timed out waiting for Flying' };
    for (const id of ['pause', 'landing']) copy.steps[id] = null;
    const judged = judgeRun(parseNominalRun(copy));
    expect(judged['flight-task']).toEqual({ verdict: 'FAIL', reasons: ['hold: Timed out waiting for Flying', 'landing not reached: hold failed'] });
    expect(judged['pause-resume']).toEqual({ verdict: 'NOT_RUN', reasons: ['pause not reached: hold failed'] });
    // The stop after a failure still counts for the start workflow.
    expect(verdicts(parseNominalRun(copy))).toEqual({ 'profile-creation': 'PASS', 'output-mapping': 'PASS', start: 'PASS', 'flight-task': 'FAIL', 'pause-resume': 'NOT_RUN',
      'parameter-changes': 'PASS', recording: 'PASS', 'reopen-results': 'PASS', 'unsupported-refusal': 'PASS' });
  });

  it('judges the parameter, recording, reopening and refusal workflows of TASK-188 from their own facts', () => {
    const cases: [StepId, (facts: Mutable) => void, string, RegExp][] = [
      ['refusal', f => { f.problems = ['Arm 1 length is not a decimal number']; }, 'unsupported-refusal', /a repeated output was not refused/],
      ['refusal', f => { f.saveDisabled = false; }, 'unsupported-refusal', /Save stayed enabled/],
      ['refusal', f => { f.layoutErrors = []; }, 'unsupported-refusal', /a ninth arm was not refused/],
      ['refusal', f => { f.versions = 2; }, 'unsupported-refusal', /2 versions of the profile stored/],
      ['parameters', f => { f.writes = []; }, 'parameter-changes', /0 writes, not the one of RTL_ALT_FINAL_M/],
      ['parameters', f => { f.writes = [{ name: 'RTL_ALT_FINAL_M', value: 1, outcome: 'refused', rebootRequired: false, shown: '1' }]; }, 'parameter-changes', /write refused, not confirmed/],
      ['parameters', f => { f.writes = [{ name: 'RTL_ALT_FINAL_M', value: 1, outcome: 'confirmed', rebootRequired: true, shown: '1' }]; }, 'parameter-changes', /needs a restart/],
      ['parameters', f => { f.writes = [{ name: 'RTL_ALT_FINAL_M', value: 1, outcome: 'confirmed', rebootRequired: false, shown: '0' }]; }, 'parameter-changes', /the table shows RTL_ALT_FINAL_M as 0/],
      ['reopen', f => { f.listed = 2; }, 'reopen-results', /2 experiments listed/],
      ['reopen', f => { f.recordingText = 'None'; }, 'reopen-results', /does not name the recording/],
      ['reopen', f => { f.profileText = 'Hexa X, version 1'; }, 'reopen-results', /names another aircraft/],
      ['reopen', f => { f.truthRows = 0; }, 'reopen-results', /no position rows/],
      ['reopen', f => { f.corruptChunks = 1; }, 'reopen-results', /1 corrupt chunks/],
    ];
    for (const [id, edit, workflow, reason] of cases) {
      const judged = judgeRun(withFacts(id, edit));
      expect(judged[workflow as keyof typeof judged].verdict, `${id} → ${workflow}`).toBe('FAIL');
      expect(judged[workflow as keyof typeof judged].reasons.join(' | '), `${id} → ${workflow}`).toMatch(reason);
      for (const other of NOMINAL_WORKFLOWS) if (other !== workflow) expect(judged[other].verdict, `${id}: ${other}`).toBe('PASS');
    }
    // A recording that was not closed, or dropped rows, fails its own workflow by the capture's facts.
    const copy = JSON.parse(JSON.stringify(PASSING)) as { captures: Mutable };
    copy.captures.recording = { ...PASSING.captures.recording, droppedChunks: 1 };
    expect(judgeRun(parseNominalRun(copy)).recording).toEqual({ verdict: 'FAIL', reasons: ['the recording dropped 1 chunks and 0 rows'] });
  });

  it('reports the speed and the power panel without judging them', () => {
    const copy = JSON.parse(JSON.stringify(PASSING)) as { captures: Mutable };
    copy.captures.speed = { verdict: 'Behind real time: it averages 0.300×, below the 0.99× a real-time run needs', average: 0.3, dropped: 359, simElapsedS: 108, runningWallS: 360 };
    copy.captures.power = { hover: { voltageV: 15.1, currentA: 126, powerW: 1900, commandPercent: [61] }, limitEvents: ['Warning 60.21 s battery current above its rating'] };
    for (const verdict of Object.values(judgeRun(parseNominalRun(copy)))) expect(verdict).toEqual({ verdict: 'PASS', reasons: [] });
    copy.captures.speed = null;
    copy.captures.power = null;
    for (const verdict of Object.values(judgeRun(parseNominalRun(copy)))) expect(verdict).toEqual({ verdict: 'PASS', reasons: [] });
  });

  const withCaptures = (edit: (captures: Mutable, run: Mutable) => void) => {
    const copy = JSON.parse(JSON.stringify(PASSING)) as Mutable & { captures: Mutable };
    edit(copy.captures, copy);
    return parseNominalRun(copy);
  };

  it('fails a hold above the steadiness limit of decision A-13, on any axis, and passes one at the limit', () => {
    const onAxis = (axis: string, sdDegS: number) => ({ ...QUIET, [axis]: rates(sdDegS, sdDegS * 1.4) });
    for (const axis of ['roll', 'pitch', 'yaw']) {
      const first = judgeRun(withCaptures(c => { c.steadiness = { hold: onAxis(axis, 1.01), afterResume: QUIET }; }));
      expect(first['flight-task']).toEqual({ verdict: 'FAIL', reasons: [`the hold: ${axis} rate varies by 1.01 deg/s, above the 1 deg/s limit (A-13)`] });
      expect(first['pause-resume'].verdict).toBe('PASS');
      const second = judgeRun(withCaptures(c => { c.steadiness = { hold: QUIET, afterResume: onAxis(axis, 1.01) }; }));
      expect(second['pause-resume']).toEqual({ verdict: 'FAIL', reasons: [`the hold after Resume: ${axis} rate varies by 1.01 deg/s, above the 1 deg/s limit (A-13)`] });
      expect(second['flight-task'].verdict).toBe('PASS');
      const atLimit = judgeRun(withCaptures(c => { c.steadiness = { hold: onAxis(axis, 1), afterResume: onAxis(axis, 1) }; }));
      expect([atLimit['flight-task'].verdict, atLimit['pause-resume'].verdict]).toEqual(['PASS', 'PASS']);
    }
    // The quad at stock settings: its height stays in the band, and its roll rate is what fails it.
    const wobble = judgeRun(withCaptures((c, run) => {
      run.settings = 'stock';
      ((run.steps as Mutable).tuning as { facts: Mutable }).facts.writes = [];
      c.flownSettings = Object.entries(STOCK_SETTINGS).map(([name, value]) => ({ name, value }));
      c.steadiness = { hold: { ...QUIET, roll: rates(61.4, 85) }, afterResume: { ...QUIET, roll: rates(59.74, 85) } };
    }));
    expect(wobble['flight-task']).toEqual({ verdict: 'FAIL', reasons: ['the hold: roll rate varies by 61.40 deg/s, above the 1 deg/s limit (A-13)'] });
    expect(wobble['pause-resume']).toEqual({ verdict: 'FAIL', reasons: ['the hold after Resume: roll rate varies by 59.74 deg/s, above the 1 deg/s limit (A-13)'] });
    // Without the numbers a flight cannot show that it was steady.
    const unknown = judgeRun(withCaptures(c => { c.steadiness = { hold: null, afterResume: null }; }));
    expect(unknown['flight-task'].reasons).toEqual(['the hold: no RATE records in the flight\'s log']);
    expect(unknown['pause-resume'].reasons).toEqual(['the hold after Resume: no RATE records in the flight\'s log']);
    expect(judgeRun(withCaptures(c => { c.steadiness = null; }))['flight-task'].reasons).toEqual(['the hold: no RATE records in the flight\'s log']);
  });

  it('checks in the flight\'s own log that it flew its tuned setting and stock values for the rest', () => {
    const flown = (name: string, value: number | null) => (c: Mutable) => {
      c.flownSettings = (PASSING.captures.flownSettings as { name: string; value: number }[]).map(item => (item.name === name ? { name, value } : item));
    };
    // The write was confirmed, yet the flight's log shows the stock filter.
    expect(judgeRun(withCaptures(flown('INS_GYRO_FILTER', 20)))['flight-task']).toEqual({ verdict: 'FAIL', reasons: ['INS_GYRO_FILTER flew at 20, not 40'] });
    // Nothing else may have been tuned; float32 rounding of the stock value is not a change.
    expect(judgeRun(withCaptures(flown('ATC_RAT_RLL_P', 0.108)))['flight-task'].reasons).toEqual(['ATC_RAT_RLL_P flew at 0.108, not 0.135']);
    expect(judgeRun(withCaptures(flown('ATC_RAT_PIT_D', null)))['flight-task'].reasons).toEqual(['the flight\'s log does not show ATC_RAT_PIT_D']);
    expect(judgeRun(withCaptures(c => { c.flownSettings = []; }))['flight-task'].reasons).toHaveLength(Object.keys(STOCK_SETTINGS).length);
    // The other four aircraft stay on stock settings: a hexa with the filter raised, or with any write, fails.
    const hexa = (edit: (run: Mutable, steps: Record<string, { facts: Mutable }>) => void) => {
      const copy = JSON.parse(JSON.stringify(PASSING)) as Mutable & { captures: Mutable; steps: Record<string, { facts: Mutable }> };
      copy.configuration = 'hexa';
      const fix = (name: string, facts: Mutable) => { const step = copy.steps[name]; if (step) step.facts = { ...step.facts, ...facts }; };
      fix('profile', { motors: 6 });
      fix('mapping', { outputs: [1, 2, 3, 4, 5, 6].map(motor => ({ motor, output: motor })) });
      fix('motorCheck', { rows: [1, 2, 3, 4, 5, 6].map(motor => ({ order: motor, motor, output: motor, pass: true })) });
      fix('tuning', { writes: [] });
      copy.captures.flownSettings = Object.entries(STOCK_SETTINGS).map(([name, value]) => ({ name, value }));
      edit(copy, copy.steps);
      return judgeRun(parseNominalRun(copy));
    };
    expect(hexa(() => undefined)['flight-task']).toEqual({ verdict: 'PASS', reasons: [] });
    expect(hexa((run) => { (run.captures as Mutable).flownSettings = Object.entries(STOCK_SETTINGS).map(([name, value]) => ({ name, value: name === 'INS_GYRO_FILTER' ? 40 : value })); })['flight-task'].reasons)
      .toEqual(['INS_GYRO_FILTER flew at 40, not 20']);
    expect(hexa((_, steps) => { const step = steps.tuning; if (step) step.facts = PASSING.steps.tuning.facts; })['flight-task'].reasons).toEqual(['INS_GYRO_FILTER was written, and this run plans no such setting']);
  });

  it('fails the flight task of a flight whose capture cannot stand as its evidence, and asks for no capture of a flight not reached', () => {
    const captured = (edit: (captures: Mutable) => void) => {
      const copy = JSON.parse(JSON.stringify(PASSING)) as { captures: Mutable };
      edit(copy.captures);
      return parseNominalRun(copy);
    };
    const file = (fields: Mutable) => [{ ...PASSING.captures.dataflash[0], ...fields }];
    const cases: [(captures: Mutable) => void, string][] = [
      [c => { c.dataflash = []; }, 'the run left no DataFlash file'],
      [c => { c.dataflash = file({ status: 'damaged' }); }, 'DataFlash 00000001.BIN: damaged'],
      [c => { c.dataflash = file({ status: 'empty' }); }, 'DataFlash 00000001.BIN: empty'],
      [c => { c.dataflash = file({ status: `differs from the launcher's SHA-256 ${SHA('0')}` }); }, `DataFlash 00000001.BIN: differs from the launcher's SHA-256 ${SHA('0')}`],
      [c => { c.dataflash = file({ firmwareMatchesBuild: false }); }, 'DataFlash 00000001.BIN: its VER record does not name the build'],
      [c => { c.recording = null; }, 'the run left no recording'],
      [c => { c.recording = { ...PASSING.captures.recording, status: 'interrupted' }; }, 'the recording is interrupted, not closed'],
      [c => { c.recording = { ...PASSING.captures.recording, droppedRows: 3 }; }, 'the recording dropped 0 chunks and 3 rows'],
    ];
    for (const [edit, reason] of cases) {
      const judged = judgeRun(captured(edit));
      expect(judged['flight-task'], reason).toEqual({ verdict: 'FAIL', reasons: [reason] });
      // A recording that fails the flight's evidence fails the recording workflow too.
      for (const other of NOMINAL_WORKFLOWS) if (other !== 'flight-task' && !(reason.startsWith('the r') && other === 'recording')) expect(judged[other].verdict, `${reason}: ${other}`).toBe('PASS');
    }
    // A complete log and declared producer gaps pass: the gaps belong to the recording workflow's tasks.
    expect(judgeRun(captured(c => { c.dataflash = file({ status: 'complete', truncatedBytes: 0 }); c.recording = { ...PASSING.captures.recording, producerLost: 2 }; }))['flight-task'].verdict).toBe('PASS');
    // A flight that was not reached asks for no capture: its reason stays that it was not reached.
    const notReached = JSON.parse(JSON.stringify(PASSING)) as { steps: Record<string, unknown>; captures: Mutable };
    notReached.steps.start = { facts: null, error: 'Timed out' };
    for (const id of ['tuning', 'motorCheck', 'hold', 'pause', 'landing']) notReached.steps[id] = null;
    notReached.captures.dataflash = [];
    notReached.captures.recording = null;
    expect(judgeRun(parseNominalRun(notReached))['flight-task']).toEqual({ verdict: 'NOT_RUN',
      reasons: ['tuning not reached: start failed', 'hold not reached: start failed', 'landing not reached: start failed'] });
  });

  it('refuses a run file with a missing, mistyped or unknown field', () => {
    const broken: [string, (run: Mutable) => void, RegExp][] = [
      ['schema', run => { run.schema = 'mirage-phase1-nominal-run/0'; }, /run.schema is not mirage-phase1-nominal-run\/2/],
      ['settings', run => { run.settings = 'tuned'; }, /run.settings is not one of acceptance, stock/],
      ['configuration', run => { run.configuration = 'tri'; }, /run.configuration is not one of quad, hexa/],
      ['a hash', run => { ((run.steps as Mutable).start as { facts: Mutable }).facts.recordSha256 = 'abc'; }, /abc is not a SHA-256/],
      ['a reading', run => { ((run.steps as Mutable).hold as { facts: Mutable }).facts.readingsM = [5, Number.NaN]; }, /run.steps.hold.facts.readingsM\[1\] is not a finite number/],
      ['an empty step', run => { (run.steps as Mutable).stop = { facts: null, error: null }; }, /steps.stop has neither facts nor an error/],
      ['the captures', run => { delete run.captures; }, /run.captures is not an object/],
      ['a power reading', run => { ((run.captures as Mutable).power as { hover: Mutable }).hover.currentA = 'high'; }, /run.captures.power.hover.currentA is not a finite number/],
    ];
    for (const [what, edit, message] of broken) {
      const copy = JSON.parse(JSON.stringify(PASSING)) as Mutable;
      edit(copy);
      expect(() => parseNominalRun(copy), what).toThrow(message);
    }
  });
});

describe('the steadiness of a hold in the flight\'s DataFlash log', () => {
  const column = (name: string, values: number[], valueScale = 1) => ({ name, values: Float64Array.from(values), valueScale });
  // Rows every 0.1 s from 49.9 s to 50.5 s; the window 50.0 to 50.3 s holds rows 1 to 4. Roll ±60 deg/s, pitch steady at -2, yaw 1 and 3.
  const log = { groups: [{ name: 'XKF1', count: 0, columns: [] }, { name: 'RATE', count: 7, columns: [
    column('TimeUS', [49.9e6, 50e6, 50.1e6, 50.2e6, 50.3e6, 50.4e6, 50.5e6], 1e-6),
    column('R', [500, 60, -60, 60, -60, 500, 500]), column('P', [500, -2, -2, -2, -2, 500, 500]), column('Y', [500, 1, 3, 1, 3, 500, 500]),
  ] }] };

  it('gives the standard deviation and the peak of the rows in the window, written out by hand', () => {
    expect(steadinessOf(log, 49.95, 50.35)).toEqual({ fromS: 49.95, toS: 50.35, samples: 4, roll: rates(60, 60), pitch: rates(0, 2), yaw: rates(1, 3) });
  });

  it('has nothing to say without rows in the window or without RATE records', () => {
    expect(steadinessOf(log, 60, 70)).toBeNull();
    expect(steadinessOf({ groups: [] }, 0, 100)).toBeNull();
  });

  it('reads the RATE records of the real ArduCopter log slice with their column names and time scale', () => {
    const real = readDataFlash(new Uint8Array(readFileSync(new URL('../fixtures/dataflash/sitl-copter.bin', import.meta.url))));
    const rate = real.groups.find(group => group.name === 'RATE');
    expect(rate?.count).toBeGreaterThan(0);
    const all = steadinessOf(real, 0, 1e9);
    expect(all?.samples).toBe(rate?.count);
    for (const axis of [all?.roll, all?.pitch, all?.yaw]) {
      expect(axis?.sdDegS).toBeGreaterThanOrEqual(0);
      expect(axis?.peakDegS).toBeGreaterThanOrEqual(axis?.sdDegS ?? Number.NaN);
    }
  });
});

describe('where the verdicts may be written (A-01) and how', () => {
  const M5 = { platform: 'darwin', arch: 'arm64', model: 'Mac17,3', chip: 'Apple M5', memoryBytes: 32 * 1024 ** 3 };
  it('admits only the 15-inch Apple M5 MacBook Air with 32 GB', () => {
    expect(acceptanceMachineReasons(M5)).toEqual([]);
    expect(acceptanceMachineReasons({ ...M5, chip: 'Apple M4', memoryBytes: 16 * 1024 ** 3 })).toEqual(['the chip is Apple M4, not the Apple M5', '16.0 GB of memory, not 32 GB']);
    expect(acceptanceMachineReasons({ ...M5, platform: 'linux', arch: 'x64' })).toEqual(['linux x64 is not macOS on Apple Silicon']);
  });

  it('writes the five TASK-158 cells of one configuration with the evidence and keeps every other cell as it was', () => {
    const matrix: unknown = JSON.parse(readFileSync(new URL('../../docs/validation/phase1-matrix.json', import.meta.url), 'utf8'));
    const failing = withFacts('landing', f => { f.armed = 'Armed'; });
    const evidence = { path: 'test-results/validation/phase1-nominal/hexa.json', sha256: SHA('9') };
    const written = writeNominalCells(matrix, 'hexa', judgeRun(failing), evidence);
    const before = (matrix as { cells: Mutable[] }).cells, after = written.cells as Mutable[];
    expect(after).toHaveLength(before.length);
    const changed = after.flatMap((cell, i) => (JSON.stringify(cell) === JSON.stringify(before[i]) ? [] : [`${String(cell.configuration)} ${String(cell.workflow)}`]));
    expect(changed.sort()).toEqual(NOMINAL_WORKFLOWS.map(w => `hexa ${w}`).sort());
    for (const workflow of NOMINAL_WORKFLOWS) {
      expect(after.find(cell => cell.configuration === 'hexa' && cell.workflow === workflow)).toEqual({
        configuration: 'hexa', workflow, verdict: workflow === 'flight-task' ? 'FAIL' : 'PASS', evidence });
    }
    // Everything but the cells is the matrix as it was.
    expect({ ...written, cells: null }).toEqual({ ...(matrix as Mutable), cells: null });
    // Every configuration has its five cells exactly once.
    for (const configuration of NOMINAL_CONFIGURATIONS) expect(() => writeNominalCells(matrix, configuration.id, judgeRun(parseNominalRun(PASSING)), evidence)).not.toThrow();
  });

  it('refuses a matrix without the cells it expects and evidence without a hash', () => {
    const matrix = JSON.parse(readFileSync(new URL('../../docs/validation/phase1-matrix.json', import.meta.url), 'utf8')) as { cells: Mutable[] };
    const judged = judgeRun(parseNominalRun(PASSING)), evidence = { path: 'x.json', sha256: SHA('9') };
    expect(() => writeNominalCells({ ...matrix, schemaVersion: 2 }, 'quad', judged, evidence)).toThrow('not schema version 1');
    expect(() => writeNominalCells({ ...matrix, cells: matrix.cells.filter(c => !(c.configuration === 'x8' && c.workflow === 'start')) }, 'x8', judged, evidence))
      .toThrow('The matrix has 0 cells for x8 × start');
    expect(() => writeNominalCells({ ...matrix, cells: [...matrix.cells, ...matrix.cells.slice(0, 1)] }, 'quad', judged, evidence))
      .toThrow('The matrix has 2 cells for quad × profile-creation');
    expect(() => writeNominalCells(matrix, 'quad', judged, { path: 'x.json', sha256: 'none' })).toThrow('no SHA-256');
  });

  it('keeps the tracked matrix bound to its tracked reports: each written cell cites a report with that SHA-256, configuration and verdict', () => {
    const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url));
    const matrix = JSON.parse(read('docs/validation/phase1-matrix.json').toString('utf8')) as { cells: { configuration: string | null; workflow: string; verdict: string; evidence: { path: string; sha256: string } | null }[] };
    const written = matrix.cells.filter(cell => cell.evidence !== null && cell.evidence.path.startsWith('test-results/validation/phase1-nominal/'));
    for (const cell of written) {
      const name = `${cell.configuration} × ${cell.workflow}`, bytes = read(cell.evidence?.path ?? '');
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(cell.evidence?.sha256);
      const report = JSON.parse(bytes.toString('utf8')) as { task: string; configuration: { id: string }; acceptanceMachine: { admitted: boolean }; verdicts: Record<string, { verdict: string }> };
      expect(report.task, name).toBe('TASK-158');
      expect(report.configuration.id, name).toBe(cell.configuration);
      expect(report.acceptanceMachine.admitted, name).toBe(true);
      expect(report.verdicts[cell.workflow]?.verdict, name).toBe(cell.verdict);
    }
    // Only this task's workflows cite these reports.
    for (const cell of written) expect(NOMINAL_WORKFLOWS.some(workflow => workflow === cell.workflow), cell.workflow).toBe(true);
  });

  it('declares the criteria the TASK-158 status lists', () => {
    expect(CRITERIA).toEqual({ physicsHz: 800, speedup: 1, takeoffAltitudeM: 5, hoverBandM: 0.5, holdSimS: 10, minimumReadings: 4, pauseWallS: 30,
      pauseSimS: 1, restToleranceM: 0.006, resentPerPause: 1, polar: 'naca6409-neuralfoil-v1', dataflashStatuses: ['complete', 'truncated'], steadinessSdDegS: 1 });
    // Decision of 2026-11-04: the quad alone is tuned, by the one setting; the other four fly stock.
    expect(NOMINAL_CONFIGURATIONS.map(c => [c.id, c.tuning])).toEqual([['quad', [{ name: 'INS_GYRO_FILTER', value: 40 }]], ['hexa', []], ['octo', []], ['x8', []], ['octo-paired-16', []]]);
    expect(STOCK_SETTINGS).toEqual({ INS_GYRO_FILTER: 20, ATC_RAT_RLL_P: 0.135, ATC_RAT_RLL_I: 0.135, ATC_RAT_RLL_D: 0.0036, ATC_RAT_PIT_P: 0.135, ATC_RAT_PIT_I: 0.135, ATC_RAT_PIT_D: 0.0036 });
  });
});
