import type { MotorCheckView } from "./session-controller";

// The motor check of the Run tab (TASK-157): a button that asks ArduPilot to
// spin each motor alone before flight, and the result per motor, expected
// against what the physics turned. The flight view rings the rotor that turns.

const spinText = (spin: "ccw" | "cw") => (spin === "ccw" ? "counter-clockwise" : "clockwise");

export function MotorCheckPanel({ check, disabled, refusal, onCheck }: {
  check: MotorCheckView | null; disabled: boolean; refusal: string; onCheck: () => void;
}) {
  return (
    <section className="motor-check" aria-labelledby="motor-check-heading" data-testid="motor-check"
      data-state={check ? (check.running ? "running" : check.passed ? "passed" : "failed") : "none"}>
      <h4 id="motor-check-heading">Motor check</h4>
      <p className="hint">
        ArduPilot spins each motor alone for 1.5 s at 15 % throttle, in its own test order, while the aircraft is on the ground and
        disarmed. The ringed rotor in the view is the one the physics turns.
      </p>
      <button type="button" onClick={onCheck} disabled={disabled || check?.running === true}>
        {check?.running ? `Checking motor ${check.testing ?? ""} (${check.step + 1} of ${check.total})` : check ? "Check motors again" : "Check motors"}
      </button>
      {refusal && <p className="alert" role="alert">{refusal}</p>}
      {check && !check.running && (
        <p role="status" data-testid="motor-check-summary">
          {check.stopped ? `Stopped: ${check.stopped}` : check.passed ? `All ${check.total} motors turn as the profile and ArduPilot's frame expect.`
            : `${check.results.filter(r => !r.pass).length} of ${check.total} motors do not match.`}
        </p>
      )}
      {check && check.results.length > 0 && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Motor check results">
          <table className="scheme-table">
            <caption>Expected by ArduPilot's frame, and turned by the physics</caption>
            <thead>
              <tr><th scope="col">Test</th><th scope="col">Expected motor, output, spin</th><th scope="col">Turned motor, output, spin</th>
                <th scope="col">Result</th></tr>
            </thead>
            <tbody>
              {check.results.map(result => (
                <tr key={result.testOrder} data-testid={`motor-check-${result.testOrder}`} data-pass={result.pass ? "true" : "false"}>
                  <th scope="row">{result.testOrder}</th>
                  <td>{`Motor ${result.expected.motorId}, output ${result.expected.output}, ${spinText(result.expected.spin)}`}</td>
                  <td>{result.observed ? `Motor ${result.observed.motorId}, output ${result.observed.output}, ${spinText(result.observed.spin)}`
                    : result.turned.length > 0 ? `Motors ${result.turned.join(", ")}` : "None"}</td>
                  <td>{result.pass ? "Pass" : `Fail: ${result.reason}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
