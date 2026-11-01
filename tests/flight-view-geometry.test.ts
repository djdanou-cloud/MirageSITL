// TASK-185: the flight view's pure geometry and the flight panel's values.
// Oracles: the trail's declared capacity and sampling interval, its
// oldest-first order and its reset on a new epoch or backwards time; the
// TASK-067 lens checks the onboard camera must pass with a plain lens; ZYX
// Euler angles of known quaternions; and the blade's display rate, which must
// never exceed what a 60 Hz display shows without aliasing (half a turn per
// frame).
import { describe, expect, test } from 'vitest';
import { FpvCamera } from '@mirage/cameras/fpv-camera';
import { deriveLayout } from '@mirage/aircraft/layout';
import { chaseOffset, drawnSpinRadS, onboardCamera, TRAIL_CAPACITY, TRAIL_INTERVAL_S, TRAIL_SECONDS, TrailBuffer } from '../apps/web/src/run/flight-view-geometry.ts';
import { flightValues } from '../apps/web/src/run/FlightTelemetry.tsx';
import { quadProfile } from './support/quad-profile.ts';

describe('the trajectory ring', () => {
  test('keeps one sample per 0.1 s of simulated time for two minutes, oldest first', () => {
    expect([TRAIL_SECONDS, TRAIL_INTERVAL_S, TRAIL_CAPACITY]).toEqual([120, 0.1, 1200]);
    const trail = new TrailBuffer(), out = new Float32Array(TRAIL_CAPACITY * 3);
    // Offers every 1/800 s: only every 80th is a new sample.
    let kept = 0;
    for (let tick = 0; tick <= 800; tick++) if (trail.offer(1, tick / 800, tick, 0, 0)) kept++;
    expect(kept).toBe(11);
    expect(trail.writeInto(out)).toBe(11);
    expect(Array.from(out.subarray(0, 6))).toEqual([0, 0, 0, 80, 0, 0]);
    // Past capacity the oldest samples go and the order stays oldest first.
    const full = new TrailBuffer();
    for (let i = 0; i < TRAIL_CAPACITY + 5; i++) full.offer(1, i * TRAIL_INTERVAL_S, i, i, i);
    expect(full.writeInto(out)).toBe(TRAIL_CAPACITY);
    expect([out[0], out[(TRAIL_CAPACITY - 1) * 3]]).toEqual([5, TRAIL_CAPACITY + 4]);
  });

  test('starts again on a new epoch or when time runs backwards, and skips non-finite positions', () => {
    const trail = new TrailBuffer();
    for (let i = 0; i < 10; i++) trail.offer(1, i * 0.1, i, 0, 0);
    expect(trail.count).toBe(10);
    expect(trail.offer(2, 5, 1, 2, 3)).toBe(true);
    expect(trail.count).toBe(1);
    expect(trail.offer(2, 1, 1, 2, 3)).toBe(true);
    expect(trail.count).toBe(1);
    expect(trail.offer(2, 2, Number.NaN, 0, 0)).toBe(false);
    expect(trail.count).toBe(1);
  });
});

describe('cameras and blades', () => {
  test('the onboard camera is a plain-lens TASK-067 camera at the front of the body, and the chase camera scales with the span', async () => {
    const { profile } = await quadProfile();
    const layout = deriveLayout(profile);
    const config = onboardCamera(layout);
    expect(config.lens.distortion).toEqual({ model: 'none' });
    expect(config.mount.offsetFrdM[0]).toBeGreaterThan(0);
    expect([config.mount.offsetFrdM[1], config.mount.offsetFrdM[2], config.mount.uptiltRad]).toEqual([0, 0, 0]);
    // TASK-067's own checks accept it at any whole-pixel size.
    for (const [w, h] of [[16, 9], [687, 438], [1920, 1080]] as const) expect(() => new FpvCamera(config, w, h)).not.toThrow();
    expect(() => new FpvCamera(config, 687.5, 438)).toThrow('Invalid output size');
    const [x, y, z] = chaseOffset(layout);
    expect(x > 0 && y > 0 && z > 0).toBe(true);
  });

  test('the drawn blade turns with the motor speed, never faster than half a turn per 60 Hz frame', () => {
    expect([drawnSpinRadS(0), drawnSpinRadS(-100), drawnSpinRadS(Number.NaN)]).toEqual([0, 0, 0]);
    expect(drawnSpinRadS(6000)).toBeCloseTo(2 * Math.PI, 12);
    expect(drawnSpinRadS(30000)).toBe(drawnSpinRadS(12000));
    expect(drawnSpinRadS(30000) / 60).toBeLessThan(Math.PI);
  });
});

describe('flight values', () => {
  test('altitude, speeds and ZYX Euler angles from a NED state', () => {
    const level = { downM: -5, vnMps: 3, veMps: 4, vdMps: -1, qw: 1, qx: 0, qy: 0, qz: 0, simTimeS: 12 };
    expect(flightValues(level)).toEqual({ altitudeM: 5, groundSpeedMps: 5, verticalSpeedMps: 1, rollDeg: 0, pitchDeg: 0, headingDeg: 0, simTimeS: 12 });
    // Heading 90°: a yaw quaternion about down.
    const east = flightValues({ ...level, qw: Math.SQRT1_2, qz: Math.SQRT1_2 });
    expect(east.headingDeg).toBeCloseTo(90, 9);
    // 10° roll, then 20° pitch (ZYX: q = qz(0) * qy(20°) * qx(10°)).
    const r = (10 * Math.PI) / 360, p = (20 * Math.PI) / 360;
    const q = { qw: Math.cos(p) * Math.cos(r), qx: Math.cos(p) * Math.sin(r), qy: Math.sin(p) * Math.cos(r), qz: -Math.sin(p) * Math.sin(r) };
    const tilted = flightValues({ ...level, ...q });
    expect(tilted.rollDeg).toBeCloseTo(10, 9);
    expect(tilted.pitchDeg).toBeCloseTo(20, 9);
    // A heading just west of north wraps to 0–360.
    expect(flightValues({ ...level, qw: Math.cos(-0.05), qz: Math.sin(-0.05) }).headingDeg).toBeCloseTo(360 - (0.1 * 180) / Math.PI, 9);
  });
});
