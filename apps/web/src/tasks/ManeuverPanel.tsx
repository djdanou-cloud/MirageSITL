import { wrapDeg, planFlightTask, type FlightTaskDefinition } from "@mirage/scenarios/flight-tasks";

// What a tuning maneuver will ask for, on the Flight tasks tab (TASK-173): each
// sudden change of the request, on the task's clock, before anything flies.

export function ManeuverPanel({ task }: { task: FlightTaskDefinition }) {
  const stage = planFlightTask(task).find(planned => planned.stage.kind === "maneuver")?.stage;
  if (stage?.kind !== "maneuver") return null;
  const { axis, timeline, altitudeM, headingDeg } = stage;
  const unit = axis === "altitude" ? "m" : "°";
  /** The value requested, as the Run tab shows it. */
  const value = (offset: number): number => {
    switch (axis) {
      case "altitude": return altitudeM + offset;
      case "heading": return wrapDeg((headingDeg ?? 0) + offset);
      case "roll": case "pitch": return offset;
      default: { const never: never = axis; return never; }
    }
  };
  return (
    <div data-testid="maneuver-panel">
      <h4>What will be requested</h4>
      <table className="sensor-table" aria-label="Each change of the request">
        <thead><tr><th scope="col">At, s</th><th scope="col">{`The ${axis} request goes`}</th></tr></thead>
        <tbody>
          {timeline.edges.map(edge => (
            <tr key={edge.timeS} data-testid="maneuver-edge">
              <th scope="row">{edge.timeS}</th>
              <td>{`from ${value(edge.from)}${unit} to ${value(edge.to)}${unit}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        The maneuver takes {timeline.lengthS} s on its clock, which starts on arrival at the start of the maneuver. These changes are sudden on purpose: how the aircraft answers one is what a maneuver measures.
        {(axis === "roll" || axis === "pitch") && " ArduPilot holds the height, not the position, so the aircraft moves while it leans, and it stops and holds again afterwards."}
        {" "}After the run stops, its experiment on the Experiments tab shows requested against actual, with rise time, overshoot and settling of each change.
      </p>
    </div>
  );
}
