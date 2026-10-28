import { Ajv, type ValidateFunction } from 'ajv';
import schema from './project.schema.json';

// Project records (TASK-136): immutable versions of projects, component cards,
// aircraft profiles and experiments, each addressed by the SHA-256 of its
// canonical JSON bytes (RFC 8785). Configuration-time code only; never call it
// from a physics step.

export const PROJECT_SCHEMA_VERSION = 1;
/** Record kinds in schema v1, in dependency order: a kind may depend only on kinds before it. */
export const ITEM_KINDS = ['project', 'component-card', 'aircraft-profile', 'experiment'] as const;
export type ItemKind = typeof ITEM_KINDS[number];
/** Kinds stored inside a project, as opposed to the project record itself. */
export type ContentKind = Exclude<ItemKind, 'project'>;
/** The kinds that each record kind may reference as a dependency (schema v1). */
export const ALLOWED_DEPENDENCIES: { readonly [kind in ItemKind]: readonly ItemKind[] } = {
  'project': [],
  'component-card': [],
  'aircraft-profile': ['component-card'],
  'experiment': ['aircraft-profile', 'component-card'],
};
/** Canonical UTF-8 bytes of one record. */
export const MAX_RECORD_BYTES = 1048576;
/** Nested arrays and objects in one JSON value. */
export const MAX_JSON_DEPTH = 32;
export const MAX_NAME_CODE_POINTS = 128;
export const MAX_DEPENDENCIES = 256;
export const MAX_VERSION = 1000000;

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }
export interface Dependency { readonly kind: ItemKind; readonly sha256: string }
export interface RecordOrigin { readonly copiedFrom: string }
/** Record envelope v1. The payload belongs to the kind's owner task (TASK-138, TASK-139, TASK-154). */
export interface ProjectRecord {
  readonly schemaVersion: 1;
  readonly kind: ItemKind;
  /** Item identity shared by all versions of one item. */
  readonly id: string;
  /** Equal to `id` for a project record. */
  readonly projectId: string;
  readonly version: number;
  /** Address of the previous version; null exactly for version 1. */
  readonly previous: string | null;
  /** Provenance of a copy; only version 1 may carry it. */
  readonly origin: RecordOrigin | null;
  readonly name: string;
  readonly createdAt: string;
  /** Exact versions this version reads, sorted by sha256. */
  readonly dependencies: readonly Dependency[];
  readonly payload: JsonObject;
}
/** One verified version: its address, its canonical bytes and the parsed, frozen record. */
export interface StoredVersion {
  readonly sha256: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly record: ProjectRecord;
}
/** Throws when a payload is not valid for its kind. Registered by the kind's owner task. */
export type PayloadValidator = (payload: unknown) => void;
export type PayloadValidators = { readonly [kind in ItemKind]?: PayloadValidator };

export type ProjectStoreErrorCode =
  | 'invalid' | 'not-found' | 'conflict' | 'missing-dependency' | 'quota-exceeded' | 'storage'
  | 'archive-size' | 'archive-header' | 'archive-hash' | 'archive-invalid';
export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode;
  constructor(code: ProjectStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectStoreError';
    this.code = code;
  }
}

const ajv = new Ajv({ strict: true, strictNumbers: true });
ajv.addSchema(schema);
/** Compiles one definition of project.schema.json. */
export function compileDefinition<T>(definition: 'record' | 'archiveManifest'): ValidateFunction<T> {
  return ajv.compile<T>({ $ref: `${schema.$id}#/definitions/${definition}` });
}
export function schemaErrors(validate: ValidateFunction): string {
  return ajv.errorsText(validate.errors);
}
const validateEnvelope = compileDefinition<ProjectRecord>('record');

function invalid(message: string, cause?: unknown): ProjectStoreError {
  return new ProjectStoreError('invalid', message, cause === undefined ? undefined : { cause });
}

const LONE_SURROGATE = /\p{Cs}/u;
/**
 * RFC 8785 canonical JSON. Accepts only plain JSON values: finite numbers,
 * well-formed strings, dense arrays and plain objects with enumerable string
 * keys (no `__proto__`), nested at most MAX_JSON_DEPTH deep. Object keys are
 * sorted by UTF-16 code units; numbers and strings use ECMAScript JSON
 * serialization, which RFC 8785 adopts. Stops once the text exceeds
 * `maxLength` UTF-16 code units.
 */
export function canonicalJson(value: unknown, maxLength = Number.POSITIVE_INFINITY): string {
  const parts: string[] = [];
  let length = 0;
  const emit = (text: string): void => {
    length += text.length;
    if (length > maxLength) throw invalid(`JSON value exceeds ${maxLength} characters`);
    parts.push(text);
  };
  const visit = (node: unknown, depth: number): void => {
    switch (typeof node) {
      case 'string':
        if (LONE_SURROGATE.test(node)) throw invalid('JSON strings must be well-formed Unicode');
        emit(JSON.stringify(node));
        return;
      case 'number':
        if (!Number.isFinite(node)) throw invalid('JSON numbers must be finite');
        emit(JSON.stringify(node));
        return;
      case 'boolean':
        emit(node ? 'true' : 'false');
        return;
      case 'object':
        break;
      default:
        throw invalid(`A ${typeof node} is not a JSON value`);
    }
    if (node === null) {
      emit('null');
      return;
    }
    if (depth >= MAX_JSON_DEPTH) throw invalid(`JSON nesting exceeds ${MAX_JSON_DEPTH} levels`);
    if (Array.isArray(node)) {
      // A dense plain array owns exactly its indices and `length`.
      if (Object.getPrototypeOf(node) !== Array.prototype || Reflect.ownKeys(node).length !== node.length + 1)
        throw invalid('JSON arrays must be plain and dense');
      emit('[');
      for (let index = 0; index < node.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(node, index);
        if (!descriptor || !('value' in descriptor)) throw invalid('JSON arrays must be plain and dense');
        if (index > 0) emit(',');
        visit(descriptor.value, depth + 1);
      }
      emit(']');
      return;
    }
    const prototype: unknown = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) throw invalid('JSON objects must be plain objects');
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (typeof key !== 'string' || key === '__proto__' || !descriptor || !descriptor.enumerable || !('value' in descriptor))
        throw invalid('JSON objects may hold only enumerable string-keyed data properties other than __proto__');
      if (LONE_SURROGATE.test(key)) throw invalid('JSON keys must be well-formed Unicode');
      entries.push([key, descriptor.value]);
    }
    // Default string comparison orders UTF-16 code units, as RFC 8785 requires.
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    emit('{');
    entries.forEach(([key, item], index) => {
      if (index > 0) emit(',');
      emit(JSON.stringify(key));
      emit(':');
      visit(item, depth + 1);
    });
    emit('}');
  };
  visit(value, 0);
  return parts.join('');
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Canonical UTF-8 bytes; every UTF-16 code unit encodes to at least one byte, so `maxBytes` also bounds the text. */
export function canonicalBytes(value: unknown, maxBytes = Number.POSITIVE_INFINITY): Uint8Array<ArrayBuffer> {
  const bytes = ENCODER.encode(canonicalJson(value, maxBytes));
  if (bytes.byteLength > maxBytes) throw invalid(`JSON value exceeds ${maxBytes} bytes`);
  return bytes;
}
/** Strict UTF-8 decoding: malformed bytes throw, and a byte order mark is kept rather than skipped. */
export function decodeUtf8(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
export async function sha256Bytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  let hex = '';
  for (const byte of await sha256Bytes(bytes)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

// Controls (C0 and C1), lone surrogates, line and paragraph separators, and the
// bidirectional marks, embeddings, overrides and isolates that can reorder text.
const NAME_FORBIDDEN = /[\p{Cc}\p{Cs}\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
/**
 * A user-defined name: Unicode NFC, without leading or trailing white space,
 * 1..128 code points, and none of the characters in NAME_FORBIDDEN. Russian
 * and English text are both accepted.
 */
export function normalizeName(input: unknown): string {
  if (typeof input !== 'string') throw invalid('A name must be a string');
  // Each code point is at most two UTF-16 code units; reject longer input before normalizing it.
  if (input.length > 4 * MAX_NAME_CODE_POINTS + 64) throw invalid(`A name may have at most ${MAX_NAME_CODE_POINTS} characters`);
  if (LONE_SURROGATE.test(input)) throw invalid('A name must be well-formed Unicode');
  const name = input.normalize('NFC').trim();
  if (NAME_FORBIDDEN.test(name)) throw invalid('A name may not contain control, line-separator or bidirectional-control characters');
  // The name is well-formed, so every low surrogate ends a pair: count all other code units.
  let codePoints = 0;
  for (let i = 0; i < name.length; i++) {
    const unit = name.charCodeAt(i);
    if (unit < 0xdc00 || unit > 0xdfff) codePoints++;
  }
  if (codePoints < 1 || codePoints > MAX_NAME_CODE_POINTS) throw invalid(`A name must have 1 to ${MAX_NAME_CODE_POINTS} characters`);
  return name;
}

function validTimestamp(text: string): boolean {
  const time = Date.parse(text);
  return TIMESTAMP.test(text) && Number.isFinite(time) && new Date(time).toISOString() === text;
}
/** Exported for archive manifests, which share the timestamp format. */
export function checkTimestamp(text: string, field: string): void {
  if (!validTimestamp(text)) throw invalid(`${field} must be an existing UTC time written as YYYY-MM-DDTHH:mm:ss.sssZ`);
}

function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

/** Validates a parsed JSON value as a record envelope v1. Expects a fresh value from JSON.parse. */
function validateRecord(value: unknown, validators: PayloadValidators): ProjectRecord {
  if (!validateEnvelope(value)) throw invalid(`Record rejected by the project schema: ${schemaErrors(validateEnvelope)}`);
  const record = value;
  if (normalizeName(record.name) !== record.name) throw invalid('Record names must be NFC without leading or trailing white space');
  checkTimestamp(record.createdAt, 'createdAt');
  if ((record.kind === 'project') !== (record.projectId === record.id))
    throw invalid('projectId must equal id for a project record and differ from it otherwise');
  for (let i = 1; i < record.dependencies.length; i++)
    if ((record.dependencies[i - 1]?.sha256 ?? '') >= (record.dependencies[i]?.sha256 ?? ''))
      throw invalid('Dependencies must be sorted by sha256 without duplicates');
  const validator = validators[record.kind];
  if (validator) {
    try {
      validator(record.payload);
    } catch (cause) {
      throw invalid(`The ${record.kind} payload is invalid: ${cause instanceof Error ? cause.message : 'rejected'}`, cause);
    }
  }
  return freezeDeep(record);
}

/** Canonicalizes, validates and addresses a record. */
export async function encodeRecord(value: unknown, validators: PayloadValidators = {}): Promise<StoredVersion> {
  const text = canonicalJson(value, MAX_RECORD_BYTES);
  const bytes = ENCODER.encode(text);
  if (bytes.byteLength > MAX_RECORD_BYTES) throw invalid(`A record may have at most ${MAX_RECORD_BYTES} bytes`);
  const record = validateRecord(JSON.parse(text), validators);
  return { sha256: await sha256Hex(bytes), bytes, record };
}

/** Parses stored or imported bytes, which must be exactly the canonical form of a valid record. */
export async function decodeRecord(input: Uint8Array, validators: PayloadValidators = {}): Promise<StoredVersion> {
  if (input.byteLength < 2 || input.byteLength > MAX_RECORD_BYTES) throw invalid(`A record must have 2 to ${MAX_RECORD_BYTES} bytes`);
  const bytes = new Uint8Array(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch (cause) {
    throw invalid('A record must be UTF-8 JSON', cause);
  }
  if (!equalBytes(canonicalBytes(parsed, MAX_RECORD_BYTES), bytes)) throw invalid('Record bytes are not canonical JSON');
  const record = validateRecord(parsed, validators);
  return { sha256: await sha256Hex(bytes), bytes, record };
}
