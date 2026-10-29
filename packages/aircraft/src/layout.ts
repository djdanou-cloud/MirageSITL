import type { AircraftProfile, ArmSpec, MotorLevel } from './profile.ts';
import { sinCos, tan } from './trig.ts';

// Rotor layout of an aircraft profile (TASK-138): where each rotor is, where it
// thrusts and which way it turns. Configuration-time code only. It uses the
// engine-independent trigonometry of trig.ts and otherwise only arithmetic and
// Math.sqrt, so every engine computes the same bits.
//
// For an arm with length L, azimuth a, height h and tilts α (outward) and
// β (side), with radial r = (cos a, sin a, 0), across e = (-sin a, cos a, 0)
// and body up u = (0, 0, -1), all in body FRD:
//   mount        m = (L cos a, L sin a, -h)
//   thrust axis  t = (tan α·r + tan β·e + u) / |tan α·r + tan β·e + u|
// so α and β are the angles between u and t's projections onto the arm's
// vertical plane and the vertical plane across it. A single rotor sits at m; a
// coaxial pair at m ± (s/2)·t, the upper rotor on the thrust side.

export interface RotorLayout {
  readonly motorId: number;
  readonly armId: number;
  readonly level: MotorLevel;
  readonly output: number;
  /** Rotor hub centre, body FRD metres from the reference point. */
  readonly hubPositionBodyM: readonly number[];
  /** Unit direction of the thrust on the body, body FRD. */
  readonly thrustAxisBody: readonly number[];
  /**
   * Hub-to-body rotation (wxyz): the shortest rotation from body up to the
   * thrust axis applied after a half turn about body x, so hub +z is the thrust
   * axis and an untilted rotor has (0, 1, 0, 0). The x component is positive.
   */
  readonly hubToBody: readonly number[];
  /** +1 when the rotor turns counter-clockwise seen from its thrust side: ω = spinSign·|ω|·thrustAxis. */
  readonly spinSign: 1 | -1;
}
export interface WakePair {
  /** The upper rotor, whose slipstream reaches the lower one (TASK-101). */
  readonly upstreamMotorId: number;
  readonly downstreamMotorId: number;
}
export interface AircraftLayout {
  /** In ascending motor ID order. */
  readonly rotors: readonly RotorLayout[];
  /** One per coaxial pair, in ascending upstream motor ID order. */
  readonly wakePairs: readonly WakePair[];
}

/** Turns -0 into +0, so values and their canonical JSON agree. */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}
function mount(arm: ArmSpec): number[] {
  const { sin, cos } = sinCos(arm.azimuthRad);
  return [clean(arm.lengthM * cos), clean(arm.lengthM * sin), clean(-arm.heightM)];
}
function thrustAxis(arm: ArmSpec): number[] {
  const { sin, cos } = sinCos(arm.azimuthRad);
  const outward = tan(arm.outwardTiltRad), side = tan(arm.sideTiltRad);
  const x = outward * cos - side * sin, y = outward * sin + side * cos;
  const length = Math.sqrt(x * x + y * y + 1);
  return [clean(x / length), clean(y / length), clean(-1 / length)];
}
function hubToBody(axis: readonly number[]): number[] {
  const [x = 0, y = 0, z = 0] = axis;
  const length = Math.sqrt(x * x + y * y + (1 - z) * (1 - z));
  return [clean(-y / length), clean((1 - z) / length), 0, clean(x / length)];
}

/** Rotor positions, thrust axes, orientations, spins and wake pairs of a validated profile. */
export function deriveLayout(profile: AircraftProfile): AircraftLayout {
  const arms = new Map(profile.arms.map(arm => [arm.id, arm]));
  const rotors = profile.motors.map((motor): RotorLayout => {
    const arm = arms.get(motor.armId);
    if (!arm) throw new Error(`Motor ${motor.id} names unknown arm ${motor.armId}`);
    const centre = mount(arm), axis = thrustAxis(arm);
    const offset = motor.level === 'single' ? 0 : (motor.level === 'upper' ? 0.5 : -0.5) * (arm.pairSeparationM ?? 0);
    return {
      motorId: motor.id, armId: arm.id, level: motor.level, output: motor.output,
      hubPositionBodyM: centre.map((value, i) => clean(value + offset * axis[i]!)),
      thrustAxisBody: axis, hubToBody: hubToBody(axis), spinSign: motor.spin === 'ccw' ? 1 : -1,
    };
  });
  const wakePairs: WakePair[] = [];
  for (const upper of profile.motors) {
    if (upper.level !== 'upper') continue;
    const lower = profile.motors.find(motor => motor.armId === upper.armId && motor.level === 'lower');
    if (!lower) throw new Error(`Arm ${upper.armId} has an upper motor without a lower one`);
    wakePairs.push({ upstreamMotorId: upper.id, downstreamMotorId: lower.id });
  }
  return { rotors, wakePairs };
}
