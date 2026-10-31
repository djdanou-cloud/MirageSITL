import { useMemo } from "react";
import { frameConfiguration, parameterFileText } from "@mirage/aircraft/frame-parameters";
import type { AircraftProfile } from "@mirage/aircraft/profile";

// ArduPilot outputs and frame of the profile being edited (TASK-142, S03).
// Outputs are assigned per motor in the arm table; this section shows the
// frame they lead to, each motor's ArduPilot motor and output function, the
// generated parameter file and, for the scripting matrix, its Lua file, or
// the reasons the layout cannot be configured. The parameters belong to the
// saved profile version shown; unsaved edits are labelled as such.

const LEVEL = { single: "", upper: " upper", lower: " lower" } as const;

export function OutputMapping({ profile, profileSha256 }: { profile: AircraftProfile | null; profileSha256: string | null }) {
  const config = useMemo(() => (profile ? frameConfiguration(profile, profileSha256) : null), [profile, profileSha256]);
  return (
    <section className="project-section" aria-labelledby="outputs-heading">
      <h3 id="outputs-heading">ArduPilot outputs and frame</h3>
      {!config || !profile ? <p>The outputs and frame appear once the arms, motors and mass properties are valid.</p> : (
        <div data-testid="output-mapping" data-kind={config.ok ? config.kind : "refused"}>
          <p className="hint">
            Assign each motor's ArduPilot output in its arm above. Pinned firmware {config.source.firmwareVersion}, commit{" "}
            <code>{config.source.ardupilotCommit.slice(0, 12)}</code>.{" "}
            {profileSha256 ? <>Parameters of profile version <code data-testid="mapping-profile">{profileSha256.slice(0, 12)}</code>.</> : "Unsaved changes: save the profile to bind these parameters to a version."}
          </p>
          {!config.ok ? (
            <ul className="form-errors" aria-label="Why this layout cannot be configured">
              {config.reasons.map(reason => <li key={reason.code}>{reason.message}</li>)}
            </ul>
          ) : (
            <>
              <p data-testid="mapping-frame">
                {config.kind === "stock" ? "Stock frame" : "Stock scripting matrix"}: FRAME_CLASS {config.frameClass}, FRAME_TYPE {config.frameType},
                {" "}{config.servoPacketChannels}-channel servo packets.
              </p>
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Motor outputs table">
                <table className="entry-table" aria-label="Motor outputs">
                  <thead>
                    <tr><th scope="col">Motor</th><th scope="col">Arm</th><th scope="col">Spin</th><th scope="col">ArduPilot motor</th><th scope="col">Output</th><th scope="col">Output function</th></tr>
                  </thead>
                  <tbody>
                    {config.motors.map((motor, index) => {
                      // Mapped motors are in the profile's motor order.
                      const source = profile.motors[index]!;
                      return (
                        <tr key={motor.motorId}>
                          <th scope="row">{motor.motorId}</th>
                          <td>{source.armId}{LEVEL[source.level]}</td>
                          <td>{source.spin === "ccw" ? "Counter-clockwise" : "Clockwise"}</td>
                          <td>Motor {motor.ardupilotMotor}</td>
                          <td>SERVO{motor.output}</td>
                          <td>{motor.servoFunction}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {config.notes.length > 0 && (
            <ul aria-label="Frame notes">{config.notes.map(note => <li key={note.code}>{note.message}</li>)}</ul>
          )}
          {config.ok && (
            <>
              <h4 id="parameter-file-heading">Parameter file</h4>
              <pre className="code-block" aria-labelledby="parameter-file-heading" tabIndex={0} data-testid="mapping-parameters">{parameterFileText(config.parameters)}</pre>
              {config.script !== null && (
                <>
                  <h4 id="lua-file-heading">Lua frame file</h4>
                  <pre className="code-block" aria-labelledby="lua-file-heading" tabIndex={0} data-testid="mapping-script">{config.script}</pre>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
