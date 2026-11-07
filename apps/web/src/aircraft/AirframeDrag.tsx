import { useMemo } from "react";
import type { AircraftProfile } from "@mirage/aircraft/profile";
import { standardHull } from "@mirage/aircraft/standard-hull";
import { standardHullDrag } from "@mirage/aircraft/standard-hull-drag";
import { dragFormFromEstimate, type DragForm, type ProfileForm } from "./profile-form";

// Body drag of the aircraft editor (TASK-096): the drag of the airframe without its propellers, whose own drag the rotor
// model computes. Without stated values the aircraft flies the standard hull's preliminary estimate; stated values need
// their source. Areas are C_D·A in m² along body x (forward), y (right) and z (down); the center of pressure is in body
// axes from the reference point.

const AXES = ["x", "y", "z"] as const;
const shown = (value: number) => String(Number(value.toPrecision(4)));

export function AirframeDrag({ form, profile, radii, onChange }: {
  form: ProfileForm; profile: AircraftProfile | null; radii: ReadonlyMap<number, number> | null; onChange: (form: ProfileForm) => void;
}) {
  // The estimate needs every motor's propeller radius: the standard hull's arm thickness follows it.
  const estimate = useMemo(() => {
    if (!profile || !radii) return null;
    try {
      return standardHullDrag(standardHull(profile, motorId => radii.get(motorId) ?? Number.NaN));
    } catch {
      return null;
    }
  }, [profile, radii]);
  const empty = [...form.drag.areas, ...form.drag.cop, form.drag.maxAirspeedMps].every(text => text.trim() === "");
  const state = (dragStated: boolean) => {
    // Stating the drag for the first time starts from the estimate, for the user to replace.
    const drag = dragStated && empty && estimate ? dragFormFromEstimate(estimate) : form.drag;
    onChange({ ...form, dragStated, drag });
  };
  const setDrag = (drag: DragForm) => onChange({ ...form, drag });
  const field = (id: string, label: string, text: string, update: (text: string) => DragForm) => (
    <div className="field" key={id}>
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="decimal" value={text} onChange={event => setDrag(update(event.target.value))} />
    </div>
  );
  return (
    <section className="project-section" aria-labelledby="drag-heading">
      <h3 id="drag-heading">Body drag</h3>
      <p className="hint">
        The drag of the airframe without its propellers, whose own drag the rotor model computes. Without stated values the
        aircraft flies a preliminary estimate from its standard frame shape, a body cylinder and one capsule per arm, labeled
        preliminary and not measured.
      </p>
      {estimate ? (
        <p data-testid="drag-estimate">
          Preliminary estimate: drag areas {AXES.map((axis, i) => `${axis} ${shown(estimate.dragAreaBodyM2[4 * i] ?? 0)}`).join(", ")} m²;
          center of pressure ({estimate.centerOfPressureBodyM.map(shown).join(", ")}) m; valid up to {shown(estimate.maxAirspeedMps)} m/s.
        </p>
      ) : <p data-testid="drag-estimate">The estimate appears once the profile is valid and every motor has a propeller card.</p>}
      <div className="field">
        <label className="choice">
          <input type="checkbox" checked={form.dragStated} onChange={event => state(event.target.checked)} /> State the drag areas
        </label>
      </div>
      {form.dragStated && (
        <fieldset>
          <legend>Stated drag</legend>
          <div className="field-grid">
            {AXES.map((axis, i) => field(`drag-area-${axis}`, `Drag area ${axis} (m²)`, form.drag.areas[i] ?? "", text => {
              const areas: [string, string, string] = [...form.drag.areas];
              areas[i] = text;
              return { ...form.drag, areas };
            }))}
            {AXES.map((axis, i) => field(`drag-cop-${axis}`, `Center of pressure ${axis} (m)`, form.drag.cop[i] ?? "", text => {
              const cop: [string, string, string] = [...form.drag.cop];
              cop[i] = text;
              return { ...form.drag, cop };
            }))}
            {field("drag-airspeed", "Valid up to (m/s)", form.drag.maxAirspeedMps, maxAirspeedMps => ({ ...form.drag, maxAirspeedMps }))}
          </div>
          <div className="field">
            <label htmlFor="drag-source">Where the values come from</label>
            <input id="drag-source" type="text" value={form.drag.source} onChange={event => setDrag({ ...form.drag, source: event.target.value })} />
          </div>
        </fieldset>
      )}
    </section>
  );
}
