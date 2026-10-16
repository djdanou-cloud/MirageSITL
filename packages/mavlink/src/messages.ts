import type { MavFrame } from "./codec.ts";
/** HIL_ACTUATOR_CONTROLS only. Actual mapping/signing/firmware admission belongs to HITL gates. */
export interface HilActuators {
  timeLoUs: number;
  timeHiUs: number;
  flagsLo: number;
  flagsHi: number;
  mode: number;
  controls: Float64Array;
}
export function actuatorInto(frame: MavFrame, out: HilActuators): boolean {
  if (
    frame.id !== 93 ||
    frame.view.byteLength < 81 ||
    out.controls.length !== 16
  )
    return false;
  const v = frame.view;
  for (let i = 0; i < 16; i++) {
    const x = v.getFloat32(16 + i * 4, true);
    if (!Number.isFinite(x) || x < -1 || x > 1) return false;
  }
  out.timeLoUs = v.getUint32(0, true);
  out.timeHiUs = v.getUint32(4, true);
  out.flagsLo = v.getUint32(8, true);
  out.flagsHi = v.getUint32(12, true);
  out.mode = v.getUint8(80);
  for (let i = 0; i < 16; i++) out.controls[i] = v.getFloat32(16 + i * 4, true);
  return true;
}
