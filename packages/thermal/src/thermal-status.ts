// Display status for the thermal camera (TASK-072): what the HUD shows about
// the shutter and calibration, derived only from the NUC controller and the
// sensor frame time (never from physics truth).
import type { NucController, NucFrameResult, ShutterState } from "./nuc.ts";

export type ThermalStatusLabel = "NO SIGNAL" | "LIVE" | "NUC";

export interface ThermalStatus {
  label: ThermalStatusLabel;
  shutter: ShutterState;
  frozen: boolean;
  /** Sensor time of the displayed frame, s. */
  frameTimeS: number;
  /** Time since the last completed calibration, s (null before the first frame). */
  sinceCalibrationS: number | null;
  /** Time until the next scheduled calibration, s (null before the first frame). */
  untilCalibrationS: number | null;
  calibrations: number;
}

export function thermalStatus(nuc: NucController, frame: Readonly<NucFrameResult>): ThermalStatus {
  if (nuc.state === "idle") {
    return { label: "NO SIGNAL", shutter: "idle", frozen: false, frameTimeS: frame.frameTimeS, sinceCalibrationS: null, untilCalibrationS: null, calibrations: 0 };
  }
  const label: ThermalStatusLabel = frame.frozen ? "NUC" : "LIVE";
  const since = frame.frameTimeS - nuc.lastCalibrationTimeS;
  return {
    label, shutter: nuc.state, frozen: frame.frozen, frameTimeS: frame.frameTimeS,
    sinceCalibrationS: Number.isFinite(since) ? since : null,
    untilCalibrationS: Number.isFinite(nuc.nextCalibrationS) ? Math.max(0, nuc.nextCalibrationS - frame.frameTimeS) : 0,
    calibrations: nuc.calibrations,
  };
}
