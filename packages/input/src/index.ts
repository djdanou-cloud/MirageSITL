import { ControlFlag, type PilotInput } from '@mirage/protocol';

export interface AxisCalibration {
  axis: number; min: number; center: number; max: number;
  inverted: boolean; deadzone: number;
}
export type Channel = 'roll' | 'pitch' | 'yaw' | 'throttle';
export type GamepadCalibration = Record<Channel, AxisCalibration>;
export const CHANNELS: Channel[] = ['roll', 'pitch', 'yaw', 'throttle'];
export function defaultCalibration(): GamepadCalibration {
  const axis = (index: number): AxisCalibration => ({
    axis: index, min: -1, center: 0, max: 1, inverted: false, deadzone: 0.035,
  });
  return { roll: axis(0), pitch: axis(1), yaw: axis(3), throttle: axis(2) };
}
export function validAxis(c: AxisCalibration): boolean {
  return Number.isInteger(c.axis) && c.axis >= 0 && c.axis < 32 &&
    [c.min, c.center, c.max, c.deadzone].every(Number.isFinite) &&
    c.min < c.center && c.center < c.max && c.deadzone >= 0 && c.deadzone < 1;
}
export function normalizeAxis(raw: number, c: AxisCalibration, throttle = false): number {
  if (!Number.isFinite(raw) || !validAxis(c)) return NaN;
  if (throttle) {
    const value = Math.max(0, Math.min(1, (raw - c.min) / (c.max - c.min)));
    return c.inverted ? 1 - value : value;
  }
  let value = raw >= c.center ? (raw - c.center) / (c.max - c.center) :
    (raw - c.center) / (c.center - c.min);
  value = Math.max(-1, Math.min(1, value));
  value = Math.abs(value) <= c.deadzone ? 0 :
    Math.sign(value) * (Math.abs(value) - c.deadzone) / (1 - c.deadzone);
  return c.inverted ? -value : value;
}
export type GamepadSource = () => readonly (Gamepad | null)[];
export type InputStatus = 'connected' | 'disconnected' | 'invalid-axes' | 'unavailable';
export class GamepadAdapter {
  selectedIndex: number | null = null;
  status: InputStatus = 'disconnected';
  deviceName = '';
  constructor(public calibration = defaultCalibration(), private readonly source: GamepadSource =
    () => navigator.getGamepads()) {}
  poll(out: PilotInput, nowMs: number, armed: boolean): void {
    out.roll = out.pitch = out.yaw = out.throttle = out.flags = 0;
    out.wallTimeMs = nowMs;
    let pads: readonly (Gamepad | null)[];
    try { pads = this.source(); } catch { this.status = 'unavailable'; return; }
    if (this.selectedIndex === null) {
      const first = pads.find(pad => pad?.connected);
      if (first) this.selectedIndex = first.index;
    }
    const pad = this.selectedIndex === null ? undefined : pads[this.selectedIndex];
    if (!pad?.connected) { this.status = 'disconnected'; this.deviceName = ''; return; }
    this.deviceName = pad.id;
    for (const channel of CHANNELS) {
      const calibration = this.calibration[channel];
      const value = normalizeAxis(pad.axes[calibration.axis] ?? NaN, calibration, channel === 'throttle');
      if (!Number.isFinite(value)) {
        out.roll = out.pitch = out.yaw = out.throttle = out.flags = 0;
        this.status = 'invalid-axes'; return;
      }
      out[channel] = value;
    }
    this.status = 'connected';
    out.flags = ControlFlag.Connected | (armed ? ControlFlag.Armed : 0);
  }
}
