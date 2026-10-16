import { useEffect, useState } from "react";
import { exportArchive, type ArchiveSummary } from "@mirage/aar/archive";
import type { ChunkStore } from "@mirage/aar/storage";

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let v = bytes / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(1)} ${units[u]!}`; // u < units.length
}

/**
 * Session export (TASK-081): builds the archive on request, shows its size,
 * data categories, record counts and redactions, then offers the download.
 * Secrets are removed by exportArchive; export fails rather than leak them.
 */
export function AarExport({ store, metadata, reports = [], fileName }: {
  store: ChunkStore; metadata: unknown; reports?: readonly unknown[]; fileName: string;
}) {
  const [summary, setSummary] = useState<ArchiveSummary | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function prepare() {
    setBusy(true); setError(null);
    try {
      const result = await exportArchive(store, metadata, reports);
      setSummary(result.summary);
      setUrl(URL.createObjectURL(new Blob([result.bytes], { type: "application/octet-stream" })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return <section className="aar-export" aria-label="Session export">
    <button type="button" disabled={busy} onClick={() => { void prepare(); }}>{busy ? "Preparing…" : "Prepare export"}</button>
    {error && <p role="alert">{error}</p>}
    {summary && <>
      <p>Archive size: <strong data-testid="aar-export-size">{formatBytes(summary.totalBytes)}</strong>
        {summary.redactions > 0 && <> · {summary.redactions} item(s) redacted</>}</p>
      <table>
        <thead><tr><th>Category</th><th>Entries</th><th>Size</th></tr></thead>
        <tbody>
          {(Object.keys(summary.categories) as (keyof ArchiveSummary["categories"])[]).map(name =>
            <tr key={name}><td>{name}</td><td>{summary.categories[name].entries}</td><td>{formatBytes(summary.categories[name].bytes)}</td></tr>)}
        </tbody>
      </table>
      <p>Records: {Object.entries(summary.recordsByKind).map(([kind, n]) => `${kind} ${n}`).join(", ") || "none"}</p>
      {url && <a href={url} download={fileName}>Download {fileName}</a>}
    </>}
  </section>;
}
