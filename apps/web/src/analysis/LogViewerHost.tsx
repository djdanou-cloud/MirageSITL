import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  VIEWER_PATH, clearSecondLogMessage, dataflashRefusal, loadLogMessage, loadSecondLogMessage, parseViewerBuild, parseViewerMessage, setAlignmentMessage, setEventsMessage, setSecondEventsMessage,
  type ViewerBuild, type ViewerEvent,
} from "./viewer-protocol";
import { viewerAlignment, type LogAlignment } from "./log-alignment";

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

/** A log to open and the events to draw on its timeline; a new `id` opens it. */
export interface ViewerRequest { readonly id: string; readonly name: string; readonly bytes: ArrayBuffer; readonly events: readonly ViewerEvent[] }

export function LogViewerHost({ active, request = null, onFileChosen, second = null, alignment = null, onSecondParsed }: {
  active: boolean; request?: ViewerRequest | null; onFileChosen?: (name: string, bytes: ArrayBuffer) => void;
  /** TASK-181: a second log to compare, and how to line it up. */
  second?: ViewerRequest | null; alignment?: LogAlignment | null; onSecondParsed?: (name: string, messageTypes: number) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [availability, setAvailability] = useState<Availability>({ kind: "checking" });
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<LogStatus>({ kind: "none" });
  const frame = useRef<HTMLIFrameElement>(null);
  // A log chosen before the viewer reported ready waits here.
  const pending = useRef<{ name: string; bytes: ArrayBuffer; events: readonly ViewerEvent[] } | null>(null);

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

  const send = (name: string, bytes: ArrayBuffer, events: readonly ViewerEvent[]) => {
    const target = frame.current?.contentWindow;
    if (!target) {
      pending.current = { name, bytes, events };
      return;
    }
    const message = loadLogMessage(name, bytes);
    setStatus({ kind: "sending", name: message.name });
    // The viewer keeps these for the plot it makes of this log, so they go first; no events clears the last log's.
    target.postMessage(setEventsMessage(events), globalThis.location.origin);
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
          if (waiting) send(waiting.name, waiting.bytes, waiting.events);
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
        case "mirage.eventsSet":
        case "mirage.alignmentSet":
          break;
        case "mirage.secondLogParsed":
          parsedSecond.current?.(message.name, message.messageTypes);
          break;
      }
    };
    globalThis.addEventListener("message", onMessage);
    return () => globalThis.removeEventListener("message", onMessage);
  }, []);

  // TASK-181: a second log, once for each new id; none clears it. They wait for the viewer, as a first log does.
  const parsedSecond = useRef(onSecondParsed);
  parsedSecond.current = onSecondParsed;
  const shownSecond = useRef("");
  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (!ready || !target) return;
    const id = second?.id ?? "";
    if (id === shownSecond.current) return;
    shownSecond.current = id;
    if (!second) { target.postMessage(clearSecondLogMessage(), globalThis.location.origin); return; }
    target.postMessage(setSecondEventsMessage(second.events), globalThis.location.origin);
    target.postMessage(loadSecondLogMessage(second.name, second.bytes), globalThis.location.origin, [second.bytes]);
  }, [second, ready]);
  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (ready && target && alignment) target.postMessage(setAlignmentMessage(viewerAlignment(alignment)), globalThis.location.origin);
  }, [alignment, ready]);

  // A log the tab asks for, once for each new id.
  const shown = useRef("");
  useEffect(() => {
    if (!request || request.id === shown.current) return;
    shown.current = request.id;
    if (ready) send(request.name, request.bytes, request.events);
    else {
      pending.current = { name: request.name, bytes: request.bytes, events: request.events };
      setStatus({ kind: "sending", name: request.name });
    }
  }, [request, ready]);

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
      if (onFileChosen) { onFileChosen(file.name, buffer); return; }
      if (ready) send(file.name, buffer, []);
      else {
        pending.current = { name: file.name, bytes: buffer, events: [] };
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
