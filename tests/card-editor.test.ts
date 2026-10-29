// TASK-192 (S04): the component-card editor's form logic. Oracles: the four
// example card fixtures and a measured UIUC-style propeller card, compared by
// canonical bytes; the card schema's value keys; and validateComponentCard,
// through which every saved card must pass.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalBytes } from '../packages/project/src/schema.ts';
import schema from '../packages/aircraft/src/components.schema.json';
import { CARD_VALUE_KEYS, COMPONENT_TYPES, missingValues, validateComponentCard, type ComponentCard } from '../packages/aircraft/src/components.ts';
import {
  CARD_FIELDS, addSource, cardFromForm, formFromCard, newCardForm, removeSource, setKnown, type CardForm, type FieldForm,
} from '../apps/web/src/library/card-form.ts';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const EXAMPLES = ['motor-example', 'propeller-example', 'esc-example', 'battery-example'] as const;
function example(name: typeof EXAMPLES[number]): ComponentCard {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`./fixtures/components/${name}.json`, import.meta.url), 'utf8'));
  return validateComponentCard(parsed);
}
const same = (a: unknown, b: unknown) => Buffer.from(canonicalBytes(a)).equals(Buffer.from(canonicalBytes(b)));
function built(form: CardForm): ComponentCard {
  const result = cardFromForm(form);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.card;
}
const errors = (form: CardForm) => {
  const result = cardFromForm(form);
  return result.ok ? [] : [...result.errors];
};
function edit(form: CardForm, change: (form: Mutable<CardForm>) => void): CardForm {
  const copy = structuredClone(form) as Mutable<CardForm>;
  change(copy);
  return copy;
}
function field(form: Mutable<CardForm>, key: string): Mutable<FieldForm> {
  const value = form.fields[key];
  if (!value) throw new Error(`No field ${key}`);
  return value;
}
/** A measured propeller with every optional value, distributions and text fields. */
const MEASURED_PROPELLER = validateComponentCard({
  ...example('propeller-example'), example: false, manufacturer: 'Bench shop', model: 'Test 10x4.5', applicability: 'Static thrust below 9000 rpm.',
  sources: [
    { id: 'datasheet', kind: 'specification', description: 'Manufacturer page, 2026 edition.', sha256: null, date: null },
    { id: 'scan', kind: 'measured', description: 'Optical blade scan at 12 stations.', sha256: 'a'.repeat(64), date: '2026-10-01' },
  ],
  values: {
    diameterM: 0.254, pitchM: 0.1143, bladeCount: 2, hubDiameterM: 0.02, massKg: 0.0125,
    chord: { radiusRatio: [0.15, 0.5, 1], chordRatio: [0.12, 0.2, 0.08] },
    twist: { radiusRatio: [0.15, 0.5, 1], angleRad: [0.6, 0.31, 0.05] }, airfoil: 'Clark Y',
  },
  provenance: { diameterM: 'datasheet', pitchM: 'datasheet', bladeCount: 'datasheet', hubDiameterM: 'scan', massKg: 'datasheet', chord: 'scan', twist: 'scan', airfoil: 'datasheet' },
});

describe('card form', () => {
  test('the form lists every value of each card type in schema order, required exactly when the schema forbids null', () => {
    const valueSchemas = { motor: schema.definitions.motorValues, propeller: schema.definitions.propellerValues, esc: schema.definitions.escValues, battery: schema.definitions.batteryValues };
    for (const type of COMPONENT_TYPES) {
      expect(CARD_FIELDS[type].map(spec => spec.key), type).toEqual([...CARD_VALUE_KEYS[type]]);
      const notNull = CARD_VALUE_KEYS[type].filter(key => {
        const property: unknown = Reflect.get(valueSchemas[type].properties, key);
        return typeof property === 'object' && property !== null && 'type' in property && typeof property.type === 'string';
      });
      expect(CARD_FIELDS[type].filter(spec => spec.required).map(spec => spec.key), type).toEqual(notNull);
    }
  });

  test('opening and saving a card reproduces its exact bytes', () => {
    for (const name of EXAMPLES) expect(same(built(formFromCard(example(name))), example(name)), name).toBe(true);
    expect(same(built(formFromCard(MEASURED_PROPELLER)), MEASURED_PROPELLER)).toBe(true);
    // The twist is shown in degrees; untouched, it keeps its radians.
    const twist = formFromCard(MEASURED_PROPELLER).fields.twist!;
    expect(twist.rows.map(row => [row.ratio, row.value])).toEqual([['0.15', '34.3774677078'], ['0.5', '17.7616916491'], ['1', '2.86478897565']]);
  });

  test('a new card starts with its required values to fill, and unknown values are stored as null', () => {
    const blank = newCardForm('motor');
    expect(errors(blank)).toEqual(['Source datasheet needs a description', 'KV (rpm/V) is not a decimal number']);
    const filled = edit(blank, f => {
      field(f, 'kvRpmPerV').text = '700';
      f.sources[0]!.description = 'Manufacturer datasheet.';
      // Text typed into a value that is not known is ignored, never stored.
      field(f, 'massKg').text = '0.105';
    });
    const card = built(filled);
    expect(card.values).toEqual({ kvRpmPerV: 700, resistanceOhm: null, noLoadCurrentA: null, noLoadVoltageV: null, maxCurrentA: null, maxPowerW: null, massKg: null });
    expect(card.provenance).toEqual({ kvRpmPerV: 'datasheet', resistanceOhm: null, noLoadCurrentA: null, noLoadVoltageV: null, maxCurrentA: null, maxPowerW: null, massKg: null });
    expect(missingValues(card)).toEqual(['resistanceOhm', 'noLoadCurrentA', 'noLoadVoltageV', 'maxCurrentA', 'maxPowerW', 'massKg']);
    expect([card.example, card.manufacturer, card.model, card.applicability]).toEqual([false, null, null, null]);
    for (const type of COMPONENT_TYPES) {
      const required = CARD_FIELDS[type].filter(spec => spec.required).map(spec => spec.key);
      expect(Object.entries(newCardForm(type).fields).filter(([, value]) => value.known).map(([key]) => key), type).toEqual(required);
    }
  });

  test('a typed twist angle is converted from degrees; an untouched one keeps its radians', () => {
    // (deg·π)/180, as the aircraft editor converts: 3° and -89° round differently as deg·(π/180).
    const form = edit(formFromCard(MEASURED_PROPELLER), f => {
      const twist = field(f, 'twist');
      twist.rows[0] = { ...twist.rows[0]!, value: '-89', rad: null };
      twist.rows[1] = { ratio: '0.5', value: '3', rad: null };
      // A chord value is always its text; a radian slot left in a chord row is not a value.
      field(f, 'chord').rows[0] = { ratio: '0.15', value: '0.12', rad: 1 };
    });
    const card = built(form);
    if (card.type !== 'propeller') throw new Error('not a propeller');
    expect(card.values.twist?.angleRad).toEqual([(-89 * Math.PI) / 180, (3 * Math.PI) / 180, 0.05]);
    expect(card.values.chord).toEqual(MEASURED_PROPELLER.type === 'propeller' ? MEASURED_PROPELLER.values.chord : null);
  });

  test('invalid cards are explained, field by field', () => {
    const motor = formFromCard(example('motor-example')), propeller = formFromCard(example('propeller-example'));
    const battery = formFromCard(example('battery-example'));
    const measured = { id: 'bench', kind: 'measured' as const, description: 'No-load test.', sha256: '', date: '' };
    const cases: [string, CardForm, string][] = [
      ['a required value not known', edit(propeller, f => { field(f, 'diameterM').known = false; }), 'Diameter (m) is required'],
      ['a known value without a source', edit(motor, f => { field(f, 'massKg').source = null; }), 'Mass (kg) needs a source'],
      ['a word for a number', edit(motor, f => { field(f, 'kvRpmPerV').text = 'fast'; }), 'KV (rpm/V) is not a decimal number'],
      ['2.5 blades', edit(propeller, f => { field(f, 'bladeCount').text = '2.5'; }), 'Blades must be a whole number'],
      ['a one-row chord', edit(propeller, f => { const c = field(f, 'chord'); c.known = true; c.source = 0; c.rows = [{ ratio: '0.5', value: '0.2', rad: null }]; }), 'Chord distribution needs at least two rows'],
      ['a 90° twist', edit(propeller, f => { const t = field(f, 'twist'); t.known = true; t.source = 0; t.rows = [{ ratio: '0.3', value: '90', rad: null }, { ratio: '1', value: '-90', rad: null }]; }), 'Twist distribution row 1 angle must be between -90° and 90°; Twist distribution row 2 angle must be between -90° and 90°'],
      ['a blank source description', edit(motor, f => { f.sources[0]!.description = '  '; }), 'Source example needs a description'],
      ['a twist angle in words', edit(propeller, f => { const t = field(f, 'twist'); t.known = true; t.source = 0; t.rows = [{ ratio: '0.3', value: 'steep', rad: null }, { ratio: '1', value: '5', rad: null }]; }), 'Twist distribution row 1 angle is not a decimal number'],
      ['an empty airfoil', edit(propeller, f => { const a = field(f, 'airfoil'); a.known = true; a.source = 0; a.text = ' '; }), 'Airfoil is empty'],
      ['a 25 m propeller', edit(propeller, f => { field(f, 'diameterM').text = '25'; }), 'Diameter (m) must be <= 20'],
      ['zero cells', edit(battery, f => { field(f, 'cellsSeries').text = '0'; }), 'Cells in series must be >= 1'],
      ['a source without an ID', edit(motor, f => { f.sources[0]!.id = ''; }), 'Source 1 needs an ID'],
      ['a measured source without its hash and date', edit(motor, f => { f.example = false; f.sources.push(measured); field(f, 'massKg').source = 1; }), 'Measured source bench needs the SHA-256 and the date of its data'],
      ['an unused source', edit(motor, f => { f.example = false; f.sources.push({ ...measured, sha256: 'b'.repeat(64), date: '2026-10-29' }); }), 'Source bench is not used by any value'],
      ['an example card with measured data', edit(motor, f => { f.sources.push({ ...measured, sha256: 'b'.repeat(64), date: '2026-10-29' }); field(f, 'massKg').source = 1; }), 'An example card may not hold measured data'],
      ['an empty cell above a full one', edit(battery, f => { field(f, 'cellEmptyV').text = '4.3'; }), 'The full cell voltage must be above the empty cell voltage'],
      ['a capital in a source ID', edit(motor, f => { f.sources[0]!.id = 'Example'; }), 'Source 1 ID may hold only lowercase letters, digits and hyphens'],
      ['a short SHA-256', edit(motor, f => { f.sources[0]!.sha256 = 'abc'; }), 'Source example SHA-256 must be 64 hexadecimal digits'],
      ['30 February', edit(motor, f => { f.sources[0]!.date = '2026-02-30'; }), 'Source example date must be a calendar date written YYYY-MM-DD'],
      ['a duplicate source ID', edit(motor, f => { f.sources.push({ ...f.sources[0]! }); field(f, 'massKg').source = 1; }), 'Duplicate source ID example'],
      ['no sources', edit(motor, f => { f.sources = []; for (const value of Object.values(f.fields)) value.source = null; }), 'Add at least one source'],
      ['a 95° twist', edit(propeller, f => { const t = field(f, 'twist'); t.known = true; t.source = 0; t.rows = [{ ratio: '0.3', value: '95', rad: null }, { ratio: '1', value: '5', rad: null }]; }), 'Twist distribution row 1 angle must be between -90° and 90°'],
      ['an r/R beyond the tip', edit(propeller, f => { const c = field(f, 'chord'); c.known = true; c.source = 0; c.rows = [{ ratio: '0.5', value: '0.2', rad: null }, { ratio: '1.2', value: '0.1', rad: null }]; }), 'Chord distribution row 2 r/R must be <= 1'],
      ['a zero chord', edit(propeller, f => { const c = field(f, 'chord'); c.known = true; c.source = 0; c.rows = [{ ratio: '0.5', value: '0', rad: null }, { ratio: '1', value: '0.1', rad: null }]; }), 'Chord distribution row 1 chord/R must be > 0'],
      ['a decreasing r/R', edit(propeller, f => { const c = field(f, 'chord'); c.known = true; c.source = 0; c.rows = [{ ratio: '0.5', value: '0.2', rad: null }, { ratio: '0.3', value: '0.1', rad: null }]; }), 'The chord radius ratios must increase'],
      ['a long manufacturer', edit(motor, f => { f.manufacturer = 'x'.repeat(129); }), 'Manufacturer must NOT have more than 128 characters'],
      ['a long source description', edit(motor, f => { f.sources[0]!.description = 'x'.repeat(2049); }), 'Source 1 description must NOT have more than 2048 characters'],
    ];
    for (const [label, form, message] of cases) expect(errors(form).join('; '), label).toContain(message);
    // Every parse error is reported at once; the card checks run only on a form that parses.
    expect(errors(edit(motor, f => { field(f, 'kvRpmPerV').text = 'x'; field(f, 'massKg').source = null; }))).toEqual([
      'KV (rpm/V) is not a decimal number', 'Mass (kg) needs a source',
    ]);
    // A card-check message is shown as the reason itself, without the validator's prefix.
    expect(errors(edit(battery, f => { field(f, 'cellEmptyV').text = '4.3'; }))).toEqual(['The full cell voltage must be above the empty cell voltage']);
  });

  test('a measured source is saved with its hash in lowercase and its date', () => {
    const form = edit(formFromCard(example('motor-example')), f => {
      f.example = false;
      f.sources.push({ id: 'bench', kind: 'measured', description: 'No-load test.', sha256: ` ${'B'.repeat(64)} `, date: '2026-10-29' });
      field(f, 'noLoadCurrentA').source = 1;
    });
    const card = built(form);
    expect(card.sources[1]).toEqual({ id: 'bench', kind: 'measured', description: 'No-load test.', sha256: 'b'.repeat(64), date: '2026-10-29' });
    expect(card.provenance).toMatchObject({ noLoadCurrentA: 'bench', noLoadVoltageV: 'example' });
  });

  test('sources are added and removed without losing which value cites which', () => {
    // A value made known cites the only source; with two sources the user must choose.
    expect(setKnown(newCardForm('motor'), 'massKg', true).fields.massKg).toMatchObject({ known: true, source: 0 });
    expect(setKnown(addSource(newCardForm('motor')), 'massKg', true).fields.massKg).toMatchObject({ known: true, source: null });
    // Switching a value off and on again keeps its text and source.
    const motor = formFromCard(example('motor-example'));
    expect(setKnown(setKnown(motor, 'massKg', false), 'massKg', true).fields.massKg).toEqual(motor.fields.massKg);
    expect(addSource(motor).sources.map(source => source.id)).toEqual(['example', 'source-2']);
    expect(addSource(edit(motor, f => { f.sources.push({ ...f.sources[0]!, id: 'source-3' }); })).sources.map(source => source.id)).toEqual(['example', 'source-3', 'source-4']);
    const removed = removeSource(formFromCard(MEASURED_PROPELLER), 0);
    expect(removed.sources.map(source => source.id)).toEqual(['scan']);
    expect(Object.fromEntries(Object.entries(removed.fields).map(([key, value]) => [key, value.source]))).toEqual({
      diameterM: null, pitchM: null, bladeCount: null, hubDiameterM: 0, massKg: null, chord: 0, twist: 0, airfoil: null,
    });
    expect(errors(removed)).toEqual(['Diameter (m) needs a source', 'Pitch (m) needs a source', 'Blades needs a source', 'Mass (kg) needs a source', 'Airfoil needs a source']);
  });
});
