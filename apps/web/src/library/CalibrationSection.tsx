import { useState } from "react";
import { readComponentCard } from "@mirage/aircraft/components";
import { readMeasurementSet } from "@mirage/aircraft/measurements";
import { profileDraft, propulsionCalibrationsOf, type AircraftProfile } from "@mirage/aircraft/profile";
import { bindCalibration, calibrateMotor, savePropulsionCalibration, type PropulsionCalibration } from "@mirage/aircraft/propulsion-calibration";
import { resolveComponents } from "@mirage/aircraft/resolve-components";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import { fetchBetModule } from "../sitl/sitl-run";
import { describeLibraryError, resolveVersions } from "./library-data";

// Propulsion calibration of one measured motor (TASK-145, S04, S05): fits the profile's own rotor and motor to the bench set bound for
// that motor's exact combination, shows every residual, and on request stores the calibration and binds it as a new profile version,
// for every motor of the combination and no other. MirageSITL sets no fit tolerance: the residuals are shown and the user judges.

const fixed = (value: number | null, digits: number) => (value === null ? "—" : value.toFixed(digits));

export function CalibrationSection({ store, entry, motorId, measurementSet, onSaved }: {
  store: ProjectStore; entry: { readonly stored: StoredVersion; readonly value: AircraftProfile }; motorId: number; measurementSet: string; onSaved: (message: string) => void;
}) {
  const [result, setResult] = useState<PropulsionCalibration | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const profile = entry.value;
  const bound = propulsionCalibrationsOf(profile).find(item => item.measurementSet === measurementSet);

  const fit = () => {
    setBusy(true); setStatus("Fitting the rotor and the motor to the bench data…"); setResult(null);
    void (async () => {
      const addresses = profile.motors.flatMap(motor => [motor.components.motor, motor.components.propeller, motor.components.esc]);
      const cards = await resolveVersions(store, [...addresses, profile.battery.card].filter(sha => sha !== null), readComponentCard);
      const sets = await resolveVersions(store, [measurementSet], readMeasurementSet);
      const set = sets.values.get(measurementSet), components = resolveComponents(profile, cards.values).components;
      if (!set) throw new Error("The bound measurement set cannot be read");
      if (!components) throw new Error("A component card value the model needs is not known");
      const bet = await fetchBetModule();
      const module = await WebAssembly.compile(bet.bytes.slice());
      return calibrateMotor({ module, betModuleSha256: bet.sha256, profile, components, motorId, set: { sha256: measurementSet, set } });
    })().then(calibration => { setResult(calibration); setStatus(""); }, (cause: unknown) => setStatus(`Not fitted: ${describeLibraryError(cause)}`)).finally(() => setBusy(false));
  };
  const bind = () => {
    if (!result) return;
    setBusy(true);
    void (async () => {
      const stored = await savePropulsionCalibration(store, entry.stored.record.projectId, `${entry.stored.record.name}, motor ${motorId}`, result);
      const next = bindCalibration(profile, stored);
      const saved = await store.saveVersion(entry.stored.record.id, entry.stored.sha256, profileDraft(entry.stored.record.name, next));
      // The new version replaces this section: its message goes to the panel's status.
      onSaved(`Saved the calibration and version ${saved.record.version} of ${saved.record.name}, which flies every motor of this combination calibrated.`);
    })().catch((cause: unknown) => setStatus(`Not bound: ${describeLibraryError(cause)}`)).finally(() => setBusy(false));
  };

  return (
    <div className="calibration-section" data-testid={`calibration-${motorId}`}>
      <p className="hint">
        {bound ? `Calibrated (lift ×${bound.liftScale.toFixed(4)}, drag ×${bound.dragScale.toFixed(4)}) from the set measured on ${bound.measuredOn}; it is never used for another combination.`
          : "Not calibrated: the BET rotor flies on its catalog polar."}
      </p>
      <div className="button-row"><button type="button" onClick={fit} disabled={busy}>Fit to the bench data</button></div>
      {result && (
        <div data-testid={`calibration-result-${motorId}`}>
          <p>{`Lift ×${result.fit.scales.lift.toFixed(4)}, drag ×${result.fit.scales.drag.toFixed(4)} in ${result.fit.iterations} iterations; RMS thrust residual ${result.fit.rmsThrustResidualN.toFixed(4)} N`
            + (result.fit.rmsTorqueResidualNm === null ? "." : `, torque ${result.fit.rmsTorqueResidualNm.toFixed(5)} N·m.`)}</p>
          <p>{result.fit.motor ? `Motor at KV ${result.fit.motor.kvRpmPerV}: R ${result.fit.motor.resistanceOhm.toFixed(4)} Ω, I₀ ${result.fit.motor.noLoadCurrentA.toFixed(3)} A, RMS power residual ${result.fit.motor.rmsResidualW.toFixed(2)} W (ESC losses are in R and I₀).`
            : "The motor is not fitted."}</p>
          {result.fit.notFitted.length > 0 && <ul className="limit-list">{result.fit.notFitted.map(item => <li key={item}>{item}</li>)}</ul>}
          <div className="table-scroll" role="region" aria-label={`Residuals of motor ${motorId}`} tabIndex={0}>
            <table className="scheme-table">
              <thead><tr><th scope="col">rpm</th><th scope="col">Thrust, N</th><th scope="col">Model, N</th><th scope="col">Torque, N·m</th><th scope="col">Model, N·m</th></tr></thead>
              <tbody>
                {result.fit.residuals.map(row => (
                  <tr key={row.rpm}><td>{row.rpm}</td><td>{fixed(row.thrustN, 4)}</td><td>{fixed(row.modelThrustN, 4)}</td><td>{fixed(row.torqueNm, 5)}</td><td>{fixed(row.modelTorqueNm, 5)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">{`Envelope: ${result.fit.envelope.rpmMin} to ${result.fit.envelope.rpmMax} rpm at ${result.fit.envelope.densityKgM3.toFixed(4)} kg/m³, static; beyond it, with the F-03 margins, every step is flagged.`}</p>
          <div className="button-row"><button type="button" onClick={bind} disabled={busy}>Save and bind as a new profile version</button></div>
        </div>
      )}
      {status && <p role="status" className="status-message" data-testid={`calibration-status-${motorId}`}>{status}</p>}
    </div>
  );
}
