// Virtual one-motor-at-a-time check (TASK-157, S03). Before flight,
// ArduCopter's own motor test (MAV_CMD_DO_MOTOR_TEST, ArduCopter/motor_test.cpp
// at 8ab6afde) spins each frame motor alone, in its test order
// (AP_MotorsMatrix::output_test_seq), and the physics session shows which
// rotor that actually turned. The expectation is the TASK-142 frame
// configuration of the profile: the motor with that test order, the servo
// output it is mapped to, and the spin of its ArduPilot yaw factor (positive
// is counter-clockwise, AP_MOTORS_MATRIX_YAW_FACTOR_CCW). The observation is
// the physics side as the session runs it: the rotor whose speed rose, the
// output that drives it, and its spin in the loaded model. A motor passes
// when exactly that rotor turned with that spin. Times are simulated seconds,
// so the check follows ArduPilot's clock. Cold path: one call per status.

export type Spin = 'ccw' | 'cw';
/** What the frame configuration expects of the motor ArduPilot tests at `testOrder`. */
export interface ExpectedMotor { readonly testOrder: number; readonly motorId: number; readonly output: number; readonly spin: Spin }
/** One physics rotor, in power-telemetry row order: its motor, the servo output that drives it and its spin in the model. */
export interface PhysicsRotor { readonly motorId: number; readonly output: number; readonly spin: Spin }
export interface MotorCheckResult {
  readonly testOrder: number;
  readonly expected: { readonly motorId: number; readonly output: number; readonly spin: Spin };
  /** The single rotor that turned, or null when none or several did. */
  readonly observed: { readonly motorId: number; readonly output: number; readonly spin: Spin; readonly peakRpm: number } | null;
  /** Every motor that turned during this step. */
  readonly turned: readonly number[];
  readonly pass: boolean;
  readonly reason: string;
}
export type MotorCheckAction =
  | { readonly kind: 'command'; readonly testOrder: number; readonly pwmUs: number; readonly timeoutS: number }
  | { readonly kind: 'wait' }
  | { readonly kind: 'done' };

/** The test throttle: 15 % of the 1000-2000 us range, near ArduPilot's default MOT_SPIN_ARM. */
export const MOTOR_TEST_PWM_US = 1150;
/** How long ArduPilot spins each motor, simulated seconds. */
export const MOTOR_TEST_TIMEOUT_S = 1.5;
/** Speeds are judged from this long after the acknowledgement until the end of the spin, simulated seconds. */
const OBSERVE_FROM_S = 0.5;
/** After the spin, the next motor waits this long for the last one to stop, simulated seconds. */
const SPIN_DOWN_S = 1.5;
/** An acknowledgement must arrive within this time, simulated seconds. */
const ACK_TIMEOUT_S = 3;
/** A rotor turned when its peak speed reached this, rev/min, and at least half of the step's largest peak. */
export const TURNING_RPM = 300;

/** The expectation of a frame configuration's motors (`frameConfiguration(...).motors`), in test order. */
export function expectedMotors(motors: readonly { motorId: number; output: number; testOrder: number; yawFactor: number }[]): ExpectedMotor[] {
  return [...motors].sort((a, b) => a.testOrder - b.testOrder)
    .map(motor => ({ testOrder: motor.testOrder, motorId: motor.motorId, output: motor.output, spin: motor.yawFactor > 0 ? 'ccw' : 'cw' }));
}
/** The physics rotors of the vehicle manifest the session runs, in rotor (power-telemetry) order. */
export function physicsRotors(rotors: readonly { id: number; motorChannel: number; spinSign: number }[]): PhysicsRotor[] {
  return rotors.map(rotor => ({ motorId: rotor.id, output: rotor.motorChannel + 1, spin: rotor.spinSign > 0 ? 'ccw' : 'cw' }));
}

const spinText = (spin: Spin) => (spin === 'ccw' ? 'counter-clockwise' : 'clockwise');

export class MotorCheck {
  private readonly resultsValue: MotorCheckResult[] = [];
  private index = 0;
  private sentAtS = Number.NaN;
  private ackedAtS = Number.NaN;
  private readonly peaks: Float64Array;
  private stopped: string | null = null;

  constructor(readonly expected: readonly ExpectedMotor[], readonly physics: readonly PhysicsRotor[]) {
    if (expected.length === 0) throw new Error('The frame has no motors to test');
    this.peaks = new Float64Array(physics.length);
  }

  get results(): readonly MotorCheckResult[] { return this.resultsValue; }
  /** The step being tested (0-based), equal to the motor count once done. */
  get step(): number { return this.index; }
  get done(): boolean { return this.index >= this.expected.length || this.stopped !== null; }
  /** Why the check stopped before the last motor, or null. */
  get stoppedReason(): string | null { return this.stopped; }
  get passed(): boolean { return this.done && this.stopped === null && this.resultsValue.every(result => result.pass); }

  /** ArduPilot's COMMAND_ACK for the step's command: accepted (0) starts the observation, anything else stops the check. */
  ack(result: number, simTimeS: number, statusText = ''): void {
    if (this.done || Number.isNaN(this.sentAtS) || !Number.isNaN(this.ackedAtS)) return;
    if (result !== 0) {
      this.stopped = `ArduPilot refused the motor test (MAV_RESULT ${result})${statusText ? `: ${statusText}` : ''}`;
      return;
    }
    this.ackedAtS = simTimeS;
    this.peaks.fill(0);
  }

  /** Takes the rotors' speeds (rev/min, power-telemetry rows) at `simTimeS` and says what to do next. */
  observe(simTimeS: number, rpm: ArrayLike<number>): MotorCheckAction {
    if (this.done) return { kind: 'done' };
    const step = this.expected[this.index];
    if (!step) return { kind: 'done' };
    if (Number.isNaN(this.sentAtS)) {
      this.sentAtS = simTimeS;
      return { kind: 'command', testOrder: step.testOrder, pwmUs: MOTOR_TEST_PWM_US, timeoutS: MOTOR_TEST_TIMEOUT_S };
    }
    if (Number.isNaN(this.ackedAtS)) {
      if (simTimeS - this.sentAtS > ACK_TIMEOUT_S) this.stopped = `ArduPilot did not acknowledge the motor test of motor ${step.motorId} within ${ACK_TIMEOUT_S} s`;
      return this.done ? { kind: 'done' } : { kind: 'wait' };
    }
    const since = simTimeS - this.ackedAtS;
    if (since >= OBSERVE_FROM_S && since <= MOTOR_TEST_TIMEOUT_S) {
      for (let i = 0; i < this.peaks.length; i++) {
        const value = Math.abs(Number(rpm[i] ?? 0));
        if (Number.isFinite(value) && value > (this.peaks[i] ?? 0)) this.peaks[i] = value;
      }
    }
    if (since < MOTOR_TEST_TIMEOUT_S + SPIN_DOWN_S) return { kind: 'wait' };
    this.resultsValue.push(this.judge(step));
    this.index++;
    this.sentAtS = this.ackedAtS = Number.NaN;
    return this.observe(simTimeS, rpm);
  }

  private judge(step: ExpectedMotor): MotorCheckResult {
    const expected = { motorId: step.motorId, output: step.output, spin: step.spin };
    let largest = 0;
    for (const peak of this.peaks) largest = Math.max(largest, peak);
    const turning: number[] = [];
    this.peaks.forEach((peak, i) => { if (peak >= TURNING_RPM && peak >= largest / 2) turning.push(i); });
    const turned = turning.map(i => this.physics[i]?.motorId ?? -1);
    const base = { testOrder: step.testOrder, expected, turned };
    if (turning.length === 0) {
      return { ...base, observed: null, pass: false, reason: `No motor turned when ArduPilot tested its motor ${step.testOrder} on output ${step.output}` };
    }
    if (turning.length > 1) {
      return { ...base, observed: null, pass: false, reason: `Motors ${turned.join(', ')} turned together when ArduPilot tested output ${step.output}` };
    }
    const index = turning[0] ?? 0, rotor = this.physics[index];
    if (!rotor) return { ...base, observed: null, pass: false, reason: 'The turning rotor is not in the physics model' };
    const observed = { motorId: rotor.motorId, output: rotor.output, spin: rotor.spin, peakRpm: this.peaks[index] ?? 0 };
    if (rotor.motorId !== step.motorId) {
      return { ...base, observed, pass: false,
        reason: `Output ${step.output} should turn motor ${step.motorId}, but motor ${rotor.motorId} turned: the motor mapping is swapped` };
    }
    if (rotor.spin !== step.spin) {
      return { ...base, observed, pass: false,
        reason: `Motor ${rotor.motorId} turns ${spinText(rotor.spin)} in the model, but ArduPilot's frame expects ${spinText(step.spin)}: the spin is reversed` };
    }
    return { ...base, observed, pass: true, reason: `Motor ${rotor.motorId} turned ${spinText(rotor.spin)} on output ${rotor.output}` };
  }
}
