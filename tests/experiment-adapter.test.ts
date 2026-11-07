import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDataFlash, columnText } from '@mirage/dataflash/reader';
import { DataFlashWriter } from '@mirage/dataflash/writer';
import type { ExperimentPayload } from '@mirage/aircraft/experiment';
import { experimentContext, externalLogContext, recordingDataflash, runDifferences, viewerEvents } from '../apps/web/src/analysis/experiment-adapter.ts';
import type { ParameterChange } from '../apps/web/src/params/parameter-sets.ts';

// TASK-180. Hand-built records, and DataFlash files read back with the TASK-178 reader, which pymavlink's output pins.

const change = (name: string, simTimeS: number, oldValue: number | null, newValue: number, outcome: ParameterChange['outcome'], writeId = 1): ParameterChange =>
  ({ writeId, name, oldValue, newValue, requestedAt: '2026-11-05T00:00:00.000Z', tick: simTimeS * 800, simTimeS, experimentId: 'e1', whilePaused: false, outcome });
const base = { id: 1, name: 'X', requested: 1 };
const confirmed = (value: number): ParameterChange['outcome'] => ({ ...base, kind: 'confirmed', value, rebootRequired: false, outsideRange: false });
const CHANGES: readonly ParameterChange[] = [
  change('ATC_A', 50, 1, 2, confirmed(2), 1),
  change('ATC_B', 51, 5, 6, { ...base, kind: 'refused', by: 'autopilot', reason: 'held 5', reported: 5 }, 2),
  change('ATC_C', 52, null, 7, { ...base, kind: 'timeout', attempts: 3 }, 3),
  change('ATC_D', 53, 9, 8, { ...base, kind: 'requested', attempts: 1 }, 4),
  change('ATC_E', 54, 3, 4, { ...base, kind: 'stale', reason: 'a newer write', reported: null }, 5),
  change('ATC_A', 60, 2, 1, confirmed(1), 6),
  change('ATC_F', 61, 0, 1, confirmed(1), 7),
];
const payload = {
  profile: { sha256: 'a'.repeat(64), id: 'p1', version: 3, name: 'Quad X' }, sitl: { ownership: 'launcher', experimentId: 'e1', ardupilot: { catalogId: 'c', firmwareVersion: 'ArduCopter V4.7.2', commit: 'b'.repeat(40) } },
  session: { physicsHz: 800, clockMode: 'sitl-lockstep', speedup: 1, home: [-35.36, 149.16, 584, 0], modelId: 1 }, parameters: [{ name: 'X', value: 1, source: 'profile' }], frameScript: null, recording: null,
  lineage: { kind: 'original' }, flightTask: null,
} as unknown as ExperimentPayload;

describe('the context of an experiment', () => {
  it('states its aircraft, versions and conditions, and marks what its record does not hold as unknown', () => {
    const context = experimentContext('Run 1', payload, CHANGES), row = (label: string) => context.rows.find(item => item.label === label)?.value;
    expect(context.source).toBe('experiment');
    expect(row('Aircraft profile')).toBe('Quad X, version 3');
    expect(row('Profile SHA-256')).toBe('a'.repeat(64));
    expect(row('ArduPilot')).toContain('b'.repeat(40));
    expect(row('Location')).toBe('-35.36°, 149.16°, 584 m, heading 0°');
    expect(row('Wind and temperature')).toBeNull();
    expect(context.lineage).toBeNull();
  });
  it('puts every change on the timeline at its simulated time, and tells requested, confirmed and rejected apart', () => {
    const { events, history } = experimentContext('Run 1', payload, CHANGES);
    expect(history).toBe('run');
    expect(events.map(event => [event.timeS, event.name, event.status])).toEqual([[50, 'ATC_A', 'confirmed'], [51, 'ATC_B', 'rejected'], [52, 'ATC_C', 'rejected'], [53, 'ATC_D', 'requested'], [54, 'ATC_E', 'superseded'], [60, 'ATC_A', 'confirmed'], [61, 'ATC_F', 'confirmed']]);
    expect(events[2]).toMatchObject({ from: null, to: 7, text: 'ATC_C unknown → 7 (rejected)' });
    expect(viewerEvents(experimentContext('Run 1', payload, CHANGES))[0]).toEqual({ timeMs: 50000, text: 'ATC_A 1 → 2 (confirmed)', status: 'confirmed' });
  });
  it('counts as differences only what ended confirmed, and something back where it began is none', () => {
    expect(runDifferences(CHANGES)).toEqual([{ name: 'ATC_F', from: 0, to: 1 }]);
  });
  it('invents no history for an experiment without a stored log, and says what a repeat or variant is', () => {
    const context = experimentContext('Run 1', payload, null);
    expect(context).toMatchObject({ history: null, events: [], differences: null });
    expect(experimentContext('Run 1', payload, [])).toMatchObject({ history: 'run', events: [], differences: [] });
    expect(experimentContext('R', { ...payload, lineage: { kind: 'repeat', of: 'c'.repeat(64) } } as unknown as ExperimentPayload, null).lineage).toContain('repeat');
    expect(experimentContext('V', { ...payload, lineage: { kind: 'variant', of: 'c'.repeat(64), changes: ['speed', 'parameters'] } } as unknown as ExperimentPayload, null).lineage).toContain('speed, parameters');
  });
});

describe('the context of a log from elsewhere', () => {
  const fmt = (type: number, name: string, format: string, columns: string, payloadBytes: number) => {
    const out = new Uint8Array(89);
    out.set([0xa3, 0x95, 128, type, payloadBytes + 3]);
    new TextEncoder().encodeInto(name, out.subarray(5, 9));
    new TextEncoder().encodeInto(format, out.subarray(9, 25));
    new TextEncoder().encodeInto(columns, out.subarray(25, 89));
    return out;
  };
  /** The record a log's PARM has: TimeUS, Name, Value, Default. */
  const parm = (timeUs: bigint, name: string, value: number) => {
    const out = new Uint8Array(3 + 8 + 16 + 4 + 4), view = new DataView(out.buffer);
    out.set([0xa3, 0x95, 64]);
    view.setBigUint64(3, timeUs, true);
    new TextEncoder().encodeInto(name, out.subarray(11, 27));
    view.setFloat32(27, value, true);
    view.setFloat32(31, Number.NaN, true);
    return out;
  };
  const join = (...parts: readonly Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
  const FORMATS = join(fmt(128, 'FMT', 'BBnNZ', 'Type,Length,Name,Format,Columns', 86), fmt(64, 'PARM', 'QNff', 'TimeUS,Name,Value,Default', 32));
  it('takes a parameter\'s first record as its value, and each later change as one the log saw, with nothing on who asked', () => {
    const bytes = join(FORMATS, parm(1000000n, 'A', 1), parm(1000000n, 'B', 5), parm(2000000n, 'A', 1), parm(3000000n, 'A', 2), parm(4000000n, 'B', 5));
    const context = externalLogContext('flight.bin', bytes), row = (label: string) => context.rows.find(item => item.label === label);
    expect(context.source).toBe('external');
    expect(context.history).toBe('log');
    expect(context.events).toHaveLength(1);
    expect(context.events[0]).toMatchObject({ timeS: 3, name: 'A', from: 1, to: 2, status: 'logged', text: 'A 1 → 2 (in the log)' });
    expect(context.differences).toEqual([{ name: 'A', from: 1, to: 2 }]);
    for (const label of ['Aircraft profile', 'Component versions', 'Physics rate', 'Location', 'Wind and temperature', 'Flight task', 'ArduPilot']) expect(row(label)?.value, label).toBeNull();
    expect(row('Log file')?.value).toContain('flight.bin');
  });
  it('shows a value as the shortest decimal of its float32', () => {
    const bytes = join(FORMATS, parm(1000000n, 'A', 0.39), parm(2000000n, 'A', 0.5));
    expect(externalLogContext('flight.bin', bytes).events[0]?.text).toBe('A 0.39 → 0.5 (in the log)');
  });
  it('leaves out the counters the firmware keeps, which nobody changes', () => {
    const bytes = join(FORMATS, parm(1000000n, 'STAT_RUNTIME', 30), parm(2000000n, 'STAT_RUNTIME', 60), parm(1000000n, 'A', 1));
    expect(externalLogContext('flight.bin', bytes)).toMatchObject({ history: 'log', events: [], differences: [] });
  });
  it('invents no history for a log without parameter records', () => {
    const context = externalLogContext('other.bin', FORMATS);
    expect(context).toMatchObject({ history: null, events: [], differences: null });
  });
  it('reads the firmware from a real ArduCopter log when one is at hand', () => {
    const fixture = readFileSync('tests/fixtures/dataflash/sitl-copter.bin');
    const context = externalLogContext('reference.bin', fixture);
    expect(context.rows.find(item => item.label === 'ArduPilot')?.value).toMatch(/ArduCopter/);
    expect(context.history).toBe('log');
    expect(context.events).toEqual([]);
  });
});

describe('a DataFlash file from a stored recording', () => {
  const row = (tick: number, values: readonly number[] | null) => ({ tick, simTimeS: tick / 100, values });
  const rows = new Map([
    ['truth.position', [row(0, [0, 0, -5]), row(1, [1000, 0, -5]), row(2, [0, 0, -5])]],
    ['truth.velocity', [row(0, [1, 2, 3]), row(1, [1, 2, 3])]],
    ['truth.attitude', [row(0, [1, 0, 0, 0]), row(1, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]), row(2, [1, 0, 0, 0])]],
    ['truth.bodyRates', [row(0, [Math.PI, 0, 0]), row(1, [0, 0, 0]), row(2, [0, 0, 0])]],
  ]);
  it('pairs the truth signals by tick, leaves out a tick that lacks one, and places them by WGS84', () => {
    const bytes = recordingDataflash(rows, [0, 10, 0, 0], CHANGES);
    if (!bytes) throw new Error('No file');
    const log = readDataFlash(bytes), truth = log.groups.find(group => group.name === 'MSTR');
    if (!truth) throw new Error('No MSTR');
    expect(truth.count).toBe(2);
    const column = (name: string, at: number) => Number(truth.columns.find(item => item.name === name)?.values[at]) * (truth.columns.find(item => item.name === name)?.valueScale ?? 1);
    expect(column('PN', 1)).toBeCloseTo(1000, 3);
    expect(column('Yaw', 1)).toBeCloseTo(90, 3);
    expect(column('GX', 0)).toBeCloseTo(180, 3);
    expect(column('Alt', 0)).toBeCloseTo(5, 3);
    // 1000 m north of the equator: the meridional radius there is 6335439 m.
    expect(column('Lat', 1)).toBeCloseTo(0.00904372, 6);
    expect(column('Lng', 1)).toBeCloseTo(10, 7);
    const changes = log.groups.find(group => group.name === 'MSPC');
    expect(changes?.count).toBe(CHANGES.length);
    const name = changes?.columns.find(item => item.name === 'Name');
    expect(name && columnText(name, 1)).toBe('ATC_B');
  });
  it('gives no file when no tick has all four signals, and no parameter records when none are stored', () => {
    expect(recordingDataflash(new Map([['truth.position', [row(0, [0, 0, 0])]]]), [0, 0, 0, 0], null)).toBeNull();
    const bytes = recordingDataflash(rows, [0, 10, 0, 0], null);
    if (!bytes) throw new Error('No file');
    expect(readDataFlash(bytes).groups.find(group => group.name === 'MSPC')?.count ?? 0).toBe(0);
    expect(new DataFlashWriter().bytes().length).toBeGreaterThan(0);
  });
});
