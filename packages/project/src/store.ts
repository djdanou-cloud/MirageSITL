import { decodeArchive, encodeArchive } from './archive.ts';
import {
  ALLOWED_DEPENDENCIES, ITEM_KINDS, MAX_DEPENDENCIES, MAX_VERSION, ProjectStoreError, SHA256_HEX, TIMESTAMP, UUID_V4,
  canonicalBytes, decodeRecord, decodeUtf8, encodeRecord, equalBytes, normalizeName, type ContentKind, type Dependency,
  type ItemKind, type PayloadValidators, type StoredVersion,
} from './schema.ts';
import {
  checkHistory, classifyMerge, initialRecord, repeatsHead, sameInputs, successorRecord, type Draft, type MergeStatus,
  type VersionFields,
} from './versions.ts';

// Local project store (TASK-136, S16). Projects, component cards, aircraft
// profiles and experiments are appended as immutable versions; nothing stored
// is ever rewritten or deleted here. The browser backend is IndexedDB: one
// transaction appends a version and checks the head it replaces. The data
// belong to the page's origin, so the launcher must serve the application
// from one fixed origin. Local settings (TASK-137), such as the shell's
// navigation, are mutable canonical JSON kept apart from the records and
// never exported.

/** Canonical JSON bytes of one local setting. */
export const MAX_SETTING_BYTES = 16384;
// Up to four dot-separated segments of lowercase letters, digits and hyphens, such as `shell.navigation`.
const SETTING_KEY = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,31}){0,3}$/;
function checkSettingKey(key: string): void {
  if (!SETTING_KEY.test(key)) throw new ProjectStoreError('invalid', `Invalid setting key ${JSON.stringify(key)}`);
}

/** One stored version as a backend keeps it: canonical bytes plus the fields it indexes. */
export interface StoredRow {
  readonly sha256: string;
  readonly id: string;
  readonly projectId: string;
  readonly kind: ItemKind;
  readonly version: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}
export interface CommitRequest {
  /** Rows to append in order. A row whose sha256 is already stored is counted as present. */
  readonly adds: readonly StoredRow[];
  /** The head sha256 each item must still have; null means the item must not exist yet. */
  readonly expectHeads: ReadonlyMap<string, string | null>;
}
export interface CommitResult { readonly added: number; readonly present: number }
export interface StoreTotals { readonly records: number; readonly bytes: number }
/**
 * Append-only storage of immutable rows. A commit is atomic: when a head
 * changed or a new row would give an item version a second content (a fork),
 * it throws `conflict` and stores nothing.
 */
export interface RecordBackend {
  get(sha256: string): Promise<StoredRow | undefined>;
  /** Rows of one item, ascending by version. */
  itemRows(id: string): Promise<StoredRow[]>;
  projectRows(projectId: string): Promise<StoredRow[]>;
  kindRows(kind: ItemKind): Promise<StoredRow[]>;
  totals(): Promise<StoreTotals>;
  commit(request: CommitRequest): Promise<CommitResult>;
  /** Local settings: canonical JSON bytes by key, outside the versioned records. */
  getSetting(key: string): Promise<Uint8Array<ArrayBuffer> | undefined>;
  putSetting(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): void;
}

export function toRow(version: StoredVersion): StoredRow {
  const r = version.record;
  return { sha256: version.sha256, id: r.id, projectId: r.projectId, kind: r.kind, version: r.version, bytes: version.bytes };
}
function copyRow(row: StoredRow): StoredRow {
  return { sha256: row.sha256, id: row.id, projectId: row.projectId, kind: row.kind, version: row.version, bytes: row.bytes.slice() };
}
function conflict(message: string): ProjectStoreError {
  return new ProjectStoreError('conflict', message);
}
function headChanged(id: string): ProjectStoreError {
  return conflict(`Item ${id} changed since it was read`);
}
function forked(row: StoredRow): ProjectStoreError {
  return conflict(`Version ${row.version} of item ${row.id} is already stored with different content`);
}
function storageError(message: string, cause: unknown): ProjectStoreError {
  if (cause instanceof DOMException && cause.name === 'QuotaExceededError')
    return new ProjectStoreError('quota-exceeded', 'The browser storage quota for this origin is exhausted', { cause });
  return new ProjectStoreError('storage', message, cause === null || cause === undefined ? undefined : { cause });
}
function byIdAndVersion(a: StoredRow, b: StoredRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version;
}

/** In-memory backend with the same commit rules as IndexedDB, for tests and Node tools. */
export class MemoryBackend implements RecordBackend {
  private readonly rows = new Map<string, StoredRow>();
  /** `${id}/${version}` to sha256: the unique item-version index. */
  private readonly versions = new Map<string, string>();
  private readonly heads = new Map<string, StoredRow>();
  private readonly settings = new Map<string, Uint8Array<ArrayBuffer>>();

  get(sha256: string): Promise<StoredRow | undefined> {
    const row = this.rows.get(sha256);
    return Promise.resolve(row ? copyRow(row) : undefined);
  }
  itemRows(id: string): Promise<StoredRow[]> {
    return Promise.resolve(this.select(row => row.id === id));
  }
  projectRows(projectId: string): Promise<StoredRow[]> {
    return Promise.resolve(this.select(row => row.projectId === projectId));
  }
  kindRows(kind: ItemKind): Promise<StoredRow[]> {
    return Promise.resolve(this.select(row => row.kind === kind));
  }
  totals(): Promise<StoreTotals> {
    let bytes = 0;
    for (const row of this.rows.values()) bytes += row.bytes.byteLength;
    return Promise.resolve({ records: this.rows.size, bytes });
  }
  commit(request: CommitRequest): Promise<CommitResult> {
    try {
      return Promise.resolve(this.apply(request));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Commit failed'));
    }
  }
  getSetting(key: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    return Promise.resolve(this.settings.get(key)?.slice());
  }
  putSetting(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.settings.set(key, bytes.slice());
    return Promise.resolve();
  }
  close(): void {
    // Nothing to release.
  }
  private apply(request: CommitRequest): CommitResult {
    for (const [id, expected] of request.expectHeads)
      if ((this.heads.get(id)?.sha256 ?? null) !== expected) throw headChanged(id);
    const staged = new Map<string, StoredRow>(), stagedVersions = new Map<string, string>();
    let present = 0;
    for (const row of request.adds) {
      if (this.rows.has(row.sha256) || staged.has(row.sha256)) {
        present++;
        continue;
      }
      const key = `${row.id}/${row.version}`;
      if (this.versions.has(key) || stagedVersions.has(key)) throw forked(row);
      staged.set(row.sha256, copyRow(row));
      stagedVersions.set(key, row.sha256);
    }
    for (const [sha256, row] of staged) {
      this.rows.set(sha256, row);
      this.versions.set(`${row.id}/${row.version}`, sha256);
      const head = this.heads.get(row.id);
      if (!head || head.version < row.version) this.heads.set(row.id, row);
    }
    return { added: staged.size, present };
  }
  private select(predicate: (row: StoredRow) => boolean): StoredRow[] {
    return [...this.rows.values()].filter(predicate).sort(byIdAndVersion).map(copyRow);
  }
}

export const DEFAULT_DATABASE_NAME = 'mirage-project-store';
/** Version 1 (TASK-136) holds `records`; version 2 (TASK-137) adds `settings`. */
const DATABASE_VERSION = 2;
const RECORDS = 'records';
const SETTINGS = 'settings';

function asRow(value: unknown): StoredRow {
  if (typeof value !== 'object' || value === null) throw new ProjectStoreError('storage', 'A stored project row is not an object');
  const sha256: unknown = Reflect.get(value, 'sha256'), id: unknown = Reflect.get(value, 'id');
  const projectId: unknown = Reflect.get(value, 'projectId'), version: unknown = Reflect.get(value, 'version');
  const kindValue: unknown = Reflect.get(value, 'kind'), bytes: unknown = Reflect.get(value, 'bytes');
  const kind = ITEM_KINDS.find(k => k === kindValue);
  if (typeof sha256 !== 'string' || typeof id !== 'string' || typeof projectId !== 'string' || !kind ||
    typeof version !== 'number' || !Number.isSafeInteger(version) || !(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer))
    throw new ProjectStoreError('storage', 'A stored project row is corrupted');
  return { sha256, id, projectId, kind, version, bytes: new Uint8Array(bytes) };
}
function asRows(value: unknown): StoredRow[] {
  if (!Array.isArray(value)) throw new ProjectStoreError('storage', 'A project query did not return rows');
  return value.map((item: unknown) => asRow(item)).sort(byIdAndVersion);
}
function itemRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, 1], [id, MAX_VERSION]);
}

/**
 * IndexedDB backend. The object store `records` is keyed by sha256, with a
 * unique index on [id, version] (no item version can have two contents) and
 * indexes on projectId and kind; its rows are only ever added. The object
 * store `settings` maps a setting key to canonical JSON bytes.
 */
export class IndexedDbBackend implements RecordBackend {
  private closed = false;
  private constructor(private readonly db: IDBDatabase) {
    // A newer schema in another tab needs this connection closed; later calls then fail clearly.
    db.onversionchange = () => {
      this.closed = true;
      db.close();
    };
  }

  static async open(name: string = DEFAULT_DATABASE_NAME): Promise<IndexedDbBackend> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new ProjectStoreError('invalid', 'Invalid project database name');
    if (typeof indexedDB === 'undefined') throw new ProjectStoreError('storage', 'IndexedDB is not available');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, DATABASE_VERSION);
      request.onupgradeneeded = event => {
        if (event.oldVersion < 1) {
          const records = request.result.createObjectStore(RECORDS, { keyPath: 'sha256' });
          records.createIndex('item', ['id', 'version'], { unique: true });
          records.createIndex('project', 'projectId');
          records.createIndex('kind', 'kind');
        }
        if (event.oldVersion < 2) request.result.createObjectStore(SETTINGS);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(storageError('The project database could not be opened', request.error));
      request.onblocked = () => reject(new ProjectStoreError('storage', 'Another tab holds an older project database open'));
    });
    return new IndexedDbBackend(db);
  }

  async get(sha256: string): Promise<StoredRow | undefined> {
    const value = await this.read(store => store.get(sha256));
    return value === undefined ? undefined : asRow(value);
  }
  async itemRows(id: string): Promise<StoredRow[]> {
    return asRows(await this.read(store => store.index('item').getAll(itemRange(id))));
  }
  async projectRows(projectId: string): Promise<StoredRow[]> {
    return asRows(await this.read(store => store.index('project').getAll(projectId)));
  }
  async kindRows(kind: ItemKind): Promise<StoredRow[]> {
    return asRows(await this.read(store => store.index('kind').getAll(kind)));
  }
  totals(): Promise<StoreTotals> {
    const tx = this.transaction(RECORDS, 'readonly');
    return new Promise((resolve, reject) => {
      let records = 0, bytes = 0, failure: ProjectStoreError | null = null;
      const cursor = tx.objectStore(RECORDS).openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current || failure) return;
        try {
          const value: unknown = current.value;
          bytes += asRow(value).bytes.byteLength;
          records++;
          current.continue();
        } catch (error) {
          failure = error instanceof ProjectStoreError ? error : storageError('A stored project row could not be read', error);
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve({ records, bytes });
      tx.onabort = () => reject(failure ?? storageError('The project database could not be read', tx.error));
    });
  }
  commit(request: CommitRequest): Promise<CommitResult> {
    const tx = this.transaction(RECORDS, 'readwrite');
    return new Promise((resolve, reject) => {
      const store = tx.objectStore(RECORDS), item = store.index('item');
      let failure: ProjectStoreError | null = null, added = 0, present = 0;
      const fail = (error: ProjectStoreError): void => {
        if (failure) return;
        failure = error;
        tx.abort();
      };
      // Requests run in issue order: every head check completes before any add is issued.
      for (const [id, expected] of request.expectHeads) {
        const head = item.openCursor(itemRange(id), 'prev');
        head.onsuccess = () => {
          const value: unknown = head.result?.value;
          let actual: string | null = null;
          try {
            actual = value === undefined ? null : asRow(value).sha256;
          } catch (error) {
            fail(error instanceof ProjectStoreError ? error : storageError('A stored project row could not be read', error));
            return;
          }
          if (actual !== expected) fail(headChanged(id));
        };
      }
      const unique = new Map<string, StoredRow>();
      for (const row of request.adds) {
        if (unique.has(row.sha256)) present++;
        else unique.set(row.sha256, row);
      }
      for (const row of unique.values()) {
        const lookup = store.getKey(row.sha256);
        lookup.onsuccess = () => {
          if (failure) return;
          if (lookup.result !== undefined) {
            present++;
            return;
          }
          const add = store.add(copyRow(row));
          add.onsuccess = () => {
            added++;
          };
          add.onerror = event => {
            event.preventDefault();
            fail(add.error?.name === 'ConstraintError' ? forked(row) : storageError('A project record could not be stored', add.error));
          };
        };
      }
      tx.oncomplete = () => resolve({ added, present });
      tx.onabort = () => reject(failure ?? storageError('The project database transaction failed', tx.error));
    });
  }
  async getSetting(key: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const value = await this.read(store => store.get(key), SETTINGS);
    if (value === undefined) return undefined;
    if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer))
      throw new ProjectStoreError('storage', `Stored setting ${key} is corrupted`);
    return new Uint8Array(value);
  }
  putSetting(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const tx = this.transaction(SETTINGS, 'readwrite');
    return new Promise((resolve, reject) => {
      tx.objectStore(SETTINGS).put(bytes.slice(), key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(storageError(`Setting ${key} could not be stored`, tx.error));
    });
  }
  close(): void {
    this.closed = true;
    this.db.close();
  }

  private transaction(storeName: string, mode: IDBTransactionMode): IDBTransaction {
    if (this.closed) throw new ProjectStoreError('storage', 'The project database connection is closed');
    return this.db.transaction(storeName, mode);
  }
  private read(issue: (store: IDBObjectStore) => IDBRequest, storeName: string = RECORDS): Promise<unknown> {
    const tx = this.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const request = issue(tx.objectStore(storeName));
      tx.oncomplete = () => {
        const value: unknown = request.result;
        resolve(value);
      };
      tx.onabort = () => reject(storageError('The project database could not be read', tx.error ?? request.error));
    });
  }
}

/** The part of the browser StorageManager that quota reports use. */
export interface StorageManagerLike {
  estimate?(): Promise<{ usage?: number; quota?: number }>;
  persisted?(): Promise<boolean>;
}
export interface ProjectStoreOptions {
  readonly now?: () => Date;
  /** UUID v4 source for new items; defaults to crypto.randomUUID. */
  readonly uuid?: () => string;
  /** Payload validators registered by the kinds' owner tasks; applied when a version is written or imported. */
  readonly validators?: PayloadValidators;
  /** Origin storage manager for quota reports; defaults to navigator.storage when present. */
  readonly storage?: StorageManagerLike | null;
}
export interface StorageReport {
  readonly records: number;
  /** Canonical record bytes held by this store. */
  readonly storeBytes: number;
  /** Origin-wide usage and quota from the browser estimate, or null when unknown. */
  readonly usageBytes: number | null;
  readonly quotaBytes: number | null;
  /** Whether the browser marked the origin's storage persistent, or null when unknown. */
  readonly persisted: boolean | null;
}
export interface RequiredBy {
  readonly sha256: string;
  readonly kind: ItemKind;
  readonly id: string;
  readonly version: number;
  readonly name: string;
}
/** A dependency that no stored version of the project satisfies, with every version that needs it. */
export interface MissingDependency {
  readonly kind: ItemKind;
  readonly sha256: string;
  readonly requiredBy: readonly RequiredBy[];
}
export interface ItemImport {
  readonly id: string;
  readonly kind: ItemKind;
  /** Name of the item's head after the import. */
  readonly name: string;
  readonly status: Exclude<MergeStatus, 'diverged'>;
  /** Versions stored locally before the import (0 for a new item) and versions in the archive. */
  readonly localVersion: number;
  readonly importedVersion: number;
}
export interface ImportReport {
  readonly projectId: string;
  /** Archive records stored by this import. */
  readonly added: number;
  /** Archive records that were already stored. */
  readonly unchanged: number;
  readonly items: readonly ItemImport[];
  readonly missing: readonly MissingDependency[];
}
export interface ExportResult {
  readonly archive: Uint8Array<ArrayBuffer>;
  readonly entries: number;
  readonly bytes: number;
  readonly missing: readonly MissingDependency[];
}

const CONTENT_KINDS: readonly ItemKind[] = ['component-card', 'aircraft-profile', 'experiment'];
function kindOrder(kind: ItemKind): number {
  return ITEM_KINDS.indexOf(kind);
}
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function byArchiveOrder(a: StoredVersion, b: StoredVersion): number {
  return kindOrder(a.record.kind) - kindOrder(b.record.kind) || compareText(a.record.id, b.record.id) || a.record.version - b.record.version;
}
function byKindNameId(a: StoredVersion, b: StoredVersion): number {
  return kindOrder(a.record.kind) - kindOrder(b.record.kind) || compareText(a.record.name, b.record.name) || compareText(a.record.id, b.record.id);
}
function bySha(a: Dependency, b: Dependency): number {
  return compareText(a.sha256, b.sha256);
}
/** The highest version of each item. */
function latestRows(rows: readonly StoredRow[]): StoredRow[] {
  const heads = new Map<string, StoredRow>();
  for (const row of rows) {
    const head = heads.get(row.id);
    if (!head || head.version < row.version) heads.set(row.id, row);
  }
  return [...heads.values()];
}
function groupById(versions: readonly StoredVersion[]): Map<string, StoredVersion[]> {
  const groups = new Map<string, StoredVersion[]>();
  for (const v of versions) {
    const group = groups.get(v.record.id);
    if (group) group.push(v);
    else groups.set(v.record.id, [v]);
  }
  for (const group of groups.values()) group.sort((a, b) => a.record.version - b.record.version);
  return groups;
}
function requiredBy(v: StoredVersion): RequiredBy {
  return { sha256: v.sha256, kind: v.record.kind, id: v.record.id, version: v.record.version, name: v.record.name };
}
/** Collects unresolved dependencies; `resolve` returns the stored version of an address in the same project. */
async function findMissing(versions: readonly StoredVersion[], resolve: (sha256: string) => Promise<StoredVersion | undefined>,
  inconsistent: (message: string) => ProjectStoreError): Promise<MissingDependency[]> {
  const missing = new Map<string, { kind: ItemKind; requiredBy: RequiredBy[] }>();
  for (const v of versions) {
    for (const dependency of v.record.dependencies) {
      const target = await resolve(dependency.sha256);
      if (target) {
        if (target.record.kind !== dependency.kind || target.record.projectId !== v.record.projectId)
          throw inconsistent(`Version ${v.record.version} of item ${v.record.id} names ${dependency.sha256} with the wrong kind or project`);
        continue;
      }
      const entry = missing.get(dependency.sha256);
      if (!entry) missing.set(dependency.sha256, { kind: dependency.kind, requiredBy: [requiredBy(v)] });
      else if (entry.kind !== dependency.kind) throw inconsistent(`Dependency ${dependency.sha256} is named with two kinds`);
      else entry.requiredBy.push(requiredBy(v));
    }
  }
  return [...missing].sort(([a], [b]) => compareText(a, b)).map(([sha256, entry]) => ({
    kind: entry.kind, sha256,
    requiredBy: entry.requiredBy.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || compareText(a.id, b.id) || a.version - b.version),
  }));
}
function defaultStorage(): StorageManagerLike | null {
  const manager: StorageManager | undefined = typeof navigator === 'undefined' ? undefined : navigator.storage;
  return manager ?? null;
}
function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export class ProjectStore {
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly validators: PayloadValidators;
  private readonly storage: StorageManagerLike | null;

  constructor(private readonly backend: RecordBackend, options: ProjectStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.validators = options.validators ?? {};
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
  }

  /** Opens the origin's IndexedDB project store (browser only). */
  static async openIndexedDb(options: ProjectStoreOptions & { readonly databaseName?: string } = {}): Promise<ProjectStore> {
    return new ProjectStore(await IndexedDbBackend.open(options.databaseName), options);
  }

  async createProject(name: string): Promise<StoredVersion> {
    const id = this.newId();
    const fields = await this.fields(id, 'project', { name, payload: {} });
    return this.append(initialRecord('project', id, id, this.timestamp(), fields, null), id, null);
  }

  async createItem(projectId: string, kind: ContentKind, draft: Draft): Promise<StoredVersion> {
    if (!CONTENT_KINDS.includes(kind)) throw new ProjectStoreError('invalid', `Unknown item kind ${String(kind)}`);
    await this.requireProject(projectId);
    const fields = await this.fields(projectId, kind, draft);
    const id = this.newId();
    return this.append(initialRecord(kind, id, projectId, this.timestamp(), fields, null), id, null);
  }

  /**
   * Appends a version to an item whose head is still `expectedHead`. A draft
   * equal to the head returns the head; an experiment's inputs never change.
   */
  async saveVersion(id: string, expectedHead: string, draft: Draft): Promise<StoredVersion> {
    const head = (await this.history(id)).at(-1);
    if (!head) throw new ProjectStoreError('not-found', `Item ${id} is not stored`);
    if (head.sha256 !== expectedHead) throw headChanged(id);
    const fields = await this.fields(head.record.projectId, head.record.kind, draft);
    if (repeatsHead(head.record, fields)) return head;
    if (head.record.kind === 'experiment' && !sameInputs(head.record, fields))
      throw new ProjectStoreError('invalid', 'Experiment inputs are fixed; create a new experiment to change them');
    return this.append(successorRecord(head, this.timestamp(), fields), id, head.sha256);
  }

  /** Copies one version into a new item of the same project; the source stays unchanged. */
  async copyItem(sourceSha256: string, name: string): Promise<StoredVersion> {
    const source = (await this.get(sourceSha256)).record;
    if (source.kind === 'project') throw new ProjectStoreError('invalid', 'A project cannot be copied as an item');
    const fields = await this.fields(source.projectId, source.kind,
      { name, payload: source.payload, dependencies: source.dependencies.map(d => d.sha256) });
    const id = this.newId();
    return this.append(initialRecord(source.kind, id, source.projectId, this.timestamp(), fields, { copiedFrom: sourceSha256 }), id, null);
  }

  async get(sha256: string): Promise<StoredVersion> {
    const row = SHA256_HEX.test(sha256) ? await this.backend.get(sha256) : undefined;
    if (!row) throw new ProjectStoreError('not-found', `Record ${sha256} is not stored`);
    return this.verify(row);
  }

  /** All versions of an item, ascending; empty when the item is not stored. */
  async history(id: string): Promise<StoredVersion[]> {
    const versions = await Promise.all((await this.backend.itemRows(id)).map(row => this.verify(row)));
    if (versions.length > 0) this.checkStored(versions);
    return versions;
  }

  async head(id: string): Promise<StoredVersion | null> {
    return (await this.history(id)).at(-1) ?? null;
  }

  /** Heads of all projects, by name. */
  async listProjects(): Promise<StoredVersion[]> {
    const heads = await Promise.all(latestRows(await this.backend.kindRows('project')).map(row => this.verify(row)));
    return heads.sort(byKindNameId);
  }

  /** Heads of a project's items (without the project record), by kind and name. */
  async listItems(projectId: string, kind?: ContentKind): Promise<StoredVersion[]> {
    await this.requireProject(projectId);
    const rows = (await this.backend.projectRows(projectId)).filter(row => row.kind !== 'project' && (kind === undefined || row.kind === kind));
    const heads = await Promise.all(latestRows(rows).map(row => this.verify(row)));
    return heads.sort(byKindNameId);
  }

  async missingDependencies(projectId: string): Promise<MissingDependency[]> {
    return this.closure(await this.projectVersions(projectId));
  }

  /** Writes every version of every item of a project, with the dependencies no stored version satisfies. */
  async exportProject(projectId: string): Promise<ExportResult> {
    const versions = await this.projectVersions(projectId);
    const missing = await this.closure(versions);
    const archive = await encodeArchive(projectId, this.timestamp(), versions);
    return { archive, entries: versions.length, bytes: archive.byteLength, missing };
  }

  /**
   * Imports a project archive atomically. Items new to this store are added,
   * older local copies are fast-forwarded, and newer or equal local histories
   * are kept. A history that diverged from the local one refuses the whole
   * import. Dependencies that neither the archive nor the store holds are
   * reported, not invented.
   */
  async importArchive(input: Blob | Uint8Array): Promise<ImportReport> {
    const { manifest, versions } = await decodeArchive(input, this.validators);
    const projectId = manifest.projectId;
    const invalidArchive = (message: string, cause?: unknown) =>
      new ProjectStoreError('archive-invalid', message, cause === undefined ? undefined : { cause });
    if (versions.some(v => v.record.projectId !== projectId)) throw invalidArchive('The archive holds records of another project');
    const groups = groupById(versions);
    if (groups.get(projectId)?.[0]?.record.kind !== 'project') throw invalidArchive('The archive does not hold its project record');
    for (const group of groups.values()) {
      try {
        checkHistory(group);
      } catch (cause) {
        throw invalidArchive(`The archive holds an incomplete or inconsistent item history: ${cause instanceof Error ? cause.message : ''}`, cause);
      }
    }
    const bySha = new Map(versions.map(v => [v.sha256, v]));
    const missing = await findMissing(versions, async sha256 => {
      const inArchive = bySha.get(sha256);
      if (inArchive) return inArchive;
      const row = await this.backend.get(sha256);
      return row ? this.verify(row) : undefined;
    }, invalidArchive);

    const items: ItemImport[] = [], adds: StoredRow[] = [], diverged: string[] = [];
    const expectHeads = new Map<string, string | null>();
    for (const [id, incoming] of groups) {
      const local = await this.history(id), incomingHead = incoming.at(-1), localFirst = local[0];
      if (!incomingHead) continue;
      if (localFirst && (localFirst.record.projectId !== projectId || localFirst.record.kind !== incomingHead.record.kind))
        throw invalidArchive(`Item ${id} is stored here with another project or kind`);
      const status = classifyMerge(local, incoming);
      if (status === 'diverged') {
        diverged.push(id);
        continue;
      }
      expectHeads.set(id, local.at(-1)?.sha256 ?? null);
      adds.push(...incoming.slice(local.length).map(toRow));
      const head = status === 'local-newer' ? local.at(-1) ?? incomingHead : incomingHead;
      items.push({ id, kind: head.record.kind, name: head.record.name, status, localVersion: local.length, importedVersion: incoming.length });
    }
    if (diverged.length > 0)
      throw conflict(`This store and the archive changed the same items differently: ${diverged.sort().join(', ')}`);
    const result = await this.backend.commit({ adds, expectHeads });
    items.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || compareText(a.id, b.id));
    return { projectId, added: result.added, unchanged: versions.length - result.added, items, missing };
  }

  /** Store usage plus the origin's quota and persistence as the browser reports them. */
  async storageReport(): Promise<StorageReport> {
    const totals = await this.backend.totals();
    let usageBytes: number | null = null, quotaBytes: number | null = null, persisted: boolean | null = null;
    if (this.storage?.estimate) {
      try {
        const estimate = await this.storage.estimate();
        usageBytes = nonNegative(estimate.usage);
        quotaBytes = nonNegative(estimate.quota);
      } catch {
        // An unavailable estimate stays unknown.
      }
    }
    if (this.storage?.persisted) {
      try {
        const value: unknown = await this.storage.persisted();
        persisted = typeof value === 'boolean' ? value : null;
      } catch {
        // An unavailable persistence state stays unknown.
      }
    }
    return { records: totals.records, storeBytes: totals.bytes, usageBytes, quotaBytes, persisted };
  }

  /** A local setting, or undefined when none is stored. Settings are not versioned and never exported. */
  async readSetting(key: string): Promise<unknown> {
    checkSettingKey(key);
    const bytes = await this.backend.getSetting(key);
    if (bytes === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(decodeUtf8(bytes));
      if (!equalBytes(canonicalBytes(value, MAX_SETTING_BYTES), bytes)) throw new Error('The setting is not canonical JSON');
      return value;
    } catch (cause) {
      throw new ProjectStoreError('storage', `Stored setting ${key} is corrupted`, { cause });
    }
  }

  /** Replaces a local setting with a JSON value of at most MAX_SETTING_BYTES canonical bytes. */
  async writeSetting(key: string, value: unknown): Promise<void> {
    checkSettingKey(key);
    await this.backend.putSetting(key, canonicalBytes(value, MAX_SETTING_BYTES));
  }

  close(): void {
    this.backend.close();
  }

  private async append(candidate: unknown, id: string, expectedHead: string | null): Promise<StoredVersion> {
    const version = await encodeRecord(candidate, this.validators);
    await this.backend.commit({ adds: [toRow(version)], expectHeads: new Map([[id, expectedHead]]) });
    return version;
  }

  /** Normalizes the name and resolves dependencies to exact stored versions of the same project. */
  private async fields(projectId: string, kind: ItemKind, draft: Draft): Promise<VersionFields> {
    const name = normalizeName(draft.name);
    const listed: unknown = draft.dependencies ?? [];
    if (!Array.isArray(listed) || listed.length > MAX_DEPENDENCIES)
      throw new ProjectStoreError('invalid', `Dependencies must be a list of at most ${MAX_DEPENDENCIES} addresses`);
    const addresses: readonly unknown[] = listed;
    const dependencies: Dependency[] = [], seen = new Set<string>();
    for (const address of addresses) {
      if (typeof address !== 'string' || !SHA256_HEX.test(address)) throw new ProjectStoreError('invalid', 'Dependencies are lowercase SHA-256 addresses');
      if (seen.has(address)) throw new ProjectStoreError('invalid', `Dependency ${address} is listed twice`);
      seen.add(address);
      const row = await this.backend.get(address);
      if (!row) throw new ProjectStoreError('missing-dependency', `Dependency ${address} is not stored`);
      const target = (await this.verify(row)).record;
      if (target.projectId !== projectId) throw new ProjectStoreError('invalid', 'A dependency must belong to the same project');
      if (!ALLOWED_DEPENDENCIES[kind].includes(target.kind)) throw new ProjectStoreError('invalid', `A ${kind} cannot depend on a ${target.kind}`);
      dependencies.push({ kind: target.kind, sha256: address });
    }
    return { name, payload: draft.payload, dependencies: dependencies.sort(bySha) };
  }

  /** Decodes a stored row and checks it against its key and indexed fields. Payload validators apply only on writes. */
  private async verify(row: StoredRow): Promise<StoredVersion> {
    let version: StoredVersion;
    try {
      version = await decodeRecord(row.bytes);
    } catch (cause) {
      throw new ProjectStoreError('storage', `Stored record ${row.sha256} is corrupted`, { cause });
    }
    const r = version.record;
    if (version.sha256 !== row.sha256 || r.id !== row.id || r.projectId !== row.projectId || r.kind !== row.kind || r.version !== row.version)
      throw new ProjectStoreError('storage', `Stored record ${row.sha256} does not match its index entries`);
    return version;
  }

  private checkStored(versions: readonly StoredVersion[]): void {
    try {
      checkHistory(versions);
    } catch (cause) {
      throw new ProjectStoreError('storage', `A stored item history is inconsistent: ${cause instanceof Error ? cause.message : ''}`, { cause });
    }
  }

  private async requireProject(projectId: string): Promise<StoredVersion> {
    const head = await this.head(projectId);
    if (!head || head.record.kind !== 'project') throw new ProjectStoreError('not-found', `Project ${projectId} is not stored`);
    return head;
  }

  /** Every verified version of a project in archive order, with each item history checked. */
  private async projectVersions(projectId: string): Promise<StoredVersion[]> {
    await this.requireProject(projectId);
    const versions = await Promise.all((await this.backend.projectRows(projectId)).map(row => this.verify(row)));
    for (const group of groupById(versions).values()) this.checkStored(group);
    return versions.sort(byArchiveOrder);
  }

  private async closure(versions: readonly StoredVersion[]): Promise<MissingDependency[]> {
    const bySha = new Map(versions.map(v => [v.sha256, v]));
    return findMissing(versions, sha256 => Promise.resolve(bySha.get(sha256)),
      message => new ProjectStoreError('storage', message));
  }

  private newId(): string {
    const id = this.uuid();
    if (!UUID_V4.test(id)) throw new ProjectStoreError('invalid', 'The identifier source returned an invalid UUID v4');
    return id;
  }

  private timestamp(): string {
    const date = this.now();
    const text = Number.isFinite(date.getTime()) ? date.toISOString() : '';
    if (!TIMESTAMP.test(text)) throw new ProjectStoreError('invalid', 'The clock returned a time outside the years 0000 to 9999');
    return text;
  }
}
