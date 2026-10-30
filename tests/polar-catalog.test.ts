import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  POLAR_CATALOG, boundCatalogPolar, catalogPolar, catalogPolarByNumericId, catalogPolarForAirfoil,
} from '@mirage/physics/polar-catalog';
import { parseNeuralFoilPolar } from '@mirage/wasm-bet/rotor';
import { calculationSettings, propellerPolarsOf, validateAircraftProfile, withPropellerPolars, withSensorConfiguration,
  type AircraftProfile } from '@mirage/aircraft/profile';
import { validateSensorConfiguration } from '@mirage/aircraft/sensor-config';
import { DEFAULT_SENSOR_CONFIGURATION } from '@mirage/aircraft/sensor-fields';
import { canonicalBytes } from '@mirage/project/schema';

// TASK-144: the runtime polar catalog and profile schema 4. Oracles: the
// repository polar fixtures (same bytes, same parse) and the schema rules of
// docs/SPECS_SIMULATION_ENGINES.md.

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const FIXTURES: Record<string, string> = {
  'naca6409-neuralfoil-v1': 'naca6409-neuralfoil.json', 'naca0012-neuralfoil-v1': 'naca0012-neuralfoil.json',
};

describe('polar catalog v1', () => {
  it('holds byte-identical copies of the repository NeuralFoil fixtures with their hashes', () => {
    expect(POLAR_CATALOG.map(entry => [entry.id, entry.numericId, entry.airfoil])).toEqual([
      ['naca6409-neuralfoil-v1', 1, 'NACA6409'], ['naca0012-neuralfoil-v1', 2, 'NACA0012'],
    ]);
    for (const entry of POLAR_CATALOG) {
      const catalogBytes = readFileSync(new URL(`../packages/physics/polars/${entry.id}.json`, import.meta.url));
      const fixtureBytes = readFileSync(new URL(`./fixtures/polars/${FIXTURES[entry.id]!}`, import.meta.url));
      expect(catalogBytes.equals(fixtureBytes), entry.id).toBe(true);
      expect(sha(catalogBytes)).toBe(entry.sha256);
      // The production parser gives the same bound polar as for the fixture.
      expect(boundCatalogPolar(entry.numericId)).toEqual(parseNeuralFoilPolar(JSON.parse(fixtureBytes.toString('utf8'))));
      expect(boundCatalogPolar(entry.numericId)).toBe(boundCatalogPolar(entry.numericId));
    }
    expect(new Set(POLAR_CATALOG.map(entry => entry.numericId)).size).toBe(POLAR_CATALOG.length);
    expect(() => boundCatalogPolar(0)).toThrow('not in polar catalog');
    expect(catalogPolar('missing')).toBeNull();
    expect(catalogPolarByNumericId(2)?.id).toBe('naca0012-neuralfoil-v1');
  });

  it('matches card airfoil names without case, spaces, hyphens or underscores, and nothing else', () => {
    for (const name of ['NACA6409', 'naca 6409', 'NACA-6409', 'naca_6409']) expect(catalogPolarForAirfoil(name)?.id).toBe('naca6409-neuralfoil-v1');
    for (const name of [null, '', '  ', 'NACA 4412', 'NACA640', 'Clark Y']) expect(catalogPolarForAirfoil(name)).toBeNull();
  });
});

const PROPELLER_A = 'a1'.repeat(32), PROPELLER_B = 'b2'.repeat(32);
/** The quad X fixture with two propeller cards: motors 1 and 2 use A, motors 3 and 4 use B. */
function quadWithPropellers(): AircraftProfile {
  const base: unknown = JSON.parse(readFileSync(new URL('./fixtures/aircraft/quad-x.json', import.meta.url), 'utf8'));
  const profile = validateAircraftProfile(base);
  return validateAircraftProfile({ ...profile, motors: profile.motors.map(motor => ({
    ...motor, components: { ...motor.components, propeller: motor.id <= 2 ? PROPELLER_A : PROPELLER_B },
  })) });
}

describe('profile schema 4', () => {
  it('is written exactly when a propeller polar is chosen, keeping the sensors and the calculation', () => {
    const v1 = quadWithPropellers();
    expect(v1.schemaVersion).toBe(1);
    const chosen = withPropellerPolars(v1, [{ card: PROPELLER_B, polar: 'naca0012-neuralfoil-v1' }, { card: PROPELLER_A, polar: 'naca6409-neuralfoil-v1' }]);
    expect(chosen.schemaVersion).toBe(4);
    // Stored in ascending card order whatever the input order.
    expect(propellerPolarsOf(chosen).map(entry => entry.card)).toEqual([PROPELLER_A, PROPELLER_B]);
    expect(chosen.sensorConfiguration).toBeNull();
    expect(calculationSettings(chosen)).toEqual({ mode: 'preliminary', measurementSets: [] });
    // A sensor configuration keeps the polars; the defaults are stored as null in schema 4 too.
    const config = validateSensorConfiguration({ ...structuredClone(DEFAULT_SENSOR_CONFIGURATION), mode: 'ideal' });
    const sensed = withSensorConfiguration(chosen, config);
    expect([sensed.schemaVersion, propellerPolarsOf(sensed).length, sensed.sensorConfiguration]).toEqual([4, 2, config]);
    expect(withSensorConfiguration(sensed, DEFAULT_SENSOR_CONFIGURATION).sensorConfiguration).toBeNull();
    // Removing the polars returns the lowest schema that holds the rest.
    expect(withPropellerPolars(sensed, []).schemaVersion).toBe(3);
    expect(withPropellerPolars(chosen, []).schemaVersion).toBe(2);
    expect(Buffer.from(canonicalBytes(withPropellerPolars(chosen, []))).equals(Buffer.from(canonicalBytes(v1)))).toBe(false);
    expect(propellerPolarsOf(v1)).toEqual([]);
  });

  it('rejects polars outside schema 4, for unused cards, for unknown entries or out of order', () => {
    const chosen = withPropellerPolars(quadWithPropellers(), [{ card: PROPELLER_A, polar: 'naca6409-neuralfoil-v1' }]);
    const invalid: [string, unknown, string][] = [
      ['polars in schema 3', { ...chosen, schemaVersion: 3, sensorConfiguration: null }, 'Propeller polars appear exactly in schema 4'],
      ['schema 4 without polars', { ...chosen, propellerPolars: undefined }, 'Propeller polars appear exactly in schema 4'],
      ['an empty list', { ...chosen, propellerPolars: [] }, 'must NOT have fewer than 1 items'],
      ['an unused card', { ...chosen, propellerPolars: [{ card: 'c3'.repeat(32), polar: 'naca6409-neuralfoil-v1' }] }, 'which no motor uses'],
      ['an unknown polar', { ...chosen, propellerPolars: [{ card: PROPELLER_A, polar: 'clark-y-v1' }] }, 'Unknown catalog polar clark-y-v1'],
      ['a repeated card', { ...chosen, propellerPolars: [{ card: PROPELLER_A, polar: 'naca6409-neuralfoil-v1' },
        { card: PROPELLER_A, polar: 'naca0012-neuralfoil-v1' }] }, 'ascending card order'],
      ['descending cards', { ...chosen, propellerPolars: [{ card: PROPELLER_B, polar: 'naca6409-neuralfoil-v1' },
        { card: PROPELLER_A, polar: 'naca0012-neuralfoil-v1' }] }, 'ascending card order'],
      ['a defaults sensor configuration', { ...chosen, sensorConfiguration: DEFAULT_SENSOR_CONFIGURATION }, 'stored as null'],
      ['schema 4 without a calculation', { ...chosen, calculation: undefined }, 'Schema 4 profiles need a calculation'],
    ];
    for (const [label, input, message] of invalid) expect(() => validateAircraftProfile(JSON.parse(JSON.stringify(input))), label).toThrow(message);
  });
});
