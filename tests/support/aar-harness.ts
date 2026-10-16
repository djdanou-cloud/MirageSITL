import { RecorderHost } from "../../packages/aar/src/recorder-host";
import { AarRecord } from "../../packages/aar/src/record";
import { ChunkStorage } from "../../packages/aar/src/storage";
import { newFlightStateV2 } from "@mirage/protocol";
export async function recordInWorker() {
  const host = new RecorderHost({
    formatVersion: 1,
    recordBytes: 512,
    modelSha256: "a".repeat(64),
    firmwareSha256: null,
    seed: 0,
    physicsHz: 400,
    recordHz: 10,
    durationS: 1,
    clock: "simulation",
    source: "producer",
  });
  const wait = async () => {
    const end = performance.now() + 5000;
    while (!host.ready) {
      if (performance.now() > end || host.error)
        throw new Error(host.error || "Recorder ready timeout");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await wait();
  const record = new AarRecord(),
    s = newFlightStateV2(),
    pilot = new Float64Array(4);
  try {
    for (let i = 0; i < 20; i++) {
      s.tickId.lo = i * 40;
      s.simTimeS = i / 10;
      record.encode(s, pilot, null, null);
      host.producer.push(record.words);
    }
    const snap = await host.snapshot();
    const name = "mirage-aar-test-" + crypto.randomUUID(),
      storage = await ChunkStorage.open(name, 2, 512, 0);
    storage.write(record.bytes);
    // With no pending slots a write during the in-flight transaction is a counted drop.
    const storageRejected = !storage.write(record.bytes) && storage.dropped === 1;
    await storage.settled();
    // With the default pending list the same burst is queued and written.
    const queuedName = "mirage-aar-test-" + crypto.randomUUID(),
      queued = await ChunkStorage.open(queuedName, 2, 512);
    queued.write(record.bytes);
    const storageQueued = queued.write(record.bytes) && queued.pendingChunks === 1;
    await queued.settled();
    const queuedDropped = queued.dropped;
    queued.deleteOwnedDatabase();
    for (let i = 0; i < 10; i++) {
      storage.write(record.bytes);
      await storage.settled();
    }
    storage.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(req.error ?? new Error("IndexedDB operation failed"));
    });
    const dbChunks = await new Promise<number>((resolve, reject) => {
      const req = db.transaction("chunks").objectStore("chunks").count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(req.error ?? new Error("IndexedDB operation failed"));
    });
    db.close();
    indexedDB.deleteDatabase(name);
    return {
      records: snap.records.length / 512,
      persistent: snap.persistent,
      queueLost: snap.queueLost,
      invalid: snap.invalid,
      dbChunks,
      storageRejected,
      storageQueued,
      queuedDropped,
    };
  } finally {
    host.close();
  }
}
