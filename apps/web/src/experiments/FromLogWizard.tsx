import { useState, type ChangeEvent } from "react";
import { extractFromLog, logSpan, missingFields, withSupplied, type LogExtraction } from "@mirage/analysis/log-to-experiment";
import { parseParamFile } from "@mirage/autopilot/param-file";
import { readDataFlash } from "@mirage/dataflash/reader";
import type { StoredVersion } from "@mirage/project/schema";
import type { SessionLink } from "../run/session-link";

// Create experiment from log (TASK-182, S15): a log and an interval, what they give field by field, the aircraft the user supplies, and
// a run on the Run tab that starts from it. It says plainly that this is not a replay, and it never needs a log to exist: a run without
// one goes on as it always did.

const STATUS_TEXT = { extracted: "From the log", "user-supplied": "You supplied this", missing: "Missing" } as const;
const sha256 = async (bytes: ArrayBuffer): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");

export function FromLogWizard({ link, profiles, onRun }: { link: SessionLink; profiles: readonly StoredVersion[]; onRun: () => void }) {
  const [file, setFile] = useState<{ readonly name: string; readonly bytes: Uint8Array; readonly sha256: string; readonly span: { readonly fromS: number; readonly toS: number } } | null>(null);
  const [fromS, setFromS] = useState(""), [toS, setToS] = useState("");
  const [extraction, setExtraction] = useState<LogExtraction | null>(null);
  const [profileSha, setProfileSha] = useState("");
  const [refusal, setRefusal] = useState("");
  const [changesText, setChangesText] = useState("");
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = "";
    if (!chosen) return;
    setExtraction(null); setRefusal("");
    void chosen.arrayBuffer().then(async buffer => {
      const bytes = new Uint8Array(buffer), span = logSpan(readDataFlash(bytes));
      if (!span) { setFile(null); setRefusal(`${chosen.name} holds no timed records, so it is not a log this can read.`); return; }
      setFile({ name: chosen.name, bytes, sha256: await sha256(buffer), span });
      setFromS(span.fromS.toFixed(2)); setToS(span.toS.toFixed(2));
    }, (cause: unknown) => setRefusal(`${chosen.name} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const extract = () => {
    if (!file) return;
    setRefusal("");
    try { setExtraction(extractFromLog(file.name, file.bytes, { fromS: Number(fromS), toS: Number(toS) })); } catch (cause) {
      setExtraction(null);
      setRefusal(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const profile = profiles.find(item => item.sha256 === profileSha);
  const load = () => {
    if (!file || !extraction || !profile) return;
    let changes: readonly { readonly name: string; readonly value: number }[];
    try { changes = parseParamFile(changesText); } catch (cause) { setRefusal(`The changed parameters cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`); return; }
    link.planFromLog({ logSha256: file.sha256, profileSha256: profile.sha256, extraction: withSupplied(extraction, "aircraft", `${profile.record.name}, version ${profile.record.version}`), changes });
    onRun();
  };
  const missing = extraction ? missingFields(extraction).filter(field => field.key !== "aircraft" || !profile) : [];
  return (
    <section className="project-section" aria-labelledby="from-log-heading" data-testid="from-log">
      <h3 id="from-log-heading">Create experiment from log</h3>
      <p className="hint">A log gives a place, settings and what it saw. A run starts on the ground with its own simulated sensors, so this is an experiment like that flight and not a replay of it.</p>
      <label htmlFor="from-log-file">DataFlash log (.bin)</label>
      <input id="from-log-file" type="file" accept=".bin,.BIN,application/octet-stream" onChange={choose} />
      {file && (
        <div className="sitl-form" data-testid="from-log-interval">
          <p className="hint">{`${file.name} runs from ${file.span.fromS.toFixed(2)} s to ${file.span.toS.toFixed(2)} s on its own clock.`}</p>
          <label htmlFor="from-log-from">From, s</label>
          <input id="from-log-from" value={fromS} onChange={event => setFromS(event.target.value)} />
          <label htmlFor="from-log-to">To, s</label>
          <input id="from-log-to" value={toS} onChange={event => setToS(event.target.value)} />
          <button type="button" onClick={extract}>Read the log</button>
        </div>
      )}
      {refusal && <p className="alert" role="alert" data-testid="from-log-refused">{refusal}</p>}
      {extraction && (
        <>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="What the log gives table">
            <table className="scheme-table" aria-label="What the log gives" data-testid="from-log-report">
              <thead><tr><th scope="col">Field</th><th scope="col">Status</th><th scope="col">Value</th><th scope="col">From</th><th scope="col">Note</th></tr></thead>
              <tbody>
                {extraction.fields.map(field => {
                  const supplied = field.key === "aircraft" && profile;
                  return (
                    <tr key={field.key} data-key={field.key} data-status={supplied ? "user-supplied" : field.status}>
                      <th scope="row">{field.label}</th>
                      <td>{STATUS_TEXT[supplied ? "user-supplied" : field.status]}</td>
                      <td>{supplied ? `${profile.record.name}, version ${profile.record.version}` : field.value ?? "—"}</td>
                      <td>{supplied ? "You" : field.source ?? "—"}</td>
                      <td>{field.note ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <h4>Missing from this log</h4>
          {missing.length === 0 ? <p className="hint" data-testid="from-log-missing">Nothing this report asks for.</p> : (
            <ul data-testid="from-log-missing">
              {missing.map(field => <li key={field.key}>{`${field.label}${field.note ? `: ${field.note}` : ""}`}</li>)}
            </ul>
          )}
          {extraction.skipped.length > 0 && (
            <details data-testid="from-log-skipped">
              <summary>{`${extraction.skipped.length} parameters that stay out of the new run`}</summary>
              <ul>{extraction.skipped.map(item => <li key={item.name}>{`${item.name} = ${item.value}: ${item.why}`}</li>)}</ul>
            </details>
          )}
          <div className="sitl-form">
            <label htmlFor="from-log-aircraft">Aircraft for the new run</label>
            <select id="from-log-aircraft" value={profileSha} onChange={event => setProfileSha(event.target.value)}>
              <option value="">Choose one</option>
              {profiles.map(item => <option key={item.sha256} value={item.sha256}>{`${item.record.name} (version ${item.record.version})`}</option>)}
            </select>
            <button type="button" onClick={load} disabled={!profile}>Load into the Run tab</button>
          </div>
          <div className="field">
            <label htmlFor="from-log-changes">Change parameters for this run (NAME,VALUE on each line; empty flies the log's own)</label>
            <textarea id="from-log-changes" rows={3} value={changesText} placeholder="NAME,VALUE on each line" onChange={event => setChangesText(event.target.value)} />
          </div>
          {profiles.length === 0 && <p className="hint">This project has no aircraft profile yet: make one on the Aircraft tab.</p>}
        </>
      )}
    </section>
  );
}
