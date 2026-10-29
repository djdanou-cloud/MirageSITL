import { Ajv } from 'ajv';
import schema from './components.schema.json';
import {
  canonicalBytes, checkTimestamp, decodeUtf8, equalBytes, normalizeName, sha256Hex, type StoredVersion,
} from '@mirage/project/schema';
import type { ProjectStore } from '@mirage/project/store';
import type { AircraftProfile } from './profile.ts';

// Component cards (TASK-139, S04): reusable descriptions of motors,
// propellers, ESCs and batteries, stored as `component-card` records of the
// project store (TASK-136). Every value names its source, and null means the
// value is not known; nothing is filled in. The card exchange file moves cards
// between projects. Configuration-time code only.

export const COMPONENT_TYPES = ['motor', 'propeller', 'esc', 'battery'] as const;
export type ComponentType = typeof COMPONENT_TYPES[number];
export type SourceKind = 'specification' | 'measured' | 'synthetic';
export interface CardSource {
  readonly id: string;
  /** A datasheet or catalog, the user's own measurement, or an illustrative or assumed value. */
  readonly kind: SourceKind;
  readonly description: string;
  /** SHA-256 of the source document or measurement data; required for a measured source. */
  readonly sha256: string | null;
  /** YYYY-MM-DD of the document or measurement; required for a measured source. */
  readonly date: string | null;
}
export interface MotorCardValues {
  readonly kvRpmPerV: number;
  /** Phase-to-phase winding resistance. */
  readonly resistanceOhm: number | null;
  readonly noLoadCurrentA: number | null;
  /** The voltage of the no-load current test. */
  readonly noLoadVoltageV: number | null;
  readonly maxCurrentA: number | null;
  readonly maxPowerW: number | null;
  readonly massKg: number | null;
}
export interface ChordDistribution { readonly radiusRatio: readonly number[]; readonly chordRatio: readonly number[] }
export interface TwistDistribution { readonly radiusRatio: readonly number[]; readonly angleRad: readonly number[] }
export interface PropellerCardValues {
  readonly diameterM: number;
  /** Nominal pitch: the advance per revolution of a helical blade. */
  readonly pitchM: number;
  readonly bladeCount: number;
  readonly hubDiameterM: number | null;
  readonly massKg: number | null;
  /** Chord over tip radius at stations r/R. */
  readonly chord: ChordDistribution | null;
  /** Blade angle to the rotor plane at stations r/R. */
  readonly twist: TwistDistribution | null;
  readonly airfoil: string | null;
}
export interface EscCardValues {
  readonly maxCurrentA: number;
  /** Command update rate. */
  readonly updateRateHz: number | null;
  readonly maxVoltageV: number | null;
  readonly massKg: number | null;
}
export interface BatteryCardValues {
  readonly cellsSeries: number;
  readonly capacityAh: number;
  /** Whole-pack internal resistance. */
  readonly internalResistanceOhm: number | null;
  readonly cellFullV: number | null;
  readonly cellEmptyV: number | null;
  readonly maxDischargeCurrentA: number | null;
  readonly massKg: number | null;
}
type Provenance<V> = { readonly [K in keyof V]: string | null };
interface CardOf<T extends ComponentType, V> {
  readonly schemaVersion: 1;
  readonly units: 'SI';
  readonly type: T;
  /** An illustration shipped with MirageSITL; it never holds measured data. */
  readonly example: boolean;
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly sources: readonly CardSource[];
  readonly values: V;
  /** The source of each value: a source ID exactly when the value is known. */
  readonly provenance: Provenance<V>;
  /** Limits of use, in words. */
  readonly applicability: string | null;
}
export type MotorCard = CardOf<'motor', MotorCardValues>;
export type PropellerCard = CardOf<'propeller', PropellerCardValues>;
export type EscCard = CardOf<'esc', EscCardValues>;
export type BatteryCard = CardOf<'battery', BatteryCardValues>;
export type ComponentCard = MotorCard | PropellerCard | EscCard | BatteryCard;

/** The value fields of each type, in schema order. */
export const CARD_VALUE_KEYS: { readonly [T in ComponentType]: readonly string[] } = {
  motor: schema.definitions.motorValues.required,
  propeller: schema.definitions.propellerValues.required,
  esc: schema.definitions.escValues.required,
  battery: schema.definitions.batteryValues.required,
};
export const CARD_FILE_FORMAT = 'mirage-component-cards';
export const CARD_FILE_EXTENSION = '.miragecards';
export const MAX_CARD_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_CARDS_PER_FILE = schema.definitions.exchange.properties.cards.maxItems;
export interface CardFileEntry {
  readonly name: string;
  /** Address of the exported version in the exporting store; informational. */
  readonly sourceSha256: string;
  /** SHA-256 of the payload's canonical JSON, checked on import. */
  readonly payloadSha256: string;
  readonly payload: ComponentCard;
}
export interface CardImportResult {
  readonly name: string;
  readonly payloadSha256: string;
  /** `unchanged`: the project already held a card with this name and payload. */
  readonly status: 'added' | 'unchanged';
  /** Address of the stored version. */
  readonly sha256: string;
}
interface CardFile {
  readonly format: typeof CARD_FILE_FORMAT;
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly cards: readonly { name: string; sourceSha256: string; payloadSha256: string; payload: object }[];
}

// Union types express nullable values; the `type` discriminator reports the selected branch's errors.
const ajv = new Ajv({ strict: true, strictNumbers: true, allowUnionTypes: true, discriminator: true });
ajv.addSchema(schema);
const validateCardSchema = ajv.compile<ComponentCard>({ $ref: `${schema.$id}#/definitions/card` });
const validateFileSchema = ajv.compile<CardFile>({ $ref: `${schema.$id}#/definitions/exchange` });
const ARTICLES: { readonly [T in ComponentType]: string } = { motor: 'a motor', propeller: 'a propeller', esc: 'an ESC', battery: 'a battery' };

function fail(message: string): never {
  throw new Error(`Invalid component card: ${message}`);
}
function failFile(message: string): never {
  throw new Error(`Invalid card file: ${message}`);
}
function freeze<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/** A YYYY-MM-DD text (schema pattern) that names a day of the proleptic Gregorian calendar. */
function calendarDate(text: string): boolean {
  const [year = 0, month = 0, day = 0] = text.split('-').map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
}
function increasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > values[index - 1]!);
}
function checkTypeRules(card: ComponentCard): void {
  switch (card.type) {
    case 'motor':
      if ((card.values.noLoadCurrentA === null) !== (card.values.noLoadVoltageV === null)) {
        fail('The no-load current and its test voltage must both be known or both be missing');
      }
      return;
    case 'propeller': {
      const values = card.values;
      if (values.hubDiameterM !== null && values.hubDiameterM >= values.diameterM) fail('The hub diameter must be below the diameter');
      if (values.chord) {
        if (values.chord.chordRatio.length !== values.chord.radiusRatio.length) fail('The chord needs one chord ratio per radius ratio');
        if (!increasing(values.chord.radiusRatio)) fail('The chord radius ratios must increase');
      }
      if (values.twist) {
        if (values.twist.angleRad.length !== values.twist.radiusRatio.length) fail('The twist needs one angle per radius ratio');
        if (!increasing(values.twist.radiusRatio)) fail('The twist radius ratios must increase');
      }
      return;
    }
    case 'esc':
      return;
    case 'battery':
      if (card.values.cellFullV !== null && card.values.cellEmptyV !== null && card.values.cellFullV <= card.values.cellEmptyV) {
        fail('The full cell voltage must be above the empty cell voltage');
      }
      return;
    default: {
      const unreachable: never = card;
      throw new Error(`Unknown component type ${String(unreachable)}`);
    }
  }
}

/** Schema, source and per-type checks; returns a deep-frozen copy. Usable as the store's `component-card` validator. */
export function validateComponentCard(input: unknown): ComponentCard {
  const card: unknown = structuredClone(input);
  if (!validateCardSchema(card)) {
    const error = validateCardSchema.errors?.[0];
    return fail(`${error?.instancePath || '/'} ${error?.message ?? 'does not match the schema'}`);
  }
  const ids = new Set<string>();
  for (const source of card.sources) {
    if (ids.has(source.id)) fail(`Duplicate source ID ${source.id}`);
    ids.add(source.id);
    if (source.date !== null && !calendarDate(source.date)) fail(`Source ${source.id} date ${source.date} is not a calendar date`);
    if (source.kind === 'measured' && (source.sha256 === null || source.date === null)) {
      fail(`Measured source ${source.id} needs the SHA-256 and the date of its data`);
    }
  }
  if (card.example && card.sources.some(source => source.kind === 'measured')) fail('An example card may not hold measured data');
  const used = new Set<string>();
  for (const key of CARD_VALUE_KEYS[card.type]) {
    const value: unknown = Reflect.get(card.values, key), source: unknown = Reflect.get(card.provenance, key);
    if (value !== null && source === null) fail(`${key} has a value but no source`);
    if (value === null && source !== null) fail(`${key} has no value but names a source`);
    if (typeof source === 'string') {
      if (!ids.has(source)) fail(`${key} names unknown source ${source}`);
      used.add(source);
    }
  }
  for (const id of ids) if (!used.has(id)) fail(`Source ${id} is not used by any value`);
  checkTypeRules(card);
  return freeze(card);
}

/** The value fields a card does not know, in schema order: what a user still has to supply. */
export function missingValues(card: ComponentCard): string[] {
  return CARD_VALUE_KEYS[card.type].filter(key => Reflect.get(card.values, key) === null);
}

/** The card of a stored component-card version. */
export function readComponentCard(stored: StoredVersion): ComponentCard {
  if (stored.record.kind !== 'component-card') throw new Error(`Record ${stored.sha256} is a ${stored.record.kind}, not a component card`);
  return validateComponentCard(stored.record.payload);
}

/** Checks that every card a profile references is available and of the type its role needs. */
export function checkProfileCards(profile: AircraftProfile, cards: ReadonlyMap<string, ComponentCard>): void {
  for (const motor of profile.motors) {
    for (const [role, label] of [['motor', 'motor'], ['propeller', 'propeller'], ['esc', 'ESC']] as const) {
      const reference = motor.components[role];
      if (reference === null) continue;
      const card = cards.get(reference);
      if (!card) throw new Error(`The ${label} card ${reference} of motor ${motor.id} is not available`);
      if (card.type !== role) throw new Error(`Motor ${motor.id} references ${ARTICLES[card.type]} card as its ${label}`);
    }
  }
  const reference = profile.battery.card;
  if (reference !== null) {
    const card = cards.get(reference);
    if (!card) throw new Error(`The battery card ${reference} is not available`);
    if (card.type !== 'battery') throw new Error(`The battery reference names ${ARTICLES[card.type]} card`);
  }
}

/** A card exchange file (canonical JSON) with the given stored card versions, in order. */
export async function exportComponentCards(versions: readonly StoredVersion[], exportedAt = new Date()): Promise<Uint8Array<ArrayBuffer>> {
  if (versions.length < 1 || versions.length > MAX_CARDS_PER_FILE) throw new Error(`A card file holds 1 to ${MAX_CARDS_PER_FILE} cards`);
  const cards = [];
  for (const version of versions) {
    const payload = readComponentCard(version);
    cards.push({ name: version.record.name, sourceSha256: version.sha256, payloadSha256: await sha256Hex(canonicalBytes(payload)), payload });
  }
  const file = { format: CARD_FILE_FORMAT, formatVersion: 1, exportedAt: exportedAt.toISOString(), cards };
  if (!validateFileSchema(file)) failFile(`${validateFileSchema.errors?.[0]?.instancePath || '/'} ${validateFileSchema.errors?.[0]?.message ?? ''}`);
  const bytes = canonicalBytes(file);
  if (bytes.byteLength > MAX_CARD_FILE_BYTES) failFile(`a card file may not be larger than ${MAX_CARD_FILE_BYTES} bytes`);
  return bytes;
}

/** The cards of an exchange file, all checked before any is returned. */
export async function decodeComponentCards(input: Uint8Array): Promise<CardFileEntry[]> {
  if (input.byteLength > MAX_CARD_FILE_BYTES) failFile(`a card file may not be larger than ${MAX_CARD_FILE_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(input));
  } catch {
    return failFile('the file is not UTF-8 JSON');
  }
  if (!validateFileSchema(parsed)) {
    const error = validateFileSchema.errors?.[0];
    return failFile(`${error?.instancePath || '/'} ${error?.message ?? 'does not match the schema'}`);
  }
  if (!equalBytes(canonicalBytes(parsed), input)) failFile('the file is not canonical JSON');
  try {
    checkTimestamp(parsed.exportedAt, 'exportedAt');
  } catch (cause) {
    failFile(cause instanceof Error ? cause.message : 'exportedAt is not a UTC time');
  }
  const entries: CardFileEntry[] = [];
  for (const [index, entry] of parsed.cards.entries()) {
    const label = `card ${index + 1}`;
    let name: string;
    try {
      name = normalizeName(entry.name);
    } catch (cause) {
      return failFile(`${label}: ${cause instanceof Error ? cause.message : 'invalid name'}`);
    }
    if (name !== entry.name) failFile(`${label}: the name must be NFC without leading or trailing white space`);
    if (await sha256Hex(canonicalBytes(entry.payload)) !== entry.payloadSha256) failFile(`${label} does not match its SHA-256`);
    let payload: ComponentCard;
    try {
      payload = validateComponentCard(entry.payload);
    } catch (cause) {
      return failFile(`${label}: ${cause instanceof Error ? cause.message : 'invalid card'}`);
    }
    entries.push({ name, sourceSha256: entry.sourceSha256, payloadSha256: entry.payloadSha256, payload });
  }
  return entries;
}

/**
 * Adds the cards of an exchange file to a project. A card whose name and
 * payload the project already holds is reported unchanged; existing cards are
 * never modified. The whole file is checked before anything is stored.
 */
export async function importComponentCards(store: ProjectStore, projectId: string, input: Uint8Array): Promise<CardImportResult[]> {
  const entries = await decodeComponentCards(input);
  const held = new Map<string, string>();
  for (const head of await store.listItems(projectId, 'component-card')) {
    held.set(JSON.stringify([head.record.name, await sha256Hex(canonicalBytes(head.record.payload))]), head.sha256);
  }
  const results: CardImportResult[] = [];
  for (const entry of entries) {
    const key = JSON.stringify([entry.name, entry.payloadSha256]);
    const existing = held.get(key);
    if (existing !== undefined) {
      results.push({ name: entry.name, payloadSha256: entry.payloadSha256, status: 'unchanged', sha256: existing });
      continue;
    }
    const stored = await store.createItem(projectId, 'component-card', { name: entry.name, payload: entry.payload });
    held.set(key, stored.sha256);
    results.push({ name: entry.name, payloadSha256: entry.payloadSha256, status: 'added', sha256: stored.sha256 });
  }
  return results;
}
