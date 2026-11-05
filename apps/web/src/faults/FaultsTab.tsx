import { useEffect, useState, useSyncExternalStore } from "react";
import { EFFECT_CATALOG, EFFECT_IDS, effectDefinition, initialEffectParameters, parseEffectControl, type EffectControl, type EffectId, type EffectParameterValue, type EffectRecovery } from "@mirage/protocol";
import { EMPTY_FAULT_SCHEDULE, FAULT_TAB_FAMILIES, MAX_SCHEDULED_EFFECTS, faultTimeline, parseFaultSchedule, scheduledEffectId, withEkfDrift, type FaultSchedule, type ScheduledEffect } from "@mirage/scenarios/fault-schedule";
import { EKF_DRIFT_MAX_GROWTH_MPS2, EKF_DRIFT_MAX_SPEED_MPS, ekfDriftEndS, ekfDriftPeakM, isEkfDriftEntry, parseEkfDrift, type EkfDriftProfile, type EkfDriftRemoval } from "@mirage/scenarios/ekf-drift";
import type { StoredVersion } from "@mirage/project/schema";
import { EffectFieldInput, numberText } from "../instructor/effect-form";
import type { SessionLink } from "../run/session-link";
import type { StoreState } from "../shell/AppShell";
import { EFFECT_PATHS, FAMILY_LABELS } from "./paths";
import { loadFaultSchedule, saveFaultSchedule } from "./schedule-store";

// The Faults and interference tab (TASK-169, S09): every effect of the families that act on a flight, applied by hand on the run going now
// or put on the schedule the next run applies by itself, with onset, duration and recovery. It says what was sent and what became of it,
// and nothing about what ArduPilot will do: its reaction is in the run's recording and log. Motor faults change the physical actuation;
// sensor and link effects change what ArduPilot observes, never the truth.

const OFFERED: readonly EffectId[] = EFFECT_IDS.filter(id => FAULT_TAB_FAMILIES.includes(EFFECT_CATALOG[id].family));
const DEFAULT_EFFECT: EffectId = "motor.loss";
const STATUS_TEXT = { pending: "Pending", applied: "Applied", rejected: "Rejected" } as const;
const seconds = (value: number | null) => (value === null ? "—" : value.toFixed(2));
const summary = (control: EffectControl): string => {
  const parts = Object.entries(control.parameters).map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  return [`intensity ${control.intensity}`, ...parts].join("; ");
};
/** A number typed in a form, or null when the field is empty or not a number. */
const typed = (text: string): number | null => {
  const value = text.trim() === "" ? Number.NaN : Number(text);
  return Number.isFinite(value) ? value : null;
};

export function FaultsTab({ storeState, project, link, active }: { storeState: StoreState; project: StoredVersion | null; link: SessionLink; active: boolean }) {
  const store = storeState.status === "ready" ? storeState.store : null, projectId = project?.record.id ?? null;
  const session = useSyncExternalStore(link.subscribe, link.snapshot);
  const view = session?.view ?? null, controller = session?.controller ?? null;
  const [schedule, setSchedule] = useState<FaultSchedule>(EMPTY_FAULT_SCHEDULE);
  const [effect, setEffect] = useState<EffectId>(DEFAULT_EFFECT);
  const [intensity, setIntensity] = useState(1);
  const [parameters, setParameters] = useState<Partial<Record<EffectId, Record<string, EffectParameterValue>>>>({});
  const [recovery, setRecovery] = useState<EffectRecovery>("hold-offset");
  const [onset, setOnset] = useState("10"), [duration, setDuration] = useState("10");
  const [refusal, setRefusal] = useState("");
  // TASK-170: the EKF drift form.
  const [drift, setDrift] = useState({ directionDeg: "0", growthMps2: "0.2", topSpeedMps: "2", onsetS: "10", durationS: "10" });
  const [removal, setRemoval] = useState<EkfDriftRemoval>("gradual");
  useEffect(() => {
    if (!store || !projectId || !active) return;
    let cancelled = false;
    void loadFaultSchedule(store, projectId).then(loaded => { if (!cancelled) setSchedule(loaded); });
    return () => { cancelled = true; };
  }, [store, projectId, active]);
  const definition = effectDefinition(effect);
  const values = parameters[effect] ?? initialEffectParameters(effect);
  const running = controller !== null && controller.active;
  /** The form as a control, or the reason it cannot be one. */
  const controlOf = (id: string, enabled: boolean): EffectControl | string => {
    try {
      return parseEffectControl({ schemaVersion: 1, id, effect, enabled, intensity, parameters: values });
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  };
  const send = (enabled: boolean) => {
    setRefusal("");
    if (!controller) { setRefusal("No run is active: start one on the Run tab, or put this on the schedule."); return; }
    const control = controlOf(effect.replaceAll(".", "-"), enabled);
    if (typeof control === "string") { setRefusal(control); return; }
    // The controller refuses what it cannot deliver, and the ledger keeps that too.
    const why = controller.setEffect(control, recovery);
    if (why !== null) setRefusal(why);
  };
  const store_ = (next: FaultSchedule) => {
    setSchedule(next);
    if (store && projectId) void saveFaultSchedule(store, projectId, next).catch((cause: unknown) => setRefusal(`The schedule could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const add = () => {
    setRefusal("");
    const onsetS = typed(onset), durationS = duration.trim() === "" ? null : typed(duration);
    if (onsetS === null || onsetS < 0) { setRefusal("The onset must be a time of 0 s or more."); return; }
    if (duration.trim() !== "" && durationS === null) { setRefusal("The duration must be a number of seconds, or empty to keep it on until the run ends."); return; }
    if (schedule.entries.length >= MAX_SCHEDULED_EFFECTS) { setRefusal(`A schedule holds at most ${MAX_SCHEDULED_EFFECTS} effects.`); return; }
    const used = new Set(schedule.entries.map(entry => entry.control.id));
    let index = schedule.entries.length;
    while (used.has(scheduledEffectId(effect, index))) index++;
    const control = controlOf(scheduledEffectId(effect, index), true);
    if (typeof control === "string") { setRefusal(control); return; }
    const entry: ScheduledEffect = { control, onsetS, durationS, recovery };
    try {
      store_(parseFaultSchedule({ schemaVersion: schedule.schemaVersion, entries: [...schedule.entries, entry] }));
    } catch (cause) {
      setRefusal(cause instanceof Error ? cause.message.replace(/^Invalid fault schedule: (entries\[\d+\]: )?/, "") : String(cause));
    }
  };
  const remove = (id: string) => store_(parseFaultSchedule({ ...schedule, entries: schedule.entries.filter(entry => entry.control.id !== id) }));
  /** The form as a profile, or the reason it cannot be one. */
  const driftProfile = (): EkfDriftProfile | string => {
    try {
      return parseEkfDrift({ schemaVersion: 1, directionDeg: Number(drift.directionDeg), growthMps2: Number(drift.growthMps2), topSpeedMps: Number(drift.topSpeedMps), onsetS: Number(drift.onsetS), durationS: Number(drift.durationS), removal });
    } catch (cause) {
      return cause instanceof Error ? cause.message.replace("Invalid EKF drift: ", "") : String(cause);
    }
  };
  const addDrift = () => {
    setRefusal("");
    const profile = driftProfile();
    if (typeof profile === "string") { setRefusal(profile); return; }
    try {
      store_(withEkfDrift(schedule, profile));
    } catch (cause) {
      setRefusal(cause instanceof Error ? cause.message.replace(/^Invalid fault schedule: (entries\[\d+\]: )?/, "") : String(cause));
    }
  };
  const plan = view?.faultPlan ?? null;
  const waiting = plan ? faultTimeline(plan.schedule).slice(plan.sent) : [];
  const scheduled = schedule.entries.filter(entry => !isEkfDriftEntry(entry)), profile = schedule.ekfDrift, preview = driftProfile();
  if (!project) {
    return <section className="project-section" aria-label="Faults and interference"><h2>Faults and interference</h2><p className="hint">Open a project on the Project tab first.</p></section>;
  }
  return (
    <section className="project-section faults-tab" aria-labelledby="faults-heading" data-testid="faults-tab">
      <h2 id="faults-heading">Faults and interference</h2>
      <p className="hint">Motor faults change the physical thrust. Sensor and link effects change what ArduPilot observes, and the physics truth stays as it is. What ArduPilot does about them is not predicted here: its reaction is in the run&apos;s recording and log.</p>
      <div className="field-grid fault-fields">
        <div className="field">
          <label htmlFor="fault-effect">Effect</label>
          <select id="fault-effect" value={effect} onChange={event => {
            const next = OFFERED.find(id => id === event.target.value);
            if (next) { setRefusal(""); setEffect(next); }
          }}>
            {FAULT_TAB_FAMILIES.map(family => (
              <optgroup key={family} label={FAMILY_LABELS[family] ?? family}>
                {OFFERED.filter(id => EFFECT_CATALOG[id].family === family).map(id => <option key={id} value={id}>{EFFECT_CATALOG[id].label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fault-intensity">Intensity</label>
          <input id="fault-intensity" type="number" min={0} step={0.1} value={numberText(intensity)} onChange={event => setIntensity(event.target.valueAsNumber)} />
        </div>
        {effect === "ew.velocity-drift" && (
          <div className="field">
            <label htmlFor="fault-recovery">When it ends</label>
            <select id="fault-recovery" value={recovery} onChange={event => { if (event.target.value === "hold-offset" || event.target.value === "step-to-truth") setRecovery(event.target.value); }}>
              <option value="hold-offset">Slow down and hold the offset</option>
              <option value="step-to-truth">Step back to the truth</option>
            </select>
          </div>
        )}
        {definition.fields.map(field => (
          <EffectFieldInput key={field.key} field={field} value={values[field.key]} onChange={next => { setRefusal(""); setParameters(all => ({ ...all, [effect]: { ...values, [field.key]: next } })); }} />
        ))}
      </div>
      <p className="hint" data-testid="fault-effect-meaning">{definition.meaning}</p>
      <p className="hint" data-testid="fault-effect-path">{EFFECT_PATHS[effect] ?? ""}</p>
      <div className="button-row">
        <button type="button" onClick={() => send(true)} disabled={!running}>Apply now</button>
        <button type="button" onClick={() => send(false)} disabled={!running}>Turn off</button>
      </div>
      {!running && <p className="hint" data-testid="fault-no-run">Apply now needs a run with ArduPilot going on the Run tab.</p>}
      {refusal && <p className="alert" role="alert" data-testid="fault-refusal">{refusal}</p>}

      <h3>Schedule of the next run</h3>
      <p className="hint">Times count simulated seconds from when ArduPilot first reports the aircraft armed, so a repeat meets its faults at the same point of the flight. A run keeps the schedule it started with, in its experiment record.</p>
      <div className="field-grid fault-fields">
        <div className="field">
          <label htmlFor="fault-onset">Onset, s after arming</label>
          <input id="fault-onset" value={onset} onChange={event => setOnset(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="fault-duration">Duration, s (empty: until the run ends)</label>
          <input id="fault-duration" value={duration} onChange={event => setDuration(event.target.value)} />
        </div>
      </div>
      <div className="button-row"><button type="button" onClick={add}>Add to the schedule</button></div>
      {scheduled.length === 0 ? <p className="hint" data-testid="fault-schedule-empty">No single effect is scheduled.</p> : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="The schedule of the next run, scrollable">
          <table className="scheme-table" aria-label="The schedule of the next run" data-testid="fault-schedule">
            <thead><tr><th scope="col">Effect</th><th scope="col">Values</th><th scope="col">Onset, s</th><th scope="col">Duration, s</th><th scope="col">When it ends</th><th scope="col"><span className="visually-hidden">Remove</span></th></tr></thead>
            <tbody>
              {scheduled.map(entry => (
                <tr key={entry.control.id} data-effect={entry.control.effect}>
                  <th scope="row">{EFFECT_CATALOG[entry.control.effect].label}</th>
                  <td>{summary(entry.control)}</td>
                  <td>{entry.onsetS}</td>
                  <td>{entry.durationS ?? "Until the run ends"}</td>
                  <td>{entry.control.effect === "ew.velocity-drift" ? (entry.recovery === "hold-offset" ? "Holds the offset" : "Steps back") : "—"}</td>
                  <td><button type="button" onClick={() => remove(entry.control.id)} aria-label={`Remove ${EFFECT_CATALOG[entry.control.effect].label}`}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 id="ekf-drift-heading">EKF drift</h3>
      <p className="hint">An error put into the GNSS input, position and velocity together, which runs away from the truth in one direction. ArduPilot&apos;s estimate is never written. It may follow, reject the readings or enter a failsafe, and nothing here promises which: its experiment shows the truth against its estimate afterwards.</p>
      <div className="field-grid fault-fields" role="group" aria-labelledby="ekf-drift-heading">
        <div className="field"><label htmlFor="drift-direction">Direction, ° from north</label><input id="drift-direction" value={drift.directionDeg} onChange={event => setDrift({ ...drift, directionDeg: event.target.value })} /></div>
        <div className="field"><label htmlFor="drift-growth">{`Growth rate, m/s² (up to ${EKF_DRIFT_MAX_GROWTH_MPS2})`}</label><input id="drift-growth" value={drift.growthMps2} onChange={event => setDrift({ ...drift, growthMps2: event.target.value })} /></div>
        <div className="field"><label htmlFor="drift-speed">{`Top speed, m/s (up to ${EKF_DRIFT_MAX_SPEED_MPS})`}</label><input id="drift-speed" value={drift.topSpeedMps} onChange={event => setDrift({ ...drift, topSpeedMps: event.target.value })} /></div>
        <div className="field"><label htmlFor="drift-onset">Drift onset, s after arming</label><input id="drift-onset" value={drift.onsetS} onChange={event => setDrift({ ...drift, onsetS: event.target.value })} /></div>
        <div className="field"><label htmlFor="drift-duration">Grows for, s</label><input id="drift-duration" value={drift.durationS} onChange={event => setDrift({ ...drift, durationS: event.target.value })} /></div>
        <div className="field">
          <label htmlFor="drift-removal">Removal</label>
          <select id="drift-removal" value={removal} onChange={event => { if (event.target.value === "gradual" || event.target.value === "abrupt") setRemoval(event.target.value); }}>
            <option value="gradual">Gradual: slows and runs back</option>
            <option value="abrupt">Abrupt: gone at once</option>
          </select>
        </div>
      </div>
      <p className="hint" data-testid="drift-preview">
        {typeof preview === "string" ? preview : `This reaches ${ekfDriftPeakM(preview).toFixed(1)} m from the truth, and is gone ${ekfDriftEndS(preview).toFixed(1)} s after arming.`}
      </p>
      <div className="button-row">
        <button type="button" onClick={addDrift}>{profile ? "Replace the EKF drift" : "Put EKF drift on the schedule"}</button>
        {profile && <button type="button" onClick={() => store_(withEkfDrift(schedule, null))}>Remove the EKF drift</button>}
      </div>
      {profile && (
        <p className="hint" data-testid="drift-scheduled">{`On the schedule: toward ${profile.directionDeg}°, growing at ${profile.growthMps2} m/s² up to ${profile.topSpeedMps} m/s, from ${profile.onsetS} s for ${profile.durationS} s, removed ${profile.removal === "gradual" ? "gradually" : "at once"}, reaching ${ekfDriftPeakM(profile).toFixed(1)} m.`}</p>
      )}

      <h3>This run</h3>
      {plan && (
        <p className="hint" data-testid="fault-armed">{plan.armedAtS === null ? "Its schedule starts counting when ArduPilot reports the aircraft armed." : `Armed at ${plan.armedAtS.toFixed(2)} s of simulated time.`}</p>
      )}
      {waiting.length > 0 && plan && (
        <ul data-testid="fault-waiting">
          {waiting.map(item => {
            const entry = plan.schedule.entries[item.entry];
            return entry ? <li key={`${item.entry}-${item.on}`}>{`${EFFECT_CATALOG[entry.control.effect].label} goes ${item.on ? "on" : "off"} ${item.atS} s after arming`}</li> : null;
          })}
        </ul>
      )}
      {!view || view.effects.length === 0 ? <p className="hint" data-testid="fault-ledger-empty">No effect has been sent in this run.</p> : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="What became of each effect, scrollable">
          <table className="scheme-table fault-ledger" aria-label="What became of each effect" data-testid="fault-ledger">
            <thead><tr><th scope="col">Effect</th><th scope="col">Asked</th><th scope="col">From</th><th scope="col">Meant for, s</th><th scope="col">Applied at, s</th><th scope="col">Outcome</th><th scope="col">Why, or what it wrote</th></tr></thead>
            <tbody>
              {view.effects.map((entry, index) => (
                <tr key={index} data-effect={entry.effect} data-status={entry.status} data-origin={entry.origin} data-enabled={entry.enabled}>
                  <th scope="row">{EFFECT_CATALOG[entry.effect].label}</th>
                  <td>{entry.enabled ? "On" : "Off"}</td>
                  <td>{entry.origin === "manual" ? "By hand" : "Schedule"}</td>
                  <td>{seconds(entry.requestedSimS)}</td>
                  <td>{seconds(entry.appliedSimS)}</td>
                  <td>{STATUS_TEXT[entry.status]}</td>
                  <td>{entry.message || entry.writes.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
