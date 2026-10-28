// TASK-136 (S16, S01): local project store with immutable, content-addressed
// versions and project archives. The oracles are independent of the
// implementation: the RFC 8785 canonicalization examples, a record
// canonicalized and hashed by Python's json and hashlib (constants below),
// Unicode NFC compositions, and archives parsed and rebuilt here from the
// documented byte layout with node:crypto hashes.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  ARCHIVE_HEADER_BYTES, ARCHIVE_MAGIC, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES, MAX_MANIFEST_BYTES, decodeArchive,
} from '../packages/project/src/archive';
import {
  MAX_DEPENDENCIES, MAX_JSON_DEPTH, MAX_NAME_CODE_POINTS, MAX_RECORD_BYTES, ProjectStoreError, canonicalJson,
  decodeRecord, encodeRecord, normalizeName, sha256Hex, type StoredVersion,
} from '../packages/project/src/schema';
import {
  MemoryBackend, ProjectStore, toRow, type ProjectStoreOptions, type StorageManagerLike,
} from '../packages/project/src/store';

const UNKNOWN_ID = '00000000-0000-4000-8000-ffffffffffff';

/**
 * Names a user typed in Russian. Source files outside docs/ru/ hold no Cyrillic
 * characters, so the names are escaped; each comment gives the meaning in English.
 */
const RU = {
  /** "Project: X8 octocopter" */
  project: '\u{41f}\u{440}\u{43e}\u{435}\u{43a}\u{442}: \u{43e}\u{43a}\u{442}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8',
  /** "Quadcopter X8" */
  quad: '\u{41a}\u{432}\u{430}\u{434}\u{440}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8',
  /** "Quadcopter X8 (rev. B)" */
  quadRevB: '\u{41a}\u{432}\u{430}\u{434}\u{440}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8 (\u{440}\u{435}\u{434}. B)',
  /** "Quadcopter X8 B" */
  quadB: '\u{41a}\u{432}\u{430}\u{434}\u{440}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8 B',
  /** "Quadcopter X8 — copy" */
  quadCopy: '\u{41a}\u{432}\u{430}\u{434}\u{440}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8 — \u{43a}\u{43e}\u{43f}\u{438}\u{44f}',
  /** "Quadcopter X8 — test No. 1 (Hexa)" */
  quadTest: '\u{41a}\u{432}\u{430}\u{434}\u{440}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8 — \u{442}\u{435}\u{441}\u{442} №1 (Hexa)',
  /** "Hover — hovering" */
  hover: 'Hover — \u{432}\u{438}\u{441}\u{435}\u{43d}\u{438}\u{435}',
  /** "Hover — renamed" */
  hoverRenamed: 'Hover — \u{43f}\u{435}\u{440}\u{435}\u{438}\u{43c}\u{435}\u{43d}\u{43e}\u{432}\u{430}\u{43d}\u{43e}',
  /** "Motor T-Motor MN3110 KV780" */
  motor: '\u{41c}\u{43e}\u{442}\u{43e}\u{440} T-Motor MN3110 KV780',
};

/** Resolves to the ProjectStoreError code, or 'resolved' when the action succeeds. */
async function codeOf(action: () => unknown): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ProjectStoreError) return error.code;
    throw error;
  }
  return 'resolved';
}

/** JSON escape text such as a backslash, 'u' and '20ac', built from parts so the source holds the escape, not the character. */
function jsonEscape(hex: string): string {
  return '\\' + 'u' + hex;
}

/** Deterministic clock and UUID v4 source; the seed keeps stores' identifiers distinct. */
function sequence(seed: number): { now: () => Date; uuid: () => string } {
  let tick = 0, ids = 0;
  return {
    now: () => new Date(Date.UTC(2026, 9, 28, 12, 0, tick++)),
    uuid: () => `00000000-0000-4000-8000-${seed.toString(16).padStart(4, '0')}${(++ids).toString(16).padStart(8, '0')}`,
  };
}

function newStore(seed: number, options: Partial<ProjectStoreOptions> = {}): { store: ProjectStore; backend: MemoryBackend } {
  const backend = new MemoryBackend();
  return { store: new ProjectStore(backend, { ...sequence(seed), storage: null, ...options }), backend };
}

async function buildProject(store: ProjectStore): Promise<Record<'project' | 'motor' | 'profile' | 'experiment', StoredVersion>> {
  const project = await store.createProject(RU.project);
  const motor = await store.createItem(project.record.id, 'component-card',
    { name: 'Motor MN3110 KV780', payload: { kvRpmPerV: 780 } });
  const profile = await store.createItem(project.record.id, 'aircraft-profile',
    { name: RU.quad, payload: { arms: 4, motorsPerArm: 2 }, dependencies: [motor.sha256] });
  const experiment = await store.createItem(project.record.id, 'experiment',
    { name: RU.hover, payload: { task: 'hover', durationS: 60 }, dependencies: [profile.sha256, motor.sha256] });
  return { project, motor, profile, experiment };
}

function sortedDependencies(...items: StoredVersion[]): { kind: string; sha256: string }[] {
  return items.map(v => ({ kind: v.record.kind, sha256: v.sha256 })).sort((a, b) => a.sha256 < b.sha256 ? -1 : 1);
}

// ---- Independent archive reader and writer (documented layout, node:crypto) ----

interface RawEntry { bytes: number; id: string; kind: string; sha256: string; version: number }
interface RawManifest { entries: RawEntry[]; exportedAt: string; format: string; formatVersion: number; projectId: string }
interface RawArchive { manifest: RawManifest; entries: Uint8Array<ArrayBuffer>[] }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function asRawManifest(value: unknown): RawManifest {
  if (!isObject(value) || !Array.isArray(value.entries) || typeof value.exportedAt !== 'string' ||
    typeof value.format !== 'string' || typeof value.formatVersion !== 'number' || typeof value.projectId !== 'string')
    throw new Error('Unexpected manifest');
  const entries = value.entries.map((entry: unknown): RawEntry => {
    if (!isObject(entry) || typeof entry.bytes !== 'number' || typeof entry.id !== 'string' || typeof entry.kind !== 'string' ||
      typeof entry.sha256 !== 'string' || typeof entry.version !== 'number') throw new Error('Unexpected manifest entry');
    return { bytes: entry.bytes, id: entry.id, kind: entry.kind, sha256: entry.sha256, version: entry.version };
  });
  return { entries, exportedAt: value.exportedAt, format: value.format, formatVersion: value.formatVersion, projectId: value.projectId };
}
function parseRaw(archive: Uint8Array): RawArchive {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  expect(view.getUint32(0, true)).toBe(0x4a52504d);
  expect(view.getUint32(4, true)).toBe(1);
  const manifestBytes = view.getUint32(8, true), count = view.getUint32(12, true), payload = view.getUint32(16, true);
  expect(archive.subarray(20, 32).every(byte => byte === 0)).toBe(true);
  const unsealed = archive.slice();
  unsealed.fill(0, 32, 64);
  expect(createHash('sha256').update(unsealed).digest().equals(archive.subarray(32, 64))).toBe(true);
  const manifest = asRawManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(archive.subarray(64, 64 + manifestBytes))));
  const entries: Uint8Array<ArrayBuffer>[] = [];
  let offset = 64 + manifestBytes;
  for (const entry of manifest.entries) {
    entries.push(archive.slice(offset, offset + entry.bytes));
    offset += entry.bytes;
  }
  expect([entries.length, offset - 64 - manifestBytes, offset]).toEqual([count, payload, archive.byteLength]);
  return { manifest, entries };
}
/** Sorted-key JSON for the ASCII keys, strings and integers of a test manifest. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => sortedJson(item)).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function buildRaw(manifest: RawManifest, entries: readonly Uint8Array[], header: { magic?: number; version?: number; manifestText?: string } = {}): Uint8Array<ArrayBuffer> {
  const manifestBytes = new TextEncoder().encode(header.manifestText ?? sortedJson(manifest));
  const payload = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  const out = new Uint8Array(64 + manifestBytes.byteLength + payload), view = new DataView(out.buffer);
  view.setUint32(0, header.magic ?? 0x4a52504d, true);
  view.setUint32(4, header.version ?? 1, true);
  view.setUint32(8, manifestBytes.byteLength, true);
  view.setUint32(12, manifest.entries.length, true);
  view.setUint32(16, payload, true);
  out.set(manifestBytes, 64);
  let offset = 64 + manifestBytes.byteLength;
  for (const entry of entries) {
    out.set(entry, offset);
    offset += entry.byteLength;
  }
  out.set(createHash('sha256').update(out).digest(), 32);
  return out;
}
function describeEntry(bytes: Uint8Array, base: RawEntry): RawEntry {
  return { ...base, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function rebuildWithout(raw: RawArchive, keep: (entry: RawEntry) => boolean): Uint8Array<ArrayBuffer> {
  const indices = raw.manifest.entries.flatMap((entry, index) => keep(entry) ? [index] : []);
  return buildRaw({ ...raw.manifest, entries: indices.map(i => raw.manifest.entries[i] ?? fail()) },
    indices.map(i => raw.entries[i] ?? fail()));
}
function fail(): never {
  throw new Error('Index out of range');
}
function flipped(archive: Uint8Array<ArrayBuffer>, offset: number): Uint8Array<ArrayBuffer> {
  const copy = archive.slice();
  copy[offset] = (copy[offset] ?? 0) ^ 0x01;
  return copy;
}
function header(fields: { magic?: number; version?: number; manifest?: number; entries?: number; payload?: number }): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(ARCHIVE_HEADER_BYTES), view = new DataView(bytes.buffer);
  view.setUint32(0, fields.magic ?? ARCHIVE_MAGIC, true);
  view.setUint32(4, fields.version ?? 1, true);
  view.setUint32(8, fields.manifest ?? 2, true);
  view.setUint32(12, fields.entries ?? 1, true);
  view.setUint32(16, fields.payload ?? 2, true);
  return bytes;
}
/** A real Blob that reports a chosen size and counts reads of its contents. */
function spyBlob(size: number, prefix: Uint8Array<ArrayBuffer>): { blob: Blob; calls: { slices: number; reads: number } } {
  const blob = new Blob([prefix]), calls = { slices: 0, reads: 0 };
  Object.defineProperty(blob, 'size', { value: size });
  Object.defineProperty(blob, 'slice', { value: (start?: number, end?: number) => {
    calls.slices++;
    return new Blob([prefix.slice(start, end)]);
  } });
  Object.defineProperty(blob, 'arrayBuffer', { value: () => {
    calls.reads++;
    return Promise.reject(new Error('Full read attempted'));
  } });
  return { blob, calls };
}

describe('canonical JSON (RFC 8785)', () => {
  test('serializes numbers, strings and literals as in the RFC 8785 example', () => {
    const input: unknown = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"' +
      jsonEscape('20ac') + '$' + jsonEscape('000F') + jsonEscape('000a') + "A'" + jsonEscape('0042') + jsonEscape('0022') +
      jsonEscape('005c') + '\\\\\\"\\/","literals":[null,true,false]}');
    expect(canonicalJson(input)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"\u{20ac}$' + jsonEscape('000f') + '\\nA\'B\\"\\\\\\\\\\"/"}');
  });

  test('sorts properties by UTF-16 code units as in the RFC 8785 example', () => {
    const input = {
      '\u{20ac}': 'Euro Sign', '\r': 'Carriage Return', '\u{fb33}': 'Hebrew Letter Dalet With Dagesh', '1': 'One',
      '\u{1f600}': 'Emoji: Grinning Face', '\u{80}': 'Control', '\u{f6}': 'Latin Small Letter O With Diaeresis',
    };
    expect(canonicalJson(input)).toBe('{"\\r":"Carriage Return","1":"One","\u{80}":"Control",' +
      '"\u{f6}":"Latin Small Letter O With Diaeresis","\u{20ac}":"Euro Sign","\u{1f600}":"Emoji: Grinning Face",' +
      '"\u{fb33}":"Hebrew Letter Dalet With Dagesh"}');
  });

  test('rejects values that are not plain JSON and bounds nesting depth', () => {
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    let deep: unknown = 0, deepest: unknown = 0;
    for (let i = 0; i < MAX_JSON_DEPTH + 1; i++) deep = [deep];
    for (let i = 0; i < MAX_JSON_DEPTH; i++) deepest = [deepest];
    const rejected: unknown[] = [
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, () => 1, Symbol('s'), 1n,
      new Date(0), new Map(), new Uint8Array(1), new (class Point { x = 1; })(), sparse, Object.assign([1], { label: 'x' }),
      Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 }), { [Symbol('s')]: 1 },
      JSON.parse('{"__proto__":1}'), '\u{d800}', { '\u{dc00}': 1 }, { a: undefined }, deep,
    ];
    for (const value of rejected) expect(() => canonicalJson(value)).toThrow(ProjectStoreError);
    expect(canonicalJson(deepest)).toBe('['.repeat(MAX_JSON_DEPTH) + '0' + ']'.repeat(MAX_JSON_DEPTH));
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ b: [true, null], a: '\u{e9}' })).toBe('{"a":"\u{e9}","b":[true,null]}');
  });
});

describe('record addressing and the envelope schema', () => {
  // Python 3.13: json.dumps(record, sort_keys=True, separators=(',', ':'), ensure_ascii=False),
  // then hashlib.sha256 over its UTF-8 bytes. The note is the NFC text U+0401 U+043B U+043A U+0430,
  // a space and U+00E9.
  const NOTE = '\u{401}\u{43b}\u{43a}\u{430} \u{e9}';
  const PYTHON_CANONICAL = '{"createdAt":"2026-10-28T12:00:00.000Z","dependencies":[],"id":"3f1c2a9e-8b7d-4c6e-9f00-112233445566",' +
    `"kind":"component-card","name":"${RU.motor}","origin":null,` +
    `"payload":{"kvRpmPerV":780,"massKg":0.078,"note":"${NOTE}"},"previous":null,` +
    '"projectId":"0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3","schemaVersion":1,"version":1}';
  const PYTHON_SHA256 = '10c1d0abfd430c84d0b1d42ce4f2e2f039dc9996e2b4ee81fc8accf021a34866';
  const record = {
    schemaVersion: 1, kind: 'component-card', id: '3f1c2a9e-8b7d-4c6e-9f00-112233445566',
    projectId: '0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3', version: 1, previous: null, origin: null,
    name: RU.motor, createdAt: '2026-10-28T12:00:00.000Z', dependencies: [],
    payload: { kvRpmPerV: 780, massKg: 0.078, note: NOTE },
  };
  const A = 'a'.repeat(64), B = 'b'.repeat(64);

  test('SHA-256 matches the FIPS 180-2 "abc" example', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('a record is addressed by the SHA-256 of its canonical JSON bytes', async () => {
    const stored = await encodeRecord(record);
    expect(new TextDecoder().decode(stored.bytes)).toBe(PYTHON_CANONICAL);
    expect([stored.bytes.byteLength, stored.sha256]).toEqual([342, PYTHON_SHA256]);
    const decoded = await decodeRecord(new TextEncoder().encode(PYTHON_CANONICAL));
    expect(decoded.sha256).toBe(PYTHON_SHA256);
    expect(decoded.record).toEqual(record);
    expect(Object.isFrozen(decoded.record.payload)).toBe(true);
  });

  test('stored bytes must be exactly the canonical UTF-8 form', async () => {
    const encoder = new TextEncoder();
    const variants = [
      encoder.encode(JSON.stringify(record, null, 1)),
      new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(PYTHON_CANONICAL)]),
      encoder.encode(PYTHON_CANONICAL.replace('{"createdAt"', '{"createdAt":"2026-10-28T12:00:00.000Z","createdAt"')),
      encoder.encode(PYTHON_CANONICAL.replace('"version":1}', '"version":1.0}')),
      encoder.encode(PYTHON_CANONICAL.replace('\u{e9}', jsonEscape('00e9'))),
      new Uint8Array([0xff, 0xfe]),
    ];
    for (const bytes of variants) expect(await codeOf(() => decodeRecord(bytes))).toBe('invalid');
  });

  test('the envelope schema rejects unknown fields and inconsistent records', async () => {
    const invalid: unknown[] = [
      { ...record, extra: 1 }, { ...record, schemaVersion: 2 }, { ...record, kind: 'mission' },
      { ...record, id: 'not-a-uuid' }, { ...record, id: record.id.toUpperCase() }, { ...record, version: 0 },
      { ...record, version: 1.5 }, { ...record, previous: A }, { ...record, version: 2 },
      { ...record, version: 2, previous: A, origin: { copiedFrom: B } },
      { ...record, createdAt: '2026-02-30T12:00:00.000Z' }, { ...record, createdAt: '2026-10-28T12:00:00Z' },
      // A name in NFD (U+0415 U+0308 instead of U+0401) and a name with leading white space.
      { ...record, name: '\u{415}\u{308}\u{43b}\u{43a}\u{430}' }, { ...record, name: ' padded' }, { ...record, payload: [] },
      { ...record, dependencies: [{ kind: 'component-card', sha256: A }] },
      { ...record, kind: 'project' }, { ...record, kind: 'project', projectId: record.id, payload: { a: 1 } },
      { ...record, kind: 'aircraft-profile', projectId: record.id },
      { ...record, kind: 'aircraft-profile', dependencies: [{ kind: 'component-card', sha256: B }, { kind: 'component-card', sha256: A }] },
      { ...record, kind: 'aircraft-profile', dependencies: [{ kind: 'component-card', sha256: A }, { kind: 'component-card', sha256: A }] },
      { ...record, kind: 'aircraft-profile', dependencies: [{ kind: 'experiment', sha256: A }] },
      { ...record, kind: 'experiment', dependencies: [{ kind: 'experiment', sha256: A }] },
    ];
    for (const value of invalid) expect(await codeOf(() => encodeRecord(value))).toBe('invalid');
    const valid: unknown[] = [
      { ...record, kind: 'aircraft-profile', dependencies: [{ kind: 'component-card', sha256: A }, { kind: 'component-card', sha256: B }] },
      { ...record, kind: 'experiment', dependencies: [{ kind: 'aircraft-profile', sha256: A }, { kind: 'component-card', sha256: B }] },
      { ...record, kind: 'project', projectId: record.id, payload: {} },
      { ...record, version: 2, previous: A }, { ...record, origin: { copiedFrom: A } },
    ];
    for (const value of valid) expect(await codeOf(() => encodeRecord(value))).toBe('resolved');
  });

  test('records are limited to 1 MiB and 256 dependencies', async () => {
    expect(await codeOf(() => encodeRecord({ ...record, payload: { text: 'x'.repeat(MAX_RECORD_BYTES) } }))).toBe('invalid');
    const many = Array.from({ length: MAX_DEPENDENCIES + 1 }, (_, i) => ({ kind: 'component-card', sha256: i.toString(16).padStart(64, '0') }));
    expect(await codeOf(() => encodeRecord({ ...record, kind: 'aircraft-profile', dependencies: many }))).toBe('invalid');
    expect(await codeOf(() => encodeRecord({ ...record, kind: 'aircraft-profile', dependencies: many.slice(0, MAX_DEPENDENCIES) }))).toBe('resolved');
  });
});

describe('user-defined names', () => {
  test('Cyrillic and Latin names are NFC-normalized and trimmed', () => {
    // Decomposed Cyrillic letters compose: U+0415 U+0308 to U+0401 and U+0438 U+0306 to U+0439.
    expect(normalizeName('  \u{415}\u{308}\u{43b}\u{43a}\u{430}  ')).toBe('\u{401}\u{43b}\u{43a}\u{430}');
    expect(normalizeName('\u{438}\u{306}')).toBe('\u{439}');
    expect(normalizeName('Cafe\u{301}')).toBe('Caf\u{e9}');
    const mixed = RU.quadTest;
    expect(normalizeName(mixed)).toBe(mixed);
    const astral = '\u{1f681}'.repeat(MAX_NAME_CODE_POINTS);
    expect(normalizeName(astral)).toBe(astral);
  });

  test('rejects empty, overlong, control and bidirectional-control names', () => {
    for (const name of ['', '   ', 'x'.repeat(MAX_NAME_CODE_POINTS + 1), 'a\u{0}b', 'a\nb', 'a\u{85}b', 'a\u{202e}b', 'a\u{2066}b', 'a\u{2028}b', '\u{d800}x'])
      expect(() => normalizeName(name)).toThrow(ProjectStoreError);
  });
});

describe('versions', () => {
  test('an edit creates a new version and leaves earlier experiment inputs byte-identical', async () => {
    const { store } = newStore(1);
    const { project, motor, profile, experiment } = await buildProject(store);
    const before = await Promise.all([experiment, profile, motor].map(async v => (await store.get(v.sha256)).bytes.slice()));
    const motor2 = await store.saveVersion(motor.record.id, motor.sha256, { name: 'Motor MN3110 KV780', payload: { kvRpmPerV: 800 } });
    const profile2 = await store.saveVersion(profile.record.id, profile.sha256,
      { name: RU.quadRevB, payload: { arms: 4, motorsPerArm: 2, armLengthM: 0.4 }, dependencies: [motor2.sha256] });
    const after = await Promise.all([experiment, profile, motor].map(async v => (await store.get(v.sha256)).bytes));
    expect(after).toEqual(before);
    expect((await store.get(experiment.sha256)).record.dependencies).toEqual(sortedDependencies(profile, motor));
    expect((await store.history(profile.record.id)).map(v => [v.record.version, v.record.previous])).toEqual([[1, null], [2, profile.sha256]]);
    expect((await store.head(profile.record.id))?.sha256).toBe(profile2.sha256);
    expect(profile2.record).toMatchObject({ name: RU.quadRevB, projectId: project.record.id, version: 2, origin: null });
    expect(profile2.record.dependencies).toEqual(sortedDependencies(motor2));
  });

  test('a save needs the current head and an unchanged draft creates no version', async () => {
    const { store, backend } = newStore(1);
    const { motor } = await buildProject(store);
    const motor2 = await store.saveVersion(motor.record.id, motor.sha256, { name: 'Motor B', payload: { kvRpmPerV: 800 } });
    const totals = await backend.totals();
    expect(await codeOf(() => store.saveVersion(motor.record.id, motor.sha256, { name: 'Motor C', payload: {} }))).toBe('conflict');
    expect((await store.saveVersion(motor.record.id, motor2.sha256, { name: ' Motor B ', payload: { kvRpmPerV: 800 } })).sha256).toBe(motor2.sha256);
    expect(await backend.totals()).toEqual(totals);
    expect(await codeOf(() => store.saveVersion(UNKNOWN_ID, motor.sha256, { name: 'X', payload: {} }))).toBe('not-found');
    expect(await codeOf(() => store.saveVersion(motor.record.id, motor2.sha256, { name: 'X', payload: { bad: Number.NaN } }))).toBe('invalid');
    expect(await backend.totals()).toEqual(totals);
  });

  test('experiment inputs are frozen; a later version may only rename', async () => {
    const { store } = newStore(1);
    const { motor, profile, experiment } = await buildProject(store);
    const inputs = experiment.record.dependencies.map(d => d.sha256);
    const renamed = await store.saveVersion(experiment.record.id, experiment.sha256,
      { name: RU.hoverRenamed, payload: experiment.record.payload, dependencies: inputs });
    expect([renamed.record.version, renamed.record.payload, renamed.record.dependencies]).toEqual([2, experiment.record.payload, experiment.record.dependencies]);
    expect(await codeOf(() => store.saveVersion(experiment.record.id, renamed.sha256,
      { name: renamed.record.name, payload: { task: 'land', durationS: 60 }, dependencies: inputs }))).toBe('invalid');
    expect(await codeOf(() => store.saveVersion(experiment.record.id, renamed.sha256,
      { name: renamed.record.name, payload: experiment.record.payload, dependencies: [profile.sha256] }))).toBe('invalid');
    expect(await codeOf(() => store.saveVersion(experiment.record.id, renamed.sha256,
      { name: renamed.record.name, payload: experiment.record.payload, dependencies: [motor.sha256] }))).toBe('invalid');
  });

  test('dependencies must exist in the same project with an allowed kind', async () => {
    const { store } = newStore(1);
    const { project, motor, experiment } = await buildProject(store);
    const id = project.record.id;
    expect(await codeOf(() => store.createItem(id, 'aircraft-profile', { name: 'P', payload: {}, dependencies: ['f'.repeat(64)] }))).toBe('missing-dependency');
    expect(await codeOf(() => store.createItem(id, 'aircraft-profile', { name: 'P', payload: {}, dependencies: [experiment.sha256] }))).toBe('invalid');
    expect(await codeOf(() => store.createItem(id, 'component-card', { name: 'C', payload: {}, dependencies: [motor.sha256] }))).toBe('invalid');
    expect(await codeOf(() => store.createItem(id, 'aircraft-profile', { name: 'P', payload: {}, dependencies: [motor.sha256, motor.sha256] }))).toBe('invalid');
    expect(await codeOf(() => store.createItem(id, 'aircraft-profile', { name: 'P', payload: {}, dependencies: ['F'.repeat(64)] }))).toBe('invalid');
    const other = await store.createProject('Other');
    expect(await codeOf(() => store.createItem(other.record.id, 'aircraft-profile', { name: 'P', payload: {}, dependencies: [motor.sha256] }))).toBe('invalid');
    expect(await codeOf(() => store.createItem(UNKNOWN_ID, 'component-card', { name: 'C', payload: {} }))).toBe('not-found');
    expect(await codeOf(() => store.createItem(motor.record.id, 'component-card', { name: 'C', payload: {} }))).toBe('not-found');
    expect(await codeOf(() => store.createItem(id, 'component-card', { name: 'C', payload: [] }))).toBe('invalid');
    expect(await codeOf(() => store.createItem(id, 'component-card', { name: '\u{202e}', payload: {} }))).toBe('invalid');
  });

  test('copy creates an independent item and leaves the original unchanged', async () => {
    const { store } = newStore(1);
    const { project, profile } = await buildProject(store);
    const historyBefore = await store.history(profile.record.id);
    const copy = await store.copyItem(profile.sha256, RU.quadCopy);
    expect(copy.record.id).not.toBe(profile.record.id);
    expect(copy.record).toMatchObject({ kind: 'aircraft-profile', projectId: project.record.id, version: 1, previous: null,
      origin: { copiedFrom: profile.sha256 }, name: RU.quadCopy });
    expect([copy.record.payload, copy.record.dependencies]).toEqual([profile.record.payload, profile.record.dependencies]);
    const edited = await store.saveVersion(copy.record.id, copy.sha256,
      { name: copy.record.name, payload: { arms: 8, motorsPerArm: 2 }, dependencies: copy.record.dependencies.map(d => d.sha256) });
    expect([edited.record.version, edited.record.origin]).toEqual([2, null]);
    expect(await store.history(profile.record.id)).toEqual(historyBefore);
    expect(await codeOf(() => store.copyItem(project.sha256, 'Copy'))).toBe('invalid');
    expect(await codeOf(() => store.copyItem('e'.repeat(64), 'Copy'))).toBe('not-found');
  });

  test('lists project and item heads', async () => {
    const { store } = newStore(1);
    const { project, motor, profile, experiment } = await buildProject(store);
    const profile2 = await store.saveVersion(profile.record.id, profile.sha256, { name: RU.quadB, payload: {}, dependencies: [] });
    const hexa = await store.createProject('Hexa test');
    expect((await store.listProjects()).map(v => v.record.name)).toEqual(['Hexa test', RU.project]);
    expect((await store.listItems(project.record.id)).map(v => v.sha256)).toEqual([motor.sha256, profile2.sha256, experiment.sha256]);
    expect((await store.listItems(project.record.id, 'aircraft-profile')).map(v => v.sha256)).toEqual([profile2.sha256]);
    expect(await store.listItems(hexa.record.id)).toEqual([]);
    expect(await codeOf(() => store.listItems(UNKNOWN_ID))).toBe('not-found');
    expect(await codeOf(() => store.get('0'.repeat(64)))).toBe('not-found');
    expect(await store.head(UNKNOWN_ID)).toBeNull();
  });

  test('registered payload validators gate saves and imports', async () => {
    const validators = { 'component-card': (payload: unknown) => {
      if (!isObject(payload) || typeof payload.kvRpmPerV !== 'number') throw new Error('kvRpmPerV is required');
    } };
    const strict = newStore(2, { validators });
    const project = await strict.store.createProject('Strict');
    expect(await codeOf(() => strict.store.createItem(project.record.id, 'component-card', { name: 'C', payload: {} }))).toBe('invalid');
    expect(await codeOf(() => strict.store.createItem(project.record.id, 'component-card', { name: 'C', payload: { kvRpmPerV: 780 } }))).toBe('resolved');
    const plain = newStore(3);
    const other = await plain.store.createProject('Plain');
    await plain.store.createItem(other.record.id, 'component-card', { name: 'C', payload: {} });
    const { archive } = await plain.store.exportProject(other.record.id);
    expect(await codeOf(() => strict.store.importArchive(archive))).toBe('archive-invalid');
  });
});

describe('project archives', () => {
  test('export and import round-trip every version byte for byte', async () => {
    const a = newStore(1);
    const { project, profile } = await buildProject(a.store);
    await a.store.saveVersion(profile.record.id, profile.sha256, { name: RU.quadB, payload: { arms: 4 }, dependencies: [] });
    const exported = await a.store.exportProject(project.record.id);
    expect([exported.entries, exported.bytes, exported.missing]).toEqual([5, exported.archive.byteLength, []]);
    const raw = parseRaw(exported.archive);
    expect(buildRaw(raw.manifest, raw.entries)).toEqual(exported.archive);
    expect(raw.manifest).toMatchObject({ format: 'mirage-project-archive', formatVersion: 1, projectId: project.record.id });
    expect(raw.manifest.entries.map(e => [e.kind, e.version])).toEqual(
      [['project', 1], ['component-card', 1], ['aircraft-profile', 1], ['aircraft-profile', 2], ['experiment', 1]]);

    const b = newStore(2);
    const report = await b.store.importArchive(exported.archive);
    expect(report).toMatchObject({ projectId: project.record.id, added: 5, unchanged: 0, missing: [] });
    expect(report.items.map(i => [i.kind, i.status, i.localVersion, i.importedVersion])).toEqual([
      ['project', 'new', 0, 1], ['component-card', 'new', 0, 1], ['aircraft-profile', 'new', 0, 2], ['experiment', 'new', 0, 1]]);
    for (const [index, entry] of raw.manifest.entries.entries())
      expect((await b.store.get(entry.sha256)).bytes).toEqual(raw.entries[index]);
    expect((await b.store.listProjects()).map(v => v.record.name)).toEqual([RU.project]);
    expect((await b.store.listItems(project.record.id)).map(v => v.record.name)).toEqual(['Motor MN3110 KV780', RU.quadB, RU.hover]);

    const again = await b.store.importArchive(exported.archive);
    expect([again.added, again.unchanged, again.items.every(i => i.status === 'unchanged')]).toEqual([0, 5, true]);
    expect((await a.store.importArchive(exported.archive)).added).toBe(0);
    const c = newStore(3);
    expect((await c.store.importArchive(new Blob([exported.archive]))).added).toBe(5);
  });

  test('exports are deterministic for a fixed clock', async () => {
    const fixed = () => new Date(Date.UTC(2026, 9, 28, 12));
    const { store } = newStore(1, { now: fixed });
    const { project } = await buildProject(store);
    const first = await store.exportProject(project.record.id), second = await store.exportProject(project.record.id);
    expect(second.archive).toEqual(first.archive);
  });

  test('import fast-forwards older copies and refuses a diverged history without changes', async () => {
    const a = newStore(1), b = newStore(2);
    const { project, profile } = await buildProject(a.store);
    await b.store.importArchive((await a.store.exportProject(project.record.id)).archive);
    const profileA2 = await a.store.saveVersion(profile.record.id, profile.sha256, { name: 'A edit', payload: { arms: 6 }, dependencies: [] });
    const second = (await a.store.exportProject(project.record.id)).archive;
    const forward = await b.store.importArchive(second);
    expect(forward.added).toBe(1);
    expect(forward.items.find(i => i.id === profile.record.id)).toMatchObject({ status: 'fast-forward', localVersion: 1, importedVersion: 2 });
    await a.store.saveVersion(profile.record.id, profileA2.sha256, { name: 'A again', payload: { arms: 8 }, dependencies: [] });
    await b.store.saveVersion(profile.record.id, profileA2.sha256, { name: 'B edit', payload: { arms: 4 }, dependencies: [] });
    const totals = await b.backend.totals();
    expect(await codeOf(async () => b.store.importArchive((await a.store.exportProject(project.record.id)).archive))).toBe('conflict');
    expect(await b.backend.totals()).toEqual(totals);
    const older = await b.store.importArchive(second);
    expect([older.added, older.items.find(i => i.id === profile.record.id)?.status]).toEqual([0, 'local-newer']);
  });

  test('an import reports each missing dependency', async () => {
    const a = newStore(1);
    const { project, motor, profile, experiment } = await buildProject(a.store);
    const motor2 = await a.store.saveVersion(motor.record.id, motor.sha256, { name: 'Motor v2', payload: { kvRpmPerV: 800 } });
    const profile2 = await a.store.saveVersion(profile.record.id, profile.sha256, { name: 'Profile v2', payload: {}, dependencies: [motor2.sha256] });
    const raw = parseRaw((await a.store.exportProject(project.record.id)).archive);
    const withoutMotor = rebuildWithout(raw, entry => entry.id !== motor.record.id);
    const requiredBy = (v: StoredVersion) => ({ sha256: v.sha256, kind: v.record.kind, id: v.record.id, version: v.record.version, name: v.record.name });
    const expected = [
      { kind: 'component-card', sha256: motor.sha256, requiredBy: [requiredBy(profile), requiredBy(experiment)] },
      { kind: 'component-card', sha256: motor2.sha256, requiredBy: [requiredBy(profile2)] },
    ].sort((x, y) => x.sha256 < y.sha256 ? -1 : 1);
    const b = newStore(2);
    const report = await b.store.importArchive(withoutMotor);
    expect([report.added, report.missing]).toEqual([4, expected]);
    expect(await b.store.missingDependencies(project.record.id)).toEqual(expected);
    expect((await b.store.exportProject(project.record.id)).missing).toEqual(expected);
    expect(await codeOf(() => b.store.copyItem(profile2.sha256, 'Copy'))).toBe('missing-dependency');
    expect((await a.store.importArchive(withoutMotor)).missing).toEqual([]);
  });

  test('rejects archives that are inconsistent with their records', async () => {
    const a = newStore(1);
    const { project, profile } = await buildProject(a.store);
    await a.store.saveVersion(profile.record.id, profile.sha256, { name: 'v2', payload: {}, dependencies: [] });
    const raw = parseRaw((await a.store.exportProject(project.record.id)).archive);
    const b = newStore(2);
    const cases = [
      rebuildWithout(raw, entry => entry.kind !== 'project'),
      rebuildWithout(raw, entry => !(entry.id === profile.record.id && entry.version === 1)),
      buildRaw({ ...raw.manifest, projectId: UNKNOWN_ID }, raw.entries),
      buildRaw({ ...raw.manifest, entries: raw.manifest.entries.map((e, i) => i === 1 ? { ...e, kind: 'experiment' } : e) }, raw.entries),
      buildRaw({ ...raw.manifest, entries: raw.manifest.entries.map((e, i) => i === 1 ? { ...e, version: 2 } : e) }, raw.entries),
      buildRaw({ ...raw.manifest, entries: [...raw.manifest.entries, raw.manifest.entries[1] ?? fail()] }, [...raw.entries, raw.entries[1] ?? fail()]),
      buildRaw({ ...raw.manifest, format: 'other' }, raw.entries),
      buildRaw(raw.manifest, raw.entries, { manifestText: JSON.stringify(raw.manifest, null, 1) }),
    ];
    for (const archive of cases) expect(await codeOf(() => b.store.importArchive(archive))).toBe('archive-invalid');
    const pretty = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(raw.entries[1])), null, 1));
    const nonCanonical = buildRaw({ ...raw.manifest, entries: raw.manifest.entries.map((e, i) => i === 1 ? describeEntry(pretty, e) : e) },
      raw.entries.map((e, i) => i === 1 ? pretty : e));
    expect(await codeOf(() => b.store.importArchive(nonCanonical))).toBe('archive-invalid');
    expect(await b.backend.totals()).toEqual({ records: 0, bytes: 0 });
  });

  test('rejects tampered archives', async () => {
    const a = newStore(1);
    const { project } = await buildProject(a.store);
    const { archive } = await a.store.exportProject(project.record.id);
    const raw = parseRaw(archive), b = newStore(2);
    const manifestBytes = new DataView(archive.buffer).getUint32(8, true);
    for (const offset of [ARCHIVE_HEADER_BYTES + 7, ARCHIVE_HEADER_BYTES + manifestBytes + 20, archive.byteLength - 3, 40])
      expect(await codeOf(() => b.store.importArchive(flipped(archive, offset)))).toBe('archive-hash');
    for (const offset of [0, 4, 21]) expect(await codeOf(() => b.store.importArchive(flipped(archive, offset)))).toBe('archive-header');
    expect(await codeOf(() => b.store.importArchive(buildRaw(raw.manifest, raw.entries, { magic: 0x4d415241 })))).toBe('archive-header');
    expect(await codeOf(() => b.store.importArchive(buildRaw(raw.manifest, raw.entries, { version: 2 })))).toBe('archive-header');
    // Resealed: the archive digest is recomputed after one record changes, so only the per-entry hash detects it.
    const text = new TextDecoder().decode(raw.entries[1]);
    const edited = new TextEncoder().encode(text.replace('"kvRpmPerV":780', '"kvRpmPerV":980'));
    expect(edited).not.toEqual(raw.entries[1]);
    expect(await codeOf(() => b.store.importArchive(buildRaw(raw.manifest, raw.entries.map((e, i) => i === 1 ? edited : e))))).toBe('archive-hash');
    expect(await b.backend.totals()).toEqual({ records: 0, bytes: 0 });
  });

  test('rejects oversized archives before reading or allocating their contents', async () => {
    const b = newStore(2);
    const oversized = spyBlob(MAX_ARCHIVE_BYTES + 1, new Uint8Array(0));
    expect(await codeOf(() => b.store.importArchive(oversized.blob))).toBe('archive-size');
    expect(oversized.calls).toEqual({ slices: 0, reads: 0 });
    const headers = [
      header({ manifest: MAX_MANIFEST_BYTES + 1, payload: 0 }),
      header({ entries: MAX_ARCHIVE_ENTRIES + 1 }),
      header({ entries: 0 }),
      header({ manifest: 1 }),
      header({ manifest: 0xffffffff, payload: 0xffffffff }),
    ];
    for (const prefix of headers) {
      const view = new DataView(prefix.buffer), declared = ARCHIVE_HEADER_BYTES + view.getUint32(8, true) + view.getUint32(16, true);
      const spy = spyBlob(Math.min(declared, MAX_ARCHIVE_BYTES), prefix);
      expect(await codeOf(() => b.store.importArchive(spy.blob))).toBe('archive-header');
      expect(spy.calls).toEqual({ slices: 1, reads: 0 });
    }
    const inconsistent = spyBlob(ARCHIVE_HEADER_BYTES + 100, header({ manifest: 50, payload: 49 }));
    expect(await codeOf(() => b.store.importArchive(inconsistent.blob))).toBe('archive-header');
    expect(inconsistent.calls.reads).toBe(0);
    expect(await codeOf(() => decodeArchive(new Uint8Array(ARCHIVE_HEADER_BYTES - 1)))).toBe('archive-size');
    // A manifest entry above the per-record limit is refused before the entry is decoded.
    const a = newStore(1);
    const { project } = await buildProject(a.store);
    const raw = parseRaw((await a.store.exportProject(project.record.id)).archive);
    const huge = new Uint8Array(MAX_RECORD_BYTES + 1).fill(0x20);
    const oversizedEntry = buildRaw({ ...raw.manifest, entries: raw.manifest.entries.map((e, i) => i === 1 ? describeEntry(huge, e) : e) },
      raw.entries.map((e, i) => i === 1 ? huge : e));
    expect(await codeOf(() => b.store.importArchive(oversizedEntry))).toBe('archive-invalid');
  });
});

describe('storage', () => {
  test('reports store usage, the origin quota and persistence', async () => {
    const storage: StorageManagerLike = {
      estimate: () => Promise.resolve({ usage: 2048, quota: 1073741824 }),
      persisted: () => Promise.resolve(true),
    };
    const { store } = newStore(1, { storage });
    const built = await buildProject(store);
    const bytes = Object.values(built).reduce((sum, v) => sum + v.bytes.byteLength, 0);
    expect(await store.storageReport()).toEqual({ records: 4, storeBytes: bytes, usageBytes: 2048, quotaBytes: 1073741824, persisted: true });
    expect(await newStore(2).store.storageReport()).toEqual({ records: 0, storeBytes: 0, usageBytes: null, quotaBytes: null, persisted: null });
    const odd: StorageManagerLike = { estimate: () => Promise.resolve({ usage: -1 }), persisted: () => Promise.reject(new Error('denied')) };
    expect(await newStore(3, { storage: odd }).store.storageReport()).toMatchObject({ usageBytes: null, quotaBytes: null, persisted: null });
  });

  test('backend commits are atomic, idempotent and refuse forks', async () => {
    const { store, backend } = newStore(1);
    const { motor } = await buildProject(store);
    const row = await backend.get(motor.sha256);
    if (!row) throw new Error('Stored motor row missing');
    const totals = await backend.totals();
    const fresh = await encodeRecord({ ...motor.record, id: UNKNOWN_ID });
    expect(await codeOf(() => backend.commit({ adds: [toRow(fresh)], expectHeads: new Map([[motor.record.id, 'a'.repeat(64)]]) }))).toBe('conflict');
    expect(await codeOf(() => backend.commit({ adds: [toRow(fresh)], expectHeads: new Map([[UNKNOWN_ID, motor.sha256]]) }))).toBe('conflict');
    const fork = await encodeRecord({ ...motor.record, name: 'Fork' });
    expect(await codeOf(() => backend.commit({ adds: [toRow(fresh), toRow(fork)], expectHeads: new Map() }))).toBe('conflict');
    expect(await backend.totals()).toEqual(totals);
    expect(await backend.commit({ adds: [row], expectHeads: new Map([[motor.record.id, motor.sha256]]) })).toEqual({ added: 0, present: 1 });
    expect(await backend.commit({ adds: [toRow(fresh)], expectHeads: new Map([[UNKNOWN_ID, null]]) })).toEqual({ added: 1, present: 0 });
    // Stored bytes are copies: mutating a returned row cannot change the store.
    row.bytes.fill(0);
    expect((await store.get(motor.sha256)).bytes).toEqual(motor.bytes);
  });
});
