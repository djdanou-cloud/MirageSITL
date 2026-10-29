import { useMemo, useState, type ChangeEvent, type Dispatch, type SetStateAction } from "react";
import { readComponentCard, type ComponentType, type SourceKind } from "@mirage/aircraft/components";
import { derivePropellerGeometry, type PropellerGeometryResult } from "@mirage/aircraft/propeller-geometry";
import { sha256Hex, type StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import {
  CARD_FIELDS, DISTRIBUTION_COLUMNS, MAX_DISTRIBUTION_ROWS, MAX_SOURCES, addSource, cardFromForm, formFromCard, newCardForm,
  removeSource, setKnown, type CardForm, type FieldForm, type FieldSpec, type RowForm, type SourceForm,
} from "./card-form";
import { describeLibraryError, typeName } from "./library-data";

// The component-card editor (TASK-192, S04): create, edit and copy motor,
// propeller, ESC and battery cards of the open project without editing files.
// Every saved version goes through validateComponentCard (TASK-139); while the
// form is invalid, Save is disabled and the reasons are listed. Saving appends
// a version, so profiles and measurement sets keep the exact versions they
// reference. A propeller card shows the BET geometry derived from it.

export interface CardEditing {
  /** Null for a card that is not stored yet. */
  readonly itemId: string | null;
  readonly head: StoredVersion | null;
  readonly name: string;
  readonly form: CardForm;
  readonly savedName: string;
  /** The form as last opened or saved, to detect unsaved changes. */
  readonly savedForm: string;
}
export function editingOfCard(stored: StoredVersion): CardEditing {
  const form = formFromCard(readComponentCard(stored));
  return { itemId: stored.record.id, head: stored, name: stored.record.name, form, savedName: stored.record.name, savedForm: JSON.stringify(form) };
}
export function newCardEditing(type: ComponentType): CardEditing {
  return { itemId: null, head: null, name: "", form: newCardForm(type), savedName: "", savedForm: "" };
}
export function cardChanged(editing: CardEditing | null): boolean {
  return editing !== null && (editing.name !== editing.savedName || JSON.stringify(editing.form) !== editing.savedForm);
}

const SOURCE_KINDS: readonly { readonly kind: SourceKind; readonly label: string }[] = [
  { kind: "specification", label: "Datasheet or catalog" },
  { kind: "measured", label: "Own measurement" },
  { kind: "synthetic", label: "Illustrative or assumed" },
];
const EMPTY_ROW: RowForm = { ratio: "", value: "", rad: null };
const degrees = (rad: number) => String(Number(((rad * 180) / Math.PI).toPrecision(6)));
const metres = (value: number) => String(Number(value.toPrecision(6)));

function SourceFields({ source, index, count, onChange, onRemove, onFile }: {
  source: SourceForm; index: number; count: number;
  onChange: (source: SourceForm) => void; onRemove: () => void; onFile: (file: File) => void;
}) {
  const id = `card-source-${index + 1}`;
  const readFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onFile(file);
  };
  return (
    <fieldset>
      <legend>Source {index + 1}</legend>
      <div className="field-grid">
        <div className="field">
          <label htmlFor={`${id}-id`}>Source {index + 1} ID</label>
          <input id={`${id}-id`} type="text" value={source.id} onChange={event => onChange({ ...source, id: event.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-kind`}>Source {index + 1} kind</label>
          <select id={`${id}-kind`} value={source.kind} onChange={event => {
            const kind = SOURCE_KINDS.find(item => item.kind === event.target.value)?.kind;
            if (kind) onChange({ ...source, kind });
          }}>
            {SOURCE_KINDS.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-date`}>Source {index + 1} date (optional)</label>
          <input id={`${id}-date`} type="date" value={source.date} onChange={event => onChange({ ...source, date: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-description`}>Source {index + 1} description</label>
        <input id={`${id}-description`} type="text" value={source.description} onChange={event => onChange({ ...source, description: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-sha256`}>Source {index + 1} SHA-256 (optional)</label>
        <input id={`${id}-sha256`} type="text" spellCheck={false} value={source.sha256} onChange={event => onChange({ ...source, sha256: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-file`}>Source {index + 1} SHA-256 from a file</label>
        <input id={`${id}-file`} type="file" onChange={readFile} />
      </div>
      {source.kind === "measured" && <p className="hint">A measured source needs the SHA-256 and the date of its data.</p>}
      <div className="button-row">
        <button type="button" disabled={count <= 1} onClick={onRemove}>Remove source {index + 1}</button>
      </div>
    </fieldset>
  );
}

function SourceSelect({ spec, field, sources, onChange }: {
  spec: FieldSpec; field: FieldForm; sources: readonly SourceForm[]; onChange: (source: number | null) => void;
}) {
  return (
    <select aria-label={`Source of ${spec.label}`} disabled={!field.known} value={field.source === null ? "" : String(field.source)}
      onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))}>
      <option value="">Choose a source</option>
      {sources.map((source, index) => <option key={index} value={String(index)}>{source.id.trim() || `Source ${index + 1}`}</option>)}
    </select>
  );
}

function DistributionFields({ spec, kind, field, sources, onChange, onKnown }: {
  spec: FieldSpec; kind: "chord" | "twist"; field: FieldForm; sources: readonly SourceForm[];
  onChange: (field: FieldForm) => void; onKnown: (known: boolean) => void;
}) {
  const column = DISTRIBUTION_COLUMNS[kind];
  const setRow = (index: number, row: RowForm) => onChange({ ...field, rows: field.rows.map((item, i) => (i === index ? row : item)) });
  return (
    <fieldset className="distribution">
      <legend>{spec.label}</legend>
      <label className="choice">
        <input type="checkbox" checked={field.known} onChange={event => onKnown(event.target.checked)} /> {spec.label} is known
      </label>
      <SourceSelect spec={spec} field={field} sources={sources} onChange={source => onChange({ ...field, source })} />
      <div className="table-scroll" tabIndex={0} role="region" aria-label={`${spec.label} stations`}>
        <table className="entry-table">
          <thead>
            <tr><th scope="col">r/R</th><th scope="col">{column.heading}</th></tr>
          </thead>
          <tbody>
            {field.rows.map((row, index) => (
              <tr key={index}>
                <td>
                  <input type="text" inputMode="decimal" disabled={!field.known} aria-label={`${spec.label} row ${index + 1} r/R`} value={row.ratio}
                    onChange={event => setRow(index, { ...row, ratio: event.target.value })} />
                </td>
                <td>
                  {/* A typed angle replaces the stored radians. */}
                  <input type="text" inputMode="decimal" disabled={!field.known} aria-label={`${spec.label} row ${index + 1} ${column.label}`} value={row.value}
                    onChange={event => setRow(index, { ...row, value: event.target.value, rad: null })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="button-row">
        <button type="button" disabled={!field.known || field.rows.length >= MAX_DISTRIBUTION_ROWS}
          onClick={() => onChange({ ...field, rows: [...field.rows, EMPTY_ROW] })}>Add {spec.label.toLowerCase()} row</button>
        <button type="button" disabled={!field.known || field.rows.length <= 1}
          onClick={() => onChange({ ...field, rows: field.rows.slice(0, -1) })}>Remove last {spec.label.toLowerCase()} row</button>
      </div>
    </fieldset>
  );
}

function PropellerPreview({ preview }: { preview: PropellerGeometryResult }) {
  const geometry = preview.geometry;
  return (
    <div data-testid="propeller-preview" data-geometry={JSON.stringify(preview)}>
      <p>
        {geometry.bladeCount} blades, radius {metres(geometry.radiusM)} m, blade from {metres(geometry.rootCutoutM)} m,
        {geometry.bladeInertiaKgM2 === null ? " inertia not known" : ` inertia ${String(Number(geometry.bladeInertiaKgM2.toPrecision(4)))} kg·m²`},
        airfoil {geometry.airfoil ?? "not named"}.
      </p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Blade stations">
        <table className="scheme-table">
          <caption>Blade stations ({geometry.radialStationM.length} strips)</caption>
          <thead>
            <tr><th scope="col">Station</th><th scope="col">r (m)</th><th scope="col">Chord (m)</th><th scope="col">Blade angle (°)</th><th scope="col">Width (m)</th></tr>
          </thead>
          <tbody>
            {geometry.radialStationM.map((r, i) => (
              <tr key={i}>
                <th scope="row">{i + 1}</th>
                <td>{metres(r)}</td>
                <td>{metres(geometry.chordM[i] ?? Number.NaN)}</td>
                <td>{degrees(geometry.twistRad[i] ?? Number.NaN)}</td>
                <td>{metres(geometry.quadratureWidthM[i] ?? Number.NaN)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Assumptions</h4>
      <ul className="limit-list" aria-label="Geometry assumptions">{preview.assumptions.map(note => <li key={note.id}>{note.description}</li>)}</ul>
      <h4>Validity flags</h4>
      {preview.flags.length === 0 ? <p>None: every value the geometry needs is given.</p> : (
        <ul className="limit-list" aria-label="Geometry validity flags">{preview.flags.map(note => <li key={note.id}>{note.description}</li>)}</ul>
      )}
    </div>
  );
}

export function CardEditor({ store, projectId, editing, onChange, onSaved }: {
  store: ProjectStore; projectId: string; editing: CardEditing;
  onChange: Dispatch<SetStateAction<CardEditing | null>>; onSaved: () => void;
}) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyName, setCopyName] = useState(() => (editing.head ? `${editing.head.record.name} copy` : ""));
  const form = editing.form;
  const result = useMemo(() => cardFromForm(form), [form]);
  const nameError = editing.name.trim() === "" ? "Give the card a name" : null;
  const errors = [...(nameError ? [nameError] : []), ...(result.ok ? [] : result.errors)];
  const dirty = cardChanged(editing);
  const preview = useMemo(() => (result.ok && result.card.type === "propeller" ? derivePropellerGeometry(result.card) : null), [result]);

  const setForm = (next: CardForm) => onChange({ ...editing, form: next });
  const setField = (key: string, field: FieldForm) => setForm({ ...form, fields: { ...form.fields, [key]: field } });
  const setSource = (index: number, source: SourceForm) => setForm({ ...form, sources: form.sources.map((item, i) => (i === index ? source : item)) });
  const perform = (action: () => Promise<string>) => {
    setBusy(true);
    void action().then(setStatus, (error: unknown) => setStatus(describeLibraryError(error))).finally(() => setBusy(false));
  };
  const hashFile = (index: number, file: File) => perform(async () => {
    const sha256 = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
    onChange(current => current && {
      ...current, form: { ...current.form, sources: current.form.sources.map((item, i) => (i === index ? { ...item, sha256 } : item)) },
    });
    return `Computed the SHA-256 of ${file.name} for source ${index + 1}; the file itself is not stored.`;
  });
  const save = () => {
    if (!result.ok || nameError) return;
    const card = result.card;
    perform(async () => {
      const draft = { name: editing.name, payload: card };
      const stored = editing.itemId && editing.head
        ? await store.saveVersion(editing.itemId, editing.head.sha256, draft)
        : await store.createItem(projectId, "component-card", draft);
      onChange(editingOfCard(stored));
      setCopyName(`${stored.record.name} copy`);
      onSaved();
      if (stored.sha256 === editing.head?.sha256) return "Nothing changed, so no version was saved.";
      return stored.record.version === 1 ? `Created ${stored.record.name}.`
        : `Saved version ${stored.record.version} of ${stored.record.name}. Profiles and measurement sets keep the version they reference.`;
    });
  };
  const copy = () => {
    const source = editing.head;
    if (!source) return;
    perform(async () => {
      const copied = await store.copyItem(source.sha256, copyName);
      onSaved();
      return `Copied ${source.record.name} to ${copied.record.name}; the original is unchanged.`;
    });
  };

  const scalars = CARD_FIELDS[form.type].filter(spec => spec.kind !== "chord" && spec.kind !== "twist");
  const distributions = CARD_FIELDS[form.type].flatMap(spec => (spec.kind === "chord" || spec.kind === "twist" ? [{ spec, kind: spec.kind }] : []));
  const fieldOf = (spec: FieldSpec) => form.fields[spec.key] ?? { known: false, text: "", source: null, rows: [] };
  return (
    <section className="project-section card-editor" aria-labelledby="card-editor-heading">
      <h3 id="card-editor-heading">{editing.itemId ? `Editing ${editing.savedName}` : `New ${typeName(form.type).toLowerCase()} card`}</h3>
      <p className="hint">
        {typeName(form.type)} card{editing.head ? `, version ${editing.head.record.version}` : ""}. Every value names its source;
        a value that is not known is stored as not known, never filled in. Units are SI.
      </p>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="card-name">Card name</label>
          <input id="card-name" type="text" value={editing.name} onChange={event => onChange({ ...editing, name: event.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="card-manufacturer">Manufacturer (optional)</label>
          <input id="card-manufacturer" type="text" value={form.manufacturer} onChange={event => setForm({ ...form, manufacturer: event.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="card-model">Model (optional)</label>
          <input id="card-model" type="text" value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} />
        </div>
      </div>
      <label className="choice">
        <input type="checkbox" checked={form.example} onChange={event => setForm({ ...form, example: event.target.checked })} />
        Illustrative example card, holding no measured data
      </label>

      <h4>Sources</h4>
      <p className="hint">Name each datasheet, measurement or assumption once, then choose it as the source of the values it gives.</p>
      {form.sources.map((source, index) => (
        <SourceFields key={index} source={source} index={index} count={form.sources.length}
          onChange={next => setSource(index, next)} onRemove={() => setForm(removeSource(form, index))} onFile={file => hashFile(index, file)} />
      ))}
      <div className="button-row">
        <button type="button" disabled={form.sources.length >= MAX_SOURCES} onClick={() => setForm(addSource(form))}>Add source</button>
      </div>

      <h4>Values</h4>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Card values">
        <table className="entry-table card-values">
          <thead>
            <tr><th scope="col">Quantity</th><th scope="col">Known</th><th scope="col">Value</th><th scope="col">Source</th></tr>
          </thead>
          <tbody>
            {scalars.map(spec => {
              const field = fieldOf(spec);
              return (
                <tr key={spec.key}>
                  <th scope="row">{spec.label}{spec.required ? ", required" : ""}</th>
                  <td>
                    <input type="checkbox" aria-label={`${spec.label} is known`} checked={field.known} disabled={spec.required && field.known}
                      onChange={event => setForm(setKnown(form, spec.key, event.target.checked))} />
                  </td>
                  <td>
                    <input type="text" inputMode={spec.kind === "text" ? "text" : "decimal"} aria-label={spec.label} disabled={!field.known}
                      placeholder={field.known ? "" : "not known"} value={field.known ? field.text : ""}
                      onChange={event => setField(spec.key, { ...field, text: event.target.value })} />
                  </td>
                  <td><SourceSelect spec={spec} field={field} sources={form.sources} onChange={source => setField(spec.key, { ...field, source })} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {distributions.map(({ spec, kind }) => (
        <DistributionFields key={spec.key} spec={spec} kind={kind} field={fieldOf(spec)} sources={form.sources}
          onChange={field => setField(spec.key, field)} onKnown={known => setForm(setKnown(form, spec.key, known))} />
      ))}
      {distributions.length > 0 && (
        <p className="hint">Stations are r/R, increasing, with at least two rows. The chord is chord over tip radius; the blade angle is to the rotor plane.</p>
      )}
      <div className="field">
        <label htmlFor="card-applicability">Limits of use (optional)</label>
        <input id="card-applicability" type="text" value={form.applicability} onChange={event => setForm({ ...form, applicability: event.target.value })} />
      </div>

      {errors.length > 0 && (
        <ul className="form-errors" aria-label="Problems to fix before saving the card">{errors.map(error => <li key={error}>{error}</li>)}</ul>
      )}
      <div className="button-row">
        <button type="button" className="save-button" disabled={busy || !dirty || errors.length > 0} onClick={save}>Save card</button>
        <button type="button" disabled={busy} onClick={() => {
          onChange(dirty && editing.head ? editingOfCard(editing.head) : null);
          setStatus(dirty ? "The changes were discarded." : "");
        }}>{dirty ? "Discard changes" : "Close the card"}</button>
      </div>
      {editing.head && (
        <form className="inline-form copy-form" onSubmit={event => { event.preventDefault(); copy(); }}>
          <label htmlFor="card-copy-name">Copy as</label>
          <input id="card-copy-name" type="text" value={copyName} onChange={event => setCopyName(event.target.value)} />
          <button type="submit" disabled={busy || copyName.trim() === ""}>Copy card</button>
        </form>
      )}
      <p role="status" className="status-message project-status" data-testid="card-status">{status}</p>

      {form.type === "propeller" && (
        <>
          <h4>BET geometry</h4>
          {preview ? <PropellerPreview preview={preview} /> : <p>The geometry appears once the card is valid.</p>}
        </>
      )}
    </section>
  );
}
