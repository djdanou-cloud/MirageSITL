// AAR session archive (TASK-081): export/import of a recording with its
// manifest, optional resimulation reports and redacted metadata.
//
// Layout (no compression, so no decompression bombs):
//   0  8 bytes  magic "MAARCHV1"
//   8  u32      archive version (1)
//   12 u32      entry count
//   16 u32      index length (bytes, UTF-8 JSON)
//   20 u32      reserved (0)
//   24 f64      total archive bytes
//   32 32 bytes SHA-256 of the index
//   64 index JSON: [{ name, category, offset, bytes, sha256 }], offsets relative to the payload start
//   payloads, contiguous and non-overlapping, in index order
//
// Import reads the header first and rejects declared sizes beyond the limits
// or the actual Blob size, then reads and validates the index, and only then
// reads payloads (each bounded by its validated size) and verifies every
// SHA-256 before anything is written to the target store.
//
// Secrets: metadata keys naming secrets (token, secret, password, API key,
// authorization, cookie) are dropped, values that look like credentials
// (Google API keys, bearer tokens, 64-hex bridge tokens) are replaced, and
// serial/device identifiers are redacted when configured. The finished
// archive's text parts are scanned once more and export fails if anything
// credential-like remains.
import { RECORD_BYTES, CHUNK_HEADER_BYTES, isRecordKind, parseManifest, readChunk, type RecordKindValue, type SessionManifest } from "./format.ts";
import type { ChunkStore } from "./storage.ts";

export const ARCHIVE_MAGIC = "MAARCHV1";
export const ARCHIVE_VERSION = 1;
const HEADER_BYTES = 64;

export type EntryCategory = "manifest" | "chunk" | "metadata" | "report";
export interface ArchiveEntry { name: string; category: EntryCategory; offset: number; bytes: number; sha256: string }

export interface ArchiveLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxIndexBytes: number;
  maxEntryBytes: number;
}
export const DEFAULT_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024, maxEntries: 200_000, maxIndexBytes: 32 * 1024 * 1024, maxEntryBytes: 64 * 1024 * 1024,
});

export interface RedactionOptions {
  /** Redact serial numbers, device/USB identifiers and similar (default true). */
  redactSerials?: boolean;
  /** Extra metadata key patterns to drop. */
  dropKeys?: readonly RegExp[];
}

const SECRET_KEY = /token|secret|password|passwd|api[-_ ]?key|authorization|cookie|credential|private[-_ ]?key/i;
const SERIAL_KEY = /serial|imei|mac[-_ ]?address|uuid|device[-_ ]?id|usb[-_ ]?id|hardware[-_ ]?id/i;
const SECRET_VALUE: readonly RegExp[] = [/AIza[0-9A-Za-z_-]{35}/g, /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, /\b[a-f0-9]{64}\b/gi, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g];
/** Gamepad/USB descriptors embed vendor/product ids and often serials. */
const SERIAL_VALUE: readonly RegExp[] = [/\b(?:SN|S\/N|serial)[:#\s]*[A-Za-z0-9-]{4,}/gi, /\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/gi];

/** Returns redacted metadata (JSON-compatible) and how many items were removed or replaced. */
export function redactMetadata(value: unknown, options: RedactionOptions = {}): { value: unknown; redactions: number } {
  const serials = options.redactSerials ?? true;
  let redactions = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error("Metadata nested too deeply");
    if (typeof v === "string") {
      let s = v;
      for (const re of [...SECRET_VALUE, ...(serials ? SERIAL_VALUE : [])]) s = s.replace(re, () => { redactions++; return "[REDACTED]"; });
      return s;
    }
    if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
    if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (SECRET_KEY.test(k) || (serials && SERIAL_KEY.test(k)) || (options.dropKeys ?? []).some(re => re.test(k))) { redactions++; continue; }
        out[k] = walk(x, depth + 1);
      }
      return out;
    }
    redactions++;
    return null; // functions, symbols, bigint: not archivable
  };
  return { value: walk(value, 0), redactions };
}

/** Credential-like strings in text, ignoring the manifest's model hash fields. */
export function findSecrets(text: string): string[] {
  const found: string[] = [];
  for (const re of SECRET_VALUE) for (const m of text.matchAll(new RegExp(re.source, re.flags))) found.push(m[0]);
  return found;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(d, b => b.toString(16).padStart(2, "0")).join("");
}
const encoder = new TextEncoder();

export interface ArchiveSummary {
  totalBytes: number;
  categories: Record<EntryCategory, { entries: number; bytes: number }>;
  /** Records per kind in the chunks (input, actuator, truth, sensor, event, gap). */
  recordsByKind: Record<string, number>;
  redactions: number;
}

export interface ExportResult { bytes: Uint8Array<ArrayBuffer>; summary: ArchiveSummary; index: ArchiveEntry[] }

const KIND_NAMES: Record<RecordKindValue, string> = { 1: "input", 2: "actuator", 3: "truth", 4: "sensor", 5: "event", 6: "gap" };

/** Builds an archive from a store; reports are optional JSON objects (e.g. resimulation reports). */
export async function exportArchive(store: ChunkStore, metadata: unknown, reports: readonly unknown[] = [], options: RedactionOptions = {}): Promise<ExportResult> {
  const manifest = await store.getManifest();
  if (!manifest) throw new Error("Nothing to export: no manifest");
  const parts: { name: string; category: EntryCategory; bytes: Uint8Array }[] = [];
  parts.push({ name: "manifest.json", category: "manifest", bytes: encoder.encode(JSON.stringify(parseManifest(manifest))) });
  const { value: cleanMeta, redactions } = redactMetadata(metadata, options);
  parts.push({ name: "metadata.json", category: "metadata", bytes: encoder.encode(JSON.stringify(cleanMeta)) });
  reports.forEach((r, i) => parts.push({ name: `report-${i}.json`, category: "report", bytes: encoder.encode(JSON.stringify(redactMetadata(r, options).value)) }));
  const recordsByKind: Record<string, number> = {};
  for (const seq of await store.list()) {
    const bytes = await store.get(seq);
    if (!bytes) continue;
    const info = readChunk(bytes);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < info.records; i++) {
      const kind = v.getUint32(CHUNK_HEADER_BYTES + i * RECORD_BYTES, true);
      const name = isRecordKind(kind) ? KIND_NAMES[kind] : "unknown";
      recordsByKind[name] = (recordsByKind[name] ?? 0) + 1;
    }
    parts.push({ name: `chunks/${seq}.bin`, category: "chunk", bytes });
  }
  // The final guarantee: no credential-like text in any JSON part (manifest model hashes excepted).
  for (const p of parts) {
    if (p.category === "chunk") continue;
    let text = new TextDecoder().decode(p.bytes);
    if (p.category === "manifest") text = text.replace(/"(physics|airframe)":"[a-f0-9]{64}"/g, "");
    const secrets = findSecrets(text);
    if (secrets.length > 0) throw new Error(`Export refused: ${p.name} still contains credential-like text`);
  }
  const index: ArchiveEntry[] = [];
  let offset = 0;
  for (const p of parts) { index.push({ name: p.name, category: p.category, offset, bytes: p.bytes.byteLength, sha256: await sha256Hex(p.bytes) }); offset += p.bytes.byteLength; }
  const indexBytes = encoder.encode(JSON.stringify(index));
  const total = HEADER_BYTES + indexBytes.byteLength + offset;
  const out = new Uint8Array(total);
  out.set(encoder.encode(ARCHIVE_MAGIC), 0);
  const v = new DataView(out.buffer);
  v.setUint32(8, ARCHIVE_VERSION, true); v.setUint32(12, index.length, true); v.setUint32(16, indexBytes.byteLength, true); v.setFloat64(24, total, true);
  out.set(hexBytes(await sha256Hex(indexBytes)), 32);
  out.set(indexBytes, HEADER_BYTES);
  let at = HEADER_BYTES + indexBytes.byteLength;
  for (const p of parts) { out.set(p.bytes, at); at += p.bytes.byteLength; }
  return { bytes: out, summary: summarize(index, total, recordsByKind, redactions), index };
}

function hexBytes(hex: string): Uint8Array { const b = new Uint8Array(hex.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16); return b; }

export function summarize(index: readonly ArchiveEntry[], totalBytes: number, recordsByKind: Record<string, number> = {}, redactions = 0): ArchiveSummary {
  const categories: ArchiveSummary["categories"] = { manifest: { entries: 0, bytes: 0 }, chunk: { entries: 0, bytes: 0 }, metadata: { entries: 0, bytes: 0 }, report: { entries: 0, bytes: 0 } };
  for (const e of index) { categories[e.category].entries++; categories[e.category].bytes += e.bytes; }
  return { totalBytes, categories, recordsByKind, redactions };
}

/** Minimal Blob surface used by import (lets tests count bytes actually read). */
export interface BlobLike { readonly size: number; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } }

function validateIndex(value: unknown, payloadBytes: number, limits: ArchiveLimits): ArchiveEntry[] {
  if (!Array.isArray(value)) throw new Error("Archive index must be a list");
  const entries: ArchiveEntry[] = [];
  let expected = 0;
  const names = new Set<string>();
  for (const raw of value as unknown[]) {
    if (typeof raw !== "object" || raw === null) throw new Error("Invalid archive entry");
    const e = raw as Record<string, unknown>;
    if (Object.keys(e).length !== 5 || typeof e.name !== "string" || !/^(manifest|metadata)\.json$|^report-\d{1,6}\.json$|^chunks\/\d{1,10}\.bin$/.test(e.name) || names.has(e.name) ||
      (e.category !== "manifest" && e.category !== "chunk" && e.category !== "metadata" && e.category !== "report") ||
      typeof e.offset !== "number" || typeof e.bytes !== "number" || !Number.isSafeInteger(e.offset) || !Number.isSafeInteger(e.bytes) ||
      typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256)) throw new Error("Invalid archive entry");
    if (e.offset !== expected) throw new Error("Archive entries overlap or leave holes");
    if (e.bytes < 0 || e.bytes > limits.maxEntryBytes) throw new Error("Archive entry exceeds the size limit");
    names.add(e.name);
    expected += e.bytes;
    entries.push({ name: e.name, category: e.category, offset: e.offset, bytes: e.bytes, sha256: e.sha256 });
  }
  if (expected !== payloadBytes) throw new Error("Archive payload size does not match its index");
  if (entries.filter(e => e.category === "manifest").length !== 1) throw new Error("Archive needs exactly one manifest");
  return entries;
}

/** Reads header and index only (bounded), for preview before import. */
export async function inspectArchive(blob: BlobLike, limits: ArchiveLimits = DEFAULT_LIMITS): Promise<{ index: ArchiveEntry[]; summary: ArchiveSummary; payloadStart: number }> {
  if (blob.size < HEADER_BYTES) throw new Error("Not an AAR archive (too short)");
  if (blob.size > limits.maxArchiveBytes) throw new Error("Archive exceeds the size limit");
  const header = new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
  if (header.byteLength !== HEADER_BYTES || new TextDecoder().decode(header.subarray(0, 8)) !== ARCHIVE_MAGIC) throw new Error("Not an AAR archive");
  const v = new DataView(header.buffer);
  if (v.getUint32(8, true) !== ARCHIVE_VERSION) throw new Error("Unsupported archive version");
  const count = v.getUint32(12, true), indexLength = v.getUint32(16, true), total = v.getFloat64(24, true);
  if (count > limits.maxEntries) throw new Error("Archive declares too many entries");
  if (indexLength > limits.maxIndexBytes) throw new Error("Archive index exceeds the size limit");
  if (total !== blob.size || HEADER_BYTES + indexLength > total) throw new Error("Archive size does not match its header");
  const indexBytes = new Uint8Array(await blob.slice(HEADER_BYTES, HEADER_BYTES + indexLength).arrayBuffer());
  const declared = Array.from(header.subarray(32, 64), b => b.toString(16).padStart(2, "0")).join("");
  if ((await sha256Hex(indexBytes)) !== declared) throw new Error("Archive index hash mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes)); } catch { throw new Error("Archive index is not valid JSON"); }
  const payloadStart = HEADER_BYTES + indexLength;
  const index = validateIndex(parsed, total - payloadStart, limits);
  if (index.length !== count) throw new Error("Archive entry count does not match its header");
  return { index, summary: summarize(index, total), payloadStart };
}

export interface ImportResult { manifest: SessionManifest; metadata: unknown; reports: unknown[]; chunks: number; summary: ArchiveSummary }

/** Verifies the whole archive, then writes manifest and chunks into an empty target store. */
export async function importArchive(blob: BlobLike, target: ChunkStore, limits: ArchiveLimits = DEFAULT_LIMITS): Promise<ImportResult> {
  const { index, summary, payloadStart } = await inspectArchive(blob, limits);
  if ((await target.list()).length > 0 || (await target.getManifest())) throw new Error("Import target store is not empty");
  const verified: { entry: ArchiveEntry; bytes: Uint8Array }[] = [];
  for (const entry of index) {
    const bytes = new Uint8Array(await blob.slice(payloadStart + entry.offset, payloadStart + entry.offset + entry.bytes).arrayBuffer());
    if (bytes.byteLength !== entry.bytes || (await sha256Hex(bytes)) !== entry.sha256) throw new Error(`Archive entry ${entry.name} hash mismatch`);
    if (entry.category === "chunk") readChunk(bytes); // CRC and structure
    verified.push({ entry, bytes });
  }
  const text = (name: string): unknown => {
    const found = verified.find(x => x.entry.name === name);
    return found ? (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(found.bytes)) as unknown) : null;
  };
  const manifest = parseManifest(text("manifest.json"));
  const reports = verified.filter(x => x.entry.category === "report").map(x => text(x.entry.name));
  await target.putManifest(manifest);
  let chunks = 0;
  for (const { entry, bytes } of verified) {
    if (entry.category !== "chunk") continue;
    await target.put(Number(entry.name.slice(7, -4)), bytes);
    chunks++;
  }
  return { manifest, metadata: text("metadata.json"), reports, chunks, summary };
}
