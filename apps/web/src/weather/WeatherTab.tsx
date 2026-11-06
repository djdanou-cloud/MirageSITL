import { useEffect, useState } from "react";
import type { StoredVersion } from "@mirage/project/schema";
import type { SessionLink } from "../run/session-link";
import type { StoreState } from "../shell/AppShell";
import { nameLanguage } from "../shell/project-files";
import { DEFAULT_LOCATION, loadLocation, saveLocation, type LocationChoice } from "./location";
import { LocationPicker } from "./LocationPicker";
import { TerrainSource } from "./TerrainSource";
import { WeatherPanel } from "./WeatherPanel";

// The Weather and location tab (S07, S17): the location of the flight (TASK-148), the terrain it stands on (TASK-186), and its weather
// by hand or on a schedule (TASK-167), whose air comes from the location's elevation.

export function WeatherTab({ storeState, project, link, active }: { storeState: StoreState; project: StoredVersion | null; link: SessionLink; active: boolean }) {
  const store = storeState.status === "ready" ? storeState.store : null, projectId = project?.record.id ?? null;
  const [location, setLocation] = useState<LocationChoice>(DEFAULT_LOCATION);
  // Bumped when the terrain section saves a ground elevation, so the location form reloads it.
  const [revision, setRevision] = useState(0);
  const [elevationError, setElevationError] = useState("");
  const applyTerrainElevation = (groundElevationMslM: number) => {
    if (!store || !projectId) return;
    const next = { ...location, groundElevationMslM };
    saveLocation(store, projectId, next).then(() => { setLocation(next); setRevision(value => value + 1); setElevationError(""); },
      (cause: unknown) => setElevationError(`Not saved: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
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
      <LocationPicker store={store} projectId={projectId} onSaved={setLocation} revision={revision} />
      <TerrainSource store={store} projectId={projectId} location={location} onElevation={applyTerrainElevation} />
      {elevationError && <p className="error" role="alert">{elevationError}</p>}
      <WeatherPanel store={store} projectId={projectId} link={link} active={active} location={location} />
    </div>
  );
}
