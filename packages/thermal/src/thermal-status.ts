export type ShutterState = "idle" | "closed" | "calibrating" | "open";
export interface ThermalStatus {
  state: ShutterState;
  frameId: number;
  sensorTimeS: number;
  cycles: number;
  visible: boolean;
}

export type ThermalStatusLabel = "NO SIGNAL" | "LIVE" | "NUC";

/**
 * HUD label derived only from the NUC status (sensor frame clock), never
 * from physics truth: NO SIGNAL before the first frame, NUC while the
 * display holds its last image (closed/calibrating/open), LIVE otherwise.
 */
export function thermalStatusLabel(status: Readonly<ThermalStatus>): ThermalStatusLabel {
  if (status.frameId < 0) return "NO SIGNAL";
  return status.visible ? "LIVE" : "NUC";
}

