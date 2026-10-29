import { readComponentCard, type ComponentCard, type ComponentType } from '@mirage/aircraft/components';
import { readMeasurementSet, type Combination, type MeasurementSet } from '@mirage/aircraft/measurements';
import { readAircraftProfile, type AircraftProfile } from '@mirage/aircraft/profile';
import { ProjectStoreError, type StoredVersion } from '@mirage/project/schema';
import type { ProjectStore } from '@mirage/project/store';
import { describeProjectError } from '../shell/project-files';

// Data of the Components tab (TASK-140): the open project's component cards,
// measurement sets and aircraft profiles, read from the project store and
// checked by their owners' readers. A record that fails its check is listed
// with the reason instead of being dropped.

export interface LibraryEntry<T> {
  readonly stored: StoredVersion;
  readonly value: T | null;
  /** Why the record could not be read, or null. */
  readonly error: string | null;
}
export interface LibraryData {
  readonly cards: readonly LibraryEntry<ComponentCard>[];
  readonly sets: readonly LibraryEntry<MeasurementSet>[];
  readonly profiles: readonly LibraryEntry<AircraftProfile>[];
}

/** An error from the store or from a card, set or profile check, in words. */
export function describeLibraryError(error: unknown): string {
  if (error instanceof ProjectStoreError) return describeProjectError(error, 'create');
  return error instanceof Error ? error.message : String(error);
}

function entry<T>(stored: StoredVersion, read: (stored: StoredVersion) => T): LibraryEntry<T> {
  try {
    return { stored, value: read(stored), error: null };
  } catch (cause) {
    return { stored, value: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** The heads of the project's cards, measurement sets and profiles, each read and checked. */
export async function loadLibrary(store: ProjectStore, projectId: string): Promise<LibraryData> {
  const [cards, sets, profiles] = await Promise.all([
    store.listItems(projectId, 'component-card'), store.listItems(projectId, 'measurement-set'), store.listItems(projectId, 'aircraft-profile'),
  ]);
  return {
    cards: cards.map(stored => entry(stored, readComponentCard)),
    sets: sets.map(stored => entry(stored, readMeasurementSet)),
    profiles: profiles.map(stored => entry(stored, readAircraftProfile)),
  };
}

/** Exact versions by address: a profile may reference card and set versions older than the heads. */
export async function resolveVersions<T>(store: ProjectStore, addresses: Iterable<string>,
  read: (stored: StoredVersion) => T): Promise<{ values: Map<string, T>; names: Map<string, string> }> {
  const values = new Map<string, T>(), names = new Map<string, string>();
  for (const sha256 of new Set(addresses)) {
    try {
      const stored = await store.get(sha256);
      names.set(sha256, `${stored.record.name} (version ${stored.record.version})`);
      values.set(sha256, read(stored));
    } catch {
      // A missing or invalid version stays unresolved; the calculation reports it as not available.
    }
  }
  return { values, names };
}
const TYPE_NAMES: { readonly [type in ComponentType]: string } = { motor: 'Motor', propeller: 'Propeller', esc: 'ESC', battery: 'Battery' };
export function typeName(type: ComponentType): string {
  return TYPE_NAMES[type];
}

/** The parts of a combination in words, by card names. */
export function describeCombination(combination: Combination, names: ReadonlyMap<string, string>): string {
  const name = (sha256: string) => names.get(sha256) ?? `card ${sha256.slice(0, 12)}`;
  const supply = combination.supply.kind === 'battery' ? name(combination.supply.card) : 'laboratory power supply';
  return `${name(combination.motor)}, ${name(combination.propeller)}, ${name(combination.esc)}, ${supply}`;
}

const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/;
/** A decimal number typed in a form, or an error naming the field. */
export function parseDecimal(text: string, label: string): number {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) throw new Error(`${label} is not a decimal number`);
  return Number(trimmed);
}
/** An optional field: empty is null. */
export function parseOptional(text: string, label: string): number | null {
  return text.trim() === '' ? null : parseDecimal(text, label);
}

export const ENTRY_COLUMNS = [
  { key: 'rpm', label: 'Speed (rpm)', required: true },
  { key: 'thrustN', label: 'Thrust (N)', required: true },
  { key: 'torqueNm', label: 'Torque (N·m)', required: false },
  { key: 'voltageV', label: 'Voltage (V)', required: false },
  { key: 'currentA', label: 'Current (A)', required: false },
] as const;
export type EntryKey = typeof ENTRY_COLUMNS[number]['key'];
export type EntryRow = { readonly [key in EntryKey]: string };
export const EMPTY_ROW: EntryRow = { rpm: '', thrustN: '', torqueNm: '', voltageV: '', currentA: '' };

/**
 * Columns from rows typed in a form. Speed and thrust are required in every
 * row; an optional quantity left empty in every row was not measured and is
 * null, and one filled in some rows only is an error.
 */
export function entryColumns(rows: readonly EntryRow[]): {
  rpm: number[]; thrustN: number[]; torqueNm: number[] | null; voltageV: number[] | null; currentA: number[] | null;
} {
  if (rows.length === 0) throw new Error('Enter at least one row');
  const column = (key: EntryKey, label: string, required: boolean): number[] | null => {
    const filled = rows.filter(row => row[key].trim() !== '').length;
    if (filled === 0 && !required) return null;
    if (filled !== rows.length) {
      throw new Error(required ? `${label} is needed in every row` : `${label} must be filled in every row or left empty in all rows`);
    }
    return rows.map((row, index) => parseDecimal(row[key], `Row ${index + 1}: ${label}`));
  };
  const [rpm, thrust, torque, voltage, current] = ENTRY_COLUMNS.map(item => column(item.key, item.label, item.required));
  if (!rpm || !thrust) throw new Error('Speed and thrust are needed in every row');
  return { rpm, thrustN: thrust, torqueNm: torque ?? null, voltageV: voltage ?? null, currentA: current ?? null };
}
