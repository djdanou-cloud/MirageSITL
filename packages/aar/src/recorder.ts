import { RECORD_BYTES, parseManifest, type AarManifest } from "./format.ts";
import { AarRecord } from "./record.ts";
export class RecordingRing {
  readonly manifest: AarManifest;
  readonly bytes: Uint8Array;
  readonly capacity: number;
  count = 0;
  evicted = 0;
  invalid = 0;
  private write = 0;
  private readonly scratch = new AarRecord();
  constructor(manifest: unknown) {
    this.manifest = parseManifest(manifest);
    this.capacity = this.manifest.recordHz * this.manifest.durationS;
    this.bytes = new Uint8Array(this.capacity * RECORD_BYTES);
  }
  append(record: Uint8Array): boolean {
    if (record.byteLength !== RECORD_BYTES) {
      this.invalid++;
      return false;
    }
    this.scratch.bytes.set(record);
    if (!this.scratch.decode()) {
      this.invalid++;
      return false;
    }
    this.bytes.set(record, this.write * RECORD_BYTES);
    this.write = (this.write + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    else this.evicted++;
    return true;
  }
  snapshot(): Uint8Array {
    const out = new Uint8Array(this.count * RECORD_BYTES),
      start = (this.write - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const offset = ((start + i) % this.capacity) * RECORD_BYTES;
      out.set(
        this.bytes.subarray(offset, offset + RECORD_BYTES),
        i * RECORD_BYTES,
      );
    }
    return out;
  }
}
