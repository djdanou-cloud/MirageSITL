import { formatParameterValue } from "@mirage/autopilot/param-service";
import type { ParameterChange, ParameterLog } from "./parameter-sets";

// The parameter change history (TASK-160, S11): every write of the current
// run with its old and new value, request time, simulated time, tick and
// outcome, and the stored logs of earlier runs of the project. A confirmed
// value whose metadata needs a restart is never called applied.

/** A float32 as the shortest decimal that reads back to it; anything else as JavaScript writes it. */
export function valueText(value: number | null): string {
  if (value === null) return "none";
  try { return formatParameterValue(value); } catch { return String(value); }
}

/** What a change's outcome means for the autopilot. */
export function outcomeText(change: ParameterChange): string {
  const outcome = change.outcome;
  switch (outcome.kind) {
    case "requested":
      return change.whilePaused ? "Requested while paused: a paused SITL answers after Resume"
        : `Requested, waiting for ArduPilot's answer (sent ${outcome.attempts} ${outcome.attempts === 1 ? "time" : "times"})`;
    case "confirmed": {
      const range = outcome.outsideRange ? "; outside the range ArduPilot declares for it" : "";
      if (outcome.rebootRequired === true) return `Stored, not applied: ArduPilot uses it only after SITL restarts${range}`;
      if (outcome.rebootRequired === false) return `Confirmed and applied${range}`;
      return "Confirmed; without metadata for this build it is not known whether it needs a restart";
    }
    case "refused": return outcome.by === "service" ? `Refused before sending: ${outcome.reason}` : `Refused by ArduPilot: ${outcome.reason}`;
    case "timeout": return `No answer from ArduPilot after ${outcome.attempts} sends`;
    case "stale": return `No longer current: ${outcome.reason}`;
    default: { const never: never = outcome; return never; }
  }
}

function ChangeTable({ changes, onSendBack, testId }: {
  changes: readonly ParameterChange[]; onSendBack: ((name: string, value: number) => void) | null; testId: string;
}) {
  return (
    <div className="table-scroll">
      <table className="scheme-table parameter-history" data-testid={testId}>
        <thead>
          <tr><th scope="col">Requested (UTC)</th><th scope="col">Simulated time</th><th scope="col">Parameter</th><th scope="col">Old</th>
            <th scope="col">New</th><th scope="col">Outcome</th>{onSendBack && <th scope="col"><span className="visually-hidden">Send back</span></th>}</tr>
        </thead>
        <tbody>
          {changes.map(change => (
            <tr key={change.writeId} data-name={change.name} data-outcome={change.outcome.kind}
              data-reboot={change.outcome.kind === "confirmed" ? String(change.outcome.rebootRequired) : undefined}>
              <td>{change.requestedAt.replace("T", " ").replace("Z", "")}</td>
              <td>{`${change.simTimeS.toFixed(2)} s (tick ${change.tick})`}</td>
              <td>{change.name}</td>
              <td>{valueText(change.oldValue)}</td>
              <td>{valueText(change.newValue)}</td>
              <td className="parameter-outcome">{outcomeText(change)}</td>
              {onSendBack && (
                <td>
                  {change.oldValue !== null && (
                    <button type="button" onClick={() => { if (change.oldValue !== null) onSendBack(change.name, change.oldValue); }}>
                      Send back {valueText(change.oldValue)}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ParameterHistory({ changes, earlier, onSendBack }: {
  changes: readonly ParameterChange[];
  /** Stored logs of the project's other runs, newest first. */
  earlier: readonly ParameterLog[];
  /** Writes an earlier value back, or null when nothing can be written now. */
  onSendBack: ((name: string, value: number) => void) | null;
}) {
  return (
    <section className="parameter-section" aria-labelledby="parameter-history-heading">
      <h3 id="parameter-history-heading">Change history</h3>
      {changes.length === 0 ? <p className="hint">No parameter of this run has been written yet.</p>
        : <ChangeTable changes={changes} onSendBack={onSendBack} testId="parameter-history" />}
      {earlier.length > 0 && (
        <div className="parameter-earlier" data-testid="parameter-history-earlier">
          <h4>Earlier runs</h4>
          {earlier.map(log => (
            <details key={log.experimentId} data-experiment={log.experimentId}>
              <summary>{`Run ${log.experimentId}: ${log.changes.length} ${log.changes.length === 1 ? "change" : "changes"}`}</summary>
              <ChangeTable changes={log.changes} onSendBack={null} testId="parameter-history-stored" />
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
