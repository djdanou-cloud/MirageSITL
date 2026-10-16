import { createRecordingQueue, RecordingHandoff } from "./handoff.ts";
import { parseManifest, type AarManifest } from "./format.ts";
export interface RecordingSnapshot {
  manifest: AarManifest;
  records: Uint8Array;
  evicted: number;
  queueLost: number;
  invalid: number;
  storageDropped: number;
  persistent: boolean;
}
export class RecorderHost {
  readonly queue = createRecordingQueue();
  readonly producer = new RecordingHandoff(this.queue);
  private readonly worker = new Worker(
    new URL("./recorder.worker.ts", import.meta.url),
    { type: "module", name: "mirage-recorder" },
  );
  private pending: ((v: RecordingSnapshot) => void) | null = null;
  private reject: ((e: Error) => void) | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  ready = false;
  error = "";
  constructor(manifest: AarManifest) {
    this.worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (typeof data !== "object" || data === null) return;
      const d = data as Record<string, unknown>;
      if (d.type === "closed") {
        if (this.timeout) clearTimeout(this.timeout);
        this.worker.terminate();
        return;
      }
      if (d.type === "ready") this.ready = !this.closing;
      else if (
        d.type === "snapshot" &&
        d.records instanceof Uint8Array &&
        typeof d.evicted === "number" &&
        typeof d.queueLost === "number" &&
        typeof d.invalid === "number" &&
        typeof d.storageDropped === "number" &&
        typeof d.persistent === "boolean"
      ) {
        this.pending?.({
          manifest: parseManifest(d.manifest),
          records: d.records,
          evicted: d.evicted,
          queueLost: d.queueLost,
          invalid: d.invalid,
          storageDropped: d.storageDropped,
          persistent: d.persistent,
        });
        if (this.timeout) clearTimeout(this.timeout);
        this.pending = null;
        this.reject = null;
      } else if (d.type === "error") {
        this.fail(
          typeof d.message === "string" ? d.message : "Recording failed",
        );
      }
    };
    this.worker.onerror = (e) => this.fail(e.message);
    this.worker.postMessage({
      type: "init",
      queue: this.queue,
      manifest: parseManifest(manifest),
    });
  }
  private fail(message: string): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.error = message;
    this.reject?.(new Error(message));
    this.pending = this.reject = null;
  }
  snapshot(): Promise<RecordingSnapshot> {
    if (!this.ready || this.pending || this.error)
      return Promise.reject(
        new Error(this.error || "Recorder not ready or busy"),
      );
    return new Promise((resolve, reject) => {
      this.pending = resolve;
      this.reject = reject;
      this.worker.postMessage({ type: "snapshot" });
      this.timeout = setTimeout(
        () => this.fail("Recorder snapshot timed out"),
        5000,
      );
    });
  }
  close(): void {
    this.fail("Recorder closed");
    this.ready = false;
    this.closing = true;
    this.worker.postMessage({ type: "close" });
    this.timeout = setTimeout(() => this.worker.terminate(), 2000);
  }
}
