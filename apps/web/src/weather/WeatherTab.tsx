import { useEffect, useState } from "react";
import type { StoredVersion } from "@mirage/project/schema";
import type { SessionLink } from "../run/session-link";
import type { StoreState } from "../shell/AppShell";
import { nameLanguage } from "../shell/project-files";
import { DEFAULT_LOCATION, loadLocation, type LocationChoice } from "./location";
import { LocationPicker } from "./LocationPicker";
import { WeatherPanel } from "./WeatherPanel";

// The Weather and location tab (S07): the location of the flight (TASK-148), and its weather by hand or on a schedule (TASK-167),
// whose air comes from the location's elevation.

export function WeatherTab({ storeState, project, link, active }: { storeState: StoreState; project: StoredVersion | null; link: SessionLink; active: boolean }) {
  const store = storeState.status === "ready" ? storeState.store : null, projectId = project?.record.id ?? null;
  const [location, setLocation] = useState<LocationChoice>(DEFAULT_LOCATION);
  useEffect(() => {
    if (!store || !projectId) { setLocation(DEFAULT_LOCATION); return; }
    let cancelled = false;
    void loadLocation(store, projectId).then(found => { if (!cancelled) setLocation(found); });
    return () => { cancelled = true; };
  }, [store, projectId, active]);
  return (
    <div className="logging-panel weather-panel">
      <h2>Weather and location</h2>
      <p className="hint">
        {project ? <>Open project: <span lang={nameLanguage(project.record.name)}>{project.record.name}</span></> : "No project is open."}
      </p>
      <LocationPicker store={store} projectId={projectId} onSaved={setLocation} />
      <WeatherPanel store={store} projectId={projectId} link={link} active={active} location={location} />
    </div>
  );
}
