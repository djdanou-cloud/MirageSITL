import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import type { StoredVersion } from "@mirage/project/schema";
import type { MissingDependency, ProjectStore, StorageReport } from "@mirage/project/store";
import { archiveFileName, describeProjectError, nameLanguage, type ProjectOperation } from "./project-files";
import type { StoreState } from "./AppShell";

// The Project tab (TASK-137): create, open, rename, export and import local
// projects through the project store (TASK-136), and show its storage use.

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MiB`;
  return `${(bytes / 1073741824).toFixed(1)} GiB`;
}
function formatTime(createdAt: string): string {
  return `${createdAt.slice(0, 10)} ${createdAt.slice(11, 16)} UTC`;
}
function download(bytes: Uint8Array<ArrayBuffer>, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function describeStorage(report: StorageReport): string {
  const stored = `${plural(report.records, "record")} (${formatBytes(report.storeBytes)}) in the project store.`;
  const browser = report.usageBytes !== null && report.quotaBytes !== null
    ? ` This site uses ${formatBytes(report.usageBytes)} of ${formatBytes(report.quotaBytes)} available to it.`
    : " The browser does not report its storage quota.";
  const persistence = report.persisted === true ? " The browser keeps this storage until you clear it."
    : report.persisted === false ? " The browser may clear this storage when the disk is low."
      : "";
  return stored + browser + persistence;
}

export function ProjectPanel({ storeState, project, projects, onOpen, onRefresh }: {
  storeState: StoreState;
  project: StoredVersion | null;
  projects: readonly StoredVersion[];
  onOpen: (projectId: string | null) => void;
  /** Reloads the project list and, when given, opens that project. */
  onRefresh: (openProjectId?: string) => Promise<void>;
}) {
  const store = storeState.status === "ready" ? storeState.store : null;
  const [newName, setNewName] = useState("");
  const [rename, setRename] = useState(project?.record.name ?? "");
  const [status, setStatus] = useState("");
  const [missing, setMissing] = useState<readonly MissingDependency[]>([]);
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  // The rename field restarts from the name of each newly opened project or version.
  const openName = project?.record.name ?? "", openSha = project?.sha256;
  useEffect(() => {
    setRename(openName);
  }, [openSha, openName]);
  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    store.storageReport().then(report => { if (!cancelled) setStorage(report); }, () => { if (!cancelled) setStorage(null); });
    return () => { cancelled = true; };
  }, [store, projects]);

  const perform = (operation: ProjectOperation, action: (store: ProjectStore) => Promise<string>): void => {
    if (!store) return;
    setBusy(true);
    setMissing([]);
    void action(store).then(setStatus, (error: unknown) => setStatus(describeProjectError(error, operation))).finally(() => setBusy(false));
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    perform("create", async s => {
      const created = await s.createProject(newName);
      setNewName("");
      await onRefresh(created.record.id);
      return `Created project ${created.record.name}.`;
    });
  };
  const renameProject = (event: FormEvent) => {
    event.preventDefault();
    if (!project) return;
    perform("rename", async s => {
      const next = await s.saveVersion(project.record.id, project.sha256, { name: rename, payload: {} });
      await onRefresh(next.record.id);
      return next.sha256 === project.sha256 ? "The name is unchanged." : `Renamed the project to ${next.record.name}.`;
    });
  };
  const exportProject = () => {
    if (!project) return;
    perform("export", async s => {
      const result = await s.exportProject(project.record.id);
      download(result.archive, archiveFileName(project.record.name));
      setMissing(result.missing);
      return `Exported ${plural(result.entries, "record")} (${formatBytes(result.bytes)}).` +
        (result.missing.length > 0 ? ` ${plural(result.missing.length, "dependency")} listed below were already missing.` : "");
    });
  };
  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    perform("import", async s => {
      const report = await s.importArchive(file);
      await onRefresh(report.projectId);
      setMissing(report.missing);
      const name = report.items.find(item => item.kind === "project")?.name ?? "the project";
      return `Imported ${name}: ${plural(report.added, "record")} added, ${plural(report.unchanged, "record")} already stored.` +
        (report.missing.length > 0 ? ` ${plural(report.missing.length, "missing dependency")} listed below.` : "");
    });
  };

  return (
    <div className="project-panel">
      <h2>Project</h2>
      {storeState.status === "opening" && <p role="status">Opening the local project store.</p>}
      {storeState.status === "unavailable" && (
        <p role="status" className="project-warning">
          The local project store is unavailable, so projects cannot be saved in this browser. {storeState.reason}
        </p>
      )}
      <div className="project-grid">
        <div className="project-section">
          <h3>Open project</h3>
          {project ? (
            <>
              <p className="project-name" lang={nameLanguage(project.record.name)}>{project.record.name}</p>
              <p className="hint">Version {project.record.version}, saved {formatTime(project.record.createdAt)}.</p>
              <form className="inline-form" onSubmit={renameProject}>
                <label htmlFor="project-rename">Project name</label>
                <input id="project-rename" type="text" value={rename} onChange={event => setRename(event.target.value)} />
                <button type="submit" disabled={busy}>Rename</button>
              </form>
              <div className="button-row">
                <button type="button" disabled={busy} onClick={exportProject}>Export project</button>
                <button type="button" disabled={busy} onClick={() => onOpen(null)}>Close project</button>
              </div>
            </>
          ) : (
            <p>No project is open. Create a project, open one below or import an archive.</p>
          )}
        </div>
        <div className="project-section">
          <h3>New project</h3>
          <form className="inline-form" onSubmit={create}>
            <label htmlFor="project-new-name">New project name</label>
            <input id="project-new-name" type="text" value={newName} onChange={event => setNewName(event.target.value)} />
            <button type="submit" disabled={!store || busy}>Create project</button>
          </form>
          <p className="hint">Names may be Russian or English, up to 128 characters.</p>
        </div>
        <div className="project-section">
          <h3>Projects on this computer</h3>
          {projects.length === 0 ? (
            <p>No projects are stored yet.</p>
          ) : (
            <ul className="project-list">
              {projects.map(stored => (
                <li key={stored.record.id}>
                  <span lang={nameLanguage(stored.record.name)}>{stored.record.name}</span>
                  {stored.record.id === project?.record.id ? (
                    <span className="current-tag">Open now</span>
                  ) : (
                    <button type="button" aria-label={`Open ${stored.record.name}`} onClick={() => onOpen(stored.record.id)}>Open</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="project-section">
          <h3>Import</h3>
          <label htmlFor="project-import">Import a project archive</label>
          <input id="project-import" type="file" accept=".mirageproj,application/octet-stream" disabled={!store || busy} onChange={importFile} />
          <p className="hint">A .mirageproj file exported from MirageSITL. Damaged or changed files are refused, and nothing is stored from them.</p>
        </div>
        <div className="project-section">
          <h3>Storage</h3>
          <p data-testid="project-storage">{storage ? describeStorage(storage) : "Storage use is not known yet."}</p>
          <p className="hint">Projects are kept in this browser for this address only. Export a project to keep a copy outside the browser.</p>
        </div>
      </div>
      <p role="status" className="status-message project-status" data-testid="project-status">{status}</p>
      {missing.length > 0 && (
        <ul className="missing-list" aria-label="Missing dependencies">
          {missing.map(item => (
            <li key={item.sha256}>
              {item.kind} {item.sha256.slice(0, 12)}, needed by {item.requiredBy.map(v => `${v.name} (version ${v.version})`).join(", ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
