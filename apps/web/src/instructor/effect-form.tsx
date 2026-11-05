import type { EffectField, EffectParameterValue } from "@mirage/protocol";

// One field of an effect's form, read from the protocol's catalog (TASK-166), so a range shown is the range the protocol enforces. The
// instructor console and the Faults and interference tab (TASK-169) draw the same form.

/** The range the protocol enforces, as a person reads it. */
export function rangeText(field: EffectField): string {
  const unit = field.unit === "1" || field.unit === "" ? "" : ` ${field.unit}`;
  switch (field.kind) {
    case "enum": return "";
    case "integer": return `${field.min} to ${field.max}${unit}`;
    case "number": return `${field.exclusiveMin ? "above " : ""}${field.min} ${field.exclusiveMax ? "to below" : "to"} ${field.max}${unit}`;
    case "vector3": return `${field.min.toFixed(2).replace(/\.00$/, "")} to ${field.max.toFixed(2).replace(/\.00$/, "")}${unit} per axis${field.normMax === undefined ? "" : `, length up to ${field.normMax}${unit}`}`;
    default: { const never: never = field; return String(never); }
  }
}
export const fieldLabel = (field: EffectField) => (field.unit === "1" || field.unit === "" ? field.label : `${field.label}, ${field.unit}`);
export const numberText = (value: number) => (Number.isNaN(value) ? "" : value);

export function EffectFieldInput({ field, value, onChange }: { field: EffectField; value: EffectParameterValue | undefined; onChange: (next: EffectParameterValue) => void }) {
  const range = rangeText(field);
  switch (field.kind) {
    case "enum":
      return (
        <label>
          {field.label}
          <select aria-label={field.label} value={typeof value === "string" ? value : field.initial} onChange={(e) => onChange(e.target.value)}>
            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      );
    case "number":
    case "integer":
      return (
        <label>
          {fieldLabel(field)}
          <input aria-label={field.label} type="number" min={field.min} max={field.max} step={field.kind === "integer" ? 1 : "any"}
            value={numberText(typeof value === "number" ? value : field.initial)} onChange={(e) => onChange(e.target.valueAsNumber)} />
          <small>{range}</small>
        </label>
      );
    case "vector3": {
      const vector = typeof value === "object" ? value : field.initial;
      return (
        <fieldset className="console-vector">
          <legend>{fieldLabel(field)}</legend>
          {field.axes.map((axis, index) => (
            <label key={axis}>
              {axis}
              <input aria-label={`${field.label} ${axis}`} type="number" min={field.min} max={field.max} step="any" value={numberText(vector[index] ?? 0)}
                onChange={(e) => {
                  const next: [number, number, number] = [vector[0], vector[1], vector[2]];
                  next[index] = e.target.valueAsNumber;
                  onChange(next);
                }} />
            </label>
          ))}
          <small>{range}</small>
        </fieldset>
      );
    }
    default: { const never: never = field; return <>{String(never)}</>; }
  }
}
