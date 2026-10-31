import { parseNeuralFoilPolar, type BoundPolar } from '../../wasm-bet/src/rotor.ts';
import naca6409 from '../polars/naca6409-neuralfoil-v1.json';
import naca0012 from '../polars/naca0012-neuralfoil-v1.json';

// Runtime airfoil polar catalog (TASK-144). An aircraft profile chooses one
// catalog polar per propeller; the derived vehicle manifest carries its
// numeric ID as each rotor's `polarId`. The files are byte-identical copies of
// tests/fixtures/polars/ (tests/polar-catalog.test.ts checks the SHA-256), so
// their provenance and limitations are those fixtures'. Configuration-time
// code only; never call from a physics step.

/** Bumped whenever an entry is added, removed or changes its bytes or numeric ID. */
export const POLAR_CATALOG_VERSION = 1;

export interface CatalogPolar {
  /** Stable text ID, stored in aircraft profiles. */
  readonly id: string;
  /** Rotor `polarId` in vehicle manifests; never reused for another polar. */
  readonly numericId: number;
  /** Airfoil name, as a propeller card would state it. */
  readonly airfoil: string;
  readonly provenance: 'neural-surrogate';
  /** SHA-256 of the catalog file. */
  readonly sha256: string;
  readonly description: string;
}

export const POLAR_CATALOG: readonly CatalogPolar[] = Object.freeze([
  Object.freeze({
    id: 'naca6409-neuralfoil-v1', numericId: 1, airfoil: 'NACA6409', provenance: 'neural-surrogate',
    sha256: 'd6d9793ea030c6b957fa9018ed5c3307891665829773574b2bacb26f1909c9a1',
    description: 'NACA 6409, NeuralFoil 0.3.3 prediction (xxxlarge model, nCrit 9, Mach 0): 121 angles of attack, 10 Reynolds numbers; not measured data.',
  }),
  Object.freeze({
    id: 'naca0012-neuralfoil-v1', numericId: 2, airfoil: 'NACA0012', provenance: 'neural-surrogate',
    sha256: 'b65b811583008327d517505e2995ed2bd1ee9fa66cad207288bf0a436a01dab1',
    description: 'NACA 0012, NeuralFoil 0.3.3 prediction (xxxlarge model, nCrit 9, Mach 0): 121 angles of attack, 10 Reynolds numbers; not measured data.',
  }),
]);

const SOURCES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['naca6409-neuralfoil-v1', naca6409], ['naca0012-neuralfoil-v1', naca0012],
]);
const parsed = new Map<number, BoundPolar>();

export function catalogPolar(id: string): CatalogPolar | null {
  return POLAR_CATALOG.find(entry => entry.id === id) ?? null;
}
export function catalogPolarByNumericId(numericId: number): CatalogPolar | null {
  return POLAR_CATALOG.find(entry => entry.numericId === numericId) ?? null;
}
/** Airfoil names compare without case, spaces, hyphens or underscores ("naca 6409" is NACA6409). */
function airfoilKey(name: string): string {
  return name.toUpperCase().replace(/[\s_-]/g, '');
}
/** The catalog polar of a card's airfoil name, or null when none matches exactly (after normalization). */
export function catalogPolarForAirfoil(airfoil: string | null): CatalogPolar | null {
  if (airfoil === null) return null;
  const key = airfoilKey(airfoil);
  if (key === '') return null;
  return POLAR_CATALOG.find(entry => airfoilKey(entry.airfoil) === key) ?? null;
}
/** The bound polar of a catalog entry, parsed once by the production NeuralFoil parser. */
export function boundCatalogPolar(numericId: number): BoundPolar {
  const known = parsed.get(numericId);
  if (known) return known;
  const entry = catalogPolarByNumericId(numericId);
  if (!entry) throw new Error(`Polar ${numericId} is not in polar catalog v${POLAR_CATALOG_VERSION}`);
  const source = SOURCES.get(entry.id);
  if (typeof source !== 'object' || source === null || Reflect.get(source, 'id') !== entry.id) throw new Error(`Polar ${entry.id} source mismatch`);
  const polar = parseNeuralFoilPolar(source);
  parsed.set(numericId, polar);
  return polar;
}
