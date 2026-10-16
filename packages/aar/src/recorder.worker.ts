/// <reference lib="webworker" />
import { RecordingHandoff } from "./handoff.ts";
import { RecordingRing } from "./recorder.ts";
import { AarRecord } from "./record.ts";
import { ChunkStorage } from "./storage.ts";
const scope = self as DedicatedWorkerGlobalScope;
let queue: RecordingHandoff | null = null,
  ring: RecordingRing | null = null,
  storage: ChunkStorage | null = null,
  timer: ReturnType<typeof setInterval> | null = null;
const record = new AarRecord(),
  chunk = new Uint8Array(64 * 512);
let chunkCount = 0,
  storageDropped = 0;
function flush(): void {
  if (!chunkCount) return;
  if (storage) {
    storage.write(chunk.subarray(0, chunkCount * 512));
  } else storageDropped += chunkCount;
  chunkCount = 0;
}
function drain(): void {
  if (!queue || !ring) return;
  for (let i = 0; i < 256 && queue.pop(record.words); i++)
    if (ring.append(record.bytes)) {
      chunk.set(record.bytes, chunkCount++ * 512);
      if (chunkCount === 64) flush();
    }
}
scope.onmessage = ({ data }: MessageEvent<unknown>) => {
  void handle(data);
};
async function handle(data: unknown): Promise<void> {
  if (typeof data !== "object" || data === null) return;
  const d = data as Record<string, unknown>;
  try {
    if (
      d.type === "init" &&
      queue === null &&
      d.queue instanceof SharedArrayBuffer
    ) {
      ring = new RecordingRing(d.manifest);
      queue = new RecordingHandoff(d.queue);
      try {
        storage = await ChunkStorage.open(
          "mirage-aar-" + crypto.randomUUID(),
          Math.ceil(ring.bytes.length / chunk.length),
          chunk.length,
        );
      } catch {
        storage = null;
      }
      timer = setInterval(drain, 10);
      scope.postMessage({ type: "ready", persistent: storage !== null });
    } else if (d.type === "snapshot" && ring) {
      drain();
      flush();
      await storage?.settled();
      scope.postMessage({
        type: "snapshot",
        manifest: ring.manifest,
        records: ring.snapshot(),
        evicted: ring.evicted,
        queueLost: queue?.lost ?? 0,
        invalid: ring.invalid,
        storageDropped: storageDropped + (storage?.droppedBytes ?? 0) / 512,
        persistent: storage !== null,
      });
    } else if (d.type === "close") {
      if (timer) clearInterval(timer);
      drain();
      flush();
      await storage?.settled();
      storage?.deleteOwnedDatabase();
      scope.postMessage({ type: "closed" });
      scope.close();
    }
  } catch (e) {
    scope.postMessage({
      type: "error",
      message: e instanceof Error ? e.message : "Recording failed",
    });
  }
}
