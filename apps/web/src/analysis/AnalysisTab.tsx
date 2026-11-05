import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { reopenRecording } from "@mirage/aar/recorder-v2-host";
import { readExperiment, type ExperimentPayload } from "@mirage/aircraft/experiment";
import type { StoredVersion } from "@mirage/project/schema";
import type { StoreState } from "../shell/AppShell";
import type { SessionLink } from "../run/session-link";
import { readParameterLog, type ParameterChange } from "../params/parameter-sets";
import { ContextPanel } from "./ContextPanel";
import { experimentContext, externalLogContext, recordingDataflash, viewerEvents, type AnalysisContext } from "./experiment-adapter";
import { LogViewerHost, type ViewerRequest } from "./LogViewerHost";

// The Analysis tab (TASK-179, TASK-180): the offline viewer, a stored experiment opened in it with its context, or a log from
// elsewhere with what that log can say. An experiment's file is the run's own DataFlash log while the launcher has it; otherwise one
// written from its stored recording, and the panel says which. Nothing leaves the machine.

interface Listed { readonly stored: StoredVersion; readonly payload: ExperimentPayload }
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
      // The run's own parameter history, if one was stored: none is ever made up.
      const logs = await store.listItems(projectId, "parameter-log");
      const own = logs.map(readParameterLog).filter(log => log.experimentSha256 === current.stored.sha256).at(-1);
      const changes: readonly ParameterChange[] | null = own ? own.changes : null;
      const shown = experimentContext(current.stored.record.name, current.payload, changes);
      if (cancelled) return;
      setContext(shown);
      const { sitl, recording, session } = current.payload;
      const events = viewerEvents(shown);
      if (sitl.ownership === "launcher" && launcher) {
        try {
          const logs = await launcher.logs(sitl.experimentId), name = (logs.attachments ?? logs.dataflash).at(-1);
          if (name) {
            const bytes = await launcher.dataflash(sitl.experimentId, name);
            if (cancelled) return;
            setFileNote(`ArduPilot's own log of this run, ${name}, from the launcher.`);
            setRequest({ id: `${current.stored.sha256}:${name}`, name, bytes: toBuffer(bytes), events });
            return;
          }
        } catch {
          // The launcher may be gone or no longer hold it: the recording is next.
        }
      }
      if (recording) {
        const opened = await reopenRecording(recording.recordId).catch(() => null);
        const bytes = opened ? recordingDataflash(opened.rows, session.home, changes) : null;
        if (cancelled) return;
        if (bytes) {
          setFileNote(`MirageSITL's truth from the stored recording, with no ArduPilot data: ${launcher ? "the launcher has no log of this run" : "enter the launcher's token on the Run tab for ArduPilot's own log"}.`);
          setRequest({ id: `${current.stored.sha256}:recording`, name: `${current.stored.record.name}.bin`, bytes: toBuffer(bytes), events });
          return;
        }
      }
      if (!cancelled) setFileNote("No log of this run is at hand: neither the launcher nor a stored recording has one.");
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
        <LogViewerHost active={active} request={request}
          onFileChosen={(name, bytes) => {
            // A file from elsewhere: what it holds and no more.
            const shown = externalLogContext(name, new Uint8Array(bytes));
            setSelected("");
            setContext(shown);
            setFileNote("");
            setRequest({ id: `file:${name}:${bytes.byteLength}:${Date.now()}`, name, bytes, events: viewerEvents(shown) });
          }} />
        {context && <ContextPanel context={context} />}
      </div>
    </div>
  );
}
