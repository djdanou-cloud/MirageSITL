import { useEffect, useMemo, useState } from "react";
import type { ProjectStore } from "@mirage/project/store";
import type { EffectiveConditions } from "@mirage/sensors/environment";
import { conditionsOf, geographicModels, type GeographicModels } from "./conditions";
import { DEFAULT_LOCATION, SITES, atSite, describeLocation, loadLocation, saveLocation, type LocationChoice } from "./location";
import { COORDINATES, formOf, locationOf, type LocationForm } from "./location-form";

// The location of the flight (TASK-148, S07): a built-in site or coordinates,
// the ground elevation, the heading, and the sea-level pressure and ISA
// temperature offset the air at the ground is derived from. The effective
// conditions the calculation will use there (gravity, magnetic field, geoid
// undulation, air) are shown as the form changes, from the same models the
// run uses, and the saved location is the next run's home and environment.

const fixed = (value: number, digits: number): string => value.toFixed(digits);
function ConditionsList({ conditions }: { conditions: EffectiveConditions }) {
  const m = conditions.magnetic, air = conditions.air, geoid = conditions.geoid;
  return (
    <dl className="sitl-status" data-testid="effective-conditions">
      <dt>Gravity</dt><dd data-testid="conditions-gravity">{fixed(conditions.gravityMps2, 5)} m/s² (WGS84 normal gravity at the ground)</dd>
      <dt>Geoid</dt>
      <dd data-testid="conditions-geoid">
        {geoid.status === "AVAILABLE" ? `${geoid.model}: undulation ${fixed(geoid.undulationM, 2)} m, ellipsoidal height ${fixed(conditions.ellipsoidalHeightM, 2)} m`
          : `No authoritative geoid: ${geoid.reason}`}
      </dd>
      <dt>Magnetic field</dt>
      <dd data-testid="conditions-field">
        {`${m.model}: ${fixed(m.totalNt, 0)} nT, declination ${fixed(m.declinationDeg, 2)}°, inclination ${fixed(m.inclinationDeg, 2)}°`}
        {`, north ${fixed(m.northNt, 0)} nT, east ${fixed(m.eastNt, 0)} nT, down ${fixed(m.downNt, 0)} nT`}
        {m.zone === "normal" ? "" : m.zone === "caution" ? " (WMM caution zone: the declination is unreliable)" : " (WMM blackout zone: the compass is unusable)"}
      </dd>
      <dt>Air at the ground</dt>
      <dd data-testid="conditions-air">
        {`${fixed(air.temperatureK - 273.15, 2)} °C, ${fixed(air.pressurePa / 100, 2)} hPa, ${fixed(air.densityKgM3, 4)} kg/m³`}
        {` (sea-level pressure ${fixed(air.seaLevelPressurePa / 100, 2)} hPa ${air.seaLevelPressureSource}, ISA ${air.temperatureOffsetK >= 0 ? "+" : ""}${air.temperatureOffsetK} K)`}
      </dd>
    </dl>
  );
}

export function LocationPicker({ store, projectId, onSaved }: { store: ProjectStore | null; projectId: string | null; onSaved?: (location: LocationChoice) => void }) {
  const [saved, setSaved] = useState<LocationChoice>(DEFAULT_LOCATION);
  const [form, setForm] = useState<LocationForm>(formOf(DEFAULT_LOCATION));
  const [status, setStatus] = useState("");
  const [models, setModels] = useState<GeographicModels | null>(null);
  const [modelError, setModelError] = useState("");

  useEffect(() => {
    let cancelled = false;
    geographicModels().then(loaded => { if (!cancelled) setModels(loaded); }, (cause: unknown) => { if (!cancelled) setModelError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!store || !projectId) { setSaved(DEFAULT_LOCATION); setForm(formOf(DEFAULT_LOCATION)); return; }
    let cancelled = false;
    void loadLocation(store, projectId).then(location => { if (!cancelled) { setSaved(location); setForm(formOf(location)); setStatus(""); } });
    return () => { cancelled = true; };
  }, [store, projectId]);

  const { location, problems } = useMemo(() => locationOf(form), [form]);
  const conditions = useMemo(() => {
    if (!location || !models) return null;
    try { return conditionsOf(location, models, new Date()); } catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
  }, [location, models]);
  const dirty = location !== null && JSON.stringify(location) !== JSON.stringify(saved);
  const chooseSite = (id: string) => {
    const site = SITES.find(entry => entry.id === id);
    const base = locationOf(form).location ?? saved;
    setForm(site ? formOf(atSite(base, site)) : { ...form, site: COORDINATES });
  };
  const save = () => {
    if (!store || !projectId || !location) return;
    saveLocation(store, projectId, location).then(() => { setSaved(location); onSaved?.(location); setStatus("Saved. The next run starts here, and ArduPilot's home is this location."); },
      (cause: unknown) => setStatus(`Not saved: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const onSite = form.site !== COORDINATES;
  const field = (id: string, label: string, key: keyof LocationForm, mode: "decimal" | "numeric" = "decimal", disabled = false) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode={mode} value={form[key]} disabled={disabled} onChange={event => setForm({ ...form, [key]: event.target.value })} />
    </div>
  );
  return (
    <section className="project-section" aria-labelledby="location-heading" data-testid="location-picker">
      <h3 id="location-heading">Location</h3>
      <p>
        {projectId ? "The location of the next run of this project" : "Open a project to keep a location"}: a built-in site, or coordinates with the
        ground elevation above mean sea level. ArduPilot starts at it as its home, the physics uses the WGS84 normal gravity and the air at that
        elevation, and the run&apos;s experiment record keeps the location with these conditions. Phase 1 has no offline map; the synthetic pad stands
        at any coordinates.
      </p>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="location-site">Site</label>
          <select id="location-site" value={form.site} onChange={event => chooseSite(event.target.value)}>
            {SITES.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
            <option value={COORDINATES}>Coordinates</option>
          </select>
        </div>
        {field("location-latitude", "Latitude (°)", "latitudeDeg", "decimal", onSite)}
        {field("location-longitude", "Longitude (°)", "longitudeDeg", "decimal", onSite)}
        {field("location-elevation", "Ground elevation above mean sea level (m)", "groundElevationMslM", "decimal", onSite)}
        {field("location-heading-deg", "Heading (°)", "headingDeg", "decimal", onSite)}
        <div className="field">
          <label htmlFor="location-pressure">Sea-level pressure</label>
          <select id="location-pressure" value={form.pressure} onChange={event => setForm({ ...form, pressure: event.target.value === "measured" ? "measured" : "standard" })}>
            <option value="standard">ISA standard (1013.25 hPa)</option>
            <option value="measured">Measured QNH</option>
          </select>
        </div>
        {field("location-qnh", "Measured QNH (hPa)", "qnhHpa", "decimal", form.pressure !== "measured")}
        {field("location-offset", "Temperature offset from ISA (K)", "temperatureOffsetK")}
      </div>
      {onSite && <p className="hint">{SITES.find(site => site.id === form.site)?.source}</p>}
      {problems.length > 0 && <ul className="form-errors" aria-label="Problems to fix before saving the location">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
      <h4>Effective conditions</h4>
      {modelError && <p className="form-errors" data-testid="conditions-error">{`The geoid or magnetic model did not load: ${modelError}`}</p>}
      {!modelError && !models && <p className="hint">Loading the EGM96 geoid and the WMM2025 magnetic model…</p>}
      {typeof conditions === "string" && <p className="form-errors" data-testid="conditions-error">{conditions}</p>}
      {conditions !== null && typeof conditions !== "string" && <ConditionsList conditions={conditions} />}
      <p className="hint">
        On the Phase 1 path ArduPilot SITL computes its own magnetic field from its declination tables at the home; the field above is
        MirageSITL&apos;s WMM2025 value, shown and recorded for the comparison. The gravity and the air are what the physics uses.
      </p>
      <div className="sitl-actions">
        <button type="button" onClick={save} disabled={!store || !projectId || !location || !dirty}>Save location</button>
      </div>
      <p className="hint" data-testid="location-status" aria-live="polite">{status || `Saved location: ${describeLocation(saved)}`}</p>
    </section>
  );
}
