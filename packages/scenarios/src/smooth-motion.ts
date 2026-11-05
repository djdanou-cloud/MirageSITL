// Smooth motion for flight tasks (TASK-172). A target whose speed changes in one
// step is a target no aircraft can follow: ArduCopter limits how hard it corrects
// (WP_ACC_Z, 1 m/s² by default, for height), so it falls behind, flies faster than
// asked to catch up, and then cannot stop in time. These profiles change speed
// within an acceleration limit and a jerk limit, so position, speed and
// acceleration agree at every moment and ArduPilot needs no correction to follow.
//
// The unit is the caller's: metres for a height or a distance, degrees for a
// heading. `Infinity` is a valid jerk (a speed change with sharp acceleration
// corners, which a heading can follow) and a valid acceleration (no ramp at all).
// Pure and cold: FlightTaskRunner calls these a few times per second of simulated
// time on the main thread, never inside the physics step.

/** One moment of a profile: acceleration and speed at that moment, and the distance covered since its start. */
export interface MotionSample { readonly acceleration: number; readonly speed: number; readonly distance: number }
export interface MotionProfile {
  /** When the change ends; a sample after it continues at the final speed. */
  readonly durationS: number;
  /** The distance covered by that time. */
  readonly distance: number;
  sample(timeS: number): MotionSample;
}

function requirePositive(value: number, what: string): void {
  if (!(value > 0)) throw new Error(`The ${what} must be above 0, not ${String(value)}`);
}

/** Changes speed from one value to another, in the jerk limit's S-shape; the distance is what that takes. */
export function speedChange(from: number, to: number, acceleration: number, jerk: number): MotionProfile {
  requirePositive(acceleration, 'acceleration limit');
  requirePositive(jerk, 'jerk limit');
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('A speed change needs finite speeds');
  const change = Math.abs(to - from), sign = Math.sign(to - from);
  // How long acceleration grows (and later falls), and how long it holds its peak between.
  let peak = 0, jerkS = 0, holdS = 0;
  if (change > 0 && Number.isFinite(acceleration)) {
    const reachesLimit = jerk === Number.POSITIVE_INFINITY || change >= acceleration * acceleration / jerk;
    peak = reachesLimit ? acceleration : Math.sqrt(change * jerk);
    jerkS = peak / jerk;
    holdS = reachesLimit ? change / acceleration - jerkS : 0;
  }
  const durationS = 2 * jerkS + holdS, distance = (from + to) / 2 * durationS;
  const signedPeak = sign * peak, speedAfterRise = from + signedPeak * jerkS / 2, distanceAfterRise = from * jerkS + signedPeak * jerkS * jerkS / 6;
  return {
    durationS, distance,
    sample(timeS) {
      if (timeS >= durationS) return { acceleration: 0, speed: to, distance: distance + to * (timeS - durationS) };
      if (timeS <= 0) return { acceleration: 0, speed: from, distance: 0 };
      if (timeS < jerkS) {
        const share = timeS / jerkS;
        return { acceleration: signedPeak * share, speed: from + signedPeak * timeS * share / 2, distance: from * timeS + signedPeak * timeS * timeS * share / 6 };
      }
      if (timeS <= jerkS + holdS) {
        const held = timeS - jerkS;
        return { acceleration: signedPeak, speed: speedAfterRise + signedPeak * held, distance: distanceAfterRise + speedAfterRise * held + signedPeak * held * held / 2 };
      }
      const left = durationS - timeS, share = left / jerkS;
      return { acceleration: signedPeak * share, speed: to - signedPeak * left * share / 2, distance: distance - to * left + signedPeak * left * left * share / 6 };
    },
  };
}

/** The speed at which accelerating from rest and braking back to rest cover exactly `distance`, with no cruise between. */
function peakSpeedOf(distance: number, acceleration: number, jerk: number): number {
  if (jerk === Number.POSITIVE_INFINITY) return Math.sqrt(distance * acceleration);
  const jerkS = acceleration / jerk;
  // Reaches the acceleration limit on the way: v²/a + v·a/j = distance.
  const reaching = acceleration / 2 * (Math.sqrt(jerkS * jerkS + 4 * distance / acceleration) - jerkS);
  if (reaching >= acceleration * jerkS) return reaching;
  // Does not: 2·v^(3/2)/√j = distance.
  return Math.pow(distance * Math.sqrt(jerk) / 2, 2 / 3);
}

/** Starts at rest, reaches `speed` if the distance allows, and stops at rest exactly at `distance`; a short move peaks lower. */
export function restToRest(distance: number, speed: number, acceleration: number, jerk: number): MotionProfile {
  requirePositive(speed, 'speed');
  if (!(distance >= 0)) throw new Error(`The distance must not be negative, not ${String(distance)}`);
  if (distance === 0) return { durationS: 0, distance: 0, sample: () => ({ acceleration: 0, speed: 0, distance: 0 }) };
  const full = speedChange(0, speed, acceleration, jerk);
  const peak = 2 * full.distance <= distance ? speed : peakSpeedOf(distance, acceleration, jerk);
  const rise = peak === speed ? full : speedChange(0, peak, acceleration, jerk), fall = speedChange(peak, 0, acceleration, jerk);
  const cruiseS = Math.max(0, distance - 2 * rise.distance) / peak, cruiseEndS = rise.durationS + cruiseS, durationS = cruiseEndS + fall.durationS;
  return {
    durationS, distance,
    sample(timeS) {
      if (timeS >= durationS) return { acceleration: 0, speed: 0, distance };
      if (timeS <= rise.durationS) return rise.sample(timeS);
      if (timeS <= cruiseEndS) return { acceleration: 0, speed: peak, distance: rise.distance + peak * (timeS - rise.durationS) };
      const falling = fall.sample(timeS - cruiseEndS);
      return { acceleration: falling.acceleration, speed: falling.speed, distance: distance - fall.distance + falling.distance };
    },
  };
}
