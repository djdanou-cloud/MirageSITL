import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { readExperiment } from "@mirage/aircraft/experiment";
import type { StoredVersion } from "@mirage/project/schema";
import type { StoreState } from "../shell/AppShell";
import type { SessionLink } from "../run/session-link";
import { CompareLogs } from "./CompareLogs";
import { FidelityReport } from "../experiments/FidelityReport";
import { ContextPanel } from "./ContextPanel";
import { externalLogContext, viewerEvents, type AnalysisContext } from "./experiment-adapter";
import { findExperimentLog, type Listed } from "./experiment-log";
import { LogViewerHost, type ViewerRequest } from "./LogViewerHost";
import type { ViewerEvent } from "./viewer-protocol";
import { NO_ALIGNMENT, type ComparedLog, type LogAlignment, type LogInterval } from "./log-alignment";

// The Analysis tab (TASK-179, TASK-180): the offline viewer, a stored experiment opened in it with its context, or a log from
// elsewhere with what that log can say. An experiment's file is the run's own DataFlash log while the launcher has it; otherwise one
// written from its stored recording, and the panel says which. Nothing leaves the machine.


/** An experiment the Experiments tab opens here; with a log to compare it against, already aligned (TASK-183). */
export interface AnalysisOpen {
  readonly sha256: string;
  readonly at: number;
  readonly compare?: { readonly name: string; readonly bytes: ArrayBuffer; readonly sha256: string; readonly interval: LogInterval; readonly secondOffsetS: number };
}
export function AnalysisTab({ storeState, project, link, active, openSha }: {
  storeState: StoreState; project: StoredVersion | null; link: SessionLink; active: boolean; openSha: AnalysisOpen | null;
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
  const [secondLog, setSecondLog] = useState<ComparedLog | null>(null);
  /** A copy of the first log, kept because the viewer takes the bytes it is sent, for comparing two intervals of one flight. */
  const firstLog = useRef<{ readonly name: string; readonly bytes: ArrayBuffer; readonly events: readonly ViewerEvent[]; readonly experimentSha256: string | null } | null>(null);
  const wanted = useRef<AnalysisOpen["compare"] | null>(null);
  const open = (next: ViewerRequest, experimentSha256: string | null) => {
    firstLog.current = { name: next.name, bytes: next.bytes.slice(0), events: next.events, experimentSha256 };
    setSecond(null); setSecondParsed(null); setSecondContext(null); setSecondLog(null); setAlignment(NO_ALIGNMENT);
    setRequest(next);
    // TASK-183: the log it came from comes with it, lined up at the start of the interval.
    const compare = wanted.current;
    wanted.current = null;
    if (compare) {
      const shown = externalLogContext(compare.name, new Uint8Array(compare.bytes));
      setSecondContext(shown);
      setSecondLog({ name: compare.name, sha256: compare.sha256, experimentSha256: null });
      setSecond({ id: `${compare.sha256}:${next.id}`, name: compare.name, bytes: compare.bytes, events: viewerEvents(shown) });
      setAlignment({ mode: "overlay", first: null, second: compare.interval, secondOffsetS: compare.secondOffsetS });
    }
  };
  const experimentLog = useCallback((item: Listed) => {
    if (!store || !projectId) return Promise.reject(new Error("No project is open"));
    return findExperimentLog(store, projectId, launcher, item);
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
  useEffect(() => { if (openSha) { wanted.current = openSha.compare ?? null; setSelected(openSha.sha256); } }, [openSha]);
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
  }, [store, projectId, current, experimentLog, openSha]);

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
        <CompareLogs store={store} projectId={projectId} experiments={experiments} firstLog={firstLog} secondLog={secondLog} secondParsed={secondParsed} secondContext={secondContext} alignment={alignment}
          experimentLog={experimentLog}
          onSecond={(next, shown, log) => { setSecondParsed(null); setSecondContext(shown); setSecondLog(log); setSecond(next); }}
          onAlignment={setAlignment} />
      )}
      {/* TASK-184: an experiment beside a real flight log, kept as a comparison of its profile version. */}
      {experiments.length > 0 && <FidelityReport store={store} projectId={projectId} experiments={experiments} experimentLog={experimentLog} />}
    </div>
  );
}
