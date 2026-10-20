// Cold native experiment adapter. Reuses TASK-058 effects; no production timing claim.
import { EwEngine, type FaultCommand } from '../../packages/ew/src/engine.ts';
import { LocalTangentFrame } from '../../packages/sensors/src/geodesy.ts';
import type { GpsSample, ImuSample } from '../../packages/mavlink/src/samples.ts';

export const CASES = ['control', 'jamming', 'position-step', 'velocity-drift', 'magnetic', 'motor-loss'] as const;
export type CaseId = typeof CASES[number];
export const PLAN = Object.freeze({ schemaVersion: 1, seed: 59, gpsHz: 10, preFaultHoldS: 5,
  exposureS: 12, recoveryS: 8, motorExposureS: 3,
  effects: {
    jamming: { kind: 'gnss-jamming', severity: 1 },
    'position-step': { kind: 'position-step', offsetNedM: [30, 0, 0] },
    'velocity-drift': { kind: 'velocity-drift', accelerationNedMps2: [0.5, 0, 0], maxSpeedMps: 4 },
    magnetic: { kind: 'magnetic', rotationRad: [0, 0, 0], biasBodyGauss: [0.3, 0.2, 0] },
    'motor-loss': { kind: 'motor-loss', motorIndex: 0, mode: 'instant-thrust-loss', remainingThrustFraction: 0 },
  },
  // Freeze rule is declared before calibration. Floors reflect capture/scheduling variation,
  // not measured aircraft accuracy. A separate run must satisfy these fixed limits.
  envelopeRule: { factor: 1.5, positionMarginM: 2, innovationMargin: 0.5 },
} as const);

export class EwObservations {
  readonly engine = new EwEngine();
  readonly frame = new LocalTangentFrame(-35.362938 * Math.PI / 180, 149.165085 * Math.PI / 180, 584);
  readonly geodetic = new Float64Array(3);
  readonly gps: GpsSample = { timeLoUs: 0, timeHiUs: 0, latitudeRad: 0, longitudeRad: 0, altitudeMslM: 0,
    vnMps: 0, veMps: 0, vdMps: 0, hdop: 0.8, vdop: 1.1, hdopValid: true, vdopValid: true,
    fixType: 3, satellites: 12, satellitesValid: true, velocityValid: true, courseRad: 0, courseValid: true };
  readonly distorted: GpsSample = { ...this.gps };
  readonly imu: ImuSample = { timeLoUs: 0, timeHiUs: 0, specificForceBodyMps2: new Float64Array(3),
    gyroBodyRadS: new Float64Array(3), magBodyGauss: new Float64Array(3), pressurePa: 101325,
    differentialPressurePa: 0, pressureAltitudeM: 0, temperatureK: 288.15, updatedMask: 0x1fff };
  readonly distortedImu: ImuSample = { ...this.imu, specificForceBodyMps2: new Float64Array(3),
    gyroBodyRadS: new Float64Array(3), magBodyGauss: new Float64Array(3) };
  readonly context = { dtS: 1 / 800, simTimeS: 0, truthNorthM: 0, truthEastM: 0, truthDownM: 0 };
  readonly thrustFractions = new Float64Array([1, 1, 1, 1]);
  active = false;
  readonly id: CaseId;
  constructor(id: string) {
    if (!CASES.some(c => c === id)) throw Error('Unknown native EW case');
    this.id = id as CaseId; // membership checked above
    this.engine.reset(PLAN.seed);
  }
  setActive(active: boolean, tick: number): void {
    if (active === this.active) return;
    this.active = active;
    if (this.id === 'control') return;
    if (this.id === 'motor-loss') {
      // Synthetic actuator has no electrical torque/RPM model. Apply the explicit
      // instant-thrust-loss contract, including yaw wrench, after its motor lag.
      this.thrustFractions[0] = active ? 0 : 1;
      return;
    }
    const command: FaultCommand = { protocolVersion: 2, requestId: tick + 1, expectedEpoch: 1, type: 'fault.set',
      atTick: { lo: tick, hi: 0 }, faultId: this.id, enabled: active, effect: PLAN.effects[this.id], recovery: 'step-to-truth' };
    if (this.engine.apply(command, command.atTick) !== 'applied') throw Error('EW command rejected');
  }
  advance(timeS: number): void {
    this.context.simTimeS = timeS;
    if (!this.engine.advanceInto(this.context)) throw Error('EW advance rejected');
  }
  sample(timeS: number, position: Float64Array, velocity: Float64Array): void {
    this.frame.nedToGeodeticFromInto(position, this.geodetic);
    const g = this.gps;
    g.timeLoUs = Math.round(timeS * 1e6) >>> 0; g.timeHiUs = Math.floor(timeS * 1e6 / 4294967296);
    g.latitudeRad = this.geodetic[0]!; g.longitudeRad = this.geodetic[1]!; g.altitudeMslM = this.geodetic[2]!;
    g.vnMps = velocity[0]!; g.veMps = velocity[1]!; g.vdMps = velocity[2]!;
    g.courseRad = Math.atan2(g.veMps, g.vnMps); if (g.courseRad < 0) g.courseRad += 2 * Math.PI;
    if (!this.engine.distortGpsInto(g, this.distorted)) throw Error('GPS observation rejected');
  }
  // SIM_Compass subtracts milliGauss offsets. Apply a body bias to all three
  // simulated compasses, preserving the firmware's estimator selection logic.
  compassOffsetsMilliGauss(): number[] {
    if (!this.engine.distortImuInto(this.imu, this.distortedImu)) throw Error('Magnetic observation rejected');
    return Array.from(this.distortedImu.magBodyGauss, v => -1000 * v);
  }
}
