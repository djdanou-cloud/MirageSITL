import { useState, useSyncExternalStore, type ChangeEvent } from "react";
import { compareToOriginal, type FlightMetrics, type ResimulationComparison } from "@mirage/analysis/resimulate";
import type { ProjectStore } from "@mirage/project/store";
import type { AnalysisOpen } from "../analysis/AnalysisTab";
import { findExperimentLog, type Listed } from "../analysis/experiment-log";
import type { SessionLink } from "../run/session-link";
import type { LogExtractionRecord } from "./log-plan";

// A run started from a log against the flight that log came from (TASK-183, S15). The log is not stored with the project, so the user chooses it again and its hash says it is the
// same one. The run's path was computed afresh, so these numbers say how far apart they went, and no limit applies to any of them (SA-01).

const ROWS: readonly { readonly key: keyof FlightMetrics; readonly label: string; readonly unit: string }[] = [
  { key: "durationS", label: "Duration", unit: "s" }, { key: "maxHeightM", label: "Greatest height", unit: "m" }, { key: "horizontalRangeM", label: "Farthest from the start", unit: "m" }, { key: "pathLengthM", label: "Path length", unit: "m" },
];
const SOURCE_TEXT = { XKF1: "the EKF's position (XKF1)", MSTR: "MirageSITL's truth (MSTR)" } as const;
const sha256Of = async (bytes: ArrayBuffer): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");

export function FromLogCompare({ store, projectId, link, item, log, onOpen }: {
  store: ProjectStore; projectId: string; link: SessionLink; item: Listed; log: LogExtractionRecord; onOpen: (compare: NonNullable<AnalysisOpen["compare"]>) => void;
}) {
  const launcher = useSyncExternalStore(link.subscribe, () => link.launcher);
  const [refusal, setRefusal] = useState("");
  const [comparison, setComparison] = useState<ResimulationComparison | null>(null);
  const [original, setOriginal] = useState<ArrayBuffer | null>(null);
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setRefusal(""); setComparison(null); setOriginal(null);
    void (async () => {
      const buffer = await file.arrayBuffer();
      if (await sha256Of(buffer) !== log.log.sha256) { setRefusal(`${file.name} is not the log this run came from: ${log.log.name}, ${log.log.bytes.toLocaleString("en-US")} bytes.`); return; }
      const found = await findExperimentLog(store, projectId, launcher, item);
      if (!found.request) { setRefusal(found.note); return; }
      const result = compareToOriginal(new Uint8Array(found.request.bytes), new Uint8Array(buffer), log.interval);
      if (result.kind === "missing") { setRefusal(result.reason); return; }
      setComparison(result.comparison);
      setOriginal(buffer);
    })().catch((cause: unknown) => setRefusal(`The comparison failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const difference = comparison?.difference ?? null;
  return (
    <div data-testid="from-log-compare">
      <div className="field">
        <label htmlFor="from-log-original">{`Compare with the original log, ${log.log.name} (.bin)`}</label>
        <input id="from-log-original" type="file" accept=".bin,.BIN,application/octet-stream" onChange={choose} />
      </div>
      {refusal && <p className="alert" role="alert" data-testid="from-log-compare-refused">{refusal}</p>}
      {comparison && (
        <>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="This run against the original flight, scrollable">
            <table className="scheme-table" aria-label="This run against the original flight" data-testid="from-log-metrics">
              <thead><tr><th scope="col">Metric</th><th scope="col">Original flight</th><th scope="col">This run</th><th scope="col">Difference</th></tr></thead>
              <tbody>
                {ROWS.map(row => (
                  <tr key={row.key} data-metric={row.key}>
                    <th scope="row">{`${row.label}, ${row.unit}`}</th>
                    <td data-column="original">{comparison.original[row.key].toFixed(2)}</td>
                    <td data-column="run">{comparison.run[row.key].toFixed(2)}</td>
                    <td data-column="difference">{(comparison.run[row.key] - comparison.original[row.key]).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" data-testid="from-log-difference" data-horizontal-max={difference?.horizontalMaxM} data-height-max={difference?.heightMaxM}>
            {difference
              ? `Lined up at the start of the interval, over the ${difference.comparedS.toFixed(1)} s they share, the paths are up to ${difference.horizontalMaxM.toFixed(2)} m apart on the ground (RMS ${difference.horizontalRmsM.toFixed(2)} m) and ${difference.heightMaxM.toFixed(2)} m in height (RMS ${difference.heightRmsM.toFixed(2)} m).`
              : "Lined up at the start of the interval, the two do not overlap in time."}
            {` The original reads ${SOURCE_TEXT[comparison.originalSource]} and this run ${SOURCE_TEXT[comparison.runSource]}. Its path was computed afresh and never fed from the log. These describe the difference; none has a limit, and you decide what they mean.`}
          </p>
          {original && (
            <button type="button" onClick={() => onOpen({ name: log.log.name, bytes: original.slice(0), sha256: log.log.sha256, interval: log.interval, secondOffsetS: comparison.secondOffsetS })}>Compare both in Analysis</button>
          )}
        </>
      )}
    </div>
  );
}
