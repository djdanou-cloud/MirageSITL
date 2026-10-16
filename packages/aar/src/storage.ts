// AAR chunk storage (TASK-076): IndexedDB in the browser, an in-memory
// store for tests. Operations complete in issue order (IndexedDB runs
// readwrite transactions over the same store in creation order), so the
// recorder's byte accounting matches what is stored.
import { parseManifest, type SessionManifest } from "./format.ts";

export interface ChunkStore {
  put(sequence: number, bytes: Uint8Array): Promise<void>;
  get(sequence: number): Promise<Uint8Array | null>;
  delete(sequence: number): Promise<void>;
  /** Stored chunk sequences, ascending. */
  list(): Promise<number[]>;
  putManifest(manifest: SessionManifest): Promise<void>;
  getManifest(): Promise<SessionManifest | null>;
}

/** In-memory store; `latencyMs` delays each operation (FIFO) to exercise backpressure. */
export class MemoryChunkStore implements ChunkStore {
  readonly chunks = new Map<number, Uint8Array>();
  private manifest: SessionManifest | null = null;
  private tail: Promise<void> = Promise.resolve();
  /** Largest total stored bytes ever observed. */
  peakBytes = 0;
  constructor(private readonly latencyMs = 0) {}

  private run<T>(op: () => T): Promise<T> {
    const result = this.tail.then(() => new Promise<T>(resolve => {
      const finish = () => resolve(op());
      if (this.latencyMs > 0) setTimeout(finish, this.latencyMs); else finish();
    }));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  get bytes(): number { let n = 0; for (const c of this.chunks.values()) n += c.byteLength; return n; }
  put(sequence: number, bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice();
    return this.run(() => { this.chunks.set(sequence, copy); this.peakBytes = Math.max(this.peakBytes, this.bytes); });
  }
  get(sequence: number): Promise<Uint8Array | null> { return this.run(() => this.chunks.get(sequence)?.slice() ?? null); }
  delete(sequence: number): Promise<void> { return this.run(() => { this.chunks.delete(sequence); }); }
  list(): Promise<number[]> { return this.run(() => [...this.chunks.keys()].sort((a, b) => a - b)); }
  putManifest(manifest: SessionManifest): Promise<void> { return this.run(() => { this.manifest = structuredClone(manifest); }); }
  getManifest(): Promise<SessionManifest | null> { return this.run(() => (this.manifest ? structuredClone(this.manifest) : null)); }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed")); });
}

/** One IndexedDB database per session: object stores "chunks" (key = sequence) and "meta". */
export class IndexedDbChunkStore implements ChunkStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name: string): Promise<IndexedDbChunkStore> {
    if (!/^mirage-aar-[A-Za-z0-9-]{8,64}$/.test(name)) throw new Error("Invalid AAR database name");
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("chunks"); req.result.createObjectStore("meta"); };
    return new IndexedDbChunkStore(await request(req));
  }

  private store(name: "chunks" | "meta", mode: IDBTransactionMode): IDBObjectStore { return this.db.transaction(name, mode).objectStore(name); }

  async put(sequence: number, bytes: Uint8Array): Promise<void> { await request(this.store("chunks", "readwrite").put(bytes.slice().buffer, sequence)); }
  async get(sequence: number): Promise<Uint8Array | null> {
    const value: unknown = await request(this.store("chunks", "readonly").get(sequence));
    return value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  }
  async delete(sequence: number): Promise<void> { await request(this.store("chunks", "readwrite").delete(sequence)); }
  async list(): Promise<number[]> {
    const keys: unknown = await request(this.store("chunks", "readonly").getAllKeys());
    if (!Array.isArray(keys)) return [];
    return keys.filter((k): k is number => typeof k === "number").sort((a, b) => a - b);
  }
  async putManifest(manifest: SessionManifest): Promise<void> { await request(this.store("meta", "readwrite").put(JSON.stringify(manifest), "manifest")); }
  async getManifest(): Promise<SessionManifest | null> {
    const value: unknown = await request(this.store("meta", "readonly").get("manifest"));
    return typeof value === "string" ? parseManifest(JSON.parse(value) as unknown) : null;
  }
  close(): void { this.db.close(); }
  static async destroy(name: string): Promise<void> { await request(indexedDB.deleteDatabase(name)); }
}
