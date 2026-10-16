import { ControlFlag, UNKNOWN_U32, type PilotInputV2 } from "@mirage/protocol";
/** PWM endpoints belong to cold radio configuration. Extended channels have different sentinels. */
export function rcSentinel(
  channel: number,
  action: "release" | "ignore",
): number {
  if (!Number.isInteger(channel) || channel < 1 || channel > 18)
    throw new Error("Invalid RC channel");
  return action === "ignore" ? 65535 : channel <= 8 ? 0 : 65534;
}
export function pwm(value: number, throttle = false): number {
  return Number.isFinite(value) && value >= (throttle ? 0 : -1) && value <= 1
    ? Math.round(throttle ? 1000 + 1000 * value : 1500 + 500 * value)
    : -1;
}
export class RcOverride {
  readonly payload = new Uint8Array(38);
  private readonly view = new DataView(this.payload.buffer);
  into(
    channels: Uint16Array,
    targetSystem: number,
    targetComponent: number,
  ): boolean {
    if (
      channels.length !== 18 ||
      !Number.isInteger(targetSystem) ||
      targetSystem < 1 ||
      targetSystem > 255 ||
      !Number.isInteger(targetComponent) ||
      targetComponent < 0 ||
      targetComponent > 255
    )
      return false;
    for (let i = 0; i < 18; i++) {
      const v = channels[i]!;
      if (
        (v < 800 || v > 2200) &&
        v !== 65535 &&
        v !== 0 &&
        !(i >= 8 && v === 65534)
      )
        return false;
    }
    for (let i = 0; i < 8; i++) this.view.setUint16(i * 2, channels[i]!, true);
    this.view.setUint8(16, targetSystem);
    this.view.setUint8(17, targetComponent);
    for (let i = 8; i < 18; i++)
      this.view.setUint16(18 + (i - 8) * 2, channels[i]!, true);
    return true;
  }
}

/** Configured wire channels [roll,pitch,throttle,yaw,mode], independent of motor IDs. */
export class PilotRcMapper {
  readonly channels = new Uint16Array(18);
  private readonly map: Uint8Array;
  private readonly modes: Uint16Array;
  constructor(
    channels: readonly [number, number, number, number, number] = [
      1, 2, 3, 4, 5,
    ],
    modePwm: readonly number[] = [1100, 1300, 1425, 1550, 1700, 1900],
  ) {
    if (
      channels.length !== 5 ||
      channels.some((c) => !Number.isInteger(c) || c < 1 || c > 18) ||
      new Set(channels).size !== 5 ||
      modePwm.length !== 6 ||
      modePwm.some((v) => !Number.isInteger(v) || v < 800 || v > 2200)
    )
      throw new Error("Invalid RC mapping");
    this.map = new Uint8Array(channels);
    this.modes = new Uint16Array(modePwm);
    this.channels.fill(65535);
  }
  mapInto(input: PilotInputV2): boolean {
    const r = pwm(input.roll),
      p = pwm(input.pitch),
      t = pwm(input.throttle, true),
      y = pwm(input.yaw),
      slot = input.calibratedModeSlot;
    if (
      r < 0 ||
      p < 0 ||
      t < 0 ||
      y < 0 ||
      input.flags >>> 0 !== input.flags ||
      (input.flags & ~3) !== 0 ||
      !(
        slot === UNKNOWN_U32 ||
        (Number.isInteger(slot) && slot >= 0 && slot < 6)
      )
    )
      return false;
    this.channels.fill(65535);
    if ((input.flags & ControlFlag.Connected) === 0) {
      for (let i = 0; i < 5; i++) {
        const channel = this.map[i]!;
        this.channels[channel - 1] = channel <= 8 ? 0 : 65534;
      }
      return true;
    }
    this.channels[this.map[0]! - 1] = r;
    this.channels[this.map[1]! - 1] = p;
    this.channels[this.map[2]! - 1] = t;
    this.channels[this.map[3]! - 1] = y;
    if (slot !== UNKNOWN_U32)
      this.channels[this.map[4]! - 1] = this.modes[slot]!;
    return true;
  }
}
