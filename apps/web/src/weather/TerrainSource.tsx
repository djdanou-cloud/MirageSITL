import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectStore } from "@mirage/project/store";
import type { TerrainSourceRecord } from "@mirage/terrain/coverage";
import { MAX_RUN_RADIUS_M, MIN_RUN_RADIUS_M } from "@mirage/terrain/run-terrain";
import { geographicModels } from "./conditions";
import { discoverLocalTerrain, sourcesAt, terrainHeightAtPlace, type DiscoveredTerrain } from "./local-terrain";
import type { LocationChoice } from "./location";
import { DEFAULT_TERRAIN_CHOICE, loadTerrainChoice, parseTerrainChoice, saveTerrainChoice, type TerrainChoice } from "./terrain-store";

// The terrain of the next run (TASK-186, S17): every source of the terrain inventory with its kind, layer, coverage, detail, license
// and readiness at the location; the choice between the synthetic level pad and the local real terrain, at run time; and the
// terrain's height at the location as a ground elevation. Imagery is shown and never chosen as ground, and an adapter that needs
// keys, a deployment or data is not ready. Nothing is downloaded: real terrain is only what the local folder serves.

const LAYER_TEXT: Readonly<Record<TerrainSourceRecord["layer"], string>> = { ground: "Ground (elevation)", imagery: "Imagery, not ground", other: "Other data" };
function coverageText(record: TerrainSourceRecord): string {
  const c = record.coverage;
  switch (c.kind) {
    case "any": return "Any location";
    case "none": return record.coverageText;
    case "box": return `${c.south.toFixed(4)}° to ${c.north.toFixed(4)}° N, ${c.west.toFixed(4)}° to ${c.east.toFixed(4)}° E`;
    default: { const never: never = c; return String(never); }
  }
}
type Elevation = { readonly ellipsoidalM: number; readonly mslM: number; readonly undulationM: number } | { readonly reason: string } | null;

export function TerrainSource({ store, projectId, location, onElevation }: {
  store: ProjectStore | null; projectId: string | null; location: LocationChoice; onElevation?: (groundElevationMslM: number) => void;
}) {
  const [saved, setSaved] = useState<TerrainChoice>(DEFAULT_TERRAIN_CHOICE);
  const [sourceId, setSourceId] = useState<TerrainChoice["sourceId"]>(DEFAULT_TERRAIN_CHOICE.sourceId);
  const [radiusText, setRadiusText] = useState(String(DEFAULT_TERRAIN_CHOICE.radiusM));
  const [discovered, setDiscovered] = useState<DiscoveredTerrain | null>(null);
  const [elevation, setElevation] = useState<Elevation>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!store || !projectId) { setSaved(DEFAULT_TERRAIN_CHOICE); setSourceId(DEFAULT_TERRAIN_CHOICE.sourceId); setRadiusText(String(DEFAULT_TERRAIN_CHOICE.radiusM)); return; }
    let cancelled = false;
    void loadTerrainChoice(store, projectId).then(choice => {
      if (cancelled) return;
      setSaved(choice); setSourceId(choice.sourceId); setRadiusText(String(choice.radiusM)); setStatus("");
    });
    return () => { cancelled = true; };
  }, [store, projectId]);
  const look = useCallback(() => {
    setDiscovered(null);
    void discoverLocalTerrain().then(setDiscovered);
  }, []);
  useEffect(look, [look]);

  const records = useMemo(() => (discovered ? sourcesAt(discovered, location.latitudeDeg, location.longitudeDeg) : []), [discovered, location]);
  const ground = records.filter(record => record.layer === "ground");
  const ready = (id: string) => records.some(record => record.id === id && record.readiness === "ready");
  const terrainReady = ready("fabdem-elevation");

  useEffect(() => {
    setElevation(null);
    if (!discovered || !terrainReady) return;
    let cancelled = false;
    void Promise.all([terrainHeightAtPlace(discovered, location.latitudeDeg, location.longitudeDeg), geographicModels()]).then(([height, models]) => {
      if (cancelled) return;
      if (typeof height === "string") { setElevation({ reason: `The local terrain has no height at the location: ${height}` }); return; }
      const undulationM = models.geoid.undulationM(location.latitudeDeg * Math.PI / 180, location.longitudeDeg * Math.PI / 180);
      setElevation({ ellipsoidalM: height, mslM: height - undulationM, undulationM });
    }, (cause: unknown) => { if (!cancelled) setElevation({ reason: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { cancelled = true; };
  }, [discovered, terrainReady, location]);

  const parsed = parseTerrainChoice({ schemaVersion: 1, sourceId, radiusM: Number(radiusText) });
  const refusal = typeof parsed === "string" ? parsed : sourceId === "fabdem-elevation" && !terrainReady
    ? (records.find(record => record.id === "fabdem-elevation")?.reason ?? "The local terrain is not ready") : null;
  const dirty = typeof parsed !== "string" && JSON.stringify(parsed) !== JSON.stringify(saved);
  const save = () => {
    if (!store || !projectId || typeof parsed === "string" || refusal !== null) return;
    saveTerrainChoice(store, projectId, parsed).then(() => {
      setSaved(parsed);
      setStatus(parsed.sourceId === "synthetic-pad" ? "Saved. The next run stands on the synthetic level pad."
        : `Saved. The next run loads the local terrain within ${parsed.radiusM} m of its home, and pauses where the aircraft leaves it.`);
    }, (cause: unknown) => setStatus(`Not saved: ${cause instanceof Error ? cause.message : String(cause)}`));
  };

  return (
    <section aria-labelledby="terrain-heading" data-testid="terrain-source">
      <h3 id="terrain-heading">Terrain</h3>
      <p className="hint">
        The ground the next run stands on. Real terrain comes only from local data that this computer serves; nothing is downloaded or cached.
        Within the loaded terrain the aircraft stands on a level plane at the home&apos;s height, and the run pauses where the loaded terrain ends.
      </p>
      {!store || !projectId ? <p className="hint" data-testid="terrain-no-project">Open a project to choose its terrain.</p> : null}
      <fieldset disabled={!store || !projectId}>
        <legend>Ground of the next run</legend>
        {ground.map(record => (
          <div className="field" key={record.id}>
            <input id={`terrain-choice-${record.id}`} type="radio" name="terrain-choice" value={record.id} checked={sourceId === record.id}
              disabled={record.readiness !== "ready" && sourceId !== record.id} data-testid={`terrain-choice-${record.id}`}
              onChange={() => { if (record.id === "synthetic-pad" || record.id === "fabdem-elevation") setSourceId(record.id); }} />
            <label htmlFor={`terrain-choice-${record.id}`}>
              {record.id === "synthetic-pad" ? `${record.name} (synthetic)` : record.name}
              {record.readiness === "ready" ? "" : ` — not ready: ${record.reason ?? ""}`}
            </label>
          </div>
        ))}
        <div className="field">
          <label htmlFor="terrain-radius">Terrain radius around the home, m ({MIN_RUN_RADIUS_M} to {MAX_RUN_RADIUS_M})</label>
          <input id="terrain-radius" type="text" inputMode="numeric" value={radiusText} disabled={sourceId !== "fabdem-elevation"}
            onChange={event => setRadiusText(event.target.value)} />
        </div>
        <button type="button" onClick={save} disabled={!dirty || refusal !== null}>Save the terrain choice</button>
        <button type="button" onClick={look}>Look for local terrain again</button>
      </fieldset>
      {refusal && <p className="error" role="alert" data-testid="terrain-refusal">{refusal}</p>}
      {status && <p className="hint" role="status" data-testid="terrain-status">{status}</p>}
      <dl className="sitl-status" data-testid="terrain-elevation">
        <dt>Terrain at the location</dt>
        <dd>
          {!discovered ? "Looking for local terrain…"
            : !terrainReady ? "No real terrain covers the location."
            : elevation === null ? "Reading the terrain…"
            : "reason" in elevation ? elevation.reason
            : `${elevation.mslM.toFixed(1)} m above mean sea level (ellipsoidal ${elevation.ellipsoidalM.toFixed(1)} m minus the EGM96 undulation ${elevation.undulationM.toFixed(1)} m; FABDEM refers to EGM2008, which differs from EGM96 by up to about a metre here). The location's ground elevation is ${location.groundElevationMslM.toFixed(1)} m.`}
        </dd>
      </dl>
      {elevation && "mslM" in elevation && onElevation && (
        location.site === null
          ? <button type="button" onClick={() => onElevation(Math.round(elevation.mslM * 10) / 10)}>Use the terrain height as the ground elevation</button>
          : <p className="hint">A built-in site keeps its own elevation; choose coordinates to use the terrain&apos;s.</p>
      )}
      <table className="scheme-table" data-testid="terrain-sources">
        <caption>Terrain sources of the inventory, at the location</caption>
        <thead><tr><th scope="col">Source</th><th scope="col">Layer</th><th scope="col">Coverage</th><th scope="col">Detail</th><th scope="col">License</th><th scope="col">Status</th></tr></thead>
        <tbody>
          {records.map(record => (
            <tr key={record.id} data-testid={`terrain-source-${record.id}`} data-readiness={record.readiness} data-layer={record.layer}>
              <th scope="row">{record.name}</th>
              <td>{LAYER_TEXT[record.layer]}</td>
              <td>{coverageText(record)}</td>
              <td>{record.resolution}</td>
              <td>{`${record.license} (${record.licenseStatus})`}</td>
              <td>{record.readiness === "ready" ? (record.offline ? "Ready, offline" : "Ready") : `Not ready: ${record.reason ?? ""}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
