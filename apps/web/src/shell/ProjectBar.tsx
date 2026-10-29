import type { StoredVersion } from "@mirage/project/schema";
import { nameLanguage } from "./project-files";
import type { StoreState } from "./AppShell";

/** The project context shown above every tab (TASK-137). */
export function ProjectBar({ project, storeState, onManage }: {
  project: StoredVersion | null;
  storeState: StoreState;
  onManage: () => void;
}) {
  return (
    <div className="project-bar" role="group" aria-label="Project context">
      <span className="eyebrow">PROJECT</span>
      <strong data-testid="current-project" lang={project ? nameLanguage(project.record.name) : undefined}>
        {project ? project.record.name : "No project open"}
      </strong>
      {storeState.status === "unavailable" && (
        <span className="project-bar-warning">Projects cannot be saved here.</span>
      )}
      <button type="button" onClick={onManage}>Projects</button>
    </div>
  );
}
