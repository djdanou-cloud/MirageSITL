import { emptyBody, emptyBodyPart, type BodyForm, type BodyPartForm, type ProfileForm } from "./profile-form";

// Body size of the aircraft editor (TASK-196): the central body, the arm thickness and named parts such as a camera pod, in
// place of the standard hull that TASK-095 works out from the arms and propellers. All in body axes from the reference point
// (x forward, y right, z down). The body is a cylinder about the body z axis; a part is a vertical cylinder or a capsule, and a
// box is entered as the cylinder or capsule that encloses it. These shapes are what touches the ground, and an accident names
// the part that struck.

const MAX_PARTS = 14;
const AXES = [[0, "x"], [1, "y"], [2, "z"]] as const;
type Vector = readonly [string, string, string];
const setAxis = (vector: Vector, axis: 0 | 1 | 2, text: string): Vector => {
  const next: [string, string, string] = [vector[0], vector[1], vector[2]];
  next[axis] = text;
  return next;
};

function VectorFields({ id, label, value, onChange }: { id: string; label: string; value: Vector; onChange: (value: Vector) => void }) {
  return (
    <>
      {AXES.map(([axis, name]) => (
        <div className="field" key={name}>
          <label htmlFor={`${id}-${name}`}>{label} {name} (m)</label>
          <input id={`${id}-${name}`} type="text" inputMode="decimal" value={value[axis]} onChange={event => onChange(setAxis(value, axis, event.target.value))} />
        </div>
      ))}
    </>
  );
}

function PartFields({ index, part, onChange, onRemove }: { index: number; part: BodyPartForm; onChange: (part: BodyPartForm) => void; onRemove: () => void }) {
  const id = `body-part-${index + 1}`, label = `Body part ${index + 1}`;
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="field-grid">
        <div className="field">
          <label htmlFor={`${id}-name`}>{label} name</label>
          <input id={`${id}-name`} type="text" value={part.name} onChange={event => onChange({ ...part, name: event.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-shape`}>{label} shape</label>
          <select id={`${id}-shape`} value={part.shape} onChange={event => onChange({ ...part, shape: event.target.value === "capsule" ? "capsule" : "cylinder" })}>
            <option value="cylinder">Cylinder (vertical)</option>
            <option value="capsule">Capsule</option>
          </select>
        </div>
        {part.shape === "cylinder" ? (
          <>
            <VectorFields id={`${id}-centre`} label={`${label} centre`} value={part.center} onChange={center => onChange({ ...part, center })} />
            <div className="field">
              <label htmlFor={`${id}-half-height`}>{label} half-height (m)</label>
              <input id={`${id}-half-height`} type="text" inputMode="decimal" value={part.halfHeightM} onChange={event => onChange({ ...part, halfHeightM: event.target.value })} />
            </div>
          </>
        ) : (
          <>
            <VectorFields id={`${id}-start`} label={`${label} start`} value={part.start} onChange={start => onChange({ ...part, start })} />
            <VectorFields id={`${id}-end`} label={`${label} end`} value={part.end} onChange={end => onChange({ ...part, end })} />
          </>
        )}
        <div className="field">
          <label htmlFor={`${id}-radius`}>{label} radius (m)</label>
          <input id={`${id}-radius`} type="text" inputMode="decimal" value={part.radiusM} onChange={event => onChange({ ...part, radiusM: event.target.value })} />
        </div>
      </div>
      <div className="button-row"><button type="button" onClick={onRemove}>Remove {label.toLowerCase()}</button></div>
    </fieldset>
  );
}

export function BodySize({ form, onChange }: { form: ProfileForm; onChange: (form: ProfileForm) => void }) {
  const body = form.body;
  const setBody = (next: BodyForm) => onChange({ ...form, body: next });
  const field = (id: string, label: string, value: string, update: (text: string) => BodyForm) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="decimal" value={value} onChange={event => setBody(update(event.target.value))} />
    </div>
  );
  return (
    <section className="project-section" aria-labelledby="body-heading">
      <h3 id="body-heading">Body size</h3>
      <p className="hint">
        Without a described body the aircraft has the standard frame shape: a body cylinder sized from the shortest arm and arms sized from
        their propellers, synthetic and not measured. A described body replaces it in contact with the ground, the propeller clearance
        check and the drag estimate.
      </p>
      <div className="field">
        <label className="choice">
          <input type="checkbox" checked={form.bodyDescribed} onChange={event => onChange({ ...form, bodyDescribed: event.target.checked })} /> Describe the body
        </label>
      </div>
      {form.bodyDescribed && (
        <>
          <fieldset>
            <legend>Central body</legend>
            <p className="hint">A cylinder about the body z axis. Positions are in body axes from the reference point: x forward, y right, z down.</p>
            <div className="field-grid">
              {field("body-radius", "Body radius (m)", body.radiusM, radiusM => ({ ...body, radiusM }))}
              {field("body-half-height", "Body half-height (m)", body.halfHeightM, halfHeightM => ({ ...body, halfHeightM }))}
              {field("body-centre-down", "Body centre below the reference point (m)", body.centerDownM, centerDownM => ({ ...body, centerDownM }))}
              {field("arm-radius", "Arm thickness radius (m, optional)", body.armRadiusM, armRadiusM => ({ ...body, armRadiusM }))}
            </div>
          </fieldset>
          {body.parts.map((part, index) => (
            <PartFields key={index} index={index} part={part}
              onChange={next => setBody({ ...body, parts: body.parts.map((item, i) => (i === index ? next : item)) })}
              onRemove={() => setBody({ ...body, parts: body.parts.filter((_, i) => i !== index) })} />
          ))}
          <p className="hint">Parts hang below or beside the body, such as a camera pod or a cargo box; enter a box as the cylinder or capsule that encloses it.</p>
          <div className="button-row">
            <button type="button" disabled={body.parts.length >= MAX_PARTS}
              onClick={() => setBody({ ...body, parts: [...body.parts, { ...emptyBodyPart(), name: body.parts.length === 0 ? "Camera pod" : `Part ${body.parts.length + 1}` }] })}>
              Add body part
            </button>
            <button type="button" onClick={() => setBody({ ...emptyBody(), source: body.source })}>Reset the body</button>
          </div>
          <div className="field">
            <label htmlFor="body-source">Where the body dimensions come from</label>
            <input id="body-source" type="text" value={body.source} onChange={event => setBody({ ...body, source: event.target.value })} />
          </div>
        </>
      )}
    </section>
  );
}
