import {
  AutopilotHealthV2,
  VehicleFlagV2,
  UNKNOWN_U32,
  type FlightStateV2,
} from "@mirage/protocol";
export interface HudTelemetry {
  source: "demo-truth" | "autopilot";
  status: "unknown" | "stale" | "fresh";
  mode: string;
  ekfFlags: number | null;
  ageMs: number | null;
}
export function hudTelemetry(
  state: FlightStateV2,
  additionalAgeMs = 0,
): HudTelemetry {
  if (!(state.vehicleFlags & VehicleFlagV2.AutopilotStatusValid))
    return {
      source: "demo-truth",
      status: "unknown",
      mode: "DIRECT RATE",
      ekfFlags: null,
      ageMs: null,
    };
  const age = state.autopilotStatusAgeMs + additionalAgeMs;
  const fresh =
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 1000 &&
    (state.autopilotHealth &
      (AutopilotHealthV2.HeartbeatFresh |
        AutopilotHealthV2.EkfReportFresh |
        AutopilotHealthV2.LinkHealthy)) ===
      7;
  return {
    source: "autopilot",
    status: fresh ? "fresh" : "stale",
    mode:
      state.autopilotMode === UNKNOWN_U32
        ? "UNKNOWN"
        : `AP MODE ${state.autopilotMode}`,
    ekfFlags: fresh ? state.ekfFlags : null,
    ageMs: Number.isFinite(age) && age >= 0 ? age : null,
  };
}
