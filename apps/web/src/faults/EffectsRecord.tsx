import { EFFECT_CATALOG } from "@mirage/protocol";
import type { FaultSchedule } from "@mirage/scenarios/fault-schedule";
import type { EffectLog } from "./effect-log";

// A stored run's effects on the Experiments tab (TASK-169): the schedule it started with and what became of each control. A record of
// what was sent; what ArduPilot did about it is in the run's recording and log.

const seconds = (value: number | null) => (value === null ? "—" : value.toFixed(2));
const STATUS_TEXT = { pending: "Pending when last saved", applied: "Applied", rejected: "Rejected" } as const;

export function EffectsRecord({ schedule, log }: { schedule: FaultSchedule | null; log: EffectLog | null }) {
  if (!schedule && !log) return null;
  return (
    <div data-testid="experiment-effects">
      <h4>Faults and interference</h4>
      {schedule && (
        <p className="hint" data-testid="experiment-effects-schedule">
          {`Its schedule: ${schedule.entries.map(entry => `${EFFECT_CATALOG[entry.control.effect].label} at ${entry.onsetS} s${entry.durationS === null ? " until the end" : ` for ${entry.durationS} s`}`).join("; ")}. Times count from when ArduPilot first reported the aircraft armed.`}
        </p>
      )}
      {log && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="What became of each effect of this run, scrollable">
          <table className="scheme-table fault-ledger" aria-label="What became of each effect of this run" data-testid="experiment-effects-log">
            <thead><tr><th scope="col">Effect</th><th scope="col">Asked</th><th scope="col">From</th><th scope="col">Meant for, s</th><th scope="col">Applied at, s</th><th scope="col">Outcome</th><th scope="col">Why, or what it wrote</th></tr></thead>
            <tbody>
              {log.entries.map((entry, index) => (
                <tr key={index} data-effect={entry.effect} data-status={entry.status}>
                  <th scope="row">{EFFECT_CATALOG[entry.effect].label}</th>
                  <td>{entry.enabled ? "On" : "Off"}</td>
                  <td>{entry.origin === "manual" ? "By hand" : "Schedule"}</td>
                  <td>{seconds(entry.requestedSimS)}</td>
                  <td>{seconds(entry.appliedSimS)}</td>
                  <td>{STATUS_TEXT[entry.status]}</td>
                  <td>{entry.message || entry.writes.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
