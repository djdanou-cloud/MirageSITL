import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { MAX_CONTINUOUS_STEP_M, interpolatePoseInto, interpolationAlpha, newFlightStateV2, newRenderPoseV2,
  type FlightStateV2, type HistoryReadV2 } from '@mirage/protocol';
import { nedToRenderPositionInto } from '../apps/web/src/coordinates';

/** Quaternion (w,x,y,z) for a rotation of `angle` rad about the NED down axis (yaw): an independent oracle. */
const yaw = (angle: number) => [Math.cos(angle / 2), 0, 0, Math.sin(angle / 2)] as const;
function frame(northM: number, q: readonly [number, number, number, number]): FlightStateV2 {
  const s = newFlightStateV2();
  s.northM = northM; s.eastM = 2 * northM; s.downM = -northM;
  [s.qw, s.qx, s.qy, s.qz] = q;
  return s;
}
/** Rotation angle between two unit quaternions, treating q and -q as equal. */
const angleBetween = (a: readonly number[], b: readonly number[]) =>
  2 * Math.acos(Math.min(1, Math.abs(a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0))));
const quat = (pose: ReturnType<typeof newRenderPoseV2>) => [pose.qw, pose.qx, pose.qy, pose.qz];

describe('render interpolation', () => {
  it('interpolates position linearly and attitude along the great circle', () => {
    const previous = frame(0, yaw(0)), current = frame(10, yaw(Math.PI / 2)), out = newRenderPoseV2();
    interpolatePoseInto(previous, current, 'pair', 0.5, out);
    expect([out.northM, out.eastM, out.downM]).toEqual([5, 10, -5]);
    expect(angleBetween(quat(out), yaw(Math.PI / 4))).toBeLessThan(1e-12);
    expect(Math.hypot(...quat(out))).toBeCloseTo(1, 15);
    expect(out.interpolated).toBe(true);
    for (const t of [0, 0.25, 0.75]) {
      interpolatePoseInto(previous, current, 'pair', t, out);
      expect(angleBetween(quat(out), yaw((Math.PI / 2) * t)), String(t)).toBeLessThan(1e-12);
    }
  });
  it('treats q and -q as the same attitude instead of taking the long way round', () => {
    const q = yaw(0.3), negated = [-q[0], -q[1], -q[2], -q[3]] as const;
    const out = newRenderPoseV2();
    interpolatePoseInto(frame(0, q), frame(0, negated), 'pair', 0.5, out);
    expect(angleBetween(quat(out), q)).toBeLessThan(1e-12); // no spurious full rotation
    // A small rotation expressed with a sign flip still interpolates by the small angle.
    const end = yaw(0.5), flipped = [-end[0], -end[1], -end[2], -end[3]] as const;
    interpolatePoseInto(frame(0, q), frame(0, flipped), 'pair', 0.5, out);
    expect(angleBetween(quat(out), yaw(0.4))).toBeLessThan(1e-12);
  });
  it('never interpolates across an epoch/model break, a miss, or a teleport', () => {
    const previous = frame(0, yaw(0)), current = frame(10, yaw(1)), out = newRenderPoseV2();
    for (const history of ['latest', 'none'] as HistoryReadV2[]) {
      interpolatePoseInto(previous, current, history, 0.5, out);
      expect([out.northM, out.interpolated], history).toEqual([10, false]);
      expect(angleBetween(quat(out), yaw(1))).toBeLessThan(1e-12);
    }
    const teleported = frame(MAX_CONTINUOUS_STEP_M, yaw(0)); // 100 m north, 200 m east, 100 m up in one tick
    interpolatePoseInto(previous, teleported, 'pair', 0.5, out);
    expect([out.northM, out.interpolated]).toEqual([MAX_CONTINUOUS_STEP_M, false]);
  });
  it('never mutates truth and normalizes slightly denormalized float32 attitudes', () => {
    const previous = frame(1, yaw(0.2)), current = frame(2, yaw(0.6));
    current.qw *= 1.001; // float32 transport is not exactly unit length
    const before = JSON.stringify([previous, current]), out = newRenderPoseV2();
    interpolatePoseInto(previous, current, 'pair', 0.3, out);
    expect(JSON.stringify([previous, current])).toBe(before);
    expect(Math.hypot(...quat(out))).toBeCloseTo(1, 14);
    const zero = frame(0, [0, 0, 0, 0]);
    interpolatePoseInto(zero, zero, 'latest', 1, out);
    expect(quat(out)).toEqual([1, 0, 0, 0]); // a degenerate quaternion renders as identity, never NaN
  });
  it('derives the fraction from the scheduled wall time and rate, clamped to [0, 1]', () => {
    const s = newFlightStateV2(); s.scheduledWallTimeMs = 1000;
    expect(interpolationAlpha(1000, s, 400, true)).toBe(0);
    expect(interpolationAlpha(1001.25, s, 400, true)).toBe(0.5);
    expect(interpolationAlpha(1000 + 1000 / 1200, s, 1200, true)).toBeCloseTo(1, 12);
    expect(interpolationAlpha(990, s, 400, true)).toBe(0);
    expect(interpolationAlpha(1100, s, 400, true)).toBe(1);
    expect(interpolationAlpha(1001, s, 400, false)).toBe(1); // paused: show the current frame
    expect(interpolationAlpha(NaN, s, 400, true)).toBe(1);
    expect(interpolationAlpha(1001, s, 0, true)).toBe(1);
  });
  it('maps NED positions to the right-handed render basis', () => {
    const out = new Vector3();
    expect(nedToRenderPositionInto(1, 0, 0, out).toArray()).toEqual([0, -0, -1]);
    expect(nedToRenderPositionInto(0, 1, 0, out).toArray()).toEqual([1, -0, -0]);
    expect(nedToRenderPositionInto(0, 0, 1, out).toArray()).toEqual([0, -1, -0]);
  });
});
