import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DataFlashReader, columnText, parseSource, readDataFlash, type DataFlashColumn, type DataFlashLog, type DataFlashValues,
} from '../packages/dataflash/src/reader.ts';
import {
  DataFlashWriter, MIRAGE_MESSAGES, readExperimentRecords, writeDataFlash, type ExperimentRecord,
} from '../packages/dataflash/src/writer.ts';

// Oracle: pymavlink 2.4.50 mavlogdump --format json (scripts/generate-dataflash-fixtures.py).
type Cell = number | string | null | readonly number[];
interface EncodedRecords { names: string[]; order: number[]; groups: Record<string, { format: string; columns: string[]; rows: Cell[][] }> }
interface Units { [name: string]: { [column: string]: { unit: string; multiplier: number | null; valueScale: number; instance: boolean } } }
interface Edit { kind: 'insert' | 'set' | 'zero' | 'cut'; offset?: number; hex?: string; length?: number }
interface DamagedCase { name: string; edit: Edit; removed: [number, number]; ranges: { start: number; end: number; kind: string }[]; pymavlinkSkipped: [number, number][] }
interface Reference {
  slice: { file: string; sha256: string; bytes: number; records: number };
  records: EncodedRecords; units: Units; damaged: DamagedCase[];
  writer: { input: unknown[]; sha256: string; bytes: number; records: EncodedRecords; units: Units };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isEncoded(value: unknown): value is EncodedRecords {
  return isObject(value) && Array.isArray(value.names) && Array.isArray(value.order) && isObject(value.groups) &&
    Object.values(value.groups).every(g => isObject(g) && typeof g.format === 'string' && Array.isArray(g.columns) && Array.isArray(g.rows));
}
function loadReference(): Reference {
  const value: unknown = JSON.parse(readFileSync(new URL('./fixtures/dataflash/reference.json', import.meta.url), 'utf8'));
  if (!isObject(value) || !isObject(value.slice) || !isEncoded(value.records) || !isObject(value.units) || !Array.isArray(value.damaged) ||
      !isObject(value.writer) || !isEncoded(value.writer.records) || !Array.isArray(value.writer.input)) throw new Error('Invalid DataFlash reference');
  // Shape validated above; the remaining leaves are compared value by value below.
  return value as unknown as Reference;
}

const reference = loadReference();
const slice = new Uint8Array(readFileSync(new URL(`./fixtures/dataflash/${reference.slice.file}`, import.meta.url)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function expectedNumber(cell: Cell): number {
  if (cell === 'NaN') return NaN;
  if (cell === 'Infinity') return Infinity;
  if (cell === '-Infinity') return -Infinity;
  if (typeof cell !== 'number') throw new Error(`Expected a number, got ${JSON.stringify(cell)}`);
  return cell;
}
function same(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') return Object.is(actual, expected);
  return JSON.stringify(actual) === JSON.stringify(expected);
}
function actualCell(group: string, column: DataFlashColumn, row: number): unknown {
  const char = column.format;
  if (char === 'a') return Array.from(column.values.subarray(row * 32, row * 32 + 32), Number);
  if (char === 'n' || char === 'N' || char === 'Z') {
    if (group === 'FILE' && char === 'Z') return hex(new Uint8Array(column.values.buffer, column.values.byteOffset + row * column.width, column.width));
    return columnText(column, row);
  }
  const value = column.values[row];
  return typeof value === 'bigint' ? value.toString() : value;
}
/** Every record, in order, against mavlogdump: type, timestamp and each field value. */
function mismatches(log: DataFlashLog, expected: EncodedRecords, removed: [number, number] = [0, 0]): string[] {
  const errors: string[] = [], rows = new Map<number, number>(), refRows = new Map<string, number>();
  let i = 0;
  for (let k = 0; k < expected.order.length; k++) {
    const name = expected.names[expected.order[k] ?? -1] ?? '?', refRow = refRows.get(name) ?? 0;
    refRows.set(name, refRow + 1);
    if (k >= removed[0] && k < removed[1]) continue;
    const groupIndex = log.order[i++], group = groupIndex === undefined ? undefined : log.groups[groupIndex];
    if (!group) { errors.push(`record ${k}: missing`); break; }
    const row = rows.get(groupIndex ?? -1) ?? 0;
    rows.set(groupIndex ?? -1, row + 1);
    const ref = expected.groups[name], cells = ref?.rows[refRow];
    if (group.name !== name || !ref || !cells) { errors.push(`record ${k}: ${group.name} != ${name}`); continue; }
    if (group.format !== ref.format || group.columns.map(c => c.name).join() !== ref.columns.join()) errors.push(`${name}: definition differs`);
    if (!Object.is(group.timestampsS[row], expectedNumber(cells[0] ?? null))) errors.push(`record ${k} ${name}: time ${group.timestampsS[row]} != ${String(cells[0])}`);
    group.columns.forEach((column, c) => {
      const want = cells[c + 1] ?? null, got = actualCell(name, column, row);
      const ok = typeof got === 'number' ? Object.is(got, expectedNumber(want)) : same(got, want);
      if (!ok) errors.push(`record ${k} ${name}.${column.name}: ${String(got)} != ${JSON.stringify(want)}`);
    });
    if (errors.length > 20) break;
  }
  if (i !== log.records) errors.push(`record count ${log.records} != ${i}`);
  return errors;
}
function unitMismatches(log: DataFlashLog, units: Units): string[] {
  const errors: string[] = [];
  for (const group of log.groups) {
    const want = units[group.name];
    for (const column of group.columns) {
      const expected = want?.[column.name] ?? { unit: '', multiplier: null, valueScale: 1, instance: false };
      const actual = { unit: column.unit, multiplier: column.multiplier, valueScale: column.valueScale, instance: column.instance };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${group.name}.${column.name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
  }
  return errors;
}
function applyEdit(data: Uint8Array, edit: Edit): Uint8Array {
  const offset = edit.offset ?? 0;
  if (edit.kind === 'insert') {
    const extra = Buffer.from(edit.hex ?? '', 'hex');
    return Uint8Array.from([...data.subarray(0, offset), ...extra, ...data.subarray(offset)]);
  }
  const copy = data.slice();
  if (edit.kind === 'set') copy.set(Buffer.from(edit.hex ?? '', 'hex'), offset);
  else if (edit.kind === 'zero') copy.fill(0, offset, offset + (edit.length ?? 0));
  else return copy.subarray(0, edit.length ?? 0);
  return copy;
}
function readInChunks(data: Uint8Array, size: number): DataFlashLog {
  const reader = new DataFlashReader();
  for (let at = 0; at < data.length; at += size) reader.push(data.subarray(at, at + size));
  return reader.finish();
}
function numbers(values: DataFlashValues | undefined): number[] {
  const out: number[] = [];
  for (let i = 0; values && i < values.length; i++) out.push(Number(values[i]));
  return out;
}
/** A raw record: header, type, body. */
function record(type: number, body: number[]): number[] { return [0xa3, 0x95, type, ...body]; }
function text(value: string, width: number): number[] {
  const out = new Array<number>(width).fill(0);
  for (let i = 0; i < value.length && i < width; i++) out[i] = value.charCodeAt(i);
  return out;
}
/** Little-endian unsigned integer bytes. */
function le(value: number, bytes: number): number[] {
  return Array.from({ length: bytes }, (_, i) => Math.floor(value / 2 ** (8 * i)) % 256);
}
function u64(value: number): number[] { return le(value, 8); }
function f64(value: number): number[] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return Array.from(new Uint8Array(view.buffer));
}
function fmt(type: number, length: number, name: string, format: string, columns: string): number[] {
  return record(128, [type, length, ...text(name, 4), ...text(format, 16), ...text(columns, 64)]);
}

describe('DataFlash reader against pymavlink mavlogdump (TASK-178)', () => {
  it('uses the registered SITL slice', () => {
    expect(slice.length).toBe(reference.slice.bytes);
    expect(sha256(slice)).toBe(reference.slice.sha256);
  });
  it('reads every record, time and field value of the reference slice exactly', () => {
    const log = readDataFlash(slice);
    expect(log.records).toBe(reference.slice.records);
    expect(log.damaged).toEqual([]);
    expect(log.clock).toBe('usec');
    expect(mismatches(log, reference.records)).toEqual([]);
    const gps = log.groups.find(g => g.name === 'GPS');
    expect(gps?.columns.find(c => c.name === 'GWk')?.values[0]).toBe(2442);
  });
  it('resolves FMTU units against the final UNIT and MULT tables', () => {
    const log = readDataFlash(slice);
    expect(unitMismatches(log, reference.units)).toEqual([]);
    const lat = log.groups.find(g => g.name === 'POS')?.columns.find(c => c.name === 'Lat');
    expect(lat).toMatchObject({ unit: 'deglatitude', valueScale: 1 });
    expect(log.groups.find(g => g.name === 'IMU')?.columns.find(c => c.name === 'I')?.instance).toBe(true);
  });
  it('gives the same result for any chunking', () => {
    const whole = readDataFlash(slice);
    for (const size of [1, 2, 3, 7, 89, 4096, 65536]) {
      const log = readInChunks(slice, size);
      expect(log.records).toBe(whole.records);
      expect(mismatches(log, reference.records)).toEqual([]);
      expect(log.groups.map(g => [g.name, g.count, Array.from(g.offsets)])).toEqual(whole.groups.map(g => [g.name, g.count, Array.from(g.offsets)]));
    }
  });
  it('records the byte offset and global order of every record', () => {
    const log = readDataFlash(slice);
    const offsets: number[] = [], rows = new Map<number, number>();
    for (const index of log.order) {
      const group = log.groups[index], row = rows.get(index) ?? 0;
      rows.set(index, row + 1);
      offsets.push(group?.offsets[row] ?? NaN);
    }
    expect(offsets[0]).toBe(0);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1] ?? Infinity);
    expect(log.bytes).toBe(slice.length);
  });
  it.each(reference.damaged.map(c => [c.name, c] as const))('reports the damaged ranges of %s and keeps every other record', (_, damaged) => {
    const data = applyEdit(slice, damaged.edit), log = readDataFlash(data);
    expect(log.damaged).toEqual(damaged.ranges);
    expect(damaged.pymavlinkSkipped).toEqual(damaged.ranges.filter(r => r.kind === 'skipped').map(r => [r.start, r.end - r.start]));
    expect(mismatches(log, reference.records, damaged.removed)).toEqual([]);
    expect(readInChunks(data, 5).damaged).toEqual(damaged.ranges);
  });
  it('rejects FMT records with an unknown format character or a wrong length', () => {
    const data = Uint8Array.from([
      ...fmt(10, 3 + 8 + 1, 'GOOD', 'QB', 'TimeUS,V'),
      ...fmt(11, 3 + 8 + 1, 'BADC', 'QX', 'TimeUS,V'),
      ...fmt(12, 3 + 8 + 2, 'BADL', 'QB', 'TimeUS,V'),
      ...fmt(13, 3 + 8 + 1, 'BADN', 'QB', 'TimeUS'),
      ...record(10, [1, 0, 0, 0, 0, 0, 0, 0, 7]),
      ...record(11, [2, 0, 0, 0, 0, 0, 0, 0, 8]),
      ...record(10, [3, 0, 0, 0, 0, 0, 0, 0, 9]),
    ]);
    const log = readDataFlash(data), fmtLength = 89;
    expect(log.damaged).toEqual([
      { start: fmtLength, end: 2 * fmtLength, kind: 'bad-format' },
      { start: 2 * fmtLength, end: 3 * fmtLength, kind: 'bad-format' },
      { start: 3 * fmtLength, end: 4 * fmtLength, kind: 'bad-format' },
      { start: 4 * fmtLength + 12, end: 4 * fmtLength + 24, kind: 'skipped' },
    ]);
    const good = log.groups.find(g => g.name === 'GOOD');
    expect(numbers(good?.columns[1]?.values)).toEqual([7, 9]);
    expect(log.groups.map(g => g.name)).toEqual(['FMT', 'GOOD']);
  });
  it('reports a cut final record and a cut header as truncated', () => {
    const header = fmt(10, 12, 'GOOD', 'QB', 'TimeUS,V');
    const one = readDataFlash(Uint8Array.from([...header, ...record(10, [1, 0, 0, 0])]));
    expect(one.damaged).toEqual([{ start: 89, end: 96, kind: 'truncated' }]);
    const two = readDataFlash(Uint8Array.from([...header, 0xa3, 0x95]));
    expect(two.damaged).toEqual([{ start: 89, end: 91, kind: 'skipped' }]);
    expect(readDataFlash(new Uint8Array(0))).toMatchObject({ records: 0, damaged: [], clock: 'unsupported' });
  });
  it('switches to a redefined format and starts a new group', () => {
    const data = Uint8Array.from([
      ...fmt(10, 12, 'OLD', 'QB', 'TimeUS,V'), ...record(10, [1, 0, 0, 0, 0, 0, 0, 0, 5]),
      ...fmt(10, 13, 'NEW', 'Qh', 'TimeUS,W'), ...record(10, [2, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]),
      ...fmt(10, 13, 'NEW', 'Qh', 'TimeUS,W'), ...record(10, [3, 0, 0, 0, 0, 0, 0, 0, 2, 0]),
    ]);
    const log = readDataFlash(data);
    expect(log.groups.map(g => [g.name, g.count])).toEqual([['FMT', 3], ['OLD', 1], ['NEW', 2]]);
    expect(numbers(log.groups[2]?.columns[1]?.values)).toEqual([-1, 2]);
  });
  it('follows pymavlink when no GPS gives a week: TimeUS from a zero timebase', () => {
    const data = Uint8Array.from([...fmt(20, 12, 'GPS', 'QB', 'TimeUS,Status'), ...record(20, [1, 0, 0, 0, 0, 0, 0, 0, 3]),
      ...fmt(21, 4, 'NONE', 'B', 'V'), ...record(21, [9])]);
    const log = readDataFlash(data);
    expect(log).toMatchObject({ clock: 'usec', timebaseS: 0 });
    expect(Array.from(log.groups[0]?.timestampsS ?? [])).toEqual([0, 0.000001]);
    expect(Array.from(log.groups[1]?.timestampsS ?? [])).toEqual([0.000001]);
    expect(Array.from(log.groups[2]?.timestampsS ?? [])).toEqual([0.000001]);
  });
  it('takes the timebase from the first GPS record with a week', () => {
    // 315964800 + 604800 × 2442 + 100 − 18 − 2 = 1792886480 s, exact in float64.
    const data = Uint8Array.from([...fmt(20, 18, 'GPS', 'QBHI', 'TimeUS,Status,GWk,GMS'),
      ...record(20, [...u64(1_000_000), 0, ...le(0, 2), ...le(0, 4)]),
      ...record(20, [...u64(2_000_000), 3, ...le(2442, 2), ...le(100_000, 4)]),
      ...record(20, [...u64(3_000_000), 3, ...le(2442, 2), ...le(900_000, 4)])]);
    const log = readDataFlash(data);
    expect(log).toMatchObject({ clock: 'usec', timebaseS: 1792886480 });
    expect(Array.from(log.groups[1]?.timestampsS ?? [])).toEqual([1792886481, 1792886482, 1792886483]);
    expect(log.groups[0]?.timestampsS[0]).toBe(1792886481);
  });
  it('uses a leading TimeMS only when it does not go back, and never for ACC or GYR', () => {
    const data = Uint8Array.from([
      ...fmt(23, 12, 'TUS', 'QB', 'TimeUS,V'), ...record(23, [...u64(1000), 1]),
      ...fmt(24, 8, 'TMS', 'IB', 'TimeMS,V'), ...record(24, [...le(5, 4), 0]), ...record(24, [...le(2, 4), 0]),
      ...fmt(25, 8, 'ACC1', 'IB', 'TimeMS,V'), ...record(25, [...le(9, 4), 0]),
      ...fmt(26, 8, 'GYR1', 'IB', 'TimeMS,V'), ...record(26, [...le(9, 4), 0]),
    ]);
    const times = readDataFlash(data).groups.slice(1).map(g => Array.from(g.timestampsS));
    expect(times).toEqual([[1000 * 0.000001], [5 * 0.001, 5 * 0.001], [5 * 0.001], [5 * 0.001]]);
  });
  it('decodes half floats', () => {
    const data = Uint8Array.from([...fmt(22, 15, 'HALF', 'gggggg', 'A,B,C,D,E,F'),
      ...record(22, [...le(0x3e00, 2), ...le(0x8000, 2), ...le(0x7bff, 2), ...le(0x0001, 2), ...le(0x7c00, 2), ...le(0x7e00, 2)])]);
    const values = readDataFlash(data).groups[1]?.columns.map(c => c.values[0]);
    expect(values).toEqual([1.5, -0, 65504, 2 ** -24, Infinity, NaN]);
    expect(Object.is(values?.[1], -0)).toBe(true);
  });
  it('resolves units declared before their UNIT and MULT records, and missing ids', () => {
    const data = Uint8Array.from([
      ...fmt(119, 76, 'UNIT', 'QbZ', 'TimeUS,Id,Label'), ...fmt(120, 20, 'MULT', 'Qbd', 'TimeUS,Id,Mult'),
      ...fmt(118, 44, 'FMTU', 'QBNN', 'TimeUS,FmtType,UnitIds,MultIds'), ...fmt(50, 15, 'XYZ', 'Qhc', 'TimeUS,A,B'),
      ...record(118, [...u64(0), 50, ...text('sz', 16), ...text('FB', 16)]),
      ...record(119, [...u64(0), 0x73, ...text('s', 64)]), ...record(119, [...u64(0), 0x6d, ...text('m', 64)]),
      ...record(120, [...u64(0), 0x46, ...f64(1e-6)]), ...record(120, [...u64(0), 0x42, ...f64(0.01)]),
      ...record(50, [...u64(5), ...le(7, 2), ...le(250, 2)]),
    ]);
    const group = readDataFlash(data).groups.find(g => g.name === 'XYZ');
    expect(group?.columns.map(c => [c.name, c.unit, c.multiplier, c.valueScale, c.instance])).toEqual([
      ['TimeUS', 's', 1e-6, 1e-6, false], ['A', '', 0.01, 0.01, false], ['B', '', null, 1, false]]);
    expect(group?.columns[2]?.values[0]).toBe(2.5);
  });
  it('leaves times unset for logs with pre-TimeUS clocks', () => {
    const data = Uint8Array.from([...fmt(20, 14, 'GPS', 'IIHB', 'T,TimeMS,Week,Status'),
      ...record(20, [1, 0, 0, 0, 2, 0, 0, 0, 0x8a, 0x09, 3])]);
    const log = readDataFlash(data);
    expect(log.clock).toBe('unsupported');
    expect(Number.isNaN(log.groups[1]?.timestampsS[0])).toBe(true);
  });
  it('decodes pymavlink text: UTF-8, Latin-1 fallback, cut at the first NUL', () => {
    const name = [0x4d, 0xc3, 0xa9, 0, 0x41], latin = [0x4d, 0xe9, 0, 0xff];
    const data = Uint8Array.from([...fmt(30, 3 + 8 + 16, 'TXT', 'QN', 'TimeUS,S'),
      ...record(30, [1, 0, 0, 0, 0, 0, 0, 0, ...name, ...new Array<number>(11).fill(0)]),
      ...record(30, [2, 0, 0, 0, 0, 0, 0, 0, ...latin, ...new Array<number>(12).fill(0)])]);
    const column = readDataFlash(data).groups[1]?.columns[1];
    if (!column) throw new Error('missing column');
    expect([columnText(column, 0), columnText(column, 1)]).toEqual(['Mé', 'Mé']);
  });
  it('parses a Blob in chunks with progress', async () => {
    const progress: number[] = [];
    const log = await parseSource(new Blob([slice]), 4096, bytes => progress.push(bytes));
    expect(mismatches(log, reference.records)).toEqual([]);
    expect(progress.at(-1)).toBe(slice.length);
    expect(progress.length).toBe(Math.ceil(slice.length / 4096));
    await expect(parseSource(new Blob([slice]), 0, () => undefined)).rejects.toThrow(RangeError);
  });
});

describe('DataFlash writer for MirageSITL records (TASK-178)', () => {
  const input: unknown[] = reference.writer.input;
  // Validated by the writer; used where typed records are needed.
  const records = (): ExperimentRecord[] => readExperimentRecords(readDataFlash(writeDataFlash(input)));
  it('writes the recorded sample byte for byte', () => {
    const bytes = writeDataFlash(input);
    expect(bytes.length).toBe(reference.writer.bytes);
    expect(sha256(bytes)).toBe(reference.writer.sha256);
  });
  it('reads back as pymavlink reads it, with its units', () => {
    const log = readDataFlash(writeDataFlash(input));
    expect(log.damaged).toEqual([]);
    expect(mismatches(log, reference.writer.records)).toEqual([]);
    expect(unitMismatches(log, reference.writer.units)).toEqual([]);
  });
  it('re-parses into identical records', () => {
    expect(readExperimentRecords(readDataFlash(writeDataFlash(input)))).toEqual(input);
  });
  it('uses MirageSITL names that the ArduPilot log does not', () => {
    const names = MIRAGE_MESSAGES.map(m => m.name);
    expect(names).toEqual(['MSTR', 'MSMO', 'MSEV', 'MSPC']);
    for (const name of names) expect(reference.records.names).not.toContain(name);
    expect(readExperimentRecords(readDataFlash(slice))).toEqual([]);
  });
  it('rejects invalid records and leaves the output unchanged', () => {
    const writer = new DataFlashWriter();
    writer.append({ kind: 'event', timeUs: 1, event: 'note', text: 'ok' });
    const before = writer.bytes();
    const truth = records().find(r => r.kind === 'truth');
    const motor = records().find(r => r.kind === 'motor');
    const parameter = records().find(r => r.kind === 'parameter');
    if (!truth || !motor || !parameter) throw new Error('fixture lacks a record kind');
    const invalid: unknown[] = [
      { kind: 'event', timeUs: -1, event: 'note', text: 'x' },
      { kind: 'event', timeUs: 1.5, event: 'note', text: 'x' },
      { kind: 'event', timeUs: 2 ** 53, event: 'note', text: 'x' },
      { kind: 'event', timeUs: 1, event: 'other', text: 'x' },
      { kind: 'event', timeUs: 1, event: 'note', text: 'x'.repeat(65) },
      { kind: 'event', timeUs: 1, event: 'note', text: 'a\u0000b' },
      { ...truth, latitudeDeg: 90.5 },
      { ...truth, longitudeDeg: -181 },
      { ...truth, northM: NaN },
      { ...truth, yawDeg: Infinity },
      { ...motor, motor: 16 },
      { ...motor, motor: 1.5 },
      { ...motor, rpm: NaN },
      { ...parameter, name: '' },
      { ...parameter, name: 'A'.repeat(17) },
      { ...parameter, name: 'BAD NAME' },
      { ...parameter, status: 'pending' },
      { ...parameter, requestedValue: NaN },
      { ...parameter, previousValue: NaN },
      { ...parameter, sequence: -1 },
      { ...parameter, sequence: 2 ** 32 },
      { kind: 'other', timeUs: 1 },
      { ...motor, extra: 1 },
    ];
    for (const value of invalid) expect(() => writer.append(value), JSON.stringify(value)).toThrow(RangeError);
    expect(writer.bytes()).toEqual(before);
  });
  it('quantizes values to their wire types', () => {
    const log = readDataFlash(writeDataFlash([{ kind: 'motor', timeUs: 5, motor: 2, command: 0.1, rpm: 1 / 3, thrustN: 1e-50,
      torqueNm: -0, currentA: 3.4028234663852886e38, voltageV: 16 }]));
    const [read] = readExperimentRecords(log);
    expect(read).toEqual({ kind: 'motor', timeUs: 5, motor: 2, command: Math.fround(0.1), rpm: Math.fround(1 / 3), thrustN: 0,
      torqueNm: -0, currentA: 3.4028234663852886e38, voltageV: 16 });
    expect(() => writeDataFlash([{ kind: 'motor', timeUs: 5, motor: 2, command: 0, rpm: 0, thrustN: 0, torqueNm: 0, currentA: 1e39, voltageV: 0 }]))
      .toThrow(RangeError);
  });
});
