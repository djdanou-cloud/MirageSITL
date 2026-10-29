import { Ajv } from 'ajv';
import schema from './measurements.schema.json';
import {
  benchMeasurements, importBenchMeasurements, type BenchColumns, type BenchConditions, type BenchMeasurements,
} from '@mirage/physics/bench-import';
import { canonicalBytes, sha256Hex, type StoredVersion } from '@mirage/project/schema';
import type { Draft } from '@mirage/project/versions';
import { isCalendarDate, type ComponentCard, type ComponentType } from './components.ts';

// Measurement sets (TASK-140, S04): static bench data of one exact motor,
// propeller, ESC and power-supply combination, stored as `measurement-set`
// records of the project store that depend on the combination's card
// versions. The values follow the bench CSV v2 rules (TASK-090, TASK-140); a
// quantity that was not measured is null and is never filled in.
// Configuration-time code only.

/** The supply of a bench run: a battery card version, or a laboratory power supply, which no card describes. */
export type MeasurementSupply = { readonly kind: 'battery'; readonly card: string } | { readonly kind: 'laboratory' };
/** Card versions of a measured combination. */
export interface Combination {
  readonly motor: string;
  readonly propeller: string;
  readonly esc: string;
  readonly supply: MeasurementSupply;
}
export interface MeasurementSource {
  /** `file`: an uploaded bench CSV; `manual`: values entered in the application. */
  readonly kind: 'file' | 'manual';
  readonly fileName: string | null;
  /** SHA-256 of the uploaded file's bytes. */
  readonly fileSha256: string | null;
  /** YYYY-MM-DD of the measurement. */
  readonly date: string;
  readonly description: string | null;
}
export interface MeasurementSet {
  readonly schemaVersion: 1;
  readonly units: 'SI';
  readonly combination: Combination;
  /** Propeller diameter of the run; it must equal the propeller card's. */
  readonly diameterM: number;
  readonly conditions: BenchConditions;
  readonly points: BenchColumns;
  readonly source: MeasurementSource;
  /** Limits of use, in words. */
  readonly applicability: string | null;
}
export interface MeasurementDetails {
  readonly combination: Combination;
  readonly date: string;
  readonly description: string | null;
  readonly applicability: string | null;
}

// Union types express nullable values, as in the other aircraft schemas.
const validateSchema = new Ajv({ strict: true, strictNumbers: true, allowUnionTypes: true }).compile<MeasurementSet>(schema);
const ROLES = ['motor', 'propeller', 'esc'] as const;
const ARTICLES: { readonly [type in ComponentType]: string } = { motor: 'a motor', propeller: 'a propeller', esc: 'an ESC', battery: 'a battery' };

function fail(message: string): never {
  throw new Error(`Invalid measurement set: ${message}`);
}
function freeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Schema, bench and source checks; returns a deep-frozen copy. Usable as the store's `measurement-set` validator. */
export function validateMeasurementSet(input: unknown): MeasurementSet {
  const set: unknown = structuredClone(input);
  if (!validateSchema(set)) {
    const error = validateSchema.errors?.[0];
    return fail(`${error?.instancePath || '/'} ${error?.message ?? 'does not match the schema'}`);
  }
  try {
    benchMeasurements(set.diameterM, set.conditions, set.points);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : 'the bench data is invalid');
  }
  const { kind, fileName, fileSha256, date } = set.source;
  if (kind === 'file' && (fileName === null || fileSha256 === null)) fail('A file source needs its name and SHA-256');
  if (kind === 'manual' && (fileName !== null || fileSha256 !== null)) fail('A manual entry has no file name or SHA-256');
  if (!isCalendarDate(date)) fail(`The date ${date} is not a calendar date`);
  return freeze(set);
}

/** The coefficients, powers and flags of a set's bench data. */
export function measurementSetBench(set: MeasurementSet): BenchMeasurements {
  return benchMeasurements(set.diameterM, set.conditions, set.points);
}

/** SHA-256 of the canonical JSON of the combination: equal exactly for the same card versions and supply. */
export async function combinationKey(combination: Combination): Promise<string> {
  return sha256Hex(canonicalBytes(combination));
}

/** The card versions of a combination, sorted and without duplicates. */
export function combinationCards(combination: Combination): string[] {
  const cards = new Set([combination.motor, combination.propeller, combination.esc]);
  if (combination.supply.kind === 'battery') cards.add(combination.supply.card);
  return [...cards].sort();
}

/** A set from a bench CSV file (v1 or v2); the file's SHA-256 is that of its UTF-8 text. */
export async function measurementSetFromBenchCsv(text: string, details: MeasurementDetails & { readonly fileName: string }): Promise<MeasurementSet> {
  const bench = importBenchMeasurements(text);
  const fileSha256 = await sha256Hex(new TextEncoder().encode(text));
  return validateMeasurementSet({
    schemaVersion: 1, units: 'SI', combination: details.combination, diameterM: bench.diameterM, conditions: bench.conditions,
    points: {
      rpm: bench.points.map(point => point.rpm), thrustN: bench.points.map(point => point.thrustN),
      torqueNm: bench.points[0]?.torqueNm === null ? null : bench.points.map(point => point.torqueNm),
      voltageV: bench.points[0]?.voltageV === null ? null : bench.points.map(point => point.voltageV),
      currentA: bench.points[0]?.currentA === null ? null : bench.points.map(point => point.currentA),
    },
    source: { kind: 'file', fileName: details.fileName, fileSha256, date: details.date, description: details.description },
    applicability: details.applicability,
  });
}

/** A set from values entered in the application. */
export function measurementSetFromColumns(details: MeasurementDetails & {
  readonly diameterM: number; readonly conditions: BenchConditions; readonly columns: BenchColumns;
}): MeasurementSet {
  return validateMeasurementSet({
    schemaVersion: 1, units: 'SI', combination: details.combination, diameterM: details.diameterM, conditions: details.conditions,
    points: details.columns,
    source: { kind: 'manual', fileName: null, fileSha256: null, date: details.date, description: details.description },
    applicability: details.applicability,
  });
}

/** Checks that the combination's cards are available and of their roles' types, and that the propeller diameter matches. */
export function checkMeasurementCards(set: MeasurementSet, cards: ReadonlyMap<string, ComponentCard>): void {
  const roles: [ComponentType, string][] = ROLES.map(role => [role, set.combination[role]]);
  if (set.combination.supply.kind === 'battery') roles.push(['battery', set.combination.supply.card]);
  for (const [role, sha256] of roles) {
    const card = cards.get(sha256);
    if (!card) throw new Error(`The ${role} card ${sha256} of the combination is not available`);
    if (card.type !== role) throw new Error(`The ${role} card of the combination is ${ARTICLES[card.type]} card`);
    if (card.type === 'propeller' && card.values.diameterM !== set.diameterM) {
      throw new Error(`The bench diameter ${set.diameterM} m differs from the propeller card diameter ${card.values.diameterM} m`);
    }
  }
}

/** A project-store draft (TASK-136) for a set version, with its combination's cards as dependencies. */
export function measurementSetDraft(name: string, input: unknown): Draft {
  const set = validateMeasurementSet(input);
  return { name, payload: set, dependencies: combinationCards(set.combination) };
}

/** The set of a stored measurement-set version; its dependencies must be exactly its combination's cards. */
export function readMeasurementSet(stored: StoredVersion): MeasurementSet {
  const record = stored.record;
  if (record.kind !== 'measurement-set') throw new Error(`Record ${stored.sha256} is a ${record.kind}, not a measurement set`);
  const set = validateMeasurementSet(record.payload);
  const listed = record.dependencies.map(dependency => dependency.sha256);
  if (record.dependencies.some(dependency => dependency.kind !== 'component-card') || listed.join(',') !== combinationCards(set.combination).join(',')) {
    throw new Error(`Measurement-set record ${stored.sha256}: its dependencies must list exactly its combination's cards`);
  }
  return set;
}
