// TASK-157: the motor check's judgement and command. Oracles: the TASK-128
// frame catalog through frameConfiguration (test order and yaw factor per
// motor; ArduPilot's quad X tests motors 1, 4, 2, 3 and turns motors 1 and 2
// counter-clockwise), MAV_CMD_DO_MOTOR_TEST of common.xml (209; param1 motor
// instance, param2 throttle type 1 = PWM, param3 value, param4 timeout,
// param5 count) decoded by the TASK-150 codec, and hand-made speed traces.
import { describe, expect, test } from 'vitest';
import { frameConfiguration } from '@mirage/aircraft/frame-parameters';
import { GroundStation } from '@mirage/autopilot/ground-station';
import { expectedMotors, MOTOR_TEST_PWM_US, MOTOR_TEST_TIMEOUT_S, MotorCheck, physicsRotors, TURNING_RPM, type PhysicsRotor } from '@mirage/autopilot/motor-test';
import { MavParser, type MavFrame } from '@mirage/mavlink/codec';
import { fieldOf, readNumber } from '@mirage/mavlink/messages';
import { quadProfile } from './support/quad-profile.ts';

const QUAD: PhysicsRotor[] = [{ motorId: 1, output: 1, spin: 'ccw' }, { motorId: 2, output: 2, spin: 'ccw' }, { motorId: 3, output: 3, spin: 'cw' },
  { motorId: 4, output: 4, spin: 'cw' }];

/** Runs the check at 10 Hz of simulated time; `speeds(testOrder)` gives each rotor's speed while that test spins. */
function drive(check: MotorCheck, speeds: (testOrder: number) => readonly number[], ack: (testOrder: number) => number = () => 0): string[] {
  const sent: string[] = [];
  let t = 0, current = 0, ackAt = Number.NaN;
  for (let tick = 0; tick < 2000 && !check.done; tick++, t += 0.1) {
    const spinning = !Number.isNaN(ackAt) && t - ackAt <= MOTOR_TEST_TIMEOUT_S;
    const action = check.observe(t, spinning ? speeds(current) : [0, 0, 0, 0]);
    if (action.kind === 'command') {
      sent.push(`${action.testOrder}@${action.pwmUs}/${action.timeoutS}`);
      current = action.testOrder;
      check.ack(ack(current), t + 0.05);
      ackAt = t + 0.05;
    }
  }
  return sent;
}
const only = (motorIndex: number, rpm = 2000) => [0, 1, 2, 3].map(i => (i === motorIndex ? rpm : 0));

describe('the expectation', () => {
  test('follows the frame catalog: test order, output and yaw-factor spin', async () => {
    const { profile, derived } = await quadProfile();
    const frame = frameConfiguration(profile);
    if (!frame.ok) throw new Error('No frame');
    expect(expectedMotors(frame.motors).map(m => [m.testOrder, m.motorId, m.output, m.spin])).toEqual([
      [1, 1, 1, 'ccw'], [2, 4, 4, 'cw'], [3, 2, 2, 'ccw'], [4, 3, 3, 'cw']]);
    expect(physicsRotors(derived.manifest.rotors)).toEqual(QUAD);
  });
});

describe('the judgement', () => {
  const expected = [{ testOrder: 1, motorId: 1, output: 1, spin: 'ccw' as const }, { testOrder: 2, motorId: 4, output: 4, spin: 'cw' as const }];

  test('passes when exactly the expected rotor turns, and commands each motor in test order at 1150 us for 1.5 s', () => {
    const check = new MotorCheck(expected, QUAD);
    const sent = drive(check, order => only(order === 1 ? 0 : 3));
    expect(sent).toEqual([`1@${MOTOR_TEST_PWM_US}/1.5`, `2@${MOTOR_TEST_PWM_US}/1.5`]);
    expect(check.passed).toBe(true);
    expect(check.results.map(r => r.reason)).toEqual(['Motor 1 turned counter-clockwise on output 1', 'Motor 4 turned clockwise on output 4']);
  });

  test('names a missing, a shared, a swapped and a reversed motor', () => {
    const none = new MotorCheck(expected, QUAD);
    drive(none, () => [0, 0, TURNING_RPM - 1, 0]);
    expect(none.results[0]?.reason).toBe('No motor turned when ArduPilot tested its motor 1 on output 1');
    const shared = new MotorCheck(expected, QUAD);
    drive(shared, () => [2000, 1500, 0, 0]);
    expect(shared.results[0]).toMatchObject({ pass: false, observed: null, turned: [1, 2], reason: 'Motors 1, 2 turned together when ArduPilot tested output 1' });
    // A slower second rotor below half the peak is drag, not a second motor.
    const drag = new MotorCheck(expected, QUAD);
    drive(drag, order => (order === 1 ? [2000, 900, 0, 0] : only(3)));
    expect(drag.passed).toBe(true);
    const swapped = new MotorCheck(expected, [{ motorId: 1, output: 2, spin: 'ccw' }, { motorId: 2, output: 1, spin: 'ccw' }, ...QUAD.slice(2)]);
    drive(swapped, order => only(order === 1 ? 1 : 3));
    expect(swapped.results[0]?.reason).toBe('Output 1 should turn motor 1, but motor 2 turned: the motor mapping is swapped');
    const reversed = new MotorCheck(expected, [{ motorId: 1, output: 1, spin: 'cw' }, ...QUAD.slice(1)]);
    drive(reversed, order => only(order === 1 ? 0 : 3));
    expect(reversed.results[0]?.reason).toBe('Motor 1 turns clockwise in the model, but ArduPilot\'s frame expects counter-clockwise: the spin is reversed');
    expect([none.passed, shared.passed, swapped.passed, reversed.passed]).toEqual([false, false, false, false]);
  });

  test('stops on a refusal or a missing acknowledgement, and never judges before the acknowledgement', () => {
    const refused = new MotorCheck(expected, QUAD);
    drive(refused, () => only(0), () => 4);
    expect([refused.done, refused.passed, refused.results.length, refused.stoppedReason]).toEqual([true, false, 0, 'ArduPilot refused the motor test (MAV_RESULT 4)']);
    const silent = new MotorCheck(expected, QUAD);
    expect(silent.observe(0, only(0))).toMatchObject({ kind: 'command', testOrder: 1 });
    for (let t = 0.1; t <= 3.2; t += 0.1) silent.observe(t, only(0));
    expect(silent.stoppedReason).toBe('ArduPilot did not acknowledge the motor test of motor 1 within 3 s');
    expect(() => new MotorCheck([], QUAD)).toThrow('The frame has no motors to test');
  });
});

test('the ground station encodes MAV_CMD_DO_MOTOR_TEST with a PWM throttle and refuses values out of range', () => {
  const gcs = new GroundStation(), out = new Uint8Array(64);
  const frames: MavFrame[] = [];
  const parser = new MavParser(frame => { frames.push({ ...frame, payload: frame.payload.slice(), view: new DataView(frame.payload.slice().buffer) }); });
  parser.push(out.slice(0, gcs.motorTestInto(3, 1150, 1.5, out)));
  const frame = frames[0];
  if (!frame) throw new Error('No frame');
  const value = (name: string) => readNumber(frame.view, fieldOf(76, name) ?? (() => { throw new Error(name); })());
  expect([value('command'), value('param1'), value('param2'), value('param3'), value('param4'), value('param5'), value('target_system')])
    .toEqual([209, 3, 1, 1150, 1.5, 1, 1]);
  expect([gcs.motorTestInto(0, 1150, 1.5, out), gcs.motorTestInto(33, 1150, 1.5, out), gcs.motorTestInto(1, 999, 1.5, out), gcs.motorTestInto(1, 1150, 11, out)])
    .toEqual([0, 0, 0, 0]);
});
