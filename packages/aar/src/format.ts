// After-action review (AAR) recording format v1 (TASK-076).
//
// Records are fixed 128-byte little-endian slots:
//   0  u32 kind            (RecordKind)
//   4  u32 epoch           (physics epoch; a change breaks continuity)
//   8  u32 tick low  12 u32 tick high   (physics tick, 64-bit)
//   16 f64 simTimeS        (simulation time domain: seconds since epoch start)
//   24 f64 wallTimeMs      (wall time domain: performance.now() of the producer)
//   32 f64 x 12 values     (meaning per kind, see RECORD_VALUE_NAMES)
// Chunks hold up to `chunkRecords` records plus a 32-byte header with a CRC32
// of the payload. A session manifest names the format version, model hashes,
// seed, rates and time domains. The physics side writes into a dedicated
// recording queue (its own SharedArrayBuffer): the render state ring and the
// sensor/actuator SPSC queues are never read as an archive or given a second
// consumer. A full recording queue drops the record and counts it; it never
// blocks physics.

export const AAR_FORMAT = "mirage.aar";
export const AAR_VERSION = 1;
export const RECORD_BYTES = 128;
export const RECORD_VALUES = 12;
export const CHUNK_HEADER_BYTES = 32;
export const CHUNK_MAGIC = 0x4b484341; // "ACHK"

export const RecordKind = { Input: 1, Actuator: 2, Truth: 3, Sensor: 4, Event: 5, Gap: 6 } as const;
export type RecordKindValue = typeof RecordKind[keyof typeof RecordKind];
const KIND_VALUES: readonly number[] = Object.values(RecordKind);
export function isRecordKind(value: number): value is RecordKindValue { return KIND_VALUES.includes(value); }

/** Documented value layout per kind (units in names). */
export const RECORD_VALUE_NAMES: Readonly<Record<RecordKindValue, readonly string[]>> = {
  1: ["rollCmd", "pitchCmd", "yawCmd", "throttleCmd", "deviceGeneration", "armRequest"],
  2: ["motor0", "motor1", "motor2", "motor3", "motor4", "motor5", "motor6", "motor7"],
  3: ["northM", "eastM", "downM", "vnMps", "veMps", "vdMps", "qw", "qx", "qy", "qz", "pRadS", "qRadS"],
  4: ["sensorId", "v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10"],
  5: ["eventCode", "a0", "a1", "a2", "a3"],
  6: ["lostRecords", "fromTick", "toTick", "reasonCode"], // queue drops: from = to = tick of the last record before the loss
};
/** Gap reason codes. */
export const GapReason = { QueueFull: 1, StorageBackpressure: 2 } as const;

export interface SessionManifest {
  format: typeof AAR_FORMAT;
  version: typeof AAR_VERSION;
  sessionId: string;
  createdUtc: string;
  seed: number;
  physicsHz: 400 | 800 | 1200;
  /** SHA-256 of the physics build and airframe/model configuration. */
  modelHashes: { physics: string; airframe: string };
  timeDomains: { sim: "s since epoch start"; wall: "ms performance.now() of producer" };
  chunkRecords: number;
  /** Fixed ring size: retained bytes never exceed this. */
  ringBytes: number;
  ringSeconds: number;
}

const SHA = /^[a-f0-9]{64}$/;
export function parseManifest(value: unknown): SessionManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid AAR manifest");
  const keys = ["format", "version", "sessionId", "createdUtc", "seed", "physicsHz", "modelHashes", "timeDomains", "chunkRecords", "ringBytes", "ringSeconds"];
  if (Object.keys(value).length !== keys.length || !keys.every(k => k in value)) throw new Error("Invalid AAR manifest fields");
  const m = value as Record<string, unknown>;
  if (m.format !== AAR_FORMAT) throw new Error("Not an AAR manifest");
  if (m.version !== AAR_VERSION) throw new Error(`Unsupported AAR version ${String(m.version)}`);
  const hashes = m.modelHashes, domains = m.timeDomains;
  if (typeof m.sessionId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(m.sessionId) || typeof m.createdUtc !== "string" || !Number.isFinite(Date.parse(m.createdUtc)) ||
    typeof m.seed !== "number" || !Number.isInteger(m.seed) || m.seed < 0 || m.seed > 0xffffffff ||
    (m.physicsHz !== 400 && m.physicsHz !== 800 && m.physicsHz !== 1200) ||
    typeof hashes !== "object" || hashes === null || !("physics" in hashes) || !("airframe" in hashes) ||
    typeof hashes.physics !== "string" || !SHA.test(hashes.physics) || typeof hashes.airframe !== "string" || !SHA.test(hashes.airframe) ||
    typeof domains !== "object" || domains === null || !("sim" in domains) || !("wall" in domains) ||
    domains.sim !== "s since epoch start" || domains.wall !== "ms performance.now() of producer" ||
    typeof m.chunkRecords !== "number" || !Number.isInteger(m.chunkRecords) || m.chunkRecords < 16 || m.chunkRecords > 65536 ||
    typeof m.ringSeconds !== "number" || !(m.ringSeconds >= 1 && m.ringSeconds <= 7200) ||
    typeof m.ringBytes !== "number" || !Number.isInteger(m.ringBytes) || m.ringBytes < chunkBytes(m.chunkRecords) * 2 || m.ringBytes > 2 ** 32) {
    throw new Error("Invalid AAR manifest values");
  }
  return {
    format: AAR_FORMAT, version: AAR_VERSION, sessionId: m.sessionId, createdUtc: m.createdUtc, seed: m.seed, physicsHz: m.physicsHz,
    modelHashes: { physics: hashes.physics, airframe: hashes.airframe }, timeDomains: { sim: domains.sim, wall: domains.wall },
    chunkRecords: m.chunkRecords, ringBytes: m.ringBytes, ringSeconds: m.ringSeconds,
  };
}

export function chunkBytes(records: number): number { return CHUNK_HEADER_BYTES + records * RECORD_BYTES; }

/**
 * Fixed ring size for `ringSeconds` at `recordsPerSecond`, rounded up to whole
 * chunks plus one chunk of slack for the chunk being filled.
 */
export function ringBytesFor(ringSeconds: number, recordsPerSecond: number, chunkRecords: number): number {
  const chunks = Math.ceil((ringSeconds * recordsPerSecond) / chunkRecords) + 1;
  return chunks * chunkBytes(chunkRecords);
}

// ---- CRC32 (IEEE 802.3, reflected 0xEDB88320) ----------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8); // indices < 256 / length
  return (c ^ 0xffffffff) >>> 0;
}

/** Chunk header: magic, version, sequence, record count, first/last tick (low words), payload CRC32, epoch of first record. */
export interface ChunkInfo { sequence: number; records: number; firstTick: number; lastTick: number; crc: number; firstEpoch: number }

export function writeChunkHeader(view: DataView, info: ChunkInfo): void {
  view.setUint32(0, CHUNK_MAGIC, true); view.setUint32(4, AAR_VERSION, true); view.setUint32(8, info.sequence, true); view.setUint32(12, info.records, true);
  view.setFloat64(16, info.firstTick, true); view.setUint32(24, info.crc, true); view.setUint32(28, info.firstEpoch, true);
}

/** Validates magic, version, size and CRC before any record is decoded. */
export function readChunk(bytes: Uint8Array): ChunkInfo {
  if (bytes.byteLength < CHUNK_HEADER_BYTES) throw new Error("AAR chunk too short");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== CHUNK_MAGIC) throw new Error("Not an AAR chunk");
  if (v.getUint32(4, true) !== AAR_VERSION) throw new Error("Unsupported AAR chunk version");
  const records = v.getUint32(12, true);
  if (bytes.byteLength !== chunkBytes(records)) throw new Error("AAR chunk size does not match its record count");
  const crc = v.getUint32(24, true);
  if (crc32(bytes, CHUNK_HEADER_BYTES) !== crc) throw new Error("AAR chunk checksum mismatch");
  const lastTick = records > 0 ? recordTick(v, CHUNK_HEADER_BYTES + (records - 1) * RECORD_BYTES) : 0;
  return { sequence: v.getUint32(8, true), records, firstTick: v.getFloat64(16, true), lastTick, crc, firstEpoch: v.getUint32(28, true) };
}

export function recordTick(v: DataView, offset: number): number {
  return v.getUint32(offset + 8, true) + v.getUint32(offset + 12, true) * 4294967296;
}

/** Decoded record (low rate: replay/export, not the physics path). */
export interface AarRecord { kind: RecordKindValue; epoch: number; tick: number; simTimeS: number; wallTimeMs: number; values: number[] }
export function decodeRecord(v: DataView, offset: number): AarRecord {
  const kind = v.getUint32(offset, true);
  if (!isRecordKind(kind)) throw new Error(`Unknown AAR record kind ${kind}`);
  const values: number[] = [];
  for (let i = 0; i < RECORD_VALUES; i++) values.push(v.getFloat64(offset + 32 + 8 * i, true));
  return { kind, epoch: v.getUint32(offset + 4, true), tick: recordTick(v, offset), simTimeS: v.getFloat64(offset + 16, true), wallTimeMs: v.getFloat64(offset + 24, true), values };
}

export function* chunkRecords(bytes: Uint8Array): Generator<AarRecord> {
  const info = readChunk(bytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < info.records; i++) yield decodeRecord(v, CHUNK_HEADER_BYTES + i * RECORD_BYTES);
}

// ---- Recording queue (physics -> recorder Worker) -------------------------------
// Header (Int32 words): 0 magic, 1 version, 2 capacity, 3 write counter, 4 read counter, 5 dropped records.
export const QUEUE_MAGIC = 0x51524141; // "AARQ"
const QUEUE_HEADER_WORDS = 16;
const RECORD_WORDS = RECORD_BYTES / 4;

export function createRecordingQueue(capacity: number): SharedArrayBuffer {
  if (!Number.isInteger(capacity) || capacity < 64 || capacity > 1 << 20) throw new Error("Invalid recording queue capacity");
  const sab = new SharedArrayBuffer(QUEUE_HEADER_WORDS * 4 + capacity * RECORD_BYTES);
  const w = new Int32Array(sab);
  w[0] = QUEUE_MAGIC; w[1] = AAR_VERSION; w[2] = capacity;
  return sab;
}
function queueWords(buffer: SharedArrayBuffer): Int32Array {
  const w = new Int32Array(buffer);
  if (w.length < QUEUE_HEADER_WORDS || w[0] !== QUEUE_MAGIC || w[1] !== AAR_VERSION) throw new Error("Not an AAR recording queue (the render ring and SPSC queues are never archives)");
  const capacity = w[2]!;
  if (buffer.byteLength !== QUEUE_HEADER_WORDS * 4 + capacity * RECORD_BYTES) throw new Error("AAR recording queue size mismatch");
  return w;
}

/**
 * Physics-side writer. commit() copies scalars from preallocated fields into
 * the next slot word by word with Atomics (never a direct shared
 * Float64Array access); it never allocates or blocks. A full queue drops the
 * record and increments the shared dropped counter.
 */
export class RecordingProducer {
  private readonly w: Int32Array;
  private readonly capacity: number;
  /** Private (non-shared) staging slot: doubles are split into int32 words here. */
  private readonly stageF = new Float64Array(RECORD_BYTES / 8);
  private readonly stageI = new Int32Array(this.stageF.buffer);
  /** Fill these, then call commit(). values has RECORD_VALUES entries. */
  readonly next = { kind: 3 as RecordKindValue, epoch: 0, tick: 0, simTimeS: 0.5, wallTimeMs: 0.5 };
  readonly values = new Float64Array(RECORD_VALUES);

  constructor(buffer: SharedArrayBuffer) {
    this.w = queueWords(buffer);
    this.capacity = this.w[2]!;
  }

  /** Publishes `next` + `values`; returns false (and counts a drop) when full. */
  commit(): boolean {
    const w = this.w, write = Atomics.load(w, 3) >>> 0, read = Atomics.load(w, 4) >>> 0;
    if (((write - read) >>> 0) >= this.capacity) { Atomics.add(w, 5, 1); return false; }
    const n = this.next, sf = this.stageF, si = this.stageI;
    sf[2] = n.simTimeS; sf[3] = n.wallTimeMs;
    for (let i = 0; i < RECORD_VALUES; i++) sf[4 + i] = this.values[i]!; // i < RECORD_VALUES
    si[0] = n.kind; si[1] = n.epoch;
    const tick = n.tick;
    si[2] = tick % 4294967296 | 0; si[3] = Math.floor(tick / 4294967296) | 0;
    const base = QUEUE_HEADER_WORDS + (write % this.capacity) * RECORD_WORDS;
    for (let i = 0; i < RECORD_WORDS; i++) Atomics.store(w, base + i, si[i]!); // i < RECORD_WORDS
    Atomics.store(w, 3, (write + 1) | 0); // publishes the slot
    return true;
  }
}

/** Recorder-side reader: copies the oldest record (32 words) into `out` at word `wordOffset`. */
export class RecordingConsumer {
  private readonly w: Int32Array;
  private readonly capacity: number;
  constructor(buffer: SharedArrayBuffer) {
    this.w = queueWords(buffer);
    this.capacity = this.w[2]!;
  }
  get droppedRecords(): number { return Atomics.load(this.w, 5) >>> 0; }
  get depth(): number { return (Atomics.load(this.w, 3) - Atomics.load(this.w, 4)) >>> 0; }
  tryPopInto(out: Int32Array, wordOffset: number): boolean {
    const w = this.w, read = Atomics.load(w, 4) >>> 0, write = Atomics.load(w, 3) >>> 0;
    if (read === write) return false;
    const base = QUEUE_HEADER_WORDS + (read % this.capacity) * RECORD_WORDS;
    for (let i = 0; i < RECORD_WORDS; i++) out[wordOffset + i] = Atomics.load(w, base + i);
    Atomics.store(w, 4, (read + 1) | 0); // producer may reuse the slot
    return true;
  }
}
