// How much thrust a profile's rotors give at full command (TASK-177, S12): the model's own
// answer to "can it take off, and with what margin". All rotors run at full duty on the same
// rotor engine and battery as flight, in still air with the aircraft held still, until they
// settle, so the voltage sag of the whole aircraft and the current and pack limits are in it.
// The charge is held at the run's start, so this is the thrust at that charge, and it is a
// calculation, not a measurement: it carries the profile's confidence label. It reads the
// configuration and changes nothing. Cold path, not for a physics step.
//
// This solves the steady state, and there it differs from a flight on purpose. In flight the motors
// run on the bus voltage of the previous tick with no iteration, and at high demand that loop
// flips every tick between two voltages; and a pack at its current limit is flagged there while the
// motors go on drawing what they ask (docs/SPECS_SIMULATION_ENGINES.md, "Thrust at full command").
// Here the voltage moves slowly towards what the bus gives, so it settles where the motors and the
// pack agree, and at the pack's limit it falls until the motors ask for no more than the pack delivers.
import { BetBus } from '../../wasm-bet/src/bus.ts';
import { BOUND_V2, BOUND_V2_DRIVE_DOUBLES, BOUND_V2_INPUT_DOUBLES, BOUND_V2_OUTPUT_SLOTS, BetRotorEngineV2 } from '../../wasm-bet/src/rotor-v2.ts';
import type { BetFlightConfiguration } from './bet-dynamics.ts';
import { FrameLayout } from './frame.ts';
import { validateModelManifest } from './model-manifest.ts';

export interface RotorAtFullCommand {
  readonly rotorId: number;
  readonly rpm: number;
  /** Along the rotor's own axis, N. */
  readonly thrustN: number;
  readonly motorCurrentA: number;
  /** The drive clamped this motor's current. */
  readonly currentLimited: boolean;
}
export interface ThrustCapacity {
  readonly stateOfCharge: number;
  readonly densityKgM3: number;
  /** The aircraft's upward force at full command, N: along body up, so a tilted rotor counts only for what lifts. */
  readonly thrustN: number;
  readonly weightN: number;
  /** Thrust over weight. Above 1 it can lift off; the rest is its margin. */
  readonly thrustToWeight: number;
  readonly busVoltageV: number;
  readonly busCurrentA: number;
  /** The pack's current limit holds the motors back. A flight today does not do this: it flags the limit and the motors draw on. */
  readonly packLimited: boolean;
  /** What the motors draw at the terminals, summed, W. It equals what the pack delivers, the avionics load apart. */
  readonly motorPowerW: number;
  readonly rotors: readonly RotorAtFullCommand[];
}

const HZ = 800;
/** The longest it may take to settle, and how little the speeds and the voltage may change over a check to count as settled. */
const MAX_SETTLE_S = 8, CHECK_EVERY_S = 0.1, SETTLED_RELATIVE = 1e-6;
/** How far the voltage moves towards its target each tick: slow enough that the loop cannot flip, fast against the rotors' spin-up. */
const VOLTAGE_RELAXATION = 0.02;
const OUTPUT = { thrust: 2, omega: 9, flags: 14, motorCurrent: 19, power: 21 } as const;
const INPUT = { density: 0, viscosity: 1, sound: 2, duty: 13, busVoltage: 14 } as const;

/** Throws when the configuration has no ESC drive, or the rotors do not settle. */
export function thrustCapacity(module: WebAssembly.Module, configuration: BetFlightConfiguration): ThrustCapacity {
  const model = validateModelManifest(configuration.manifest), drive = configuration.drive;
  if (!drive) throw new Error('The thrust at full command needs an ESC drive and a battery');
  const definitions = model.rotors.map((rotor, i) => {
    const polar = configuration.polars.get(rotor.polarId), inflowTauS = configuration.inflowTauS[i], inflowLimitMps = configuration.inflowLimitMps[i];
    if (!polar || inflowTauS === undefined || inflowLimitMps === undefined) throw new Error('Missing rotor polar binding');
    return { geometry: rotor, polar, initialOmegaRadS: 0, inflowTauS, inflowLimitMps, minimumConfidence: configuration.minimumConfidence };
  });
  const engine = new BetRotorEngineV2(module, definitions, HZ), bus = new BetBus(module, drive.battery, HZ);
  try {
    drive.motors.forEach((motor, i) => {
      engine.drive.set([motor.resistanceOhm, motor.torqueConstantNmPerA, motor.currentLimitA, motor.brakeCurrentLimitA, motor.noLoadTorqueNm, motor.commandTauS, motor.updatePeriodS], i * BOUND_V2_DRIVE_DOUBLES);
      engine.driveMode[i] = BOUND_V2.driveEscDuty;
      const row = i * BOUND_V2_INPUT_DOUBLES;
      engine.input[row + INPUT.density] = configuration.densityKgM3;
      engine.input[row + INPUT.viscosity] = configuration.viscosityPaS;
      engine.input[row + INPUT.sound] = configuration.soundMps;
      engine.input[row + INPUT.duty] = 1;
    });
    const soc = drive.initialStateOfCharge, house = drive.housePowerW ?? 0, count = model.rotorCount;
    const omegaAt = (i: number): number => engine.output[i * BOUND_V2_OUTPUT_SLOTS + OUTPUT.omega] ?? 0;
    let voltage = bus.openCircuitV(soc), settled = false, powerW = 0, previousVoltage = voltage;
    const previous = new Float64Array(count), checkEvery = Math.round(CHECK_EVERY_S * HZ);
    for (let tick = 1; tick <= MAX_SETTLE_S * HZ && !settled; tick++) {
      powerW = 0;
      for (let i = 0; i < count; i++) engine.input[i * BOUND_V2_INPUT_DOUBLES + INPUT.busVoltage] = voltage;
      if (!engine.stepInto()) throw new Error(`The rotors failed at full command: status ${engine.lastStatus}`);
      for (let i = 0; i < count; i++) powerW += engine.output[i * BOUND_V2_OUTPUT_SLOTS + OUTPUT.power] ?? 0;
      // The charge stays where the run starts: this asks what the aircraft gives at that charge, not while it drains.
      if (!bus.stepInto(soc, powerW, house)) throw new Error(`The battery bus failed at full command: status ${bus.lastStatus}`);
      const packVoltage = bus.output[1] ?? voltage, packCurrent = bus.output[2] ?? 0, demand = powerW + house;
      // Limited: what the pack delivers over what is asked of it scales the voltage down, until they are equal.
      const target = ((bus.output[6] ?? 0) & 1) !== 0 && demand > 0 ? voltage * (packVoltage * packCurrent) / demand : packVoltage;
      voltage += VOLTAGE_RELAXATION * (target - voltage);
      if (tick % checkEvery === 0) {
        settled = Math.abs(voltage - previousVoltage) <= SETTLED_RELATIVE * voltage;
        previousVoltage = voltage;
        for (let i = 0; i < count; i++) {
          if (Math.abs(omegaAt(i) - (previous[i] ?? 0)) > SETTLED_RELATIVE * Math.max(omegaAt(i), 1)) settled = false;
          previous[i] = omegaAt(i);
        }
      }
    }
    if (!settled) throw new Error(`The rotors did not settle at full command within ${MAX_SETTLE_S} s`);
    const hub = new Float64Array(count * 6), wrench = new Float64Array(6), layout = new FrameLayout(model);
    const rotors: RotorAtFullCommand[] = [];
    for (let i = 0; i < count; i++) {
      const at = i * BOUND_V2_OUTPUT_SLOTS, read = (slot: number): number => engine.output[at + slot] ?? 0;
      for (let j = 0; j < 3; j++) { hub[i * 6 + j] = read(j); hub[i * 6 + 3 + j] = read(6 + j); }
      const rotor = model.rotors[i];
      if (!rotor) throw new Error('Missing rotor');
      rotors.push({ rotorId: rotor.id, rpm: omegaAt(i) * 60 / (2 * Math.PI), thrustN: read(OUTPUT.thrust), motorCurrentA: read(OUTPUT.motorCurrent), currentLimited: (read(OUTPUT.flags) & BOUND_V2.flagCurrentLimited) !== 0 });
    }
    if (!layout.sumInto(hub, wrench)) throw new Error('The rotors\' wrench could not be summed');
    const weightN = model.massKg * (configuration.gravityMps2 ?? 9.80665), thrustN = -(wrench[2] ?? 0);
    return {
      stateOfCharge: soc, densityKgM3: configuration.densityKgM3, thrustN, weightN, thrustToWeight: thrustN / weightN, busVoltageV: bus.output[1] ?? voltage, busCurrentA: bus.output[2] ?? 0,
      packLimited: ((bus.output[6] ?? 0) & 1) !== 0, motorPowerW: powerW, rotors,
    };
  } finally {
    engine.dispose();
  }
}
