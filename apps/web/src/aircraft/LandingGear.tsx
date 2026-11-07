import { useMemo } from "react";
import { landingGearOf, type AircraftProfile, type GearKind, type GearValues } from "@mirage/aircraft/profile";
import { effectiveGear, GEAR_VALUES } from "@mirage/aircraft/profile-gear";
import { emptyGear, type GearForm, type GearValueForm, type ProfileForm } from "./profile-form";

// Landing gear of the aircraft editor (TASK-194): the gear the aircraft stands on, in place of the standard supports of decision
// D-07. Positions are the bottom of each foot or wheel with the struts fully extended, in body axes from the reference point (x
// forward, y right, z down). Each value is known with its source, or left empty: then the standard gear's rule applies, and the
// table says which values were assumed. A value is never filled in for the user.

const MAX_SUPPORTS = 8;
const KINDS: readonly { readonly kind: GearKind; readonly label: string; readonly hint: string }[] = [
  { kind: "legs", label: "Legs", hint: "Each support is a leg with a rubber foot that slides on the ground." },
  { kind: "skids", label: "Skids", hint: "Supports pair up as the two ends of each skid: supports 1 and 2 are the first skid, 3 and 4 the second, and so on." },
  { kind: "wheels", label: "Wheels", hint: "Wheels roll along body x and need their rolling coefficient, for which no standard value exists." },
];
const AXES = [[0, "x"], [1, "y"], [2, "z"]] as const;
/** The standard rule of each value, in words, for the hint beside it. */
const RULES: { readonly [K in keyof GearValues]: string } = {
  strutTravelM: "five static deflections",
  strutStiffnessNpm: "from a 5 mm static deflection (F-08)",
  strutDampingNspm: "damping ratio 0.7 (F-08)",
  footRadiusM: "0.01 m",
  rimRadiusM: "half the foot radius",
  footStiffnessNpm: "nine times the strut",
  unsprungMassKg: "1 % of a support's share",
  staticFriction: "0.6 (F-08)",
  kineticFriction: "0.5 (F-08)",
  rollingCoefficient: "none: needed for wheels",
};
const shown = (value: number) => String(Number(value.toPrecision(4)));

export function LandingGear({ form, profile, onChange }: { form: ProfileForm; profile: AircraftProfile | null; onChange: (form: ProfileForm) => void }) {
  const gear = form.gear;
  const setGear = (next: GearForm) => onChange({ ...form, gear: next });
  // The values the gear flies with, once the profile is valid: what was stated and what the standard rules give.
  const flown = useMemo(() => {
    const described = profile ? landingGearOf(profile) : null;
    if (!profile || !described) return null;
    try {
      return effectiveGear(profile, described);
    } catch {
      return null;
    }
  }, [profile]);
  const describe = (described: boolean) => onChange({ ...form, gearDescribed: described, ...(described ? { groundClearanceM: "" } : {}) });
  const setFoot = (index: number, axis: 0 | 1 | 2, text: string) =>
    setGear({ ...gear, feet: gear.feet.map((foot, i): GearForm["feet"][number] => {
      if (i !== index) return foot;
      const next: [string, string, string] = [foot[0], foot[1], foot[2]];
      next[axis] = text;
      return next;
    }) });
  const setValue = (key: keyof GearValues, entry: GearValueForm) => setGear({ ...gear, values: { ...gear.values, [key]: entry } });
  const rows = GEAR_VALUES.filter(item => item.key !== "rollingCoefficient" || gear.kind === "wheels");
  return (
    <section className="project-section" aria-labelledby="gear-heading">
      <h3 id="gear-heading">Landing gear</h3>
      <p className="hint">
        Without a described gear the aircraft stands on the standard supports: one under each arm at its motor radius, synthetic and not
        measured. A described gear replaces them, and the ground clearance then follows from it.
      </p>
      <div className="field">
        <label className="choice">
          <input type="checkbox" checked={form.gearDescribed} onChange={event => describe(event.target.checked)} /> Describe the landing gear
        </label>
      </div>
      {form.gearDescribed && (
        <>
          <fieldset>
            <legend>Supports</legend>
            <div className="field">
              <label htmlFor="gear-kind">Gear type</label>
              <select id="gear-kind" value={gear.kind} onChange={event => setGear({ ...gear, kind: KINDS.find(item => item.kind === event.target.value)?.kind ?? "legs" })}>
                {KINDS.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}
              </select>
            </div>
            <p className="hint">{KINDS.find(item => item.kind === gear.kind)?.hint} Positions are the bottom of each foot or wheel with the struts fully extended, in body axes from the reference point: x forward, y right, z down.</p>
            <div className="table-scroll" role="region" aria-label="Landing gear supports" tabIndex={0}>
              <table className="scheme-table">
                <thead><tr><th scope="col">Support</th>{AXES.map(([, axis]) => <th scope="col" key={axis}>{axis} (m)</th>)}<th scope="col"><span className="visually-hidden">Remove</span></th></tr></thead>
                <tbody>
                  {gear.feet.map((foot, index) => (
                    <tr key={index}>
                      <th scope="row">{index + 1}</th>
                      {AXES.map(([a, axis]) => (
                        <td key={axis}>
                          <input type="text" inputMode="decimal" aria-label={`Support ${index + 1} ${axis} (m)`} value={foot[a]}
                            onChange={event => setFoot(index, a, event.target.value)} />
                        </td>
                      ))}
                      <td>
                        <button type="button" disabled={gear.feet.length <= 1} onClick={() => setGear({ ...gear, feet: gear.feet.filter((_, i) => i !== index) })}>
                          Remove support {index + 1}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="button-row">
              <button type="button" disabled={gear.feet.length >= MAX_SUPPORTS} onClick={() => setGear({ ...gear, feet: [...gear.feet, ["0", "0", gear.feet.at(-1)?.[2] ?? "0.1"]] })}>
                Add support
              </button>
              <button type="button" onClick={() => setGear({ ...emptyGear(), kind: gear.kind, positionSource: gear.positionSource, values: gear.values })}>
                Reset to four legs in a square
              </button>
            </div>
            <div className="field">
              <label htmlFor="gear-position-source">Where the positions come from</label>
              <input id="gear-position-source" type="text" value={gear.positionSource} onChange={event => setGear({ ...gear, positionSource: event.target.value })} />
            </div>
          </fieldset>
          <fieldset>
            <legend>Values for every support</legend>
            <p className="hint">Leave a value and its source empty when it is not known: the standard rule beside it applies, and nothing is written into the profile.</p>
            <div className="table-scroll" role="region" aria-label="Landing gear values" tabIndex={0}>
              <table className="scheme-table">
                <thead><tr><th scope="col">Value</th><th scope="col">Known value</th><th scope="col">Source</th><th scope="col">Standard rule</th><th scope="col">Flown with</th></tr></thead>
                <tbody>
                  {rows.map(({ key, label, unit }) => {
                    const entry = gear.values[key], flownValue = flown?.values[key];
                    return (
                      <tr key={key}>
                        <th scope="row">{label}{unit ? ` (${unit})` : ""}</th>
                        <td><input type="text" inputMode="decimal" aria-label={`${label}${unit ? ` (${unit})` : ""}`} value={entry.value}
                          onChange={event => setValue(key, { ...entry, value: event.target.value })} /></td>
                        <td><input type="text" aria-label={`${label} source`} value={entry.source}
                          onChange={event => setValue(key, { ...entry, source: event.target.value })} /></td>
                        <td>{RULES[key]}</td>
                        <td data-testid={`gear-flown-${key}`}>
                          {flown && flownValue !== undefined ? `${shown(flownValue)}${flown.assumed.includes(key) ? " (assumed)" : ""}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!flown && <p className="hint">The values flown appear once the profile is valid.</p>}
          </fieldset>
        </>
      )}
    </section>
  );
}
