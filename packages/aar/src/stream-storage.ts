// Streaming storage of format v2 records (TASK-162). Unlike TASK-076's fixed
// 32 MiB key ring, a record grows chunk by chunk without a size cap. The
// IndexedDB database `mirage-recordings` is persistent and holds every record:
// a catalog entry per record (header, status, counters) and its chunks keyed
// by [record ID, chunk index]. Each chunk is written together with its
// catalog entry in one transaction, so the catalog never names a chunk that
// is not stored. One transaction is in flight at a time; chunks that arrive
// meanwhile wait in a bounded list. A chunk that cannot wait (full list) or
// whose transaction fails is dropped, its index stays unused, and the entry
// counts it, so the gap is explicit. A record still marked `recording` when
// no live recorder holds it was cut off by a restart: it reopens as
// `interrupted` with every chunk stored before. Cold path: the recorder
// Worker and readers use this, never the physics loop.
import { decodeChunk, parseRecordHeader, recordKey, type DecodedRow, type RecordHeaderV2 } from "./format-v2.ts";
import type { ChunkSink } from "./recorder-v2.ts";
import { signalById } from "./signal-catalog.ts";

export type RecordingStatus = "recording" | "closed" | "interrupted";
export interface CatalogEntry {
  readonly recordId: string;
  readonly header: RecordHeaderV2;
  readonly status: RecordingStatus;
  /** Chunk indices used so far, stored or dropped. */
  readonly chunks: number;
  readonly storedChunks: number;
  readonly bytes: number;
  /** Stored rows per signal name. */
  readonly rows: Readonly<Record<string, number>>;
  readonly droppedChunks: number;
  readonly droppedRows: number;
  /** Rows the producer could not queue (each also a gap in the record). */
  readonly producerLost: number;
  /** Kept samples whose source produced nothing, per signal name (never written as zeros). */
  readonly absent: Readonly<Record<string, number>>;
  readonly updatedAt: string;
}

export interface RecordingBackend {
  putEntry(entry: CatalogEntry): Promise<void>;
  /** Stores `chunk` at `index` and `entry` in one transaction. */
  putChunk(entry: CatalogEntry, index: number, chunk: Uint8Array): Promise<void>;
  listEntries(): Promise<CatalogEntry[]>;
  getEntry(recordId: string): Promise<CatalogEntry | null>;
  getChunk(recordId: string, index: number): Promise<Uint8Array | null>;
  deleteRecord(recordId: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function counts(value: unknown, where: string): Record<string, number> {
  if (!isRecord(value)) throw new Error(`${where}: an object of counts expected`);
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`${where}.${key}: a count expected`);
    out[key] = count;
  }
  return out;
}
/** Validates a catalog entry read from storage. */
export function parseCatalogEntry(input: unknown): CatalogEntry {
  if (!isRecord(input)) throw new Error("Recording catalog entry: an object expected");
  const header = parseRecordHeader(input.header);
  const { recordId, status, updatedAt } = input;
  if (recordId !== header.recordId) throw new Error("Recording catalog entry: the record ID differs from its header");
  if (status !== "recording" && status !== "closed" && status !== "interrupted") throw new Error("Recording catalog entry: invalid status");
  if (typeof updatedAt !== "string") throw new Error("Recording catalog entry: invalid update time");
  const number = (key: string): number => {
    const value = input[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Recording catalog entry: invalid ${key}`);
    return value;
  };
  const entry: CatalogEntry = { recordId: header.recordId, header, status, chunks: number("chunks"), storedChunks: number("storedChunks"), bytes: number("bytes"),
    rows: counts(input.rows, "rows"), droppedChunks: number("droppedChunks"), droppedRows: number("droppedRows"), producerLost: number("producerLost"),
    absent: counts(input.absent, "absent"), updatedAt };
  if (entry.storedChunks + entry.droppedChunks > entry.chunks) throw new Error("Recording catalog entry: more chunks counted than used");
  return entry;
}
/** A plain copy of an entry for IndexedDB's structured clone. */
function plain(entry: CatalogEntry): unknown {
  return JSON.parse(JSON.stringify(entry));
}

/** In-memory backend for tests and for a recording that storage refused. */
export class MemoryRecordingBackend implements RecordingBackend {
  private readonly entries = new Map<string, unknown>();
  private readonly chunks = new Map<string, Uint8Array>();
  /** Test hook: the next putChunk calls fail. */
  failNext = 0;
  async putEntry(entry: CatalogEntry): Promise<void> { this.entries.set(entry.recordId, plain(entry)); return Promise.resolve(); }
  async putChunk(entry: CatalogEntry, index: number, chunk: Uint8Array): Promise<void> {
    if (this.failNext > 0) { this.failNext--; return Promise.reject(new Error("Injected storage failure")); }
    this.chunks.set(`${entry.recordId}/${index}`, chunk.slice());
    this.entries.set(entry.recordId, plain(entry));
    return Promise.resolve();
  }
  async listEntries(): Promise<CatalogEntry[]> { return Promise.resolve([...this.entries.values()].map(parseCatalogEntry)); }
  async getEntry(recordId: string): Promise<CatalogEntry | null> {
    const entry = this.entries.get(recordId);
    return Promise.resolve(entry === undefined ? null : parseCatalogEntry(entry));
  }
  async getChunk(recordId: string, index: number): Promise<Uint8Array | null> {
    return Promise.resolve(this.chunks.get(`${recordId}/${index}`)?.slice() ?? null);
  }
  async deleteRecord(recordId: string): Promise<void> {
    this.entries.delete(recordId);
    for (const key of [...this.chunks.keys()]) if (key.startsWith(`${recordId}/`)) this.chunks.delete(key);
    return Promise.resolve();
  }
  /** Test hook: overwrites one stored byte. */
  corrupt(recordId: string, index: number, at: number): void {
    const chunk = this.chunks.get(`${recordId}/${index}`);
    if (chunk) chunk[at] = (chunk[at] ?? 0) ^ 0xff;
  }
  storedBytes(): number { let sum = 0; for (const chunk of this.chunks.values()) sum += chunk.length; return sum; }
}

export const RECORDINGS_DATABASE = "mirage-recordings";
/** The Web Lock a recorder holds while its record is `recording`. */
export function recordingLockName(recordId: string): string { return `mirage-recording-${recordId}`; }
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}
/** The persistent browser backend: stores `entries` (key path recordId) and `chunks` (key [recordId, index]). */
export class IndexedDbRecordingBackend implements RecordingBackend {
  private constructor(private readonly db: IDBDatabase) {}
  static async open(name = RECORDINGS_DATABASE): Promise<IndexedDbRecordingBackend> {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore("entries", { keyPath: "recordId" });
      opening.result.createObjectStore("chunks");
    };
    return new IndexedDbRecordingBackend(await request(opening));
  }
  close(): void { this.db.close(); }
  async putEntry(entry: CatalogEntry): Promise<void> {
    const tx = this.db.transaction("entries", "readwrite");
    tx.objectStore("entries").put(plain(entry));
    return done(tx);
  }
  async putChunk(entry: CatalogEntry, index: number, chunk: Uint8Array): Promise<void> {
    const tx = this.db.transaction(["entries", "chunks"], "readwrite");
    tx.objectStore("chunks").put(chunk, [entry.recordId, index]);
    tx.objectStore("entries").put(plain(entry));
    return done(tx);
  }
  async listEntries(): Promise<CatalogEntry[]> {
    const all: unknown[] = await request(this.db.transaction("entries").objectStore("entries").getAll());
    return all.map(parseCatalogEntry);
  }
  async getEntry(recordId: string): Promise<CatalogEntry | null> {
    const value: unknown = await request(this.db.transaction("entries").objectStore("entries").get(recordId));
    return value === undefined ? null : parseCatalogEntry(value);
  }
  async getChunk(recordId: string, index: number): Promise<Uint8Array | null> {
    const value: unknown = await request(this.db.transaction("chunks").objectStore("chunks").get([recordId, index]));
    return value instanceof Uint8Array ? value : null;
  }
  async deleteRecord(recordId: string): Promise<void> {
    const tx = this.db.transaction(["entries", "chunks"], "readwrite");
    tx.objectStore("entries").delete(recordId);
    tx.objectStore("chunks").delete(IDBKeyRange.bound([recordId, 0], [recordId, Number.MAX_SAFE_INTEGER]));
    return done(tx);
  }
}

/** Producer counters the writer copies into the catalog entry. */
export interface ProducerCounters { readonly lost: number; absent(id: number): number }

/**
 * Writes one record's chunks in order with at most one transaction in flight
 * and `maxPending` chunks waiting (default 64, 4 MiB). Implements the
 * consumer's ChunkSink.
 */
export class StreamWriter implements ChunkSink {
  private entry: CatalogEntry;
  private readonly waiting: { index: number; chunk: Uint8Array; rows: ReadonlyMap<number, number> }[] = [];
  private busy: Promise<void> | null = null;
  private counters: ProducerCounters | null = null;
  failures = 0;
  lastError = "";

  private constructor(private readonly backend: RecordingBackend, header: RecordHeaderV2, private readonly maxPending: number) {
    this.entry = { recordId: header.recordId, header, status: "recording", chunks: 0, storedChunks: 0, bytes: 0, rows: {}, droppedChunks: 0,
      droppedRows: 0, producerLost: 0, absent: {}, updatedAt: new Date().toISOString() };
  }
  /** Creates the record's catalog entry with status `recording`. */
  static async start(backend: RecordingBackend, header: RecordHeaderV2, maxPending = 64): Promise<StreamWriter> {
    if (!Number.isInteger(maxPending) || maxPending < 0 || maxPending > 1024) throw new RangeError("Invalid pending chunk bound");
    const writer = new StreamWriter(backend, parseRecordHeader(header), maxPending);
    if (await backend.getEntry(header.recordId)) throw new Error(`Recording ${header.recordId} already exists`);
    await backend.putEntry(writer.entry);
    return writer;
  }
  get current(): CatalogEntry { return this.entry; }
  /** Producer counters to copy into the entry with every chunk. */
  bindCounters(counters: ProducerCounters): void { this.counters = counters; }

  write(index: number, chunk: Uint8Array, rows: ReadonlyMap<number, number>): void {
    this.entry = { ...this.entry, chunks: Math.max(this.entry.chunks, index + 1) };
    if (this.waiting.length >= this.maxPending && this.busy) {
      this.drop(rows);
      return;
    }
    this.waiting.push({ index, chunk, rows });
    this.pump();
  }
  private drop(rows: ReadonlyMap<number, number>): void {
    let lost = 0;
    for (const count of rows.values()) lost += count;
    this.entry = { ...this.entry, droppedChunks: this.entry.droppedChunks + 1, droppedRows: this.entry.droppedRows + lost };
  }
  private withCounters(entry: CatalogEntry): CatalogEntry {
    const counters = this.counters;
    if (!counters) return entry;
    const absent: Record<string, number> = {};
    for (let id = 1; id <= 20; id++) {
      const count = counters.absent(id), name = signalById(id)?.name;
      if (count > 0 && name) absent[name] = count;
    }
    return { ...entry, producerLost: counters.lost, absent };
  }
  private pump(): void {
    if (this.busy) return;
    const next = this.waiting.shift();
    if (!next) return;
    const rows = { ...this.entry.rows };
    for (const [id, count] of next.rows) {
      const name = signalById(id)?.name ?? "gap";
      rows[name] = (rows[name] ?? 0) + count;
    }
    const stored = this.withCounters({ ...this.entry, storedChunks: this.entry.storedChunks + 1, bytes: this.entry.bytes + next.chunk.length, rows,
      updatedAt: new Date().toISOString() });
    this.busy = this.backend.putChunk(stored, next.index, next.chunk).then(
      () => {
        // Counters that changed while the transaction ran are kept; the stored fields are this chunk's.
        this.entry = { ...stored, chunks: this.entry.chunks, droppedChunks: this.entry.droppedChunks, droppedRows: this.entry.droppedRows };
      },
      (error: unknown) => {
        this.failures++;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.drop(next.rows);
      },
    ).finally(() => {
      this.busy = null;
      this.pump();
    });
  }
  /** Resolves when every waiting chunk has been written or dropped. */
  async settled(): Promise<void> {
    while (this.busy) await this.busy;
  }
  /** Writes the remaining chunks and marks the record closed. */
  async close(): Promise<CatalogEntry> {
    await this.settled();
    this.entry = this.withCounters({ ...this.entry, status: "closed", updatedAt: new Date().toISOString() });
    await this.backend.putEntry(this.entry);
    return this.entry;
  }
}

/** Marks every `recording` entry that no live recorder holds as `interrupted`; returns their IDs. */
export async function recoverInterrupted(backend: RecordingBackend, isLive: (recordId: string) => boolean): Promise<string[]> {
  const recovered: string[] = [];
  for (const entry of await backend.listEntries()) {
    if (entry.status !== "recording" || isLive(entry.recordId)) continue;
    await backend.putEntry({ ...entry, status: "interrupted", updatedAt: new Date().toISOString() });
    recovered.push(entry.recordId);
  }
  return recovered;
}

export interface OpenedRecording {
  readonly entry: CatalogEntry;
  readonly header: RecordHeaderV2;
  /** Rows per signal name, in stored order. */
  readonly rows: ReadonlyMap<string, readonly DecodedRow[]>;
  /** Chunk indices the catalog counts but storage does not hold (dropped chunks). */
  readonly missingChunks: readonly number[];
  /** Chunks that failed their checks, with the reason; their rows are not used. */
  readonly corruptChunks: readonly { readonly index: number; readonly reason: string }[];
  /** Gap rows: rows lost by the producer, at their tick. */
  readonly gaps: readonly DecodedRow[];
}
/** Reopens a stored record: verifies every chunk and groups its rows by signal. */
export async function openRecording(backend: RecordingBackend, recordId: string): Promise<OpenedRecording> {
  const entry = await backend.getEntry(recordId);
  if (!entry) throw new Error(`No recording ${recordId}`);
  const key = recordKey(entry.recordId);
  const rows = new Map<string, DecodedRow[]>(), missingChunks: number[] = [], corruptChunks: { index: number; reason: string }[] = [], gaps: DecodedRow[] = [];
  for (let index = 0; index < entry.chunks; index++) {
    const chunk = await backend.getChunk(recordId, index);
    if (!chunk) { missingChunks.push(index); continue; }
    try {
      for (const row of decodeChunk(chunk, key, index).rows) {
        if (row.values === null && row.parameter === null) { gaps.push(row); continue; }
        const name = signalById(row.signal)?.name ?? String(row.signal);
        let list = rows.get(name);
        if (!list) { list = []; rows.set(name, list); }
        list.push(row);
      }
    } catch (error) {
      corruptChunks.push({ index, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { entry, header: entry.header, rows, missingChunks, corruptChunks, gaps };
}
