import { parseManifest, RECORD_BYTES, type AarManifest } from "./format.ts";
import { AarRecord } from "./record.ts";
export type ReplayMode = "snapshots" | "resimulate";
/** Immutable private copy; seek selects a snapshot at/before time in a single epoch.
 * It never integrates physics, crosses an epoch or fills missing samples.
 */
export class SnapshotReplay {
  readonly manifest: AarManifest;
  readonly count: number;
  private readonly records: Uint8Array;
  private readonly epoch: Uint32Array;
  private readonly time: Float64Array;
  constructor(
    manifest: unknown,
    records: Uint8Array,
    expectedModelSha256?: string,
  ) {
    this.manifest = parseManifest(manifest);
    if (
      expectedModelSha256 !== undefined &&
      this.manifest.modelSha256 !== expectedModelSha256
    )
      throw new Error("AAR model hash mismatch");
    if (
      records.length % RECORD_BYTES !== 0 ||
      records.length >
        this.manifest.recordHz * this.manifest.durationS * RECORD_BYTES
    )
      throw new Error("Invalid AAR record size");
    this.count = records.length / RECORD_BYTES;
    this.epoch = new Uint32Array(this.count);
    this.time = new Float64Array(this.count);
    const scratch = new AarRecord(),
      seen = new Set<number>();
    let previousEpoch = -1,
      previousTick = -1,
      previousTime = -1;
    for (let i = 0; i < this.count; i++) {
      scratch.bytes.set(
        records.subarray(i * RECORD_BYTES, (i + 1) * RECORD_BYTES),
      );
      if (!scratch.decode())
        throw new Error("Invalid AAR record checksum or payload");
      const s = scratch.state,
        tick = s.tickId.hi * 2 ** 32 + s.tickId.lo;
      if (s.epoch !== previousEpoch) {
        if (seen.has(s.epoch)) throw new Error("Repeated AAR epoch segment");
        seen.add(s.epoch);
        previousTime = -1;
        previousTick = -1;
      }
      if (
        s.simTimeS < previousTime ||
        tick < previousTick ||
        (tick === previousTick && s.simTimeS !== previousTime)
      )
        throw new Error("AAR time or tick reversal");
      this.epoch[i] = s.epoch;
      this.time[i] = s.simTimeS;
      previousTime = s.simTimeS;
      previousTick = tick;
      previousEpoch = s.epoch;
    }
    this.records = records.slice();
  }
  seek(epoch: number, timeS: number, out: AarRecord): number {
    if (!Number.isFinite(timeS) || timeS < 0) return -1;
    let found = -1;
    for (let i = 0; i < this.count; i++)
      if (this.epoch[i] === epoch && this.time[i]! <= timeS) found = i;
    if (found >= 0) this.read(found, out);
    return found;
  }
  read(index: number, out: AarRecord): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.count)
      return false;
    out.bytes.set(
      this.records.subarray(index * RECORD_BYTES, (index + 1) * RECORD_BYTES),
    );
    return out.decode();
  }
}
