import {
  isCalendarDate, validateComponentCard, type ComponentCard, type ComponentType, type SourceKind,
} from '@mirage/aircraft/components';
import { angleField } from '../aircraft/profile-form';
import { parseDecimal } from './library-data';

// The component-card editor's form (TASK-192, S04): the text a user types,
// turned into a card of schema 1 (TASK-139) only through
// validateComponentCard. A value is either known, with its text and the
// source it comes from, or not known and stored as null; nothing is filled
// in. Twist angles are typed in degrees and stored in radians; an angle whose
// text was not edited keeps its radians, so opening and saving an unchanged
// card reproduces its bytes.

export type FieldKind = 'number' | 'integer' | 'text' | 'chord' | 'twist';
export interface FieldSpec {
  readonly key: string;
  /** The field's name with its unit, as the form shows it and as messages name it. */
  readonly label: string;
  readonly kind: FieldKind;
  /** A card of this type must know the value. */
  readonly required: boolean;
}
const number = (key: string, label: string, required = false): FieldSpec => ({ key, label, kind: 'number', required });
/** The values of each card type, in schema order. */
export const CARD_FIELDS: { readonly [T in ComponentType]: readonly FieldSpec[] } = {
  motor: [
    number('kvRpmPerV', 'KV (rpm/V)', true), number('resistanceOhm', 'Winding resistance (Ω)'),
    number('noLoadCurrentA', 'No-load current (A)'), number('noLoadVoltageV', 'No-load test voltage (V)'),
    number('maxCurrentA', 'Maximum current (A)'), number('maxPowerW', 'Maximum power (W)'), number('massKg', 'Mass (kg)'),
  ],
  propeller: [
    number('diameterM', 'Diameter (m)', true), number('pitchM', 'Pitch (m)', true),
    { key: 'bladeCount', label: 'Blades', kind: 'integer', required: true },
    number('hubDiameterM', 'Hub diameter (m)'), number('massKg', 'Mass (kg)'),
    { key: 'chord', label: 'Chord distribution', kind: 'chord', required: false },
    { key: 'twist', label: 'Twist distribution', kind: 'twist', required: false },
    { key: 'airfoil', label: 'Airfoil', kind: 'text', required: false },
  ],
  esc: [
    number('maxCurrentA', 'Maximum current (A)', true), number('updateRateHz', 'Update rate (Hz)'),
    number('maxVoltageV', 'Maximum voltage (V)'), number('massKg', 'Mass (kg)'),
  ],
  battery: [
    { key: 'cellsSeries', label: 'Cells in series', kind: 'integer', required: true }, number('capacityAh', 'Capacity (Ah)', true),
    number('internalResistanceOhm', 'Internal resistance (Ω)'), number('cellFullV', 'Full cell voltage (V)'),
    number('cellEmptyV', 'Empty cell voltage (V)'), number('maxDischargeCurrentA', 'Maximum discharge current (A)'), number('massKg', 'Mass (kg)'),
  ],
};
/** The card schema's limits on sources and distribution stations. */
export const MAX_SOURCES = 16;
export const MAX_DISTRIBUTION_ROWS = 64;
/** The columns of a distribution: the station r/R and the value at it. */
export const DISTRIBUTION_COLUMNS = {
  chord: { array: 'chordRatio', label: 'chord/R', heading: 'Chord over tip radius' },
  twist: { array: 'angleRad', label: 'angle', heading: 'Blade angle (°)' },
} as const;

/** A distribution station: r/R, the value text, and for a twist the stored radians while that text is unedited. */
export interface RowForm {
  readonly ratio: string;
  readonly value: string;
  readonly rad: number | null;
}
export interface FieldForm {
  readonly known: boolean;
  /** The value of a number, integer or text field; ignored while the value is not known. */
  readonly text: string;
  /** Index of the value's source in the card's sources, or null when none is chosen. */
  readonly source: number | null;
  /** The stations of a distribution; kept while it is not known, so switching back restores them. */
  readonly rows: readonly RowForm[];
}
export interface SourceForm {
  readonly id: string;
  readonly kind: SourceKind;
  readonly description: string;
  /** Empty when not given. */
  readonly sha256: string;
  readonly date: string;
}
export interface CardForm {
  readonly type: ComponentType;
  readonly example: boolean;
  /** Empty when not known, as are model and applicability. */
  readonly manufacturer: string;
  readonly model: string;
  readonly applicability: string;
  readonly sources: readonly SourceForm[];
  readonly fields: { readonly [key: string]: FieldForm };
}
export type CardFormResult = { readonly ok: true; readonly card: ComponentCard } | { readonly ok: false; readonly errors: readonly string[] };

const EMPTY_ROW: RowForm = { ratio: '', value: '', rad: null };
const isDistribution = (kind: FieldKind) => kind === 'chord' || kind === 'twist';
function unknownField(spec: FieldSpec): FieldForm {
  return { known: false, text: '', source: null, rows: isDistribution(spec.kind) ? [EMPTY_ROW, EMPTY_ROW] : [] };
}

/** A new card: one specification source to describe, and the type's required values to fill from it. */
export function newCardForm(type: ComponentType): CardForm {
  const fields: Record<string, FieldForm> = {};
  for (const spec of CARD_FIELDS[type]) fields[spec.key] = spec.required ? { ...unknownField(spec), known: true, source: 0 } : unknownField(spec);
  return {
    type, example: false, manufacturer: '', model: '', applicability: '',
    sources: [{ id: 'datasheet', kind: 'specification', description: '', sha256: '', date: '' }], fields,
  };
}

/** The stations of a stored distribution. */
function rowsOf(card: ComponentCard, kind: 'chord' | 'twist'): RowForm[] | null {
  if (card.type !== 'propeller') return null;
  if (kind === 'chord') {
    const chord = card.values.chord;
    return chord && chord.radiusRatio.map((ratio, i) => ({ ratio: String(ratio), value: String(chord.chordRatio[i]), rad: null }));
  }
  const twist = card.values.twist;
  return twist && twist.radiusRatio.map((ratio, i) => {
    const angle = angleField(twist.angleRad[i] ?? Number.NaN);
    return { ratio: String(ratio), value: angle.text, rad: angle.rad };
  });
}

/** The form of a stored card. */
export function formFromCard(card: ComponentCard): CardForm {
  const fields: Record<string, FieldForm> = {};
  for (const spec of CARD_FIELDS[card.type]) {
    const value: unknown = Reflect.get(card.values, spec.key), cited: unknown = Reflect.get(card.provenance, spec.key);
    const index = card.sources.findIndex(source => source.id === cited);
    const source = index < 0 ? null : index;
    if (spec.kind === 'chord' || spec.kind === 'twist') {
      const rows = rowsOf(card, spec.kind);
      fields[spec.key] = rows ? { known: true, text: '', source, rows } : unknownField(spec);
    } else if (typeof value === 'number' || typeof value === 'string') {
      fields[spec.key] = { known: true, text: String(value), source, rows: [] };
    } else {
      fields[spec.key] = unknownField(spec);
    }
  }
  return {
    type: card.type, example: card.example, manufacturer: card.manufacturer ?? '', model: card.model ?? '',
    applicability: card.applicability ?? '',
    sources: card.sources.map(source => ({ ...source, sha256: source.sha256 ?? '', date: source.date ?? '' })), fields,
  };
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** Collects parse errors so that every field at fault is reported at once. */
class Reader {
  readonly errors: string[] = [];
  number(text: string, label: string): number {
    try {
      return parseDecimal(text, label);
    } catch (cause) {
      this.errors.push(cause instanceof Error ? cause.message : `${label} is not a decimal number`);
      return Number.NaN;
    }
  }
  distribution(spec: FieldSpec, kind: 'chord' | 'twist', rows: readonly RowForm[]): object {
    const column = DISTRIBUTION_COLUMNS[kind];
    if (rows.length < 2) this.errors.push(`${spec.label} needs at least two rows`);
    if (rows.length > MAX_DISTRIBUTION_ROWS) this.errors.push(`${spec.label} has at most ${MAX_DISTRIBUTION_ROWS} rows`);
    const radiusRatio: number[] = [], values: number[] = [];
    for (const [index, row] of rows.entries()) {
      const label = `${spec.label} row ${index + 1}`;
      radiusRatio.push(this.number(row.ratio, `${label} r/R`));
      if (kind === 'chord' || row.rad === null) {
        const value = this.number(row.value, `${label} ${column.label}`);
        if (kind === 'twist' && Number.isFinite(value) && !(value > -90 && value < 90)) this.errors.push(`${label} angle must be between -90° and 90°`);
        // Degrees to radians as (deg·π)/180, as for the aircraft editor's angles.
        values.push(kind === 'twist' ? (value * Math.PI) / 180 : value);
      } else {
        values.push(row.rad);
      }
    }
    return { radiusRatio, [column.array]: values };
  }
  value(spec: FieldSpec, field: FieldForm): unknown {
    switch (spec.kind) {
      case 'number':
        return this.number(field.text, spec.label);
      case 'integer': {
        const value = this.number(field.text, spec.label);
        if (Number.isFinite(value) && !Number.isInteger(value)) this.errors.push(`${spec.label} must be a whole number`);
        return value;
      }
      case 'text':
        if (field.text.trim() === '') this.errors.push(`${spec.label} is empty`);
        return field.text;
      case 'chord':
      case 'twist':
        return this.distribution(spec, spec.kind, field.rows);
      default: {
        const unreachable: never = spec.kind;
        throw new Error(`Unknown field kind ${String(unreachable)}`);
      }
    }
  }
}

const TOP_LABELS: { readonly [key: string]: string } = { manufacturer: 'Manufacturer', model: 'Model', applicability: 'Applicability' };
/** A validator message with its prefix removed and its JSON path in the form's words. */
function describeCardError(type: ComponentType, message: string): string {
  const text = message.replace(/^Invalid component card: /, '');
  const value = /^\/values\/([A-Za-z]+)(?:\/([A-Za-z]+)(?:\/([0-9]+))?)? (.*)$/s.exec(text);
  if (value) {
    const [, key = '', array, index, rest = ''] = value;
    const spec = CARD_FIELDS[type].find(item => item.key === key);
    if (!spec) return text;
    if (array === undefined || index === undefined) return `${spec.label} ${rest}`;
    const column = array === 'radiusRatio' ? 'r/R' : spec.kind === 'chord' || spec.kind === 'twist' ? DISTRIBUTION_COLUMNS[spec.kind].label : array;
    return `${spec.label} row ${Number(index) + 1} ${column} ${rest}`;
  }
  const source = /^\/sources\/([0-9]+)\/([A-Za-z0-9]+) (.*)$/s.exec(text);
  if (source) return `Source ${Number(source[1]) + 1} ${source[2] === 'sha256' ? 'SHA-256' : source[2] ?? ''} ${source[3] ?? ''}`;
  const top = /^\/([a-z]+) (.*)$/s.exec(text);
  const label = top && TOP_LABELS[top[1] ?? ''];
  return label ? `${label} ${top[2] ?? ''}` : text;
}
const nullIfEmpty = (text: string) => (text.trim() === '' ? null : text);

/** The card a form describes, or every reason it is invalid. */
export function cardFromForm(form: CardForm): CardFormResult {
  const read = new Reader();
  if (form.sources.length === 0) read.errors.push('Add at least one source');
  if (form.sources.length > MAX_SOURCES) read.errors.push(`A card has at most ${MAX_SOURCES} sources`);
  const sources = form.sources.map((source, index) => {
    const id = source.id.trim(), name = id === '' ? String(index + 1) : id;
    if (id === '') read.errors.push(`Source ${index + 1} needs an ID`);
    else if (!SOURCE_ID.test(id)) read.errors.push(`Source ${index + 1} ID may hold only lowercase letters, digits and hyphens, begins with a letter or digit and has at most 64 characters`);
    if (source.description.trim() === '') read.errors.push(`Source ${name} needs a description`);
    const sha256 = source.sha256.trim().toLowerCase(), date = source.date.trim();
    if (sha256 !== '' && !SHA256.test(sha256)) read.errors.push(`Source ${name} SHA-256 must be 64 hexadecimal digits`);
    if (date !== '' && !(DATE.test(date) && isCalendarDate(date))) read.errors.push(`Source ${name} date must be a calendar date written YYYY-MM-DD`);
    return { id, kind: source.kind, description: source.description, sha256: sha256 === '' ? null : sha256, date: date === '' ? null : date };
  });
  const values: Record<string, unknown> = {}, provenance: Record<string, string | null> = {};
  for (const spec of CARD_FIELDS[form.type]) {
    const field = form.fields[spec.key];
    if (!field?.known) {
      if (spec.required) read.errors.push(`${spec.label} is required`);
      values[spec.key] = null;
      provenance[spec.key] = null;
      continue;
    }
    values[spec.key] = read.value(spec, field);
    const source = field.source === null ? undefined : sources[field.source];
    if (!source) read.errors.push(`${spec.label} needs a source`);
    provenance[spec.key] = source?.id ?? null;
  }
  if (read.errors.length > 0) return { ok: false, errors: read.errors };
  const candidate = {
    schemaVersion: 1, units: 'SI', type: form.type, example: form.example,
    manufacturer: nullIfEmpty(form.manufacturer), model: nullIfEmpty(form.model), sources, values, provenance,
    applicability: nullIfEmpty(form.applicability),
  };
  try {
    return { ok: true, card: validateComponentCard(candidate) };
  } catch (cause) {
    return { ok: false, errors: [cause instanceof Error ? describeCardError(form.type, cause.message) : String(cause)] };
  }
}

/** The form with a field's known state switched; a value made known cites the only source when the card has one. */
export function setKnown(form: CardForm, key: string, known: boolean): CardForm {
  const field = form.fields[key];
  if (!field) return form;
  const source = known && field.source === null && form.sources.length === 1 ? 0 : field.source;
  return { ...form, fields: { ...form.fields, [key]: { ...field, known, source } } };
}
/** The form with a new, empty source whose ID is not yet used. */
export function addSource(form: CardForm): CardForm {
  const ids = new Set(form.sources.map(source => source.id));
  let n = form.sources.length + 1;
  while (ids.has(`source-${n}`)) n++;
  return { ...form, sources: [...form.sources, { id: `source-${n}`, kind: 'specification', description: '', sha256: '', date: '' }] };
}
/** The form without a source; values that cited it are left without a source, and later references move up. */
export function removeSource(form: CardForm, index: number): CardForm {
  const fields: Record<string, FieldForm> = {};
  for (const [key, field] of Object.entries(form.fields)) {
    const source = field.source === null || field.source === index ? null : field.source > index ? field.source - 1 : field.source;
    fields[key] = { ...field, source };
  }
  return { ...form, sources: form.sources.filter((_, i) => i !== index), fields };
}
