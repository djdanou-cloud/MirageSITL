// TASK-081: session archive export/import, bomb/size/hash rejection before
// allocation, and secret redaction.
import { describe, expect, it } from "vitest";
import { AAR_FORMAT, AAR_VERSION, RecordKind, RecordingProducer, createRecordingQueue, ringBytesFor, type SessionManifest } from "../packages/aar/src/format.ts";
import { AarRecorder } from "../packages/aar/src/recorder.ts";
import { MemoryChunkStore } from "../packages/aar/src/storage.ts";
import { openRecording } from "../packages/aar/src/replay.ts";
import { DEFAULT_LIMITS, exportArchive, findSecrets, importArchive, inspectArchive, redactMetadata, type BlobLike } from "../packages/aar/src/archive.ts";

const HASHES = { physics: "1".repeat(64), airframe: "2".repeat(64) };
const MANIFEST: SessionManifest = { format: AAR_FORMAT, version: AAR_VERSION, sessionId: "archive-0001", createdUtc: "2026-10-16T12:00:00Z", seed: 3, physicsHz: 400,
  modelHashes: HASHES, timeDomains: { sim: "s since epoch start", wall: "ms performance.now() of producer" }, chunkRecords: 64, ringBytes: ringBytesFor(60, 800, 64), ringSeconds: 60 };
const GOOGLE_KEY = "AIza" + "SyD-0123456789abcdefghijklmnopqrstu"; // test-shaped, not a real key
const BRIDGE_TOKEN = "ab".repeat(32);
const METADATA = {
  app: "MirageSITL 0.1.0", notes: `bridge ${BRIDGE_TOKEN} and Authorization: Bearer abcdef123456`, apiKey: GOOGLE_KEY, bridgeToken: BRIDGE_TOKEN,
  gamepad: { id: "Xbox Wireless Controller (Vendor: 045e Product: 0b13)", serialNumber: "SN 7H3K92LQ", usbId: "045e:0b13" },
  radio: { name: "TX16S", firmware: "EdgeTX 2.10", description: "serial: TX16S-998877" },
  pilots: ["A. Instructor"], embedded: `key=${GOOGLE_KEY}`,
};

async function recordedStore(): Promise<MemoryChunkStore> {
  const queue = createRecordingQueue(4096), store = new MemoryChunkStore(), producer = new RecordingProducer(queue);
  const recorder = new AarRecorder(MANIFEST, queue, store);
  await recorder.start();
  for (let t = 1; t <= 600; t++) {
    for (const kind of [RecordKind.Input, RecordKind.Truth]) {
      producer.next.kind = kind; producer.next.epoch = 1; producer.next.tick = t; producer.next.simTimeS = t / 400; producer.next.wallTimeMs = t * 2.5;
      producer.values.fill(t); producer.commit();
    }
  }
  await recorder.drainAndFlush();
  return store;
}
/** Blob over bytes that counts how many bytes import actually reads. */
class CountingBlob implements BlobLike {
  read = 0;
  constructor(private readonly bytes: Uint8Array, readonly size = bytes.byteLength) {}
  slice(start: number, end: number) {
    const part = this.bytes.slice(start, Math.min(end, this.bytes.byteLength));
    this.read += part.byteLength;
    return { arrayBuffer: () => Promise.resolve(part.buffer) };
  }
}
function patch(bytes: Uint8Array, at: number, write: (v: DataView) => void): Uint8Array {
  const copy = bytes.slice();
  write(new DataView(copy.buffer, at));
  return copy;
}

describe("export and import", () => {
  it("round-trips a recording, its manifest, metadata and reports", async () => {
    const source = await recordedStore();
    const report = { verdict: "match", comparedTicks: 600 };
    const { bytes, summary, index } = await exportArchive(source, METADATA, [report]);
    expect(summary.totalBytes).toBe(bytes.byteLength);
    expect(summary.categories.chunk.entries).toBe(Math.ceil(1200 / 64));
    expect(summary.categories.manifest.entries).toBe(1);
    expect(summary.recordsByKind).toEqual({ input: 600, truth: 600 });
    expect(index.reduce((a, e) => a + e.bytes, 0)).toBeLessThan(bytes.byteLength);
    const target = new MemoryChunkStore();
    const result = await importArchive(new CountingBlob(bytes), target);
    expect(result.manifest).toEqual(MANIFEST);
    expect(result.reports).toEqual([report]);
    expect(result.chunks).toBe(summary.categories.chunk.entries);
    for (const seq of await source.list()) expect(await target.get(seq)).toEqual(await source.get(seq));
    const reopened = await openRecording(target, HASHES);
    expect(reopened.truth).toHaveLength(600);
    await expect(importArchive(new CountingBlob(bytes), target)).rejects.toThrow("not empty");
  });

  it("removes keys, tokens and serial identifiers, and never writes them into the archive", async () => {
    const { bytes, summary } = await exportArchive(await recordedStore(), METADATA);
    const text = new TextDecoder("latin1").decode(bytes);
    for (const secret of [GOOGLE_KEY, BRIDGE_TOKEN, "Bearer abcdef123456", "7H3K92LQ", "TX16S-998877", "045e:0b13"]) expect(text).not.toContain(secret);
    expect(summary.redactions).toBeGreaterThanOrEqual(7);
    const imported = await importArchive(new CountingBlob(bytes), new MemoryChunkStore());
    expect(imported.metadata).toMatchObject({ app: "MirageSITL 0.1.0", radio: { name: "TX16S", firmware: "EdgeTX 2.10" }, pilots: ["A. Instructor"] });
    expect(JSON.stringify(imported.metadata)).not.toMatch(/apiKey|bridgeToken|serialNumber|usbId/);
    // Model hashes are kept: they are configuration provenance, not credentials.
    expect(text).toContain(HASHES.physics);
    // Serial redaction is configurable; secrets are always removed.
    const kept = redactMetadata(METADATA, { redactSerials: false }).value;
    expect(JSON.stringify(kept)).toContain("SN 7H3K92LQ");
    expect(JSON.stringify(kept)).not.toContain(GOOGLE_KEY);
    expect(findSecrets(JSON.stringify(kept))).toEqual([]);
  });

  it("redacts credentials in attached reports and refuses an empty store", async () => {
    const report = { verdict: "mismatch", note: `rerun with key ${GOOGLE_KEY}`, token: BRIDGE_TOKEN };
    const { bytes } = await exportArchive(await recordedStore(), {}, [report]);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).not.toContain(GOOGLE_KEY);
    expect(text).not.toContain(BRIDGE_TOKEN);
    const imported = await importArchive(new CountingBlob(bytes), new MemoryChunkStore());
    expect(imported.reports).toEqual([{ verdict: "mismatch", note: "rerun with key [REDACTED]" }]);
    await expect(exportArchive(new MemoryChunkStore(), {})).rejects.toThrow("no manifest");
  });
});

describe("hostile archives", () => {
  it("rejects bombs and oversized declarations after reading only the header", async () => {
    const { bytes } = await exportArchive(await recordedStore(), {});
    const cases: [string, Uint8Array, number?][] = [
      ["too many entries", patch(bytes, 12, v => v.setUint32(0, 1e9, true))],
      ["index exceeds", patch(bytes, 16, v => v.setUint32(0, 2 ** 31, true))],
      ["size does not match", patch(bytes, 24, v => v.setFloat64(0, 2 ** 40, true))],
      ["Unsupported archive version", patch(bytes, 8, v => v.setUint32(0, 2, true))],
      ["Not an AAR archive", patch(bytes, 0, v => v.setUint8(0, 0x41))],
    ];
    for (const [message, data] of cases) {
      const blob = new CountingBlob(data);
      await expect(importArchive(blob, new MemoryChunkStore()), message).rejects.toThrow(message);
      expect(blob.read, message).toBe(64);
    }
    const huge = new CountingBlob(bytes, DEFAULT_LIMITS.maxArchiveBytes + 1);
    await expect(importArchive(huge, new MemoryChunkStore())).rejects.toThrow("size limit");
    expect(huge.read).toBe(0);
  });

  it("rejects tampered indexes, overlapping entries and payload hash mismatches before writing", async () => {
    const { bytes } = await exportArchive(await recordedStore(), { app: "x" });
    const indexLength = new DataView(bytes.buffer).getUint32(16, true);
    const tamperedIndex = bytes.slice(); tamperedIndex[64 + 10] = tamperedIndex[64 + 10]! ^ 1;
    await expect(importArchive(new CountingBlob(tamperedIndex), new MemoryChunkStore())).rejects.toThrow("index hash mismatch");
    const payload = bytes.slice(); payload[64 + indexLength + 200] = payload[64 + indexLength + 200]! ^ 1;
    const target = new MemoryChunkStore();
    await expect(importArchive(new CountingBlob(payload), target)).rejects.toThrow("hash mismatch");
    expect(await target.list()).toEqual([]);
    expect(await target.getManifest()).toBeNull();
    // A consistent archive whose index overlaps entries (re-signed index) is still rejected.
    const inspected = await inspectArchive(new CountingBlob(bytes));
    expect(inspected.index[1]!.offset).toBe(inspected.index[0]!.bytes);
    expect(inspected.summary.totalBytes).toBe(bytes.byteLength);
    const forged = await forgeIndex(bytes, index => { index[1]!.offset = 0; });
    await expect(importArchive(new CountingBlob(forged), new MemoryChunkStore())).rejects.toThrow("overlap");
    const oversized = await forgeIndex(bytes, index => { index[0]!.bytes = DEFAULT_LIMITS.maxEntryBytes + 1; });
    await expect(importArchive(new CountingBlob(oversized), new MemoryChunkStore())).rejects.toThrow("size limit");
  });
});

/** Rewrites the index (with a valid index hash) to test semantic validation. */
async function forgeIndex(bytes: Uint8Array, change: (index: { offset: number; bytes: number }[]) => void): Promise<Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset), indexLength = v.getUint32(16, true);
  const index = JSON.parse(new TextDecoder().decode(bytes.subarray(64, 64 + indexLength))) as { offset: number; bytes: number }[];
  change(index);
  const newIndex = new TextEncoder().encode(JSON.stringify(index));
  const payload = bytes.subarray(64 + indexLength);
  const out = new Uint8Array(64 + newIndex.byteLength + payload.byteLength);
  out.set(bytes.subarray(0, 64)); out.set(newIndex, 64); out.set(payload, 64 + newIndex.byteLength);
  const ov = new DataView(out.buffer);
  ov.setUint32(16, newIndex.byteLength, true); ov.setFloat64(24, out.byteLength, true);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", newIndex));
  out.set(digest, 32);
  return out;
}
