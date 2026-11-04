import { useEffect, useMemo, useState } from "react";
import type { ParameterMetadataSet } from "@mirage/autopilot/param-metadata";
import {
  formatParamFile, groupOf, selectParameters, type ExportCandidate, type ExportSelection, type ParamFileContext,
} from "@mirage/autopilot/param-file";
import type { ParameterValue } from "@mirage/autopilot/param-service";
import { readExperiment, type ExperimentPayload } from "@mirage/aircraft/experiment";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import { valueText } from "./ParameterHistory";
import type { ParameterSet } from "./parameter-sets";

// Parameter file export (TASK-161, S11): an ArduPilot parameter file of the
// running SITL's read-back, of an experiment record's parameters (generated
// from its saved profile) or of a stored parameter set. All parameters, the
// changes against a stored set, or chosen parameters and groups. The preview
// shows each value with its source before anything is saved; a write that
// is still pending is never exported as a value, the file holds ArduPilot's
// confirmed one. The aircraft, firmware and experiment context goes into the
// file's comments. The aircraft profile with its component cards and
// measurement sets is saved separately, as a project archive. Nothing is
// written to a flight controller.

/** Rows of the preview shown at once. */
const SHOWN_ROWS = 200;
const SOURCE_TEXT = { sitl: "SITL read-back", experiment: "Experiment record", set: "Parameter set" } as const;

export interface LiveParameters {
  readonly list: readonly ParameterValue[];
  /** Requested values of writes ArduPilot has not answered yet, by name. */
  readonly pending: ReadonlyMap<string, number>;
  readonly experimentId: string;
  readonly recordSha256: string | null;
}
interface StoredSet { readonly stored: StoredVersion; readonly set: ParameterSet }
interface StoredExperiment { readonly stored: StoredVersion; readonly payload: ExperimentPayload }

/** A file name from free text: letters, digits, dot, dash and underscore. */
function fileName(text: string, extension: string): string {
  return `${text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "parameters"}${extension}`;
}
function download(bytes: BlobPart, type: string, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function firmwareOf(payload: ExperimentPayload): ParamFileContext["firmware"] {
  return { version: payload.sitl.ardupilot.firmwareVersion, commit: payload.sitl.ardupilot.commit };
}
function experimentIdOf(payload: ExperimentPayload): string {
  return payload.sitl.ownership === "external" ? payload.sitl.connectionId : payload.sitl.experimentId;
}
const words = (text: string) => text.split(/[\s,]+/).map(word => word.trim().toUpperCase()).filter(word => word !== "");

export function ParameterExport({ store, projectId, live, sets, metadata }: {
  store: ProjectStore | null; projectId: string | null; live: LiveParameters | null; sets: readonly StoredSet[]; metadata: ParameterMetadataSet | null;
}) {
  const [experiments, setExperiments] = useState<readonly StoredExperiment[]>([]);
  const [source, setSource] = useState("live");
  const [mode, setMode] = useState<ExportSelection["kind"]>("all");
  const [baseline, setBaseline] = useState("");
  const [names, setNames] = useState("");
  const [groups, setGroups] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!store || !projectId) { setExperiments([]); return; }
    let cancelled = false;
    store.listItems(projectId, "experiment").then(list => {
      if (!cancelled) setExperiments(list.flatMap(stored => { try { return [{ stored, payload: readExperiment(stored) }]; } catch { return []; } }));
    }, (cause: unknown) => { if (!cancelled) setNotice(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [store, projectId, live?.recordSha256, sets.length]);
  useEffect(() => { setBaseline(current => sets.some(s => s.stored.sha256 === current) ? current : sets[0]?.stored.sha256 ?? ""); }, [sets]);

  // The candidates of the chosen source, with each value's source, and the experiment record that gives the context.
  const chosen = useMemo((): { candidates: readonly ExportCandidate[]; label: string; record: string | null } => {
    if (source === "live") {
      if (!live || live.list.length === 0) return { candidates: [], label: "the running SITL's read-back", record: null };
      return {
        label: "the running SITL's read-back", record: live.recordSha256,
        candidates: live.list.map(p => {
          const pending = live.pending.get(p.name), facts = metadata?.get(p.name);
          const note = pending !== undefined ? `A write of ${valueText(pending)} is pending; the file holds ArduPilot's confirmed value`
            : facts?.readOnly ? "Read-only in ArduPilot's metadata: a ground station cannot write it" : facts?.volatile ? "ArduPilot changes it itself" : null;
          return { name: p.name, value: p.value, source: "sitl", note };
        }),
      };
    }
    const [kind, sha] = source.split(":");
    if (kind === "experiment") {
      const found = experiments.find(e => e.stored.sha256 === sha);
      if (!found) return { candidates: [], label: "", record: null };
      return { label: `the parameters of experiment ${experimentIdOf(found.payload)}, generated from its saved profile`, record: found.stored.sha256,
        // ArduPilot holds every value as a float32, so the file holds the float32 of the generated value.
        // Where that run started is no part of the profile, and a vehicle works its own COMPASS_DEC out wherever it is.
        candidates: found.payload.parameters.filter(p => p.source !== "site").map(p => ({ name: p.name, value: Math.fround(p.value), source: "experiment",
          note: `Generated from the saved profile (${p.source})${Math.fround(p.value) === p.value ? "" : `; ${p.value} as ArduPilot's float32`}` })) };
    }
    const found = sets.find(s => s.stored.sha256 === sha);
    if (!found) return { candidates: [], label: "", record: null };
    return { label: `parameter set "${found.stored.record.name}" (version ${found.stored.record.version}), read back from run ${found.set.source.experimentId}`,
      record: found.set.source.experimentSha256, candidates: found.set.parameters.map(p => ({ name: p.name, value: p.value, source: "set", note: null })) };
  }, [source, live, metadata, experiments, sets]);

  const baselineSet = sets.find(s => s.stored.sha256 === baseline);
  const selection = useMemo((): { value: ExportSelection; text: string } | null => {
    switch (mode) {
      case "all": return { value: { kind: "all" }, text: `all ${chosen.candidates.length} parameters` };
      case "changes":
        return baselineSet ? { value: { kind: "changes", baseline: baselineSet.set.parameters },
          text: `the parameters that differ from parameter set "${baselineSet.stored.record.name}" (version ${baselineSet.stored.record.version}) or that it does not hold` } : null;
      case "chosen":
        return { value: { kind: "chosen", names: words(names), groups: words(groups) },
          text: `the parameters ${words(names).join(", ") || "(none)"} and the groups ${words(groups).join(", ") || "(none)"}` };
      default: { const never: never = mode; return never; }
    }
  }, [mode, chosen.candidates.length, baselineSet, names, groups]);
  const selected = useMemo(() => selection ? selectParameters(chosen.candidates, selection.value) : [], [chosen.candidates, selection]);
  const record = experiments.find(e => e.stored.sha256 === chosen.record);
  const context = (): ParamFileContext => ({
    exportedAt: new Date().toISOString(), source: chosen.label, selection: selection?.text ?? "",
    aircraft: record ? { name: record.payload.profile.name, version: record.payload.profile.version, sha256: record.payload.profile.sha256 } : null,
    firmware: record ? firmwareOf(record.payload) : null,
    experiment: record ? { id: experimentIdOf(record.payload), sha256: record.stored.sha256 } : live && source === "live" ? { id: live.experimentId, sha256: live.recordSha256 ?? "not saved" } : null,
  });
  const groupList = useMemo(() => [...new Set(chosen.candidates.map(c => groupOf(c.name)))].sort(), [chosen.candidates]);

  const saveFile = () => {
    try {
      const text = formatParamFile(context(), selected);
      download(text, "text/plain", fileName(`${record?.payload.profile.name ?? "parameters"}-${source === "live" ? live?.experimentId ?? "sitl" : source.replace(":", "-").slice(0, 20)}`, ".param"));
      setNotice(`Saved ${selected.length} parameters.`);
    } catch (cause) {
      setNotice(`The file was not saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const saveSettings = () => {
    if (!store || !projectId || !record) return;
    store.exportItems(projectId, [record.payload.profile.sha256]).then(result => {
      download(result.archive, "application/octet-stream", fileName(`${record.payload.profile.name}-simulator-settings`, ".mirageproj"));
      setNotice(`Saved the simulator settings: ${result.entries} records${result.missing.length > 0 ? `, ${result.missing.length} dependencies missing from this store` : ""}.`);
    }, (cause: unknown) => setNotice(`The simulator settings were not saved: ${cause instanceof Error ? cause.message : String(cause)}`));
  };

  return (
    <section className="project-section" aria-labelledby="parameter-export-heading">
      <h3 id="parameter-export-heading">Export a parameter file</h3>
      <p className="hint">
        An ArduPilot parameter file (NAME,VALUE lines) to load by hand into a ground station or SITL; MirageSITL never writes it to a flight controller.
        Simulator-only settings, the aircraft geometry with its component cards and measurement sets, are saved separately as a project archive.
      </p>
      <div className="sitl-actions">
        <label htmlFor="parameter-export-source">Values from</label>
        <select id="parameter-export-source" value={source} onChange={event => setSource(event.target.value)}>
          <option value="live">The running SITL (read-back)</option>
          {experiments.map(e => <option key={e.stored.sha256} value={`experiment:${e.stored.sha256}`}>{`Experiment ${e.stored.record.name}`}</option>)}
          {sets.map(s => <option key={s.stored.sha256} value={`set:${s.stored.sha256}`}>{`Parameter set ${s.stored.record.name} (version ${s.stored.record.version})`}</option>)}
        </select>
      </div>
      <fieldset className="run-mode">
        <legend>Parameters</legend>
        <label><input type="radio" name="parameter-export-mode" checked={mode === "all"} onChange={() => setMode("all")} /> All</label>
        <label><input type="radio" name="parameter-export-mode" checked={mode === "changes"} onChange={() => setMode("changes")} disabled={sets.length === 0} /> Changes against a parameter set</label>
        <label><input type="radio" name="parameter-export-mode" checked={mode === "chosen"} onChange={() => setMode("chosen")} /> Chosen parameters and groups</label>
      </fieldset>
      {mode === "changes" && (
        <div className="sitl-actions">
          <label htmlFor="parameter-export-baseline">Baseline set</label>
          <select id="parameter-export-baseline" value={baseline} onChange={event => setBaseline(event.target.value)}>
            {sets.map(s => <option key={s.stored.sha256} value={s.stored.sha256}>{`${s.stored.record.name} (version ${s.stored.record.version})`}</option>)}
          </select>
        </div>
      )}
      {mode === "chosen" && (
        <div className="field-grid">
          <div className="field">
            <label htmlFor="parameter-export-names">Parameters (names, comma-separated)</label>
            <input id="parameter-export-names" type="text" value={names} onChange={event => setNames(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="parameter-export-groups">Groups (the name up to the first underscore, comma-separated)</label>
            <input id="parameter-export-groups" type="text" list="parameter-export-group-list" value={groups} onChange={event => setGroups(event.target.value)} />
            <datalist id="parameter-export-group-list">{groupList.map(group => <option key={group} value={group} />)}</datalist>
          </div>
        </div>
      )}
      <p className="hint" data-testid="parameter-export-summary">
        {chosen.candidates.length === 0 ? "No values: start a run, or choose an experiment record or a parameter set."
          : `${selected.length} of ${chosen.candidates.length} parameters from ${chosen.label}${record ? `; aircraft ${record.payload.profile.name} version ${record.payload.profile.version}, ArduPilot ${record.payload.sitl.ardupilot.commit.slice(0, 8)}` : ""}`}
      </p>
      {selected.length > 0 && (
        <div className="table-scroll">
          <table className="scheme-table" data-testid="parameter-export-preview">
            <thead><tr><th scope="col">Parameter</th><th scope="col">Value</th><th scope="col">Source</th><th scope="col">Note</th></tr></thead>
            <tbody>
              {selected.slice(0, SHOWN_ROWS).map(c => (
                <tr key={c.name} data-name={c.name} data-source={c.source}>
                  <td>{c.name}</td><td>{valueText(c.value)}</td><td>{SOURCE_TEXT[c.source]}</td><td>{c.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected.length > SHOWN_ROWS && <p className="hint">The preview shows {SHOWN_ROWS} of {selected.length}; the file holds all of them.</p>}
      <div className="sitl-actions">
        <button type="button" onClick={saveFile} disabled={selected.length === 0}>Save the parameter file</button>
        <button type="button" onClick={saveSettings} disabled={!record || !store}>Save the simulator settings</button>
      </div>
      {!record && chosen.candidates.length > 0 && <p className="hint">The simulator settings need the experiment record of these values, which is not saved yet.</p>}
      {notice && <p className="hint" role="status" data-testid="parameter-export-notice">{notice}</p>}
    </section>
  );
}
