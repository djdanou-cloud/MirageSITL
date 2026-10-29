// TASK-139 (S04): component cards, the card exchange file and the BET
// propeller geometry derived from a card. Oracles: values computed by hand
// with 40-digit decimal arithmetic, the TASK-033 UIUC blade-station builder
// applied to the 14 measured UIUC geometries, and the v1 rotor checks of the
// BET runtime.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { validateModelManifest } from '../packages/physics/src/model-manifest.ts';
import { bladeStations, parseUiucPropellerFixture } from '../packages/physics/src/uiuc-propeller.ts';
import { canonicalBytes, ProjectStoreError } from '../packages/project/src/schema.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';
import { profileDraft, validateAircraftProfile } from '../packages/aircraft/src/profile.ts';
import { atan } from '../packages/aircraft/src/trig.ts';
import { GEOMETRY_STRIPS, RECORDED_PROPELLER_GEOMETRY_SHA256 } from './support/aircraft-derivation.ts';
import {
  checkProfileCards, decodeComponentCards, exportComponentCards, importComponentCards, missingValues, readComponentCard,
  validateComponentCard, type ComponentCard,
} from '../packages/aircraft/src/components.ts';
import {
  ASSUMED_CHORD_RATIO, ASSUMED_ROOT_RATIO, DEFAULT_STRIPS, derivePropellerGeometry,
} from '../packages/aircraft/src/propeller-geometry.ts';

/** Absolute tolerance in metres, radians and kg·m², set before implementation. */
const GEOMETRY_TOLERANCE = 1e-12;
const EXAMPLES = ['motor-example', 'propeller-example', 'esc-example', 'battery-example'] as const;

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type CardData = Mutable<ComponentCard>;
function fixture(name: typeof EXAMPLES[number]): CardData {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`./fixtures/components/${name}.json`, import.meta.url), 'utf8'));
  return structuredClone(validateComponentCard(parsed)) as CardData;
}
function edit(name: typeof EXAMPLES[number], change: (card: CardData) => void): unknown {
  const card = fixture(name);
  change(card);
  return card;
}
/** Sets one value of a card, keeping its provenance consistent. */
function setValue(card: CardData, key: string, value: unknown): void {
  Reflect.set(card.values, key, value);
  Reflect.set(card.provenance, key, value === null ? null : card.sources[0]!.id);
}
/** Sets the source of one value alone. */
function setSource(card: CardData, key: string, source: string | null): void {
  Reflect.set(card.provenance, key, source);
}
function expectClose(actual: readonly number[], expected: readonly number[], label: string): void {
  expect(actual, label).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(Math.abs(value - expected[i]!), `${label}[${i}]`).toBeLessThanOrEqual(GEOMETRY_TOLERANCE));
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('card schema', () => {
  test('the example cards validate, are labeled examples and hold no measured data', () => {
    for (const name of EXAMPLES) {
      const card = validateComponentCard(fixture(name));
      expect(card.example, name).toBe(true);
      expect(card.sources.every(source => source.kind === 'synthetic'), name).toBe(true);
      expect(card.model, name).toMatch(/^Example /);
      expect(Object.isFrozen(card) && Object.isFrozen(card.values) && Object.isFrozen(card.sources[0])).toBe(true);
    }
    expect(missingValues(validateComponentCard(fixture('propeller-example')))).toEqual(['hubDiameterM', 'chord', 'twist', 'airfoil']);
    expect(missingValues(validateComponentCard(fixture('motor-example')))).toEqual([]);
  });

  test('other units, unknown fields and values outside their ranges are rejected', () => {
    const invalid: [string, unknown][] = [
      ['imperial units', edit('motor-example', c => { Object.assign(c, { units: 'imperial' }); })],
      ['a diameter in inches', edit('propeller-example', c => { Object.assign(c.values, { diameterIn: 10 }); })],
      ['an unknown type', edit('esc-example', c => { Object.assign(c, { type: 'servo' }); })],
      ['schema version 2', edit('esc-example', c => { Object.assign(c, { schemaVersion: 2 }); })],
      ['zero KV', edit('motor-example', c => { setValue(c, 'kvRpmPerV', 0); })],
      ['KV of 200000', edit('motor-example', c => { setValue(c, 'kvRpmPerV', 200000); })],
      ['a 25 m propeller', edit('propeller-example', c => { setValue(c, 'diameterM', 25); })],
      ['no blades', edit('propeller-example', c => { setValue(c, 'bladeCount', 0); })],
      ['17 blades', edit('propeller-example', c => { setValue(c, 'bladeCount', 17); })],
      ['2.5 blades', edit('propeller-example', c => { setValue(c, 'bladeCount', 2.5); })],
      ['a negative internal resistance', edit('battery-example', c => { setValue(c, 'internalResistanceOhm', -0.01); })],
      ['zero cells', edit('battery-example', c => { setValue(c, 'cellsSeries', 0); })],
      ['33 cells', edit('battery-example', c => { setValue(c, 'cellsSeries', 33); })],
      ['a twist of 90 degrees', edit('propeller-example', c => { setValue(c, 'twist', { radiusRatio: [0.3, 1], angleRad: [Math.PI / 2, 0.1] }); })],
      ['a radius ratio above 1', edit('propeller-example', c => { setValue(c, 'chord', { radiusRatio: [0.3, 1.1], chordRatio: [0.2, 0.1] }); })],
      ['a zero chord', edit('propeller-example', c => { setValue(c, 'chord', { radiusRatio: [0.3, 1], chordRatio: [0.2, 0] }); })],
      ['a 65-character airfoil name', edit('propeller-example', c => { setValue(c, 'airfoil', 'A'.repeat(65)); })],
    ];
    for (const [label, input] of invalid) expect(() => validateComponentCard(input), label).toThrow('Invalid component card');
  });

  test('a missing field is rejected; a missing value is null and listed', () => {
    const invalid: [string, unknown][] = [
      ['no pitch field', edit('propeller-example', c => { Reflect.deleteProperty(c.values, 'pitchM'); Reflect.deleteProperty(c.provenance, 'pitchM'); })],
      ['a null pitch', edit('propeller-example', c => { setValue(c, 'pitchM', null); })],
      ['a null KV', edit('motor-example', c => { setValue(c, 'kvRpmPerV', null); })],
      ['a null capacity', edit('battery-example', c => { setValue(c, 'capacityAh', null); })],
      ['no sources', edit('esc-example', c => { c.sources = []; })],
      ['no applicability field', edit('esc-example', c => { Reflect.deleteProperty(c, 'applicability'); })],
    ];
    for (const [label, input] of invalid) expect(() => validateComponentCard(input), label).toThrow('Invalid component card');
    const sparse = validateComponentCard(edit('motor-example', c => {
      for (const key of ['resistanceOhm', 'noLoadCurrentA', 'noLoadVoltageV', 'maxPowerW']) setValue(c, key, null);
    }));
    expect(missingValues(sparse)).toEqual(['resistanceOhm', 'noLoadCurrentA', 'noLoadVoltageV', 'maxPowerW']);
  });

  test('every value names a listed source; measured sources carry a SHA-256 and a date; examples are never measured', () => {
    const measured = { id: 'bench', kind: 'measured' as const, description: 'No-load test at 10.0 V, 21 °C.', sha256: 'b'.repeat(64), date: '2026-09-12' };
    const valid = validateComponentCard(edit('motor-example', c => {
      c.example = false;
      c.sources.push(measured);
      setSource(c, 'noLoadCurrentA', 'bench');
      setSource(c, 'noLoadVoltageV', 'bench');
    }));
    expect(valid.sources.map(source => source.kind)).toEqual(['synthetic', 'measured']);
    // Gregorian leap years: 2028 and 2000 have 29 February, 2100 does not.
    for (const date of ['2028-02-29', '2000-02-29', '0050-03-01']) {
      expect(() => validateComponentCard(edit('motor-example', c => {
        c.example = false; c.sources.push({ ...measured, date }); c.provenance.massKg = 'bench';
      })), date).not.toThrow();
    }
    const invalid: [string, unknown, string][] = [
      ['a value without a source', edit('motor-example', c => { c.provenance.massKg = null; }), 'massKg has a value but no source'],
      ['a source for a missing value', edit('propeller-example', c => { setSource(c, 'airfoil', 'example'); }), 'airfoil has no value but names a source'],
      ['an unknown source', edit('esc-example', c => { c.provenance.massKg = 'datasheet'; }), 'massKg names unknown source datasheet'],
      ['an unused source', edit('esc-example', c => { c.sources.push({ ...measured, id: 'spare' }); c.example = false; }), 'Source spare is not used'],
      ['duplicate source IDs', edit('esc-example', c => { c.sources.push({ ...c.sources[0]! }); }), 'Duplicate source ID example'],
      ['a measured source without a hash', edit('motor-example', c => {
        c.example = false; c.sources.push({ ...measured, sha256: null }); c.provenance.massKg = 'bench';
      }), 'Measured source bench needs the SHA-256 and the date of its data'],
      ['a measured source without a date', edit('motor-example', c => {
        c.example = false; c.sources.push({ ...measured, date: null }); c.provenance.massKg = 'bench';
      }), 'Measured source bench needs the SHA-256 and the date of its data'],
      ['30 February', edit('motor-example', c => {
        c.example = false; c.sources.push({ ...measured, date: '2026-02-30' }); c.provenance.massKg = 'bench';
      }), 'not a calendar date'],
      ['29 February 2100', edit('motor-example', c => {
        c.example = false; c.sources.push({ ...measured, date: '2100-02-29' }); c.provenance.massKg = 'bench';
      }), 'not a calendar date'],
      ['month 13', edit('motor-example', c => {
        c.example = false; c.sources.push({ ...measured, date: '2026-13-01' }); c.provenance.massKg = 'bench';
      }), 'not a calendar date'],
      ['an example with measured data', edit('motor-example', c => { c.sources.push(measured); c.provenance.massKg = 'bench'; }), 'An example card may not hold measured data'],
    ];
    for (const [label, input, message] of invalid) expect(() => validateComponentCard(input), label).toThrow(message);
  });

  test('per-type rules', () => {
    const invalid: [string, unknown, string][] = [
      ['a no-load current without its voltage', edit('motor-example', c => { setValue(c, 'noLoadVoltageV', null); }), 'no-load current and its test voltage'],
      ['a hub as wide as the propeller', edit('propeller-example', c => { setValue(c, 'hubDiameterM', 0.254); }), 'hub diameter must be below the diameter'],
      ['radius ratios that do not increase', edit('propeller-example', c => { setValue(c, 'chord', { radiusRatio: [0.5, 0.5], chordRatio: [0.2, 0.1] }); }), 'chord radius ratios must increase'],
      ['distribution lengths that differ', edit('propeller-example', c => { setValue(c, 'twist', { radiusRatio: [0.3, 0.6, 1], angleRad: [0.4, 0.2] }); }), 'twist needs one angle per radius ratio'],
      ['a chord with a missing ratio', edit('propeller-example', c => { setValue(c, 'chord', { radiusRatio: [0.3, 0.6, 1], chordRatio: [0.2, 0.1] }); }), 'chord needs one chord ratio per radius ratio'],
      ['an empty cell above a full one', edit('battery-example', c => { setValue(c, 'cellEmptyV', 4.3); }), 'full cell voltage must be above the empty'],
    ];
    for (const [label, input, message] of invalid) expect(() => validateComponentCard(input), label).toThrow(message);
  });
});

describe('propeller geometry', () => {
  test('the example propeller matches the hand-computed oracle and lists every assumption', () => {
    const result = derivePropellerGeometry(fixture('propeller-example'), { strips: 4 });
    const g = result.geometry;
    // R = 0.254/2; no hub diameter, so the root is at 0.15·R = 0.01905 m; four strips 0.0269875 m wide.
    expect([g.bladeCount, g.radiusM, g.airfoil]).toEqual([2, 0.127, null]);
    expect(Math.abs(g.rootCutoutM - 0.01905)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
    expectClose(g.radialStationM, [0.03254375, 0.05953125, 0.08651875, 0.11350625], 'stations');
    expectClose(g.quadratureWidthM, [0.0269875, 0.0269875, 0.0269875, 0.0269875], 'widths');
    // No chord: c = 0.1812·R = 0.0230124 m. No twist: θ = atan(P/(2πr)) with P = 0.1143 m, by 40-digit series.
    expectClose(g.chordM, [0.0230124, 0.0230124, 0.0230124, 0.0230124], 'chord');
    expectClose(g.twistRad, [0.5097139416130941, 0.29656587104581633, 0.2072409517702519, 0.15891647856551683], 'twist');
    // Two thin uniform rods from the axis to the tip: I = m·R²/3 = 0.0125·0.127²/3.
    expect(Math.abs(g.bladeInertiaKgM2! - 6.720416666666666e-5)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
    expect(result.assumptions.map(item => item.id)).toEqual([
      'rigid-identical-blades', 'midpoint-strips', 'root-cutout', 'chord', 'twist', 'inertia',
    ]);
    expect(result.flags.map(item => item.id)).toEqual(['root-cutout-assumed', 'chord-assumed', 'twist-from-pitch', 'airfoil-unspecified']);
    expect(result.assumptions.find(item => item.id === 'chord')!.description).toContain('0.1812');
    expect(result.assumptions.find(item => item.id === 'midpoint-strips')!.description).toContain('4 strips');
    expect([ASSUMED_CHORD_RATIO, ASSUMED_ROOT_RATIO, DEFAULT_STRIPS]).toEqual([0.1812, 0.15, 16]);
  });

  test('the 14 measured UIUC geometries as cards give the TASK-033 blade stations', () => {
    const raw: unknown = JSON.parse(readFileSync(new URL('./fixtures/rotors/uiuc-propellers.json', import.meta.url), 'utf8'));
    const fixtureData = parseUiucPropellerFixture(raw);
    const pitches = new Map((raw as { propellers: { id: string; nominalPitchM: number }[] }).propellers.map(p => [p.id, p.nominalPitchM]));
    expect(fixtureData.propellers).toHaveLength(14);
    for (const p of fixtureData.propellers) {
      const card = edit('propeller-example', c => {
        c.example = false;
        c.sources = [{ id: 'uiuc', kind: 'measured', description: `UIUC propeller database volume 2, ${p.id}`, sha256: 'c'.repeat(64), date: '2022-06-27' }];
        c.values = { diameterM: p.diameterM, pitchM: pitches.get(p.id)!, bladeCount: p.bladeCount, hubDiameterM: 0.3 * p.diameterM,
          massKg: null, chord: { radiusRatio: [...p.radiusRatio], chordRatio: [...p.chordRatio] },
          twist: { radiusRatio: [...p.radiusRatio], angleRad: p.betaDeg.map(deg => (deg * Math.PI) / 180) }, airfoil: p.airfoil };
        c.provenance = { diameterM: 'uiuc', pitchM: 'uiuc', bladeCount: 'uiuc', hubDiameterM: 'uiuc', massKg: null, chord: 'uiuc', twist: 'uiuc', airfoil: 'uiuc' };
      });
      const derived = derivePropellerGeometry(card, { strips: 28 });
      const reference = bladeStations(p, 0.3, 28);
      expect(derived.geometry.radiusM).toBe(reference.radiusM);
      expect(Math.abs(derived.geometry.rootCutoutM - reference.cutoutM), p.id).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
      expectClose(derived.geometry.radialStationM, reference.stationM, `${p.id} stations`);
      expectClose(derived.geometry.chordM, reference.chordM, `${p.id} chord`);
      expectClose(derived.geometry.twistRad, reference.twistRad, `${p.id} twist`);
      expectClose(derived.geometry.quadratureWidthM, reference.widthM, `${p.id} widths`);
      expect(derived.flags.map(item => item.id), p.id).toEqual(['inertia-unknown']);
    }
  });

  test('a distribution that does not reach a station is held at its end value and flagged', () => {
    const card = edit('propeller-example', c => {
      setValue(c, 'hubDiameterM', 0.02);
      setValue(c, 'chord', { radiusRatio: [0.3, 0.9], chordRatio: [0.2, 0.1] });
      setValue(c, 'twist', { radiusRatio: [0.1, 1], angleRad: [0.5, 0.1] });
      setValue(c, 'airfoil', 'Clark Y');
    });
    const { geometry, flags } = derivePropellerGeometry(card, { strips: 4 });
    // Root at 0.01 m, strips 0.02925 m wide: r/R = 0.19390.., 0.42421.., 0.65453.., 0.88484...
    const ratios = [0.024625, 0.053875, 0.083125, 0.112375].map(r => r / 0.127);
    expectClose(geometry.radialStationM, [0.024625, 0.053875, 0.083125, 0.112375], 'stations');
    const chordRatio = (x: number) => x <= 0.3 ? 0.2 : 0.2 + (x - 0.3) * (0.1 - 0.2) / 0.6;
    expectClose(geometry.chordM, ratios.map(x => chordRatio(x) * 0.127), 'chord');
    expectClose(geometry.twistRad, ratios.map(x => 0.5 + (x - 0.1) * (0.1 - 0.5) / 0.9), 'twist');
    expect(geometry.airfoil).toBe('Clark Y');
    expect(flags.map(item => item.id)).toEqual(['chord-extended']);
    const twistShort = edit('propeller-example', c => {
      setValue(c, 'hubDiameterM', 0.02);
      setValue(c, 'chord', { radiusRatio: [0.1, 1], chordRatio: [0.2, 0.1] });
      setValue(c, 'twist', { radiusRatio: [0.3, 0.8], angleRad: [0.5, 0.2] });
    });
    const short = derivePropellerGeometry(twistShort, { strips: 4 });
    expectClose(short.geometry.twistRad, ratios.map(x => (x <= 0.3 ? 0.5 : x >= 0.8 ? 0.2 : 0.5 + (x - 0.3) * (0.2 - 0.5) / 0.5)), 'held twist');
    expect(short.flags.map(item => item.id)).toEqual(['twist-extended', 'airfoil-unspecified']);
    // Data that ends before the tip is flagged too.
    const tipShort = edit('propeller-example', c => {
      setValue(c, 'hubDiameterM', 0.02);
      setValue(c, 'chord', { radiusRatio: [0.1, 0.8], chordRatio: [0.2, 0.1] });
      setValue(c, 'twist', { radiusRatio: [0.1, 1], angleRad: [0.5, 0.1] });
    });
    expect(derivePropellerGeometry(tipShort, { strips: 4 }).flags.map(item => item.id)).toEqual(['chord-extended', 'airfoil-unspecified']);
  });

  test('the geometry is valid BET rotor input for every strip count', () => {
    for (const strips of [1, 2, DEFAULT_STRIPS, 64]) {
      const { geometry } = derivePropellerGeometry(fixture('propeller-example'), { strips });
      const rotor = {
        id: 0, motorChannel: 0, bladeCount: geometry.bladeCount, spinSign: 1, radiusM: geometry.radiusM, rootCutoutM: geometry.rootCutoutM,
        polarId: 0, radialStationM: geometry.radialStationM, chordM: geometry.chordM, twistRad: geometry.twistRad,
        quadratureWidthM: geometry.quadratureWidthM, hubPositionBodyM: [0, 0, 0], hubToBody: [0, 1, 0, 0],
        shaftInertiaKgM2: geometry.bladeInertiaKgM2!, bearingViscousNmPerRadS: 0, azimuthSamples: 8,
      };
      expect(() => validateModelManifest({ schemaVersion: 1, modelId: 1, kind: 'bet', units: 'SI', worldFrame: 'NED', bodyFrame: 'FRD',
        quaternionOrder: 'wxyz', massKg: 1, inertiaBodyKgM2: [0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.02], rotorCount: 1, rotorCapacity: 32,
        rotors: [rotor] }), `${strips} strips`).not.toThrow();
    }
    for (const strips of [0, 65, 2.5]) expect(() => derivePropellerGeometry(fixture('propeller-example'), { strips })).toThrow('strips');
    expect(() => derivePropellerGeometry(fixture('motor-example'))).toThrow('not a propeller card');
  });

  test('the example geometry has the recorded bytes that Chromium must reproduce', () => {
    const hashes = Object.fromEntries(GEOMETRY_STRIPS.map(strips =>
      [strips, sha256(canonicalBytes(derivePropellerGeometry(fixture('propeller-example'), { strips })))]));
    expect(hashes).toEqual(RECORDED_PROPELLER_GEOMETRY_SHA256);
  });

  test('atan is within 8 ulp of the engine and odd', () => {
    const ulps = (a: number, b: number) => {
      const view = new DataView(new ArrayBuffer(16));
      view.setFloat64(0, a); view.setFloat64(8, b);
      const order = (bits: bigint) => (bits >> 63n ? -(bits & 0x7fffffffffffffffn) : bits);
      const difference = order(view.getBigUint64(0)) - order(view.getBigUint64(8));
      return Number(difference < 0n ? -difference : difference);
    };
    let worst = 0;
    for (let i = 0; i <= 100000; i++) {
      const x = Math.sinh(-12 + (24 * i) / 100000); // -81000 .. 81000, dense near zero
      worst = Math.max(worst, ulps(atan(x), Math.atan(x)));
    }
    for (const x of [1e-300, 1e-8, 0.125, 1, 8, 1e8, 1e300]) worst = Math.max(worst, ulps(atan(x), Math.atan(x)));
    expect(worst).toBeLessThanOrEqual(8);
    expect(atan(0)).toBe(0);
    for (const x of [0.3, 1.82, 1e5]) expect(atan(-x)).toBe(-atan(x));
    for (const x of [Infinity, NaN]) expect(() => atan(x)).toThrow(RangeError);
  });
});

describe('store and exchange', () => {
  function newStore(): ProjectStore {
    let ids = 0;
    return new ProjectStore(new MemoryBackend(), {
      now: () => new Date(Date.UTC(2026, 9, 29, 12)),
      uuid: () => `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, '0')}`,
      storage: null,
      validators: { 'component-card': validateComponentCard, 'aircraft-profile': validateAircraftProfile },
    });
  }
  async function library(store: ProjectStore) {
    const project = await store.createProject('Library');
    const cards = [];
    for (const name of EXAMPLES) cards.push(await store.createItem(project.record.id, 'component-card', { name: `Example ${name}`, payload: fixture(name) }));
    return { project, cards };
  }

  test('cards are versioned records; the store refuses invalid ones', async () => {
    const store = newStore();
    const { project, cards } = await library(store);
    const motor = cards[0]!;
    expect(readComponentCard(motor)).toEqual(validateComponentCard(fixture('motor-example')));
    const heavier = await store.saveVersion(motor.record.id, motor.sha256,
      { name: motor.record.name, payload: edit('motor-example', c => { setValue(c, 'massKg', 0.11); }) });
    expect(heavier.record.version).toBe(2);
    expect(readComponentCard(await store.get(motor.sha256)).values).toMatchObject({ massKg: 0.105 });
    const refused = store.createItem(project.record.id, 'component-card', { name: 'Broken', payload: edit('esc-example', c => { setValue(c, 'maxCurrentA', -1); }) });
    await expect(refused).rejects.toBeInstanceOf(ProjectStoreError);
    await expect(refused).rejects.toThrow('The component-card payload is invalid');
    const profile = await store.createProject('Hexa');
    expect(() => readComponentCard(profile)).toThrow('not a component card');
  });

  test('export and import round-trip between projects, and repeat imports change nothing', async () => {
    const store = newStore();
    const { cards } = await library(store);
    const file = await exportComponentCards(cards, new Date(Date.UTC(2026, 9, 29, 13)));
    // The file is canonical JSON; each entry carries its card's name, address and payload hash.
    const parsed: unknown = JSON.parse(new TextDecoder().decode(file));
    expect(Buffer.from(canonicalBytes(parsed)).equals(Buffer.from(file))).toBe(true);
    const entries = await decodeComponentCards(file);
    expect(entries.map(entry => [entry.name, entry.sourceSha256])).toEqual(cards.map(card => [card.record.name, card.sha256]));
    for (const [i, entry] of entries.entries()) expect(entry.payloadSha256).toBe(sha256(canonicalBytes(cards[i]!.record.payload)));

    const target = await store.createProject('Hexa trials');
    const first = await importComponentCards(store, target.record.id, file);
    expect(first.map(item => item.status)).toEqual(['added', 'added', 'added', 'added']);
    const imported = await store.listItems(target.record.id, 'component-card');
    expect(imported).toHaveLength(4);
    for (const card of cards) {
      const copy = imported.find(item => item.record.name === card.record.name)!;
      expect(Buffer.from(canonicalBytes(copy.record.payload)).equals(Buffer.from(canonicalBytes(card.record.payload)))).toBe(true);
    }
    const again = await importComponentCards(store, target.record.id, file);
    expect(again.map(item => item.status)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    expect(again.map(item => item.sha256)).toEqual(first.map(item => item.sha256));
    expect(await store.listItems(target.record.id, 'component-card')).toHaveLength(4);
    // A second export of the imported cards holds the same payloads.
    const reexported = await decodeComponentCards(await exportComponentCards(imported));
    expect(reexported.map(entry => entry.payloadSha256).sort()).toEqual(entries.map(entry => entry.payloadSha256).sort());
  });

  test('damaged, edited or invalid card files are refused and store nothing', async () => {
    const store = newStore();
    const { cards } = await library(store);
    const file = await exportComponentCards(cards);
    const target = await store.createProject('Target');
    const text = new TextDecoder().decode(file);
    const encode = (value: unknown) => canonicalBytes(value);
    const parsed = JSON.parse(text) as { cards: { payload: { values: Record<string, unknown> }; payloadSha256: string }[] };
    const tampered = structuredClone(parsed); tampered.cards[1]!.payload.values.pitchM = 0.12;
    const invalid = structuredClone(parsed); invalid.cards[2]!.payload.values.maxCurrentA = -5;
    invalid.cards[2]!.payloadSha256 = sha256(canonicalBytes(invalid.cards[2]!.payload));
    const cases: [string, Uint8Array, string][] = [
      ['a changed payload', encode(tampered), 'card 2 does not match its SHA-256'],
      ['an invalid card', encode(invalid), 'card 3: Invalid component card'],
      ['indented JSON', new TextEncoder().encode(JSON.stringify(parsed, null, 2)), 'not canonical JSON'],
      ['another format', encode({ ...parsed, format: 'mirage-project-archive' }), 'Invalid card file'],
      ['no cards', encode({ ...parsed, cards: [] }), 'Invalid card file'],
      ['not JSON', new TextEncoder().encode('MPRJ'), 'Invalid card file'],
      ['an oversized file', new Uint8Array(16 * 1024 * 1024 + 1), 'larger than'],
      ['a padded name', encode({ ...parsed, cards: [{ ...parsed.cards[0]!, name: ' Padded' }] }), 'card 1: the name must be NFC'],
      ['a name with a line feed', encode({ ...parsed, cards: [{ ...parsed.cards[0]!, name: 'Two\nlines' }] }), 'card 1: A name may not contain control'],
    ];
    for (const [label, bytes, message] of cases) {
      await expect(importComponentCards(store, target.record.id, bytes), label).rejects.toThrow(message);
    }
    expect(await store.listItems(target.record.id, 'component-card')).toHaveLength(0);
    await expect(exportComponentCards([await store.createProject('Not a card')])).rejects.toThrow('not a component card');
    await expect(exportComponentCards([])).rejects.toThrow('A card file holds 1 to 256 cards');
  });

  test('a profile references cards of the right type', async () => {
    const store = newStore();
    const { project, cards } = await library(store);
    const [motor, propeller, esc, battery] = cards.map(card => card.sha256);
    const bySha = new Map(cards.map(card => [card.sha256, readComponentCard(card)]));
    const profileJson: unknown = JSON.parse(readFileSync(new URL('./fixtures/aircraft/quad-x.json', import.meta.url), 'utf8'));
    const profile = structuredClone(validateAircraftProfile(profileJson)) as Mutable<ReturnType<typeof validateAircraftProfile>>;
    profile.motors.forEach(m => { m.components = { motor: motor!, propeller: propeller!, esc: esc! }; });
    profile.battery.card = battery!;
    expect(() => checkProfileCards(validateAircraftProfile(profile), bySha)).not.toThrow();
    await store.createItem(project.record.id, 'aircraft-profile', profileDraft('Quad', profile));
    const swapped = structuredClone(profile);
    swapped.motors[2]!.components.propeller = motor!;
    expect(() => checkProfileCards(validateAircraftProfile(swapped), bySha)).toThrow(`Motor 3 references a motor card as its propeller`);
    const missing = structuredClone(profile);
    missing.battery.card = 'd'.repeat(64);
    expect(() => checkProfileCards(validateAircraftProfile(missing), bySha)).toThrow(`The battery card ${'d'.repeat(64)} is not available`);
  });
});
