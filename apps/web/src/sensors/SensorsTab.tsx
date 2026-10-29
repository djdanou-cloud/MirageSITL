import { useEffect, useMemo, useState } from "react";
import { profileDraft, readAircraftProfile, withSensorConfiguration } from "@mirage/aircraft/profile";
import {
  FIXED_ARDUPILOT_ROWS, SENSOR_FIELDS, SENSOR_KINDS, sensorField, type SensorFieldSpec, type SensorKind,
} from "@mirage/aircraft/sensor-fields";
import { IDEAL_RESIDUALS, RESIDUALS, otherArduPilotTerms, resolveSensorConfiguration, type Effective, type ResolvedField } from "@mirage/aircraft/sensor-ownership";
import { findSensorPreset, latestPresetCatalog, presetCatalog } from "@mirage/aircraft/sensor-presets";
import type { StoredVersion } from "@mirage/project/schema";
import type { StoreState } from "../shell/AppShell";
import { nameLanguage } from "../shell/project-files";
import { describeLibraryError } from "../library/library-data";
import {
  applyPresetToForm, componentLabel, editQuantity, fieldLabel, formFromSensors, sensorsFromForm, type SensorForm,
} from "./sensor-form";

// The Sensors tab (TASK-143, S08): Ideal sensors or specified errors for the
// IMU, GNSS, barometer, magnetometer and battery sensing of each aircraft
// profile. Every field shows its owner on the Phase 1 path (ArduPilot SITL as
// an external process); fields their owner cannot apply yet are disabled with
// the reason. Saving writes a profile version through withSensorConfiguration
// and profileDraft; the ArduPilot defaults are stored as null.

const SENSOR_TITLES: { readonly [kind in SensorKind]: string } = {
  imu: "IMU", gnss: "GNSS", barometer: "Barometer", magnetometer: "Magnetometer", battery: "Battery voltage and current",
};
interface Editing {
  readonly itemId: string;
  readonly head: StoredVersion;
  readonly form: SensorForm;
  /** The form as opened or saved, to detect unsaved changes. */
  readonly savedForm: string;
}
function editingOf(stored: StoredVersion): Editing {
  const form = formFromSensors(readAircraftProfile(stored).sensorConfiguration);
  return { itemId: stored.record.id, head: stored, form, savedForm: JSON.stringify(form) };
}
function summary(stored: StoredVersion): string {
  try {
    const config = readAircraftProfile(stored).sensorConfiguration;
    return config === null ? "ArduPilot defaults" : config.mode === "ideal" ? "Ideal sensors" : "With specified errors";
  } catch {
    return "cannot be read";
  }
}
function ownerText(spec: SensorFieldSpec, ideal: boolean): string {
  if (spec.owner === "unassigned") return "Nobody yet";
  if (!spec.applicable) return "ArduPilot SITL; cannot be set on native-json yet";
  if (spec.owner === "mirage") return ideal ? "MirageSITL, off in Ideal" : "MirageSITL";
  if (spec.source === "mag.hard-iron") return ideal ? "ArduPilot SITL, stock pairing kept in Ideal" : "ArduPilot SITL";
  return ideal ? "ArduPilot SITL, switched off in Ideal" : "ArduPilot SITL";
}
function statusText(field: ResolvedField | undefined): string {
  const effective: Effective | undefined = field?.effective;
  switch (effective?.kind) {
    case "specified": return field?.owner === "mirage" ? "Applied by MirageSITL" : "Applied by ArduPilot SITL";
    case "neutral": return "Off in Ideal";
    case "neutralized": return "Switched off in Ideal";
    case "ardupilot-stock": return "ArduPilot default";
    case "not-applied": return field?.owner === "mirage" ? "Not specified: nothing injected" : "Not applied";
    case undefined: return "";
    default: {
      const unreachable: never = effective;
      return String(unreachable);
    }
  }
}

export function SensorsTab({ storeState, project, active }: { storeState: StoreState; project: StoredVersion | null; active: boolean }) {
  const store = storeState.status === "ready" ? storeState.store : null;
  const projectId = project?.record.id ?? null;
  const [profiles, setProfiles] = useState<readonly StoredVersion[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<{ [kind in SensorKind]?: string }>({});
  const dirty = editing !== null && JSON.stringify(editing.form) !== editing.savedForm;

  useEffect(() => {
    setEditing(null);
    setProfiles(null);
    setStatus("");
  }, [projectId]);
  useEffect(() => {
    if (!store || !projectId || !active) return;
    let cancelled = false;
    store.listItems(projectId, "aircraft-profile").then(heads => {
      if (cancelled) return;
      setProfiles(heads);
      // Another tab may have saved a newer version of the open profile; follow it unless there are unsaved changes.
      setEditing(current => {
        if (!current || JSON.stringify(current.form) !== current.savedForm) return current;
        const head = heads.find(item => item.record.id === current.itemId);
        if (!head || head.sha256 === current.head.sha256) return current;
        try {
          setChoices({});
          return editingOf(head);
        } catch {
          return current;
        }
      });
    }, (error: unknown) => { if (!cancelled) setStatus(describeLibraryError(error)); });
    return () => { cancelled = true; };
  }, [store, projectId, active, revision]);

  const result = useMemo(() => (editing ? sensorsFromForm(editing.form) : null), [editing]);
  const resolved = useMemo(() => (result?.ok ? resolveSensorConfiguration(result.configuration) : null), [result]);
  const ideal = editing?.form.mode === "ideal";

  const open = (stored: StoredVersion) => {
    try {
      setEditing(editingOf(stored));
      setChoices({});
      setStatus(`Opened ${stored.record.name}, version ${stored.record.version}.`);
    } catch (error) {
      setStatus(`${stored.record.name} cannot be opened: ${describeLibraryError(error)}`);
    }
  };
  const setForm = (form: SensorForm) => setEditing(current => (current ? { ...current, form } : current));
  const save = () => {
    if (!store || !editing || !result?.ok) return;
    const { head, itemId } = editing, configuration = result.configuration, submitted = JSON.stringify(editing.form);
    setBusy(true);
    void (async () => {
      const profile = withSensorConfiguration(readAircraftProfile(head), configuration);
      const stored = await store.saveVersion(itemId, head.sha256, profileDraft(head.record.name, profile));
      // Edits typed while the save ran stay; only an unchanged form moves to the saved version.
      setEditing(current => (current?.itemId === itemId && JSON.stringify(current.form) === submitted ? editingOf(stored) : current));
      setChoices({});
      setRevision(value => value + 1);
      if (stored.sha256 === head.sha256) return "Nothing changed, so no version was saved.";
      return `Saved version ${stored.record.version} of ${stored.record.name}.`;
    })().then(setStatus, (error: unknown) => {
      setStatus(`The sensors were not saved: ${describeLibraryError(error)}`);
      // Reread the project, so that Discard can return to the current version after a conflict.
      setRevision(value => value + 1);
    }).finally(() => setBusy(false));
  };
  const applyPreset = (kind: SensorKind) => {
    if (!editing) return;
    const choice = choices[kind] ?? editing.form.presets[kind]?.id ?? "";
    if (choice === "") {
      setForm({ ...editing.form, presets: { ...editing.form.presets, [kind]: null } });
      setStatus(`No ${SENSOR_TITLES[kind]} preset; the values stay as they are.`);
      return;
    }
    const outcome = applyPresetToForm(editing.form, { catalogVersion: latestPresetCatalog().catalogVersion, id: choice });
    setForm(outcome.form);
    const part = findSensorPreset({ catalogVersion: latestPresetCatalog().catalogVersion, id: choice })?.part ?? choice;
    const applied = outcome.applied.map(path => fieldLabel(sensorField(path)));
    const skipped = outcome.skipped.map(item => `${fieldLabel(sensorField(item.field))}: ${item.reason}`);
    setStatus(`Applied ${part}: ${applied.length > 0 ? applied.join(", ") : "no value"}.${skipped.length > 0 ? ` Not applied: ${skipped.join(" ")}` : ""}`);
  };

  if (!project) {
    return (
      <div className="library-panel sensors-panel">
        <h2>Sensors</h2>
        <p>No project is open. Open or create a project in the Project tab to set the sensors of its aircraft profiles.</p>
      </div>
    );
  }
  const errors = result && !result.ok ? result.errors : [];
  return (
    <div className="library-panel sensors-panel">
      <h2>Sensors</h2>
      <p>
        Sensor errors of the aircraft profiles in <span lang={nameLanguage(project.record.name)}>{project.record.name}</span>.
        Owners are those of ArduPilot SITL as an external process; runs apply these settings from TASK-147, and the synthetic demo ignores them.
      </p>
      <section className="project-section" aria-labelledby="sensor-profiles-heading">
        <h3 id="sensor-profiles-heading">Aircraft profiles</h3>
        {profiles === null ? <p>Reading the project.</p> : profiles.length === 0 ? (
          <p>This project has no aircraft profile. Create one in the Aircraft tab.</p>
        ) : (
          <ul className="project-list" aria-label="Aircraft profiles for sensors">
            {profiles.map(stored => (
              <li key={stored.sha256}>
                <span lang={nameLanguage(stored.record.name)}>{stored.record.name}, version {stored.record.version}: {summary(stored)}</span>
                {editing?.itemId === stored.record.id ? <span className="current-tag">Open now</span> : (
                  <button type="button" disabled={dirty || busy} aria-label={`Open the sensors of ${stored.record.name}`} onClick={() => open(stored)}>Open</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {dirty && <p className="hint">Save or discard the sensor changes before opening another profile.</p>}
      </section>
      {editing && (
        <section className="project-section sensor-editor" aria-labelledby="sensor-editor-heading"
          data-testid="sensor-editor" data-resolved={resolved ? JSON.stringify(resolved) : ""}>
          <h3 id="sensor-editor-heading">
            Sensors of <span lang={nameLanguage(editing.head.record.name)}>{editing.head.record.name}</span>, version {editing.head.record.version}
          </h3>
          <fieldset>
            <legend>Sensor errors</legend>
            <label className="choice">
              <input type="radio" name="sensor-mode" disabled={busy} checked={editing.form.mode === "ideal"} onChange={() => setForm({ ...editing.form, mode: "ideal" })} /> Ideal sensors
            </label>
            <label className="choice">
              <input type="radio" name="sensor-mode" disabled={busy} checked={editing.form.mode === "specified"} onChange={() => setForm({ ...editing.form, mode: "specified" })} /> With specified errors
            </label>
          </fieldset>
          <p className="hint" data-testid="sensor-state">
            {resolved === null ? "The form has problems." : resolved.state === "ardupilot-defaults" ? "ArduPilot defaults: MirageSITL injects nothing."
              : resolved.state === "ideal" ? "Ideal sensors: every error that a setting can switch off is off." : "Differs from the ArduPilot defaults."}
          </p>
          <div className="button-row">
            <button type="button" disabled={busy} onClick={() => { setForm(formFromSensors(null)); setChoices({}); }}>Reset to ArduPilot defaults</button>
          </div>
          <section className="residuals" aria-labelledby="residuals-heading">
            <h4 id="residuals-heading">What ArduPilot still adds in Ideal mode</h4>
            <ul className="limit-list">
              {IDEAL_RESIDUALS.map(id => (
                <li key={id}>{RESIDUALS[id].text}{RESIDUALS[id].verified ? "" : " (inferred, not yet measured)"}</li>
              ))}
            </ul>
          </section>
          {SENSOR_KINDS.map(kind => {
            const presets = latestPresetCatalog().presets.filter(preset => preset.sensor === kind);
            const current = editing.form.presets[kind];
            const shown = current ? findSensorPreset(current) : null;
            const citations = shown ? (presetCatalog(current?.catalogVersion ?? 0)?.citations ?? [])
              .filter(citation => [...shown.values, ...shown.references].some(item => item.citation === citation.id)) : [];
            return (
              <fieldset key={kind} className="sensor-group">
                <legend>{SENSOR_TITLES[kind]}</legend>
                <div className="inline-form preset-row">
                  <label htmlFor={`preset-${kind}`}>{SENSOR_TITLES[kind]} preset</label>
                  <select id={`preset-${kind}`} value={choices[kind] ?? current?.id ?? ""} onChange={event => setChoices({ ...choices, [kind]: event.target.value })}>
                    <option value="">No preset</option>
                    {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.manufacturer} {preset.part}</option>)}
                  </select>
                  <button type="button" disabled={busy} onClick={() => applyPreset(kind)}>Apply {SENSOR_TITLES[kind]} preset</button>
                </div>
                {shown && (
                  <details>
                    <summary>Sources of the {shown.part} preset</summary>
                    <ul className="limit-list">
                      {shown.values.map(item => (
                        <li key={item.field}>{fieldLabel(sensorField(item.field))}: {item.datasheet.value} {item.datasheet.unit} ({item.datasheet.conditions}), [{item.citation}] {item.locator}</li>
                      ))}
                      {shown.references.map(note => <li key={`${note.field}-${note.text}`}>{note.text} [{note.citation}] Not filled: {note.reasonNotFilled}</li>)}
                      {citations.map(citation => (
                        <li key={citation.id}>[{citation.id}] {citation.publisher}, {citation.title}{citation.documentNumber ? `, ${citation.documentNumber}` : ""}{citation.revision ? `, ${citation.revision}` : ""}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <div className="table-scroll" tabIndex={0} role="region" aria-label={`${SENSOR_TITLES[kind]} settings`}>
                  <table className="entry-table sensor-table">
                    <thead>
                      <tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">Owner</th><th scope="col">Status</th></tr>
                    </thead>
                    <tbody>
                      {SENSOR_FIELDS.filter(spec => spec.sensor === kind).map(spec => {
                        const parts = editing.form.values[spec.path] ?? [];
                        const field = resolved?.fields.find(item => item.path === spec.path);
                        const reasonId = `reason-${spec.path.replace(".", "-")}`;
                        return (
                          <tr key={spec.path}>
                            <th scope="row">{fieldLabel(spec)}</th>
                            <td>
                              {parts.map((part, index) => (
                                <input key={index} type="text" inputMode="decimal" aria-label={componentLabel(spec, index)}
                                  aria-describedby={spec.applicable ? undefined : reasonId} disabled={!spec.applicable || ideal || busy}
                                  placeholder={spec.applicable ? (spec.owner === "mirage" ? "off" : "default") : "not available"}
                                  value={spec.applicable ? part.text : ""}
                                  onChange={event => setForm({ ...editing.form, values: { ...editing.form.values,
                                    [spec.path]: parts.map((item, i) => (i === index ? editQuantity(event.target.value) : item)) } })} />
                              ))}
                            </td>
                            <td><span data-testid={`owner-${spec.path}`}>{ownerText(spec, ideal)}</span></td>
                            <td>
                              {spec.applicable ? (ideal && parts.some(part => part.text !== "") ? "Kept; not used while Ideal sensors is selected" : statusText(field))
                                : <span id={reasonId} className="hint">{spec.disabledReason}</span>}
                            </td>
                          </tr>
                        );
                      })}
                      {kind === "imu" && FIXED_ARDUPILOT_ROWS.map(row => (
                        <tr key={row.id}>
                          <th scope="row">{row.label}</th>
                          <td>{row.text}</td>
                          <td><span data-testid={`owner-${row.id}`}>ArduPilot SITL (fixed)</span></td>
                          <td>Cannot be switched off on stock ArduPilot (D-10)</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </fieldset>
            );
          })}
          <section aria-labelledby="other-terms-heading">
            <h4 id="other-terms-heading">Other ArduPilot SITL error terms</h4>
            <ul className="limit-list">
              {otherArduPilotTerms(result?.ok ? result.configuration : null).map(term => (
                <li key={term.source}><span data-testid={`owner-${term.source}`}>ArduPilot SITL</span>: {term.label}, {ideal ? "switched off in Ideal" : term.state}</li>
              ))}
            </ul>
          </section>
          {errors.length > 0 && (
            <ul className="form-errors" aria-label="Problems to fix before saving the sensors">{errors.map(error => <li key={error}>{error}</li>)}</ul>
          )}
          <div className="button-row">
            <button type="button" className="save-button" disabled={busy || !dirty || errors.length > 0} onClick={save}>Save sensors</button>
            {dirty && (
              <button type="button" disabled={busy} onClick={() => {
                const head = profiles?.find(item => item.record.id === editing.itemId) ?? editing.head;
                setEditing(editingOf(head));
                setChoices({});
                setRevision(value => value + 1);
                setStatus("The sensor changes were discarded.");
              }}>Discard changes</button>
            )}
          </div>
        </section>
      )}
      <p role="status" className="status-message project-status" data-testid="sensors-status">{status}</p>
    </div>
  );
}

