// EW engine (TASK-058), docs/SPECS_SIMULATION_ENGINES.md section 5:
// truth -> ideal sample -> noise/bias -> EW -> quantization -> MAVLink.
//
// One preallocated instance of each effect and a bounded fault registry keyed
// by faultId. fault.set commands apply at tick boundaries (apply() is called
// before integrating that tick) without allocation; the same command log on
// the same seed yields the same observations. GPS composition order is
// baseline -> position step + drift (one WGS84 conversion of the summed NED
// offset, plus drift velocity) -> jamming (satellites, DOP, fix). The
// magnetometer anomaly changes only the magnetometer; accelerometer, gyro and
// barometer pass through. Motor faults act on physics actuators through
// MotorFaults, never on observations. Truth is never written.
import { EwFlagV2, type ScheduledCommandV2, type TickId } from "@mirage/protocol";
import type { MotorFaults } from "@mirage/physics/motor-fault";
import { copyGpsInto, validGps, type GpsSample, type ImuSample } from "../../mavlink/src/samples.ts";
import { NO_GEOID, type GeoidModel } from "@mirage/sensors/geoid";
import { GnssJamming } from "./gnss-jamming.ts";
import { MagneticAnomaly } from "./magnetic.ts";
import { GpsOffsetApplier, PositionStep } from "./position-step.ts";
import { VelocityDrift, addDriftVelocityInto } from "./velocity-drift.ts";

export type FaultCommand = Extract<ScheduledCommandV2, { type: "fault.set" }>;
type EffectKind = FaultCommand["effect"]["kind"];

/** Physics-step context; the engine only reads it. */
export interface EwContext {
  dtS: number;
  simTimeS: number;
  truthNorthM: number;
  truthEastM: number;
  truthDownM: number;
}

export const FAULT_REGISTRY_CAPACITY = 16;
/** Deceleration for hold-offset drift recovery, m/s^2 (training preset v1). */
export const DRIFT_RECOVERY_DECEL_MPS2 = 0.3;

const KIND_CODE: Record<EffectKind, number> = { "gnss-jamming": 0, "position-step": 1, "velocity-drift": 2, magnetic: 3, "motor-loss": 4 };

export type ApplyResult = "applied" | "registry-full" | "rejected";

export class EwEngine {
  readonly jamming = new GnssJamming();
  readonly step: PositionStep;
  readonly drift: VelocityDrift;
  readonly magnetic = new MagneticAnomaly([0, 0, 0], [0, 0, 0]);
  private readonly applier: GpsOffsetApplier;
  private readonly severity = new Float64Array(1);
  private magneticActive = false;
  private readonly offset = new Float64Array(3);
  private readonly magScratch = new Float64Array(3);
  // Registry: slot -> faultId (null when free), effect kind code, motor index (-1 if not motor-loss).
  private readonly ids: (string | null)[] = new Array<string | null>(FAULT_REGISTRY_CAPACITY).fill(null);
  private readonly kinds = new Int8Array(FAULT_REGISTRY_CAPACITY);
  private readonly motors = new Int8Array(FAULT_REGISTRY_CAPACITY);
  private seedValue = 0;
  private motorFaultCount = 0;

  constructor(private readonly motorFaults: MotorFaults | null = null, geoid: GeoidModel = NO_GEOID) {
    this.step = new PositionStep(geoid);
    this.drift = new VelocityDrift(geoid);
    this.applier = new GpsOffsetApplier(geoid);
  }

  get seed(): number { return this.seedValue; }

  /** EwFlagV2 bitmask of currently active effects (state ABI ew_flags). */
  get flags(): number {
    return (this.severity[0] !== 0 || this.jamming.degraded ? EwFlagV2.GnssJamming : 0) |
      (this.step.isActive ? EwFlagV2.PositionStep : 0) |
      (this.drift.mode !== "off" ? EwFlagV2.VelocityDrift : 0) |
      (this.magneticActive ? EwFlagV2.MagneticAnomaly : 0) |
      (this.motorFaultCount > 0 ? EwFlagV2.MotorFault : 0);
  }

  /** Clears every effect, the registry and motor faults; `seed` is recorded for seeded effects. */
  reset(seed: number): void {
    this.seedValue = seed >>> 0;
    this.jamming.reset();
    this.severity[0] = 0;
    this.step.reset();
    this.drift.reset();
    this.magneticActive = false;
    this.magnetic.configure(0, 0, 0, 0, 0, 0);
    this.ids.fill(null);
    this.kinds.fill(0);
    this.motors.fill(-1);
    this.motorFaultCount = 0;
    this.motorFaults?.reset();
  }

  private findSlot(faultId: string): number {
    for (let i = 0; i < FAULT_REGISTRY_CAPACITY; i++) if (this.ids[i] === faultId) return i;
    return -1;
  }
  /** Slot that currently owns an effect kind (and motor index for motor-loss), or -1. */
  private ownerOf(kind: number, motor: number): number {
    for (let i = 0; i < FAULT_REGISTRY_CAPACITY; i++) {
      if (this.ids[i] !== null && this.kinds[i] === kind && this.motors[i] === motor) return i;
    }
    return -1;
  }

  /**
   * Applies one admitted fault.set at the boundary of `tick`. Enabling a
   * faultId takes ownership of its effect (one active instance per effect
   * kind, per motor for motor-loss; a newer faultId replaces the previous
   * owner). Disabling releases it with the command's recovery policy;
   * disabling an unknown or non-owning faultId changes nothing.
   */
  apply(command: FaultCommand, tick: TickId): ApplyResult {
    const e = command.effect, kind = KIND_CODE[e.kind];
    const motor = e.kind === "motor-loss" ? e.motorIndex : -1;
    const tickNumber = tick.hi * 4294967296 + tick.lo;
    const existing = this.findSlot(command.faultId);
    if (!command.enabled) {
      if (existing < 0 || this.kinds[existing] !== kind || this.motors[existing] !== motor) return "applied";
      this.release(e, command.recovery);
      this.ids[existing] = null;
      return "applied";
    }
    let slot = this.ownerOf(kind, motor);
    if (slot < 0) slot = existing;
    if (slot < 0) {
      for (let i = 0; i < FAULT_REGISTRY_CAPACITY && slot < 0; i++) if (this.ids[i] === null) slot = i;
      if (slot < 0) return "registry-full";
    }
    if (existing >= 0 && existing !== slot) this.ids[existing] = null; // the id moved to another effect
    if (!this.engage(e, command.recovery, tickNumber)) return "rejected";
    this.ids[slot] = command.faultId;
    this.kinds[slot] = kind;
    this.motors[slot] = motor;
    return "applied";
  }

  private engage(e: FaultCommand["effect"], recovery: FaultCommand["recovery"], tick: number): boolean {
    switch (e.kind) {
      case "gnss-jamming":
        this.severity[0] = e.severity;
        return true;
      case "position-step": {
        const [n, east, d] = e.offsetNedM;
        if (!this.step.schedule(n, east, d, tick)) return false;
        this.step.advanceTick(tick);
        return true;
      }
      case "velocity-drift":
        return this.drift.enable({ accelNedMps2: e.accelerationNedMps2, maxSpeedMps: e.maxSpeedMps,
          decelMps2: DRIFT_RECOVERY_DECEL_MPS2, recovery });
      case "magnetic": {
        const [r, p, y] = e.rotationRad, [bx, by, bz] = e.biasBodyGauss;
        if (!this.magnetic.configure(r, p, y, bx, by, bz)) return false;
        this.magneticActive = true;
        return true;
      }
      case "motor-loss": {
        if (!this.motorFaults?.set(e.motorIndex, e.mode, e.remainingThrustFraction)) return false;
        if (this.ownerOf(KIND_CODE["motor-loss"], e.motorIndex) < 0) this.motorFaultCount++;
        return true;
      }
      default: { const never: never = e; throw new Error(`Unhandled effect ${JSON.stringify(never)}`); }
    }
  }

  private release(e: FaultCommand["effect"], recovery: FaultCommand["recovery"]): void {
    switch (e.kind) {
      case "gnss-jamming": this.severity[0] = 0; return; // filtered severity decays on the physics clock
      case "position-step": this.step.disable(); return;
      case "velocity-drift":
        this.drift.disable(recovery); // the command's recovery decides how drift ends (spec section 5)
        return;
      case "magnetic": this.magneticActive = false; this.magnetic.configure(0, 0, 0, 0, 0, 0); return;
      case "motor-loss": this.motorFaults?.set(e.motorIndex, "none", 1); this.motorFaultCount--; return;
      default: { const never: never = e; throw new Error(`Unhandled effect ${JSON.stringify(never)}`); }
    }
  }

  /** Every physics step; allocation-free. */
  advanceInto(context: EwContext): boolean {
    if (!this.jamming.advanceFrom(this.severity, context)) return false;
    return this.drift.advanceFrom(context);
  }

  /** baseline -> step + drift -> jamming. False with `target` untouched for an invalid source. */
  distortGpsInto(source: GpsSample, target: GpsSample): boolean {
    if (source === target || !validGps(source)) return false;
    copyGpsInto(source, target);
    const o = this.offset, b = this.drift.offsetNedM, stepActive = this.step.isActive, driftOn = this.drift.mode !== "off";
    o[0] = (stepActive ? (this.step.offsetNedM[0] as number) : 0) + (driftOn ? (b[0] as number) : 0); // length 3
    o[1] = (stepActive ? (this.step.offsetNedM[1] as number) : 0) + (driftOn ? (b[1] as number) : 0);
    o[2] = (stepActive ? (this.step.offsetNedM[2] as number) : 0) + (driftOn ? (b[2] as number) : 0);
    if ((o[0] !== 0 || o[1] !== 0 || o[2] !== 0) &&
      !this.applier.applyFromInto(source, o, target)) {
      copyGpsInto(source, target);
      return false;
    }
    if (driftOn) addDriftVelocityInto(source, this.drift.velocityNedMps, target);
    // Jamming reads the already-shifted sample; it only touches satellites, DOP and fix.
    if (this.severity[0] !== 0 || this.jamming.degraded) {
      if (!this.jamming.distortInPlace(target)) { copyGpsInto(source, target); return false; }
    }
    return true;
  }

  /** Magnetometer only; other IMU fields are copied unchanged. */
  distortImuInto(source: ImuSample, target: ImuSample): boolean {
    if (source === target || source.magBodyGauss.length !== 3 || target.magBodyGauss.length !== 3) return false;
    target.timeLoUs = source.timeLoUs; target.timeHiUs = source.timeHiUs;
    target.specificForceBodyMps2.set(source.specificForceBodyMps2);
    target.gyroBodyRadS.set(source.gyroBodyRadS);
    target.pressurePa = source.pressurePa; target.differentialPressurePa = source.differentialPressurePa;
    target.pressureAltitudeM = source.pressureAltitudeM; target.temperatureK = source.temperatureK;
    target.updatedMask = source.updatedMask;
    if (!this.magneticActive) { target.magBodyGauss.set(source.magBodyGauss); return true; }
    if (!this.magnetic.distortInto(source.magBodyGauss, this.magScratch)) return false;
    target.magBodyGauss.set(this.magScratch);
    return true;
  }
}
