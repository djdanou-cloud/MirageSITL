import type { StoredVersion } from "@mirage/project/schema";
import type { StoreState } from "../shell/AppShell";
import { nameLanguage } from "../shell/project-files";
import { LocationPicker } from "./LocationPicker";

// The Weather and location tab (S07): the location of the flight (TASK-148)
// now; wind, gusts, turbulence and scheduled changes follow with TASK-166 and
// TASK-167, when weather.set gets its own controls here.

export function WeatherTab({ storeState, project }: { storeState: StoreState; project: StoredVersion | null; active: boolean }) {
  const store = storeState.status === "ready" ? storeState.store : null;
  return (
    <div className="logging-panel weather-panel">
      <h2>Weather and location</h2>
      <p className="hint">
        {project ? <>Open project: <span lang={nameLanguage(project.record.name)}>{project.record.name}</span></> : "No project is open."}
      </p>
      <LocationPicker store={store} projectId={project?.record.id ?? null} />
      <section className="project-section" aria-labelledby="weather-heading">
        <h3 id="weather-heading">Weather</h3>
        <p className="planned-status">Not available yet.</p>
        <p>Wind, gusts, turbulence, temperature and pressure, applied manually or on a schedule, with repeatable gust realizations.</p>
      </section>
    </div>
  );
}
