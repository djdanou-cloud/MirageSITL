import { useEffect, useMemo, useState } from "react";
import { experimentChanges, readExperiment, type ExperimentPayload } from "@mirage/aircraft/experiment";
import { listRecordings, reopenRecording } from "@mirage/aar/recorder-v2-host";
import type { StoredVersion } from "@mirage/project/schema";
import type { ImportReport } from "@mirage/project/store";
import type { StoreState } from "../shell/AppShell";
import type { SessionLink } from "../run/session-link";
import { TASK_TYPE_LABELS } from "../tasks/flight-task-form";
import { externalDependencies, lineageText, trajectoryDifference, type PositionRow, type TrajectoryDifference } from "./lifecycle";

// The Experiments tab (TASK-165, S16): every experiment of the project with
// its fixed inputs and where it comes from. Repeat runs an experiment's inputs
// again and Create variant runs them with changes, each in the Run tab as a
// new experiment that names its parent; the parent stays unchanged. How a
// repeat or a variant differs from its parent is shown, never judged (user
// decision of 2026-11-03). An experiment exports as a project archive with
// its aircraft profile and that profile's dependencies, and the tab lists
// what the archive cannot hold; an import lists what this computer lacks.

interface Experiment { readonly stored: StoredVersion; readonly payload: ExperimentPayload }
type Comparison = { readonly kind: "done"; readonly difference: TrajectoryDifference } | { readonly kind: "unavailable"; readonly reason: string } | null;

function fileName(text: string, extension: string): string {
  return `${text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "experiment"}${extension}`;
}
function download(bytes: BlobPart, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** truth.position of a recording as rows, or why it cannot be read. */
async function positions(recordId: string): Promise<PositionRow[]> {
  const opened = await reopenRecording(recordId);
  return (opened.rows.get("truth.position") ?? []).flatMap(row => row.values
    ? [{ tick: row.tick, simTimeS: row.simTimeS, northM: row.values[0] ?? Number.NaN, eastM: row.values[1] ?? Number.NaN, downM: row.values[2] ?? Number.NaN }] : []);
}
const metres = (value: number) => `${value.toFixed(value < 0.01 ? 4 : 3)} m`;

export function ExperimentsTab({ storeState, project, link, active, onRun }: {
  storeState: StoreState; project: StoredVersion | null; link: SessionLink; active: boolean; onRun: () => void;
}) {
  const store = storeState.status === "ready" ? storeState.store : null;
  const projectId = project?.record.id ?? null;
  const [experiments, setExperiments] = useState<readonly Experiment[]>([]);
  const [selected, setSelected] = useState("");
  const [comparison, setComparison] = useState<Comparison>(null);
  const [notice, setNotice] = useState("");
  const [imported, setImported] = useState<{ readonly report: ImportReport; readonly lacking: readonly string[] } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!store || !projectId || !active) return;
    let cancelled = false;
    store.listItems(projectId, "experiment").then(list => {
      if (cancelled) return;
      const read = list.flatMap(stored => { try { return [{ stored, payload: readExperiment(stored) }]; } catch { return []; } })
        .sort((a, b) => b.stored.record.createdAt.localeCompare(a.stored.record.createdAt));
      setExperiments(read);
      setSelected(current => read.some(e => e.stored.sha256 === current) ? current : read[0]?.stored.sha256 ?? "");
    }, (cause: unknown) => { if (!cancelled) setNotice(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [store, projectId, active, reload]);
  useEffect(() => { setComparison(null); }, [selected]);

  const bySha = useMemo(() => new Map(experiments.map(e => [e.stored.sha256, e])), [experiments]);
  const nameOf = (sha256: string) => bySha.get(sha256)?.stored.record.name ?? `an experiment not in this project (${sha256.slice(0, 12)})`;
  const current = bySha.get(selected);
  const lineage = current?.payload.lineage;
  const parent = lineage && lineage.kind !== "original" ? bySha.get(lineage.of) : undefined;
  const launcherOwned = current?.payload.sitl.ownership === "launcher";

  const plan = (kind: "repeat" | "variant") => {
    if (!current) return;
    link.planRun({ kind, parentSha256: current.stored.sha256, parentName: current.stored.record.name, parent: current.payload });
    onRun();
  };
  const compare = () => {
    if (!current || !parent) return;
    const a = parent.payload.recording, b = current.payload.recording;
    if (!a || !b) { setComparison({ kind: "unavailable", reason: "Both runs need a recording; one of them recorded nothing" }); return; }
    Promise.all([positions(a.recordId), positions(b.recordId)]).then(([rowsA, rowsB]) => setComparison({ kind: "done", difference: trajectoryDifference(rowsA, rowsB) }),
      (cause: unknown) => setComparison({ kind: "unavailable", reason: `A recording cannot be read in this browser: ${cause instanceof Error ? cause.message : String(cause)}` }));
  };
  const exportSelected = () => {
    if (!store || !projectId || !current) return;
    store.exportItems(projectId, [current.stored.sha256]).then(result => {
      download(result.archive, fileName(current.stored.record.name, ".mirageproj"));
      setNotice(`Exported ${result.entries} records.`);
    }, (cause: unknown) => setNotice(`The experiment was not exported: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const importFile = (file: File) => {
    if (!store) return;
    setImported(null);
    store.importArchive(file).then(async report => {
      // What the archive could not carry: recordings that this browser does not hold.
      const held = new Set((await listRecordings().catch(() => [])).map(entry => entry.recordId));
      const lacking: string[] = [];
      for (const stored of await store.listItems(report.projectId, "experiment")) {
        if (!report.items.some(item => item.id === stored.record.id)) continue;
        try {
          const payload = readExperiment(stored);
          if (payload.recording && !held.has(payload.recording.recordId)) lacking.push(`${stored.record.name}: recording ${payload.recording.recordId} is not in this browser`);
          if (payload.sitl.ownership === "launcher") lacking.push(`${stored.record.name}: needs ArduPilot build ${payload.sitl.ardupilot.catalogId} (commit ${payload.sitl.ardupilot.commit}) in the launcher to repeat it`);
        } catch (cause) {
          lacking.push(`${stored.record.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      setImported({ report, lacking });
      setReload(n => n + 1);
    }, (cause: unknown) => setNotice(`The archive was not imported: ${cause instanceof Error ? cause.message : String(cause)}`));
  };

  return (
    <div className="experiments-panel">
      <h2>Experiments</h2>
      <p>
        Every run is an experiment with fixed inputs: the aircraft profile version, the ArduPilot build, the speed, the home, the initial parameters
        and the recording setup. Repeat runs the same inputs again; Create variant starts from them and lets you change some. How a repeat or a variant
        differs from its parent is shown, never judged: you decide whether it reproduced.
      </p>
      {!project && <p className="hint">Open a project to see its experiments.</p>}
      {project && experiments.length === 0 && <p className="hint">This project has no experiment yet: start a run in the Run tab.</p>}
      {experiments.length > 0 && (
        <section className="project-section" aria-labelledby="experiments-list-heading">
          <h3 id="experiments-list-heading">Experiments of this project</h3>
          <div className="table-scroll">
            <table className="scheme-table" data-testid="experiment-list">
              <thead><tr><th scope="col">Experiment</th><th scope="col">Started</th><th scope="col">Aircraft</th><th scope="col">Speed</th><th scope="col">From</th></tr></thead>
              <tbody>
                {experiments.map(e => (
                  <tr key={e.stored.sha256} data-sha={e.stored.sha256} data-lineage={e.payload.lineage.kind} className={e.stored.sha256 === selected ? "selected" : undefined}>
                    <th scope="row"><button type="button" className="link-button" onClick={() => setSelected(e.stored.sha256)}>{e.stored.record.name}</button></th>
                    <td>{e.stored.record.createdAt.replace("T", " ").slice(0, 19)}</td>
                    <td>{`${e.payload.profile.name} v${e.payload.profile.version}`}</td>
                    <td>{e.payload.session.speedup === null ? "set by the SITL" : `${e.payload.session.speedup}×`}</td>
                    <td>{lineageText(e.payload.lineage, nameOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {current && (
        <section className="project-section" aria-labelledby="experiment-detail-heading" data-testid="experiment-detail">
          <h3 id="experiment-detail-heading">{current.stored.record.name}</h3>
          <dl className="sitl-status">
            <dt>From</dt><dd data-testid="experiment-lineage">{lineageText(current.payload.lineage, nameOf)}</dd>
            <dt>Aircraft profile</dt><dd>{`${current.payload.profile.name}, version ${current.payload.profile.version}`}</dd>
            <dt>ArduPilot</dt><dd>{current.payload.sitl.ownership === "launcher"
              ? `${current.payload.sitl.ardupilot.firmwareVersion} (${current.payload.sitl.ardupilot.catalogId})` : `${current.payload.sitl.ardupilot.firmwareVersion}, a SITL started by hand`}</dd>
            <dt>Speed and physics</dt><dd>{`${current.payload.session.speedup === null ? "set by the SITL" : `${current.payload.session.speedup}×`}, ${current.payload.session.physicsHz} Hz`}</dd>
            <dt>Home</dt><dd>{current.payload.session.home.join(", ")}</dd>
            <dt>Initial parameters</dt><dd>{current.payload.parameters.length}</dd>
            <dt>Flight task</dt><dd data-testid="experiment-flight-task">{current.payload.flightTask ? `${current.payload.flightTask.name} (${TASK_TYPE_LABELS[current.payload.flightTask.definition.type]})` : "None"}</dd>
            <dt>Recording</dt><dd>{current.payload.recording ? `${current.payload.recording.commonHz} Hz common rate, record ${current.payload.recording.recordId}` : "None"}</dd>
          </dl>
          <div className="sitl-actions">
            <button type="button" onClick={() => plan("repeat")} disabled={!launcherOwned}>Repeat</button>
            <button type="button" onClick={() => plan("variant")} disabled={!launcherOwned}>Create variant</button>
            <button type="button" onClick={exportSelected} disabled={!store}>Export the experiment</button>
          </div>
          {!launcherOwned && <p className="hint">A run with a SITL started by hand is repeated by connecting that SITL again in the Run tab.</p>}
          {lineage && lineage.kind !== "original" && (
            <div data-testid="experiment-differences">
              <h4>{`Differences from ${nameOf(lineage.of)}`}</h4>
              {parent ? (
                <>
                  <p className="hint" data-testid="experiment-input-differences">
                    {(() => { const changes = experimentChanges(parent.payload, current.payload); return changes.length === 0 ? "No input differs." : `Inputs that differ: ${changes.join(", ")}.`; })()}
                  </p>
                  <button type="button" onClick={compare}>Compare the recorded trajectories</button>
                  {comparison?.kind === "done" && (
                    <p className="hint" data-testid="experiment-trajectory" data-first-different={comparison.difference.firstDifferentTick ?? "none"}
                      data-compared={comparison.difference.comparedTicks}>
                      {`${comparison.difference.comparedTicks} recorded ticks in common; the positions differ by at most ${metres(comparison.difference.maxHorizontalM)} horizontally and ${metres(comparison.difference.maxVerticalM)} vertically`}
                      {comparison.difference.atSimTimeS === null ? ", identical throughout" : ` (largest at ${comparison.difference.atSimTimeS.toFixed(2)} s)`}
                      {comparison.difference.firstDifferentTick === null ? "." : `; they first differ at tick ${comparison.difference.firstDifferentTick}.`}
                      {" Shown, not judged."}
                    </p>
                  )}
                  {comparison?.kind === "unavailable" && <p className="hint" data-testid="experiment-trajectory">{comparison.reason}</p>}
                </>
              ) : <p className="hint">The parent is not in this project, so the differences cannot be shown.</p>}
            </div>
          )}
          <h4>Outside the export</h4>
          <ul className="form-errors" data-testid="experiment-external">
            {externalDependencies(current.payload).map(d => <li key={d.what}>{`${d.what}: ${d.why}.`}</li>)}
          </ul>
        </section>
      )}
      <section className="project-section" aria-labelledby="experiments-import-heading">
        <h3 id="experiments-import-heading">Import experiments</h3>
        <label htmlFor="experiments-import">Experiment archive (.mirageproj)</label>
        <input id="experiments-import" type="file" accept=".mirageproj" disabled={!store}
          onChange={event => { const file = event.target.files?.[0]; if (file) importFile(file); event.target.value = ""; }} />
        {imported && (
          <div data-testid="experiments-imported">
            <p className="hint">{`Imported ${imported.report.added} records (${imported.report.unchanged} were already here) into project ${imported.report.projectId}.`}</p>
            {imported.report.missing.length > 0 && (
              <ul className="form-errors" aria-label="Missing records">
                {imported.report.missing.map(m => <li key={m.sha256}>{`${m.kind} ${m.sha256} is missing, needed by ${m.requiredBy.map(r => r.name).join(", ")}`}</li>)}
              </ul>
            )}
            {imported.lacking.length > 0 && (
              <ul className="form-errors" aria-label="Outside the archive" data-testid="experiments-lacking">{imported.lacking.map(text => <li key={text}>{text}</li>)}</ul>
            )}
          </div>
        )}
      </section>
      {notice && <p className="hint" role="status" data-testid="experiments-notice">{notice}</p>}
    </div>
  );
}
