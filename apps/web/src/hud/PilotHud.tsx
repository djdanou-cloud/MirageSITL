import type { FlightStateV2 } from "@mirage/protocol";
import { attitudeFromQuaternion } from "./attitude";
import { hudTelemetry } from "./telemetry";
export function PilotHud({
  state,
  additionalAgeMs = 0,
}: {
  state: FlightStateV2 | null;
  additionalAgeMs?: number;
}) {
  const a = state
      ? attitudeFromQuaternion(state.qw, state.qx, state.qy, state.qz)
      : null,
    t = state ? hudTelemetry(state, additionalAgeMs) : null;
  const roll = a ? (a.rollRad * 180) / Math.PI : 0,
    pitch = a ? (a.pitchRad * 180) / Math.PI : 0;
  return (
    <div
      className="pilot-hud"
      data-testid="pilot-hud"
      aria-label="Pilot attitude and autopilot status"
    >
      <div
        className="attitude-window"
        role="img"
        aria-label={
          a
            ? `Roll ${roll.toFixed(1)} degrees, pitch ${pitch.toFixed(1)} degrees`
            : "Attitude unavailable"
        }
      >
        <div
          className="attitude-world"
          style={{
            transform: `rotate(${-roll}deg) translateY(${pitch * 1.5}px)`,
          }}
        />
        <div className="attitude-cross">— + —</div>
      </div>
      <output data-testid="hud-ap-status">
        {t?.source === "autopilot"
          ? `${t.mode} · ${t.status.toUpperCase()} · ${t.ageMs?.toFixed(0) ?? "?"} ms`
          : "DEMO TRUTH · ArduPilot disconnected · EKF UNKNOWN"}
      </output>
      {t?.source === "autopilot" && (
        <output role="status">
          {t.status !== "fresh"
            ? "EKF STALE"
            : t.ekfFlags === 31
              ? "EKF flags valid"
              : "EKF DEGRADED"}
        </output>
      )}
    </div>
  );
}
