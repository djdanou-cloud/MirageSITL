import { BOUND_V2, BetRotorEngineV2 } from '../../wasm-bet/src/rotor-v2.ts';
import type { BoundRotorDefinition } from '../../wasm-bet/src/rotor.ts';
import type { EscDriveConfiguration, EscDriveMotor } from './bet-dynamics.ts';
import { motorTorqueConstantNmPerA, validateVehicleManifest, type VehicleManifest } from './vehicle-manifest.ts';

// The production drive of a vehicle manifest (TASK-092) and ArduPilot's thrust
// curve fitted to it. Configuration-time code only; never call from a step.

/**
 * MOT_SPIN_MIN and MOT_SPIN_MAX defaults of the pinned AP_MotorsMulticopter.h
 * (AP_MOTORS_SPIN_MIN_DEFAULT, AP_MOTORS_SPIN_MAX_DEFAULT). The parameter
 * profile does not set them, so these are the values the autopilot uses.
 */
export const ARDUPILOT_SPIN_RANGE = Object.freeze({ min: 0.15, max: 0.95 });

/**
 * The ESC drive of a validated manifest, one motor per rotor in rotor order.
 * k_t = k_e = 60/(2π·KV), the no-load torque is k_t·I₀ and the update period
 * is 1/updateRateHz. Every motor needs `noLoadCurrentA` and every ESC
 * `updateRateHz` and `brakeCurrentLimitA`, and the vehicle a battery; a
 * missing value throws, so nothing is defaulted.
 */
export function escDriveFromManifest(input: VehicleManifest, initialStateOfCharge: number, housePowerW = 0): EscDriveConfiguration {
  const manifest = validateVehicleManifest(input);
  if (!manifest.battery) throw new Error('The ESC drive needs a battery');
  if (!Number.isFinite(initialStateOfCharge) || initialStateOfCharge <= 0 || initialStateOfCharge > 1) throw new Error('Invalid initial state of charge');
  if (!Number.isFinite(housePowerW) || housePowerW < 0) throw new Error('Invalid house power');
  const motors = manifest.rotors.map((rotor): EscDriveMotor => {
    const motor = manifest.motors.find(item => item.rotorId === rotor.id);
    if (!motor) throw new Error(`Rotor ${rotor.id} has no motor`);
    const esc = manifest.escs.find(item => item.motorId === motor.id);
    if (!esc) throw new Error(`Motor ${motor.id} has no ESC`);
    if (motor.noLoadCurrentA === undefined) throw new Error(`Motor ${motor.id} lacks noLoadCurrentA`);
    if (esc.updateRateHz === undefined) throw new Error(`ESC ${esc.id} lacks updateRateHz`);
    if (esc.brakeCurrentLimitA === undefined) throw new Error(`ESC ${esc.id} lacks brakeCurrentLimitA`);
    const kt = motorTorqueConstantNmPerA(motor.kvRpmPerV);
    return Object.freeze({
      resistanceOhm: motor.resistanceOhm, torqueConstantNmPerA: kt, currentLimitA: motor.currentLimitA,
      brakeCurrentLimitA: esc.brakeCurrentLimitA, noLoadTorqueNm: kt * motor.noLoadCurrentA,
      commandTauS: esc.commandTauS, updatePeriodS: 1 / esc.updateRateHz,
    });
  });
  return Object.freeze({ motors: Object.freeze(motors), battery: manifest.battery, initialStateOfCharge, housePowerW });
}

export interface ThrustExpoFit {
  /** Least-squares e of T/T_max = (1 − e)·a + e·a². */
  readonly expo: number;
  /** Root-mean-square residual of the normalized thrust. */
  readonly rmsResidual: number;
}

/**
 * Fits ArduPilot's thrust curve (Thrust_Linearization): the thrust fraction
 * y = (1 − e)·a + e·a² at actuator a ∈ [0, 1], which the autopilot maps to
 * MOT_SPIN_MIN + (MOT_SPIN_MAX − MOT_SPIN_MIN)·a. The residual y − a is
 * e·(a² − a), so e = Σ(y − a)(a² − a) / Σ(a² − a)². The result is not
 * clamped: an e outside [−1, 1] throws, because that is MOT_THST_EXPO's range
 * in the pinned source.
 */
export function fitThrustExpo(actuator: readonly number[], thrustFraction: readonly number[]): ThrustExpoFit {
  if (actuator.length !== thrustFraction.length || actuator.length < 3) throw new Error('A thrust fit needs at least three paired samples');
  let numerator = 0, denominator = 0;
  for (let i = 0; i < actuator.length; i++) {
    const a = actuator[i]!, y = thrustFraction[i]!;
    if (!Number.isFinite(a) || !Number.isFinite(y) || a < 0 || a > 1) throw new Error('Thrust samples must be finite with actuator in [0, 1]');
    const basis = a * a - a;
    numerator += (y - a) * basis; denominator += basis * basis;
  }
  if (!(denominator > 0)) throw new Error('A thrust fit needs actuator samples inside (0, 1)');
  const expo = numerator / denominator;
  if (expo < -1 || expo > 1) throw new Error(`Fitted thrust expo ${expo} is outside MOT_THST_EXPO's [-1, 1]`);
  let squares = 0;
  for (let i = 0; i < actuator.length; i++) {
    const a = actuator[i]!, residual = thrustFraction[i]! - ((1 - expo) * a + expo * a * a);
    squares += residual * residual;
  }
  return Object.freeze({ expo, rmsResidual: Math.sqrt(squares / actuator.length) });
}

export interface StaticThrustSweep {
  readonly module: WebAssembly.Module;
  readonly rotor: BoundRotorDefinition;
  readonly motor: EscDriveMotor;
  /** A stiff supply, as on a thrust stand. */
  readonly busVoltageV: number;
  readonly densityKgM3: number; readonly viscosityPaS: number; readonly soundMps: number;
  /** Ascending ESC duties in [0, 1]. */
  readonly duties: readonly number[];
  readonly hz?: 400 | 800 | 1200 | 4800;
  /** Settling time per duty; defaults to 4 s. */
  readonly settleS?: number;
}
export interface StaticThrustPoint { readonly duty: number; readonly thrustN: number; readonly omegaRadS: number; readonly currentA: number }

/**
 * Static thrust of one rotor in still air on the ESC drive at each duty:
 * the rotor runs for `settleS` per duty, and the axial hub force (+z_h is the
 * thrust axis) is read once the speed changes by less than 1e-9 of itself
 * per step. A duty that does not settle throws.
 */
export function staticThrustSweep(sweep: StaticThrustSweep): StaticThrustPoint[] {
  const hz = sweep.hz ?? 800, steps = Math.round((sweep.settleS ?? 4) * hz);
  for (let i = 0; i < sweep.duties.length; i++) {
    const d = sweep.duties[i]!;
    if (!Number.isFinite(d) || d < 0 || d > 1 || (i > 0 && d <= sweep.duties[i - 1]!)) throw new Error('Sweep duties must ascend within [0, 1]');
  }
  if (!Number.isFinite(sweep.busVoltageV) || sweep.busVoltageV <= 0) throw new Error('Invalid sweep voltage');
  const engine = new BetRotorEngineV2(sweep.module, [sweep.rotor], hz);
  try {
    const m = sweep.motor;
    engine.drive.set([m.resistanceOhm, m.torqueConstantNmPerA, m.currentLimitA, m.brakeCurrentLimitA, m.noLoadTorqueNm,
      m.commandTauS, m.updatePeriodS], 0);
    engine.driveMode[0] = BOUND_V2.driveEscDuty;
    // Input row: density, viscosity and sound speed at 0..2, esc_duty at 13 and bus_voltage at 14.
    const input = engine.input, output = engine.output;
    input[0] = sweep.densityKgM3; input[1] = sweep.viscosityPaS; input[2] = sweep.soundMps; input[14] = sweep.busVoltageV;
    const points: StaticThrustPoint[] = [];
    for (const duty of sweep.duties) {
      input[13] = duty;
      let previous = output[9]!, change = Infinity;
      for (let n = 0; n < steps; n++) {
        if (!engine.stepInto()) throw new Error(`Rotor step failed with status ${engine.lastStatus}`);
        change = Math.abs(output[9]! - previous); previous = output[9]!;
      }
      if (change > 1e-9 * Math.max(Math.abs(previous), 1)) throw new Error(`Duty ${duty} did not settle`);
      // Output slot 19 is motor_current (record byte 144).
      points.push(Object.freeze({ duty, thrustN: output[2]!, omegaRadS: output[9]!, currentA: output[19]! }));
    }
    return points;
  } finally {
    engine.dispose();
  }
}

/**
 * MOT_THST_EXPO of a drive: a static sweep over actuator a at the pinned
 * MOT_SPIN_MIN/MAX defaults, normalized by the thrust at MOT_SPIN_MAX, then
 * `fitThrustExpo`. Run it at MOT_BAT_VOLT_MAX, where ArduPilot's voltage
 * scaling is 1.
 */
export function thrustExpoOfDrive(sweep: Omit<StaticThrustSweep, 'duties'>, samples = 17): ThrustExpoFit & { readonly points: readonly StaticThrustPoint[] } {
  if (!Number.isInteger(samples) || samples < 3) throw new Error('A thrust fit needs at least three samples');
  const actuator = Array.from({ length: samples }, (_, i) => i / (samples - 1));
  const duties = actuator.map(a => ARDUPILOT_SPIN_RANGE.min + (ARDUPILOT_SPIN_RANGE.max - ARDUPILOT_SPIN_RANGE.min) * a);
  const points = staticThrustSweep({ ...sweep, duties });
  const maximum = points[points.length - 1]!.thrustN;
  if (!(maximum > 0)) throw new Error('The rotor gives no thrust at MOT_SPIN_MAX');
  const fit = fitThrustExpo(actuator, points.map(p => p.thrustN / maximum));
  return Object.freeze({ ...fit, points: Object.freeze(points) });
}
