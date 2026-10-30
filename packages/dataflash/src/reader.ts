/**
 * DataFlash log reader (TASK-178): self-describing ArduPilot `.BIN` logs, FMT records first.
 *
 * Record framing, resynchronization, field decoding and times follow pymavlink 2.4.50's
 * DFReader, which `mavlogdump.py` uses: a record is 0xA3 0x95, a defined type byte and the
 * body its FMT declares. Bytes that do not start a defined record are skipped up to the next
 * one and reported as a damaged range. This is a cold path: columns grow by doubling.
 */

const HEAD1 = 0xa3;
const HEAD2 = 0x95;
const FMT_TYPE = 128;
const FMT_LENGTH = 89;
/** GPS epoch 1980-01-06 in Unix seconds, as pymavlink computes it. */
const GPS_EPOCH_S = 86400 * 3657;
const GPS_WEEK_S = 604800;
const LEAP_SECONDS = 18;

export type DataFlashValues =
  | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array
  | Float32Array | Float64Array | BigInt64Array | BigUint64Array;

export interface DataFlashColumn {
  readonly name: string;
  /** The DataFlash format character. */
  readonly format: string;
  /** Row-major values: `width` elements per row (32 for `a`, the byte width for text). */
  readonly values: DataFlashValues;
  readonly width: number;
  /** Unit label from FMTU and UNIT, `''` where none is given. */
  readonly unit: string;
  /** MULT value from FMTU, `null` where none is given. */
  readonly multiplier: number | null;
  /** Factor from the stored value to `unit`: 1 where the format already scales it (c, C, e, E, L). */
  readonly valueScale: number;
  /** FMTU marks this column as the instance (`#`). */
  readonly instance: boolean;
}

export interface DataFlashGroup {
  readonly type: number;
  readonly name: string;
  readonly format: string;
  readonly count: number;
  readonly columns: readonly DataFlashColumn[];
  /** Byte offset of each record in the file. */
  readonly offsets: Float64Array;
  /** pymavlink's timestamp of each record in seconds (Unix time once a GPS week is logged). */
  readonly timestampsS: Float64Array;
}

export type DamageKind = 'skipped' | 'truncated' | 'bad-format';

export interface DamagedRange {
  readonly start: number;
  readonly end: number;
  readonly kind: DamageKind;
}

/** Plain, structured-cloneable result. */
export interface DataFlashLog {
  readonly bytes: number;
  readonly records: number;
  /** One group per message definition, in order of first definition. */
  readonly groups: readonly DataFlashGroup[];
  /** Group index of every record in file order. */
  readonly order: Uint16Array;
  readonly damaged: readonly DamagedRange[];
  /** `usec` reproduces pymavlink's microsecond clock; other clocks leave times NaN. */
  readonly clock: 'usec' | 'unsupported';
  readonly timebaseS: number;
}

interface FieldSpec {
  readonly size: number;
  /** Elements per row. */
  readonly width: number;
  readonly scale: number | null;
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  a: { size: 64, width: 32, scale: null },
  b: { size: 1, width: 1, scale: null },
  B: { size: 1, width: 1, scale: null },
  g: { size: 2, width: 1, scale: null },
  h: { size: 2, width: 1, scale: null },
  H: { size: 2, width: 1, scale: null },
  i: { size: 4, width: 1, scale: null },
  I: { size: 4, width: 1, scale: null },
  f: { size: 4, width: 1, scale: null },
  n: { size: 4, width: 4, scale: null },
  N: { size: 16, width: 16, scale: null },
  Z: { size: 64, width: 64, scale: null },
  c: { size: 2, width: 1, scale: 100 },
  C: { size: 2, width: 1, scale: 100 },
  e: { size: 4, width: 1, scale: 100 },
  E: { size: 4, width: 1, scale: 100 },
  L: { size: 4, width: 1, scale: 1e7 },
  d: { size: 8, width: 1, scale: null },
  M: { size: 1, width: 1, scale: null },
  q: { size: 8, width: 1, scale: null },
  Q: { size: 8, width: 1, scale: null },
};

function allocate(format: string, length: number): DataFlashValues {
  switch (format) {
    case 'b': case 'M': return new Int8Array(length);
    case 'B': case 'n': case 'N': case 'Z': return new Uint8Array(length);
    case 'h': case 'a': return new Int16Array(length);
    case 'H': return new Uint16Array(length);
    case 'i': return new Int32Array(length);
    case 'I': return new Uint32Array(length);
    case 'f': case 'g': return new Float32Array(length);
    case 'q': return new BigInt64Array(length);
    case 'Q': return new BigUint64Array(length);
    default: return new Float64Array(length);
  }
}

/** IEEE 754 binary16 to a number (exact in float32). */
function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 0x1f, fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** pymavlink's text: UTF-8, else Latin-1, then cut at the first NUL. */
export function decodeText(bytes: Uint8Array): string {
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    value = '';
    for (const byte of bytes) value += String.fromCharCode(byte);
  }
  const end = value.indexOf('\0');
  return end === -1 ? value : value.slice(0, end);
}

/** Text of one row of an n, N or Z column. */
export function columnText(column: DataFlashColumn, row: number): string {
  if (!(column.values instanceof Uint8Array) || row < 0 || row >= column.values.length / column.width) throw new RangeError('Not a text cell');
  return decodeText(column.values.subarray(row * column.width, (row + 1) * column.width));
}

function copyValues(target: DataFlashValues, source: DataFlashValues): void {
  if (target instanceof BigInt64Array) { if (source instanceof BigInt64Array) target.set(source); return; }
  if (target instanceof BigUint64Array) { if (source instanceof BigUint64Array) target.set(source); return; }
  if (!(source instanceof BigInt64Array) && !(source instanceof BigUint64Array)) target.set(source);
}

class ColumnBuilder {
  values: DataFlashValues;
  readonly spec: FieldSpec;
  constructor(readonly name: string, readonly format: string, readonly offset: number) {
    const spec = FIELDS[format];
    if (!spec) throw new RangeError(`Unknown format character ${format}`);
    this.spec = spec;
    this.values = allocate(format, 16 * spec.width);
  }
  ensure(rows: number): void {
    const needed = rows * this.spec.width;
    if (needed <= this.values.length) return;
    const grown = allocate(this.format, Math.max(needed, this.values.length * 2));
    copyValues(grown, this.values);
    this.values = grown;
  }
  read(view: DataView, at: number, row: number): void {
    const p = at + this.offset, v = this.values, w = this.spec.width;
    if (v instanceof BigInt64Array) { v[row] = view.getBigInt64(p, true); return; }
    if (v instanceof BigUint64Array) { v[row] = view.getBigUint64(p, true); return; }
    switch (this.format) {
      case 'b': case 'M': v[row] = view.getInt8(p); break;
      case 'B': v[row] = view.getUint8(p); break;
      case 'h': v[row] = view.getInt16(p, true); break;
      case 'H': v[row] = view.getUint16(p, true); break;
      case 'i': v[row] = view.getInt32(p, true); break;
      case 'I': v[row] = view.getUint32(p, true); break;
      case 'f': v[row] = view.getFloat32(p, true); break;
      case 'd': v[row] = view.getFloat64(p, true); break;
      case 'g': v[row] = half(view.getUint16(p, true)); break;
      // pymavlink divides by 100 or 1e7 rather than multiplying, for accuracy.
      case 'c': v[row] = view.getInt16(p, true) / 100; break;
      case 'C': v[row] = view.getUint16(p, true) / 100; break;
      case 'e': v[row] = view.getInt32(p, true) / 100; break;
      case 'E': v[row] = view.getUint32(p, true) / 100; break;
      case 'L': v[row] = view.getInt32(p, true) / 1e7; break;
      case 'a': for (let i = 0; i < 32; i++) v[row * w + i] = view.getInt16(p + 2 * i, true); break;
      default: for (let i = 0; i < w; i++) v[row * w + i] = view.getUint8(p + i);
    }
  }
  /** A numeric cell as a number (pymavlink converts 64-bit integers to float the same way). */
  number(row: number): number {
    const value = this.values[row * this.spec.width];
    return value === undefined ? NaN : Number(value);
  }
}

class GroupBuilder {
  count = 0;
  offsets = new Float64Array(16);
  readonly columns: ColumnBuilder[];
  private readonly byName: Map<string, number>;
  constructor(readonly id: number, readonly type: number, readonly name: string, readonly format: string,
    columns: readonly string[], readonly length: number) {
    let offset = 3;
    this.columns = columns.map((column, i) => {
      const builder = new ColumnBuilder(column, format.charAt(i), offset);
      offset += builder.spec.size;
      return builder;
    });
    this.byName = new Map(columns.map((column, i) => [column, i]));
  }
  same(name: string, format: string, columns: readonly string[], length: number): boolean {
    return this.name === name && this.format === format && this.length === length &&
      this.columns.length === columns.length && this.columns.every((c, i) => c.name === columns[i]);
  }
  add(view: DataView, at: number, offset: number): void {
    const row = this.count++;
    if (row >= this.offsets.length) {
      const grown = new Float64Array(this.offsets.length * 2);
      grown.set(this.offsets);
      this.offsets = grown;
    }
    this.offsets[row] = offset;
    for (const column of this.columns) {
      column.ensure(row + 1);
      column.read(view, at, row);
    }
  }
  column(name: string): ColumnBuilder | undefined {
    const i = this.byName.get(name);
    return i === undefined ? undefined : this.columns[i];
  }
  /** A numeric cell, or undefined when the column does not exist. */
  number(name: string, row: number): number | undefined {
    return this.column(name)?.number(row);
  }
  text(name: string, row: number): string {
    const column = this.column(name);
    if (!column || !(column.values instanceof Uint8Array)) return '';
    return decodeText(column.values.subarray(row * column.spec.width, (row + 1) * column.spec.width));
  }
}

function formatLength(format: string): number | null {
  let length = 3;
  for (const char of format) {
    const spec = FIELDS[char];
    if (!spec) return null;
    length += spec.size;
  }
  return length;
}

/** Incremental reader: `push` chunks in file order, then `finish` once. */
export class DataFlashReader {
  private readonly groups: GroupBuilder[] = [];
  /** Current definition of each type byte. */
  private readonly defined: (GroupBuilder | undefined)[] = new Array<GroupBuilder | undefined>(256);
  private readonly damaged: DamagedRange[] = [];
  private order = new Uint16Array(1024);
  private records = 0;
  private pending = new Uint8Array(0);
  /** Absolute offset of `pending[0]`. */
  private base = 0;
  private skipStart = -1;
  private finished = false;

  constructor() {
    const fmt = new GroupBuilder(0, FMT_TYPE, 'FMT', 'BBnNZ', ['Type', 'Length', 'Name', 'Format', 'Columns'], FMT_LENGTH);
    this.groups.push(fmt);
    this.defined[FMT_TYPE] = fmt;
  }

  push(chunk: Uint8Array): void {
    if (this.finished) throw new Error('DataFlash reader already finished');
    if (chunk.length === 0) return;
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    const used = this.parse(joined, false);
    this.pending = joined.slice(used);
    this.base += used;
  }

  finish(): DataFlashLog {
    if (this.finished) throw new Error('DataFlash reader already finished');
    this.finished = true;
    this.parse(this.pending, true);
    return this.result(this.base + this.pending.length);
  }

  private damage(start: number, end: number, kind: DamageKind): void {
    this.damaged.push(Object.freeze({ start, end, kind }));
  }

  private endSkip(at: number): void {
    if (this.skipStart < 0) return;
    this.damage(this.skipStart, at, 'skipped');
    this.skipStart = -1;
  }

  /**
   * Parses whole records and returns the bytes consumed. A skip ends at the next header with a
   * defined type, as in pymavlink; at the end of the file a record cut short is `truncated`.
   */
  private parse(data: Uint8Array, final: boolean): number {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;
    while (data.length - pos >= 3) {
      const group = data[pos] === HEAD1 && data[pos + 1] === HEAD2 ? this.defined[data[pos + 2] ?? 0] : undefined;
      if (!group) {
        if (this.skipStart < 0) this.skipStart = this.base + pos;
        pos++;
        continue;
      }
      if (data.length - pos < group.length) {
        if (!final) return pos;
        this.endSkip(this.base + pos);
        this.damage(this.base + pos, this.base + data.length, 'truncated');
        return data.length;
      }
      this.endSkip(this.base + pos);
      if (group.name === 'FMT' && !this.define(data, pos)) {
        this.damage(this.base + pos, this.base + pos + group.length, 'bad-format');
        pos += group.length;
        continue;
      }
      group.add(view, pos, this.base + pos);
      if (this.records >= this.order.length) {
        const grown = new Uint16Array(this.order.length * 2);
        grown.set(this.order);
        this.order = grown;
      }
      this.order[this.records++] = group.id;
      pos += group.length;
    }
    if (!final) return pos;
    if (pos < data.length && this.skipStart < 0) this.skipStart = this.base + pos;
    this.endSkip(this.base + data.length);
    return data.length;
  }

  /** Applies the FMT record at `at`; false if it is rejected. */
  private define(data: Uint8Array, at: number): boolean {
    const type = data[at + 3] ?? 0, length = data[at + 4] ?? 0;
    const name = decodeText(data.subarray(at + 5, at + 9));
    const format = decodeText(data.subarray(at + 9, at + 25));
    const text = decodeText(data.subarray(at + 25, at + 89));
    const columns = text === '' ? [] : text.split(',');
    if (formatLength(format) !== length || columns.length !== format.length || this.groups.length >= 0xffff) return false;
    const current = this.defined[type];
    if (current?.same(name, format, columns, length)) return true;
    // The built-in FMT definition cannot be replaced.
    if (type === FMT_TYPE) return false;
    const group = new GroupBuilder(this.groups.length, type, name, format, columns, length);
    this.groups.push(group);
    this.defined[type] = group;
    return true;
  }

  private result(bytes: number): DataFlashLog {
    const order = this.order.slice(0, this.records);
    const times = this.groups.map(g => new Float64Array(g.count));
    const clock = this.clock(order, times);
    const units = this.units();
    const groups = this.groups.map((g, i) => Object.freeze({
      type: g.type, name: g.name, format: g.format, count: g.count,
      offsets: g.offsets.slice(0, g.count),
      timestampsS: times[i] ?? new Float64Array(0),
      columns: Object.freeze(g.columns.map(c => {
        const unit = units.get(g)?.get(c.name);
        const multiplier = unit?.multiplier ?? null;
        return Object.freeze({
          name: c.name, format: c.format, width: c.spec.width,
          values: c.values.slice(0, g.count * c.spec.width),
          unit: unit?.unit ?? '', multiplier,
          valueScale: c.spec.scale !== null || !multiplier ? 1 : multiplier,
          instance: unit?.instance ?? false,
        });
      })),
    }));
    return Object.freeze({
      bytes, records: this.records, groups: Object.freeze(groups), order,
      damaged: Object.freeze(this.damaged.slice()), clock: clock.kind, timebaseS: clock.timebase,
    });
  }

  /** FMTU units against the final UNIT and MULT tables; the last FMTU of a type wins. */
  private units(): Map<GroupBuilder, Map<string, ColumnUnit>> {
    const unitTable = new Map<string, string>(), multTable = new Map<string, number>();
    const fmtu = new Map<number, { units: string; mults: string }>();
    for (const g of this.groups) {
      for (let row = 0; row < g.count; row++) {
        const id = String.fromCharCode((g.number('Id', row) ?? 0) & 0xff);
        if (g.name === 'UNIT') unitTable.set(id, g.text('Label', row));
        else if (g.name === 'MULT') multTable.set(id, g.number('Mult', row) ?? NaN);
        else if (g.name === 'FMTU') fmtu.set(g.number('FmtType', row) ?? -1, { units: g.text('UnitIds', row), mults: g.text('MultIds', row) });
      }
    }
    const result = new Map<GroupBuilder, Map<string, ColumnUnit>>();
    for (const g of this.groups) {
      const entry = fmtu.get(g.type);
      if (!entry || this.defined[g.type] !== g) continue;
      result.set(g, new Map(g.columns.map((c, i) => {
        const unitId = entry.units.charAt(i), multId = entry.mults.charAt(i);
        return [c.name, {
          unit: unitId === '' ? '' : unitTable.get(unitId) ?? '',
          multiplier: multId === '' ? null : multTable.get(multId) ?? null,
          instance: unitId === '#',
        }];
      })));
    }
    return result;
  }

  /** pymavlink's init_clock with its microsecond clock (DFReaderClock_usec); older clocks are unsupported. */
  private clock(order: Uint16Array, times: Float64Array[]): { kind: 'usec' | 'unsupported'; timebase: number } {
    const rows = new Uint32Array(order.length), counts = new Uint32Array(this.groups.length);
    for (let i = 0; i < order.length; i++) {
      const index = order[i] ?? 0, row = counts[index] ?? 0;
      rows[i] = row;
      counts[index] = row + 1;
    }
    // A modern GPS has TimeUS, GWk and GMS; the first one with GWk > 0 sets the timebase.
    let modern: Cell | null = null;
    for (let i = 0; i < order.length; i++) {
      const g = this.groups[order[i] ?? 0], row = rows[i] ?? 0;
      if (g?.name !== 'GPS') continue;
      if (!g.column('TimeUS') || !g.column('GWk') || !g.column('GMS')) break;
      modern = { g, row };
      if ((g.number('GWk', row) ?? 0) > 0) break;
    }
    let firstUs: number | undefined, fix: Cell | null = null, legacy = false;
    for (let i = 0; i < order.length; i++) {
      const g = this.groups[order[i] ?? 0], row = rows[i] ?? 0;
      if (!g) continue;
      if (firstUs === undefined) {
        firstUs = g.number('TimeUS', row);
        if (modern && firstUs !== undefined) {
          if ((modern.g.number('GWk', modern.row) ?? 0) > 0) fix = modern;
          break;
        }
      }
      if (g.name === 'GPS' || g.name === 'GPS2') {
        if ((g.number('TimeUS', row) ?? 0) !== 0 && (g.number('GWk', row) ?? 0) !== 0) { fix = { g, row }; break; }
        if ((g.number('T', row) ?? 0) !== 0 || (g.number('Week', row) ?? 0) !== 0 || (g.number('GPSTime', row) ?? 0) !== 0) { legacy = true; break; }
      } else if (g.name === 'TIME' && g.column('StartTime')) { legacy = true; break; }
    }
    if (legacy || firstUs === undefined) {
      for (const t of times) t.fill(NaN);
      return { kind: 'unsupported', timebase: NaN };
    }
    let timebase = 0, current = 0;
    if (fix) {
      const t = GPS_EPOCH_S + GPS_WEEK_S * (fix.g.number('GWk', fix.row) ?? 0) + (fix.g.number('GMS', fix.row) ?? 0) * 0.001 - LEAP_SECONDS;
      timebase = t - (fix.g.number('TimeUS', fix.row) ?? 0) * 0.000001;
      current = timebase + firstUs * 0.000001;
    }
    for (let i = 0; i < order.length; i++) {
      const index = order[i] ?? 0, g = this.groups[index], row = rows[i] ?? 0, out = times[index];
      if (!g || !out) continue;
      const first = g.columns[0];
      if (!first) { out[row] = 0; continue; }
      if (first.name === 'TimeUS') current = timebase + first.number(row) * 0.000001;
      else if (first.name === 'TimeMS' && !g.name.startsWith('ACC') && !g.name.startsWith('GYR') &&
        !(timebase + first.number(row) * 0.001 < current)) current = timebase + first.number(row) * 0.001;
      out[row] = current;
    }
    return { kind: 'usec', timebase };
  }
}

interface Cell { readonly g: GroupBuilder; readonly row: number }
interface ColumnUnit { readonly unit: string; readonly multiplier: number | null; readonly instance: boolean }

/** Reads a complete log held in memory. */
export function readDataFlash(bytes: Uint8Array): DataFlashLog {
  const reader = new DataFlashReader();
  reader.push(bytes);
  return reader.finish();
}

/** Reads a Blob or buffer in chunks, reporting the bytes read after each chunk. */
export async function parseSource(source: Blob | ArrayBuffer | Uint8Array, chunkBytes: number,
  onProgress: (bytes: number, total: number) => void): Promise<DataFlashLog> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new RangeError('chunkBytes must be a positive integer');
  const reader = new DataFlashReader();
  if (source instanceof Blob) {
    for (let at = 0; at < source.size; at += chunkBytes) {
      reader.push(new Uint8Array(await source.slice(at, at + chunkBytes).arrayBuffer()));
      onProgress(Math.min(at + chunkBytes, source.size), source.size);
    }
  } else {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    for (let at = 0; at < bytes.length; at += chunkBytes) {
      reader.push(bytes.subarray(at, at + chunkBytes));
      onProgress(Math.min(at + chunkBytes, bytes.length), bytes.length);
    }
  }
  return reader.finish();
}

/** The buffers of a log, for a Worker's transfer list. */
export function transferables(log: DataFlashLog): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  const add = (view: { buffer: ArrayBufferLike }) => { if (view.buffer instanceof ArrayBuffer) buffers.push(view.buffer); };
  add(log.order);
  for (const group of log.groups) {
    add(group.offsets);
    add(group.timestampsS);
    for (const column of group.columns) add(column.values);
  }
  return buffers;
}
