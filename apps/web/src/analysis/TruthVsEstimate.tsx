import { useEffect, useMemo, useState } from "react";
import { reopenRecording } from "@mirage/aar/recorder-v2-host";
import { ESTIMATE_AXES, truthVsEstimate, type AxisSeries, type EstimateAxis, type TruthVsEstimateResult } from "@mirage/analysis/truth-vs-estimate";
import { ekfDriftAt, ekfDriftAxis, type EkfDriftProfile } from "@mirage/scenarios/ekf-drift";
import { PLOT_BOX, niceTicks } from "./response-geometry";

// The truth against ArduPilot's estimate on the Experiments tab (TASK-170, S09): position and velocity on one simulated clock, and the
// error between them, with a table for anyone not reading a chart. It describes what happened; ArduPilot may have followed its input,
// rejected it or entered a failsafe, and no limit applies to any of these numbers (SA-01).

type Quantity = "position" | "velocity";
const AXIS_LABEL: Readonly<Record<EstimateAxis, string>> = { north: "North", east: "East", down: "Down" };
const UNIT: Readonly<Record<Quantity, string>> = { position: "m", velocity: "m/s" };
/** Reports the table shows at most, spread over the run; the chart draws them all. */
const TABLE_ROWS = 60;

function linePath(timeS: readonly number[], value: readonly number[], x: (t: number) => number, y: (v: number) => number): string {
  let path = "";
  timeS.forEach((t, index) => { path += `${index === 0 ? "M" : "L"}${x(t).toFixed(1)} ${y(value[index] ?? 0).toFixed(1)}`; });
  return path;
}
/** A chart of one quantity against simulated time, with its own value axis. */
function Chart({ title, unit, startS, endS, lines, testId }: {
  title: string; unit: string; startS: number; endS: number; testId: string;
  lines: readonly { readonly name: string; readonly className: string; readonly timeS: readonly number[]; readonly value: readonly number[] }[];
}) {
  const box = PLOT_BOX;
  const values = lines.flatMap(line => line.value), low = Math.min(...values), high = Math.max(...values), pad = Math.max((high - low) * 0.05, 1e-3);
  const yLow = low - pad, yHigh = high + pad, span = Math.max(endS - startS, 1e-3);
  const x = (t: number) => box.left + (t - startS) / span * (box.width - box.left - box.right);
  const y = (v: number) => box.top + (yHigh - v) / (yHigh - yLow) * (box.height - box.top - box.bottom);
  return (
    <figure className="response-plot" data-testid={testId}>
      <figcaption className="response-legend">
        <strong>{title}</strong>
        {lines.map(line => <span key={line.name}><i className={`response-key ${line.className.replace("response-", "response-key-")}`} aria-hidden="true" />{line.name}</span>)}
      </figcaption>
      <div className="response-canvas">
        <svg viewBox={`0 0 ${box.width} ${box.height}`} role="img" aria-label={`${title}, in ${unit}, over ${span.toFixed(1)} s. The table below holds the numbers.`}>
          {niceTicks(yLow, yHigh, 5).map(tick => (
            <g key={tick}>
              <line className="response-grid" x1={box.left} x2={box.width - box.right} y1={y(tick)} y2={y(tick)} />
              <text className="response-tick" x={box.left - 6} y={y(tick) + 4} textAnchor="end">{tick}</text>
            </g>
          ))}
          {niceTicks(startS, endS, 8).map(tick => <text key={tick} className="response-tick" x={x(tick)} y={box.height - box.bottom + 15} textAnchor="middle">{tick}</text>)}
          <text className="response-tick" x={box.left + (box.width - box.left - box.right) / 2} y={box.height - 4} textAnchor="middle">Simulated time, s</text>
          {lines.map(line => <path key={line.name} className={`response-line ${line.className}`} data-line={line.name} d={linePath(line.timeS, line.value, x, y)} />)}
        </svg>
      </div>
    </figure>
  );
}

export function TruthVsEstimate({ recordId, home, drift, armedAtS }: { recordId: string; home: readonly [number, number, number, number]; drift: EkfDriftProfile | null; armedAtS: number | null }) {
  const [result, setResult] = useState<TruthVsEstimateResult | { readonly kind: "loading" }>({ kind: "loading" });
  const [quantity, setQuantity] = useState<Quantity>("position");
  const [axis, setAxis] = useState<EstimateAxis>("north");
  useEffect(() => {
    let cancelled = false;
    setResult({ kind: "loading" });
    reopenRecording(recordId).then(opened => { if (!cancelled) setResult(truthVsEstimate(opened.rows, home)); },
      (cause: unknown) => { if (!cancelled) setResult({ kind: "missing", reason: `The recording cannot be read in this browser: ${cause instanceof Error ? cause.message : String(cause)}` }); });
    return () => { cancelled = true; };
  }, [recordId, home]);
  const series = result.kind === "series" ? result.series : null, shown: AxisSeries | null = series ? series[quantity][axis] : null;
  // What was added to the GNSS input along this axis, from the scenario's form: the record of what was asked, never of what ArduPilot did.
  const input = useMemo(() => {
    if (!drift || armedAtS === null || !shown || axis === "down") return null;
    const [north, east] = ekfDriftAxis(drift), share = axis === "north" ? north : east;
    return shown.timeS.map(timeS => { const at = ekfDriftAt(drift, timeS - armedAtS); return share * (quantity === "position" ? at.offsetM : at.speedMps); });
  }, [drift, armedAtS, shown, axis, quantity]);
  if (result.kind === "loading") return <p className="hint">Reading the recording…</p>;
  if (result.kind === "missing") return <p className="alert" role="alert" data-testid="truth-estimate-missing">{result.reason}</p>;
  if (!series || !shown) return null;
  const unit = UNIT[quantity], label = `${AXIS_LABEL[axis]} ${quantity}`, stride = Math.max(1, Math.ceil(shown.timeS.length / TABLE_ROWS));
  return (
    <div className="response-panel" data-testid="truth-estimate">
      <h4>Truth against ArduPilot&apos;s estimate</h4>
      <div className="sitl-form">
        <label htmlFor="truth-quantity">Quantity</label>
        <select id="truth-quantity" value={quantity} onChange={event => { if (event.target.value === "position" || event.target.value === "velocity") setQuantity(event.target.value); }}>
          <option value="position">Position</option>
          <option value="velocity">Velocity</option>
        </select>
        <label htmlFor="truth-axis">Axis</label>
        <select id="truth-axis" value={axis} onChange={event => { const next = ESTIMATE_AXES.find(item => item === event.target.value); if (next) setAxis(next); }}>
          {ESTIMATE_AXES.map(item => <option key={item} value={item}>{AXIS_LABEL[item]}</option>)}
        </select>
      </div>
      <Chart title={label} unit={unit} startS={series.startS} endS={series.endS} testId="truth-estimate-chart" lines={[
        { name: "Truth", className: "response-requested", timeS: shown.timeS, value: shown.truth },
        { name: "ArduPilot's estimate", className: "response-actual", timeS: shown.timeS, value: shown.estimate },
      ]} />
      <Chart title={`${label}: estimate minus truth`} unit={unit} startS={series.startS} endS={series.endS} testId="truth-estimate-error" lines={[
        { name: "Error", className: "response-actual", timeS: shown.timeS, value: shown.error },
        ...(input ? [{ name: "Added to its GNSS input", className: "response-requested", timeS: shown.timeS, value: input }] : []),
      ]} />
      <p className="hint" data-testid="truth-estimate-note">
        {`The estimate is what ArduPilot reports in GLOBAL_POSITION_INT${series.estimateHz === null ? "" : `, about ${series.estimateHz.toFixed(0)} times a second`}, read against the truth at the same simulated moment. These describe the flight; none has a limit, and you decide what they mean.`}
        {series.withoutTruth > 0 ? ` ${series.withoutTruth} reports fall where the recording holds no truth and are left out.` : ""}
        {series.beforePosition > 0 ? ` ${series.beforePosition} reports came before ArduPilot had a position and are left out.` : ""}
      </p>
      <details>
        <summary>The values as a table</summary>
        <table className="sensor-table" aria-label="Truth, estimate and error at reports of the estimate" data-testid="truth-estimate-values">
          <thead><tr><th scope="col">Simulated time, s</th><th scope="col">{`Truth, ${unit}`}</th><th scope="col">{`Estimate, ${unit}`}</th><th scope="col">{`Error, ${unit}`}</th></tr></thead>
          <tbody>
            {shown.timeS.flatMap((timeS, index) => (index % stride !== 0 ? [] : [
              <tr key={timeS}><th scope="row">{timeS.toFixed(2)}</th><td>{(shown.truth[index] ?? Number.NaN).toFixed(3)}</td><td>{(shown.estimate[index] ?? Number.NaN).toFixed(3)}</td><td>{(shown.error[index] ?? Number.NaN).toFixed(3)}</td></tr>,
            ]))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
