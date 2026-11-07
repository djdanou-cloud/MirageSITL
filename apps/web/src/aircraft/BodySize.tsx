import { useMemo } from "react";
import type { AircraftProfile } from "@mirage/aircraft/profile";
import { standardHull } from "@mirage/aircraft/standard-hull";
import { bodyFormFromHull, emptyBodyPart, maxBodyParts, type BodyForm, type BodyPartForm, type ProfileForm } from "./profile-form";

// Body and arm size of the aircraft editor (TASK-196): the central body, the arm thickness and parts fixed to the body
// such as a camera or a cargo box, which the flight physics uses as contact shapes, the propeller clearance check as
// the body, the drag estimate as the airframe, and both 3D views draw. Without them the aircraft flies the standard
// hull worked out from its arms and propellers. Depths are below the reference point; x is forward and y right.

type PartField = Exclude<keyof BodyPartForm, "name">;
const PART_FIELDS: readonly [PartField, string][] = [
  ["xM", "x, forward (m)"], ["yM", "y, right (m)"], ["bottomDepthM", "Bottom below the reference point (m)"],
  ["diameterM", "Diameter (m)"], ["heightM", "Height (m)"],
];

export function BodySize({ form, profile, radii, onChange }: {
  form: ProfileForm; profile: AircraftProfile | null; radii: ReadonlyMap<number, number> | null; onChange: (form: ProfileForm) => void;
}) {
  // The standard hull the profile flies without a described body; it needs every motor's propeller radius.
  const standard = useMemo(() => {
    if (!profile || !radii) return null;
    try {
      return standardHull(profile, motorId => radii.get(motorId) ?? Number.NaN);
    } catch {
      return null;
    }
  }, [profile, radii]);
  const empty = [form.body.diameterM, form.body.heightM, form.body.bottomDepthM, form.body.armDiameterM].every(text => text.trim() === "");
  const describe = (bodyStated: boolean) => {
    // Describing the body for the first time starts from the standard hull, for the user to replace.
    const body = bodyStated && empty && standard ? bodyFormFromHull(standard) : form.body;
    onChange({ ...form, bodyStated, body });
  };
  const setBody = (body: BodyForm) => onChange({ ...form, body });
  const setPart = (index: number, part: BodyPartForm) => setBody({ ...form.body, parts: form.body.parts.map((item, i) => (i === index ? part : item)) });
  const limit = maxBodyParts(form.arms.length);
  const field = (id: string, label: string, text: string, update: (text: string) => void) => (
    <div className="field" key={id}>
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="decimal" value={text} onChange={event => update(event.target.value)} />
    </div>
  );
  return (
    <section className="project-section" aria-labelledby="body-heading">
      <h3 id="body-heading">Body and arms</h3>
      <p className="hint">
        The body, the arm thickness and parts under or beside the body, such as a camera or a cargo box. The flight physics uses
        them as the airframe's contact shapes, so a part that touches the ground is reported as a body contact; the propeller
        clearance check and the drag estimate use them too. Without them the aircraft flies a standard frame shape worked out
        from its arms and propellers. Mass properties are entered separately and do not follow from these sizes.
      </p>
      <div className="field">
        <label className="choice">
          <input type="checkbox" checked={form.bodyStated} onChange={event => describe(event.target.checked)} /> Describe the body and arms
        </label>
      </div>
      {form.bodyStated && (
        <>
          <fieldset>
            <legend>Body</legend>
            <p className="hint">A cylinder about the vertical axis through the reference point.</p>
            <div className="field-grid">
              {field("body-diameter", "Body diameter (m)", form.body.diameterM, diameterM => setBody({ ...form.body, diameterM }))}
              {field("body-height", "Body height (m)", form.body.heightM, heightM => setBody({ ...form.body, heightM }))}
              {field("body-bottom", "Body bottom below the reference point (m)", form.body.bottomDepthM, bottomDepthM => setBody({ ...form.body, bottomDepthM }))}
              {field("arm-thickness", "Arm thickness (m)", form.body.armDiameterM, armDiameterM => setBody({ ...form.body, armDiameterM }))}
            </div>
          </fieldset>
          {form.body.parts.map((part, index) => (
            <fieldset key={index}>
              <legend>Body part {index + 1}{part.name.trim() === "" ? "" : `: ${part.name.trim()}`}</legend>
              <p className="hint">A vertical cylinder fixed to the body.</p>
              <div className="field-grid">
                {field(`part-${index}-name`, "Name", part.name, name => setPart(index, { ...part, name }))}
                {PART_FIELDS.map(([key, label]) => field(`part-${index}-${key}`, label, part[key], text => setPart(index, { ...part, [key]: text })))}
              </div>
              <div className="button-row">
                <button type="button" onClick={() => setBody({ ...form.body, parts: form.body.parts.filter((_, i) => i !== index) })}>
                  Remove body part {index + 1}
                </button>
              </div>
            </fieldset>
          ))}
          <div className="button-row">
            <button type="button" disabled={form.body.parts.length >= limit}
              onClick={() => setBody({ ...form.body, parts: [...form.body.parts, emptyBodyPart()] })}>Add a body part</button>
          </div>
          {form.body.parts.length >= limit && <p className="hint">The body, the arms and the parts can make at most 16 shapes.</p>}
        </>
      )}
    </section>
  );
}
