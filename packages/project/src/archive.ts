import {
  ProjectStoreError, canonicalBytes, checkTimestamp, compileDefinition, decodeRecord, decodeUtf8, equalBytes, schemaErrors,
  sha256Bytes, sha256Hex, type ItemKind, type PayloadValidators, type ProjectStoreErrorCode, type StoredVersion,
} from './schema.ts';

// Project archive v1 (TASK-136). An uncompressed, length-delimited container
// in the style of the TASK-081 AAR archive. Little-endian 64-byte header:
//   0 u32 magic 0x4a52504d (bytes "MPRJ")   4 u32 format version 1
//   8 u32 manifest bytes                    12 u32 entry count
//  16 u32 payload bytes                     20..31 reserved, zero
//  32..63 SHA-256 of the whole archive with bytes 32..63 read as zero
// Then the canonical JSON manifest at byte 64, then each entry's canonical
// record bytes in manifest order. Sizes are checked against the limits and
// the input length before the contents are read or copied.

export const ARCHIVE_MAGIC = 0x4a52504d;
export const ARCHIVE_FORMAT_VERSION = 1;
export const ARCHIVE_HEADER_BYTES = 64;
export const MAX_ARCHIVE_BYTES = 134217728;
export const MAX_MANIFEST_BYTES = 4194304;
export const MAX_ARCHIVE_ENTRIES = 16384;
/** Suggested file-name extension for exported project archives. */
export const ARCHIVE_FILE_EXTENSION = '.mirageproj';

export interface ArchiveEntry {
  readonly sha256: string;
  readonly bytes: number;
  readonly kind: ItemKind;
  readonly id: string;
  readonly version: number;
}
export interface ArchiveManifest {
  readonly format: 'mirage-project-archive';
  readonly formatVersion: 1;
  readonly projectId: string;
  readonly exportedAt: string;
  readonly entries: readonly ArchiveEntry[];
}
export interface DecodedArchive {
  readonly manifest: ArchiveManifest;
  /** Verified entries in manifest order. */
  readonly versions: readonly StoredVersion[];
}

const validateManifestShape = compileDefinition<ArchiveManifest>('archiveManifest');

function archiveError(code: ProjectStoreErrorCode, message: string, cause?: unknown): ProjectStoreError {
  return new ProjectStoreError(code, message, cause === undefined ? undefined : { cause });
}

/** Writes an archive of verified versions, which the caller lists in archive order. */
export async function encodeArchive(projectId: string, exportedAt: string, versions: readonly StoredVersion[]): Promise<Uint8Array<ArrayBuffer>> {
  if (versions.length > MAX_ARCHIVE_ENTRIES) throw archiveError('archive-size', `A project archive may hold at most ${MAX_ARCHIVE_ENTRIES} records`);
  const manifest = {
    format: 'mirage-project-archive', formatVersion: ARCHIVE_FORMAT_VERSION, projectId, exportedAt,
    entries: versions.map(v => ({ sha256: v.sha256, bytes: v.bytes.byteLength, kind: v.record.kind, id: v.record.id, version: v.record.version })),
  };
  if (!validateManifestShape(manifest)) throw archiveError('invalid', `Archive manifest rejected: ${schemaErrors(validateManifestShape)}`);
  const manifestBytes = canonicalBytes(manifest);
  const payload = versions.reduce((sum, v) => sum + v.bytes.byteLength, 0);
  const total = ARCHIVE_HEADER_BYTES + manifestBytes.byteLength + payload;
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES || total > MAX_ARCHIVE_BYTES)
    throw archiveError('archive-size', `The project archive would exceed its ${MAX_ARCHIVE_BYTES}-byte limit`);
  const out = new Uint8Array(total), view = new DataView(out.buffer);
  view.setUint32(0, ARCHIVE_MAGIC, true);
  view.setUint32(4, ARCHIVE_FORMAT_VERSION, true);
  view.setUint32(8, manifestBytes.byteLength, true);
  view.setUint32(12, versions.length, true);
  view.setUint32(16, payload, true);
  out.set(manifestBytes, ARCHIVE_HEADER_BYTES);
  let offset = ARCHIVE_HEADER_BYTES + manifestBytes.byteLength;
  for (const v of versions) {
    out.set(v.bytes, offset);
    offset += v.bytes.byteLength;
  }
  // Bytes 32..63 are still zero, as the digest definition requires.
  out.set(await sha256Bytes(out), 32);
  return out;
}

interface Layout { readonly manifestBytes: number; readonly entries: number; readonly payload: number }

function readHeader(header: Uint8Array, size: number): Layout {
  const view = new DataView(header.buffer, header.byteOffset, ARCHIVE_HEADER_BYTES);
  if (view.getUint32(0, true) !== ARCHIVE_MAGIC || view.getUint32(4, true) !== ARCHIVE_FORMAT_VERSION || header.subarray(20, 32).some(byte => byte !== 0))
    throw archiveError('archive-header', 'Not a MirageSITL project archive v1');
  const layout = { manifestBytes: view.getUint32(8, true), entries: view.getUint32(12, true), payload: view.getUint32(16, true) };
  if (layout.manifestBytes < 2 || layout.manifestBytes > MAX_MANIFEST_BYTES || layout.entries < 1 || layout.entries > MAX_ARCHIVE_ENTRIES ||
    layout.payload < 2 * layout.entries || ARCHIVE_HEADER_BYTES + layout.manifestBytes + layout.payload !== size)
    throw archiveError('archive-header', 'Project archive header lengths are outside their limits or disagree with the file size');
  return layout;
}

function readManifest(bytes: Uint8Array, layout: Layout): ArchiveManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
    if (!equalBytes(canonicalBytes(parsed, MAX_MANIFEST_BYTES), bytes)) throw new Error('The manifest is not canonical JSON');
  } catch (cause) {
    throw archiveError('archive-invalid', 'The archive manifest is not canonical UTF-8 JSON', cause);
  }
  if (!validateManifestShape(parsed)) throw archiveError('archive-invalid', `Archive manifest rejected: ${schemaErrors(validateManifestShape)}`);
  const manifest = parsed;
  try {
    checkTimestamp(manifest.exportedAt, 'exportedAt');
  } catch (cause) {
    throw archiveError('archive-invalid', 'The archive export time is invalid', cause);
  }
  const addresses = new Set<string>(), versions = new Set<string>();
  let payload = 0;
  for (const entry of manifest.entries) {
    addresses.add(entry.sha256);
    versions.add(`${entry.id}/${entry.version}`);
    payload += entry.bytes;
  }
  if (manifest.entries.length !== layout.entries || payload !== layout.payload)
    throw archiveError('archive-invalid', 'The archive manifest disagrees with the header');
  if (addresses.size !== manifest.entries.length || versions.size !== manifest.entries.length)
    throw archiveError('archive-invalid', 'The archive lists a record or an item version twice');
  return manifest;
}

/**
 * Reads and verifies a project archive: size and header limits first, then
 * the archive digest, the canonical manifest, and each entry's SHA-256,
 * canonical form, envelope and payload validators. A Blob is measured and its
 * header read before any other byte is loaded.
 */
export async function decodeArchive(input: Blob | Uint8Array, validators: PayloadValidators = {}): Promise<DecodedArchive> {
  const size = input instanceof Uint8Array ? input.byteLength : input.size;
  if (!Number.isSafeInteger(size) || size < ARCHIVE_HEADER_BYTES || size > MAX_ARCHIVE_BYTES)
    throw archiveError('archive-size', `A project archive must have ${ARCHIVE_HEADER_BYTES} to ${MAX_ARCHIVE_BYTES} bytes`);
  const header = input instanceof Uint8Array ? input.subarray(0, ARCHIVE_HEADER_BYTES)
    : new Uint8Array(await input.slice(0, ARCHIVE_HEADER_BYTES).arrayBuffer());
  if (header.byteLength !== ARCHIVE_HEADER_BYTES) throw archiveError('archive-size', 'The project archive header is truncated');
  const layout = readHeader(header, size);
  const bytes = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(await input.arrayBuffer());
  if (bytes.byteLength !== size) throw archiveError('archive-size', 'The project archive changed while it was read');
  // The copy is private: zero the digest field in place instead of copying the archive again.
  const stored = bytes.slice(32, ARCHIVE_HEADER_BYTES);
  bytes.fill(0, 32, ARCHIVE_HEADER_BYTES);
  if (!equalBytes(await sha256Bytes(bytes), stored)) throw archiveError('archive-hash', 'The project archive does not match its SHA-256');
  const manifest = readManifest(bytes.subarray(ARCHIVE_HEADER_BYTES, ARCHIVE_HEADER_BYTES + layout.manifestBytes), layout);
  const versions: StoredVersion[] = [];
  let offset = ARCHIVE_HEADER_BYTES + layout.manifestBytes;
  for (const [index, entry] of manifest.entries.entries()) {
    const entryBytes = bytes.slice(offset, offset + entry.bytes);
    offset += entry.bytes;
    if (await sha256Hex(entryBytes) !== entry.sha256) throw archiveError('archive-hash', `Archive entry ${index} does not match its SHA-256`);
    let version: StoredVersion;
    try {
      version = await decodeRecord(entryBytes, validators);
    } catch (cause) {
      throw archiveError('archive-invalid', `Archive entry ${index} is not a valid record: ${cause instanceof Error ? cause.message : 'rejected'}`, cause);
    }
    const r = version.record;
    if (r.kind !== entry.kind || r.id !== entry.id || r.version !== entry.version)
      throw archiveError('archive-invalid', `Archive entry ${index} disagrees with its record`);
    versions.push(version);
  }
  return { manifest, versions };
}
