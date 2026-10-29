import {
  DEFAULT_SENSOR_CONFIGURATION, SENSOR_FIELDS, SENSOR_KINDS, type PresetReference, type SensorConfiguration, type SensorFieldPath,
  type SensorFieldSpec, type SensorKind, type SensorMode,
} from '@mirage/aircraft/sensor-fields';
import { applySensorPreset, findSensorPreset } from '@mirage/aircraft/sensor-presets';
import { isDefaultSensorConfiguration, readField, validateSensorConfiguration } from '@mirage/aircraft/sensor-config';
import { parseDecimal } from '../library/library-data';

// The Sensors tab's form (TASK-143, S08): text in display units, turned into a
// sensor configuration only through validateSensorConfiguration. A quantity
// whose text was not edited keeps the SI value it was loaded with, so display
// conversions never re-round and opening and saving reproduces the bytes.
// Locked fields are never parsed; their stored value is always null.

/** One displayed number: its text, and the stored SI value while that text is unedited. */
export interface QuantityField {
  readonly text: string;
  readonly si: number | null;
}
export interface SensorForm {
  readonly mode: SensorMode;
  readonly presets: { readonly [kind in SensorKind]: PresetReference | null };
  /** One quantity per component: one for a scalar, three for a vector or orientation. */
  readonly values: { readonly [path in SensorFieldPath]?: readonly QuantityField[] };
}
export type SensorFormResult = { readonly ok: true; readonly configuration: SensorConfiguration | null } | { readonly ok: false; readonly errors: readonly string[] };

const componentCount = (spec: SensorFieldSpec) => (spec.shape === 'vector3' || spec.shape === 'euler' ? 3 : 1);
/** SI to display: display = (si·siDenominator)/siNumerator, shown with 12 significant digits. */
export function displayText(spec: SensorFieldSpec, si: number): string {
  return String(Number(((si * spec.display.siDenominator) / spec.display.siNumerator).toPrecision(12)));
}
/** Display to SI: si = (display·siNumerator)/siDenominator, so degrees convert as (deg·π)/180. */
export function toSi(spec: SensorFieldSpec, display: number): number {
  return (display * spec.display.siNumerator) / spec.display.siDenominator;
}
export function quantity(spec: SensorFieldSpec, si: number): QuantityField {
  return { text: displayText(spec, si), si };
}
/** A number the user typed; its SI value follows from the text. */
export function editQuantity(text: string): QuantityField {
  return { text, si: null };
}
/** The field's label with its display unit, as the form and its messages name it. */
export function fieldLabel(spec: SensorFieldSpec): string {
  const shown = spec.display.unit || spec.siUnit;
  return shown === '1' ? spec.label : `${spec.label} (${shown})`;
}
export const COMPONENT_NAMES = { vector3: ['X', 'Y', 'Z'], euler: ['roll', 'pitch', 'yaw'] } as const;
export function componentLabel(spec: SensorFieldSpec, index: number): string {
  if (spec.shape === 'vector3' || spec.shape === 'euler') return `${fieldLabel(spec)} ${COMPONENT_NAMES[spec.shape][index] ?? ''}`;
  return fieldLabel(spec);
}

/** The form of a stored configuration; null is the ArduPilot defaults. */
export function formFromSensors(config: SensorConfiguration | null): SensorForm {
  const source = config ?? DEFAULT_SENSOR_CONFIGURATION;
  const values: { [path in SensorFieldPath]?: readonly QuantityField[] } = {};
  for (const spec of SENSOR_FIELDS) {
    const value = readField(source, spec.path);
    values[spec.path] = value === null ? Array.from({ length: componentCount(spec) }, () => editQuantity(''))
      : (typeof value === 'number' ? [value] : value).map(si => quantity(spec, si));
  }
  const presets = { imu: source.imu.preset, gnss: source.gnss.preset, barometer: source.barometer.preset,
    magnetometer: source.magnetometer.preset, battery: source.battery.preset };
  return { mode: source.mode, presets, values };
}

/** Writes a preset's values into the form, keeping the block's other values; returns what was applied and skipped. */
export function applyPresetToForm(form: SensorForm, reference: PresetReference): { form: SensorForm; applied: readonly SensorFieldPath[];
  skipped: readonly { readonly field: SensorFieldPath; readonly reason: string }[] } {
  const application = applySensorPreset(DEFAULT_SENSOR_CONFIGURATION, reference);
  const values = { ...form.values };
  for (const path of application.applied) {
    const spec = SENSOR_FIELDS.find(item => item.path === path);
    const value = readField(application.configuration, path);
    if (spec && typeof value === 'number') values[path] = [quantity(spec, value)];
  }
  // applySensorPreset found the preset, so it names its sensor.
  const kind = findSensorPreset(reference)?.sensor;
  const presets = kind ? { ...form.presets, [kind]: reference } : form.presets;
  return { form: { ...form, values, presets }, applied: application.applied, skipped: application.skipped };
}

function rangeText(spec: SensorFieldSpec): string {
  const low = displayText(spec, spec.minimum), high = displayText(spec, spec.maximum);
  return spec.exclusiveMinimum ? `above ${low} and at most ${high}` : `between ${low} and ${high}`;
}

/** The configuration a form describes (null for the ArduPilot defaults), or every reason it is invalid. */
export function sensorsFromForm(form: SensorForm): SensorFormResult {
  const errors: string[] = [];
  const blocks: Record<string, Record<string, unknown>> = {};
  for (const kind of SENSOR_KINDS) blocks[kind] = { preset: form.presets[kind] };
  for (const spec of SENSOR_FIELDS) {
    const block = blocks[spec.sensor] ?? {};
    const parts = form.values[spec.path] ?? [];
    if (!spec.applicable || parts.every(part => part.si === null && part.text.trim() === '')) {
      block[spec.key] = null;
      continue;
    }
    const values: number[] = [];
    parts.forEach((part, index) => {
      const label = componentLabel(spec, index);
      if (part.si !== null) {
        values.push(part.si);
        return;
      }
      if (part.text.trim() === '') {
        errors.push(`${label} is empty; give all ${parts.length} components or none`);
        return;
      }
      try {
        const typed = toSi(spec, parseDecimal(part.text, label));
        const low = spec.shape === 'euler' && index === 1 ? -Math.PI / 2 : spec.minimum;
        const high = spec.shape === 'euler' && index === 1 ? Math.PI / 2 : spec.maximum;
        // A bound shown with 12 significant digits converts back within this of the bound; it means the bound itself.
        const near = (bound: number) => Math.abs(typed - bound) <= 1e-11 * Math.max(Math.abs(bound), Number.MIN_VALUE);
        const si = near(high) ? high : near(low) ? low : typed;
        const inside = si <= high && (spec.exclusiveMinimum && !(spec.shape === 'euler' && index === 1) ? si > low : si >= low);
        if (!inside) errors.push(`${label} must be ${spec.shape === 'euler' && index === 1 ? 'between -90 and 90' : rangeText(spec)}`);
        else if (spec.shape === 'integer' && !Number.isInteger(si)) errors.push(`${label} must be a whole number of ${spec.siUnit === 'µs' ? 'microseconds' : spec.siUnit}`);
        values.push(si);
      } catch (cause) {
        errors.push(cause instanceof Error ? cause.message : `${label} is not a decimal number`);
      }
    });
    block[spec.key] = spec.shape === 'vector3' || spec.shape === 'euler' ? values : values[0] ?? null;
  }
  if (errors.length > 0) return { ok: false, errors };
  try {
    const configuration = validateSensorConfiguration({ schemaVersion: 1, mode: form.mode, ...blocks });
    return { ok: true, configuration: isDefaultSensorConfiguration(configuration) ? null : configuration };
  } catch (cause) {
    return { ok: false, errors: [cause instanceof Error ? cause.message.replace(/^Invalid sensor configuration: /, '') : String(cause)] };
  }
}
