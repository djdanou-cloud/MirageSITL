import {
  CHANNELS,
  validAxis,
  type AxisCalibration,
  type GamepadCalibration,
} from "./index.ts";
import {
  defaultModeCalibration,
  type ModeCalibration,
} from "./mode-channel.ts";
export const CALIBRATION_KEY = "mirage.radio-calibration.v1";
export interface CalibrationProfile {
  schemaVersion: 1;
  axes: GamepadCalibration;
  mode: ModeCalibration;
}
export interface CalibrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
function axis(x: unknown): x is AxisCalibration {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    Object.keys(x).length === 6 &&
    "axis" in x &&
    typeof x.axis === "number" &&
    "min" in x &&
    typeof x.min === "number" &&
    "center" in x &&
    typeof x.center === "number" &&
    "max" in x &&
    typeof x.max === "number" &&
    "inverted" in x &&
    typeof x.inverted === "boolean" &&
    "deadzone" in x &&
    typeof x.deadzone === "number" &&
    validAxis({
      axis: x.axis,
      min: x.min,
      center: x.center,
      max: x.max,
      inverted: x.inverted,
      deadzone: x.deadzone,
    })
  );
}
export function parseCalibration(x: unknown): CalibrationProfile | null {
  if (
    typeof x !== "object" ||
    x === null ||
    Object.keys(x).length !== 3 ||
    !("schemaVersion" in x) ||
    x.schemaVersion !== 1 ||
    !("axes" in x) ||
    typeof x.axes !== "object" ||
    x.axes === null ||
    !("mode" in x) ||
    typeof x.mode !== "object" ||
    x.mode === null
  )
    return null;
  const a = x.axes,
    m = x.mode;
  if (Object.keys(m).length !== 3) return null;
  if (
    !("roll" in a) ||
    !axis(a.roll) ||
    !("pitch" in a) ||
    !axis(a.pitch) ||
    !("yaw" in a) ||
    !axis(a.yaw) ||
    !("throttle" in a) ||
    !axis(a.throttle) ||
    Object.keys(a).length !== 4 ||
    !("enabled" in m) ||
    typeof m.enabled !== "boolean" ||
    !("axis" in m) ||
    !axis(m.axis) ||
    !("slots" in m) ||
    typeof m.slots !== "number" ||
    !Number.isInteger(m.slots) ||
    m.slots < 2 ||
    m.slots > 6
  )
    return null;
  const axes: GamepadCalibration = {
    roll: { ...a.roll },
    pitch: { ...a.pitch },
    yaw: { ...a.yaw },
    throttle: { ...a.throttle },
  };
  const modeAxis = m.axis;
  if (
    m.enabled &&
    CHANNELS.some((channel) => axes[channel].axis === modeAxis.axis)
  )
    return null;
  return {
    schemaVersion: 1,
    axes,
    mode: { enabled: m.enabled, axis: { ...m.axis }, slots: m.slots },
  };
}
export function loadCalibration(
  store: CalibrationStorage,
): CalibrationProfile | null {
  try {
    const s = store.getItem(CALIBRATION_KEY);
    return s ? parseCalibration(JSON.parse(s) as unknown) : null;
  } catch {
    return null;
  }
}
export function saveCalibration(
  store: CalibrationStorage,
  axes: GamepadCalibration,
  mode: ModeCalibration = defaultModeCalibration(),
): boolean {
  const profile = parseCalibration({ schemaVersion: 1, axes, mode });
  if (!profile) return false;
  try {
    store.setItem(CALIBRATION_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}
