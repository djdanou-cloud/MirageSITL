/** Recorder-only IndexedDB persistence. A fixed key ring caps stored chunks.
 * At most one transaction is in flight; busy/error means an explicitly counted drop.
 */
export class ChunkStorage {
  dropped = 0;
  failures = 0;
  droppedBytes = 0;
  private busy = false;
  private sequence = 0;
  private constructor(
    private readonly db: IDBDatabase,
    readonly maxChunks: number,
    readonly chunkBytes: number,
  ) {}
  static async open(
    name: string,
    maxChunks: number,
    chunkBytes: number,
  ): Promise<ChunkStorage> {
    if (
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
    return new ChunkStorage(db, maxChunks, chunkBytes);
  }
  write(bytes: Uint8Array): boolean {
    if (this.busy || bytes.length > this.chunkBytes) {
      this.dropped++;
      this.droppedBytes += bytes.length;
      return false;
    }
    this.busy = true;
    const copy = bytes.slice();
    try {
      const tx = this.db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").put(copy, this.sequence++ % this.maxChunks);
      tx.oncomplete = () => {
        this.busy = false;
      };
      let failed = false;
      tx.onerror = tx.onabort = () => {
        if (failed) return;
        failed = true;
        this.busy = false;
        this.failures++;
        this.dropped++;
        this.droppedBytes += bytes.length;
      };
    } catch {
      this.busy = false;
      this.failures++;
      this.dropped++;
      this.droppedBytes += bytes.length;
      return false;
    }
    return true;
  }
  async settled(): Promise<void> {
    while (this.busy)
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
