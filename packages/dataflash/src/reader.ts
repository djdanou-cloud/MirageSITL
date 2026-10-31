// ArduPilot DataFlash log reader (TASK-178, S14/S15). Logs are self-describing:
// FMT records define every other record type, FMTU/UNIT/MULT give units. The
// reader accepts arbitrary chunks, keeps only the unparsed tail, and reports
// every damaged byte range instead of stopping. Values follow pymavlink
// 2.4.50 DFReader exactly (scaling, strings, units and its microsecond clock),
// which is the test oracle. Configuration/analysis code, never a physics step.

export type DamageReason = "bad-header" | "unknown-type" | "invalid-format" | "truncated";
export interface DamagedRange {
  /** Byte offsets in the whole log, [start, end). */
  readonly start: number;
  readonly end: number;
  readonly reason: DamageReason;
}
export interface DataflashFormat {
  readonly type: number;
  readonly name: string;
  /** Whole record length, header included. */
  readonly length: number;
  readonly format: string;
  readonly columns: readonly string[];
  /** Unit label per column from FMTU/UNIT/MULT, or null when the log gives none. */
  units: string[] | null;
  instanceField: string | null;
}
export type Column = Float64Array | string[] | Int16Array[] | Uint8Array[];
export interface MessageTable {
  readonly name: string;
  readonly format: DataflashFormat;
  readonly count: number;
  /** One column per field, in FMT order; numbers are already scaled as DFReader scales them. */
  readonly columns: Readonly<Record<string, Column>>;
  /** DFReader's zero-time-base timestamp of each record, in seconds. */
  readonly timestampS: Float64Array;
  /** Byte offset of each record. */
  readonly offsets: Float64Array;
}
export interface DataflashLog {
  readonly bytes: number;
  readonly formats: ReadonlyMap<number, DataflashFormat>;
  readonly tables: ReadonlyMap<string, MessageTable>;
  readonly damaged: readonly DamagedRange[];
  /**
   * DFReader's time base from the first GPS record with a valid week, in Unix
   * seconds: add it to timestampS for absolute time. Null without one.
   */
  readonly gpsTimeBaseS: number | null;
}

const HEAD1 = 0xa3, HEAD2 = 0x95, FMT_TYPE = 0x80;
/** Field sizes of the pinned DFReader FORMAT_TO_STRUCT table. */
const SIZE: Readonly<Record<string, number>> = {
  a: 64, b: 1, B: 1, g: 2, h: 2, H: 2, i: 4, I: 4, f: 4, n: 4, N: 16, Z: 64,
  c: 2, C: 2, e: 4, E: 4, L: 4, d: 8, M: 1, q: 8, Q: 8,
};
/** Format characters with DFReader's own multiplier. */
const MULTIPLIER: Readonly<Record<string, number>> = { c: 0.01, C: 0.01, e: 0.01, E: 0.01, L: 1.0e-7 };
const STRING_FORMATS = "nNZ";
/** DFReader MULT_TO_PREFIX. */
const PREFIX = new Map<number, string>([[0, ""], [1, ""], [1e-1, "d"], [1e-2, "c"], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"]]);
const GPS_EPOCH_S = 86400 * (10 * 365 + Math.floor((1980 - 1969) / 4) + 1 + 6 - 2);

/** Python's "%.4g". */
function formatG4(value: number): string {
  if (value === 0) return "0";
  const exponent = Number(value.toExponential(3).split("e")[1]);
  if (exponent < -4 || exponent >= 4) {
    const [mantissa = "", power = "0"] = value.toExponential(3).split("e");
    const trimmed = mantissa.includes(".") ? mantissa.replace(/0+$/, "").replace(/\.$/, "") : mantissa;
    const sign = power.startsWith("-") ? "-" : "+";
    return `${trimmed}e${sign}${power.replace(/^[-+]/, "").padStart(2, "0")}`;
  }
  const fixed = value.toFixed(Math.max(0, 3 - exponent));
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
function halfToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 0x1f, fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}
const utf8 = new TextDecoder("utf-8", { fatal: true }), latin1 = new TextDecoder("latin1");
function text(bytes: Uint8Array): string {
  let decoded: string;
  try {
    decoded = utf8.decode(bytes);
  } catch {
    decoded = latin1.decode(bytes);
  }
  const end = decoded.indexOf("\0");
  return end === -1 ? decoded : decoded.slice(0, end);
}

type Kind = "number" | "string" | "array" | "bytes";
class Builder {
  count = 0;
  readonly kinds: Kind[];
  numbers: Float64Array[];
  readonly strings: string[][];
  readonly arrays: Int16Array[][];
  readonly bytes: Uint8Array[][];
  timestamps = new Float64Array(16);
  offsets = new Float64Array(16);
  constructor(readonly format: DataflashFormat) {
    this.kinds = [...format.format].map(char => (char === "a" ? "array" : char === "Z" && format.name === "FILE" ? "bytes" : STRING_FORMATS.includes(char) ? "string" : "number"));
    this.numbers = this.kinds.map(kind => new Float64Array(kind === "number" ? 16 : 0));
    this.strings = this.kinds.map(() => []);
    this.arrays = this.kinds.map(() => []);
    this.bytes = this.kinds.map(() => []);
  }
  grow(): void {
    const capacity = this.timestamps.length * 2;
    const extend = (array: Float64Array) => { const next = new Float64Array(capacity); next.set(array); return next; };
    this.timestamps = extend(this.timestamps);
    this.offsets = extend(this.offsets);
    this.numbers = this.numbers.map(array => (array.length === 0 ? array : extend(array)));
  }
  column(i: number): Column {
    switch (this.kinds[i]) {
      case "number": return this.numbers[i]!.slice(0, this.count);
      case "string": return this.strings[i]!;
      case "array": return this.arrays[i]!;
      default: return this.bytes[i]!;
    }
  }
  set(i: number, row: number, value: number | string | Int16Array | Uint8Array): void {
    if (typeof value === "number") this.numbers[i]![row] = value;
    else if (typeof value === "string") this.strings[i]!.push(value);
    else if (value instanceof Int16Array) this.arrays[i]!.push(value);
    else this.bytes[i]!.push(value);
  }
}

export class DataflashReader {
  private buffer = new Uint8Array(1 << 16);
  private length = 0;
  /** Absolute offset of buffer[0]. */
  private base = 0;
  private readonly formats = new Map<number, DataflashFormat>([[FMT_TYPE, {
    type: FMT_TYPE, name: "FMT", length: 89, format: "BBnNZ", columns: ["Type", "Length", "Name", "Format", "Columns"], units: null, instanceField: null,
  }]]);
  private readonly builders = new Map<string, Builder>();
  private readonly damaged: DamagedRange[] = [];
  private readonly unitLookup = new Map<string, string>();
  private readonly multLookup = new Map<number, number>();
  private skipStart = -1;
  private skipReason: DamageReason = "bad-header";
  private previousTimestamp = 0;
  private gpsTimeBaseS: number | null = null;
  private finished = false;

  /** Appends one chunk of any size and parses every complete record. */
  push(chunk: Uint8Array): void {
    if (this.finished) throw new Error("The DataFlash reader is finished");
    if (this.length + chunk.length > this.buffer.length) {
      const next = new Uint8Array(Math.max(this.buffer.length * 2, this.length + chunk.length));
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
    this.parse(false);
  }

  /** Ends the log: a trailing partial record is reported as truncated. */
  finish(): DataflashLog {
    if (!this.finished) {
      this.parse(true);
      this.finished = true;
    }
    const tables = new Map<string, MessageTable>();
    for (const [name, builder] of this.builders) {
      const columns: Record<string, Column> = {};
      builder.format.columns.forEach((column, i) => { columns[column] = builder.column(i); });
      tables.set(name, {
        name, format: builder.format, count: builder.count, columns,
        timestampS: builder.timestamps.slice(0, builder.count), offsets: builder.offsets.slice(0, builder.count),
      });
    }
    return { bytes: this.base + this.length, formats: this.formats, tables, damaged: this.damaged, gpsTimeBaseS: this.gpsTimeBaseS };
  }

  private parse(final: boolean): void {
    let at = 0;
    while (true) {
      const remaining = this.length - at;
      if (remaining < 3) break;
      const b = this.buffer;
      const known = b[at] === HEAD1 && b[at + 1] === HEAD2 && this.formats.has(b[at + 2]!);
      if (!known) {
        if (this.skipStart < 0) {
          this.skipStart = this.base + at;
          this.skipReason = b[at] === HEAD1 && b[at + 1] === HEAD2 ? "unknown-type" : "bad-header";
        }
        at++;
        continue;
      }
      // The header check above found the format.
      const format = this.formats.get(b[at + 2]!)!;
      if (remaining < format.length) break;
      this.endSkip(this.base + at);
      const start = at;
      at += format.length;
      if (!this.record(format, start)) {
        this.damaged.push({ start: this.base + start, end: this.base + at, reason: "invalid-format" });
      }
    }
    if (final) {
      this.endSkip(this.base + at);
      if (at < this.length) this.damaged.push({ start: this.base + at, end: this.base + this.length, reason: "truncated" });
      at = this.length;
    }
    // Keep only the unparsed tail.
    this.buffer.copyWithin(0, at, this.length);
    this.length -= at;
    this.base += at;
  }

  private endSkip(end: number): void {
    if (this.skipStart >= 0) {
      this.damaged.push({ start: this.skipStart, end, reason: this.skipReason });
      this.skipStart = -1;
    }
  }

  /** Decodes one record; false for an FMT record that defines an impossible format. */
  private record(format: DataflashFormat, start: number): boolean {
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + start + 3, format.length - 3);
    const values: (number | string | Int16Array | Uint8Array)[] = [];
    let offset = 0;
    for (const char of format.format) {
      values.push(this.value(view, offset, char, format.name));
      // The format was checked against its length when it was defined.
      offset += SIZE[char]!;
    }
    if (format.type === FMT_TYPE) {
      const [type, length, name, fmt, columns] = values;
      if (typeof type !== "number" || typeof length !== "number" || typeof name !== "string" || typeof fmt !== "string" || typeof columns !== "string") return false;
      let size = 3;
      for (const char of fmt) {
        const width = SIZE[char];
        if (width === undefined) return false;
        size += width;
      }
      // Logs begin by defining FMT itself; only its own layout is accepted for it.
      if (size !== length || (type === FMT_TYPE && fmt !== "BBnNZ")) return false;
      const old = this.formats.get(type);
      const defined: DataflashFormat = { type, name, length, format: fmt, columns: columns === "" ? [] : columns.split(","), units: old?.units ?? null, instanceField: null };
      if (old?.instanceField) defined.instanceField = old.instanceField;
      this.formats.set(type, defined);
    }
    this.store(format, values, start);
    if (format.name === "UNIT" || format.name === "MULT" || format.name === "FMTU") this.units(format, values);
    if (format.name === "GPS" && this.gpsTimeBaseS === null) this.gps(format, values);
    return true;
  }

  private value(view: DataView, offset: number, char: string, name: string): number | string | Int16Array | Uint8Array {
    switch (char) {
      case "b": case "M": return view.getInt8(offset);
      case "B": return view.getUint8(offset);
      case "h": return view.getInt16(offset, true);
      case "H": return view.getUint16(offset, true);
      case "i": return view.getInt32(offset, true);
      case "I": return view.getUint32(offset, true);
      case "f": return view.getFloat32(offset, true);
      case "d": return view.getFloat64(offset, true);
      case "g": return halfToNumber(view.getUint16(offset, true));
      case "q": return Number(view.getBigInt64(offset, true));
      case "Q": return Number(view.getBigUint64(offset, true));
      case "c": return view.getInt16(offset, true) / (1 / MULTIPLIER.c!);
      case "C": return view.getUint16(offset, true) / (1 / MULTIPLIER.C!);
      case "e": return view.getInt32(offset, true) / (1 / MULTIPLIER.e!);
      case "E": return view.getUint32(offset, true) / (1 / MULTIPLIER.E!);
      case "L": return view.getInt32(offset, true) / (1 / MULTIPLIER.L!);
      case "a": {
        const out = new Int16Array(32);
        for (let i = 0; i < 32; i++) out[i] = view.getInt16(offset + i * 2, true);
        return out;
      }
      default: {
        const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, SIZE[char]).slice();
        // DFReader keeps FILE's Z field as raw bytes.
        return char === "Z" && name === "FILE" ? bytes : text(bytes);
      }
    }
  }

  private store(format: DataflashFormat, values: readonly (number | string | Int16Array | Uint8Array)[], start: number): void {
    let builder = this.builders.get(format.name);
    if (!builder || builder.format.format !== format.format) {
      // A redefinition with another layout starts a new table under the same name.
      builder = new Builder(format);
      this.builders.set(format.name, builder);
    }
    if (builder.count === builder.timestamps.length) builder.grow();
    const row = builder.count++;
    values.forEach((value, i) => builder.set(i, row, value));
    builder.offsets[row] = this.base + start;
    // DFReaderClock_usec with a zero time base: a record whose first field is
    // TimeUS gives the time; any other repeats the previous time, 0 at first.
    const timestamp = format.columns[0] === "TimeUS" ? 0 + Number(values[0]) * 0.000001 : this.previousTimestamp;
    builder.timestamps[row] = timestamp;
    this.previousTimestamp = timestamp;
  }

  private units(format: DataflashFormat, values: readonly (number | string | Int16Array | Uint8Array)[]): void {
    const get = (column: string) => values[format.columns.indexOf(column)];
    if (format.name === "UNIT") {
      const id = get("Id"), label = get("Label");
      if (typeof id === "number" && id >= 0 && typeof label === "string") this.unitLookup.set(String.fromCharCode(id), label);
    } else if (format.name === "MULT") {
      const id = get("Id"), mult = get("Mult");
      // DFReader rounds multipliers to 7 significant digits.
      if (typeof id === "number" && id >= 0 && typeof mult === "number") this.multLookup.set(id, Number(mult.toPrecision(7)));
    } else {
      const type = get("FmtType"), unitIds = get("UnitIds"), multIds = get("MultIds");
      const target = typeof type === "number" ? this.formats.get(type) : undefined;
      if (!target || typeof unitIds !== "string" || typeof multIds !== "string") return;
      const instance = unitIds.indexOf("#");
      if (instance !== -1 && instance < target.columns.length) target.instanceField = target.columns[instance]!;
      const units = target.columns.map((_, i) => (i < unitIds.length ? this.unitLookup.get(unitIds[i]!) ?? "" : ""));
      units.forEach((unit, i) => {
        if (MULTIPLIER[target.format[i] ?? ""] !== undefined || unit === "" || i >= multIds.length) return;
        const mult = this.multLookup.get(multIds.charCodeAt(i));
        if (mult === undefined) return;
        const prefix = PREFIX.get(mult);
        units[i] = prefix !== undefined ? prefix + unit : `${formatG4(mult)} ${unit}`;
      });
      target.units = units;
    }
  }

  private gps(format: DataflashFormat, values: readonly (number | string | Int16Array | Uint8Array)[]): void {
    const week = values[format.columns.indexOf("GWk")], ms = values[format.columns.indexOf("GMS")], timeUs = values[format.columns.indexOf("TimeUS")];
    if (typeof week !== "number" || typeof ms !== "number" || typeof timeUs !== "number" || week <= 0) return;
    // DFReaderClock._gpsTimeToTime and DFReaderClock_usec.find_time_base, in their evaluation order.
    const t = GPS_EPOCH_S + 86400 * 7 * week + ms * 0.001 - 18;
    this.gpsTimeBaseS = t - timeUs * 0.000001;
  }
}

/** Parses a whole log held in memory, in chunks of `chunkBytes`. */
export function readDataflash(bytes: Uint8Array, chunkBytes = 1 << 16): DataflashLog {
  const reader = new DataflashReader();
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) reader.push(bytes.subarray(offset, offset + chunkBytes));
  return reader.finish();
}
