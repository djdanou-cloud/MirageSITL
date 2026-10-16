// AAR recorder (TASK-076): drains the dedicated recording queue into
// CRC-checked chunks and keeps a fixed-size ring in a ChunkStore. Runs in the
// recorder Worker (recorder.worker.ts), never in the physics step.
//
// * Ring: before each chunk is stored, the oldest stored chunks are deleted
//   until the new chunk fits in manifest.ringBytes. Eviction is the ring
//   working as configured, not loss.
// * Backpressure: while maxPendingWrites stores are in flight the recorder
//   stops draining, so the recording queue absorbs bursts instead of chunks
//   being dropped. Loss happens only when the queue itself is full; it is
//   counted on the physics side and written as a Gap record (count, tick
//   range, reason) before the next stored record. The reason is
//   StorageBackpressure when the recorder was stalled by storage, QueueFull
//   otherwise (recorder not draining fast enough).
import {
  CHUNK_HEADER_BYTES, GapReason, RECORD_BYTES, RecordKind, RecordingConsumer, chunkBytes, crc32, parseManifest, recordTick, writeChunkHeader,
  type SessionManifest,
} from "./format.ts";
import type { ChunkStore } from "./storage.ts";

export interface RecorderStats {
  recordsQueued: number;
  chunksStored: number;
  evictedChunks: number;
  /** Pumps that stopped draining because storage had maxPendingWrites in flight. */
  storageStalls: number;
  /** Records lost because the recording queue was full (the only loss path). */
  queueDroppedRecords: number;
  gapRecords: number;
  storedBytes: number;
  pendingWrites: number;
  storageErrors: number;
}

export class AarRecorder {
  readonly manifest: SessionManifest;
  readonly stats: RecorderStats = { recordsQueued: 0, chunksStored: 0, evictedChunks: 0, storageStalls: 0, queueDroppedRecords: 0, gapRecords: 0, storedBytes: 0, pendingWrites: 0, storageErrors: 0 };
  private readonly consumer: RecordingConsumer;
  private chunk: Uint8Array;
  private words: Int32Array;
  private view: DataView;
  private filled = 0;
  private sequence = 0;
  private readonly stored: { sequence: number; bytes: number }[] = [];
  private lastTick = 0;
  private pendingGap: { records: number; fromTick: number; toTick: number; reason: number } | null = null;
  private stalled = false;
  private seenQueueDrops = 0;

  constructor(manifest: unknown, queue: SharedArrayBuffer, private readonly store: ChunkStore, private readonly maxPendingWrites = 4) {
    this.manifest = parseManifest(manifest);
    this.consumer = new RecordingConsumer(queue);
    const size = chunkBytes(this.manifest.chunkRecords);
    this.chunk = new Uint8Array(size);
    this.words = new Int32Array(this.chunk.buffer);
    this.view = new DataView(this.chunk.buffer);
    if (!Number.isInteger(maxPendingWrites) || maxPendingWrites < 1) throw new Error("maxPendingWrites must be >= 1");
  }

  async start(): Promise<void> { await this.store.putManifest(this.manifest); }

  /** Drains the queue; seals and stores full chunks. Returns records drained. */
  pump(): number {
    let drained = 0;
    const capacity = this.manifest.chunkRecords;
    for (;;) {
      if (this.filled >= capacity) {
        if (this.stats.pendingWrites >= this.maxPendingWrites) {
          // Storage is behind: leave records in the queue (bounded) instead of dropping chunks.
          if (!this.stalled) this.stats.storageStalls++;
          this.stalled = true;
          this.noteQueueDrops();
          break;
        }
        this.stalled = false;
        this.seal();
        continue;
      }
      if (this.pendingGap) { this.writeGap(); continue; }
      const offsetWords = (CHUNK_HEADER_BYTES + this.filled * RECORD_BYTES) / 4;
      if (!this.consumer.tryPopInto(this.words, offsetWords)) {
        // Drops happen only while the queue is full, i.e. after every record drained so far was enqueued.
        if (this.noteQueueDrops()) continue;
        break;
      }
      this.lastTick = recordTick(this.view, offsetWords * 4);
      this.filled++;
      drained++;
      this.stats.recordsQueued++;
    }
    return drained;
  }

  /** Seals a partially filled chunk (e.g. on pause/stop). */
  flush(): void {
    this.noteQueueDrops();
    if (this.pendingGap) { if (this.filled >= this.manifest.chunkRecords) this.seal(); this.writeGap(); }
    if (this.filled > 0) this.seal();
  }

  /** Stop path: drains the queue completely (waiting for storage as needed), seals the last chunk and waits for storage. */
  async drainAndFlush(): Promise<void> {
    for (;;) {
      this.pump();
      if (this.consumer.depth === 0) break;
      await this.idle();
    }
    if (this.filled >= this.manifest.chunkRecords) await this.idle();
    this.flush();
    await this.idle();
  }

  /** Resolves when every issued store operation has finished. */
  async idle(): Promise<void> { while (this.stats.pendingWrites > 0) await new Promise(resolve => setTimeout(resolve, 1)); }

  private noteQueueDrops(): boolean {
    const dropped = this.consumer.droppedRecords;
    if (dropped === this.seenQueueDrops) return false;
    const delta = (dropped - this.seenQueueDrops) >>> 0;
    this.seenQueueDrops = dropped;
    this.stats.queueDroppedRecords += delta;
    this.addGap(delta, this.stalled ? GapReason.StorageBackpressure : GapReason.QueueFull, this.lastTick, this.lastTick);
    return true;
  }

  /** Merges loss into the pending gap (written before the next stored record); a merged gap keeps its first reason. */
  private addGap(records: number, reason: number, fromTick: number, toTick: number): void {
    const g = this.pendingGap;
    if (!g) { this.pendingGap = { records, fromTick, toTick, reason }; return; }
    g.records += records;
    g.fromTick = Math.min(g.fromTick, fromTick);
    g.toTick = Math.max(g.toTick, toTick);
  }

  private writeGap(): void {
    const g = this.pendingGap;
    if (!g) return;
    const o = CHUNK_HEADER_BYTES + this.filled * RECORD_BYTES, v = this.view;
    this.chunk.fill(0, o, o + RECORD_BYTES);
    v.setUint32(o, RecordKind.Gap, true);
    v.setUint32(o + 8, this.lastTick % 4294967296, true); v.setUint32(o + 12, Math.floor(this.lastTick / 4294967296), true);
    v.setFloat64(o + 16, Number.NaN, true); v.setFloat64(o + 24, Number.NaN, true);
    v.setFloat64(o + 32, g.records, true); v.setFloat64(o + 40, g.fromTick, true); v.setFloat64(o + 48, g.toTick, true); v.setFloat64(o + 56, g.reason, true);
    this.filled++;
    this.stats.gapRecords++;
    this.pendingGap = null;
  }

  private seal(): void {
    const records = this.filled;
    this.filled = 0;
    const size = chunkBytes(records);
    const bytes = records === this.manifest.chunkRecords ? this.chunk : this.chunk.slice(0, size);
    const firstEpoch = this.view.getUint32(CHUNK_HEADER_BYTES + 4, true), firstTick = recordTick(this.view, CHUNK_HEADER_BYTES);
    const sequence = this.sequence++;
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    writeChunkHeader(header, { sequence, records, firstTick, lastTick: this.lastTick, crc: crc32(bytes, CHUNK_HEADER_BYTES), firstEpoch });
    if (records === this.manifest.chunkRecords) {
      // The sealed buffer goes to storage; the next chunk gets a fresh buffer (once per chunk, not per record).
      this.chunk = new Uint8Array(chunkBytes(this.manifest.chunkRecords));
      this.words = new Int32Array(this.chunk.buffer);
      this.view = new DataView(this.chunk.buffer);
    }
    // Ring: evict oldest until the new chunk fits the fixed byte cap.
    while (this.stats.storedBytes + size > this.manifest.ringBytes && this.stored.length > 0) {
      const oldest = this.stored.shift()!; // length checked
      this.stats.storedBytes -= oldest.bytes;
      this.stats.evictedChunks++;
      this.track(this.store.delete(oldest.sequence));
    }
    this.stats.storedBytes += size;
    this.stored.push({ sequence, bytes: size });
    this.stats.chunksStored++;
    this.track(this.store.put(sequence, bytes));
  }

  private track(op: Promise<void>): void {
    this.stats.pendingWrites++;
    op.then(() => { this.stats.pendingWrites--; }, () => { this.stats.pendingWrites--; this.stats.storageErrors++; });
  }
}
