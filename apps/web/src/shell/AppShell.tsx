import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Radio } from "lucide-react";
import type { StoredVersion } from "@mirage/project/schema";
import { validateComponentCard } from "@mirage/aircraft/components";
import { validateExperiment } from "@mirage/aircraft/experiment";
import { LoggingTab } from "../logging/LoggingTab";
import { validateParameterLog, validateParameterSet } from "../params/parameter-sets";
import { validateExperimentBatch } from "@mirage/project/batch";
import { parseFlightTask } from "@mirage/scenarios/flight-tasks";
import { FlightTasksTab } from "../tasks/FlightTasksTab";
import { ParametersTab } from "../params/ParametersTab";
import { ExperimentsTab } from "../experiments/ExperimentsTab";
import { SessionLink } from "../run/session-link";
import { validateMeasurementSet } from "@mirage/aircraft/measurements";
import { validateAircraftProfile } from "@mirage/aircraft/profile";
import { ProjectStore } from "@mirage/project/store";
import { AircraftEditor } from "../aircraft/AircraftEditor";
import { AnalysisTab } from "../analysis/AnalysisTab";
import { ComponentsPanel } from "../library/ComponentsPanel";
import { SensorsTab } from "../sensors/SensorsTab";
import {
  DEFAULT_NAVIGATION, TABS, forcedTab, loadNavigation, panelId, saveNavigation, tabForKey, tabId,
  type NavigationState, type TabId,
} from "./navigation";
import { FirstRun } from "./FirstRun";
import { ProjectBar } from "./ProjectBar";
import { ProjectPanel } from "./ProjectPanel";
import { describeProjectError, nameLanguage } from "./project-files";

// Phase 1 application shell (TASK-137, S01): the project context, the twelve
// tabs and their panels. Every panel stays mounted and inactive ones are
// hidden, so the Run tab's simulation keeps running while other tabs are open.
// Physics stays in its Worker; the shell holds only navigation and project
// metadata.

export type StoreState =
  | { readonly status: "opening" }
  | { readonly status: "ready"; readonly store: ProjectStore }
  | { readonly status: "unavailable"; readonly reason: string };

/** What each tab will hold; the shell says so until the tab's own task lands. */
const PLANNED: { readonly [tab in Exclude<TabId, "project" | "aircraft" | "components" | "sensors" | "run" | "logging" | "parameters" | "experiments" | "tasks" | "analysis">]: string } = {
  faults: "Motor faults, sensor and GNSS interference, EKF drift and link loss, applied manually or on a schedule.",
  weather: "Wind, gusts, turbulence, temperature and pressure, and the location of the flight.",
};

// `?g3=1` (TASK-073) measures the full-screen flight view, which lives in the Run tab.
const FORCED_TAB = forcedTab(globalThis.location?.search ?? "");

function PlannedPanel({ label, description, project }: { label: string; description: string; project: StoredVersion | null }) {
  return (
    <div className="planned-panel">
      <h2>{label}</h2>
      <p className="planned-status">Not available yet.</p>
      <p>{description}</p>
      <p className="hint">
        {project ? <>Open project: <span lang={nameLanguage(project.record.name)}>{project.record.name}</span></> : "No project is open."}
      </p>
    </div>
  );
}

/**
 * `run` renders the Run tab; `visible` is false while another tab is open. The Run tab attaches its
 * SITL session to `link`, through which the Parameters tab reads and writes that run's parameters.
 */
export function AppShell({ run }: { run: (visible: boolean, storeState: StoreState, project: StoredVersion | null, link: SessionLink) => ReactNode }) {
  const link = useMemo(() => new SessionLink(), []);
  const [storeState, setStoreState] = useState<StoreState>({ status: "opening" });
  const [navigation, setNavigation] = useState<NavigationState>(
    FORCED_TAB ? { ...DEFAULT_NAVIGATION, tab: FORCED_TAB } : DEFAULT_NAVIGATION);
  const [projects, setProjects] = useState<readonly StoredVersion[]>([]);
  const [notice, setNotice] = useState("");
  /** The experiment the Experiments tab asked the Analysis tab to open (TASK-180). */
  const [analysisOpen, setAnalysisOpen] = useState<{ readonly sha256: string; readonly at: number } | null>(null);
  // Set once the user navigates; until then the stored navigation may replace the default.
  const changed = useRef(false);
  const tabs = useRef(new Map<TabId, HTMLButtonElement>());
  const store = storeState.status === "ready" ? storeState.store : null;

  useEffect(() => {
    let cancelled = false, opened: ProjectStore | null = null;
    const open = async () => {
      try {
        // Payload validators of the kinds' owner tasks apply to every write and archive import.
        const ready = await ProjectStore.openIndexedDb({
          validators: {
            "component-card": validateComponentCard, "measurement-set": validateMeasurementSet, "aircraft-profile": validateAircraftProfile,
            "experiment": validateExperiment, "parameter-set": validateParameterSet, "parameter-log": validateParameterLog, "flight-task": parseFlightTask, "experiment-batch": validateExperimentBatch,
          },
        });
        opened = ready;
        if (cancelled) {
          ready.close();
          return;
        }
        const [stored, list] = await Promise.all([loadNavigation(ready), ready.listProjects()]);
        if (cancelled) return;
        setProjects(list);
        setNavigation(current => changed.current
          ? { tab: current.tab, projectId: stored.projectId }
          : { tab: FORCED_TAB ?? stored.tab, projectId: stored.projectId });
        setStoreState({ status: "ready", store: ready });
      } catch (cause) {
        if (!cancelled) setStoreState({ status: "unavailable", reason: describeProjectError(cause, "storage") });
      }
    };
    void open();
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, []);

  // Navigation is saved after every user change, including changes made before the store opened.
  useEffect(() => {
    if (!store || !changed.current) return;
    saveNavigation(store, navigation).then(() => setNotice(""), (cause: unknown) => setNotice(describeProjectError(cause, "storage")));
  }, [store, navigation]);

  const update = (change: (current: NavigationState) => NavigationState) => {
    changed.current = true;
    setNavigation(change);
  };
  const selectTab = (tab: TabId) => update(current => ({ ...current, tab }));
  const openProject = (projectId: string | null) => update(current => ({ ...current, projectId }));
  const refreshProjects = async (openProjectId?: string) => {
    if (!store) return;
    setProjects(await store.listProjects());
    if (openProjectId !== undefined) openProject(openProjectId);
  };
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = tabForKey(navigation.tab, event.key);
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    tabs.current.get(next)?.focus();
  };
  const project = projects.find(stored => stored.record.id === navigation.projectId) ?? null;

  const content = (tab: TabId): ReactNode => {
    switch (tab) {
      case "project":
        return (
          <>
            <ProjectPanel storeState={storeState} project={project} projects={projects} onOpen={openProject} onRefresh={refreshProjects} />
            <div className="project-panel first-run-panel">
              <FirstRun />
            </div>
          </>
        );
      case "aircraft":
        return <AircraftEditor storeState={storeState} project={project} active={navigation.tab === "aircraft"} />;
      case "components":
        return <ComponentsPanel storeState={storeState} project={project} active={navigation.tab === "components"} />;
      case "sensors":
        return <SensorsTab storeState={storeState} project={project} active={navigation.tab === "sensors"} />;
      case "run":
        return run(navigation.tab === "run", storeState, project, link);
      case "logging":
        return <LoggingTab storeState={storeState} project={project} active={navigation.tab === "logging"} />;
      case "parameters":
        return <ParametersTab storeState={storeState} project={project} link={link} active={navigation.tab === "parameters"} />;
      case "tasks":
        return <FlightTasksTab storeState={storeState} project={project} active={navigation.tab === "tasks"} />;
      case "experiments":
        return <ExperimentsTab storeState={storeState} project={project} link={link} active={navigation.tab === "experiments"} onRun={() => selectTab("run")} onAnalyse={sha256 => { setAnalysisOpen({ sha256, at: Date.now() }); selectTab("analysis"); }} />;
      case "analysis":
        return <AnalysisTab storeState={storeState} project={project} link={link} active={navigation.tab === "analysis"} openSha={analysisOpen} />;
      default: {
        const label = TABS.find(entry => entry.id === tab)?.label ?? tab;
        return <PlannedPanel label={label} description={PLANNED[tab]} project={project} />;
      }
    }
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="shell-header">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            <Radio size={22} />
          </span>
          <h1 className="brand-title">
            MIRAGE<span className="brand-light">SITL</span>
            <small>FLIGHT LABORATORY</small>
          </h1>
        </div>
        <ProjectBar project={project} storeState={storeState} onManage={() => selectTab("project")} />
      </header>
      <nav className="shell-nav" aria-label="Application sections">
        <div className="tablist" role="tablist" aria-label="Sections" onKeyDown={onTabKey}>
          {TABS.map(entry => {
            const selected = entry.id === navigation.tab;
            return (
              <button
                key={entry.id}
                ref={element => {
                  if (element) tabs.current.set(entry.id, element);
                  else tabs.current.delete(entry.id);
                }}
                id={tabId(entry.id)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId(entry.id)}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(entry.id)}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </nav>
      <main id="main-content" className="shell-main" tabIndex={-1}>
        {notice && <p className="shell-notice" role="status">{notice}</p>}
        {TABS.map(entry => (
          <div
            key={entry.id}
            id={panelId(entry.id)}
            className="shell-panel"
            role="tabpanel"
            aria-labelledby={tabId(entry.id)}
            hidden={entry.id !== navigation.tab}
            tabIndex={entry.id === "project" || entry.id === "aircraft" || entry.id === "components" || entry.id === "sensors" || entry.id === "run" || entry.id === "analysis" ? undefined : 0}
          >
            {content(entry.id)}
          </div>
        ))}
      </main>
      <footer>
        <span>MIRAGESITL · LOCAL SIMULATION, NO ACCOUNT OR CLOUD SERVICE</span>
        <span>Development build · not validated for pilot training or real-flight settings</span>
      </footer>
    </div>
  );
}
