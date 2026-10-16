// In-memory emulator of the R2Bucket subset used by services/tiles-worker
// (TASK-064): byte copies, upload times from an injected clock, lexicographic
// prefix listing with pagination, and operation counters. It stands in for a
// local R2 binding; it is not Miniflare and makes no claim about R2 latency
// or consistency.
import type { R2BodyLike, R2BucketLike, R2ObjectLike } from "../../services/tiles-worker/src/r2-cache.ts";

interface Stored { bytes: Uint8Array; uploaded: Date; customMetadata: Record<string, string> }

export class MemoryR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, Stored>();
  puts = 0;
  deletes = 0;
  constructor(private readonly nowMs: () => number, private readonly pageSize = 1000) {}

  get(key: string): Promise<R2BodyLike | null> {
    const o = this.objects.get(key);
    if (!o) return Promise.resolve(null);
    const copy = o.bytes.slice();
    return Promise.resolve({ key, size: copy.byteLength, uploaded: o.uploaded, customMetadata: { ...o.customMetadata },
      arrayBuffer: () => Promise.resolve(copy.buffer) });
  }

  put(key: string, value: ArrayBuffer | Uint8Array, options: { customMetadata: Record<string, string> }): Promise<unknown> {
    const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value.slice(0));
    this.objects.set(key, { bytes, uploaded: new Date(this.nowMs()), customMetadata: { ...options.customMetadata } });
    this.puts++;
    return Promise.resolve(undefined);
  }

  delete(keys: string | string[]): Promise<void> {
    for (const key of typeof keys === "string" ? [keys] : keys) if (this.objects.delete(key)) this.deletes++;
    return Promise.resolve();
  }

  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }> {
    const keys = [...this.objects.keys()].filter(k => k.startsWith(options.prefix)).sort();
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const limit = Math.min(options.limit ?? this.pageSize, this.pageSize);
    const page = keys.slice(start, start + limit).map(key => {
      const o = this.objects.get(key)!; // key taken from the map above
      return { key, size: o.bytes.byteLength, uploaded: o.uploaded, customMetadata: { ...o.customMetadata } };
    });
    const truncated = start + limit < keys.length;
    return Promise.resolve(truncated ? { objects: page, truncated, cursor: String(start + limit) } : { objects: page, truncated });
  }

  get totalBytes(): number {
    let total = 0;
    for (const o of this.objects.values()) total += o.bytes.byteLength;
    return total;
  }
}
