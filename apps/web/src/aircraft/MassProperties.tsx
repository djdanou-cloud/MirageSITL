import type { MassForm, ProfileForm } from "./profile-form";

// Mass properties of the aircraft editor (TASK-141): the aircraft without
// payload, an optional payload with its own CG and inertia, and the ground
// clearance. Positions are body FRD metres from the reference point.

const INERTIA = [["xx", "Ixx"], ["yy", "Iyy"], ["zz", "Izz"], ["xy", "Ixy"], ["xz", "Ixz"], ["yz", "Iyz"]] as const;

function MassFields({ prefix, title, value, onChange }: { prefix: string; title: string; value: MassForm; onChange: (value: MassForm) => void }) {
  const field = (id: string, label: string, text: string, update: (text: string) => MassForm) => (
    <div className="field" key={id}>
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="decimal" value={text} onChange={event => onChange(update(event.target.value))} />
    </div>
  );
  return (
    <fieldset>
      <legend>{title}</legend>
      <div className="field-grid">
        {field(`${prefix}-mass`, `${title} mass (kg)`, value.massKg, massKg => ({ ...value, massKg }))}
        {(["x", "y", "z"] as const).map((axis, i) => field(`${prefix}-cg-${axis}`, `${title} CG ${axis} (m)`, value.cg[i] ?? "", text => {
          const cg: [string, string, string] = [...value.cg];
          cg[i] = text;
          return { ...value, cg };
        }))}
        {INERTIA.map(([key, symbol]) => field(`${prefix}-inertia-${key}`, `${title} ${symbol} (kg·m²)`, value.inertia[key],
          text => ({ ...value, inertia: { ...value.inertia, [key]: text } })))}
      </div>
    </fieldset>
  );
}

export function MassProperties({ form, onChange }: { form: ProfileForm; onChange: (form: ProfileForm) => void }) {
  return (
    <section className="project-section" aria-labelledby="mass-heading">
      <h3 id="mass-heading">Mass properties</h3>
      <p className="hint">
        The aircraft as flown without payload: airframe, propulsion and battery. CG in body axes (x forward, y right, z down) from the
        reference point; the inertia tensor about the CG, with its off-diagonal entries as they appear in the tensor.
      </p>
      <MassFields prefix="aircraft" title="Aircraft" value={form.mass} onChange={mass => onChange({ ...form, mass })} />
      <div className="field">
        <label className="choice">
          <input type="checkbox" checked={form.payloadEnabled} onChange={event => onChange({ ...form, payloadEnabled: event.target.checked })} /> Payload
        </label>
      </div>
      {form.payloadEnabled && <MassFields prefix="payload" title="Payload" value={form.payload} onChange={payload => onChange({ ...form, payload })} />}
      <div className="field">
        <label htmlFor="ground-clearance">Ground clearance (m, optional)</label>
        <input id="ground-clearance" type="text" inputMode="decimal" value={form.groundClearanceM}
          onChange={event => onChange({ ...form, groundClearanceM: event.target.value })} />
      </div>
    </section>
  );
}
