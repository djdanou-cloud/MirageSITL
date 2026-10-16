/// <reference lib="webworker" />
// AAR recorder Worker entry (TASK-076). Owns the consumer side of the
// recording queue and an IndexedDB ring for one session; physics only ever
// calls RecordingProducer.commit() on its own thread.
//
// Messages in:  { type: "init", manifest, queue: SharedArrayBuffer, pumpMs? }
//               { type: "flush" } | { type: "stop" }
// Messages out: { type: "ready" } | { type: "stats", stats } | { type: "error", message }
import { AarRecorder } from "./recorder.ts";
import { IndexedDbChunkStore } from "./storage.ts";
import { parseManifest } from "./format.ts";

let recorder: AarRecorder | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function fail(error: unknown): void { postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }); }

addEventListener("message", (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (typeof data !== "object" || data === null || !("type" in data)) return fail(new Error("Unknown recorder message"));
  switch (data.type) {
    case "init": {
      if (recorder || !("manifest" in data) || !("queue" in data) || !(data.queue instanceof SharedArrayBuffer)) return fail(new Error("Invalid recorder init"));
      const manifest = parseManifest(data.manifest), queue = data.queue;
      const pumpMs = "pumpMs" in data && typeof data.pumpMs === "number" && data.pumpMs >= 5 && data.pumpMs <= 1000 ? data.pumpMs : 50;
      IndexedDbChunkStore.open(`mirage-aar-${manifest.sessionId}`)
        .then(async store => {
          const r = new AarRecorder(manifest, queue, store);
          await r.start();
          recorder = r;
          let ticks = 0;
          timer = setInterval(() => {
            r.pump();
            if (++ticks % Math.max(1, Math.round(1000 / pumpMs)) === 0) postMessage({ type: "stats", stats: { ...r.stats } });
          }, pumpMs);
          postMessage({ type: "ready" });
        })
        .catch(fail);
      return;
    }
    case "flush":
      if (recorder) { recorder.pump(); recorder.flush(); postMessage({ type: "stats", stats: { ...recorder.stats } }); }
      return;
    case "stop":
      if (timer) clearInterval(timer);
      if (recorder) {
        const r = recorder;
        void r.drainAndFlush().then(() => postMessage({ type: "stats", stats: { ...r.stats } }), fail);
      }
      return;
    default:
      return fail(new Error("Unknown recorder message"));
  }
});
