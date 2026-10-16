import { useState } from "react";
import { importArchive, exportArchive } from "@mirage/aar/archive";
import { SnapshotReplay } from "@mirage/aar/replay";
import { MAX_ARCHIVE_BYTES } from "@mirage/aar/format";
import type { SimulationRuntime } from "../runtime";
import { Review } from "./Review";
export function Export({ runtime }: { runtime: SimulationRuntime | null }) {
  const [status, setStatus] = useState("Recording off"),
    [busy, setBusy] = useState(false),
    [replay, setReplay] = useState<SnapshotReplay | null>(null),
    [recording, setRecording] = useState(false);
  const snapshot = async (download: boolean) => {
    setBusy(true);
    try {
      const s = await runtime?.recording?.snapshot();
      if (!s) throw new Error("Recorder not ready");
      setReplay(new SnapshotReplay(s.manifest, s.records));
      if (download) {
        const bytes = await exportArchive(s.manifest, s.records, {
            queueLost: s.queueLost,
            evicted: s.evicted,
            storageDropped: s.storageDropped,
          }),
          url = URL.createObjectURL(
            new Blob([bytes], { type: "application/octet-stream" }),
          ),
          a = document.createElement("a");
        a.href = url;
        a.download = "mirage-session.aar";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setStatus(
        `${s.records.length} bytes · truth/pilot snapshots · sensors/actuators unavailable in demo · queue loss ${s.queueLost} · evicted ${s.evicted} · storage dropped ${s.storageDropped} · ${s.persistent ? "IndexedDB" : "memory only"}`,
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Recording failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="control-section"
      aria-label="Session recording and export"
    >
      <h2>Session recording</h2>
      <p>
        Records demo truth and pilot controls at about 10 samples per simulated
        second for up to 30 minutes. Sensor and motor feedback are unavailable
        in demo; sampling gaps are marked. Archives include model identity and
        seed and exclude keys and serial identifiers.
      </p>
      <button
        disabled={!runtime?.ready || busy}
        onClick={() => {
          if (recording) {
            runtime?.stopRecording();
            setRecording(false);
            setStatus("Recording paused; snapshots retained");
          } else {
            setBusy(true);
            void runtime
              ?.startRecording()
              .then(
                () => {
                  setRecording(true);
                  setStatus("Recording demo-decimated snapshots");
                },
                (e: unknown) => setStatus(String(e)),
              )
              .finally(() => setBusy(false));
          }
        }}
      >
        {recording ? "Stop recording" : "Start recording"}
      </button>
      <button
        disabled={!runtime?.recording || busy}
        onClick={() => {
          void snapshot(false);
        }}
      >
        Review recording
      </button>
      <button
        disabled={!runtime?.recording || busy}
        onClick={() => {
          void snapshot(true);
        }}
      >
        Export session
      </button>
      <label>
        Import AAR (max 32 MiB)
        <input
          aria-label="Import AAR"
          type="file"
          accept=".aar"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.size > MAX_ARCHIVE_BYTES) {
              setStatus("AAR archive size rejected");
              return;
            }
            setBusy(true);
            void f
              .arrayBuffer()
              .then((b) => importArchive(new Uint8Array(b)))
              .then((a) => {
                setReplay(new SnapshotReplay(a.manifest, a.records));
                setStatus(
                  `${a.records.length} bytes imported · queue loss ${a.loss.queueLost} · evicted ${a.loss.evicted} · storage dropped ${a.loss.storageDropped}`,
                );
              })
              .catch((e: unknown) =>
                setStatus(e instanceof Error ? e.message : "Import failed"),
              )
              .finally(() => setBusy(false));
          }}
        />
      </label>
      <output role="status" data-testid="aar-status">
        {status}
      </output>
      {replay && <Review replay={replay} />}
    </section>
  );
}
