import { useEffect, useMemo, useState } from "react";
import {
  comparisonControls, comparisonWindowKind, durationScenario, heldByDefault, massAccounting, metricRows, parameterDifferences,
  type ComparisonControl, type ComparisonKind, type MassPart, type MetricRow,
} from "@mirage/analysis/compare";
import type { LimitEntry, LimitSummary } from "@mirage/analysis/metrics";
import type { ExperimentPayload } from "@mirage/aircraft/experiment";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import { loadExperiment, type LoadedExperiment } from "./compare-data";

// Two experiments side by side on the Experiments tab (TASK-177, S12): different conditions for one aircraft, or equal
// conditions for different configurations. It lists the inputs held equal and the ones that differ, flags any that
// differ when they should not, accounts for the components' own mass, and shows both results with the calculation mode and
// confidence label of each. Nothing here says which is better: the user judges (SA-01).

interface Experiment { readonly stored: StoredVersion; readonly payload: ExperimentPayload }
const MASS_LABELS: Readonly<Record<MassPart, string>> = { motors: "Motors", propellers: "Propellers", escs: "ESCs", battery: "Battery" };
const QUANTITY_LABELS: Readonly<Record<LimitEntry["quantity"], string>> = {
  "motor-current": "Motor current over its rating", "motor-power": "Motor power over its rating", "esc-current": "Motor current over the ESC's rating", "esc-voltage": "Bus voltage over the ESC's rating",
  rpm: "Rotor speed over its rating", "battery-voltage": "Battery below its empty voltage", "current-limit": "Motor current at the drive's limit", "pack-current-limit": "Pack current at its limit", "charge-limit": "Regeneration into a full pack",
};
const number = (value: number | null, digits: number): string => (value === null ? "missing" : value.toFixed(digits));
const kilograms = (value: number | null): string => (value === null ? "not known" : `${value.toFixed(3)} kg`);
const signedKg = (value: number | null): string => (value === null ? "not known" : `${value > 0 ? "+" : ""}${value.toFixed(3)} kg`);
function difference(row: MetricRow): string {
  if (row.difference === null) return "";
  return `${row.difference > 0 ? "+" : ""}${row.difference.toFixed(row.digits)}`;
}

function LimitsTable({ name, limits, side }: { name: string; limits: LimitSummary; side: string }) {
  if (!limits.recorded) return <p className="hint" data-testid={`compare-limits-${side}`}>{`${name}: not known. This recording was made before limits were recorded.`}</p>;
  if (limits.entries.length === 0 && limits.dropped === 0) return <p className="hint" data-testid={`compare-limits-${side}`}>{`${name}: none.`}</p>;
  return (
    <div data-testid={`compare-limits-${side}`}>
      <p className="hint">{name}{limits.dropped > 0 ? `: the monitor could not hold ${limits.dropped} more events, so the counts below are too low.` : ""}</p>
      <table aria-label={`Limits exceeded by ${name}`}>
        <thead><tr><th scope="col">Where</th><th scope="col">What</th><th scope="col">Kind</th><th scope="col" className="compare-number">Times</th><th scope="col" className="compare-number">Total, s</th><th scope="col" className="compare-number">Limit</th></tr></thead>
        <tbody>
          {limits.entries.map(entry => (
            <tr key={`${entry.subject}/${entry.quantity}`}>
              <th scope="row">{entry.subject === "battery" ? "Battery" : `Motor ${entry.subject + 1}`}</th>
              <td>{QUANTITY_LABELS[entry.quantity]}</td>
              <td>{entry.kind === "warning" ? "Rating exceeded; physics unchanged" : "The model clamped it"}</td>
              <td className="compare-number">{entry.episodes}</td>
              <td className="compare-number">{`${entry.totalS.toFixed(2)}${entry.open ? ", still on at the end" : ""}`}</td>
              <td className="compare-number">{entry.limit === null ? "none stated" : entry.limit.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ComparePanel({ store, experiments }: { store: ProjectStore; experiments: readonly Experiment[] }) {
  const [shaA, setShaA] = useState(experiments[1]?.stored.sha256 ?? "");
  const [shaB, setShaB] = useState(experiments[0]?.stored.sha256 ?? "");
  const [kind, setKind] = useState<ComparisonKind>("configurations");
  const [held, setHeld] = useState<ReadonlySet<ComparisonControl>>(() => heldByDefault("configurations"));
  const [reserveText, setReserveText] = useState("20");
  const [loaded, setLoaded] = useState<{ readonly a: LoadedExperiment; readonly b: LoadedExperiment } | null>(null);
  const [state, setState] = useState<"idle" | "loading">("idle");
  const [problem, setProblem] = useState("");

  const experimentA = experiments.find(item => item.stored.sha256 === shaA), experimentB = experiments.find(item => item.stored.sha256 === shaB);
  useEffect(() => {
    setLoaded(null); setProblem("");
    if (!experimentA || !experimentB) return;
    if (experimentA.stored.sha256 === experimentB.stored.sha256) { setProblem("Choose two different experiments."); return; }
    let cancelled = false;
    setState("loading");
    Promise.all([loadExperiment(store, experimentA.stored, experimentA.payload), loadExperiment(store, experimentB.stored, experimentB.payload)]).then(([a, b]) => {
      if (!cancelled) { setLoaded({ a, b }); setState("idle"); }
    }, (cause: unknown) => {
      if (!cancelled) { setProblem(cause instanceof Error ? cause.message : String(cause)); setState("idle"); }
    });
    return () => { cancelled = true; };
    // The stored versions are immutable, so their addresses say whether anything changed.
  }, [store, shaA, shaB]);

  const reserve = reserveText.trim() === "" ? Number.NaN : Number(reserveText), reserveValid = reserve >= 0 && reserve < 100;
  const controls = useMemo(() => (loaded ? comparisonControls(loaded.a.compared, loaded.b.compared, held) : []), [loaded, held]);
  const flagged = controls.filter(row => row.flagged), differing = controls.filter(row => row.differs), equal = controls.filter(row => !row.differs);
  const mass = useMemo(() => (loaded ? massAccounting(loaded.a.compared, loaded.b.compared) : null), [loaded]);
  const metricsA = loaded?.a.metrics ?? null, metricsB = loaded?.b.metrics ?? null;
  const windowKind = metricsA && metricsB ? comparisonWindowKind(metricsA, metricsB) : null;
  const rows = useMemo(() => (metricsA && metricsB && reserveValid ? metricRows({ a: metricsA, b: metricsB, capacityA: loaded?.a.capacity ?? null, capacityB: loaded?.b.capacity ?? null, reservePercent: reserve }) : []),
    [metricsA, metricsB, loaded, reserve, reserveValid]);
  const groups = [...new Set(rows.map(row => row.group))];
  const changeKind = (next: ComparisonKind) => { setKind(next); setHeld(heldByDefault(next)); };
  const toggle = (control: ComparisonControl, on: boolean) => {
    const next = new Set(held);
    if (on) next.add(control); else next.delete(control);
    setHeld(next);
  };
  const nameA = loaded?.a.compared.name ?? "A", nameB = loaded?.b.compared.name ?? "B";
  return (
    <section className="project-section compare-panel" aria-labelledby="compare-heading" data-testid="compare-panel">
      <h3 id="compare-heading">Compare two experiments</h3>
      <p className="hint">Both results are shown side by side, with every input that differs. Nothing here says which is better: you decide what the differences mean.</p>
      <div className="sitl-form">
        <label htmlFor="compare-a">Experiment A</label>
        <select id="compare-a" value={shaA} onChange={event => setShaA(event.target.value)}>
          {experiments.map(item => <option key={item.stored.sha256} value={item.stored.sha256}>{item.stored.record.name}</option>)}
        </select>
        <label htmlFor="compare-b">Experiment B</label>
        <select id="compare-b" value={shaB} onChange={event => setShaB(event.target.value)}>
          {experiments.map(item => <option key={item.stored.sha256} value={item.stored.sha256}>{item.stored.record.name}</option>)}
        </select>
        <label htmlFor="compare-kind">What is being compared</label>
        <select id="compare-kind" value={kind} onChange={event => changeKind(event.target.value === "conditions" ? "conditions" : "configurations")}>
          <option value="configurations">Different configurations, equal conditions</option>
          <option value="conditions">One aircraft, different conditions</option>
        </select>
        <label htmlFor="compare-reserve">Reserve for the duration estimate (% of capacity)</label>
        <input id="compare-reserve" type="text" inputMode="decimal" value={reserveText} onChange={event => setReserveText(event.target.value)} />
      </div>
      {!reserveValid && <p className="alert" role="alert">The reserve must be a number from 0 to below 100.</p>}
      {problem && <p className="alert" role="alert" data-testid="compare-problem">{problem}</p>}
      {state === "loading" && <p className="hint" data-testid="compare-loading">Reading both recordings and calculating the thrust at full command…</p>}
      {loaded && (
        <div data-testid="compare-result" data-flags={flagged.length}>
          {flagged.length > 0 && (
            <p className="alert" role="alert" data-testid="compare-flagged">{`Meant to be held equal, and they differ: ${flagged.map(row => row.label).join(", ")}. The results below are not a controlled comparison of what you set out to compare.`}</p>
          )}
          <h4>Inputs</h4>
          <p className="hint" data-testid="compare-lists">{`Held equal: ${equal.map(row => row.label).join(", ") || "nothing"}. Differ: ${differing.map(row => row.label).join(", ") || "nothing"}.`}</p>
          <div className="table-scroll">
            <table aria-label="Inputs of the two experiments" data-testid="compare-controls">
              <thead><tr><th scope="col">Input</th><th scope="col">A</th><th scope="col">B</th><th scope="col">Hold equal</th><th scope="col">Result</th></tr></thead>
              <tbody>
                {controls.map(row => (
                  <tr key={row.control} data-control={row.control} data-differs={row.differs} data-flagged={row.flagged}>
                    <th scope="row">{row.label}</th><td>{row.a}</td><td>{row.b}</td>
                    <td><input type="checkbox" aria-label={`Hold ${row.label} equal`} checked={row.held} onChange={event => toggle(row.control, event.target.checked)} /></td>
                    <td>{row.flagged ? "Differs: flagged" : row.differs ? "Differs" : "Equal"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {differing.some(row => row.control === "parameters") && (
            <p className="hint" data-testid="compare-parameters">{`Parameters that differ: ${parameterDifferences(loaded.a.compared.payload, loaded.b.compared.payload).join(", ")}.`}</p>
          )}

          <h4>Mass</h4>
          {!mass && <p className="hint" data-testid="compare-mass-missing">One of the aircraft versions is not in this project, so its mass cannot be accounted for.</p>}
          {mass && (
            <>
              {mass.flagged && (
                <p className="alert" role="alert" data-testid="compare-mass-flagged">{`The components' own masses change by ${signedKg(mass.componentDifferenceKg)}, and the aircraft's stated mass by ${signedKg(mass.statedDifferenceKg)}. Check the aircraft mass in the profile: ${signedKg(mass.unaccountedKg)} is not explained by the components.`}</p>
              )}
              <table aria-label="Mass of the two aircraft" data-testid="compare-mass">
                <thead><tr><th scope="col">Part</th><th scope="col" className="compare-number">A</th><th scope="col" className="compare-number">B</th><th scope="col" className="compare-number">B less A</th></tr></thead>
                <tbody>
                  {mass.parts.map(part => <tr key={part.part} data-part={part.part}><th scope="row">{MASS_LABELS[part.part]}</th><td className="compare-number">{kilograms(part.aKg)}</td><td className="compare-number">{kilograms(part.bKg)}</td><td className="compare-number">{signedKg(part.differenceKg)}</td></tr>)}
                  <tr data-part="aircraft"><th scope="row">Aircraft as stated, with those parts</th><td className="compare-number">{kilograms(mass.aircraftKg[0])}</td><td className="compare-number">{kilograms(mass.aircraftKg[1])}</td><td className="compare-number">{signedKg(mass.statedDifferenceKg)}</td></tr>
                  <tr data-part="payload"><th scope="row">Payload</th><td className="compare-number">{kilograms(mass.payloadKg[0])}</td><td className="compare-number">{kilograms(mass.payloadKg[1])}</td><td className="compare-number">{signedKg(mass.payloadKg[1] - mass.payloadKg[0])}</td></tr>
                  <tr data-part="total"><th scope="row">Total</th><td className="compare-number">{kilograms(mass.totalKg[0])}</td><td className="compare-number">{kilograms(mass.totalKg[1])}</td><td className="compare-number">{signedKg(mass.totalKg[1] - mass.totalKg[0])}</td></tr>
                </tbody>
              </table>
            </>
          )}

          <h4>Calculation mode and confidence</h4>
          <table aria-label="Calculation mode and confidence of the two aircraft" data-testid="compare-confidence">
            <thead><tr><th scope="col">Experiment</th><th scope="col">Calculation</th><th scope="col">Confidence label</th></tr></thead>
            <tbody>
              {[{ side: "a", entry: loaded.a }, { side: "b", entry: loaded.b }].map(({ side, entry }) => (
                <tr key={side} data-side={side}>
                  <th scope="row">{side.toUpperCase()}</th>
                  <td data-testid={`compare-mode-${side}`}>{entry.calculation ? (entry.calculation.mode === "measured" ? "From measurements" : "Preliminary") : "not known"}</td>
                  <td data-testid={`compare-label-${side}`}>{entry.calculation?.label ?? "not known"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">A label belongs to a profile version and the regimes it was earned in. None of them certifies anything for real flight.</p>

          <h4>Results</h4>
          {(loaded.a.metricsMissing || loaded.b.metricsMissing) && (
            <p className="alert" role="alert" data-testid="compare-metrics-missing">{[loaded.a.metricsMissing && `A: ${loaded.a.metricsMissing}`, loaded.b.metricsMissing && `B: ${loaded.b.metricsMissing}`].filter(Boolean).join(". ")}</p>
          )}
          {windowKind && <p className="hint" data-testid="compare-window">{windowKind === "task" ? "Compared over the measured part of each task." : "Compared over the whole flight, from the first to the last moment more than 0.5 m above where it stood: one of them has no measured part."}</p>}
          {rows.length > 0 && (
            <div className="table-scroll">
              <table aria-label="Results of the two experiments" data-testid="compare-metrics">
                <thead><tr><th scope="col">Result</th><th scope="col" className="compare-number">A</th><th scope="col" className="compare-number">B</th><th scope="col" className="compare-number">B less A</th><th scope="col">Unit</th></tr></thead>
                {groups.map(group => (
                  <tbody key={group}>
                    <tr><th scope="rowgroup" colSpan={5}>{group}</th></tr>
                    {rows.filter(row => row.group === group).map(row => (
                      <tr key={row.id} data-metric={row.id}>
                        <th scope="row">{row.label}</th>
                        <td className="compare-number" data-side="a">{number(row.a, row.digits)}</td>
                        <td className="compare-number" data-side="b">{number(row.b, row.digits)}</td>
                        <td className="compare-number" data-side="difference">{difference(row)}</td>
                        <td>{row.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
          {[{ side: "a", entry: loaded.a, name: nameA }, { side: "b", entry: loaded.b, name: nameB }].map(({ side, entry, name }) => (
            <div key={side}>
              {entry.capacityMissing && <p className="hint" data-testid={`compare-capacity-missing-${side}`}>{`${side.toUpperCase()}, ${name}: ${entry.capacityMissing}.`}</p>}
              {entry.capacity?.packLimited && (
                <p className="alert" data-testid={`compare-pack-limited-${side}`}>{`${side.toUpperCase()}: at full command these motors ask for more than the pack's current limit, so the thrust above is what the pack can drive. A flight today flags that limit and lets the motors draw on, so a flight at full command can exceed this thrust by drawing power the pack does not deliver.`}</p>
              )}
            </div>
          ))}
          <p className="hint" data-testid="compare-thrust-note">
            The thrust at full command is calculated, not flown: every motor at full command in still air with the aircraft held still, on the run&apos;s starting charge
            {loaded.a.capacity ? `, at ${loaded.a.capacity.densityKgM3.toFixed(3)} kg/m³` : ""}. Thrust over weight above 1 means it can lift off; the rest is its margin.
          </p>
          {windowKind && reserveValid && <p className="hint" data-testid="compare-duration-scenario">{durationScenario(windowKind, windowKind === "task" ? loaded.a.compared.payload.flightTask?.name ?? null : null, reserve)}</p>}

          {metricsA?.response && metricsB?.response && metricsA.response.length === metricsB.response.length && (
            <>
              <h4>Maneuver response</h4>
              <table aria-label="Maneuver response of the two experiments" data-testid="compare-response">
                <thead><tr><th scope="col">Change</th><th scope="col" className="compare-number">Rise A, s</th><th scope="col" className="compare-number">Rise B, s</th><th scope="col" className="compare-number">Overshoot A, %</th><th scope="col" className="compare-number">Overshoot B, %</th><th scope="col" className="compare-number">Settling A, s</th><th scope="col" className="compare-number">Settling B, s</th></tr></thead>
                <tbody>
                  {metricsA.response.map((edge, index) => {
                    const other = metricsB.response?.[index];
                    return (
                      <tr key={edge.edgeTimeS}>
                        <th scope="row">{`${edge.from.toFixed(1)} to ${edge.to.toFixed(1)}`}</th>
                        <td className="compare-number">{number(edge.riseTimeS, 3)}</td><td className="compare-number">{number(other?.riseTimeS ?? null, 3)}</td>
                        <td className="compare-number">{number(edge.overshootPercent, 1)}</td><td className="compare-number">{number(other?.overshootPercent ?? null, 1)}</td>
                        <td className="compare-number">{number(edge.settlingTimeS, 3)}</td><td className="compare-number">{number(other?.settlingTimeS ?? null, 3)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="hint">Settling is within 5 % of the change requested. The chart of each is on its experiment above.</p>
            </>
          )}

          <h4>Component limits exceeded</h4>
          {metricsA && <LimitsTable name={`A, ${nameA}`} limits={metricsA.limits} side="a" />}
          {metricsB && <LimitsTable name={`B, ${nameB}`} limits={metricsB.limits} side="b" />}
        </div>
      )}
    </section>
  );
}
