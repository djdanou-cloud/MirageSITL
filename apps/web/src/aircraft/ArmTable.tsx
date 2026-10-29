import { useState } from "react";
import type { SpinDirection } from "@mirage/aircraft/profile";
import {
  MAX_ARMS, applyEvenLayout, editAngle, emptyMotor, evenLayout, type AngleField, type ArmForm, type EvenLayoutText, type MotorForm, type ProfileForm,
} from "./profile-form";

// Arms and motors of the aircraft editor (TASK-141): a layout helper that
// replaces the arms with an even layout, and one group per arm with its
// geometry and its single motor or coaxial pair. Angles are in degrees.

export interface CardOption {
  readonly sha256: string;
  readonly name: string;
}
export interface CardOptions {
  readonly motor: readonly CardOption[];
  readonly propeller: readonly CardOption[];
  readonly esc: readonly CardOption[];
}

function TextField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="decimal" value={value} onChange={event => onChange(event.target.value)} />
    </div>
  );
}
function CardSelect({ id, label, value, options, onChange }: {
  id: string; label: string; value: string | null; options: readonly CardOption[]; onChange: (value: string | null) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ""} onChange={event => onChange(event.target.value === "" ? null : event.target.value)}>
        <option value="">None selected</option>
        {options.map(option => <option key={option.sha256} value={option.sha256}>{option.name}</option>)}
      </select>
    </div>
  );
}

function MotorFields({ prefix, title, motor, cards, onChange }: {
  prefix: string; title: string; motor: MotorForm; cards: CardOptions; onChange: (motor: MotorForm) => void;
}) {
  const set = (change: Partial<MotorForm>) => onChange({ ...motor, ...change });
  return (
    <fieldset className="motor-fields">
      <legend>{title}</legend>
      <div className="field-grid">
        <TextField id={`${prefix}-id`} label="Motor number" value={motor.id} onChange={id => set({ id })} />
        <TextField id={`${prefix}-output`} label="ArduPilot output" value={motor.output} onChange={output => set({ output })} />
        <div className="field">
          <label htmlFor={`${prefix}-spin`}>Spin</label>
          <select id={`${prefix}-spin`} value={motor.spin} onChange={event => set({ spin: event.target.value === "cw" ? "cw" : "ccw" })}>
            <option value="ccw">Counter-clockwise</option>
            <option value="cw">Clockwise</option>
          </select>
        </div>
        <CardSelect id={`${prefix}-motor-card`} label="Motor card" value={motor.motor} options={cards.motor} onChange={value => set({ motor: value })} />
        <CardSelect id={`${prefix}-propeller-card`} label="Propeller card" value={motor.propeller} options={cards.propeller} onChange={value => set({ propeller: value })} />
        <CardSelect id={`${prefix}-esc-card`} label="ESC card" value={motor.esc} options={cards.esc} onChange={value => set({ esc: value })} />
      </div>
    </fieldset>
  );
}

function ArmFields({ index, arm, cards, onChange, onRemove }: {
  index: number; arm: ArmForm; cards: CardOptions; onChange: (arm: ArmForm) => void; onRemove: () => void;
}) {
  const id = index + 1, prefix = `arm-${id}`;
  const set = (change: Partial<ArmForm>) => onChange({ ...arm, ...change });
  const angle = (key: "azimuth" | "outwardTilt" | "sideTilt", label: string, field: AngleField) => {
    const update = (text: string): Partial<ArmForm> =>
      key === "azimuth" ? { azimuth: editAngle(text) } : key === "outwardTilt" ? { outwardTilt: editAngle(text) } : { sideTilt: editAngle(text) };
    return <TextField id={`${prefix}-${key}`} label={label} value={field.text} onChange={text => set(update(text))} />;
  };
  return (
    <fieldset className="arm-fields">
      <legend>Arm {id}</legend>
      <div className="field-grid">
        <TextField id={`${prefix}-length`} label="Length (m)" value={arm.lengthM} onChange={lengthM => set({ lengthM })} />
        {angle("azimuth", "Azimuth (°)", arm.azimuth)}
        <TextField id={`${prefix}-height`} label="Height (m)" value={arm.heightM} onChange={heightM => set({ heightM })} />
        {angle("outwardTilt", "Outward tilt (°)", arm.outwardTilt)}
        {angle("sideTilt", "Side tilt (°)", arm.sideTilt)}
        <div className="field">
          <label className="choice">
            <input type="checkbox" checked={arm.coaxial} onChange={event => set({ coaxial: event.target.checked })} /> Coaxial pair
          </label>
        </div>
        {arm.coaxial && <TextField id={`${prefix}-separation`} label="Pair separation (m)" value={arm.pairSeparationM} onChange={pairSeparationM => set({ pairSeparationM })} />}
      </div>
      <MotorFields prefix={`${prefix}-upper`} title={arm.coaxial ? `Arm ${id} upper motor` : `Arm ${id} motor`} motor={arm.upper} cards={cards}
        onChange={upper => set({ upper })} />
      {arm.coaxial && <MotorFields prefix={`${prefix}-lower`} title={`Arm ${id} lower motor`} motor={arm.lower} cards={cards} onChange={lower => set({ lower })} />}
      <div className="button-row">
        <button type="button" onClick={onRemove}>Remove arm {id}</button>
      </div>
    </fieldset>
  );
}

export function ArmTable({ form, cards, onChange }: { form: ProfileForm; cards: CardOptions; onChange: (form: ProfileForm) => void }) {
  const [helper, setHelper] = useState<EvenLayoutText>({ count: "4", lengthM: "", firstAzimuthDeg: "45", coaxial: false, pairSeparationM: "" });
  const [helperErrors, setHelperErrors] = useState<readonly string[]>([]);
  const setArm = (index: number, arm: ArmForm) => onChange({ ...form, arms: form.arms.map((item, i) => (i === index ? arm : item)) });
  const layout = () => {
    const result = evenLayout(helper);
    setHelperErrors(result.ok ? [] : result.errors);
    if (result.ok) onChange(applyEvenLayout(form, result.arms));
  };
  const addArm = () => {
    const used = new Set(form.arms.flatMap(arm => (arm.coaxial ? [arm.upper.id, arm.lower.id] : [arm.upper.id])));
    let next = 1;
    while (used.has(String(next))) next++;
    const spin: SpinDirection = form.arms.length % 2 === 0 ? "ccw" : "cw";
    onChange({
      ...form,
      arms: [...form.arms, {
        lengthM: "", azimuth: editAngle(""), heightM: "0", outwardTilt: editAngle("0"), sideTilt: editAngle("0"), coaxial: false, pairSeparationM: "",
        upper: { ...emptyMotor(spin), id: String(next), output: String(next) }, lower: emptyMotor(spin === "ccw" ? "cw" : "ccw"),
      }],
    });
  };
  return (
    <section className="project-section arm-table" aria-labelledby="arms-heading">
      <h3 id="arms-heading">Arms and motors</h3>
      <fieldset>
        <legend>Even layout</legend>
        <p className="hint">Replaces every arm with arms spaced evenly from the first azimuth, numbered and wired in arm order, with alternating spins.</p>
        <div className="field-grid">
          <TextField id="layout-count" label="Number of arms" value={helper.count} onChange={count => setHelper({ ...helper, count })} />
          <TextField id="layout-length" label="Arm length (m)" value={helper.lengthM} onChange={lengthM => setHelper({ ...helper, lengthM })} />
          <TextField id="layout-azimuth" label="First arm azimuth (°)" value={helper.firstAzimuthDeg}
            onChange={firstAzimuthDeg => setHelper({ ...helper, firstAzimuthDeg })} />
          <div className="field">
            <label className="choice">
              <input type="checkbox" checked={helper.coaxial} onChange={event => setHelper({ ...helper, coaxial: event.target.checked })} /> Coaxial pairs
            </label>
          </div>
          {helper.coaxial && (
            <TextField id="layout-separation" label="Layout pair separation (m)" value={helper.pairSeparationM}
              onChange={pairSeparationM => setHelper({ ...helper, pairSeparationM })} />
          )}
        </div>
        <div className="button-row">
          <button type="button" onClick={layout}>Lay out arms</button>
        </div>
        {helperErrors.length > 0 && <ul className="form-errors" aria-label="Layout errors">{helperErrors.map(error => <li key={error}>{error}</li>)}</ul>}
      </fieldset>
      <p className="hint">Azimuth runs clockwise from forward, seen from above. Outward tilt leans the thrust axis away from the body; side tilt leans it towards increasing azimuth.</p>
      {form.arms.map((arm, index) => (
        <ArmFields key={index} index={index} arm={arm} cards={cards} onChange={next => setArm(index, next)}
          onRemove={() => onChange({ ...form, arms: form.arms.filter((_, i) => i !== index) })} />
      ))}
      <div className="button-row">
        <button type="button" disabled={form.arms.length >= MAX_ARMS} onClick={addArm}>Add arm</button>
      </div>
      {form.arms.length >= MAX_ARMS && <p className="hint">An aircraft has at most {MAX_ARMS} arms.</p>}
    </section>
  );
}
