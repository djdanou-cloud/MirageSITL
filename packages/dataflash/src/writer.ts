/**
 * DataFlash writer for MirageSITL experiment records (TASK-178).
 *
 * Writes a self-describing log: FMT records first, then the UNIT and MULT tables, then FMT and
 * FMTU for each MirageSITL message. The message names start with `MS`; no four-character
 * ArduPilot log name in the pinned source does, so they are never confused with autopilot data.
 * Values are validated and quantized to their wire types. Cold path.
 */
import { columnText, type DataFlashLog } from './reader.ts';

const HEAD = [0xa3, 0x95] as const;

/** Simulated truth in the local NED frame, with geodetic position. */
export interface TruthRecord {
  readonly kind: 'truth';
  readonly timeUs: number;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  /** Altitude above mean sea level. */
  readonly altitudeM: number;
  readonly northM: number;
  readonly eastM: number;
  readonly downM: number;
  readonly northMps: number;
  readonly eastMps: number;
  readonly downMps: number;
  readonly rollDeg: number;
  readonly pitchDeg: number;
  readonly yawDeg: number;
  /** Body-frame angular rates. */
  readonly rollRateDegS: number;
  readonly pitchRateDegS: number;
  readonly yawRateDegS: number;
}

export interface MotorRecord {
  readonly kind: 'motor';
  readonly timeUs: number;
  /** Motor index, 0 to 15. */
  readonly motor: number;
  /** Normalized command. */
  readonly command: number;
  readonly rpm: number;
  readonly thrustN: number;
  readonly torqueNm: number;
  readonly currentA: number;
  readonly voltageV: number;
}

export type EventKind = 'note' | 'environment' | 'fault' | 'command';

export interface EventRecord {
  readonly kind: 'event';
  readonly timeUs: number;
  readonly event: EventKind;
  /** At most 64 UTF-8 bytes, no NUL. */
  readonly text: string;
}

export type ParameterStatus = 'requested' | 'confirmed' | 'rejected';

export interface ParameterChangeRecord {
  readonly kind: 'parameter';
  readonly timeUs: number;
  /** Request sequence tying a request to its outcome. */
  readonly sequence: number;
  readonly name: string;
  readonly requestedValue: number;
  /** Value before the change; null when unknown. */
  readonly previousValue: number | null;
  /** Value the autopilot reported; null when none was reported. */
  readonly confirmedValue: number | null;
  readonly status: ParameterStatus;
}

export type ExperimentRecord = TruthRecord | MotorRecord | EventRecord | ParameterChangeRecord;

export interface MirageMessage {
  readonly kind: ExperimentRecord['kind'];
  readonly type: number;
  readonly name: string;
  readonly format: string;
  readonly columns: readonly string[];
  readonly units: string;
  readonly multipliers: string;
}

const TRUTH_FIELDS = ['latitudeDeg', 'longitudeDeg', 'altitudeM', 'northM', 'eastM', 'downM', 'northMps', 'eastMps', 'downMps',
  'rollDeg', 'pitchDeg', 'yawDeg', 'rollRateDegS', 'pitchRateDegS', 'yawRateDegS'] as const;
const MOTOR_FIELDS = ['command', 'rpm', 'thrustN', 'torqueNm', 'currentA', 'voltageV'] as const;
const EVENTS: readonly EventKind[] = ['note', 'environment', 'fault', 'command'];
const STATUSES: readonly ParameterStatus[] = ['requested', 'confirmed', 'rejected'];

function define(m: MirageMessage): MirageMessage {
  return Object.freeze({ ...m, columns: Object.freeze([...m.columns]) });
}

export const MIRAGE_MESSAGES: readonly MirageMessage[] = Object.freeze([
  define({ kind: 'truth', type: 240, name: 'MSTR', format: 'QLLfffffffffffff',
    columns: ['TimeUS', 'Lat', 'Lng', 'Alt', 'PN', 'PE', 'PD', 'VN', 'VE', 'VD', 'Roll', 'Pitch', 'Yaw', 'GX', 'GY', 'GZ'],
    units: 'sDUmmmmnnndddkkk', multipliers: 'FGG0000000000000' }),
  define({ kind: 'motor', type: 241, name: 'MSMO', format: 'QBffffff',
    columns: ['TimeUS', 'Inst', 'Cmd', 'RPM', 'Thr', 'Trq', 'Curr', 'Volt'], units: 's#-qNtAv', multipliers: 'F--00000' }),
  define({ kind: 'event', type: 242, name: 'MSEV', format: 'QBZ', columns: ['TimeUS', 'Kind', 'Text'], units: 's--', multipliers: 'F--' }),
  define({ kind: 'parameter', type: 243, name: 'MSPC', format: 'QINfffB',
    columns: ['TimeUS', 'Seq', 'Name', 'Req', 'Old', 'Act', 'Stat'], units: 's------', multipliers: 'F------' }),
]);

/** UNIT and MULT tables; ArduPilot's identifiers, plus `N` for newton, which ArduPilot does not define. */
const UNITS: readonly [string, string][] = [['-', ''], ['#', 'instance'], ['s', 's'], ['D', 'deglatitude'], ['U', 'deglongitude'],
  ['m', 'm'], ['n', 'm/s'], ['d', 'deg'], ['k', 'deg/s'], ['q', 'rpm'], ['N', 'N'], ['t', 'N.m'], ['A', 'A'], ['v', 'V']];
const MULTIPLIERS: readonly [string, number][] = [['-', 0], ['0', 1], ['F', 1e-6], ['G', 1e-7]];

const SIZES: Readonly<Record<string, number>> = { B: 1, I: 4, L: 4, N: 16, Q: 8, Z: 64, b: 1, d: 8, f: 4, n: 4 };

const TYPE_FMT = 128, TYPE_FMTU = 118, TYPE_UNIT = 119, TYPE_MULT = 120;
const encoder = new TextEncoder();

function message(kind: ExperimentRecord['kind']): MirageMessage {
  const found = MIRAGE_MESSAGES.find(m => m.kind === kind);
  if (!found) throw new RangeError(`Unknown record kind ${kind}`);
  return found;
}

function length(format: string): number {
  let bytes = 3;
  for (const char of format) {
    const size = SIZES[char];
    if (size === undefined) throw new Error(`No size for format character ${char}`);
    bytes += size;
  }
  return bytes;
}

/** Encodes one record; values must already be validated. */
class RecordBuilder {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private at = 3;
  constructor(type: number, size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
    this.bytes.set([...HEAD, type]);
  }
  u8(value: number): this { this.view.setUint8(this.at, value); this.at += 1; return this; }
  i8(value: number): this { this.view.setInt8(this.at, value); this.at += 1; return this; }
  u32(value: number): this { this.view.setUint32(this.at, value, true); this.at += 4; return this; }
  i32(value: number): this { this.view.setInt32(this.at, value, true); this.at += 4; return this; }
  u64(value: number): this { this.view.setBigUint64(this.at, BigInt(value), true); this.at += 8; return this; }
  f32(value: number): this { this.view.setFloat32(this.at, value, true); this.at += 4; return this; }
  f64(value: number): this { this.view.setFloat64(this.at, value, true); this.at += 8; return this; }
  text(value: string, width: number): this {
    const bytes = encoder.encode(value);
    if (bytes.length > width) throw new RangeError(`Text longer than ${width} bytes`);
    this.bytes.set(bytes, this.at);
    this.at += width;
    return this;
  }
  done(): Uint8Array {
    if (this.at !== this.bytes.length) throw new Error('Record length mismatch');
    return this.bytes;
  }
}

function fmt(type: number, name: string, format: string, columns: readonly string[]): Uint8Array {
  const text = columns.join(',');
  if (encoder.encode(text).length > 64 || format.length > 16 || name.length > 4) throw new RangeError(`Message ${name} does not fit FMT`);
  return new RecordBuilder(TYPE_FMT, 89).u8(type).u8(length(format)).text(name, 4).text(format, 16).text(text, 64).done();
}

function fmtu(type: number, units: string, multipliers: string): Uint8Array {
  return new RecordBuilder(TYPE_FMTU, 44).u64(0).u8(type).text(units, 16).text(multipliers, 16).done();
}

function header(): Uint8Array[] {
  const out = [
    fmt(TYPE_FMT, 'FMT', 'BBnNZ', ['Type', 'Length', 'Name', 'Format', 'Columns']),
    fmt(TYPE_UNIT, 'UNIT', 'QbZ', ['TimeUS', 'Id', 'Label']),
    fmt(TYPE_MULT, 'MULT', 'Qbd', ['TimeUS', 'Id', 'Mult']),
    fmt(TYPE_FMTU, 'FMTU', 'QBNN', ['TimeUS', 'FmtType', 'UnitIds', 'MultIds']),
  ];
  for (const [id, label] of UNITS) out.push(new RecordBuilder(TYPE_UNIT, 76).u64(0).i8(id.charCodeAt(0)).text(label, 64).done());
  for (const [id, value] of MULTIPLIERS) out.push(new RecordBuilder(TYPE_MULT, 20).u64(0).i8(id.charCodeAt(0)).f64(value).done());
  for (const m of MIRAGE_MESSAGES) {
    out.push(fmt(m.type, m.name, m.format, m.columns));
    out.push(fmtu(m.type, m.units, m.multipliers));
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new RangeError(message);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || !expected.every(k => Object.hasOwn(value, k))) fail(`Record fields must be ${expected.join(', ')}`);
}

/** A finite number that stays finite in float32. */
function float32(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) fail(`${name} must be finite in float32`);
  return Math.fround(value);
}

function nullableFloat32(value: unknown, name: string): number {
  return value === null ? NaN : float32(value, name);
}

function integer(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail(`${name} must be an integer from 0 to ${max}`);
  return value;
}

function eventText(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || encoder.encode(value).length > 64) fail('text must be at most 64 UTF-8 bytes without NUL');
  return value;
}

function degrees(value: unknown, name: string, limit: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) fail(`${name} must be within ±${limit}`);
  return Math.round(value * 1e7);
}

/** Validates a record and encodes it. */
function encode(value: unknown): Uint8Array {
  if (!isObject(value) || typeof value.kind !== 'string') fail('Record must be an object with a kind');
  const timeUs = integer(value.timeUs, 'timeUs', Number.MAX_SAFE_INTEGER);
  switch (value.kind) {
    case 'truth': {
      keys(value, ['kind', 'timeUs', ...TRUTH_FIELDS]);
      const m = message('truth'), b = new RecordBuilder(m.type, length(m.format)).u64(timeUs)
        .i32(degrees(value.latitudeDeg, 'latitudeDeg', 90)).i32(degrees(value.longitudeDeg, 'longitudeDeg', 180));
      for (const field of TRUTH_FIELDS.slice(2)) b.f32(float32(value[field], field));
      return b.done();
    }
    case 'motor': {
      keys(value, ['kind', 'timeUs', 'motor', ...MOTOR_FIELDS]);
      const m = message('motor'), b = new RecordBuilder(m.type, length(m.format)).u64(timeUs).u8(integer(value.motor, 'motor', 15));
      for (const field of MOTOR_FIELDS) b.f32(float32(value[field], field));
      return b.done();
    }
    case 'event': {
      keys(value, ['kind', 'timeUs', 'event', 'text']);
      const kind = EVENTS.findIndex(e => e === value.event);
      if (kind < 0) fail(`event must be one of ${EVENTS.join(', ')}`);
      const m = message('event');
      return new RecordBuilder(m.type, length(m.format)).u64(timeUs).u8(kind).text(eventText(value.text), 64).done();
    }
    case 'parameter': {
      keys(value, ['kind', 'timeUs', 'sequence', 'name', 'requestedValue', 'previousValue', 'confirmedValue', 'status']);
      if (typeof value.name !== 'string' || !/^[A-Z0-9_]{1,16}$/.test(value.name)) fail('name must be 1 to 16 of A-Z, 0-9 and _');
      const status = STATUSES.findIndex(e => e === value.status);
      if (status < 0) fail(`status must be one of ${STATUSES.join(', ')}`);
      const m = message('parameter');
      return new RecordBuilder(m.type, length(m.format)).u64(timeUs).u32(integer(value.sequence, 'sequence', 0xffffffff))
        .text(value.name, 16).f32(float32(value.requestedValue, 'requestedValue'))
        .f32(nullableFloat32(value.previousValue, 'previousValue')).f32(nullableFloat32(value.confirmedValue, 'confirmedValue'))
        .u8(status).done();
    }
    default:
      return fail(`Unknown record kind ${value.kind}`);
  }
}

export class DataFlashWriter {
  private readonly parts: Uint8Array[] = header();
  private size = this.parts.reduce((n, p) => n + p.length, 0);

  /** Validates and appends one record; an invalid record throws RangeError and writes nothing. */
  append(record: unknown): void {
    const bytes = encode(record);
    this.parts.push(bytes);
    this.size += bytes.length;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

export function writeDataFlash(records: readonly unknown[]): Uint8Array {
  const writer = new DataFlashWriter();
  for (const record of records) writer.append(record);
  return writer.bytes();
}

/** Reads the MirageSITL records of a log back in file order; other messages are ignored. */
export function readExperimentRecords(log: DataFlashLog): ExperimentRecord[] {
  const kinds = log.groups.map(g => {
    const m = MIRAGE_MESSAGES.find(x => x.name === g.name);
    if (!m) return null;
    if (g.format !== m.format || g.columns.map(c => c.name).join() !== m.columns.join()) throw new RangeError(`${g.name} has an unexpected definition`);
    return m.kind;
  });
  const rows = new Uint32Array(log.groups.length), out: ExperimentRecord[] = [];
  for (const index of log.order) {
    const group = log.groups[index], kind = kinds[index], row = rows[index] ?? 0;
    rows[index] = row + 1;
    if (!group || !kind) continue;
    const n = (i: number) => {
      const value = group.columns[i]?.values[row];
      return value === undefined ? NaN : Number(value);
    };
    const nullable = (i: number) => (Number.isNaN(n(i)) ? null : n(i));
    const timeUs = n(0);
    if (!Number.isSafeInteger(timeUs)) throw new RangeError(`${group.name} TimeUS exceeds the safe integer range`);
    switch (kind) {
      case 'truth':
        out.push({ kind, timeUs, latitudeDeg: n(1), longitudeDeg: n(2), altitudeM: n(3), northM: n(4), eastM: n(5), downM: n(6),
          northMps: n(7), eastMps: n(8), downMps: n(9), rollDeg: n(10), pitchDeg: n(11), yawDeg: n(12),
          rollRateDegS: n(13), pitchRateDegS: n(14), yawRateDegS: n(15) });
        break;
      case 'motor':
        out.push({ kind, timeUs, motor: n(1), command: n(2), rpm: n(3), thrustN: n(4), torqueNm: n(5), currentA: n(6), voltageV: n(7) });
        break;
      case 'event': {
        const event = EVENTS[n(1)], column = group.columns[2];
        if (!event || !column) throw new RangeError(`MSEV kind ${n(1)} is not defined`);
        out.push({ kind, timeUs, event, text: columnText(column, row) });
        break;
      }
      case 'parameter': {
        const status = STATUSES[n(6)], column = group.columns[2];
        if (!status || !column) throw new RangeError(`MSPC status ${n(6)} is not defined`);
        out.push({ kind, timeUs, sequence: n(1), name: columnText(column, row), requestedValue: n(3),
          previousValue: nullable(4), confirmedValue: nullable(5), status });
        break;
      }
    }
  }
  return out;
}
