import type { EkfStatus } from "@mirage/autopilot/ekf-status";
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
/**
 * Applies an identity-bound EkfMonitor snapshot onto FlightStateV2 in place.
 * Demo truth never sets AutopilotStatusValid; only an active autopilot
 * diagnostic stream that has ingested at least one frame on the matching
 * session epoch sets AutopilotStatusValid. Failed innovation gates or
 * EKF_UNINITIALIZED clear ekfFlags so PilotHud never displays valid EKF.
 */
export function applyAutopilotTelemetry(
  state: FlightStateV2,
  status: EkfStatus | null,
  lastKnownMode: number = UNKNOWN_U32,
): void {
  const hasObservedAutopilot =
    status !== null &&
    status.epoch === state.epoch &&
    (Number.isFinite(status.ageMs) ||
      status.heartbeatFresh ||
      status.reportFresh ||
      status.mode !== null ||
      status.flags !== 0 ||
      lastKnownMode !== UNKNOWN_U32);
  if (!hasObservedAutopilot || status === null) {
    state.vehicleFlags &= ~VehicleFlagV2.AutopilotStatusValid;
    state.ekfFlags = 0;
    state.autopilotMode = UNKNOWN_U32;
    state.autopilotHealth = 0;
    state.autopilotStatusAgeMs = 0;
    return;
  }
  state.vehicleFlags |= VehicleFlagV2.AutopilotStatusValid;
  const bothFresh = status.heartbeatFresh && status.reportFresh;
  state.autopilotHealth =
    (status.heartbeatFresh ? AutopilotHealthV2.HeartbeatFresh : 0) |
    (status.reportFresh ? AutopilotHealthV2.EkfReportFresh : 0) |
    (bothFresh ? AutopilotHealthV2.LinkHealthy : 0);
  state.ekfFlags = status.innovationHealthy ? status.flags : 0;
  state.autopilotMode = status.mode !== null ? status.mode : lastKnownMode;
  state.autopilotStatusAgeMs = Number.isFinite(status.ageMs)
    ? status.ageMs
    : Infinity;
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
