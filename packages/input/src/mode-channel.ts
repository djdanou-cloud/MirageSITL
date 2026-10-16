import { normalizeAxis, validAxis, type AxisCalibration } from "./index.ts";
export interface ModeCalibration {
  enabled: boolean;
  axis: AxisCalibration;
  slots: number;
}
export function defaultModeCalibration(): ModeCalibration {
  return {
    enabled: false,
    axis: { axis: 4, min: -1, center: 0, max: 1, inverted: false, deadzone: 0 },
    slots: 6,
  };
}
export function modeSlot(raw: number, c: ModeCalibration): number {
  if (!c.enabled) return -1;
  if (
    !validAxis(c.axis) ||
    !Number.isInteger(c.slots) ||
    c.slots < 2 ||
    c.slots > 6
  )
    return -1;
  const x = normalizeAxis(raw, c.axis);
  return Number.isFinite(x)
    ? Math.min(c.slots - 1, Math.floor(((x + 1) * c.slots) / 2))
    : -1;
}
