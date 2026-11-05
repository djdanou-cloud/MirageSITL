import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { reopenRecording } from "@mirage/aar/recorder-v2-host";
import { readExperiment, type ExperimentPayload } from "@mirage/aircraft/experiment";
import type { StoredVersion } from "@mirage/project/schema";
import type { StoreState } from "../shell/AppShell";
import type { SessionLink } from "../run/session-link";
import { readParameterLog, type ParameterChange } from "../params/parameter-sets";
import { CompareLogs } from "./CompareLogs";
import { ContextPanel } from "./ContextPanel";
import { experimentContext, externalLogContext, recordingDataflash, viewerEvents, type AnalysisContext } from "./experiment-adapter";
import { LogViewerHost, type ViewerRequest } from "./LogViewerHost";
import type { ViewerEvent } from "./viewer-protocol";
import { NO_ALIGNMENT, type LogAlignment } from "./log-alignment";

// The Analysis tab (TASK-179, TASK-180): the offline viewer, a stored experiment opened in it with its context, or a log from
// elsewhere with what that log can say. An experiment's file is the run's own DataFlash log while the launcher has it; otherwise one
// written from its stored recording, and the panel says which. Nothing leaves the machine.

export interface Listed { readonly stored: StoredVersion; readonly payload: ExperimentPayload }
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

export function AnalysisTab({ storeState, project, link, active, openSha }: {
  storeState: StoreState; project: StoredVersion | null; link: SessionLink; active: boolean; openSha: { readonly sha256: string; readonly at: number } | null;
}) {
  const store = storeState.status === "ready" ? storeState.store : null;
  const projectId = project?.record.id ?? null;
  const launcher = useSyncExternalStore(link.subscribe, () => link.launcher);
  const [experiments, setExperiments] = useState<readonly Listed[]>([]);
  const [selected, setSelected] = useState("");
  const [context, setContext] = useState<AnalysisContext | null>(null);
  const [request, setRequest] = useState<ViewerRequest | null>(null);
  const [fileNote, setFileNote] = useState("");
  // TASK-181: the second log and how it lines up; opening a first log starts a comparison afresh.
  const [second, setSecond] = useState<ViewerRequest | null>(null);
  const [alignment, setAlignment] = useState<LogAlignment>(NO_ALIGNMENT);
  const [secondParsed, setSecondParsed] = useState<string | null>(null);
  const [secondContext, setSecondContext] = useState<AnalysisContext | null>(null);
  /** A copy of the first log, kept because the viewer takes the bytes it is sent, for comparing two intervals of one flight. */
  const firstLog = useRef<{ readonly name: string; readonly bytes: ArrayBuffer; readonly events: readonly ViewerEvent[]; readonly experimentSha256: string | null } | null>(null);
  const open = (next: ViewerRequest, experimentSha256: string | null) => {
    firstLog.current = { name: next.name, bytes: next.bytes.slice(0), events: next.events, experimentSha256 };
    setSecond(null); setSecondParsed(null); setSecondContext(null); setAlignment(NO_ALIGNMENT);
    setRequest(next);
  };
  /** A stored experiment's log and context, as the first log or the second. */
  const experimentLog = useCallback(async (item: Listed): Promise<{ readonly request: ViewerRequest | null; readonly context: AnalysisContext; readonly note: string }> => {
    if (!store || !projectId) throw new Error("No project is open");
    // The run's own parameter history, if one was stored: none is ever made up.
    const logs = await store.listItems(projectId, "parameter-log");
    const own = logs.map(readParameterLog).filter(log => log.experimentSha256 === item.stored.sha256).at(-1);
    const changes: readonly ParameterChange[] | null = own ? own.changes : null;
    const shown = experimentContext(item.stored.record.name, item.payload, changes), events = viewerEvents(shown);
    const { sitl, recording, session } = item.payload;
    if (sitl.ownership === "launcher" && launcher) {
      try {
        const files = await launcher.logs(sitl.experimentId), name = (files.attachments ?? files.dataflash).at(-1);
        if (name) {
          const bytes = await launcher.dataflash(sitl.experimentId, name);
          return { request: { id: `${item.stored.sha256}:${name}`, name, bytes: toBuffer(bytes), events }, context: shown, note: `ArduPilot's own log of this run, ${name}, from the launcher.` };
        }
      } catch {
        // The launcher may be gone or no longer hold it: the recording is next.
      }
    }
    if (recording) {
      const opened = await reopenRecording(recording.recordId).catch(() => null);
      const bytes = opened ? recordingDataflash(opened.rows, session.home, changes) : null;
      if (bytes) {
        return { request: { id: `${item.stored.sha256}:recording`, name: `${item.stored.record.name}.bin`, bytes: toBuffer(bytes), events }, context: shown,
          note: `MirageSITL's truth from the stored recording, with no ArduPilot data: ${launcher ? "the launcher has no log of this run" : "enter the launcher's token on the Run tab for ArduPilot's own log"}.` };
      }
    }
    return { request: null, context: shown, note: "No log of this run is at hand: neither the launcher nor a stored recording has one." };
  }, [store, projectId, launcher]);

  useEffect(() => {
    if (!store || !projectId || !active) return;
    let cancelled = false;
    void store.listItems(projectId, "experiment").then(items => {
      if (cancelled) return;
      setExperiments(items.map(stored => ({ stored, payload: readExperiment(stored) })));
    });
    return () => { cancelled = true; };
  }, [store, projectId, active]);
  useEffect(() => { if (openSha) setSelected(openSha.sha256); }, [openSha]);
  const current = useMemo(() => experiments.find(item => item.stored.sha256 === selected) ?? null, [experiments, selected]);

  useEffect(() => {
    if (!store || !projectId || !current) return;
    let cancelled = false;
    void (async () => {
      setFileNote("Finding this experiment's log…");
      const found = await experimentLog(current);
      if (cancelled) return;
      setContext(found.context);
      setFileNote(found.note);
      if (found.request) open(found.request, current.stored.sha256);
    })();
    return () => { cancelled = true; };
  }, [store, projectId, current, launcher]);

  return (
    <div className="analysis-tab" data-testid="analysis-tab">
      {experiments.length > 0 && (
        <section className="project-section analysis-picker">
          <label htmlFor="analysis-experiment">Open an experiment of this project</label>
          <select id="analysis-experiment" value={selected} onChange={event => setSelected(event.target.value)}>
            <option value="">None</option>
            {experiments.map(item => <option key={item.stored.sha256} value={item.stored.sha256}>{item.stored.record.name}</option>)}
          </select>
          {current && <p className="hint" data-testid="analysis-file-note">{fileNote}</p>}
        </section>
      )}
      <div className="analysis-layout">
        <LogViewerHost active={active} request={request} second={second} alignment={alignment} onSecondParsed={name => setSecondParsed(name)}
          onFileChosen={(name, bytes) => {
            // A file from elsewhere: what it holds and no more.
            const shown = externalLogContext(name, new Uint8Array(bytes));
            setSelected("");
            setContext(shown);
            setFileNote("");
            open({ id: `file:${name}:${bytes.byteLength}:${Date.now()}`, name, bytes, events: viewerEvents(shown) }, null);
          }} />
        {context && <ContextPanel context={context} />}
      </div>
      {request && (
        <CompareLogs store={store} projectId={projectId} experiments={experiments} firstLog={firstLog} secondParsed={secondParsed} secondContext={secondContext} alignment={alignment}
          experimentLog={experimentLog}
          onSecond={(next, shown) => { setSecondParsed(null); setSecondContext(shown); setSecond(next); }}
          onAlignment={setAlignment} />
      )}
    </div>
  );
}
