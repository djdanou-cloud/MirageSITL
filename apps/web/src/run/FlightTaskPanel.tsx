import { planFlightTask, type FlightTaskRequest } from "@mirage/scenarios/flight-tasks";
import { TASK_TYPE_LABELS, stageText } from "../tasks/flight-task-form";
import type { FlightTaskView } from "./session-controller";

// The Run tab's flight task (TASK-172, S10): Run task from READY, the stage it
// is in, and requested next to actual. A value the stage does not request reads
// "not requested". The actual column is the physics truth at the same moment;
// the recording keeps both.

const ROWS: readonly { readonly key: keyof FlightTaskRequest; readonly label: string; readonly digits: number }[] = [
  { key: "northM", label: "North, m", digits: 2 }, { key: "eastM", label: "East, m", digits: 2 }, { key: "altitudeM", label: "Altitude, m", digits: 2 },
  { key: "speedMps", label: "Ground speed, m/s", digits: 2 }, { key: "headingDeg", label: "Heading, °", digits: 1 }, { key: "verticalSpeedMps", label: "Vertical speed, m/s", digits: 2 },
];
const value = (values: FlightTaskRequest | undefined, key: keyof FlightTaskRequest, digits: number): string => {
  const v = values?.[key];
  return v === null || v === undefined ? "not requested" : v.toFixed(digits);
};
const STATE_TEXT = { waiting: "Waiting for Run task", running: "Flying the task", done: "Task finished", failed: "Task ended early" } as const;

export function FlightTaskPanel({ task, canRun, onRun, refusal }: { task: FlightTaskView; canRun: boolean; onRun: () => void; refusal: string }) {
  const { step, task: entry } = task;
  const stages = planFlightTask(entry.definition);
  const planned = step ? stages[step.stageIndex] : undefined;
  return (
    <div className="sitl-task" role="group" aria-label="Flight task of this run">
      <h4>Flight task: {task.name} ({TASK_TYPE_LABELS[entry.definition.type]})</h4>
      <button type="button" onClick={onRun} disabled={!canRun}>Run task</button>
      {refusal && <p className="alert" role="alert">{refusal}</p>}
      <p data-testid="task-state" data-state={task.state}>{STATE_TEXT[task.state]}{task.reason ? `: ${task.reason}` : ""}</p>
      {step && (
        <>
          <p data-testid="task-stage" data-stage={step.stage} data-measured={step.measured}>
            Stage {step.stageIndex + 1} of {stages.length}: {planned ? stageText(planned.stage) : step.stage}
            {step.measured ? ", the task itself" : ", on the way to or from the task"}
          </p>
          <p data-testid="task-time">{step.taskTimeS === null ? "The task's clock has not started" : `Task time ${step.taskTimeS.toFixed(1)} s`}</p>
          <table className="sensor-table" aria-label="Requested and actual now">
            <thead><tr><th scope="col">Now</th><th scope="col">Requested</th><th scope="col">Actual</th></tr></thead>
            <tbody>
              {ROWS.map(({ key, label, digits }) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td data-testid={`task-requested-${key}`}>{value(step.requested, key, digits)}</td>
                  <td data-testid={`task-actual-${key}`}>{value(step.actual, key, digits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {step.arrival && (
            <table className="sensor-table" aria-label="Requested and actual where the task's clock started">
              <thead><tr><th scope="col">Where the clock started, at {step.arrival.simTimeS.toFixed(1)} s</th><th scope="col">Requested</th><th scope="col">Actual</th></tr></thead>
              <tbody>
                {ROWS.map(({ key, label, digits }) => (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    <td data-testid={`task-arrival-requested-${key}`}>{value(step.arrival?.requested, key, digits)}</td>
                    <td data-testid={`task-arrival-actual-${key}`}>{value(step.arrival?.actual, key, digits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
