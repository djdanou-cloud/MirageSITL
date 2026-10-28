import {
  ProjectStoreError, canonicalJson, type Dependency, type ItemKind, type ProjectRecord, type RecordOrigin,
  type StoredVersion,
} from './schema.ts';

// Version rules (TASK-136). Every item is a linear chain of immutable versions
// 1..n; version n names version n-1 by its SHA-256. An edit appends a version
// and never rewrites one, so a dependency on an exact version stays valid.

/** What a caller edits: the name, the payload and the exact versions it depends on. */
export interface Draft {
  readonly name: string;
  readonly payload: unknown;
  /** SHA-256 addresses of stored versions in the same project. */
  readonly dependencies?: readonly string[];
}
/** A draft after name normalization and dependency resolution. */
export interface VersionFields {
  readonly name: string;
  readonly payload: unknown;
  readonly dependencies: readonly Dependency[];
}
/** How an incoming item history relates to the local one. */
export type MergeStatus = 'new' | 'fast-forward' | 'unchanged' | 'local-newer' | 'diverged';

export function initialRecord(kind: ItemKind, id: string, projectId: string, createdAt: string, fields: VersionFields,
  origin: RecordOrigin | null): unknown {
  return {
    schemaVersion: 1, kind, id, projectId, version: 1, previous: null, origin, name: fields.name, createdAt,
    dependencies: fields.dependencies, payload: fields.payload,
  };
}

export function successorRecord(head: StoredVersion, createdAt: string, fields: VersionFields): unknown {
  const r = head.record;
  return {
    schemaVersion: 1, kind: r.kind, id: r.id, projectId: r.projectId, version: r.version + 1, previous: head.sha256,
    origin: null, name: fields.name, createdAt, dependencies: fields.dependencies, payload: fields.payload,
  };
}

/** The inputs a simulation reads from a version: its payload and its exact dependencies. */
export function sameInputs(record: ProjectRecord, fields: Pick<VersionFields, 'payload' | 'dependencies'>): boolean {
  return canonicalJson(record.payload) === canonicalJson(fields.payload) &&
    canonicalJson(record.dependencies) === canonicalJson(fields.dependencies);
}

/** True when saving `fields` would repeat the head; such a save creates no version. */
export function repeatsHead(head: ProjectRecord, fields: VersionFields): boolean {
  return head.name === fields.name && sameInputs(head, fields);
}

/**
 * Checks one item's complete history, sorted by version: versions 1..n of one
 * item, kind and project, each naming its predecessor. An experiment fixes its
 * inputs at version 1; later versions may only rename it.
 */
export function checkHistory(versions: readonly StoredVersion[]): void {
  const first = versions[0]?.record;
  if (!first) throw new ProjectStoreError('invalid', 'An item history is empty');
  versions.forEach((version, index) => {
    const r = version.record;
    if (r.version !== index + 1 || r.id !== first.id) throw new ProjectStoreError('invalid', `Item ${first.id} does not hold versions 1 to ${versions.length}`);
    if (r.kind !== first.kind || r.projectId !== first.projectId) throw new ProjectStoreError('invalid', `Item ${first.id} changes its kind or project`);
    if (r.previous !== (versions[index - 1]?.sha256 ?? null)) throw new ProjectStoreError('invalid', `Version ${r.version} of item ${r.id} does not follow version ${r.version - 1}`);
    if (r.kind === 'experiment' && !sameInputs(r, first)) throw new ProjectStoreError('invalid', `Experiment ${r.id} changes its inputs after version 1`);
  });
}

/** Compares verified histories of one item; both start at version 1. */
export function classifyMerge(local: readonly StoredVersion[], incoming: readonly StoredVersion[]): MergeStatus {
  if (local.length === 0) return 'new';
  const shared = Math.min(local.length, incoming.length);
  for (let i = 0; i < shared; i++) if (local[i]?.sha256 !== incoming[i]?.sha256) return 'diverged';
  if (incoming.length > local.length) return 'fast-forward';
  return incoming.length === local.length ? 'unchanged' : 'local-newer';
}
