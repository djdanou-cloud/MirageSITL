import { useEffect, useMemo, useRef, useState } from "react";
import { bindMeasurements, type MeasurementCandidate } from "@mirage/aircraft/calculation-mode";
import { readComponentCard, type ComponentType } from "@mirage/aircraft/components";
import { deriveLayout, type AircraftLayout } from "@mirage/aircraft/layout";
import { readMeasurementSet } from "@mirage/aircraft/measurements";
import { calculationSettings, profileDraft, readAircraftProfile } from "@mirage/aircraft/profile";
import type { StoredVersion } from "@mirage/project/schema";
import type { StoreState } from "../shell/AppShell";
import { nameLanguage } from "../shell/project-files";
import { describeLibraryError } from "../library/library-data";
import { AircraftScheme3D, type RenderedRotor } from "./AircraftScheme3D";
import { ArmTable, type CardOption, type CardOptions } from "./ArmTable";
import { MassProperties } from "./MassProperties";
import { emptyForm, formFromProfile, profileFromForm, type ProfileForm } from "./profile-form";

// The Aircraft tab (TASK-141, S03): create, open, edit, save and copy aircraft
// profiles of the open project without editing files. Every saved version goes
// through validateAircraftProfile and profileDraft (TASK-138); while the form
// is invalid, Save is disabled and the reasons are listed. The 3D scheme draws
// the layout derivation of the last valid form.

interface Editing {
  /** Null for a profile that is not stored yet. */
  readonly itemId: string | null;
  readonly head: StoredVersion | null;
  readonly name: string;
  readonly form: ProfileForm;
  readonly savedName: string;
  /** The form as last opened or saved, to detect unsaved changes. */
  readonly savedForm: string;
}
interface Library {
  readonly profiles: readonly StoredVersion[];
  readonly cards: CardOptions & { readonly battery: readonly CardOption[] };
  readonly candidates: readonly MeasurementCandidate[];
}
const EMPTY_LIBRARY: Library = { profiles: [], cards: { motor: [], propeller: [], esc: [], battery: [] }, candidates: [] };

function editingOf(stored: StoredVersion): Editing {
  const form = formFromProfile(readAircraftProfile(stored));
  return { itemId: stored.record.id, head: stored, name: stored.record.name, form, savedName: stored.record.name, savedForm: JSON.stringify(form) };
}

/** `active`: the tab is shown. Panels stay mounted, so the profiles and cards are read again whenever the tab is opened. */
export function AircraftEditor({ storeState, project, active }: { storeState: StoreState; project: StoredVersion | null; active: boolean }) {
  const store = storeState.status === "ready" ? storeState.store : null;
  const projectId = project?.record.id ?? null;
  const [library, setLibrary] = useState<Library>(EMPTY_LIBRARY);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyName, setCopyName] = useState("");
  const [rendered, setRendered] = useState<readonly RenderedRotor[]>([]);
  const [shared, setShared] = useState<{ motor: string | null; propeller: string | null; esc: string | null }>({ motor: null, propeller: null, esc: null });

  useEffect(() => {
    setEditing(null);
    setStatus("");
  }, [projectId]);
  useEffect(() => {
    if (!store || !projectId || !active) return;
    let cancelled = false;
    void (async () => {
      const [profiles, cardHeads, setHeads] = await Promise.all([
        store.listItems(projectId, "aircraft-profile"), store.listItems(projectId, "component-card"), store.listItems(projectId, "measurement-set"),
      ]);
      const cards: { [type in ComponentType]: CardOption[] } = { motor: [], propeller: [], esc: [], battery: [] };
      for (const stored of cardHeads) {
        try {
          cards[readComponentCard(stored).type].push({ sha256: stored.sha256, name: stored.record.name });
        } catch {
          // An unreadable card cannot be selected; the Components tab shows why.
        }
      }
      const candidates = setHeads.flatMap(stored => {
        try {
          return [{ sha256: stored.sha256, createdAt: stored.record.createdAt, set: readMeasurementSet(stored) }];
        } catch {
          return [];
        }
      });
      if (cancelled) return;
      setLibrary({ profiles, cards, candidates });
      // The Sensors tab may have saved a newer version of the open profile; follow it unless there are unsaved changes.
      setEditing(current => {
        if (!current?.itemId || current.name !== current.savedName || JSON.stringify(current.form) !== current.savedForm) return current;
        const head = profiles.find(stored => stored.record.id === current.itemId);
        if (!head || head.sha256 === current.head?.sha256) return current;
        try {
          return editingOf(head);
        } catch {
          return current;
        }
      });
    })().catch((error: unknown) => { if (!cancelled) setStatus(describeLibraryError(error)); });
    return () => { cancelled = true; };
  }, [store, projectId, revision, active]);

  const result = useMemo(() => (editing ? profileFromForm(editing.form) : null), [editing]);
  const nameError = editing && editing.name.trim() === "" ? "Give the profile a name" : null;
  const errors = [...(nameError ? [nameError] : []), ...(result && !result.ok ? result.errors : [])];
  const dirty = editing !== null && (editing.name !== editing.savedName || JSON.stringify(editing.form) !== editing.savedForm);
  // The scheme keeps the last valid layout while an edit is invalid.
  const lastLayout = useRef<AircraftLayout | null>(null);
  const layout = useMemo(() => (result?.ok ? deriveLayout(result.profile) : null), [result]);
  if (layout) lastLayout.current = layout;
  if (!editing) lastLayout.current = null;
  const shownLayout = layout ?? lastLayout.current;

  const setForm = (form: ProfileForm) => setEditing(current => (current ? { ...current, form } : current));
  const perform = (action: () => Promise<string>) => {
    setBusy(true);
    void action().then(setStatus, (error: unknown) => setStatus(describeLibraryError(error))).finally(() => setBusy(false));
  };
  const open = (stored: StoredVersion) => {
    try {
      setEditing(editingOf(stored));
      setCopyName(`${stored.record.name} copy`);
      setStatus(`Opened ${stored.record.name}, version ${stored.record.version}.`);
    } catch (error) {
      setStatus(`${stored.record.name} cannot be opened: ${describeLibraryError(error)}`);
    }
  };
  const save = () => {
    if (!store || !projectId || !editing || !result?.ok || nameError) return;
    perform(async () => {
      let profile = result.profile;
      // A measured profile binds the newest measurement sets of exactly its new combinations (TASK-140).
      if (calculationSettings(profile).mode === "measured") profile = await bindMeasurements(profile, "measured", library.candidates);
      const draft = profileDraft(editing.name, profile);
      const stored = editing.itemId && editing.head
        ? await store.saveVersion(editing.itemId, editing.head.sha256, draft)
        : await store.createItem(projectId, "aircraft-profile", draft);
      setEditing(editingOf(stored));
      setRevision(value => value + 1);
      if (stored.sha256 === editing.head?.sha256) return "Nothing changed, so no version was saved.";
      return stored.record.version === 1 ? `Created ${stored.record.name}.` : `Saved version ${stored.record.version} of ${stored.record.name}.`;
    });
  };
  const copy = () => {
    if (!store || !editing?.head) return;
    const source = editing.head;
    perform(async () => {
      const copied = await store.copyItem(source.sha256, copyName);
      setRevision(value => value + 1);
      return `Copied ${source.record.name} to ${copied.record.name}; the original is unchanged.`;
    });
  };
  const applyShared = () => {
    if (!editing) return;
    setForm({
      ...editing.form,
      arms: editing.form.arms.map(arm => ({ ...arm, upper: { ...arm.upper, ...shared }, lower: { ...arm.lower, ...shared } })),
    });
  };

  if (!project) {
    return (
      <div className="aircraft-panel">
        <h2>Aircraft</h2>
        <p>No project is open. Open or create a project in the Project tab to edit its aircraft profiles.</p>
      </div>
    );
  }
  const select = (id: string, label: string, value: string | null, options: readonly CardOption[], onChange: (value: string | null) => void) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ""} onChange={event => onChange(event.target.value === "" ? null : event.target.value)}>
        <option value="">None selected</option>
        {options.map(option => <option key={option.sha256} value={option.sha256}>{option.name}</option>)}
      </select>
    </div>
  );
  return (
    <div className="aircraft-panel">
      <h2>Aircraft</h2>
      <p>
        Aircraft profiles of <span lang={nameLanguage(project.record.name)}>{project.record.name}</span>: arms, motors and their outputs,
        mass properties, and a 3D scheme of each motor's position, spin and thrust axis.
      </p>
      <section className="project-section" aria-labelledby="profiles-heading">
        <h3 id="profiles-heading">Aircraft profiles</h3>
        {library.profiles.length === 0 ? <p>The project has no aircraft profiles yet.</p> : (
          <ul className="project-list" aria-label="Aircraft profiles">
            {library.profiles.map(stored => (
              <li key={stored.sha256}>
                <span lang={nameLanguage(stored.record.name)}>{stored.record.name}, version {stored.record.version}</span>
                {editing?.itemId === stored.record.id ? <span className="current-tag">Open now</span> : (
                  <button type="button" disabled={dirty || busy} aria-label={`Open ${stored.record.name}`} onClick={() => open(stored)}>Open</button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="button-row">
          <button type="button" disabled={dirty || busy} onClick={() => {
            setEditing({ itemId: null, head: null, name: "", form: emptyForm(), savedName: "", savedForm: "" });
            setStatus("A new profile is open. It is stored when you save it.");
          }}>New profile</button>
          {dirty && (
            <button type="button" disabled={busy} onClick={() => {
              setEditing(editing?.head ? editingOf(editing.head) : null);
              setStatus("The changes were discarded.");
            }}>Discard changes</button>
          )}
        </div>
        {dirty && <p className="hint">Save or discard the changes before opening another profile.</p>}
      </section>
      {editing && (
        <>
          <section className="project-section" aria-labelledby="profile-heading">
            <h3 id="profile-heading">{editing.itemId ? `Editing ${editing.savedName}` : "New profile"}</h3>
            <div className="field">
              <label htmlFor="profile-name">Profile name</label>
              <input id="profile-name" type="text" value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} />
            </div>
            <p className="hint">
              {editing.form.calculation?.mode === "measured"
                ? "Calculation from measurements: saving binds the newest measurement sets of exactly this profile's combinations."
                : "Preliminary calculation. The calculation mode is set in the Components tab."}
              {" "}Sensor errors, placement and presets are set in the Sensors tab; saving here keeps them.
            </p>
            {errors.length > 0 && (
              <ul className="form-errors" aria-label="Problems to fix before saving">{errors.map(error => <li key={error}>{error}</li>)}</ul>
            )}
            <div className="button-row">
              <button type="button" className="save-button" disabled={busy || !dirty || errors.length > 0} onClick={save}>Save profile</button>
            </div>
            {editing.head && (
              <form className="inline-form copy-form" onSubmit={event => { event.preventDefault(); copy(); }}>
                <label htmlFor="copy-name">Copy as</label>
                <input id="copy-name" type="text" value={copyName} onChange={event => setCopyName(event.target.value)} />
                <button type="submit" disabled={busy || copyName.trim() === ""}>Copy profile</button>
              </form>
            )}
            <p role="status" className="status-message project-status" data-testid="aircraft-status">{status}</p>
          </section>
          <section className="project-section" aria-labelledby="scheme-heading">
            <h3 id="scheme-heading">Scheme</h3>
            {shownLayout ? (
              <div data-testid="aircraft-scheme" data-rendered={JSON.stringify(rendered)} data-current={layout ? "true" : "false"}>
                {!layout && <p className="hint">The form has problems, so the scheme shows the last valid layout.</p>}
                <AircraftScheme3D layout={shownLayout} name={editing.name || "the new profile"} onRendered={setRendered} />
              </div>
            ) : <p>The scheme appears once the arms, motors and mass properties are valid.</p>}
          </section>
          <ArmTable form={editing.form} cards={library.cards} onChange={setForm} />
          <section className="project-section" aria-labelledby="propulsion-heading">
            <h3 id="propulsion-heading">Propulsion and battery</h3>
            <p className="hint">Cards come from the Components tab. Choose cards here for every motor at once, or per motor in its arm.</p>
            <div className="field-grid">
              {select("all-motor-card", "Motor card for every motor", shared.motor, library.cards.motor, motor => setShared({ ...shared, motor }))}
              {select("all-propeller-card", "Propeller card for every motor", shared.propeller, library.cards.propeller, propeller => setShared({ ...shared, propeller }))}
              {select("all-esc-card", "ESC card for every motor", shared.esc, library.cards.esc, esc => setShared({ ...shared, esc }))}
            </div>
            <div className="button-row">
              <button type="button" onClick={applyShared}>Apply to every motor</button>
            </div>
            {select("battery-card", "Battery card", editing.form.batteryCard, library.cards.battery, batteryCard => setForm({ ...editing.form, batteryCard }))}
          </section>
          <MassProperties form={editing.form} onChange={setForm} />
        </>
      )}
    </div>
  );
}
