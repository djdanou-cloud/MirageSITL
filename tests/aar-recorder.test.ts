// TASK-076: AAR recording format, bounded ring and explicit loss accounting.
import { describe, expect, it } from "vitest";
import {
  AAR_FORMAT, AAR_VERSION, CHUNK_HEADER_BYTES, GapReason, RECORD_BYTES, RecordKind, RecordingConsumer, RecordingProducer, chunkBytes, chunkRecords,
  crc32, createRecordingQueue, parseManifest, readChunk, ringBytesFor, type AarRecord, type SessionManifest,
} from "../packages/aar/src/format.ts";
import { AarRecorder } from "../packages/aar/src/recorder.ts";
import { MemoryChunkStore } from "../packages/aar/src/storage.ts";
import { createSharedMemoryV2, createSpscQueue } from "../packages/protocol/src/index.ts";

const HASH = "e".repeat(64);
function manifest(overrides: Partial<SessionManifest> = {}): SessionManifest {
  return { format: AAR_FORMAT, version: AAR_VERSION, sessionId: "session-0001", createdUtc: "2026-10-16T12:00:00Z", seed: 42, physicsHz: 400,
    modelHashes: { physics: HASH, airframe: "f".repeat(64) }, timeDomains: { sim: "s since epoch start", wall: "ms performance.now() of producer" },
    chunkRecords: 256, ringBytes: ringBytesFor(1800, 40, 256), ringSeconds: 1800, ...overrides };
}
/** Producer helper: one record per call, values = [tick, kind, ...]. */
function push(p: RecordingProducer, kind: AarRecord["kind"], tick: number, epoch = 1, hz = 20): boolean {
  p.next.kind = kind; p.next.epoch = epoch; p.next.tick = tick; p.next.simTimeS = tick / hz; p.next.wallTimeMs = 1000 + tick * (1000 / hz);
  p.values.fill(0); p.values[0] = tick; p.values[1] = kind;
  return p.commit();
}
async function storedRecords(store: MemoryChunkStore): Promise<AarRecord[]> {
  const out: AarRecord[] = [];
  for (const seq of await store.list()) for (const r of chunkRecords((await store.get(seq))!)) out.push(r);
  return out;
}

describe("format", () => {
  it("uses the standard CRC-32 and validates manifests", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926); // IEEE 802.3 check value
    expect(parseManifest(manifest()).seed).toBe(42);
    for (const bad of [{ version: 2 }, { format: "other" }, { modelHashes: { physics: "x", airframe: HASH } }, { physicsHz: 500 }, { ringBytes: 10 },
      { timeDomains: { sim: "ticks", wall: "ms performance.now() of producer" } }, { sessionId: "../x" }]) {
      expect(() => parseManifest({ ...manifest(), ...bad }), JSON.stringify(bad)).toThrow();
    }
    expect(() => parseManifest({ ...manifest(), extra: 1 })).toThrow("fields");
  });

  it("round-trips records with both time domains, epoch and 64-bit ticks through a checked chunk", async () => {
    const queue = createRecordingQueue(64), store = new MemoryChunkStore();
    const producer = new RecordingProducer(queue), recorder = new AarRecorder(manifest({ chunkRecords: 16, ringBytes: chunkBytes(16) * 4 }), queue, store);
    await recorder.start();
    push(producer, RecordKind.Truth, 2 ** 40 + 5, 3);
    push(producer, RecordKind.Input, 2 ** 40 + 6, 3);
    recorder.pump(); recorder.flush(); await recorder.idle();
    const records = await storedRecords(store);
    expect(records.map(r => [r.kind, r.epoch, r.tick, r.values[0]])).toEqual([[3, 3, 2 ** 40 + 5, 2 ** 40 + 5], [1, 3, 2 ** 40 + 6, 2 ** 40 + 6]]);
    expect(records[0]!.simTimeS).toBe((2 ** 40 + 5) / 20);
    expect(records[0]!.wallTimeMs).toBe(1000 + (2 ** 40 + 5) * 50);
    expect(await store.getManifest()).toEqual(manifest({ chunkRecords: 16, ringBytes: chunkBytes(16) * 4 }));
    const bytes = (await store.get(0))!;
    expect(readChunk(bytes).records).toBe(2);
    const at = CHUNK_HEADER_BYTES + RECORD_BYTES + 40;
    bytes[at] = bytes[at]! ^ 1;
    expect(() => readChunk(bytes)).toThrow("checksum");
    expect(() => readChunk(bytes.subarray(0, bytes.length - 1))).toThrow("size");
  });

  it("never treats the render ring or an SPSC queue as an archive", () => {
    expect(() => new RecordingConsumer(createSharedMemoryV2())).toThrow("never archives");
    expect(() => new RecordingConsumer(createSpscQueue("sensor"))).toThrow("never archives");
    expect(() => new RecordingProducer(createSpscQueue("actuator"))).toThrow();
    const forged = createRecordingQueue(64);
    new Int32Array(forged)[0] = 0x4d534e53; // right version and size, wrong magic
    expect(() => new RecordingConsumer(forged)).toThrow("never archives");
  });
});

describe("recorder ring", () => {
  it("keeps a configured 30 min ring under its fixed byte cap for a 40 min session", async () => {
    const m = manifest(), queue = createRecordingQueue(1024), store = new MemoryChunkStore(), producer = new RecordingProducer(queue);
    const recorder = new AarRecorder(m, queue, store);
    await recorder.start();
    const hz = 20, ticks = 40 * 60 * hz;
    for (let t = 0; t < ticks; t++) {
      push(producer, RecordKind.Truth, t); push(producer, RecordKind.Input, t);
      if (t % 100 === 99) { recorder.pump(); await recorder.idle(); }
    }
    recorder.pump(); recorder.flush(); await recorder.idle();
    expect(store.peakBytes).toBeLessThanOrEqual(m.ringBytes);
    expect(recorder.stats.storedBytes).toBe(store.bytes);
    expect(recorder.stats).toMatchObject({ queueDroppedRecords: 0, gapRecords: 0, storageErrors: 0 });
    expect(recorder.stats.evictedChunks).toBeGreaterThan(0);
    const records = await storedRecords(store);
    const first = records[0]!.simTimeS, last = records.at(-1)!.simTimeS;
    expect(last).toBe((ticks - 1) / hz);
    expect(last - first).toBeGreaterThanOrEqual(1800); // at least the configured 30 minutes are retained
    expect(last - first).toBeLessThan(1800 + 2 * 256 / 40); // and at most two chunks more
    // Contiguous: no tick missing inside the retained window.
    const truth = records.filter(r => r.kind === RecordKind.Truth).map(r => r.tick);
    truth.forEach((t, i) => { if (i > 0) expect(t).toBe(truth[i - 1]! + 1); });
  }, 60_000);

  it("counts queue overflow explicitly and records a gap", async () => {
    const queue = createRecordingQueue(64), store = new MemoryChunkStore(), producer = new RecordingProducer(queue);
    const recorder = new AarRecorder(manifest(), queue, store);
    await recorder.start();
    let accepted = 0;
    for (let t = 0; t < 100; t++) if (push(producer, RecordKind.Truth, t)) accepted++;
    expect(accepted).toBe(64);
    recorder.pump();
    for (let t = 100; t < 110; t++) push(producer, RecordKind.Truth, t);
    recorder.pump(); recorder.flush(); await recorder.idle();
    expect(recorder.stats.queueDroppedRecords).toBe(36);
    const records = await storedRecords(store);
    const gaps = records.filter(r => r.kind === RecordKind.Gap);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.values.slice(0, 4)).toEqual([36, 63, 63, GapReason.QueueFull]); // lost count, from/to tick of the last stored record, reason
    expect(records.filter(r => r.kind === RecordKind.Truth)).toHaveLength(74);
  });

  it("absorbs storage stalls in the queue and counts overflow under backpressure explicitly", async () => {
    // Burst: 640 records arrive at once; storage allows one write in flight. Nothing is lost: the queue holds them.
    {
      const queue = createRecordingQueue(1024), store = new MemoryChunkStore(5), producer = new RecordingProducer(queue);
      const recorder = new AarRecorder(manifest({ chunkRecords: 16, ringBytes: chunkBytes(16) * 1000 }), queue, store, 1);
      await recorder.start();
      for (let t = 0; t < 640; t++) push(producer, RecordKind.Truth, t);
      recorder.pump();
      await recorder.drainAndFlush();
      expect(recorder.stats.storageStalls).toBeGreaterThan(0);
      expect(recorder.stats.queueDroppedRecords).toBe(0);
      expect((await storedRecords(store)).map(r => r.tick)).toEqual(Array.from({ length: 640 }, (_, t) => t));
    }
    // Sustained: production outruns slow storage and a small queue overflows; every record is stored or counted.
    const queue = createRecordingQueue(64), store = new MemoryChunkStore(20), producer = new RecordingProducer(queue);
    const recorder = new AarRecorder(manifest({ chunkRecords: 16, ringBytes: chunkBytes(16) * 1000 }), queue, store, 1);
    await recorder.start();
    let produced = 0;
    for (let burst = 0; burst < 30; burst++) {
      for (let k = 0; k < 32; k++) push(producer, RecordKind.Truth, produced++);
      recorder.pump();
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    while (consumerDepth(queue) > 0 || recorder.stats.pendingWrites > 0) { recorder.pump(); await new Promise(resolve => setTimeout(resolve, 2)); }
    recorder.flush(); await recorder.idle();
    const s = recorder.stats;
    const records = await storedRecords(store);
    const truth = records.filter(r => r.kind === RecordKind.Truth);
    const gaps = records.filter(r => r.kind === RecordKind.Gap);
    expect(s.queueDroppedRecords).toBeGreaterThan(0);
    expect(truth.length + s.queueDroppedRecords).toBe(produced);
    expect(gaps.reduce((a, g) => a + g.values[0]!, 0)).toBe(s.queueDroppedRecords);
    expect(gaps.some(g => g.values[3] === GapReason.StorageBackpressure)).toBe(true);
    // Stored records stay in tick order; each gap sits right after the last record before the loss.
    truth.forEach((r, i) => { if (i > 0) expect(r.tick).toBeGreaterThan(truth[i - 1]!.tick); });
  });
});

function consumerDepth(queue: SharedArrayBuffer): number { const w = new Int32Array(queue); return (Atomics.load(w, 3) - Atomics.load(w, 4)) >>> 0; }

describe("physics handoff", () => {
  it("commits 1e6 records without triggering GC", async () => {
    const queue = createRecordingQueue(4096), producer = new RecordingProducer(queue), consumer = new RecordingConsumer(queue);
    const sink = new Int32Array(RECORD_BYTES / 4);
    const state = { tick: 0 };
    const run = (n: number) => {
      let ok = 0;
      for (let i = 0; i < n; i++) {
        const p = producer, t = state.tick++;
        p.next.kind = 3; p.next.epoch = 1; p.next.tick = t; p.next.simTimeS = t * 0.0025; p.next.wallTimeMs = t * 2.5 + 0.25;
        for (let k = 0; k < 12; k++) p.values[k] = t * 0.5 + k;
        if (p.commit()) ok++;
        if ((i & 1023) === 1023) while (consumer.tryPopInto(sink, 0));
      }
      return ok;
    };
    expect(run(200_000)).toBe(200_000);
    const gcStarts: number[] = [];
    const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gcStarts.push(e.startTime); });
    observer.observe({ entryTypes: ["gc"] });
    const windows: number[][] = [];
    for (let w = 0; w < 3; w++) {
      const t0 = performance.now();
      expect(run(1_000_000)).toBe(1_000_000);
      const t1 = performance.now();
      windows.push([t0, t1]);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (gcStarts.every(t => t < t0 || t > t1)) break;
    }
    observer.disconnect();
    const perWindow = windows.map(([t0, t1]) => gcStarts.filter(t => t >= t0! && t <= t1!).length);
    expect(perWindow, JSON.stringify(perWindow)).toContain(0);
  }, 60_000);
});
