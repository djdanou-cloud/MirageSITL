// Recording format v2 (TASK-162). A record is a JSON header with the signal
// table, then binary chunks. A chunk holds rows; a row is one kept sample of
// one signal (or a gap or event). There is no row for a sample that was not
// kept or not produced, so an absent sample is never read as zero, and a
// row's presence mask marks the channels its source did not fill.
//
// Row (little-endian, padded to 8 bytes):
//   0 u16 signal ID      2 u16 flags          4 u32 presence mask (bit i: channel i)
//   8 u32 tick lo       12 u32 tick hi       16 f64 simulated time, s
//  24 u32 epoch         28 u32 rows lost immediately before this row (producer queue full)
//  32 u16 channel count 34 u16 payload bytes 36 u32 reserved zero
//  40 payload: channel values (f32 or f64 by the signal's type), or a parameter
//     row's 16-byte ASCII name and f32 value
// Chunk: a 48-byte header, then rows.
//   0 u32 magic "MRC2"   4 u32 version 2      8 u32 chunk index   12 u32 row count
//  16 u32 payload bytes 20 u32 first tick lo 24 u32 first tick hi 28 u32 last tick lo
//  32 u32 last tick hi  36 u32 record key    40 u32 reserved zero 44 u32 CRC-32/ISO-HDLC of
//     the whole chunk with bytes 44..47 taken as zero
import { MAX_CHANNELS, MAX_RATE_HZ, SIGNAL_CATALOG, SignalId, signalById, type PlannedSignal, type RatePlan } from "./signal-catalog.ts";

export const FORMAT_VERSION_V2 = 2;
export const ROW_HEADER_BYTES = 40;
/** The largest payload: 16 f64 channels. */
export const MAX_PAYLOAD_BYTES = MAX_CHANNELS * 8;
export const MAX_ROW_BYTES = ROW_HEADER_BYTES + MAX_PAYLOAD_BYTES;
export const CHUNK_HEADER_BYTES = 48;
export const CHUNK_MAGIC = 0x3243524d; // "MRC2"
/** Rows are flushed into a chunk of at most this many bytes. */
export const CHUNK_BYTES = 65536;

export const RowFlag = {
  /** A gap row: `lost` rows were dropped here; the row has no payload. */
  Gap: 1,
  /** A parameter row of the snapshot taken when the recording started, not a change. */
  Snapshot: 2,
} as const;
const ROW_FLAGS = RowFlag.Gap | RowFlag.Snapshot;

export const RowOffset = {
  signal: 0, flags: 2, presence: 4, tickLo: 8, tickHi: 12, simTimeS: 16, epoch: 24, lost: 28, channelCount: 32, payloadBytes: 34, reserved: 36,
} as const;

export function paddedRowBytes(payload: number): number {
  return (ROW_HEADER_BYTES + payload + 7) & ~7;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let crc = n;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  CRC_TABLE[n] = crc;
}
/** CRC-32/ISO-HDLC of a chunk with its checksum word (bytes 44..47) taken as zero. */
export function chunkCrc(chunk: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < chunk.length; i++) {
    const byte = i >= 44 && i < 48 ? 0 : chunk[i]!;
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface RecordHeaderV2 {
  readonly formatVersion: 2;
  /** 32 lowercase hex characters. */
  readonly recordId: string;
  /** The experiment record (TASK-154) this recording belongs to, or null. */
  readonly experimentId: string | null;
  readonly startedAt: string;
  readonly physicsHz: number;
  readonly commonHz: number;
  readonly modelSha256: string | null;
  readonly firmware: { readonly commit: string; readonly binarySha256: string } | null;
  readonly signals: readonly PlannedSignal[];
}

/** The first 4 bytes of the record ID, which every chunk carries so a chunk of another record is refused. */
export function recordKey(recordId: string): number {
  return Number.parseInt(recordId.slice(0, 8), 16) >>> 0;
}

export function headerFromPlan(plan: RatePlan, identity: Omit<RecordHeaderV2, "formatVersion" | "physicsHz" | "commonHz" | "signals">): RecordHeaderV2 {
  return parseRecordHeader({ formatVersion: FORMAT_VERSION_V2, ...identity, physicsHz: plan.physicsHz, commonHz: plan.commonHz,
    signals: plan.signals.map(signal => ({ ...signal, channels: signal.channels.map(c => ({ ...c })) })) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const HEADER_KEYS = ["commonHz", "experimentId", "firmware", "formatVersion", "modelSha256", "physicsHz", "recordId", "signals", "startedAt"];
const SIGNAL_KEYS = ["aperiodic", "capped", "channels", "effectiveHz", "group", "id", "name", "requestedHz", "source", "sourceHz", "valueType"];
const nullableRate = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_RATE_HZ);

/** Validates a header from `unknown`: the schema, and every signal against the catalog of this format version. */
export function parseRecordHeader(input: unknown): RecordHeaderV2 {
  if (!isRecord(input) || input.formatVersion !== FORMAT_VERSION_V2) throw new Error("Recording header: format version 2 expected");
  if (Object.keys(input).sort().join() !== HEADER_KEYS.join()) throw new Error("Recording header: unexpected or missing fields");
  const { recordId, experimentId, startedAt, physicsHz, commonHz, modelSha256, firmware, signals } = input;
  if (typeof recordId !== "string" || !/^[0-9a-f]{32}$/.test(recordId)) throw new Error("Recording header: invalid record ID");
  if (experimentId !== null && (typeof experimentId !== "string" || experimentId.length === 0 || experimentId.length > 128)) throw new Error("Recording header: invalid experiment ID");
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) throw new Error("Recording header: invalid start time");
  if (typeof physicsHz !== "number" || ![400, 800, 1200].includes(physicsHz)) throw new Error("Recording header: invalid physics rate");
  if (typeof commonHz !== "number" || !Number.isInteger(commonHz) || commonHz < 1 || commonHz > MAX_RATE_HZ) throw new Error("Recording header: invalid common rate");
  if (modelSha256 !== null && (typeof modelSha256 !== "string" || !/^[0-9a-f]{64}$/.test(modelSha256))) throw new Error("Recording header: invalid model hash");
  let identity: RecordHeaderV2["firmware"] = null;
  if (firmware !== null) {
    if (!isRecord(firmware) || Object.keys(firmware).sort().join() !== "binarySha256,commit") throw new Error("Recording header: invalid firmware identity");
    const { commit, binarySha256 } = firmware;
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) || typeof binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(binarySha256)) {
      throw new Error("Recording header: invalid firmware identity");
    }
    identity = Object.freeze({ commit, binarySha256 });
  }
  if (!Array.isArray(signals)) throw new Error("Recording header: a signal table expected");
  const list: unknown[] = signals;
  const seen = new Set<number>();
  const parsed = list.map((item, i): PlannedSignal => {
    const where = `Recording header: signal ${i}`;
    if (!isRecord(item) || Object.keys(item).sort().join() !== SIGNAL_KEYS.join()) throw new Error(`${where}: unexpected or missing fields`);
    const known = typeof item.id === "number" ? signalById(item.id) : undefined;
    if (!known || seen.has(known.id)) throw new Error(`${where}: unknown or repeated signal ID`);
    seen.add(known.id);
    // The descriptive fields must equal this version's catalog, so a reader never decodes with other units or channels.
    if (item.name !== known.name || item.group !== known.group || item.source !== known.source || item.valueType !== known.valueType ||
      JSON.stringify(item.channels) !== JSON.stringify(known.channels)) throw new Error(`${where}: does not match the catalog of format version 2`);
    const { sourceHz, requestedHz, effectiveHz, aperiodic, capped } = item;
    if (!nullableRate(sourceHz) || !nullableRate(requestedHz) || !nullableRate(effectiveHz) || typeof aperiodic !== "boolean" || typeof capped !== "boolean") {
      throw new Error(`${where}: invalid rates`);
    }
    if (known.source === "event") {
      if (sourceHz !== null || requestedHz !== null || effectiveHz !== null || capped) throw new Error(`${where}: an event has no rates`);
    } else if (sourceHz === null || requestedHz === null || effectiveHz === null || effectiveHz !== Math.min(requestedHz, sourceHz) || capped !== requestedHz > sourceHz) {
      throw new Error(`${where}: the effective rate must be min(requested, source) and capped must say whether the request exceeded the source`);
    }
    return Object.freeze({ ...known, sourceHz, aperiodic, requestedHz, effectiveHz, capped });
  });
  if (parsed.length !== SIGNAL_CATALOG.length) throw new Error("Recording header: every catalog signal must be listed");
  return Object.freeze({ formatVersion: FORMAT_VERSION_V2, recordId, experimentId, startedAt, physicsHz, commonHz, modelSha256,
    firmware: identity, signals: Object.freeze(parsed) });
}

/** One decoded row; `values` is null for a gap row, `parameter` set only on a parameter row. */
export interface DecodedRow {
  readonly signal: number;
  readonly flags: number;
  readonly presence: number;
  readonly tick: number;
  readonly simTimeS: number;
  readonly epoch: number;
  readonly lost: number;
  readonly values: readonly number[] | null;
  readonly parameter: { readonly name: string; readonly value: number } | null;
}
export interface DecodedChunk {
  readonly index: number;
  readonly firstTick: number;
  readonly lastTick: number;
  readonly rows: readonly DecodedRow[];
}

/** Checks one row at `at` of `view` and returns its padded length, or throws. Shared by the chunk writer and the reader. */
export function checkRow(view: DataView, at: number, end: number): number {
  if (at + ROW_HEADER_BYTES > end) throw new Error("Row header past the chunk end");
  const id = view.getUint16(at + RowOffset.signal, true), flags = view.getUint16(at + RowOffset.flags, true);
  const count = view.getUint16(at + RowOffset.channelCount, true), payload = view.getUint16(at + RowOffset.payloadBytes, true);
  if ((flags & ~ROW_FLAGS) !== 0 || view.getUint32(at + RowOffset.reserved, true) !== 0) throw new Error("Row with reserved bits set");
  if (!Number.isFinite(view.getFloat64(at + RowOffset.simTimeS, true))) throw new Error("Row with a non-finite time");
  if (flags & RowFlag.Gap) {
    if (id !== SignalId.Gap || count !== 0 || payload !== 0 || view.getUint32(at + RowOffset.lost, true) === 0) throw new Error("Invalid gap row");
  } else {
    const signal = signalById(id);
    if (!signal) throw new Error(`Row of unknown signal ${id}`);
    const expected = signal.valueType === "parameter" ? 20 : signal.channels.length * (signal.valueType === "f64" ? 8 : 4);
    if (count !== signal.channels.length || payload !== expected) throw new Error(`Row of ${signal.name} with the wrong size`);
    if ((flags & RowFlag.Snapshot) && signal.valueType !== "parameter") throw new Error("Snapshot flag outside a parameter row");
    const presence = view.getUint32(at + RowOffset.presence, true);
    if (count < 32 && presence >>> count !== 0) throw new Error("Presence bits beyond the channel count");
  }
  const length = paddedRowBytes(payload);
  if (at + length > end) throw new Error("Row past the chunk end");
  return length;
}

function decodeRow(view: DataView, bytes: Uint8Array, at: number): DecodedRow {
  const signal = view.getUint16(at + RowOffset.signal, true), flags = view.getUint16(at + RowOffset.flags, true);
  const tick = view.getUint32(at + RowOffset.tickHi, true) * 2 ** 32 + view.getUint32(at + RowOffset.tickLo, true);
  const base = { signal, flags, presence: view.getUint32(at + RowOffset.presence, true), tick, simTimeS: view.getFloat64(at + RowOffset.simTimeS, true),
    epoch: view.getUint32(at + RowOffset.epoch, true), lost: view.getUint32(at + RowOffset.lost, true) };
  if (flags & RowFlag.Gap) return { ...base, values: null, parameter: null };
  const info = signalById(signal);
  const payload = at + ROW_HEADER_BYTES;
  if (info?.valueType === "parameter") {
    let name = "";
    for (let i = 0; i < 16 && bytes[payload + i] !== 0; i++) name += String.fromCharCode(bytes[payload + i]!);
    return { ...base, values: null, parameter: { name, value: view.getFloat32(payload + 16, true) } };
  }
  const count = view.getUint16(at + RowOffset.channelCount, true), f64 = info?.valueType === "f64";
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(f64 ? view.getFloat64(payload + i * 8, true) : view.getFloat32(payload + i * 4, true));
  return { ...base, values, parameter: null };
}

/** Verifies and decodes one chunk of the record whose key is `key`. Throws on any inconsistency. */
export function decodeChunk(chunk: Uint8Array, key: number, expectedIndex: number): DecodedChunk {
  if (chunk.length < CHUNK_HEADER_BYTES || chunk.length > CHUNK_BYTES) throw new Error("Chunk size out of bounds");
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (view.getUint32(0, true) !== CHUNK_MAGIC || view.getUint32(4, true) !== FORMAT_VERSION_V2) throw new Error("Not a format v2 chunk");
  if (view.getUint32(44, true) !== chunkCrc(chunk)) throw new Error(`Chunk ${expectedIndex} fails its CRC-32`);
  const index = view.getUint32(8, true), rowCount = view.getUint32(12, true), payload = view.getUint32(16, true);
  if (index !== expectedIndex) throw new Error(`Chunk ${expectedIndex} carries index ${index}`);
  if (view.getUint32(36, true) !== key) throw new Error(`Chunk ${index} belongs to another record`);
  if (view.getUint32(40, true) !== 0 || CHUNK_HEADER_BYTES + payload !== chunk.length) throw new Error(`Chunk ${index} has an invalid header`);
  const rows: DecodedRow[] = [];
  let at = CHUNK_HEADER_BYTES;
  while (at < chunk.length) {
    const length = checkRow(view, at, chunk.length);
    rows.push(decodeRow(view, chunk, at));
    at += length;
  }
  if (rows.length !== rowCount) throw new Error(`Chunk ${index} declares ${rowCount} rows and holds ${rows.length}`);
  const firstTick = view.getUint32(24, true) * 2 ** 32 + view.getUint32(20, true), lastTick = view.getUint32(32, true) * 2 ** 32 + view.getUint32(28, true);
  return { index, firstTick, lastTick, rows };
}

/**
 * Accumulates rows into one chunk buffer (cold path in the recorder Worker,
 * no allocation per row). `seal` stamps the header and CRC and returns a copy.
 */
export class ChunkBuilder {
  private readonly bytes = new Uint8Array(CHUNK_BYTES);
  private readonly view = new DataView(this.bytes.buffer);
  private length = CHUNK_HEADER_BYTES;
  private rows = 0;
  private firstTick = -1;
  private lastTick = 0;
  constructor(private readonly key: number) {}
  get rowCount(): number { return this.rows; }
  get byteLength(): number { return this.length; }
  /** True when a row of `rowBytes` padded bytes still fits. */
  fits(rowBytes: number): boolean { return this.length + rowBytes <= CHUNK_BYTES; }
  /** Appends a checked row from `source` (padded length `rowBytes`); returns false when it does not fit. */
  append(source: Uint8Array, rowBytes: number): boolean {
    if (!this.fits(rowBytes)) return false;
    this.bytes.set(source.subarray(0, rowBytes), this.length);
    const tick = this.view.getUint32(this.length + RowOffset.tickHi, true) * 2 ** 32 + this.view.getUint32(this.length + RowOffset.tickLo, true);
    if (this.firstTick < 0 || tick < this.firstTick) this.firstTick = tick;
    if (tick > this.lastTick) this.lastTick = tick;
    this.length += rowBytes;
    this.rows++;
    return true;
  }
  seal(index: number): Uint8Array {
    const v = this.view, first = Math.max(this.firstTick, 0);
    v.setUint32(0, CHUNK_MAGIC, true); v.setUint32(4, FORMAT_VERSION_V2, true); v.setUint32(8, index, true); v.setUint32(12, this.rows, true);
    v.setUint32(16, this.length - CHUNK_HEADER_BYTES, true);
    v.setUint32(20, first % 2 ** 32, true); v.setUint32(24, Math.floor(first / 2 ** 32), true);
    v.setUint32(28, this.lastTick % 2 ** 32, true); v.setUint32(32, Math.floor(this.lastTick / 2 ** 32), true);
    v.setUint32(36, this.key, true); v.setUint32(40, 0, true); v.setUint32(44, 0, true);
    const chunk = this.bytes.slice(0, this.length);
    new DataView(chunk.buffer).setUint32(44, chunkCrc(chunk), true);
    this.length = CHUNK_HEADER_BYTES;
    this.rows = 0;
    this.firstTick = -1;
    this.lastTick = 0;
    return chunk;
  }
}
