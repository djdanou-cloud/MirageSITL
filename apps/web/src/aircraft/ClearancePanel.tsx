import { useEffect, useMemo, useState } from "react";
import {
  CLEARANCE_RULES, clearanceFix, clearanceShapes, describeClash, propellerClearance,
  type ClearanceClash, type ClearanceFix, type ClearanceReport,
} from "@mirage/aircraft/clearance";
import type { AircraftProfile } from "@mirage/aircraft/profile";
import { describeLibraryError } from "../library/library-data";

// Propeller clearance in the Aircraft tab (TASK-195): the clashes of the form's
// valid profile with its chosen propellers, a top view drawn to scale, and the
// fix. By the user's decision of 2026-11-01 a profile with a clash still saves
// but no run starts from it, and the fix is only proposed: it shows each
// changed value now and after, and the top view after, and saves a new version
// only when the user confirms.

type Checked =
  | { readonly kind: "unchecked"; readonly reason: string }
  | { readonly kind: "checked"; readonly report: ClearanceReport }
  | { readonly kind: "failed"; readonly message: string };

const metres = (value: number): string => `${value.toFixed(3)} m`;
const radiusOf = (radii: ReadonlyMap<number, number>) => (motorId: number): number => radii.get(motorId) ?? Number.NaN;

/** Motors in a clash, to draw their propellers as clashing. */
function clashingMotors(clashes: readonly ClearanceClash[]): ReadonlySet<number> {
  return new Set(clashes.flatMap(clash => {
    switch (clash.kind) {
      case "propellers": return [...clash.motorIds];
      case "propeller-body": return [clash.motorId];
      case "ground": return clash.part.kind === "propeller" ? [clash.part.motorId] : [];
    }
  }));
}

/** The aircraft seen from above, to scale: forward up, right to the right. */
function TopView({ profile, radii, clashes, label }: {
  profile: AircraftProfile; radii: ReadonlyMap<number, number>; clashes: readonly ClearanceClash[]; label: string;
}) {
  const { layout, hull, discs } = clearanceShapes(profile, radiusOf(radii));
  const body = hull[0], clashing = clashingMotors(clashes);
  const bodyClash = clashes.some(clash => clash.kind === "propeller-body" || (clash.kind === "ground" && clash.part.kind === "body"));
  // Body FRD x (forward) is drawn up and y (right) to the right.
  const at = (point: readonly number[]): [number, number] => [point[1] ?? 0, -(point[0] ?? 0)];
  const extent = 1.08 * Math.max(body?.radiusM ?? 0, ...discs.map(disc =>
    disc.kind === "cylinder" ? Math.hypot(disc.centerBodyM[0] ?? 0, disc.centerBodyM[1] ?? 0) + disc.radiusM : 0));
  const font = extent / 14;
  return (
    <figure className="clearance-view">
      <svg viewBox={`${-extent} ${-extent} ${2 * extent} ${2 * extent}`} role="img" aria-label={`${label}: the aircraft seen from above, to scale`}>
        <title>{label}</title>
        {hull.slice(1).map(arm => arm.kind === "capsule" && (
          <line key={`arm-${arm.id}`} className="clearance-arm" x1={at(arm.startBodyM)[0]} y1={at(arm.startBodyM)[1]}
            x2={at(arm.endBodyM)[0]} y2={at(arm.endBodyM)[1]} strokeWidth={Math.max(2 * arm.radiusM, extent / 150)} />
        ))}
        {body && <circle className={bodyClash ? "clearance-body clash" : "clearance-body"} cx={0} cy={0} r={body.radiusM} strokeWidth={extent / 200} />}
        {discs.map(disc => disc.kind === "cylinder" && (
          <circle key={`disc-${disc.id}`} className={clashing.has(disc.id) ? "clearance-disc clash" : "clearance-disc"}
            cx={at(disc.centerBodyM)[0]} cy={at(disc.centerBodyM)[1]} r={disc.radiusM} strokeWidth={extent / 200} />
        ))}
        {layout.rotors.filter(rotor => rotor.level !== "lower").map(rotor => (
          <text key={`label-${rotor.motorId}`} className="clearance-label" x={at(rotor.hubPositionBodyM)[0]} y={at(rotor.hubPositionBodyM)[1]}
            fontSize={font} textAnchor="middle" dominantBaseline="central">
            {layout.rotors.filter(other => other.armId === rotor.armId).map(other => other.motorId).join("/")}
          </text>
        ))}
      </svg>
      <figcaption className="hint">{label}</figcaption>
    </figure>
  );
}

/**
 * `profile`: the form's valid profile, or null. `radii`: each motor's propeller radius, or null
 * while a motor has no propeller card. `onSave` stores the fixed profile as a new version.
 */
export function ClearancePanel({ profile, radii, dirty, saveBlocked, busy, onSave }: {
  profile: AircraftProfile | null; radii: ReadonlyMap<number, number> | null; dirty: boolean; saveBlocked: boolean; busy: boolean;
  onSave: (fixed: AircraftProfile) => void;
}) {
  const [preview, setPreview] = useState<ClearanceFix | null>(null);
  const [fixError, setFixError] = useState("");
  const checked = useMemo((): Checked => {
    if (!profile) return { kind: "unchecked", reason: "The clearance is checked once the arms, motors and mass properties are valid." };
    if (!radii) return { kind: "unchecked", reason: "Choose a propeller card for every motor to check that the propellers clear each other, the body and the ground." };
    try {
      return { kind: "checked", report: propellerClearance(profile, radiusOf(radii)) };
    } catch (error) {
      return { kind: "failed", message: describeLibraryError(error) };
    }
  }, [profile, radii]);
  // A proposal belongs to the profile it was made for.
  useEffect(() => { setPreview(null); setFixError(""); }, [profile, radii]);

  const propose = () => {
    if (!profile || !radii) return;
    try {
      setPreview(clearanceFix(profile, radiusOf(radii)));
      setFixError("");
    } catch (error) {
      setFixError(`No fix was found: ${describeLibraryError(error)}`);
    }
  };
  const gapPercent = Math.round(CLEARANCE_RULES.fixTipGapOfDiameter * 100);
  return (
    <section className="project-section" aria-labelledby="clearance-heading">
      <h3 id="clearance-heading">Propeller clearance</h3>
      {checked.kind === "unchecked" && <p>{checked.reason}</p>}
      {checked.kind === "failed" && <p role="alert">The clearance cannot be checked: {checked.message}</p>}
      {checked.kind === "checked" && profile && radii && (
        <>
          {checked.report.clashes.length === 0 ? (
            <p data-testid="clearance-verdict">Every propeller clears the other propellers, the body and the ground at rest.</p>
          ) : (
            <>
              <p data-testid="clearance-verdict" role="alert">
                The propellers clash, so no run starts from this profile. It can still be saved.
              </p>
              <ul className="form-errors" aria-label="Propeller clashes">
                {checked.report.clashes.map(clash => <li key={describeClash(clash)}>{describeClash(clash)}</li>)}
              </ul>
              {!preview && (
                <div className="button-row">
                  <button type="button" disabled={busy} onClick={propose}>Propose a fix</button>
                </div>
              )}
              {fixError && <p role="alert">{fixError}</p>}
            </>
          )}
          {!preview && (
            <div className="clearance-views">
              <TopView profile={profile} radii={radii} clashes={checked.report.clashes} label="Now" />
            </div>
          )}
          {preview && (
            <div className="clearance-fix" role="group" aria-label="Proposed fix">
              <h4>Proposed fix</h4>
              <p>
                {preview.changes.some(change => change.label !== "Ground clearance") && (
                  <>Every arm grows by the same factor, {preview.armScale.toFixed(3)}, rounded up to whole millimetres, so the aircraft keeps its
                    shape and each propeller tip clears the other propellers and the body by at least {gapPercent} % of the propeller diameter. </>
                )}
                {preview.changes.some(change => change.label === "Ground clearance") && (
                  <>The ground clearance rises so that no part of the aircraft touches the ground at rest. </>
                )}
                The mass and inertia stay as they are: longer arms usually weigh more, so update the mass properties if you know the new values.
              </p>
              <div className="table-scroll">
                <table className="entry-table" aria-label="Changes of the proposed fix">
                  <thead><tr><th scope="col">Value</th><th scope="col">Now</th><th scope="col">After the fix</th></tr></thead>
                  <tbody>
                    {preview.changes.map(change => (
                      <tr key={change.label}><th scope="row">{change.label}</th><td>{metres(change.beforeM)}</td><td>{metres(change.afterM)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.after.clashes.length > 0 && (
                <>
                  <p role="alert">No arm length clears these clashes; change the arm heights or angles:</p>
                  <ul className="form-errors" aria-label="Clashes the fix leaves">
                    {preview.after.clashes.map(clash => <li key={describeClash(clash)}>{describeClash(clash)}</li>)}
                  </ul>
                </>
              )}
              <div className="clearance-views">
                <TopView profile={profile} radii={radii} clashes={checked.report.clashes} label="Now" />
                <TopView profile={preview.profile} radii={radii} clashes={preview.after.clashes} label="After the fix" />
              </div>
              {dirty && <p className="hint">Saving also stores the other unsaved changes in the form.</p>}
              {saveBlocked && <p className="hint">Give the profile a name before saving.</p>}
              <div className="button-row">
                <button type="button" className="save-button" disabled={busy || saveBlocked} onClick={() => onSave(preview.profile)}>
                  Save the fixed version
                </button>
                <button type="button" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
