import { Ajv } from 'ajv';
import file from './sensor-presets.json';
import {
  SENSOR_FIELDS, SENSOR_KINDS, type PresetReference, type SensorConfiguration, type SensorFieldPath, type SensorFieldSpec, type SensorKind,
} from './sensor-fields.ts';

// Sensor presets (TASK-143, stakeholder decision of 2026-10-29): per-sensor
// datasheet values from the corrected ArduPilot sensor catalog
// (docs/hardware/ardupilot-sensors.md), each citing its primary source. The
// preset file is append-only: a released catalog version never changes, so a
// stored preset reference keeps its meaning. A preset fills only fields whose
// value is the same statistic as the datasheet value; tolerances, maxima and
// rates are shown as references and never filled. Configuration-time only.

export type PresetStatistic = 'typical-density' | 'rms' | 'cep50' | 'quantization-step';
export type PresetConversion = 'identity' | 'mdps-to-rad' | 'ug-to-mps2' | 'nt-to-gauss' | 'cep50-to-axis-sigma' | 'step-to-rms';
export interface PresetCitation {
  readonly id: string;
  readonly kind: 'specification' | 'ardupilot-source';
  readonly title: string;
  readonly publisher: string;
  readonly documentNumber: string | null;
  readonly revision: string | null;
  readonly url: string | null;
}
export interface PresetValue {
  readonly field: SensorFieldPath;
  /** SI, exactly as it is stored. */
  readonly value: number;
  readonly datasheet: { readonly value: number; readonly unit: string; readonly statistic: PresetStatistic; readonly conditions: string };
  readonly conversion: PresetConversion;
  readonly citation: string;
  readonly locator: string;
}
/** Shown, never written: a tolerance, maximum or rate that is not the field's statistic. */
export interface PresetReferenceNote {
  readonly field: SensorFieldPath;
  readonly text: string;
  readonly citation: string;
  readonly locator: string;
  readonly reasonNotFilled: string;
}
export interface SensorPreset {
  readonly id: string;
  readonly sensor: SensorKind;
  readonly manufacturer: string;
  readonly part: string;
  readonly values: readonly PresetValue[];
  readonly references: readonly PresetReferenceNote[];
}
export interface SensorPresetCatalog {
  readonly catalogVersion: number;
  /** The catalog document the presets were taken from, and its SHA-256 at release. */
  readonly basis: { readonly path: 'docs/hardware/ardupilot-sensors.md'; readonly sha256: string };
  readonly citations: readonly PresetCitation[];
  readonly presets: readonly SensorPreset[];
}

/** The closed set of conversions from datasheet units to SI; degrees convert as (x·π)/180, as everywhere in the UI. */
export const PRESET_CONVERSIONS: { readonly [c in PresetConversion]: (value: number) => number } = {
  'identity': value => value,
  'mdps-to-rad': value => (value * Math.PI) / 180000,
  'ug-to-mps2': value => (value * 9.80665) / 1e6,
  'nt-to-gauss': value => value / 1e5,
  // CEP50 of a circular Gaussian is σ·√(2 ln 2).
  'cep50-to-axis-sigma': value => value / Math.sqrt(2 * Math.log(2)),
  // A uniform quantization error of one step has RMS step/√12.
  'step-to-rms': value => value / Math.sqrt(12),
};
/**
 * What each conversion takes and gives: the datasheet unit (or the field's own
 * SI unit), the SI unit it produces, and the statistics it may carry. A CEP50
 * value must be converted to 1σ and a quantization step to RMS; a density or an
 * RMS value only changes unit.
 */
const CONVERSION_RULES: { readonly [c in PresetConversion]: { /** null: the field's own SI unit. */ readonly from: string | null; readonly to: string | null; readonly statistics: readonly PresetStatistic[] } } = {
  'identity': { from: null, to: null, statistics: ['typical-density', 'rms'] },
  'mdps-to-rad': { from: 'mdps/√Hz', to: 'rad/s/√Hz', statistics: ['typical-density'] },
  'ug-to-mps2': { from: 'µg/√Hz', to: 'm/s²/√Hz', statistics: ['typical-density'] },
  'nt-to-gauss': { from: 'nT', to: 'G', statistics: ['rms'] },
  'cep50-to-axis-sigma': { from: null, to: null, statistics: ['cep50'] },
  'step-to-rms': { from: null, to: null, statistics: ['quantization-step'] },
};
/** Statistics a field's kind of value accepts: a density field takes a density, a 1σ field an RMS-convertible statistic. */
const STATISTICS_BY_UNIT = (spec: SensorFieldSpec): readonly PresetStatistic[] =>
  spec.siUnit.endsWith('/√Hz') ? ['typical-density'] : ['rms', 'cep50', 'quantization-step'];

const text = { type: 'string', minLength: 1, maxLength: 512 };
const nullableText = { type: ['string', 'null'], minLength: 1, maxLength: 512 };
const fieldPath = { enum: SENSOR_FIELDS.map(spec => spec.path) };
const fileSchema = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'catalogs'],
  properties: {
    schemaVersion: { const: 1 },
    catalogs: { type: 'array', minItems: 1, maxItems: 1000, items: {
      type: 'object', additionalProperties: false, required: ['catalogVersion', 'basis', 'citations', 'presets'],
      properties: {
        catalogVersion: { type: 'integer', minimum: 1, maximum: 1000 },
        basis: { type: 'object', additionalProperties: false, required: ['path', 'sha256'],
          properties: { path: { const: 'docs/hardware/ardupilot-sensors.md' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
        citations: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: false,
          required: ['id', 'kind', 'title', 'publisher', 'documentNumber', 'revision', 'url'],
          properties: { id: { type: 'string', pattern: '^[A-Z][0-9]{1,3}$' }, kind: { enum: ['specification', 'ardupilot-source'] },
            title: text, publisher: text, documentNumber: nullableText, revision: nullableText, url: nullableText } } },
        presets: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: false,
          required: ['id', 'sensor', 'manufacturer', 'part', 'values', 'references'],
          properties: {
            id: { type: 'string', pattern: '^(imu|gnss|baro|mag|battery)-[a-z0-9-]{1,48}$' }, sensor: { enum: [...SENSOR_KINDS] },
            manufacturer: text, part: text,
            values: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false,
              required: ['field', 'value', 'datasheet', 'conversion', 'citation', 'locator'],
              properties: { field: fieldPath, value: { type: 'number' },
                datasheet: { type: 'object', additionalProperties: false, required: ['value', 'unit', 'statistic', 'conditions'],
                  properties: { value: { type: 'number' }, unit: text, statistic: { enum: ['typical-density', 'rms', 'cep50', 'quantization-step'] }, conditions: text } },
                conversion: { enum: Object.keys(PRESET_CONVERSIONS) }, citation: text, locator: text } } },
            references: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false,
              required: ['field', 'text', 'citation', 'locator', 'reasonNotFilled'],
              properties: { field: fieldPath, text, citation: text, locator: text, reasonNotFilled: text } } },
          } } },
      } } },
  },
} as const;
interface PresetFile { readonly schemaVersion: 1; readonly catalogs: readonly SensorPresetCatalog[] }
const validateFile = new Ajv({ strict: true, strictNumbers: true, allowUnionTypes: true }).compile<PresetFile>(fileSchema);

const SENSOR_PREFIX: { readonly [k in SensorKind]: string } = { imu: 'imu', gnss: 'gnss', barometer: 'baro', magnetometer: 'mag', battery: 'battery' };
function fail(message: string): never {
  throw new Error(`Invalid sensor preset file: ${message}`);
}
function fieldSpec(path: SensorFieldPath): SensorFieldSpec {
  const spec = SENSOR_FIELDS.find(item => item.path === path);
  if (!spec) return fail(`unknown field ${path}`);
  return spec;
}
function inRange(spec: SensorFieldSpec, value: number): boolean {
  return value >= spec.minimum && value <= spec.maximum && (!spec.exclusiveMinimum || value > spec.minimum);
}

/** Schema and code checks of a preset file; returns a deep-frozen copy. */
export function parseSensorPresetFile(input: unknown): readonly SensorPresetCatalog[] {
  const value: unknown = structuredClone(input);
  if (!validateFile(value)) {
    const error = validateFile.errors?.[0];
    return fail(`${error?.instancePath || '/'} ${error?.message ?? 'does not match the schema'}`);
  }
  value.catalogs.forEach((catalog, index) => {
    if (catalog.catalogVersion !== index + 1) fail(`catalog ${index + 1} has version ${catalog.catalogVersion}; versions are 1, 2, … in order`);
    const citations = new Set<string>();
    for (const citation of catalog.citations) {
      if (citations.has(citation.id)) fail(`catalog ${catalog.catalogVersion} repeats citation ${citation.id}`);
      citations.add(citation.id);
    }
    const ids = new Set<string>();
    for (const preset of catalog.presets) {
      const label = `preset ${preset.id} of catalog ${catalog.catalogVersion}`;
      if (ids.has(preset.id)) fail(`${label} is repeated`);
      ids.add(preset.id);
      if (!preset.id.startsWith(`${SENSOR_PREFIX[preset.sensor]}-`)) fail(`${label} is not named for its sensor ${preset.sensor}`);
      const filled = new Set<string>();
      for (const item of preset.values) {
        const spec = fieldSpec(item.field);
        if (spec.sensor !== preset.sensor) fail(`${label} sets ${item.field} of another sensor`);
        if (filled.has(item.field)) fail(`${label} sets ${item.field} twice`);
        filled.add(item.field);
        if (spec.applicable && !spec.presettable) fail(`${label} sets ${item.field}, which presets do not fill`);
        if (spec.shape !== 'scalar') fail(`${label} sets ${item.field}, which is not a scalar`);
        if (!STATISTICS_BY_UNIT(spec).includes(item.datasheet.statistic)) fail(`${label}: a ${item.datasheet.statistic} value cannot fill ${item.field}`);
        const rule = CONVERSION_RULES[item.conversion];
        if (!rule.statistics.includes(item.datasheet.statistic)) fail(`${label}: the ${item.conversion} conversion cannot carry a ${item.datasheet.statistic} value`);
        const from = rule.from ?? spec.siUnit, to = rule.to ?? spec.siUnit;
        if (item.datasheet.unit !== from) fail(`${label}: the ${item.conversion} conversion takes ${from}, not ${item.datasheet.unit}`);
        if (to !== spec.siUnit) fail(`${label}: the ${item.conversion} conversion gives ${to}, but ${item.field} is in ${spec.siUnit}`);
        if (PRESET_CONVERSIONS[item.conversion](item.datasheet.value) !== item.value) {
          fail(`${label}: ${item.field} ${item.value} is not the ${item.conversion} conversion of ${item.datasheet.value}`);
        }
        if (!inRange(spec, item.value)) fail(`${label}: ${item.field} ${item.value} is outside the field's range`);
        if (!citations.has(item.citation)) fail(`${label} cites unknown source ${item.citation}`);
      }
      for (const note of preset.references) {
        if (fieldSpec(note.field).sensor !== preset.sensor) fail(`${label} notes ${note.field} of another sensor`);
        if (!citations.has(note.citation)) fail(`${label} cites unknown source ${note.citation}`);
      }
    }
  });
  return deepFreeze(value.catalogs);
}

const CATALOGS = parseSensorPresetFile(file);
export function presetCatalog(version: number): SensorPresetCatalog | null {
  return CATALOGS.find(catalog => catalog.catalogVersion === version) ?? null;
}
export function latestPresetCatalog(): SensorPresetCatalog {
  const latest = CATALOGS.at(-1);
  if (!latest) throw new Error('The sensor preset file holds no catalog');
  return latest;
}
/** The preset a reference names, or null when the bundled file does not hold it. */
export function findSensorPreset(reference: PresetReference): SensorPreset | null {
  return presetCatalog(reference.catalogVersion)?.presets.find(preset => preset.id === reference.id) ?? null;
}

export interface PresetApplication {
  readonly configuration: SensorConfiguration;
  readonly applied: readonly SensorFieldPath[];
  readonly skipped: readonly { readonly field: SensorFieldPath; readonly reason: string }[];
}
/**
 * Writes a preset's values into its sensor block and records the reference.
 * Fields that cannot be applied, or that presets do not fill, are listed as
 * skipped with the reason. Other values of the block are kept.
 */
export function applySensorPreset(config: SensorConfiguration, reference: PresetReference): PresetApplication {
  const preset = findSensorPreset(reference);
  if (!preset) throw new Error(`Preset ${reference.id} is not in preset catalog ${reference.catalogVersion}`);
  const block: Record<string, unknown> = { ...config[preset.sensor], preset: { catalogVersion: reference.catalogVersion, id: reference.id } };
  const applied: SensorFieldPath[] = [], skipped: { field: SensorFieldPath; reason: string }[] = [];
  for (const item of preset.values) {
    const spec = fieldSpec(item.field);
    if (!spec.applicable) skipped.push({ field: item.field, reason: spec.disabledReason ?? 'It cannot be applied yet.' });
    else if (!spec.presettable) skipped.push({ field: item.field, reason: 'Presets do not fill this field.' });
    else {
      block[spec.key] = item.value;
      applied.push(item.field);
    }
  }
  return { configuration: { ...config, [preset.sensor]: block }, applied, skipped };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
