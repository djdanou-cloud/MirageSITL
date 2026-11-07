import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ParameterMetadata } from "@mirage/autopilot/param-metadata";
import { parseParameterValue } from "@mirage/autopilot/param-service";
import type { StoredVersion } from "@mirage/project/schema";
import type { StoreState } from "../shell/AppShell";
import type { SessionLink } from "../run/session-link";
import { ParameterExport, type LiveParameters } from "./ParameterExport";
import { ParameterHistory, valueText } from "./ParameterHistory";
import {
  compareParameters, readParameterLog, readParameterSet, restorePlan, saveParameterSet, snapshotOf, type ParameterLog, type ParameterSet,
  type RestorePlan,
} from "./parameter-sets";

// The Parameters tab (TASK-160, S11): the actual parameters of the SITL that
// the Run tab's current run talks to, read with the TASK-159 parameter
// service. A value is written before or during flight, and while paused,
// where a paused lockstep SITL answers after Resume (TASK-129). Each write
// shows its state (requested, confirmed, refused, timed out or no longer
// current) and whether ArduPilot uses it only after a restart; ArduPilot
// V4.7.2 accepts writes while armed (GCS_Param.cpp handle_param_set), so
// no change needs a disarm. Every change is logged with the run, and a set
// of the current values can be saved, compared and sent back. A parameter
// file of the values is exported for loading by hand (TASK-161).

/** Rows shown at once; a search narrows the rest. */
const SHOWN_ROWS = 60;
/** Differences listed at once in a comparison. */
const SHOWN_DIFFERENCES = 200;

interface StoredSet { readonly stored: StoredVersion; readonly set: ParameterSet }
const LIVE = "live";

function rangeText(facts: ParameterMetadata | undefined): string {
  if (!facts?.range) return "";
  return `${valueText(Math.fround(facts.range[0]))} to ${valueText(Math.fround(facts.range[1]))}`;
}
function choicesText(facts: ParameterMetadata): string | null {
  if (facts.values) return facts.values.map(([value, label]) => `${value}: ${label}`).join(", ");
  if (facts.bitmask) return `Bits ${facts.bitmask.map(([bit, label]) => `${bit}: ${label}`).join(", ")}`;
  return null;
}

export function ParametersTab({ storeState, project, link, active }: { storeState: StoreState; project: StoredVersion | null; link: SessionLink; active: boolean }) {
  const session = useSyncExternalStore(link.subscribe, link.snapshot);
  const controller = session?.controller ?? null;
  const view = session?.view ?? null;
  const parameters = view?.parameters ?? null;
  const metadata = controller?.parameterMetadata ?? null;
  const revision = parameters?.revision ?? -1;
  // The list changes only with the revision; reading it on every view would copy it at each Worker status.
  const list = useMemo(() => revision < 0 || !controller ? [] : controller.parameterList(), [controller, revision]);
  const store = storeState.status === "ready" ? storeState.store : null;
  const projectId = project?.record.id ?? null;

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [entry, setEntry] = useState("");
  const [notice, setNotice] = useState("");
  const [setName, setSetName] = useState("");
  const [sets, setSets] = useState<readonly StoredSet[]>([]);
  const [logs, setLogs] = useState<readonly ParameterLog[]>([]);
  const [setA, setSetA] = useState("");
  const [setB, setSetB] = useState(LIVE);
  const [restore, setRestore] = useState<RestorePlan | null>(null);
  const changeCount = parameters?.changes.length ?? 0;

  // Stored sets and the logs of earlier runs, read again whenever the tab is shown or the run logs a change.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!store || !projectId || !active) return;
    let cancelled = false;
    void Promise.all([store.listItems(projectId, "parameter-set"), store.listItems(projectId, "parameter-log")]).then(([storedSets, storedLogs]) => {
      if (cancelled) return;
      setSets(storedSets.flatMap(stored => { try { return [{ stored, set: readParameterSet(stored) }]; } catch { return []; } }));
      setLogs(storedLogs.flatMap(stored => { try { return [readParameterLog(stored)]; } catch { return []; } })
        .sort((a, b) => (b.changes[0]?.requestedAt ?? "").localeCompare(a.changes[0]?.requestedAt ?? "")));
    }, (cause: unknown) => { if (!cancelled) setNotice(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [store, projectId, active, reload, changeCount]);
  useEffect(() => { setSetA(current => sets.some(s => s.stored.sha256 === current) ? current : sets[0]?.stored.sha256 ?? ""); }, [sets]);

  const query = search.trim().toUpperCase();
  const matches = useMemo(() => query === "" ? list : list.filter(p => p.name.includes(query) || (metadata?.get(p.name)?.displayName.toUpperCase().includes(query) ?? false)),
    [list, query, metadata]);
  const chosen = selected === null ? undefined : list.find(p => p.name === selected);
  const facts = selected === null ? undefined : metadata?.get(selected);
  const paused = view?.state.name === "paused";
  const experimentId = view && "experimentId" in view.state ? view.state.experimentId : null;

  const write = (name: string, value: number) => {
    const refused = controller?.setParameter(name, value) ?? "No run is active";
    setNotice(refused ?? "");
  };
  const submit = () => {
    if (!chosen) return;
    const value = parseParameterValue(entry);
    if (value === null) { setNotice(`"${entry}" is not a number`); return; }
    write(chosen.name, value);
  };
  const saveSet = () => {
    const download = parameters?.download, commit = parameters?.firmwareCommit, record = view?.recordSha256;
    if (!store || !projectId || !controller || download?.kind !== "complete" || parameters?.stale || !commit || !record || !experimentId) {
      setNotice("A set is saved from a run whose complete parameter list is downloaded and whose experiment record is saved");
      return;
    }
    const at = controller.tickNow();
    const set: ParameterSet = { schemaVersion: 1, source: { kind: "run", experimentId, experimentSha256: record, firmwareCommit: commit, tick: at.tick, simTimeS: at.simTimeS },
      parameters: snapshotOf(list) };
    saveParameterSet(store, projectId, setName.trim() === "" ? `Parameters of ${experimentId}` : setName, set).then(stored => {
      setNotice(`Saved set "${stored.record.name}" with ${set.parameters.length} parameters`);
      setSetA(stored.sha256);
      setReload(n => n + 1);
    }, (cause: unknown) => setNotice(`The set was not saved: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const a = sets.find(s => s.stored.sha256 === setA);
  const b = setB === LIVE ? null : sets.find(s => s.stored.sha256 === setB);
  const differences = useMemo(() => a ? compareParameters(a.set.parameters, b ? b.set.parameters : snapshotOf(list)) : null, [a, b, list]);
  const sendSet = () => {
    if (!a || !controller) return;
    const plan = restorePlan(a.set.parameters, list, metadata);
    for (const entry of plan.writes) {
      const refused = controller.setParameter(entry.name, entry.value);
      if (refused) { setNotice(refused); return; }
    }
    setRestore(plan);
  };

  const download = parameters?.download;
  // TASK-161: only ArduPilot's reported values are exported; a pending write's value is named in the preview, never written to the file.
  // The session view is a new object at every Worker status, so the memo keys on what changes rarely: the change list's
  // identity and the list's revision. Recomputing on every status redrew the export preview about ten times a second
  // and blocked the main thread for some 300 ms, which stopped manual control's stick commands (TASK-174).
  const changes = parameters?.changes ?? null, recordSha256 = view?.recordSha256 ?? null;
  const live = useMemo((): LiveParameters | null => {
    if (!changes || download?.kind !== "complete" || !experimentId) return null;
    const pending = new Map(changes.flatMap(c => c.outcome.kind === "requested" ? [[c.name, c.outcome.requested] as const] : []));
    return { list, pending, experimentId, recordSha256 };
  }, [changes, download?.kind, experimentId, list, recordSha256]);
  const statusText = !parameters ? "No run has loaded its parameters. Start or connect a run with the ArduPilot SITL backend in the Run tab."
    : download?.kind === "downloading" ? `Downloading the parameter list: ${download.received} of ${download.total ?? "?"} received`
      : download?.kind === "failed" ? `The download failed: ${download.reason}`
        : download?.kind === "complete" ? `${download.total} parameters of ArduPilot ${parameters.firmwareCommit?.slice(0, 8) ?? "of unknown source"} in run ${experimentId ?? "?"}`
          : "The parameter list has not been requested";

  // A hidden tab keeps its state but draws nothing: the session updates it at every Worker status.
  if (!active) return <div className="parameters-panel" />;
  return (
    <div className="parameters-panel">
      <h2>Parameters</h2>
      <p>
        The parameters of the SITL that the Run tab&apos;s current run talks to, as ArduPilot reports them. A write is confirmed only by ArduPilot&apos;s
        own read-back. ArduPilot accepts writes while armed, so no change needs a disarm; a change marked as needing a restart is stored but takes effect
        only after SITL restarts.
      </p>
      <section className="project-section" aria-labelledby="parameters-run-heading">
        <h3 id="parameters-run-heading">Run</h3>
        <p className="hint" role="status" data-testid="parameters-status" data-download={download?.kind ?? "none"}>{statusText}</p>
        {parameters && !parameters.metadata && <p className="hint">MirageSITL has no metadata for this ArduPilot build: restarts, ranges and descriptions are not known.</p>}
        {parameters?.stale && (
          <p className="alert" role="status">
            ArduPilot renumbered its list, which happens when a write shows or hides a parameter group.
            <button type="button" onClick={() => setNotice(controller?.refreshParameters() ?? "")}>Download again</button>
          </p>
        )}
        {parameters && parameters.writeRefusal && <p className="hint" data-testid="parameters-write-refusal">{parameters.writeRefusal}</p>}
        {paused && parameters && !parameters.writeRefusal && (
          <p className="hint" data-testid="parameters-paused">
            The run is paused. A write is sent now; the paused SITL waits in lockstep and answers after Resume, so its state stays requested until then.
          </p>
        )}
        {parameters && parameters.rebootPending.length > 0 && (
          <p className="alert" role="status" data-testid="parameters-reboot-pending">
            Stored but not applied until SITL restarts: {parameters.rebootPending.join(", ")}
          </p>
        )}
        {notice && <p className="alert" role="alert" data-testid="parameters-notice">{notice}</p>}
      </section>

      {list.length > 0 && (
        <section className="project-section" aria-labelledby="parameters-list-heading">
          <h3 id="parameters-list-heading">Values</h3>
          <div className="field">
            <label htmlFor="parameter-search">Search parameters</label>
            <input id="parameter-search" type="search" value={search} onChange={event => setSearch(event.target.value)} />
          </div>
          <div className="table-scroll">
            <table className="scheme-table" data-testid="parameter-table">
              <thead>
                <tr><th scope="col">Name</th><th scope="col">Value</th><th scope="col">Units</th><th scope="col">Range</th><th scope="col">Restart</th>
                  <th scope="col">Description</th></tr>
              </thead>
              <tbody>
                {matches.slice(0, SHOWN_ROWS).map(p => {
                  const known = metadata?.get(p.name);
                  return (
                    <tr key={p.name} data-name={p.name} className={p.name === selected ? "selected" : undefined}>
                      <th scope="row">
                        <button type="button" className="link-button" onClick={() => { setSelected(p.name); setEntry(valueText(p.value)); setNotice(""); }}>{p.name}</button>
                      </th>
                      <td data-testid="parameter-value">{valueText(p.value)}</td>
                      <td>{known?.units ?? ""}</td>
                      <td>{rangeText(known)}</td>
                      <td>{known ? (known.rebootRequired ? "Needed" : "No") : "Unknown"}</td>
                      <td>{known?.displayName ?? ""}{known?.readOnly ? " (read-only)" : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {matches.length > SHOWN_ROWS && <p className="hint">Showing {SHOWN_ROWS} of {matches.length}; refine the search to see the others.</p>}
          {matches.length === 0 && <p className="hint">No parameter matches.</p>}
          {chosen && (
            <div className="parameter-editor" data-testid="parameter-editor" data-name={chosen.name}>
              <h4>{chosen.name}{facts ? `: ${facts.displayName}` : ""}</h4>
              {facts && <p className="hint">{facts.description}</p>}
              {facts && choicesText(facts) && <p className="hint">{choicesText(facts)}</p>}
              <p className="hint">
                Current value {valueText(chosen.value)}{facts?.units ? ` ${facts.units}` : ""}.
                {facts ? (facts.rebootRequired ? " A change takes effect only after SITL restarts." : " A change takes effect when ArduPilot confirms it.") : ""}
                {facts?.readOnly ? " ArduPilot does not accept writes of this parameter from a ground station." : ""}
              </p>
              <div className="sitl-actions">
                <label htmlFor="parameter-entry">New value of {chosen.name}</label>
                <input id="parameter-entry" type="text" inputMode="decimal" value={entry} onChange={event => setEntry(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") submit(); }} />
                <button type="button" onClick={submit} disabled={!parameters || parameters.writeRefusal !== null}>Write</button>
              </div>
            </div>
          )}
        </section>
      )}

      <ParameterHistory changes={parameters?.changes ?? []} earlier={logs.filter(log => log.experimentId !== experimentId)}
        onSendBack={parameters && parameters.writeRefusal === null ? write : null} />

      <section className="project-section" aria-labelledby="parameter-sets-heading">
        <h3 id="parameter-sets-heading">Parameter sets</h3>
        <p className="hint">
          A set keeps the values the running SITL reports now, with the run they come from. Compare a set with the running SITL or another set, and send
          a set&apos;s values back: only differing values are written, and parameters that ArduPilot marks read-only or changes itself are skipped.
        </p>
        <div className="sitl-actions">
          <label htmlFor="parameter-set-name">Set name</label>
          <input id="parameter-set-name" type="text" value={setName} onChange={event => setSetName(event.target.value)} />
          <button type="button" onClick={saveSet} disabled={!project || download?.kind !== "complete"}>Save as parameter set</button>
        </div>
        {!project && <p className="hint">Open a project to keep parameter sets.</p>}
        {sets.length > 0 && (
          <>
            <div className="sitl-actions">
              <label htmlFor="parameter-set-a">Set</label>
              <select id="parameter-set-a" value={setA} onChange={event => { setSetA(event.target.value); setRestore(null); }}>
                {sets.map(s => <option key={s.stored.sha256} value={s.stored.sha256}>{`${s.stored.record.name} (version ${s.stored.record.version}, ${s.set.parameters.length} parameters)`}</option>)}
              </select>
              <label htmlFor="parameter-set-b">Compare with</label>
              <select id="parameter-set-b" value={setB} onChange={event => setSetB(event.target.value)}>
                <option value={LIVE}>The running SITL</option>
                {sets.map(s => <option key={s.stored.sha256} value={s.stored.sha256}>{`${s.stored.record.name} (version ${s.stored.record.version})`}</option>)}
              </select>
              <button type="button" onClick={sendSet} disabled={!a || parameters?.writeRefusal !== null || parameters === null}>Send the set&apos;s values to the running SITL</button>
            </div>
            {a && <p className="hint">{`From run ${a.set.source.experimentId} at ${a.set.source.simTimeS.toFixed(1)} s (tick ${a.set.source.tick}), ArduPilot ${a.set.source.firmwareCommit.slice(0, 8)}`}</p>}
            {differences && (setB !== LIVE || list.length > 0) && (
              differences.length === 0 ? <p className="hint" data-testid="parameter-comparison-equal">No value differs.</p> : (
                <div className="table-scroll">
                  <table className="scheme-table" data-testid="parameter-comparison">
                    <caption>{`${differences.length} ${differences.length === 1 ? "parameter differs" : "parameters differ"}`}</caption>
                    <thead><tr><th scope="col">Parameter</th><th scope="col">Set</th><th scope="col">{b ? b.stored.record.name : "Running SITL"}</th></tr></thead>
                    <tbody>
                      {differences.slice(0, SHOWN_DIFFERENCES).map(d => (
                        <tr key={d.name} data-name={d.name}><td>{d.name}</td><td>{valueText(d.a)}</td><td>{valueText(d.b)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            {restore && (
              <div data-testid="parameter-restore">
                <p className="hint">{`Sent ${restore.writes.length} ${restore.writes.length === 1 ? "write" : "writes"}; their outcomes are in the change history.`}</p>
                {restore.skipped.length > 0 && (
                  <ul className="form-errors" aria-label="Parameters not sent">{restore.skipped.map(s => <li key={s.name}>{`${s.name}: ${s.reason}`}</li>)}</ul>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <ParameterExport store={store} projectId={projectId} live={live} sets={sets} metadata={metadata} />
    </div>
  );
}
