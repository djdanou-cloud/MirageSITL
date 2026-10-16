// AAR replay (TASK-077): recorded snapshot playback, kept separate from
// deterministic resimulation (resimulation.ts).
//
// * openRecording reads the manifest and every chunk read-only, verifying
//   format, version, CRC and (when given) the expected model hashes.
//   Records are frozen; nothing is ever written back to the store.
// * Timeline: truth records form segments of one epoch with increasing ticks.
//   Segments are laid end to end, so the timeline never interpolates or
//   jumps across a reset/epoch change; crossing one is reported as a
//   discontinuity.
// * Seeking returns the last truth record at or before the position within
//   its segment, clamps outside [0, duration), and reports positions that
//   fall inside recorded loss (gap) as inGap.
import { RecordKind, chunkRecords, parseManifest, type AarRecord, type SessionManifest } from "./format.ts";
import type { ChunkStore } from "./storage.ts";

export type ReplayMode = "snapshots" | "resimulate";

export interface Segment {
  epoch: number;
  /** Indices into Recording.truth (inclusive start, exclusive end). */
  start: number;
  end: number;
  firstTick: number;
  lastTick: number;
  /** Position of the segment's first record on the timeline, s. */
  timelineStartS: number;
  durationS: number;
}

export interface Recording {
  readonly manifest: Readonly<SessionManifest>;
  readonly truth: readonly Readonly<AarRecord>[];
  readonly inputs: ReadonlyMap<string, Readonly<AarRecord>>;
  readonly gaps: readonly Readonly<AarRecord>[];
  readonly events: readonly Readonly<AarRecord>[];
  readonly segments: readonly Readonly<Segment>[];
  readonly durationS: number;
}

export function tickKey(epoch: number, tick: number): string { return `${epoch}:${tick}`; }

export async function openRecording(store: ChunkStore, expectedHashes?: { physics: string; airframe: string }): Promise<Recording> {
  const stored: unknown = await store.getManifest();
  if (!stored) throw new Error("Recording has no manifest");
  const manifest = parseManifest(stored); // re-validated here whatever the store did: unknown formats/versions are rejected
  if (expectedHashes && (expectedHashes.physics !== manifest.modelHashes.physics || expectedHashes.airframe !== manifest.modelHashes.airframe)) {
    throw new Error("Recording model hash mismatch");
  }
  const truth: AarRecord[] = [], gaps: AarRecord[] = [], events: AarRecord[] = [];
  const inputs = new Map<string, AarRecord>();
  for (const sequence of await store.list()) {
    const bytes = await store.get(sequence);
    if (!bytes) throw new Error(`Chunk ${sequence} disappeared while reading`);
    for (const record of chunkRecords(bytes)) { // validates magic/version/size/CRC first
      Object.freeze(record.values); Object.freeze(record);
      if (record.kind === RecordKind.Truth) truth.push(record);
      else if (record.kind === RecordKind.Input) inputs.set(tickKey(record.epoch, record.tick), record);
      else if (record.kind === RecordKind.Gap) gaps.push(record);
      else if (record.kind === RecordKind.Event) events.push(record);
    }
  }
  const dt = 1 / manifest.physicsHz;
  const segments: Segment[] = [];
  let timeline = 0;
  for (let i = 0; i < truth.length;) {
    const first = truth[i]!; // i < length
    let j = i + 1;
    while (j < truth.length && truth[j]!.epoch === first.epoch && truth[j]!.tick > truth[j - 1]!.tick) j++;
    const last = truth[j - 1]!;
    const durationS = last.simTimeS - first.simTimeS + dt;
    segments.push(Object.freeze({ epoch: first.epoch, start: i, end: j, firstTick: first.tick, lastTick: last.tick, timelineStartS: timeline, durationS }));
    timeline += durationS;
    i = j;
  }
  return Object.freeze({ manifest: Object.freeze(manifest), truth: Object.freeze(truth), inputs, gaps: Object.freeze(gaps), events: Object.freeze(events),
    segments: Object.freeze(segments), durationS: timeline });
}

export interface ReplayFrame {
  record: Readonly<AarRecord>;
  segmentIndex: number;
  /** Timeline position actually shown (after clamping), s. */
  timelineS: number;
  atStart: boolean;
  atEnd: boolean;
  /** The previous frame shown belonged to another segment (reset/epoch change). */
  discontinuity: boolean;
  /** The position lies in recorded loss after `record` (missing ticks). */
  inGap: boolean;
}

export class SnapshotReplay {
  readonly mode: ReplayMode = "snapshots";
  private lastSegment = -1;
  constructor(readonly recording: Recording) {
    if (recording.truth.length === 0) throw new Error("Recording has no truth records to replay");
  }

  seek(timelineS: number): ReplayFrame {
    const rec = this.recording, segs = rec.segments, dt = 1 / rec.manifest.physicsHz;
    if (!Number.isFinite(timelineS)) throw new Error("Invalid timeline position");
    const atStart = timelineS <= 0, atEnd = timelineS >= rec.durationS - dt;
    const t = Math.min(Math.max(0, timelineS), rec.durationS - dt);
    // Last segment whose start is <= t.
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid]!.timelineStartS <= t) lo = mid; else hi = mid - 1; }
    const seg = segs[lo]!; // non-empty by construction
    const simTarget = rec.truth[seg.start]!.simTimeS + (t - seg.timelineStartS) + 1e-9;
    let a = seg.start, b = seg.end - 1;
    while (a < b) { const mid = (a + b + 1) >> 1; if (rec.truth[mid]!.simTimeS <= simTarget) a = mid; else b = mid - 1; }
    const record = rec.truth[a]!;
    const next = a + 1 < seg.end ? rec.truth[a + 1]! : null;
    const inGap = next !== null && next.tick > record.tick + 1 && simTarget >= record.simTimeS + dt;
    const discontinuity = this.lastSegment !== -1 && this.lastSegment !== lo;
    this.lastSegment = lo;
    return { record, segmentIndex: lo, timelineS: t, atStart, atEnd, discontinuity, inGap };
  }

  /** Resets playback state (the next frame reports no discontinuity). */
  reset(): void { this.lastSegment = -1; }
}
