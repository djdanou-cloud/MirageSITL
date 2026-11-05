import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  VIEWER_PATH, dataflashRefusal, loadLogMessage, parseViewerBuild, parseViewerMessage, type ViewerBuild,
} from "./viewer-protocol";

// Analysis tab host for the offline UAVLogViewer (TASK-179, S14). The viewer is
// the TASK-179 build served from this origin at /uavlogviewer/; it loads only
// when the tab is first opened. Logs reach it through the origin-checked
// message interface (protocol 1), never through a URL.

type Availability =
  | { readonly kind: "checking" }
  | { readonly kind: "missing"; readonly detail: string }
  | { readonly kind: "available"; readonly build: ViewerBuild };

type LogStatus =
  | { readonly kind: "none" }
  | { readonly kind: "sending"; readonly name: string }
  | { readonly kind: "accepted"; readonly name: string; readonly bytes: number }
  | { readonly kind: "parsed"; readonly name: string; readonly messageTypes: number }
  | { readonly kind: "refused"; readonly reason: string };

function describe(status: LogStatus): string {
  switch (status.kind) {
    case "none": return "No log is open.";
    case "sending": return `Sending ${status.name} to the viewer…`;
    case "accepted": return `Parsing ${status.name} (${status.bytes.toLocaleString("en-US")} bytes)…`;
    case "parsed": return `Opened ${status.name}: ${status.messageTypes} message types.`;
    case "refused": return `Not opened: ${status.reason}`;
  }
}

export function LogViewerHost({ active }: { active: boolean }) {
  const [opened, setOpened] = useState(false);
  const [availability, setAvailability] = useState<Availability>({ kind: "checking" });
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<LogStatus>({ kind: "none" });
  const frame = useRef<HTMLIFrameElement>(null);
  // A log chosen before the viewer reported ready waits here.
  const pending = useRef<{ name: string; bytes: ArrayBuffer } | null>(null);

  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${VIEWER_PATH}build-manifest.json`, { cache: "no-store" });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const body: unknown = await response.json();
        const build = parseViewerBuild(body);
        if (cancelled) return;
        setAvailability(build ? { kind: "available", build } : { kind: "missing", detail: "The viewer folder holds no TASK-179 build manifest." });
      } catch (cause) {
        if (!cancelled) setAvailability({ kind: "missing", detail: `No viewer build is served at ${VIEWER_PATH} (${cause instanceof Error ? cause.message : String(cause)}).` });
      }
    })();
    return () => { cancelled = true; };
  }, [opened]);

  const send = (name: string, bytes: ArrayBuffer) => {
    const target = frame.current?.contentWindow;
    if (!target) {
      pending.current = { name, bytes };
      return;
    }
    const message = loadLogMessage(name, bytes);
    setStatus({ kind: "sending", name: message.name });
    target.postMessage(message, globalThis.location.origin, [bytes]);
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== globalThis.location.origin || event.source === null || event.source !== frame.current?.contentWindow) return;
      const message = parseViewerMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case "mirage.ready": {
          setReady(true);
          const waiting = pending.current;
          pending.current = null;
          if (waiting) send(waiting.name, waiting.bytes);
          break;
        }
        case "mirage.logAccepted":
          setStatus({ kind: "accepted", name: message.name, bytes: message.bytes });
          break;
        case "mirage.logRejected":
          setStatus({ kind: "refused", reason: message.reason });
          break;
        case "mirage.logParsed":
          setStatus({ kind: "parsed", name: message.name, messageTypes: message.messageTypes });
          break;
      }
    };
    globalThis.addEventListener("message", onMessage);
    return () => globalThis.removeEventListener("message", onMessage);
  }, []);

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void file.arrayBuffer().then(buffer => {
      const refusal = dataflashRefusal(file.name, new Uint8Array(buffer));
      if (refusal) {
        setStatus({ kind: "refused", reason: refusal });
        return;
      }
      if (ready) send(file.name, buffer);
      else {
        pending.current = { name: file.name, bytes: buffer };
        setStatus({ kind: "sending", name: file.name });
      }
    }, (cause: unknown) => setStatus({ kind: "refused", reason: `${file.name} could not be read (${cause instanceof Error ? cause.message : String(cause)}).` }));
  };

  return (
    <section className="log-viewer-host" aria-labelledby="log-viewer-title">
      <div className="log-viewer-bar">
        <h2 id="log-viewer-title">Flight log viewer</h2>
        {availability.kind === "available" && (
          <>
            <label className="log-viewer-open">
              Open DataFlash log (.bin)
              <input type="file" accept=".bin,.BIN,application/octet-stream" onChange={choose} />
            </label>
            <p className="log-viewer-status" role="status">{describe(status)}</p>
            <p className="hint">
              UAVLogViewer {availability.build.commit.slice(0, 8)} with {availability.build.patches} MirageSITL patches,
              offline. <a href={`${VIEWER_PATH}licenses/README.txt`} target="_blank" rel="noreferrer">Licenses and source</a>
            </p>
          </>
        )}
      </div>
      {availability.kind === "checking" && opened && <p role="status">Looking for the local viewer build…</p>}
      {availability.kind === "missing" && (
        <div className="log-viewer-missing" role="status">
          <p><strong>The log viewer is not installed.</strong> {availability.detail}</p>
          <p>Fix: run <code>node scripts/install-macos.mjs</code>, or build it alone with <code>node scripts/build-uavlogviewer.mjs</code>,
            then reload this page. Set <code>MIRAGE_UAVLOGVIEWER_DIR</code> when the build is in another folder.</p>
        </div>
      )}
      {availability.kind === "available" && (
        <iframe ref={frame} className="log-viewer-frame" title="UAVLogViewer" src={VIEWER_PATH} />
      )}
    </section>
  );
}
