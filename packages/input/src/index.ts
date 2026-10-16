import { defaultModeCalibration, modeSlot } from "./mode-channel.ts";
import { ControlFlag, type PilotInput } from "@mirage/protocol";

export interface AxisCalibration {
  axis: number;
  min: number;
  center: number;
  max: number;
  inverted: boolean;
  deadzone: number;
}
export type Channel = "roll" | "pitch" | "yaw" | "throttle";
export type GamepadCalibration = Record<Channel, AxisCalibration>;
export const CHANNELS: Channel[] = ["roll", "pitch", "yaw", "throttle"];
export function defaultCalibration(): GamepadCalibration {
  const axis = (index: number): AxisCalibration => ({
    axis: index,
    min: -1,
    center: 0,
    max: 1,
    inverted: false,
    deadzone: 0.035,
  });
  return { roll: axis(0), pitch: axis(1), yaw: axis(3), throttle: axis(2) };
}
export function validAxis(c: AxisCalibration): boolean {
  return (
    Number.isInteger(c.axis) &&
    c.axis >= 0 &&
    c.axis < 32 &&
    [c.min, c.center, c.max, c.deadzone].every(Number.isFinite) &&
    c.min < c.center &&
    c.center < c.max &&
    c.deadzone >= 0 &&
    c.deadzone < 1
  );
}
export function normalizeAxis(
  raw: number,
  c: AxisCalibration,
  throttle = false,
): number {
  if (!Number.isFinite(raw) || !validAxis(c)) return NaN;
  if (throttle) {
    const value = Math.max(0, Math.min(1, (raw - c.min) / (c.max - c.min)));
    return c.inverted ? 1 - value : value;
  }
  let value =
    raw >= c.center
      ? (raw - c.center) / (c.max - c.center)
      : (raw - c.center) / (c.center - c.min);
  value = Math.max(-1, Math.min(1, value));
  value =
    Math.abs(value) <= c.deadzone
      ? 0
      : (Math.sign(value) * (Math.abs(value) - c.deadzone)) / (1 - c.deadzone);
  return c.inverted ? -value : value;
}
export type GamepadSample = Pick<
  Gamepad,
  "index" | "id" | "connected" | "axes"
>;
export type GamepadSource = () => readonly (GamepadSample | null)[];
export type InputStatus =
  | "connected"
  | "disconnected"
  | "invalid-axes"
  | "unavailable";
export class GamepadAdapter {
  modeCalibration = defaultModeCalibration();
  calibratedModeSlot = -1;
  selectedIndex: number | null = null;
  status: InputStatus = "disconnected";
  deviceName = "";
  /**
   * Increments whenever the device behind the selection changes: a different
   * index or id (browsers reuse the lowest free index), a disconnect, or an
   * explicit selection. Consumers disarm when it changes (pilot mailbox v2
   * device_generation), so a replugged or swapped transmitter needs a new arm.
   */
  generation = 0;
  private identityIndex = -1;
  private identityId = "";
  constructor(
    public calibration = defaultCalibration(),
    private readonly source: GamepadSource = () => navigator.getGamepads(),
  ) {}
  /** Explicitly selects a device by index; always starts a new device generation. */
  selectDevice(index: number | null): void {
    this.selectedIndex = index;
    this.generation = (this.generation + 1) >>> 0;
    this.identityIndex = -1;
    this.identityId = "";
  }
  private noteIdentity(index: number, id: string): void {
    if (index === this.identityIndex && id === this.identityId) return;
    this.identityIndex = index;
    this.identityId = id;
    this.generation = (this.generation + 1) >>> 0;
  }
  poll(out: PilotInput, nowMs: number, armed: boolean): void {
    this.calibratedModeSlot = -1;
    out.roll = out.pitch = out.yaw = out.throttle = out.flags = 0;
    out.wallTimeMs = nowMs;
    let pads: readonly (GamepadSample | null)[];
    try {
      pads = this.source();
    } catch {
      this.status = "unavailable";
      return;
    }
    if (this.selectedIndex === null) {
      const first = pads.find((pad) => pad?.connected);
      if (first) this.selectedIndex = first.index;
    }
    const pad =
      this.selectedIndex === null ? undefined : pads[this.selectedIndex];
    if (!pad?.connected) {
      this.status = "disconnected";
      this.deviceName = "";
      if (this.identityIndex !== -1) this.noteIdentity(-1, "");
      return;
    }
    this.noteIdentity(pad.index, pad.id);
    this.deviceName = pad.id;
    for (const channel of CHANNELS) {
      const calibration = this.calibration[channel];
      const value = normalizeAxis(
        pad.axes[calibration.axis] ?? NaN,
        calibration,
        channel === "throttle",
      );
      if (!Number.isFinite(value)) {
        out.roll = out.pitch = out.yaw = out.throttle = out.flags = 0;
        this.status = "invalid-axes";
        return;
      }
      out[channel] = value;
    }
    if (this.modeCalibration.enabled) {
      for (let i = 0; i < CHANNELS.length; i++)
        if (
          this.calibration[CHANNELS[i]!].axis === this.modeCalibration.axis.axis
        ) {
          out.roll = out.pitch = out.yaw = out.throttle = out.flags = 0;
          this.status = "invalid-axes";
          return;
        }
      this.calibratedModeSlot = modeSlot(
        pad.axes[this.modeCalibration.axis.axis] ?? NaN,
        this.modeCalibration,
      );
      if (this.calibratedModeSlot < 0) {
        out.roll = out.pitch = out.yaw = out.throttle = out.flags = 0;
        this.status = "invalid-axes";
        return;
      }
    }
    this.status = "connected";
    out.flags = ControlFlag.Connected | (armed ? ControlFlag.Armed : 0);
  }
}
