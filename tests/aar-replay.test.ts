// TASK-077: snapshot replay and deterministic resimulation over a real
// recording of DemoDynamics (including a reset that starts a new epoch).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AAR_FORMAT, AAR_VERSION, GapReason, RecordKind, RecordingProducer, createRecordingQueue, ringBytesFor, type SessionManifest } from "../packages/aar/src/format.ts";
import { AarRecorder } from "../packages/aar/src/recorder.ts";
import { MemoryChunkStore } from "../packages/aar/src/storage.ts";
import { SnapshotReplay, openRecording } from "../packages/aar/src/replay.ts";
import { resimulate, type Resimulator } from "../packages/aar/src/resimulation.ts";
import { DemoDynamics } from "../packages/physics/src/demo-dynamics.ts";
import { newInput } from "../packages/protocol/src/index.ts";

const HZ = 400;
const HASHES = { physics: "1".repeat(64), airframe: "2".repeat(64) };
const manifest = (overrides: Partial<SessionManifest> = {}): SessionManifest => ({
  format: AAR_FORMAT, version: AAR_VERSION, sessionId: "replay-0001", createdUtc: "2026-10-16T12:00:00Z", seed: 9, physicsHz: HZ, modelHashes: HASHES,
  timeDomains: { sim: "s since epoch start", wall: "ms performance.now() of producer" }, chunkRecords: 128, ringBytes: ringBytesFor(60, 2 * HZ, 128), ringSeconds: 60,
  ...overrides,
});
const command = (tick: number) => [0.3 * Math.sin(tick / 150), 0.2 * Math.cos(tick / 210), 0.1, 0.55 + 0.1 * Math.sin(tick / 90), 1, 1];

/** DemoDynamics behind the Resimulator interface; `throttleScale` perturbs it for mismatch tests. */
class DemoResimulator implements Resimulator {
  readonly modelHashes = HASHES;
  private dyn = new DemoDynamics(HZ);
  private readonly input = newInput();
  constructor(private readonly throttleScale = 1) {}
  reset(): void { this.dyn = new DemoDynamics(HZ); }
  step(v: readonly number[], out: Float64Array): void {
    const i = this.input;
    i.roll = v[0]!; i.pitch = v[1]!; i.yaw = v[2]!; i.throttle = v[3]! * this.throttleScale; i.flags = 3; i.wallTimeMs = this.dyn.state.tick;
    this.dyn.step(i, this.dyn.state.tick);
    const s = this.dyn.state;
    out.set([s.north, s.east, s.down, s.vn, s.ve, s.vd, s.qw, s.qx, s.qy, s.qz, s.p, s.q]);
  }
}

/** Records two epochs: 3 s, reset, 2 s; optionally loses ticks [lostFrom, lostTo) of epoch 2 with a gap record. */
async function record(lost?: [number, number], continueTicks = false): Promise<MemoryChunkStore> {
  const queue = createRecordingQueue(1 << 14), store = new MemoryChunkStore(), producer = new RecordingProducer(queue);
  const recorder = new AarRecorder(manifest(), queue, store);
  await recorder.start();
  const sim = new DemoResimulator(), truth = new Float64Array(12);
  for (const [epoch, seconds] of [[1, 3], [2, 2]] as const) {
    sim.reset();
    for (let k = 1; k <= seconds * HZ; k++) {
      const cmd = command(k + epoch * 1000);
      sim.step(cmd, truth);
      if (lost && epoch === 2 && k >= lost[0] && k < lost[1]) {
        if (k === lost[0]) {
          producer.next.kind = RecordKind.Gap; producer.next.epoch = epoch; producer.next.tick = k - 1; producer.next.simTimeS = Number.NaN; producer.next.wallTimeMs = Number.NaN;
          producer.values.fill(0); producer.values.set([2 * (lost[1] - lost[0]), k - 1, k - 1, GapReason.QueueFull]); producer.commit();
        }
        continue;
      }
      for (const [kind, values] of [[RecordKind.Input, cmd], [RecordKind.Truth, [...truth]]] as const) {
        producer.next.kind = kind; producer.next.epoch = epoch; producer.next.tick = continueTicks && epoch === 2 ? k + 1200 : k; producer.next.simTimeS = k / HZ; producer.next.wallTimeMs = 1e6 + k * 2.5;
        producer.values.fill(0); producer.values.set(values); producer.commit();
      }
      if (k % 256 === 0) recorder.pump();
    }
  }
  await recorder.drainAndFlush();
  return store;
}
async function digest(store: MemoryChunkStore): Promise<string> {
  const h = createHash("sha256");
  for (const seq of await store.list()) h.update((await store.get(seq))!);
  h.update(JSON.stringify(await store.getManifest()));
  return h.digest("hex");
}

describe("snapshot replay", () => {
  it("lays epochs end to end and seeks within segments, clamping at the boundaries", async () => {
    const rec = await openRecording(await record(), HASHES);
    expect(rec.segments.map(s => [s.epoch, s.firstTick, s.lastTick])).toEqual([[1, 1, 1200], [2, 1, 800]]);
    expect(rec.durationS).toBeCloseTo(5, 9);
    const replay = new SnapshotReplay(rec);
    const start = replay.seek(-1);
    expect([start.atStart, start.record.epoch, start.record.tick, start.discontinuity]).toEqual([true, 1, 1, false]);
    expect(replay.seek(1.0).record.tick).toBe(401); // timeline 0 is tick 1 (t = 1/400 s), so 1 s later is tick 401
    expect(replay.seek(1.00249).record.tick).toBe(401); // between records: the last one at or before
    expect(replay.seek(1.0025).record.tick).toBe(402);
    const reset = replay.seek(3.0);
    expect([reset.record.epoch, reset.record.tick, reset.discontinuity, reset.segmentIndex]).toEqual([2, 1, true, 1]); // crossing the reset
    expect(replay.seek(3.5).discontinuity).toBe(false);
    expect(replay.seek(2.999).discontinuity).toBe(true); // back across the reset
    const end = replay.seek(99);
    expect([end.atEnd, end.record.epoch, end.record.tick]).toEqual([true, 2, 800]);
    expect(() => replay.seek(Number.NaN)).toThrow();
    // An epoch change splits the timeline even when tick numbers keep increasing (e.g. a model swap).
    const swapped = await openRecording(await record(undefined, true));
    expect(swapped.segments.map(s => [s.epoch, s.firstTick, s.lastTick])).toEqual([[1, 1, 1200], [2, 1201, 2000]]);
  });

  it("reports positions inside recorded loss and preserves the recording", async () => {
    const store = await record([200, 240]);
    const before = await digest(store);
    const rec = await openRecording(store);
    expect(rec.gaps).toHaveLength(1);
    expect(rec.gaps[0]!.values.slice(0, 4)).toEqual([80, 199, 199, GapReason.QueueFull]);
    const replay = new SnapshotReplay(rec);
    const inGap = replay.seek(3 + 210 / HZ);
    expect([inGap.record.tick, inGap.inGap]).toEqual([199, true]);
    expect(replay.seek(3 + 250 / HZ).inGap).toBe(false);
    expect(Object.isFrozen(rec.truth[0]!.values) && Object.isFrozen(rec.truth[0]) && Object.isFrozen(rec.truth)).toBe(true);
    for (let i = 0; i < 100; i++) replay.seek(i * 0.05);
    expect(await digest(store)).toBe(before);
  });

  it("rejects unknown formats, corrupt chunks and model hash mismatches", async () => {
    const store = await record();
    await expect(openRecording(store, { ...HASHES, physics: "3".repeat(64) })).rejects.toThrow("hash mismatch");
    const bad = new MemoryChunkStore();
    await bad.putManifest({ ...manifest(), version: 2 } as unknown as SessionManifest); // forged on purpose: the reader must reject it
    await expect(openRecording(bad)).rejects.toThrow();
    const corrupt = await record();
    const chunk = (await corrupt.get(0))!;
    chunk[100] = chunk[100]! ^ 0xff;
    await corrupt.put(0, chunk);
    await expect(openRecording(corrupt)).rejects.toThrow("checksum");
  });
});

describe("resimulation", () => {
  it("reproduces the recording bit for bit with the same model and seed", async () => {
    const store = await record();
    const before = await digest(store);
    const report = resimulate(await openRecording(store), new DemoResimulator(), { positionM: 1e-9, velocityMps: 1e-9, quaternionDot: 1 - 1e-12 });
    expect(report).toMatchObject({ verdict: "match", comparedTicks: 2000, maxPositionErrorM: 0, maxVelocityErrorMps: 0, mismatchCount: 0 });
    expect(1 - report.minQuaternionDot).toBeLessThan(1e-15); // identical unit quaternions: dot = 1 up to rounding
    expect(await digest(store)).toBe(before);
  });

  it("reports a mismatch without rewriting the recording", async () => {
    const store = await record();
    const before = await digest(store);
    const report = resimulate(await openRecording(store), new DemoResimulator(1.01), { positionM: 0.01, velocityMps: 0.05, quaternionDot: 0.9999 });
    expect(report.verdict).toBe("mismatch");
    expect(report.firstMismatch!.epoch).toBe(1);
    expect(report.firstMismatch!.tick).toBeGreaterThan(1);
    expect(report.mismatchCount).toBeGreaterThan(report.mismatches.length);
    expect(report.mismatches).toHaveLength(32);
    expect(report.manifest).toEqual({ sessionId: "replay-0001", seed: 9, modelHashes: HASHES });
    expect(await digest(store)).toBe(before);
  });

  it("marks segments after recorded loss incomplete and refuses another model", async () => {
    const rec = await openRecording(await record([200, 240]));
    const report = resimulate(rec, new DemoResimulator(), { positionM: 1e-9, velocityMps: 1e-9, quaternionDot: 1 - 1e-12 });
    expect(report.verdict).toBe("incomplete");
    expect(report.comparedTicks).toBe(1200 + 199);
    expect(report.incompleteSegments).toEqual([{ epoch: 2, fromTick: 200, reason: "missing ticks (recorded loss)" }]);
    const other: Resimulator = { ...new DemoResimulator(), modelHashes: { ...HASHES, airframe: "4".repeat(64) }, reset: () => undefined, step: () => undefined };
    expect(() => resimulate(rec, other, { positionM: 1, velocityMps: 1, quaternionDot: 0.5 })).toThrow("hash mismatch");
  });
});
