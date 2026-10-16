export interface Attitude {
  rollRad: number;
  pitchRad: number;
  yawRad: number;
}
/** FRD-to-NED Hamilton quaternion, wxyz, aerospace 3-2-1 Euler angles. */
export function attitudeFromQuaternion(
  w: number,
  x: number,
  y: number,
  z: number,
): Attitude | null {
  const n = Math.hypot(w, x, y, z);
  if (!Number.isFinite(n) || n < 1e-9) return null;
  w /= n;
  x /= n;
  y /= n;
  z /= n;
  return {
    rollRad: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) || 0,
    pitchRad: Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
    yawRad: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) || 0,
  };
}
