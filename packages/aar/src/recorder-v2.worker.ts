/// <reference lib="webworker" />
// Recorder v2 Worker (TASK-162): drains the producer's queue every 10 ms and
// Main's event and telemetry rows into format v2 chunks, and streams them to
// the persistent `mirage-recordings` database. A chunk is sealed when full or
// after one second of wall time with rows in it, which bounds what a crash
// can lose. The Worker holds the Web Lock `mirage-recording-<id>` while it
// records, so a later page can tell a live record from an interrupted one.
import { parseRecordHeader, recordKey } from "./format-v2.ts";
import { RecordingConsumerV2, RecordingQueueReaderV2 } from "./recorder-v2.ts";
import { IndexedDbRecordingBackend, recordingLockName, StreamWriter } from "./stream-storage.ts";

const scope = self as DedicatedWorkerGlobalScope;
const DRAIN_MS = 10, SEAL_MS = 1000, ROWS_PER_DRAIN = 8192;
let consumer: RecordingConsumerV2 | null = null;
let writer: StreamWriter | null = null;
let backend: IndexedDbRecordingBackend | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let releaseLock: (() => void) | null = null;
let lastSealMs = 0;

function tick(): void {
  if (!consumer) return;
  consumer.drain(ROWS_PER_DRAIN);
  const now = performance.now();
  if (now - lastSealMs >= SEAL_MS) { consumer.flush(); lastSealMs = now; }
}
function post(message: Record<string, unknown>): void { scope.postMessage(message); }

async function init(queue: unknown, headerInput: unknown): Promise<void> {
  if (consumer) throw new Error("The recorder is already initialized");
  if (!(queue instanceof SharedArrayBuffer)) throw new Error("A recording queue is required");
  const header = parseRecordHeader(headerInput);
  const reader = new RecordingQueueReaderV2(queue);
  // The lock is taken before the catalog entry exists, so no reader can see the entry without its live lock.
  await new Promise<void>((acquired, refused) => {
    navigator.locks.request(recordingLockName(header.recordId), { ifAvailable: true }, lock => {
      if (!lock) { refused(new Error("Another recorder holds this record")); return undefined; }
      acquired();
      return new Promise<void>(release => { releaseLock = release; });
    }).catch(refused);
  });
  backend = await IndexedDbRecordingBackend.open();
  writer = await StreamWriter.start(backend, header);
  writer.bindCounters(reader);
  consumer = new RecordingConsumerV2(reader, recordKey(header.recordId), writer);
  lastSealMs = performance.now();
  timer = setInterval(tick, DRAIN_MS);
  post({ type: "ready", recordId: header.recordId });
}

async function close(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (!consumer || !writer) throw new Error("The recorder is not initialized");
  consumer.finish();
  const entry = await writer.close();
  post({ type: "closed", entry, invalidRows: consumer.invalidRows, failures: writer.failures, lastError: writer.lastError });
  consumer = null;
  backend?.close();
  releaseLock?.();
  scope.close();
}

scope.onmessage = ({ data }: MessageEvent<unknown>) => {
  if (typeof data !== "object" || data === null || !("type" in data)) return;
  const run = async (): Promise<void> => {
    switch (data.type) {
      case "init": await init("queue" in data ? data.queue : null, "header" in data ? data.header : null); break;
      case "rows": {
        const rows = "rows" in data ? data.rows : null;
        if (!consumer || !Array.isArray(rows)) throw new Error("Rows before the recorder is ready");
        for (const row of rows) if (!(row instanceof Uint8Array) || !consumer.appendRow(row)) post({ type: "row-rejected" });
        break;
      }
      case "status":
        if (writer && consumer) post({ type: "status", entry: writer.current, chunks: consumer.chunks, invalidRows: consumer.invalidRows, failures: writer.failures });
        break;
      case "close": await close(); break;
      default: break;
    }
  };
  run().catch((error: unknown) => post({ type: "error", message: error instanceof Error ? error.message : String(error) }));
};
