/** Recorder-only IndexedDB persistence. A fixed key ring caps stored chunks.
 * At most one transaction is in flight. Chunks written while it is busy wait
 * in a bounded pending list (maxPending, default 8) and are written in order;
 * only a full pending list or a failed transaction is an explicitly counted
 * drop. (Dropping whenever a transaction was busy lost most of a burst.)
 */
export class ChunkStorage {
  dropped = 0;
  failures = 0;
  droppedBytes = 0;
  private busy = false;
  private sequence = 0;
  private readonly pending: Uint8Array[] = [];
  private constructor(
    private readonly db: IDBDatabase,
    readonly maxChunks: number,
    readonly chunkBytes: number,
    readonly maxPending: number,
  ) {}
  static async open(
    name: string,
    maxChunks: number,
    chunkBytes: number,
    maxPending = 8,
  ): Promise<ChunkStorage> {
    if (
      !Number.isInteger(maxPending) ||
      maxPending < 0 ||
      maxPending > 64 ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(name) ||
      !Number.isInteger(maxChunks) ||
      maxChunks < 1 ||
      maxChunks > 8192 ||
      !Number.isInteger(chunkBytes) ||
      chunkBytes < 512 ||
      chunkBytes > 65536 ||
      maxChunks * chunkBytes > 32 * 1024 * 1024
    )
      throw new RangeError("Invalid recording storage bounds");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("chunks");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("IndexedDB open failed"));
    });
    // Each active session owns its database name. Clear only this session's bounded store.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("IndexedDB clear failed"));
    });
    return new ChunkStorage(db, maxChunks, chunkBytes, maxPending);
  }
  /** Number of chunks waiting for the in-flight transaction. */
  get pendingChunks(): number {
    return this.pending.length;
  }
  write(bytes: Uint8Array): boolean {
    if (bytes.length > this.chunkBytes) return this.drop(bytes.length, false);
    if (this.busy) {
      if (this.pending.length >= this.maxPending)
        return this.drop(bytes.length, false);
      this.pending.push(bytes.slice());
      return true;
    }
    return this.start(bytes.slice());
  }
  private drop(length: number, failure: boolean): false {
    if (failure) this.failures++;
    this.dropped++;
    this.droppedBytes += length;
    return false;
  }
  /** Starts one transaction; on completion the next pending chunk follows. */
  private start(copy: Uint8Array): boolean {
    this.busy = true;
    const next = () => {
      const queued = this.pending.shift();
      this.busy = false;
      if (queued) this.start(queued);
    };
    try {
      const tx = this.db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").put(copy, this.sequence++ % this.maxChunks);
      let done = false;
      tx.oncomplete = () => {
        if (done) return;
        done = true;
        next();
      };
      tx.onerror = tx.onabort = () => {
        if (done) return;
        done = true;
        this.drop(copy.length, true);
        next();
      };
    } catch {
      this.drop(copy.length, true);
      next();
      return false;
    }
    return true;
  }
  async settled(): Promise<void> {
    while (this.busy || this.pending.length > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  deleteOwnedDatabase(): void {
    this.db.close();
    indexedDB.deleteDatabase(this.db.name);
  }
  close(): void {
    this.db.close();
  }
}
