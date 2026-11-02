// TASK-160: parameter sets and the parameter change log as project records.
// The payloads are validated from unknown, stored as `parameter-set` and
// `parameter-log` versions that depend on their run's experiment record, and
// compared and restored against a live list with ArduPilot's own metadata
// (data/ardupilot/param-metadata.json, generated from 8ab6afde).
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import type { ParameterValue, WriteState } from '../packages/autopilot/src/param-service.ts';
import { parseParameterMetadata, type ParameterMetadataSet } from '../packages/autopilot/src/param-metadata.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';
import {
  compareParameters, readParameterLog, readParameterSet, restorePlan, saveParameterLog, saveParameterSet, snapshotOf, validateParameterLog,
  validateParameterSet, type ParameterChange, type ParameterLog, type ParameterSet,
} from '../apps/web/src/params/parameter-sets.ts';

const COMMIT = '8ab6afde107a91df1b5f60ade8f333cb8a61b190';
const EXPERIMENT = '20261102120000000-0000002a';
let metadata: ParameterMetadataSet;
beforeAll(() => {
  const set = parseParameterMetadata(JSON.parse(readFileSync('data/ardupilot/param-metadata.json', 'utf8'))).forCommit(COMMIT);
  if (!set) throw new Error(`No metadata for ${COMMIT}`);
  metadata = set;
});

function setOf(experimentSha256: string, parameters: ParameterSet['parameters']): ParameterSet {
  return { schemaVersion: 1, source: { kind: 'run', experimentId: EXPERIMENT, experimentSha256, firmwareCommit: COMMIT, tick: 32000, simTimeS: 40 }, parameters };
}
function change(writeId: number, name: string, newValue: number, outcome: WriteState, oldValue: number | null = 0): ParameterChange {
  return { writeId, name, oldValue, newValue, requestedAt: '2026-11-02T12:00:01.250Z', tick: 40800, simTimeS: 51, experimentId: EXPERIMENT, whilePaused: false, outcome };
}
const OUTCOMES: readonly WriteState[] = [
  { kind: 'requested', id: 1, name: 'RTL_ALT_M', requested: 20, attempts: 1 },
  { kind: 'confirmed', id: 2, name: 'GPS1_DELAY_MS', requested: 10, value: 10, rebootRequired: true, outsideRange: false },
  { kind: 'refused', id: 3, name: 'GPS1_DELAY_MS', requested: 10.5, by: 'service', reason: 'an integer from -32768 to 32767 is required', reported: null },
  { kind: 'refused', id: 4, name: 'BARO1_DEVID', requested: 1, by: 'autopilot', reason: 'the autopilot kept 65540 (read-only in ArduPilot\'s metadata)', reported: 65540 },
  { kind: 'timeout', id: 5, name: 'RTL_ALT_M', requested: 25, attempts: 3 },
  { kind: 'stale', id: 6, name: 'RTL_ALT_M', requested: 30, reason: 'write 7 of the same parameter replaced it', reported: null },
];
function logOf(experimentSha256: string): ParameterLog {
  return { schemaVersion: 1, experimentId: EXPERIMENT, experimentSha256, changes: OUTCOMES.map(outcome => change(outcome.id, outcome.name, outcome.requested, outcome)) };
}
const SHA = 'a'.repeat(64);

describe('parameter set and log payloads', () => {
  test('a set holds float32 values sorted by name with its run source, and every invalid form is refused with its reason', () => {
    const set = setOf(SHA, [{ name: 'ATC_RAT_RLL_P', value: Math.fround(0.135) }, { name: 'RTL_ALT_M', value: 15 }]);
    expect(validateParameterSet(JSON.parse(JSON.stringify(set)))).toEqual(set);
    const refused = (payload: unknown) => () => validateParameterSet(payload);
    expect(refused({ ...set, parameters: [...set.parameters].reverse() })).toThrow('sorted by name without duplicates');
    expect(refused({ ...set, parameters: [set.parameters[1], set.parameters[1]] })).toThrow('sorted by name without duplicates');
    expect(refused({ ...set, parameters: [{ name: 'ATC_RAT_RLL_P', value: 0.135 }] })).toThrow('must be a finite float32');
    expect(refused({ ...set, parameters: [{ name: 'A NAME', value: 1 }] })).toThrow('parameters[0].name is not valid');
    expect(refused({ ...set, parameters: [{ name: 'ABCDEFGHIJKLMNOPQ', value: 1 }] })).toThrow('parameters[0].name is not valid');
    expect(refused({ ...set, parameters: [] })).toThrow('parameters must hold 1 to 8192 entries');
    expect(refused({ ...set, extra: 1 })).toThrow('unknown field extra');
    expect(refused({ ...set, schemaVersion: 2 })).toThrow('schemaVersion must be 1');
    expect(refused({ ...set, source: { ...set.source, kind: 'file' } })).toThrow('source.kind must be run');
    expect(refused({ ...set, source: { ...set.source, firmwareCommit: 'abc' } })).toThrow('source.firmwareCommit is not valid');
    expect(refused({ ...set, source: { ...set.source, experimentSha256: 'A'.repeat(64) } })).toThrow('source.experimentSha256 is not valid');
  });

  test('a log keeps every write state with its change, in write order, and refuses a change that is not its outcome\'s', () => {
    const log = logOf(SHA);
    expect(validateParameterLog(JSON.parse(JSON.stringify(log)))).toEqual(log);
    const refused = (payload: unknown) => () => validateParameterLog(payload);
    const [first, second] = log.changes;
    if (!first || !second) throw new Error('No changes');
    expect(refused({ ...log, changes: [second, first] })).toThrow('changes must be in write order');
    expect(refused({ ...log, changes: [{ ...first, newValue: 21 }] })).toThrow('changes[0].outcome is not the outcome of this change');
    expect(refused({ ...log, changes: [{ ...first, experimentId: 'another' }] })).toThrow('changes[0] belongs to another experiment');
    expect(refused({ ...log, changes: [{ ...first, requestedAt: '2026-02-30T12:00:00.000Z' }] })).toThrow('requestedAt is not an existing UTC time');
    expect(refused({ ...log, changes: [{ ...first, requestedAt: '2026-11-02T12:00:01Z' }] })).toThrow('requestedAt is not valid');
    expect(refused({ ...log, changes: [{ ...first, outcome: { ...first.outcome, kind: 'applied' } }] })).toThrow('changes[0].outcome.kind is not a write state');
    expect(refused({ ...log, changes: [{ ...first, outcome: { ...second.outcome, id: 1, name: 'RTL_ALT_M', requested: 20, rebootRequired: 'yes' } }] }))
      .toThrow('rebootRequired must be true, false or null');
    expect(refused({ ...log, changes: [{ ...first, whilePaused: 1 }] })).toThrow('whilePaused must be true or false');
    expect(refused({ ...log, changes: [] })).toThrow('changes must hold 1 to 2000 entries');
  });
});

describe('parameter sets and logs in the project store', () => {
  test('both kinds depend on their run\'s experiment record, version like other items and are validated when written', async () => {
    const store = new ProjectStore(new MemoryBackend(), { validators: { 'parameter-set': validateParameterSet, 'parameter-log': validateParameterLog } });
    const project = await store.createProject('Parameters');
    const projectId = project.record.id;
    const experiment = await store.createItem(projectId, 'experiment', { name: 'Run 42', payload: { run: 42 } });
    const set = await saveParameterSet(store, projectId, 'Hover tuning', setOf(experiment.sha256, [{ name: 'RTL_ALT_M', value: 15 }]));
    expect(set.record).toMatchObject({ kind: 'parameter-set', version: 1, name: 'Hover tuning', dependencies: [{ kind: 'experiment', sha256: experiment.sha256 }] });
    expect(readParameterSet(await store.get(set.sha256)).parameters).toEqual([{ name: 'RTL_ALT_M', value: 15 }]);
    const renamed = await saveParameterSet(store, projectId, 'Hover tuning, 15 m', setOf(experiment.sha256, [{ name: 'RTL_ALT_M', value: 15 }]),
      { id: set.record.id, head: set.sha256 });
    expect(renamed.record).toMatchObject({ version: 2, previous: set.sha256 });

    const log = logOf(experiment.sha256);
    const first = await saveParameterLog(store, projectId, { ...log, changes: log.changes.slice(0, 2) }, null);
    const next = await saveParameterLog(store, projectId, log, { id: first.record.id, head: first.sha256 });
    expect(next.record).toMatchObject({ kind: 'parameter-log', version: 2, name: `Parameter changes of ${EXPERIMENT}`,
      dependencies: [{ kind: 'experiment', sha256: experiment.sha256 }] });
    expect(readParameterLog(next).changes.map(entry => entry.outcome.kind)).toEqual(['requested', 'confirmed', 'refused', 'refused', 'timeout', 'stale']);
    expect((await store.listItems(projectId, 'parameter-log')).map(stored => stored.sha256)).toEqual([next.sha256]);

    // A set may depend only on an experiment, and its payload is checked by the registered validator.
    const card = await store.createItem(projectId, 'component-card', { name: 'Motor', payload: {} });
    await expect(store.createItem(projectId, 'parameter-set', { name: 'Wrong', payload: setOf(card.sha256, [{ name: 'RTL_ALT_M', value: 1 }]), dependencies: [card.sha256] }))
      .rejects.toThrow();
    await expect(store.createItem(projectId, 'parameter-set', { name: 'Invalid', payload: { schemaVersion: 1 }, dependencies: [experiment.sha256] }))
      .rejects.toThrow('The parameter-set payload is invalid');
    expect(() => readParameterSet(experiment)).toThrow('is not a parameter set');
  });
});

describe('comparison and restore', () => {
  const live = (entries: readonly (readonly [string, number])[]): ParameterValue[] => entries.map(([name, value], index) => ({ name, value, type: 9, index }));

  test('a comparison lists every differing value and every parameter only one side holds, by name', () => {
    expect(compareParameters(
      [{ name: 'A', value: 1 }, { name: 'B', value: 2 }, { name: 'C', value: 3 }],
      [{ name: 'B', value: 2 }, { name: 'C', value: 4 }, { name: 'D', value: 5 }],
    )).toEqual([{ name: 'A', a: 1, b: null }, { name: 'C', a: 3, b: 4 }, { name: 'D', a: null, b: 5 }]);
    expect(snapshotOf(live([['RTL_ALT_M', 15], ['ATC_RAT_RLL_P', Math.fround(0.135)]]))).toEqual([{ name: 'ATC_RAT_RLL_P', value: Math.fround(0.135) },
      { name: 'RTL_ALT_M', value: 15 }]);
  });

  test('restoring a set writes only differing values, and skips what the SITL lacks or ArduPilot marks read-only or its own', () => {
    expect(metadata.get('BARO1_DEVID')?.readOnly).toBe(true);
    const plan = restorePlan(
      [{ name: 'BARO1_DEVID', value: 1 }, { name: 'BARO1_GND_PRESS', value: 101325 }, { name: 'GONE_PARAM', value: 1 }, { name: 'GPS1_DELAY_MS', value: 10 },
        { name: 'RTL_ALT_M', value: 15 }],
      live([['BARO1_DEVID', 65540], ['BARO1_GND_PRESS', 94000], ['GPS1_DELAY_MS', 10], ['RTL_ALT_M', 40], ['LAND_SPD_MS', 0.5]]),
      metadata,
    );
    expect(plan).toEqual({
      writes: [{ name: 'RTL_ALT_M', value: 15 }],
      skipped: [{ name: 'BARO1_DEVID', reason: 'read-only in ArduPilot\'s metadata' }, { name: 'BARO1_GND_PRESS', reason: 'read-only in ArduPilot\'s metadata' },
        { name: 'GONE_PARAM', reason: 'the running SITL has no parameter of this name' }],
    });
    // Without metadata nothing is known to be read-only: the autopilot's own answer decides.
    expect(restorePlan([{ name: 'BARO1_DEVID', value: 1 }], live([['BARO1_DEVID', 65540]]), null).writes).toEqual([{ name: 'BARO1_DEVID', value: 1 }]);
  });
});
