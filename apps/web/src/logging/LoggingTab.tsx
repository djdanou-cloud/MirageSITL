import { useEffect, useMemo, useState } from "react";
import type { SignalGroup } from "@mirage/aar/signal-catalog";
import type { StoredVersion } from "@mirage/project/schema";
import type { StoreState } from "../shell/AppShell";
import { SITL_PHYSICS_HZ } from "../sitl/sitl-run";
import { DEFAULT_LOGGING, loadLoggingSettings, planOf, saveLoggingSettings, type LoggingSettings } from "./logging-settings";
import { growth, recordingMonitor, type LiveRecording } from "./recording-monitor";
import { estimatedBytes, estimateRecording, megabytes, RUN_TAB_SOURCES } from "./size-estimate";
import { freeBytes, storageWarnings, type StorageState } from "./storage-warning";

// The Logging tab (TASK-163, S13): the rates the next Run-tab run records, with
// requested and effective rates and each source's limit, the size estimate
// per simulated hour and for a chosen run length, the browser's storage, and
// the recording a run is writing now with its growth, gaps and warnings. All
// signals start at the common rate, A-09's 50 Hz; a group or a signal may
// override it, and 0 records none of it. An invalid rate is refused with its
// reason and cannot be saved.

const GROUPS: readonly SignalGroup[] = ["truth", "pilot", "actuators", "motors", "battery", "sensors", "autopilot"];
const GROUP_LABELS: Readonly<Record<SignalGroup, string>> = {
  truth: "Truth", pilot: "Pilot input", actuators: "Actuator outputs", motors: "Motors", battery: "Battery", sensors: "MirageSITL sensors",
  autopilot: "Autopilot telemetry", events: "Events",
};
const SOURCE_TEXT = { physics: "physics tick", sensor: "sensor frame", telemetry: "autopilot message", event: "event" } as const;

interface Form {
  readonly commonHz: string;
  readonly groups: Readonly<Partial<Record<SignalGroup, string>>>;
  readonly signals: Readonly<Record<string, string>>;
  readonly durationMin: string;
  readonly reserveMb: string;
}
function formOf(settings: LoggingSettings): Form {
  const text = (record: Readonly<Record<string, number | undefined>>) =>
    Object.fromEntries(Object.entries(record).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])));
  return { commonHz: String(settings.commonHz), groups: text(settings.groups), signals: text(settings.signals), durationMin: String(settings.durationMin),
    reserveMb: String(settings.reserveMb) };
}
/** A whole number of hertz, or the reason it is not one. */
function rateOf(text: string, label: string, errors: string[]): number {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isInteger(value)) { errors.push(`${label}: "${text}" is not a whole number of hertz`); return 0; }
  return value;
}
/** The settings of a form, or the reasons it holds none; the rates are checked by the plan. */
function settingsOf(form: Form): { settings: LoggingSettings | null; errors: string[] } {
  const errors: string[] = [];
  const commonHz = rateOf(form.commonHz, "Common rate", errors);
  const groups: Partial<Record<SignalGroup, number>> = {}, signals: Record<string, number> = {};
  for (const group of GROUPS) {
    const text = form.groups[group];
    if (text !== undefined && text.trim() !== "") groups[group] = rateOf(text, `${GROUP_LABELS[group]} rate`, errors);
  }
  for (const [name, text] of Object.entries(form.signals)) if (text.trim() !== "") signals[name] = rateOf(text, `${name} rate`, errors);
  const durationMin = Number(form.durationMin), reserveMb = Number(form.reserveMb);
  if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 1440) errors.push("Run length: a whole number of minutes from 1 to 1440");
  if (!Number.isFinite(reserveMb) || reserveMb < 0 || form.reserveMb.trim() === "") errors.push("Storage reserve: a number of megabytes, 0 or more");
  if (errors.length > 0) return { settings: null, errors };
  const settings: LoggingSettings = { schemaVersion: 1, commonHz, groups, signals, durationMin, reserveMb };
  try {
    planOf(settings, SITL_PHYSICS_HZ);
  } catch (error) {
    return { settings: null, errors: [error instanceof Error ? error.message : String(error)] };
  }
  return { settings, errors: [] };
}

/** `active`: the tab is shown; the quota is read again whenever it is. `storage` replaces the browser's estimate (tests). */
export function LoggingTab({ storeState, project, active, storage }: {
  storeState: StoreState; project: StoredVersion | null; active: boolean; storage?: () => Promise<StorageState | null>;
}) {
  const store = storeState.status === "ready" ? storeState.store : null;
  const [saved, setSaved] = useState<LoggingSettings>(DEFAULT_LOGGING);
  const [form, setForm] = useState<Form>(formOf(DEFAULT_LOGGING));
  const [status, setStatus] = useState("");
  const [quota, setQuota] = useState<StorageState | null | "unavailable">(null);
  const [live, setLive] = useState<LiveRecording | null>(recordingMonitor.current);

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    void loadLoggingSettings(store).then(settings => { if (!cancelled) { setSaved(settings); setForm(formOf(settings)); } });
    return () => { cancelled = true; };
  }, [store]);
  useEffect(() => recordingMonitor.subscribe(setLive), []);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const read = async (): Promise<void> => {
      const next = storage ? await storage() : typeof navigator.storage?.estimate === "function"
        ? await navigator.storage.estimate().then(e => (e.quota === undefined || e.usage === undefined ? null : { quotaBytes: e.quota, usageBytes: e.usage }))
        : null;
      if (!cancelled) setQuota(next ?? "unavailable");
    };
    void read();
    const timer = setInterval(() => { void read(); }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active, storage]);

  const { settings, errors } = useMemo(() => settingsOf(form), [form]);
  const plan = useMemo(() => planOf(settings ?? saved, SITL_PHYSICS_HZ), [settings, saved]);
  const estimate = useMemo(() => estimateRecording(plan, RUN_TAB_SOURCES), [plan]);
  const shown = settings ?? saved;
  const plannedBytes = estimatedBytes(estimate, shown.durationMin * 60), reserveBytes = shown.reserveMb * 1e6;
  const dirty = settings !== null && JSON.stringify(settings) !== JSON.stringify(saved);
  const liveGrowth = live ? growth(live) : null;
  const elapsedS = live ? live.simTimeS - live.startSimTimeS : 0;
  const warnings = quota && quota !== "unavailable"
    ? storageWarnings(quota, plannedBytes, reserveBytes, live?.state === "recording" && liveGrowth?.perSimS != null
      ? { bytesPerSimS: liveGrowth.perSimS, remainingSimS: shown.durationMin * 60 - elapsedS } : null)
    : [];

  const save = () => {
    if (!store || !settings) return;
    void saveLoggingSettings(store, settings).then(() => { setSaved(settings); setStatus("Saved. The next run records with these rates."); },
      (error: unknown) => setStatus(`Not saved: ${error instanceof Error ? error.message : String(error)}`));
  };
  const setGroup = (group: SignalGroup, text: string) => setForm({ ...form, groups: { ...form.groups, [group]: text } });
  const setSignal = (name: string, text: string) => setForm({ ...form, signals: { ...form.signals, [name]: text } });

  return (
    <div className="logging-panel">
      <h2>Logging</h2>
      <p>
        What the next run records{project ? "" : " (open a project to keep the settings)"}: every signal at the common rate, A-09&apos;s 50 Hz by
        default, with overrides per group or signal. A rate is a whole number of hertz from 1 to 2000, or 0 for none; a source records no faster than it
        produces, so a higher request is limited to the source&apos;s rate. Runs on the Run tab step the physics at {SITL_PHYSICS_HZ} Hz.
      </p>
      <section className="project-section" aria-labelledby="logging-rates-heading">
        <h3 id="logging-rates-heading">Rates</h3>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="logging-common">Common rate (Hz)</label>
            <input id="logging-common" type="text" inputMode="numeric" value={form.commonHz} onChange={event => setForm({ ...form, commonHz: event.target.value })} />
          </div>
          {GROUPS.map(group => (
            <div className="field" key={group}>
              <label htmlFor={`logging-group-${group}`}>{GROUP_LABELS[group]} (Hz)</label>
              <input id={`logging-group-${group}`} type="text" inputMode="numeric" placeholder="common" value={form.groups[group] ?? ""}
                onChange={event => setGroup(group, event.target.value)} />
            </div>
          ))}
        </div>
        {errors.length > 0 && (
          <ul className="form-errors" aria-label="Rates that cannot be recorded">{errors.map(error => <li key={error}>{error}</li>)}</ul>
        )}
        <div className="table-scroll">
          <table className="entry-table" aria-label="Recorded signals">
            <thead>
              <tr>
                <th scope="col">Signal</th><th scope="col">Source</th><th scope="col">Source rate</th><th scope="col">Requested</th>
                <th scope="col">Effective</th><th scope="col">Override (Hz)</th><th scope="col">Per simulated second</th>
              </tr>
            </thead>
            <tbody>
              {plan.signals.filter(signal => signal.source !== "event").map(signal => {
                const size = estimate.signals.find(item => item.name === signal.name);
                const note = !size?.produced ? "not produced in a Run-tab run" : signal.capped ? `limited to the source's ${signal.sourceHz ?? 0} Hz` : "";
                return (
                  <tr key={signal.name} data-signal={signal.name}>
                    <th scope="row">{signal.name}</th>
                    <td>{SOURCE_TEXT[signal.source]}</td>
                    <td>{signal.sourceHz === null ? "—" : `${signal.aperiodic ? "up to " : ""}${signal.sourceHz} Hz`}</td>
                    <td>{signal.requestedHz ?? "—"} Hz</td>
                    <td data-testid={`effective-${signal.name}`}>{signal.effectiveHz ?? 0} Hz{note ? ` (${note})` : ""}</td>
                    <td>
                      <input type="text" inputMode="numeric" aria-label={`${signal.name} override (Hz)`} placeholder="group" value={form.signals[signal.name] ?? ""}
                        onChange={event => setSignal(signal.name, event.target.value)} />
                    </td>
                    <td>{size ? `${size.rowsPerSimS} rows, ${(size.bytesPerSimS / 1000).toFixed(1)} kB` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">Events (parameters, weather, faults, pauses and accidents) are always recorded, when they happen.</p>
      </section>
      <section className="project-section" aria-labelledby="logging-size-heading">
        <h3 id="logging-size-heading">Size</h3>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="logging-duration">Run length (simulated minutes)</label>
            <input id="logging-duration" type="text" inputMode="numeric" value={form.durationMin} onChange={event => setForm({ ...form, durationMin: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="logging-reserve">Storage reserve (MB)</label>
            <input id="logging-reserve" type="text" inputMode="decimal" value={form.reserveMb} onChange={event => setForm({ ...form, reserveMb: event.target.value })} />
          </div>
        </div>
        <dl className="sitl-status">
          <dt>Per simulated hour</dt><dd data-testid="logging-per-hour">{megabytes(estimate.bytesPerSimHour)}{estimate.upperBound ? " at most" : ""}</dd>
          <dt>For {shown.durationMin} simulated minutes</dt><dd data-testid="logging-total">{megabytes(plannedBytes)}{estimate.upperBound ? " at most" : ""}</dd>
          <dt>Free storage</dt>
          <dd data-testid="logging-free">{quota === null ? "Reading…" : quota === "unavailable" ? "This browser does not report its storage quota" : `${megabytes(freeBytes(quota))} of ${megabytes(quota.quotaBytes)}`}</dd>
        </dl>
        <p className="hint">Autopilot telemetry arrives when the autopilot sends it, so its share is an upper bound; the browser&apos;s own storage overhead is not counted.</p>
        <div className="button-row">
          <button type="button" className="save-button" disabled={!store || !dirty} onClick={save}>Save logging settings</button>
        </div>
        <p role="status" className="status-message" data-testid="logging-status">{status}</p>
      </section>
      <section className="project-section" aria-labelledby="logging-live-heading">
        <h3 id="logging-live-heading">Current recording</h3>
        {!live ? <p>No run is recording.</p> : (
          <dl className="sitl-status" data-testid="logging-live" data-state={live.state}>
            <dt>Record</dt><dd>{live.recordId} of run {live.experimentId} ({live.state})</dd>
            <dt>Stored</dt><dd data-testid="logging-bytes">{megabytes(live.bytes)} over {elapsedS.toFixed(1)} simulated s</dd>
            <dt>Growth</dt>
            <dd data-testid="logging-growth">
              {liveGrowth?.perSimS == null ? "Measuring…" : `${megabytes(liveGrowth.perSimS * 3600)} per simulated hour`}
              {liveGrowth?.perWallS == null ? "" : `, ${megabytes(liveGrowth.perWallS)} per real second`}
            </dd>
            <dt>Gaps</dt>
            <dd data-testid="logging-gaps">{live.lostRows === 0 && live.droppedChunks === 0 ? "None"
              : `${live.lostRows} rows lost before the recorder could take them, ${live.droppedChunks} chunks storage refused; each is a gap in the record`}</dd>
            {live.error && <><dt>Error</dt><dd>{live.error}</dd></>}
          </dl>
        )}
      </section>
      {warnings.length > 0 && (
        <div role="alert">
          <ul className="form-errors" aria-label="Storage warnings" data-testid="logging-warnings">{warnings.map(text => <li key={text}>{text}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
