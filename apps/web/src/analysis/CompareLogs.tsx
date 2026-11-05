import { useEffect, useState, type ChangeEvent, type RefObject } from "react";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import type { Listed } from "./AnalysisTab";
import { ContextPanel } from "./ContextPanel";
import { externalLogContext, viewerEvents, type AnalysisContext } from "./experiment-adapter";
import { alignStarts, intervalOf, overlapS, readLogComparison, saveLogComparison, type CompareMode, type ComparedLog, type LogAlignment, type LogComparison } from "./log-alignment";
import type { ViewerRequest } from "./LogViewerHost";
import { dataflashRefusal, type ViewerEvent } from "./viewer-protocol";

// Two flights, or two intervals of one flight, in the integrated viewer (TASK-181, S14): the viewer draws the second log's curves dashed on the same value axis, overlaid or
// side by side, so matching quantities have one scale. Each log keeps its own parameter changes on its own timeline. Lining them up is the user's: align the starts, then shift
// by hand. A comparison shows and judges nothing (SA-01), and a saved one keeps the offset and the intervals.

const SHIFTS = [-1, -0.1, 0.1, 1] as const;
const seconds = (value: number) => Number(value.toFixed(6));
const sha256Of = async (bytes: ArrayBuffer): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");

export function CompareLogs({ store, projectId, experiments, firstLog, secondParsed, secondContext, alignment, experimentLog, onSecond, onAlignment }: {
  store: ProjectStore | null; projectId: string | null; experiments: readonly Listed[];
  firstLog: RefObject<{ readonly name: string; readonly bytes: ArrayBuffer; readonly events: readonly ViewerEvent[]; readonly experimentSha256: string | null } | null>;
  secondParsed: string | null; secondContext: AnalysisContext | null; alignment: LogAlignment;
  experimentLog: (item: Listed) => Promise<{ readonly request: ViewerRequest | null; readonly context: AnalysisContext; readonly note: string }>;
  onSecond: (second: ViewerRequest, context: AnalysisContext | null) => void; onAlignment: (alignment: LogAlignment) => void;
}) {
  const [secondLog, setSecondLog] = useState<ComparedLog | null>(null);
  const [firstFrom, setFirstFrom] = useState(""), [firstTo, setFirstTo] = useState(""), [secondFrom, setSecondFrom] = useState(""), [secondTo, setSecondTo] = useState("");
  const [refusal, setRefusal] = useState("");
  const [saved, setSaved] = useState<readonly { readonly stored: StoredVersion; readonly comparison: LogComparison }[]>([]);
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!store || !projectId) return;
    let cancelled = false;
    void store.listItems(projectId, "log-comparison").then(items => { if (!cancelled) setSaved(items.map(stored => ({ stored, comparison: readLogComparison(stored) }))); });
    return () => { cancelled = true; };
  }, [store, projectId, status]);

  const use = async (name: string, bytes: ArrayBuffer, events: readonly ViewerEvent[], experimentSha256: string | null, context: AnalysisContext | null) => {
    setRefusal(""); setStatus("");
    setSecondLog({ name, sha256: await sha256Of(bytes), experimentSha256 });
    onSecond({ id: `${name}:${bytes.byteLength}:${Date.now()}`, name, bytes, events }, context);
  };
  const sameFlight = () => {
    const first = firstLog.current;
    if (first) void use(first.name, first.bytes.slice(0), first.events, first.experimentSha256, null);
  };
  const chooseExperiment = (sha256: string) => {
    const item = experiments.find(entry => entry.stored.sha256 === sha256);
    if (!item) return;
    void experimentLog(item).then(found => {
      if (!found.request) { setRefusal(found.note); return; }
      void use(found.request.name, found.request.bytes, found.request.events, item.stored.sha256, found.context);
    });
  };
  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void file.arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer), why = dataflashRefusal(file.name, bytes);
      if (why) { setRefusal(why); return; }
      const shown = externalLogContext(file.name, bytes);
      void use(file.name, buffer, viewerEvents(shown), null, shown);
    });
  };
  /** The form's intervals, or null with the reason shown. */
  const intervals = (): Pick<LogAlignment, "first" | "second"> | null => {
    const first = intervalOf(firstFrom, firstTo), second = intervalOf(secondFrom, secondTo);
    if (typeof first === "string" || typeof second === "string") { setRefusal(typeof first === "string" ? first : second as string); return null; }
    setRefusal("");
    return { first, second };
  };
  const apply = () => { const shown = intervals(); if (shown) onAlignment({ ...alignment, ...shown }); };
  const alignTheStarts = () => { const shown = intervals(); if (shown) onAlignment({ ...alignment, ...shown, secondOffsetS: seconds(alignStarts(shown.first, shown.second)) }); };
  const useSaved = (comparison: LogComparison) => {
    const { first, second } = comparison.alignment;
    setFirstFrom(first ? String(first.fromS) : ""); setFirstTo(first ? String(first.toS) : ""); setSecondFrom(second ? String(second.fromS) : ""); setSecondTo(second ? String(second.toS) : "");
    onAlignment(comparison.alignment);
  };
  const save = () => {
    const first = firstLog.current;
    if (!store || !projectId || !first || !secondLog) return;
    void sha256Of(first.bytes).then(sha256 => saveLogComparison(store, projectId, { schemaVersion: 1, first: { name: first.name, sha256, experimentSha256: first.experimentSha256 }, second: secondLog, alignment })).then(
      stored => setStatus(`Saved as ${stored.record.name}.`), (cause: unknown) => setRefusal(`The comparison could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const overlap = overlapS(alignment);
  return (
    <section className="project-section" aria-labelledby="compare-logs-heading" data-testid="compare-logs">
      <h3 id="compare-logs-heading">Compare with a second log</h3>
      <p className="hint">Its curves appear dashed in the viewer for whatever you plot, on the same value axis. A quantity that log does not hold has no curve. Nothing here judges either flight.</p>
      <div className="button-row">
        <button type="button" onClick={sameFlight}>This flight again, for two intervals</button>
        {experiments.length > 0 && (
          <select aria-label="Compare with an experiment" value="" onChange={event => chooseExperiment(event.target.value)}>
            <option value="">Compare with an experiment…</option>
            {experiments.map(item => <option key={item.stored.sha256} value={item.stored.sha256}>{item.stored.record.name}</option>)}
          </select>
        )}
        <label className="log-viewer-open">Compare with a file (.bin)<input type="file" accept=".bin,.BIN,application/octet-stream" onChange={chooseFile} /></label>
      </div>
      {secondLog && <p className="hint" role="status" data-testid="compare-second">{secondParsed ? `Comparing with ${secondParsed}.` : `Reading ${secondLog.name}…`}</p>}
      {refusal && <p className="alert" role="alert" data-testid="compare-refusal">{refusal}</p>}
      {secondLog && (
        <>
          <div className="field-grid fault-fields">
            <div className="field">
              <label htmlFor="compare-mode">Show them</label>
              <select id="compare-mode" value={alignment.mode} onChange={event => onAlignment({ ...alignment, mode: event.target.value as CompareMode })}>
                <option value="overlay">Overlaid</option>
                <option value="side-by-side">Side by side</option>
              </select>
            </div>
            <div className="field"><label htmlFor="compare-first-from">First log from, s</label><input id="compare-first-from" value={firstFrom} onChange={event => setFirstFrom(event.target.value)} /></div>
            <div className="field"><label htmlFor="compare-first-to">First log to, s</label><input id="compare-first-to" value={firstTo} onChange={event => setFirstTo(event.target.value)} /></div>
            <div className="field"><label htmlFor="compare-second-from">Second log from, s</label><input id="compare-second-from" value={secondFrom} onChange={event => setSecondFrom(event.target.value)} /></div>
            <div className="field"><label htmlFor="compare-second-to">Second log to, s</label><input id="compare-second-to" value={secondTo} onChange={event => setSecondTo(event.target.value)} /></div>
          </div>
          <div className="button-row">
            <button type="button" onClick={apply}>Show these intervals</button>
            <button type="button" onClick={alignTheStarts}>Align the starts</button>
            {SHIFTS.map(step => <button key={step} type="button" onClick={() => onAlignment({ ...alignment, secondOffsetS: seconds(alignment.secondOffsetS + step) })}>{`${step > 0 ? "+" : ""}${step} s`}</button>)}
            <button type="button" onClick={save}>Save this comparison</button>
          </div>
          <p className="hint" data-testid="compare-offset" data-offset-s={alignment.secondOffsetS}>
            {`The second log is shifted by ${alignment.secondOffsetS} s.${overlap === null ? "" : ` The two intervals overlap for ${seconds(overlap)} s.`}`}
          </p>
          {status && <p className="hint" role="status" data-testid="compare-saved">{status}</p>}
          {secondContext && <div data-testid="compare-second-context"><ContextPanel context={secondContext} /></div>}
        </>
      )}
      {saved.length > 0 && (
        <details data-testid="compare-saved-list">
          <summary>{`${saved.length} saved ${saved.length === 1 ? "comparison" : "comparisons"}`}</summary>
          <ul>{saved.map(({ stored, comparison }) => <li key={stored.sha256}><button type="button" onClick={() => useSaved(comparison)}>{`Use the alignment of ${stored.record.name}`}</button></li>)}</ul>
        </details>
      )}
    </section>
  );
}
