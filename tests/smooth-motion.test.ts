import { describe, expect, test } from 'vitest';
import { restToRest, speedChange, type MotionProfile } from '@mirage/scenarios/smooth-motion';

// The profiles are checked against what they must be physically, by stepping them
// and differentiating and integrating numerically: nothing here reads the
// implementation's formulas. A step of 1 ms, so the tolerances below are that
// step's numerical error, not a judgement of the shape.
const STEP_S = 0.001;

function walk(profile: MotionProfile, endS: number) {
  let speedIntegral = 0, accelerationIntegral = 0, largestAcceleration = 0, largestJerk = 0, largestSpeed = 0, smallestSpeed = Infinity;
  let previous = profile.sample(0);
  const start = previous;
  // Whole steps, then one to land exactly on the end, which is no multiple of the step.
  const steps = Math.floor(endS / STEP_S), times = [...Array.from({ length: steps }, (_, i) => (i + 1) * STEP_S), endS];
  let previousS = 0;
  for (const timeS of times) {
    const stepS = timeS - previousS;
    if (stepS <= 0) continue;
    const now = profile.sample(timeS);
    speedIntegral += (previous.speed + now.speed) / 2 * stepS;
    accelerationIntegral += (previous.acceleration + now.acceleration) / 2 * stepS;
    largestAcceleration = Math.max(largestAcceleration, Math.abs(now.acceleration));
    // Too short a last step magnifies rounding, and says nothing about the jerk.
    if (stepS >= STEP_S / 2) largestJerk = Math.max(largestJerk, Math.abs(now.acceleration - previous.acceleration) / stepS);
    largestSpeed = Math.max(largestSpeed, now.speed);
    smallestSpeed = Math.min(smallestSpeed, now.speed);
    previous = now;
    previousS = timeS;
  }
  return { start, end: previous, speedIntegral, accelerationIntegral, largestAcceleration, largestJerk, largestSpeed, smallestSpeed };
}

describe('a speed change', () => {
  // [from, to, acceleration limit, jerk limit]: reaching the limit, too small a change to reach it, braking, stopping.
  test.each([[2, 8, 1.5, 5], [0, 2, 1, 5], [0, 0.1, 1, 5], [8, 0, 2, 5], [5, 3, 2.5, 5], [0, 0.2, 1, 5]])('%d to %d at %d, jerk %d', (from, to, acceleration, jerk) => {
    const profile = speedChange(from, to, acceleration, jerk);
    const walked = walk(profile, profile.durationS);
    expect(walked.start.speed).toBe(from);
    expect(walked.start.acceleration).toBe(0);
    expect(walked.end.speed).toBeCloseTo(to, 9);
    expect(walked.end.acceleration).toBeCloseTo(0, 2);
    expect(walked.largestAcceleration).toBeLessThanOrEqual(acceleration + 1e-9);
    expect(walked.largestJerk).toBeLessThanOrEqual(jerk * 1.001);
    // Speed is the integral of acceleration, and distance of speed.
    expect(from + walked.accelerationIntegral).toBeCloseTo(to, 4);
    expect(walked.end.distance).toBeCloseTo(walked.speedIntegral, 4);
    expect(profile.distance).toBeCloseTo(walked.end.distance, 9);
    // It never passes either end: the speed moves one way only.
    expect(walked.largestSpeed).toBeLessThanOrEqual(Math.max(from, to) + 1e-9);
    expect(walked.smallestSpeed).toBeGreaterThanOrEqual(Math.min(from, to) - 1e-9);
  });
  test('takes the change over the limit, plus one jerk ramp, when it reaches the limit', () => {
    // 6 m/s at 1.5 m/s² is 4 s; acceleration grows over 0.3 s and falls over 0.3 s, which adds 0.3 s in all.
    expect(speedChange(2, 8, 1.5, 5).durationS).toBeCloseTo(4.3, 12);
    // 0.1 m/s cannot reach 1 m/s²: the peak is √(0.1·5) = 0.707 m/s² and it rises and falls in 2·0.1414 s.
    expect(speedChange(0, 0.1, 1, 5).durationS).toBeCloseTo(2 * Math.sqrt(0.1 / 5), 12);
  });
  test('continues at the final speed after its end', () => {
    const profile = speedChange(2, 8, 1.5, 5), after = profile.sample(profile.durationS + 2);
    expect(after).toEqual({ acceleration: 0, speed: 8, distance: profile.distance + 16 });
  });
  test('no change takes no time', () => {
    const profile = speedChange(4, 4, 1.5, 5);
    expect(profile.durationS).toBe(0);
    expect(profile.sample(1)).toEqual({ acceleration: 0, speed: 4, distance: 4 });
  });
  test('an infinite jerk gives sharp acceleration corners and stays finite', () => {
    const profile = speedChange(0, 10, 5, Infinity);
    expect(profile.durationS).toBe(2);
    expect(profile.sample(0.5)).toEqual({ acceleration: 5, speed: 2.5, distance: 0.625 });
    expect(profile.sample(2).speed).toBe(10);
  });
  test('an infinite acceleration changes at once', () => {
    const profile = speedChange(0, 10, Infinity, Infinity);
    expect(profile.durationS).toBe(0);
    expect(profile.sample(1)).toEqual({ acceleration: 0, speed: 10, distance: 10 });
  });
  test('refuses a limit that is not above zero', () => {
    expect(() => speedChange(0, 1, 0, 5)).toThrow('acceleration limit');
    expect(() => speedChange(0, 1, 1, -1)).toThrow('jerk limit');
    expect(() => speedChange(0, Number.NaN, 1, 5)).toThrow('finite');
  });
});

describe('a move from rest to rest', () => {
  // [distance, cruise speed, acceleration limit, jerk limit]: long, too short to reach the speed, too short to reach the limit.
  test.each([[10, 2, 1, 5], [10, 1, 1, 5], [2, 2, 1, 5], [0.05, 2, 1, 5], [50, 5, 2, 5], [90, 15, 270, Infinity], [1, 90, 270, Infinity], [0.001, 5, 1, 5]])('%d at %d, limit %d, jerk %d', (distance, speed, acceleration, jerk) => {
    const profile = restToRest(distance, speed, acceleration, jerk);
    const walked = walk(profile, profile.durationS);
    expect(walked.start.speed).toBe(0);
    expect(walked.end.speed).toBeCloseTo(0, 6);
    expect(walked.end.distance).toBeCloseTo(distance, 9);
    expect(walked.speedIntegral).toBeCloseTo(distance, 2);
    expect(walked.largestSpeed).toBeLessThanOrEqual(speed + 1e-9);
    expect(walked.largestAcceleration).toBeLessThanOrEqual(acceleration + 1e-9);
    if (Number.isFinite(jerk)) expect(walked.largestJerk).toBeLessThanOrEqual(jerk * 1.001);
    // Never past the end.
    expect(Math.max(walked.end.distance, profile.sample(profile.durationS + 5).distance)).toBeCloseTo(distance, 9);
  });
  test('a climb of 10 m at 2 m/s with ArduCopter\'s default limits', () => {
    const profile = restToRest(10, 2, 1, 5);
    // 2 m/s at 1 m/s² with 5 m/s³ takes 2.2 s and covers 2.2 m, each way, leaving 5.6 m at 2 m/s.
    expect(profile.durationS).toBeCloseTo(2.2 + 2.8 + 2.2, 12);
    expect(profile.sample(3.6).speed).toBe(2);
    expect(profile.sample(3.6).acceleration).toBe(0);
    expect(profile.sample(3.6).distance).toBeCloseTo(5, 12);
  });
  test('a move too short for its speed peaks lower and still arrives', () => {
    const profile = restToRest(1, 2, 1, 5);
    expect(profile.sample(profile.durationS / 2).speed).toBeLessThan(2);
    expect(profile.sample(profile.durationS).distance).toBe(1);
  });
  test('no distance takes no time', () => {
    expect(restToRest(0, 2, 1, 5).durationS).toBe(0);
    expect(restToRest(0, 2, 1, 5).sample(3)).toEqual({ acceleration: 0, speed: 0, distance: 0 });
  });
  test('an infinite acceleration cruises the whole way', () => {
    const profile = restToRest(10, 2, Infinity, Infinity);
    expect(profile.durationS).toBe(5);
    expect(profile.sample(2).distance).toBe(4);
  });
  test('refuses a speed that is not above zero, or a negative distance', () => {
    expect(() => restToRest(1, 0, 1, 5)).toThrow('speed');
    expect(() => restToRest(-1, 1, 1, 5)).toThrow('distance');
  });
});
