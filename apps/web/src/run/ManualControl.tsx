import { useEffect, useState } from "react";
import type { GamepadAdapter } from "@mirage/input";
import type { PilotInput } from "@mirage/protocol";
import { MANUAL_RATE_HZ, type ManualMode, type ManualView } from "./session-controller";

// Manual flight with the calibrated USB controller (TASK-174). The panel shows
// the controller and its sticks, and takes or releases manual control; the
// session controller sends the sticks to ArduPilot and pauses the run when the
// controller is lost (user decision of 2026-11-03).

const MODES: readonly ManualMode[] = ["alt-hold", "loiter", "stabilize"];
const MODE_TEXT: Readonly<Record<ManualMode, string>> = { "alt-hold": "Altitude hold", loiter: "Loiter", stabilize: "Stabilize" };
const STATUS_TEXT = { connected: "connected", disconnected: "not connected", "invalid-axes": "connected, but its axes do not match the calibration",
  unavailable: "not available in this browser" } as const;

export function ManualControl({ adapter, manual, canTake, onTake, onRelease, refusal }: {
  adapter: GamepadAdapter;
  manual: ManualView | null;
  /** The run can be flown by hand now (READY, or flying in GUIDED). */
  canTake: boolean;
  onTake: (mode: ManualMode) => void;
  onRelease: () => void;
  refusal: string;
}) {
  const [mode, setMode] = useState<ManualMode>("alt-hold");
  const [sample, setSample] = useState<{ status: GamepadAdapter["status"]; device: string; sticks: PilotInput } | null>(null);
  // The panel's own view of the controller, four times a second; the session controller polls it separately at the send rate.
  useEffect(() => {
    const show = () => {
      const sticks: PilotInput = { roll: 0, pitch: 0, yaw: 0, throttle: 0, flags: 0, wallTimeMs: 0 };
      adapter.poll(sticks, performance.now(), false);
      setSample({ status: adapter.status, device: adapter.deviceName, sticks });
    };
    show();
    const timer = setInterval(show, 250);
    return () => clearInterval(timer);
  }, [adapter]);
  const sticks = sample?.sticks;
  return (
    <section className="manual-control" aria-labelledby="manual-control-heading">
      <h4 id="manual-control-heading">Manual control</h4>
      <p className="hint" data-testid="manual-controller" data-status={sample?.status ?? "disconnected"}>
        {`Controller ${sample?.device ? `"${sample.device}" ` : ""}${STATUS_TEXT[sample?.status ?? "disconnected"]}.`}
        {sticks && sample?.status === "connected"
          ? ` Throttle ${(sticks.throttle * 100).toFixed(0)} %, roll ${sticks.roll.toFixed(2)}, pitch ${sticks.pitch.toFixed(2)}, yaw ${sticks.yaw.toFixed(2)}.` : ""}
      </p>
      <p className="hint">
        The sticks go to ArduPilot {MANUAL_RATE_HZ} times a second. If the controller is unplugged, swapped or stops sending, the run pauses. A
        controller that was plugged back in or swapped does not take over: Resume gives the flight back to MirageSITL, which holds position.
      </p>
      <div className="sitl-actions">
        <label htmlFor="manual-mode">Flight mode</label>
        <select id="manual-mode" value={mode} disabled={manual !== null}
          onChange={event => setMode(MODES.find(value => value === event.target.value) ?? "alt-hold")}>
          {MODES.map(value => <option key={value} value={value}>{MODE_TEXT[value]}</option>)}
        </select>
        <button type="button" onClick={() => onTake(mode)} disabled={manual !== null || !canTake}>Take manual control</button>
        <button type="button" onClick={onRelease} disabled={manual === null}>Release manual control</button>
      </div>
      {manual && (
        <p className="hint" role="status" data-testid="manual-status" data-mode={manual.mode}>
          {`Flying by hand in ${MODE_TEXT[manual.mode]} with "${manual.device}".`}{manual.waiting ? ` ${manual.waiting}.` : ""}
        </p>
      )}
      {refusal && <p className="alert" role="alert" data-testid="manual-refusal">{refusal}</p>}
    </section>
  );
}
