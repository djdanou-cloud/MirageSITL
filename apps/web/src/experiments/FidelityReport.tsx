import { useEffect, useMemo, useState } from "react";
import { readDataFlash } from "@mirage/dataflash/reader";
import { FIDELITY_SERIES, pairedSeries, type FidelityAssessment } from "@mirage/analysis/fidelity";
import { logSpan } from "@mirage/analysis/log-to-experiment";
import { flightCheckOf, readFidelityComparison, saveFidelityComparison, type FidelityComparison } from "@mirage/aircraft/fidelity-comparison";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import type { Listed } from "../analysis/experiment-log";
import { fidelityReport, shown, type ReportLog } from "./fidelity-report";

// The fidelity report (TASK-184, S15): a stored experiment's log beside a real flight log, compared quantity by quantity and regime by
// regime, charted, and kept as a comparison of the experiment's profile version. MirageSITL sets no limit and gives no verdict: the
// numbers are shown and the user judges. The profile version is flight-checked only while it has a comparison with a real log.

const CHART = { width: 640, height: 200, left: 48, right: 8, top: 8, bottom: 24 } as const;
function Chart({ series, unit }: { series: { timeS: number[]; real: number[]; simulated: number[] }; unit: string }) {
  if (series.timeS.length < 2) return <p className="hint">Fewer than two instants overlap.</p>;
  const t0 = series.timeS[0] ?? 0, t1 = series.timeS[series.timeS.length - 1] ?? 1;
  const values = [...series.real, ...series.simulated], low = Math.min(...values), high = Math.max(...values), span = high - low || 1;
  const x = (t: number) => CHART.left + (t - t0) / (t1 - t0 || 1) * (CHART.width - CHART.left - CHART.right);
  const y = (v: number) => CHART.top + (high - v) / span * (CHART.height - CHART.top - CHART.bottom);
  const step = Math.max(1, Math.floor(series.timeS.length / 600));
  const line = (values: number[]) => series.timeS.filter((_, i) => i % step === 0).map((t, k) => `${x(t).toFixed(1)},${y(values[k * step] ?? 0).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-label={`Real (solid) and simulated (dashed), ${unit}, ${t0.toFixed(1)} to ${t1.toFixed(1)} s of the real log`} className="fidelity-chart">
      <text x={4} y={CHART.top + 10} fontSize={10} fill="currentColor">{high.toFixed(2)}</text>
      <text x={4} y={CHART.height - CHART.bottom} fontSize={10} fill="currentColor">{low.toFixed(2)}</text>
      <text x={CHART.left} y={CHART.height - 6} fontSize={10} fill="currentColor">{`${t0.toFixed(1)} s`}</text>
      <text x={CHART.width - CHART.right - 40} y={CHART.height - 6} fontSize={10} fill="currentColor">{`${t1.toFixed(1)} s`}</text>
      <polyline points={line(series.real)} fill="none" stroke="#65dfb9" strokeWidth={1.5} />
      <polyline points={line(series.simulated)} fill="none" stroke="#f0be9e" strokeWidth={1.5} strokeDasharray="5 3" />
    </svg>
  );
}

export function FidelityReport({ store, projectId, experiments, experimentLog }: {
  store: ProjectStore | null; projectId: string | null; experiments: readonly Listed[];
  experimentLog: (item: Listed) => Promise<{ readonly request: { readonly name: string; readonly bytes: ArrayBuffer } | null; readonly note: string }>;
}) {
  const [selected, setSelected] = useState("");
  const [simulated, setSimulated] = useState<ReportLog | null>(null);
  const [simulatedNote, setSimulatedNote] = useState("");
  const [real, setReal] = useState<ReportLog | null>(null);
  const [fromText, setFromText] = useState(""), [toText, setToText] = useState(""), [offsetText, setOffsetText] = useState("");
  const [result, setResult] = useState<{ assessment: FidelityAssessment; comparison: FidelityComparison } | null>(null);
  const [problem, setProblem] = useState("");
  const [status, setStatus] = useState("");
  const [quantity, setQuantity] = useState("roll");
  const [saved, setSaved] = useState<readonly StoredVersion[]>([]);
  const current = useMemo(() => experiments.find(item => item.stored.sha256 === selected) ?? null, [experiments, selected]);

  const loadSaved = () => {
    if (!store || !projectId) return;
    void store.listItems(projectId, "fidelity-comparison").then(setSaved, () => setSaved([]));
  };
  useEffect(loadSaved, [store, projectId]);
  useEffect(() => {
    setSimulated(null); setResult(null); setSimulatedNote("");
    if (!current) return;
    let cancelled = false;
    void experimentLog(current).then(found => {
      if (cancelled) return;
      setSimulatedNote(found.note);
      if (found.request) setSimulated({ name: found.request.name, bytes: new Uint8Array(found.request.bytes.slice(0)) });
    }, (cause: unknown) => { if (!cancelled) setSimulatedNote(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [current, experimentLog]);
  // The real log's span is the default interval, and the simulated log's start lines up with its start.
  useEffect(() => {
    if (!real || !simulated) return;
    try {
      const a = logSpan(readDataFlash(real.bytes)), b = logSpan(readDataFlash(simulated.bytes));
      if (a) { setFromText(a.fromS.toFixed(2)); setToText(a.toS.toFixed(2)); }
      if (a && b) setOffsetText((b.fromS - a.fromS).toFixed(2));
    } catch (cause) { setProblem(cause instanceof Error ? cause.message : String(cause)); }
  }, [real, simulated]);

  const compare = () => {
    setProblem(""); setStatus("");
    if (!current || !simulated || !real) { setProblem("Choose an experiment whose log is available, and a real flight log."); return; }
    const fromS = Number(fromText), toS = Number(toText), simulatedOffsetS = Number(offsetText);
    if (![fromS, toS, simulatedOffsetS].every(Number.isFinite) || fromText.trim() === "" || toText.trim() === "" || offsetText.trim() === "") {
      setProblem("The interval's start and end and the offset must be numbers, in seconds."); return;
    }
    const { profile } = current.payload;
    fidelityReport({ profile: { sha256: profile.sha256, name: profile.name, version: profile.version }, experimentSha256: current.stored.sha256, real, simulated,
      interval: { fromS, toS, simulatedOffsetS } }).then(setResult, (cause: unknown) => setProblem(cause instanceof Error ? cause.message : String(cause)));
  };
  const save = () => {
    if (!store || !projectId || !result) return;
    saveFidelityComparison(store, projectId, result.comparison).then(stored => { setStatus(`Saved as a comparison of ${result.comparison.profile.name}, version ${result.comparison.profile.version} (${stored.sha256.slice(0, 12)}).`); loadSaved(); },
      (cause: unknown) => setStatus(`Not saved: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const check = current ? flightCheckOf(current.payload.profile.sha256, saved) : null;
  const others = current ? saved.map(item => readFidelityComparison(item)).filter(item => item.profile.sha256 !== current.payload.profile.sha256) : [];
  const series = useMemo(() => {
    if (!result || !real || !simulated) return null;
    const paired = pairedSeries(readDataFlash(real.bytes), readDataFlash(simulated.bytes), result.assessment.interval, quantity);
    return paired;
  }, [result, real, simulated, quantity]);
  const unit = FIDELITY_SERIES.find(item => item.id === quantity)?.unit ?? "";

  return (
    <section className="project-section" aria-labelledby="fidelity-heading" data-testid="fidelity-report">
      <h3 id="fidelity-heading">Fidelity against a real flight</h3>
      <p className="hint">
        A real flight log beside a simulated run of one profile version, quantity by quantity and regime by regime. MirageSITL sets no limit and gives no
        verdict: you judge how far to trust the results. What a log does not hold is shown as missing.
      </p>
      <div className="field">
        <label htmlFor="fidelity-experiment">Simulated run (experiment)</label>
        <select id="fidelity-experiment" value={selected} onChange={event => setSelected(event.target.value)}>
          <option value="">None</option>
          {experiments.map(item => <option key={item.stored.sha256} value={item.stored.sha256}>{item.stored.record.name}</option>)}
        </select>
      </div>
      {current && <p className="hint" data-testid="fidelity-simulated-note">{simulatedNote}</p>}
      {current && (
        <p className="hint" data-testid="fidelity-label">
          {check ? `${current.payload.profile.name}, version ${current.payload.profile.version}: flight-checked in ${check.regimes.join(", ") || "no regime"} (${check.comparisons.length} comparison${check.comparisons.length === 1 ? "" : "s"} with real logs).`
            : `${current.payload.profile.name}, version ${current.payload.profile.version}: not flight-checked; it has no comparison with a real flight log.`}
          {others.length > 0 ? ` ${others.length} saved comparison${others.length === 1 ? " belongs" : "s belong"} to other profile versions: ${others.map(item => `${item.profile.name} version ${item.profile.version}`).join(", ")}.` : ""}
        </p>
      )}
      <div className="field">
        <label htmlFor="fidelity-real">Real flight log (.bin)</label>
        <input id="fidelity-real" type="file" accept=".bin" onChange={event => {
          const file = event.target.files?.[0];
          if (!file) return;
          void file.arrayBuffer().then(buffer => { setReal({ name: file.name, bytes: new Uint8Array(buffer) }); setResult(null); });
        }} />
      </div>
      <div className="field"><label htmlFor="fidelity-from">Real log from, s</label><input id="fidelity-from" type="text" inputMode="decimal" value={fromText} onChange={event => setFromText(event.target.value)} /></div>
      <div className="field"><label htmlFor="fidelity-to">Real log to, s</label><input id="fidelity-to" type="text" inputMode="decimal" value={toText} onChange={event => setToText(event.target.value)} /></div>
      <div className="field"><label htmlFor="fidelity-offset">Simulated time minus real time, s</label><input id="fidelity-offset" type="text" inputMode="decimal" value={offsetText} onChange={event => setOffsetText(event.target.value)} /></div>
      <button type="button" onClick={compare} disabled={!current || !simulated || !real}>Compare</button>
      {problem && <p className="error" role="alert" data-testid="fidelity-problem">{problem}</p>}
      {result && (
        <div data-testid="fidelity-result">
          <p className="hint" data-testid="fidelity-origin">
            {`Real log: ${result.comparison.real.name}, ${result.comparison.real.origin === "real" ? "a real flight" : "simulated"} (${result.comparison.real.originReason}). `}
            {`Simulated log: ${result.comparison.simulated.name} (${result.comparison.simulated.originReason}).`}
          </p>
          <p className="hint" data-testid="fidelity-regimes">{`Regimes of the real interval: ${result.assessment.regimes.map(item => `${item.regime} ${item.seconds.toFixed(1)} s`).join(", ")}.`}</p>
          <div className="table-scroll" role="region" aria-label="Compared quantities" tabIndex={0}>
            <table className="scheme-table" data-testid="fidelity-rows">
              <thead><tr><th scope="col">Quantity</th><th scope="col">Regime</th><th scope="col">Samples</th><th scope="col">RMS</th><th scope="col">Bias</th><th scope="col">Theil</th><th scope="col">Largest</th><th scope="col">Real mean</th><th scope="col">Simulated mean</th></tr></thead>
              <tbody>
                {result.assessment.rows.map(row => (
                  <tr key={`${row.quantity}:${row.regime}`} data-quantity={row.quantity} data-regime={row.regime} data-status={row.status}>
                    <th scope="row">{`${row.label}, ${row.unit}`}</th><td>{row.regime}</td>
                    {row.status === "missing" ? <td colSpan={7}>{`Missing: ${row.reason ?? ""}`}</td> : <>
                      <td>{row.samples}</td><td>{shown(row.rms)}</td><td>{shown(row.bias)}</td><td>{shown(row.theil)}</td><td>{shown(row.maxAbs)}</td>
                      <td>{shown(row.real?.mean ?? null)}</td><td>{shown(row.simulated?.mean ?? null)}</td></>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-scroll" role="region" aria-label="Quantities of each log" tabIndex={0}>
            <table className="scheme-table" data-testid="fidelity-scalars">
              <thead><tr><th scope="col">Quantity</th><th scope="col">Real</th><th scope="col">Simulated</th></tr></thead>
              <tbody>
                {result.assessment.scalars.map(item => (
                  <tr key={item.quantity} data-quantity={item.quantity}>
                    <th scope="row">{`${item.label}, ${item.unit}`}</th>
                    {item.reason ? <td colSpan={2}>{`Missing: ${item.reason}`}</td> : <><td>{shown(item.real)}</td><td>{shown(item.simulated)}</td></>}
                  </tr>
                ))}
                <tr data-quantity="path">
                  <th scope="row">Path difference, m</th>
                  <td colSpan={2}>{result.assessment.path ? `horizontal RMS ${shown(result.assessment.path.horizontalRmsM, 2)}, largest ${shown(result.assessment.path.horizontalMaxM, 2)}; height RMS ${shown(result.assessment.path.heightRmsM, 2)}, largest ${shown(result.assessment.path.heightMaxM, 2)}`
                    : `Missing: ${result.assessment.pathReason ?? ""}`}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="field">
            <label htmlFor="fidelity-quantity">Chart</label>
            <select id="fidelity-quantity" value={quantity} onChange={event => setQuantity(event.target.value)}>
              {FIDELITY_SERIES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
          {series && (typeof series === "string" ? <p className="hint" data-testid="fidelity-chart-missing">{`Missing: ${series}`}</p> : <Chart series={series} unit={unit} />)}
          <button type="button" onClick={save} disabled={!store || !projectId}>Save comparison</button>
          {status && <p className="hint" role="status" data-testid="fidelity-status">{status}</p>}
        </div>
      )}
    </section>
  );
}
