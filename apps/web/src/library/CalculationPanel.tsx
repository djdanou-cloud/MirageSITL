import { useEffect, useState } from "react";
import { readComponentCard } from "@mirage/aircraft/components";
import { readMeasurementSet } from "@mirage/aircraft/measurements";
import {
  bindMeasurements, evaluateCalculation, type MeasurementCandidate, type ProfileCalculation,
} from "@mirage/aircraft/calculation-mode";
import { calculationSettings, profileDraft, type AircraftProfile, type CalculationMode } from "@mirage/aircraft/profile";
import type { ProjectStore } from "@mirage/project/store";
import { nameLanguage } from "../shell/project-files";
import { describeCombination, describeLibraryError, resolveVersions, type LibraryData, type LibraryEntry } from "./library-data";

// Calculation modes (TASK-140, S04): each aircraft profile version is either a
// Preliminary calculation or a Calculation from measurements. In measured mode
// it binds, for each motor combination, the newest measurement set of exactly
// that combination; the labels follow TASK-133 (F-06).

interface Evaluation {
  readonly result: ProfileCalculation | null;
  readonly error: string | null;
  readonly names: ReadonlyMap<string, string>;
  /** Measured mode only: newer or new sets of the profile's combinations are available. */
  readonly rebind: boolean;
}
const MODES: readonly { readonly mode: CalculationMode; readonly label: string }[] = [
  { mode: "preliminary", label: "Preliminary calculation" },
  { mode: "measured", label: "Calculation from measurements" },
];

async function evaluate(store: ProjectStore, profile: AircraftProfile, candidates: readonly MeasurementCandidate[]): Promise<Evaluation> {
  const settings = calculationSettings(profile);
  const cardAddresses = profile.motors.flatMap(motor => [motor.components.motor, motor.components.propeller, motor.components.esc]);
  const cards = await resolveVersions(store, [...cardAddresses, profile.battery.card].filter(sha => sha !== null), readComponentCard);
  const sets = await resolveVersions(store, settings.measurementSets, readMeasurementSet);
  const names = new Map([...cards.names, ...sets.names]);
  try {
    const result = await evaluateCalculation(profile, cards.values, sets.values);
    const latest = settings.mode === "measured" ? calculationSettings(await bindMeasurements(profile, "measured", candidates)).measurementSets : [];
    return { result, error: null, names, rebind: settings.mode === "measured" && latest.join(",") !== settings.measurementSets.join(",") };
  } catch (cause) {
    return { result: null, error: describeLibraryError(cause), names, rebind: false };
  }
}

export function CalculationPanel({ store, library, onSaved }: { store: ProjectStore; library: LibraryData; onSaved: () => void }) {
  const [evaluations, setEvaluations] = useState<ReadonlyMap<string, Evaluation>>(new Map());
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // A chosen mode shows at once; it gives way to the stored mode when the saved version is read back, or reverts on failure.
  const [pending, setPending] = useState<ReadonlyMap<string, CalculationMode>>(new Map());
  useEffect(() => setPending(new Map()), [library]);
  const candidates: MeasurementCandidate[] = library.sets.flatMap(entry =>
    entry.value ? [{ sha256: entry.stored.sha256, createdAt: entry.stored.record.createdAt, set: entry.value }] : []);

  useEffect(() => {
    let cancelled = false;
    const usable = library.sets.flatMap(entry =>
      entry.value ? [{ sha256: entry.stored.sha256, createdAt: entry.stored.record.createdAt, set: entry.value }] : []);
    void (async () => {
      const next = new Map<string, Evaluation>();
      for (const entry of library.profiles) {
        if (entry.value) next.set(entry.stored.sha256, await evaluate(store, entry.value, usable));
      }
      if (!cancelled) setEvaluations(next);
    })();
    return () => { cancelled = true; };
  }, [store, library]);

  const save = (entry: LibraryEntry<AircraftProfile>, mode: CalculationMode) => {
    const profile = entry.value, id = entry.stored.record.id;
    if (!profile) return;
    setPending(current => new Map([...current, [id, mode]]));
    setBusy(true);
    void (async () => {
      const next = await bindMeasurements(profile, mode, candidates);
      const saved = await store.saveVersion(entry.stored.record.id, entry.stored.sha256, profileDraft(entry.stored.record.name, next));
      onSaved();
      const bound = calculationSettings(next).measurementSets.length;
      return saved.sha256 === entry.stored.sha256 ? "The calculation is unchanged."
        : `Saved version ${saved.record.version} of ${saved.record.name}: ${MODES.find(item => item.mode === mode)?.label ?? mode}` +
          (mode === "measured" ? `, ${bound} measurement ${bound === 1 ? "set" : "sets"} bound.` : ".");
    })().then(setStatus, (error: unknown) => {
      setPending(current => new Map([...current].filter(([key]) => key !== id)));
      setStatus(`The calculation was not saved: ${describeLibraryError(error)}`);
    }).finally(() => setBusy(false));
  };

  return (
    <section className="calculation-panel" aria-labelledby="calculation-heading">
      <h3 id="calculation-heading">Calculation modes</h3>
      <p className="hint">
        Preliminary calculation uses specifications and geometry only. Calculation from measurements uses bench data for each motor
        whose exact combination of cards was measured; every other motor stays preliminary, and the aircraft takes its weakest label.
      </p>
      {library.profiles.length === 0 && <p>The project has no aircraft profiles yet.</p>}
      <div className="project-grid">
        {library.profiles.map(entry => {
          const evaluation = evaluations.get(entry.stored.sha256), id = entry.stored.record.id;
          const mode = entry.value ? pending.get(id) ?? calculationSettings(entry.value).mode : null;
          return (
            <section key={entry.stored.sha256} className="project-section" aria-labelledby={`profile-${id}`}>
              <h4 id={`profile-${id}`} lang={nameLanguage(entry.stored.record.name)}>{entry.stored.record.name}</h4>
              <p className="hint">Version {entry.stored.record.version}.</p>
              {entry.error !== null && <p className="project-warning">This profile cannot be read: {entry.error}</p>}
              {mode && (
                <fieldset>
                  <legend>Calculation mode</legend>
                  {MODES.map(item => (
                    <label key={item.mode} className="choice">
                      <input type="radio" name={`mode-${id}`} checked={mode === item.mode} disabled={busy}
                        onChange={() => save(entry, item.mode)} /> {item.label}
                    </label>
                  ))}
                </fieldset>
              )}
              {evaluation?.error && <p className="project-warning">{evaluation.error}</p>}
              {evaluation?.result && (
                <>
                  <p>Aircraft label: <strong data-testid="aircraft-label">{evaluation.result.label}</strong></p>
                  <ul className="motor-list" aria-label={`Motors of ${entry.stored.record.name}`}>
                    {evaluation.result.motors.map(motor => (
                      <li key={motor.motorId}>
                        <strong>Motor {motor.motorId}</strong>: <span className={`label label-${motor.label}`} data-testid={`motor-${motor.motorId}-label`}>{motor.label}</span>
                        <p>{motor.combination ? describeCombination(motor.combination, evaluation.names) : "The combination is incomplete."}</p>
                        <p>
                          {motor.reason}
                          {motor.measurementSet ? ` Bound set: ${evaluation.names.get(motor.measurementSet) ?? motor.measurementSet.slice(0, 12)}.` : ""}
                        </p>
                        {motor.missing.length > 0 && <p>Not known: {motor.missing.join(", ")}.</p>}
                        {motor.limits.length > 0 && <ul className="limit-list">{motor.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>}
                      </li>
                    ))}
                  </ul>
                  <ul className="limit-list">{evaluation.result.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>
                </>
              )}
              {evaluation?.rebind && entry.value && (
                <div className="button-row">
                  <button type="button" disabled={busy} onClick={() => save(entry, "measured")}>Bind the latest measurements</button>
                </div>
              )}
            </section>
          );
        })}
      </div>
      <p role="status" className="status-message" data-testid="calculation-status">{status}</p>
    </section>
  );
}
