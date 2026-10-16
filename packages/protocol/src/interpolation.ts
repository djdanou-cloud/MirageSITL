import type { HistoryReadV2 } from './atomic-v2.ts';
import type { FlightStateV2 } from './state-v2.ts';

// Render interpolation between adjacent truth frames (TASK-015). Rendering
// never waits for the writer and never mutates truth: inputs are read-only,
// results go to a caller-owned RenderPoseV2. Interpolation happens only for a
// StateReaderV2.latestPair() 'pair' (adjacent ticks, same epoch and model), so
// reset or model replacement always breaks history.

/** NED position (m) and body-to-NED unit quaternion (w,x,y,z) for rendering. */
export interface RenderPoseV2 {
  northM: number; eastM: number; downM: number;
  qw: number; qx: number; qy: number; qz: number;
  /** True when the pose was interpolated; false when it is the current frame as-is. */
  interpolated: boolean;
}
export function newRenderPoseV2(): RenderPoseV2 {
  return { northM: 0, eastM: 0, downM: 0, qw: 1, qx: 0, qy: 0, qz: 0, interpolated: false };
}

/**
 * Largest displacement between adjacent ticks treated as continuous motion:
 * 100 m per tick is 40 km/s at 400 Hz, far beyond any modeled vehicle, so a
 * larger jump inside one epoch is a teleport and is never interpolated.
 */
export const MAX_CONTINUOUS_STEP_M = 100;
/** Above this cosine the two attitudes are nearly equal; normalized lerp avoids an ill-conditioned 1/sin(theta). */
const SLERP_LINEAR_THRESHOLD = 0.9995;

/**
 * Interpolation fraction for the current frame: 0 at its scheduled wall time,
 * 1 one physics step later (rendering lags truth by at most one step).
 * Clamped to [0,1]; 1 when not running, or when time or rate is invalid.
 */
export function interpolationAlpha(nowWallMs: number, current: FlightStateV2, hz: number, running: boolean): number {
  if (!running || !(hz > 0)) return 1;
  const alpha = (nowWallMs - current.scheduledWallTimeMs) * hz / 1000;
  return alpha >= 0 ? (alpha <= 1 ? alpha : 1) : alpha < 0 ? 0 : 1; // NaN -> 1
}

/**
 * Writes the pose at `alpha` between previous (alpha=0) and current (alpha=1).
 * Uses the shortest rotation path: q and -q describe the same attitude, so
 * the end quaternion is negated when the dot product is negative. Output
 * quaternion is normalized. Falls back to the current frame unless history is
 * 'pair' and the step is continuous. Allocation-free; inputs are not mutated.
 */
export function interpolatePoseInto(previous: FlightStateV2, current: FlightStateV2, history: HistoryReadV2,
  alpha: number, out: RenderPoseV2): void {
  const dn = current.northM - previous.northM, de = current.eastM - previous.eastM, dd = current.downM - previous.downM;
  const continuous = history === 'pair' && dn * dn + de * de + dd * dd <= MAX_CONTINUOUS_STEP_M * MAX_CONTINUOUS_STEP_M;
  const t = alpha >= 0 && alpha <= 1 ? alpha : 1;
  if (!continuous || t === 1) {
    out.northM = current.northM; out.eastM = current.eastM; out.downM = current.downM;
    setNormalized(out, current.qw, current.qx, current.qy, current.qz);
    out.interpolated = false;
    return;
  }
  out.northM = previous.northM + dn * t; out.eastM = previous.eastM + de * t; out.downM = previous.downM + dd * t;
  const aw = previous.qw, ax = previous.qx, ay = previous.qy, az = previous.qz;
  let bw = current.qw, bx = current.qx, by = current.qy, bz = current.qz;
  let cos = aw * bw + ax * bx + ay * by + az * bz;
  if (cos < 0) { bw = -bw; bx = -bx; by = -by; bz = -bz; cos = -cos; } // shortest path
  let wa: number, wb: number;
  if (cos > SLERP_LINEAR_THRESHOLD) {
    wa = 1 - t; wb = t;
  } else {
    const theta = Math.acos(cos < 1 ? cos : 1), sin = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / sin; wb = Math.sin(t * theta) / sin;
  }
  setNormalized(out, aw * wa + bw * wb, ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb);
  out.interpolated = true;
}

function setNormalized(out: RenderPoseV2, w: number, x: number, y: number, z: number): void {
  const norm = Math.sqrt(w * w + x * x + y * y + z * z);
  if (norm > 0 && norm === norm) { out.qw = w / norm; out.qx = x / norm; out.qy = y / norm; out.qz = z / norm; }
  else { out.qw = 1; out.qx = 0; out.qy = 0; out.qz = 0; }
}
