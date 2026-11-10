// How much thrust a profile's rotors give at full command (TASK-177, S12): the model's own
// answer to "can it take off, and with what margin". All rotors run at full duty on the same
// rotor engine and battery as flight, in still air with the aircraft held still, until they
// settle, so the voltage sag of the whole aircraft and the current and pack limits are in it.
// The charge is held at the run's start, so this is the thrust at that charge, and it is a
// calculation, not a measurement: it carries the profile's confidence label. It reads the
// configuration and changes nothing. Cold path, not for a physics step.
//
// The rotors and the pack are solved together each tick as in a flight (TASK-197), so a flight at full
// command settles on this thrust; a pack at its limit holds the motors back in both.
import { BetBus } from '../../wasm-bet/src/bus.ts';
import { BOUND_V2, BOUND_V2_DRIVE_DOUBLES, BOUND_V2_INPUT_DOUBLES, BOUND_V2_OUTPUT_SLOTS, BetRotorEngineV2 } from '../../wasm-bet/src/rotor-v2.ts';
import type { BetFlightConfiguration } from './bet-dynamics.ts';
import { FrameLayout } from './frame.ts';
import { validateModelManifest } from './model-manifest.ts';
import { RotorWakeCoupler } from './rotor-wake.ts';

/** The record's `external_wake_hub`, in doubles (byte 136). */
const INPUT_WAKE = 15;
/** Hub to body quaternions (w x y z) as row-major rotations. */
function rotationsOf(quaternions: readonly (readonly number[])[]): Float64Array {
  return Float64Array.from(quaternions.flatMap(q => {
    const norm = Math.hypot(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 0), w = (q[0] ?? 0) / norm, x = (q[1] ?? 0) / norm, y = (q[2] ?? 0) / norm, z = (q[3] ?? 0) / norm;
    return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  }));
}
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
  /** The aircraft's upward force at full command, N: along body up, so a tilted rotor counts only for what lifts, and net of its download. */
  readonly thrustN: number;
  /** TASK-101: what the rotors' wakes push down on the airframe, summed along their own axes, N. */
  readonly airframeDownloadN: number;
  readonly weightN: number;
  /** Thrust over weight. Above 1 it can lift off; the rest is its margin. */
  readonly thrustToWeight: number;
  readonly busVoltageV: number;
  readonly busCurrentA: number;
  /** The pack's current limit holds the motors back. */
  readonly packLimited: boolean;
  /** What the motors draw at the terminals, summed, W. It equals what the pack delivers, the avionics load apart. */
  readonly motorPowerW: number;
  readonly rotors: readonly RotorAtFullCommand[];
}

const HZ = 800;
/** The longest it may take to settle, and how little the speeds and the voltage may change over a check to count as settled. */
const MAX_SETTLE_S = 8, CHECK_EVERY_S = 0.1, SETTLED_RELATIVE = 1e-6;
const OUTPUT = { thrust: 2, omega: 9, induced: 12, flags: 14, motorCurrent: 19, power: 21 } as const;
const INPUT = { density: 0, viscosity: 1, sound: 2, duty: 13, busVoltage: 14 } as const;

/** Throws when the configuration has no ESC drive, or the rotors do not settle. */
export function thrustCapacity(module: WebAssembly.Module, configuration: BetFlightConfiguration): ThrustCapacity {
  const model = validateModelManifest(configuration.manifest), drive = configuration.drive;
  if (!drive) throw new Error('The thrust at full command needs an ESC drive and a battery');
  const definitions = model.rotors.map((rotor, i) => {
    const polar = configuration.polars.get(rotor.polarId), inflowTauS = configuration.inflowTauS[i], inflowLimitMps = configuration.inflowLimitMps[i];
    if (!polar || inflowTauS === undefined || inflowLimitMps === undefined) throw new Error('Missing rotor polar binding');
    return { geometry: rotor, polar, initialOmegaRadS: 0, inflowTauS, inflowLimitMps, minimumConfidence: configuration.minimumConfidence, dynamicInflow: configuration.dynamicInflow === true };
  });
  const engine = new BetRotorEngineV2(module, definitions, HZ), bus = new BetBus(module, drive.battery, HZ);
  try {
    engine.attachBattery(drive.battery);
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
    engine.busState[0] = soc; engine.busState[1] = house;
    const previous = new Float64Array(count), checkEvery = Math.round(CHECK_EVERY_S * HZ);
    // TASK-101: as in a flight, a rotor in another's wake gives less, and the airframe in a wake takes its download off the total.
    const wake = configuration.rotorWake ? new RotorWakeCoupler({
      hubPositionsBodyM: Float64Array.from(model.rotors.flatMap(rotor => [...rotor.hubPositionBodyM])), hubToBody: rotationsOf(model.rotors.map(rotor => rotor.hubToBody)),
      radiiM: Float64Array.from(model.rotors, rotor => rotor.radiusM),
    }, configuration.rotorWake) : null;
    for (let tick = 1; tick <= MAX_SETTLE_S * HZ && !settled; tick++) {
      powerW = 0;
      if (wake) {
        for (let i = 0; i < count; i++) {
          const row = i * BOUND_V2_INPUT_DOUBLES;
          for (let j = 0; j < 3; j++) wake.airHubMps[i * 3 + j] = engine.input[row + INPUT_WAKE + j] ?? 0;
          wake.densityKgM3[i] = configuration.densityKgM3;
          wake.thrustN[i] = engine.output[i * BOUND_V2_OUTPUT_SLOTS + OUTPUT.thrust] ?? 0;
          wake.inducedAxialMps[i] = engine.output[i * BOUND_V2_OUTPUT_SLOTS + OUTPUT.induced] ?? 0;
        }
        wake.step();
        for (let i = 0; i < count; i++) for (let j = 0; j < 3; j++) engine.input[i * BOUND_V2_INPUT_DOUBLES + INPUT_WAKE + j] = wake.wakeHubMps[i * 3 + j] ?? 0;
      }
      if (!engine.solveBusInto()) throw new Error(`The battery bus failed at full command: status ${engine.lastStatus}`);
      voltage = engine.busSolution[0] ?? voltage;
      for (let i = 0; i < count; i++) engine.input[i * BOUND_V2_INPUT_DOUBLES + INPUT.busVoltage] = voltage;
      if (!engine.stepInto()) throw new Error(`The rotors failed at full command: status ${engine.lastStatus}`);
      for (let i = 0; i < count; i++) powerW += engine.output[i * BOUND_V2_OUTPUT_SLOTS + OUTPUT.power] ?? 0;
      // The charge stays where the run starts: this asks what the aircraft gives at that charge, not while it drains.
      if (!bus.stepInto(soc, powerW, house)) throw new Error(`The battery bus failed at full command: status ${bus.lastStatus}`);
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
      hub[i * 6 + 2] = read(2) - (wake?.downloadN[i] ?? 0);
      const rotor = model.rotors[i];
      if (!rotor) throw new Error('Missing rotor');
      rotors.push({ rotorId: rotor.id, rpm: omegaAt(i) * 60 / (2 * Math.PI), thrustN: read(OUTPUT.thrust), motorCurrentA: read(OUTPUT.motorCurrent), currentLimited: (read(OUTPUT.flags) & BOUND_V2.flagCurrentLimited) !== 0 });
    }
    if (!layout.sumInto(hub, wrench)) throw new Error('The rotors\' wrench could not be summed');
    const weightN = model.massKg * (configuration.gravityMps2 ?? 9.80665), thrustN = -(wrench[2] ?? 0);
    return {
      stateOfCharge: soc, densityKgM3: configuration.densityKgM3, thrustN, airframeDownloadN: wake ? wake.downloadN.reduce((sum, value) => sum + value, 0) : 0, weightN, thrustToWeight: thrustN / weightN, busVoltageV: bus.output[1] ?? voltage, busCurrentA: bus.output[2] ?? 0,
      packLimited: engine.busLimited, motorPowerW: powerW, rotors,
    };
  } finally {
    engine.dispose();
  }
}
