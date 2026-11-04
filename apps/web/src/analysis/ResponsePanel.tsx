import { useEffect, useMemo, useState } from "react";
import { reopenRecording } from "@mirage/aar/recorder-v2-host";
import type { FlightTaskDefinition } from "@mirage/scenarios/flight-tasks";
import { maneuverResponse, type EdgeResponse } from "@mirage/scenarios/maneuvers";
import { ResponsePlot } from "./ResponsePlot";
import { maneuverSeries, valueAt, type SeriesResult } from "./response-series";

// A flown maneuver's response on the Experiments tab (TASK-173, S10): the chart, and
// rise time, overshoot and settling of each change, computed from the stored
// recording. Shown and not judged (SA-01): no limit applies to any of them. What the
// recording cannot say reads as missing, never as a number.

const BANDS = [{ percent: 2, label: "2 %" }, { percent: 5, label: "5 %" }, { percent: 10, label: "10 %" }] as const;
const DEFAULT_BAND = 5;

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "loaded"; readonly result: SeriesResult; readonly lost: number; readonly gaps: number; readonly recording: boolean };

const seconds = (value: number | null, none: string) => (value === null ? none : value.toFixed(3));

export function ResponsePanel({ task, recordId }: { task: FlightTaskDefinition; recordId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [bandPercent, setBandPercent] = useState<number>(DEFAULT_BAND);
  useEffect(() => {
    let cancelled = false;
    setLoaded({ kind: "loading" });
    reopenRecording(recordId).then(opened => {
      if (cancelled) return;
      setLoaded({ kind: "loaded", result: maneuverSeries(task, opened.rows), lost: opened.missingChunks.length + opened.corruptChunks.length, gaps: opened.gaps.length, recording: opened.entry.status === "recording" });
    }, (cause: unknown) => {
      if (!cancelled) setLoaded({ kind: "failed", reason: `The recording cannot be read in this browser: ${cause instanceof Error ? cause.message : String(cause)}` });
    });
    return () => { cancelled = true; };
  }, [task, recordId]);
  const series = loaded.kind === "loaded" && loaded.result.kind === "series" ? loaded.result.series : null;
  const edges: readonly EdgeResponse[] = useMemo(() => (series ? maneuverResponse(series.requested, series.actual, bandPercent / 100) : []), [series, bandPercent]);
  return (
    <div className="response-panel" data-testid="response-panel">
      <h4>Requested and actual response</h4>
      {loaded.kind === "loading" && <p className="hint">Reading the recording…</p>}
      {loaded.kind === "failed" && <p className="alert" role="alert" data-testid="response-missing">{loaded.reason}</p>}
      {loaded.kind === "loaded" && loaded.result.kind === "missing" && <p className="alert" role="alert" data-testid="response-missing">{loaded.result.reason}</p>}
      {loaded.kind === "loaded" && loaded.recording && <p className="hint" data-testid="response-still-recording">This run is still recording, so the response may be incomplete. Stop the run to see all of it.</p>}
      {loaded.kind === "loaded" && (loaded.lost > 0 || loaded.gaps > 0) && (
        <p className="alert" role="alert" data-testid="response-lost">{`The recording lost ${loaded.lost} ${loaded.lost === 1 ? "chunk" : "chunks"} and has ${loaded.gaps} ${loaded.gaps === 1 ? "gap" : "gaps"}. A change those fall on reads as missing.`}</p>
      )}
      {series && (
        <>
          <ResponsePlot series={series} />
          <div className="sitl-form">
            <label htmlFor="response-band">Settled within</label>
            <select id="response-band" value={bandPercent} onChange={event => setBandPercent(Number(event.target.value))}>
              {BANDS.map(band => <option key={band.percent} value={band.percent}>{`${band.label} of the change requested`}</option>)}
            </select>
          </div>
          <table className="sensor-table" aria-label="Response to each change of the request" data-testid="response-metrics">
            <thead>
              <tr>
                <th scope="col">Change at, s</th><th scope="col">{`From and to, ${series.unit}`}</th><th scope="col">{`Was at, ${series.unit}`}</th><th scope="col">Delay, s</th><th scope="col">Rise time, s</th>
                <th scope="col">Overshoot, %</th><th scope="col">Settling, s</th><th scope="col">{`End error, ${series.unit}`}</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge, index) => (
                <tr key={edge.edgeTimeS} data-testid={`response-edge-${index}`} data-edge-s={edge.edgeTimeS}>
                  <th scope="row">{(edge.edgeTimeS - series.startS).toFixed(2)}</th>
                  <td>{`${edge.from.toFixed(1)} to ${edge.to.toFixed(1)}`}</td>
                  {edge.missing ? <td colSpan={6} data-testid={`response-edge-missing-${index}`}>{edge.missing}</td> : (
                    <>
                      <td>{edge.startActual === null ? "missing" : edge.startActual.toFixed(2)}</td>
                      <td data-testid={`response-delay-${index}`}>{seconds(edge.delayS, "not reached")}</td>
                      <td data-testid={`response-rise-${index}`}>{seconds(edge.riseTimeS, "not reached")}</td>
                      <td data-testid={`response-overshoot-${index}`}>{edge.overshootPercent === null ? "missing" : edge.overshootPercent.toFixed(1)}</td>
                      <td data-testid={`response-settling-${index}`}>{seconds(edge.settlingTimeS, "did not settle")}</td>
                      <td data-testid={`response-end-error-${index}`}>{edge.endError === null ? "missing" : edge.endError.toFixed(2)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Delay runs from the change to 10 % of the way there, and rise time from 10 % to 90 %, from where it actually was. Overshoot is how far it passes the request, as a percentage of the
            change requested. Settling runs from the change to the last time it enters the band around the request and stays. End error is actual minus requested over the last moments before the next change.
            These describe the response; none has a limit, and you decide what they mean.
          </p>
          <p className="hint" data-testid="response-recorded-rate">
            {series.actualHz === null ? "The recording holds too few actual values to give a rate." : `The recording holds the actual value at ${series.actualHz.toFixed(0)} Hz, and the request at each moment it was sent. A higher rate is set on the Logging tab, before the run.`}
          </p>
          {(series.axis === "roll" || series.axis === "pitch") && (
            <p className="hint" data-testid="response-estimate-note">
              Actual is the physics truth, and ArduPilot flies by its own estimate. With its simulated gyro drift on (SIM_DRIFT_SPEED, as ArduPilot ships it), that estimate lags the truth by a few tenths of a degree,
              so a lean can end slightly off the request even though ArduPilot holds what it believes exactly. Ideal mode on the Sensors tab switches that drift off.
            </p>
          )}
          {series.axis === "heading" && (
            <p className="hint" data-testid="response-heading-note">A heading here keeps counting past north so the lines stay continuous: 395° is 35°, and -10° is 350°.</p>
          )}
          <details>
            <summary>The values as a table</summary>
            <table className="sensor-table" aria-label="Requested and actual at each recorded request" data-testid="response-values">
              <thead><tr><th scope="col">Task time, s</th><th scope="col">{`Requested, ${series.unit}`}</th><th scope="col">{`Actual, ${series.unit}`}</th></tr></thead>
              <tbody>
                {series.requested.timeS.map((timeS, index) => {
                  const actual = valueAt(series.actual, timeS);
                  return <tr key={timeS}><th scope="row">{(timeS - series.startS).toFixed(2)}</th><td>{(series.requested.value[index] ?? Number.NaN).toFixed(2)}</td><td>{actual === null ? "missing" : actual.toFixed(2)}</td></tr>;
                })}
              </tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}
