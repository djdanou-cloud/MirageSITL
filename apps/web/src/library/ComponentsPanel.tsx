import { useEffect, useState, type ChangeEvent } from "react";
import { CARD_FILE_EXTENSION, exportComponentCards, importComponentCards, missingValues } from "@mirage/aircraft/components";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import type { StoreState } from "../shell/AppShell";
import { download, nameLanguage, safeFileName } from "../shell/project-files";
import { CalculationPanel } from "./CalculationPanel";
import { MeasurementsEditor } from "./MeasurementsEditor";
import { describeLibraryError, loadLibrary, typeName, type LibraryData } from "./library-data";

// The Components tab (TASK-140, S04): the open project's component cards
// (TASK-139) with card-file import and export, the measurement sets bound to
// exact combinations, and each aircraft profile's calculation mode with its
// confidence labels (TASK-133).

export function ComponentsPanel({ storeState, project }: { storeState: StoreState; project: StoredVersion | null }) {
  const store = storeState.status === "ready" ? storeState.store : null;
  const projectId = project?.record.id ?? null;
  // The previous data of the same project stays on screen while it reloads, so open forms keep their input.
  const [loaded, setLoaded] = useState<{ readonly projectId: string; readonly data: LibraryData } | null>(null);
  const library = loaded !== null && loaded.projectId === projectId ? loaded.data : null;
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!store || !projectId) return;
    let cancelled = false;
    loadLibrary(store, projectId).then(
      data => { if (!cancelled) setLoaded({ projectId, data }); },
      (error: unknown) => { if (!cancelled) setStatus(describeLibraryError(error)); });
    return () => { cancelled = true; };
  }, [store, projectId, revision]);
  const refresh = () => setRevision(value => value + 1);

  const perform = (action: (store: ProjectStore, projectId: string) => Promise<string>) => {
    if (!store || !projectId) return;
    setBusy(true);
    void action(store, projectId).then(setStatus, (error: unknown) => setStatus(describeLibraryError(error))).finally(() => {
      setBusy(false);
      refresh();
    });
  };
  const importCards = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    perform(async (s, id) => {
      const results = await importComponentCards(s, id, new Uint8Array(await file.arrayBuffer()));
      const added = results.filter(result => result.status === "added").length;
      return `Imported ${file.name}: ${added} cards added, ${results.length - added} already in the project.`;
    });
  };
  const exportCards = () => {
    const cards = library?.cards.filter(entry => entry.value !== null).map(entry => entry.stored) ?? [];
    perform(async () => {
      download(await exportComponentCards(cards), safeFileName(`${project?.record.name ?? "project"} cards`, CARD_FILE_EXTENSION, "cards"));
      return `Exported ${cards.length} cards.`;
    });
  };

  if (!project) {
    return (
      <div className="library-panel">
        <h2>Components</h2>
        <p>No project is open. Open or create a project in the Project tab to keep its component cards and measurements.</p>
      </div>
    );
  }
  const cards = library?.cards ?? [];
  return (
    <div className="library-panel">
      <h2>Components</h2>
      <p>
        Cards for motors, propellers, ESCs and batteries in <span lang={nameLanguage(project.record.name)}>{project.record.name}</span>,
        bench measurements of exact combinations, and the calculation mode of each aircraft profile.
      </p>
      {storeState.status !== "ready" && <p role="status">The local project store is not available.</p>}
      <div className="project-grid">
        <section className="project-section" aria-labelledby="cards-heading">
          <h3 id="cards-heading">Component cards</h3>
          {library === null ? <p>Reading the project.</p> : cards.length === 0 ? (
            <p>The project has no component cards yet. Import a card file to add some.</p>
          ) : (
            <ul className="card-list" aria-label="Component cards">
              {cards.map(entry => (
                <li key={entry.stored.sha256}>
                  <span className="card-name" lang={nameLanguage(entry.stored.record.name)}>{entry.stored.record.name}</span>
                  {entry.value ? (
                    <span className="hint">
                      {typeName(entry.value.type)}{entry.value.example ? ", example" : ""}, version {entry.stored.record.version}.{" "}
                      {missingValues(entry.value).length === 0 ? "Every value is known." : `Not known: ${missingValues(entry.value).join(", ")}.`}
                    </span>
                  ) : (
                    <span className="project-warning">This card cannot be read: {entry.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <label htmlFor="cards-import">Import a card file</label>
          <input id="cards-import" type="file" accept={`${CARD_FILE_EXTENSION},application/json`} disabled={!store || busy} onChange={importCards} />
          <div className="button-row">
            <button type="button" disabled={busy || cards.every(entry => entry.value === null)} onClick={exportCards}>Export cards</button>
          </div>
          <p className="hint">A {CARD_FILE_EXTENSION} file moves cards between projects. Cards the project already holds are not added twice.</p>
        </section>
        {store && library && (
          <MeasurementsEditor store={store} projectId={project.record.id} library={library} onSaved={refresh} />
        )}
      </div>
      {store && library && <CalculationPanel store={store} library={library} onSaved={refresh} />}
      <p role="status" className="status-message project-status" data-testid="components-status">{status}</p>
    </div>
  );
}
