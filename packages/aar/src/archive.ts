import {
  MAX_ARCHIVE_BYTES,
  parseManifest,
  RECORD_BYTES,
  type AarManifest,
} from "./format.ts";
import { SnapshotReplay } from "./replay.ts";
export interface ArchiveLoss {
  queueLost: number;
  evicted: number;
  storageDropped: number;
}
export interface AarArchive {
  manifest: AarManifest;
  records: Uint8Array;
  loss: ArchiveLoss;
}
export type ArchiveRedactionPolicy =
  | "reject-extra-metadata"
  | "omit-extra-metadata";
function exportManifest(
  input: unknown,
  policy: ArchiveRedactionPolicy,
): AarManifest {
  if (policy === "reject-extra-metadata") return parseManifest(input);
  if (
    policy !== "omit-extra-metadata" ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  )
    throw new Error("Invalid archive redaction policy or manifest");
  const source = input as Record<string, unknown>,
    allowed: Record<string, unknown> = {};
  // Copy only declared provenance. API keys, tokens and serial IDs never enter the archive.
  for (const key of [
    "formatVersion",
    "recordBytes",
    "modelSha256",
    "firmwareSha256",
    "seed",
    "physicsHz",
    "recordHz",
    "durationS",
    "clock",
    "source",
  ])
    allowed[key] = source[key];
  return parseManifest(allowed);
}
async function digest(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  // Authenticate header and payload, excluding the SHA-256 field itself.
  const copy = bytes.slice();
  copy.fill(0, 32, 64);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
}
/** Uncompressed, length-delimited archive. No user-controlled decompression or free-form metadata.
 * The manifest allowlist omits API keys/tokens/device identifiers by construction.
 */
export async function exportArchive(
  manifest: unknown,
  records: Uint8Array,
  loss: ArchiveLoss = { queueLost: 0, evicted: 0, storageDropped: 0 },
  redaction: ArchiveRedactionPolicy = "reject-extra-metadata",
): Promise<Uint8Array<ArrayBuffer>> {
  const m = exportManifest(manifest, redaction);
  new SnapshotReplay(m, records);
  if (!Object.values(loss).every((x) => x >>> 0 === x))
    throw new Error("Invalid loss counters");
  const metadata = new TextEncoder().encode(JSON.stringify(m));
  const total = 64 + metadata.length + records.length;
  if (metadata.length > 4096 || total > MAX_ARCHIVE_BYTES)
    throw new Error("AAR archive exceeds size limit");
  const bytes = new Uint8Array(total),
    v = new DataView(bytes.buffer);
  v.setUint32(0, 0x4d415241, true);
  v.setUint32(4, 1, true);
  v.setUint32(8, metadata.length, true);
  v.setUint32(12, records.length / RECORD_BYTES, true);
  v.setUint32(16, records.length, true);
  v.setUint32(20, loss.queueLost, true);
  v.setUint32(24, loss.evicted, true);
  v.setUint32(28, loss.storageDropped, true);
  bytes.set(metadata, 64);
  bytes.set(records, 64 + metadata.length);
  bytes.set(await digest(bytes), 32);
  return bytes;
}
export async function importArchive(input: Uint8Array): Promise<AarArchive> {
  if (input.byteLength < 64 || input.byteLength > MAX_ARCHIVE_BYTES)
    throw new Error("AAR archive size rejected");
  const v = new DataView(input.buffer, input.byteOffset, input.byteLength),
    metadataBytes = v.getUint32(8, true),
    count = v.getUint32(12, true),
    payload = v.getUint32(16, true);
  if (
    v.getUint32(0, true) !== 0x4d415241 ||
    v.getUint32(4, true) !== 1 ||
    metadataBytes > 4096 ||
    payload !== count * RECORD_BYTES ||
    64 + metadataBytes + payload !== input.length
  )
    throw new Error("AAR archive header rejected");
  const bytes = new Uint8Array(input);
  const actual = await digest(bytes);
  for (let i = 0; i < 32; i++)
    if (actual[i] !== bytes[32 + i])
      throw new Error("AAR archive hash mismatch");
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(64, 64 + metadataBytes),
    ),
  );
  const manifest = parseManifest(parsed),
    records = bytes.slice(64 + metadataBytes);
  new SnapshotReplay(manifest, records);
  return {
    manifest,
    records,
    loss: {
      queueLost: new DataView(bytes.buffer).getUint32(20, true),
      evicted: new DataView(bytes.buffer).getUint32(24, true),
      storageDropped: new DataView(bytes.buffer).getUint32(28, true),
    },
  };
}
