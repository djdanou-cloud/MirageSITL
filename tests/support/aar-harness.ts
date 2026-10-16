// Browser harness for tests/browser/aar-storage.spec.ts (TASK-076): the real
// recorder Worker drains a recording queue into IndexedDB.
import { AAR_FORMAT, AAR_VERSION, RecordKind, RecordingProducer, chunkRecords, createRecordingQueue, ringBytesFor, type SessionManifest } from "../../packages/aar/src/format.ts";
import { IndexedDbChunkStore } from "../../packages/aar/src/storage.ts";

export interface WorkerRunResult { stats: Record<string, number>; storedTicks: number[]; manifestSeed: number | null; chunks: number }

export async function runRecorderWorker(workerUrl: string, records: number): Promise<WorkerRunResult> {
  const sessionId = `browser-${Date.now().toString(36)}`;
  const manifest: SessionManifest = { format: AAR_FORMAT, version: AAR_VERSION, sessionId, createdUtc: new Date().toISOString(), seed: 7, physicsHz: 400,
    modelHashes: { physics: "a".repeat(64), airframe: "b".repeat(64) }, timeDomains: { sim: "s since epoch start", wall: "ms performance.now() of producer" },
    chunkRecords: 64, ringBytes: ringBytesFor(60, 400, 64), ringSeconds: 60 };
  const queue = createRecordingQueue(4096), producer = new RecordingProducer(queue);
  const worker = new Worker(workerUrl, { type: "module" });
  const messages: { type: string; stats?: Record<string, number>; message?: string }[] = [];
  const next = (type: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}: ${JSON.stringify(messages)}`)), 10_000);
    worker.addEventListener("message", (e: MessageEvent<{ type: string }>) => { messages.push(e.data); if (e.data.type === type) { clearTimeout(timer); resolve(); } });
  });
  const ready = next("ready");
  worker.postMessage({ type: "init", manifest, queue, pumpMs: 10 });
  await ready;
  for (let t = 0; t < records; t++) {
    producer.next.kind = RecordKind.Truth; producer.next.epoch = 1; producer.next.tick = t; producer.next.simTimeS = t / 400; producer.next.wallTimeMs = performance.now();
    producer.values[0] = t;
    producer.commit();
  }
  const done = next("stats");
  await new Promise(resolve => setTimeout(resolve, 100));
  worker.postMessage({ type: "stop" });
  await done;
  await new Promise(resolve => setTimeout(resolve, 200));
  worker.terminate();
  const store = await IndexedDbChunkStore.open(`mirage-aar-${sessionId}`);
  const storedTicks: number[] = [];
  const seqs = await store.list();
  for (const seq of seqs) for (const r of chunkRecords((await store.get(seq))!)) storedTicks.push(r.tick);
  const m = await store.getManifest();
  store.close();
  await IndexedDbChunkStore.destroy(`mirage-aar-${sessionId}`);
  const stats = [...messages].reverse().find(x => x.type === "stats")?.stats ?? {};
  return { stats, storedTicks, manifestSeed: m?.seed ?? null, chunks: seqs.length };
}
