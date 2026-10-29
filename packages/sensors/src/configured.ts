import { SeededRandom } from "@mirage/test-support/prng";
import { bodyToSensorInto, sensorToBodyMatrixInto, specificForceAtInto } from "./lever-arm.ts";

// The MirageSITL-owned sensor errors of the external-SITL path (TASK-147):
// the IMU observation delivered in the ArduPilot JSON state line and the
// battery measurement delivered in its battery section. Plans are plain
// numbers in SI units, built at configuration time from the Sensors tab
// configuration; stepInto is allocation-free and never draws a random number
// for a term whose magnitude is zero, so a zero term leaves every delivered
// bit as an absent one would.

/** Fixed RNG stream IDs (uint32); a stream never depends on which other terms are on. */
export const SENSOR_ERROR_STREAMS = Object.freeze({
  accelNoise: 0x00147001, gyroNoise: 0x00147002, batteryVoltageNoise: 0x00147003, batteryCurrentNoise: 0x00147004,
});
export const MAX_IMU_LATENCY_US = 100000;

export type Vector3Tuple = readonly [number, number, number];
export interface ImuErrorPlan {
  /** One-sided white-noise amplitude density per sensor axis; per-sample σ = N·√(f/2) at sample rate f. */
  readonly accelNoiseDensityMps2PerSqrtHz: number;
  readonly gyroNoiseDensityRadSPerSqrtHz: number;
  /** Constant bias in sensor axes. */
  readonly accelBiasMps2: Vector3Tuple;
  readonly gyroBiasRadS: Vector3Tuple;
  /** Delivery delay of the kinematic signal, whole microseconds. */
  readonly latencyUs: number;
  /** Sensor position relative to the CG, body FRD metres. */
  readonly leverArmCgM: Vector3Tuple;
  /** Sensor-to-body rotation R = Rz(yaw)·Ry(pitch)·Rx(roll) as [roll, pitch, yaw], radians. */
  readonly sensorToBodyRad: Vector3Tuple;
}
/** measured = (1 + gain error)·true + offset + noise */
export interface BatteryErrorPlan {
  readonly voltageGainError: number; readonly voltageOffsetV: number; readonly voltageNoiseRmsV: number;
  readonly currentGainError: number; readonly currentOffsetA: number; readonly currentNoiseRmsA: number;
}
export const NEUTRAL_IMU_PLAN: ImuErrorPlan = Object.freeze({
  accelNoiseDensityMps2PerSqrtHz: 0, gyroNoiseDensityRadSPerSqrtHz: 0, accelBiasMps2: Object.freeze([0, 0, 0] as const),
  gyroBiasRadS: Object.freeze([0, 0, 0] as const), latencyUs: 0, leverArmCgM: Object.freeze([0, 0, 0] as const),
  sensorToBodyRad: Object.freeze([0, 0, 0] as const),
});
export const NEUTRAL_BATTERY_PLAN: BatteryErrorPlan = Object.freeze({
  voltageGainError: 0, voltageOffsetV: 0, voltageNoiseRmsV: 0, currentGainError: 0, currentOffsetA: 0, currentNoiseRmsA: 0,
});

function finite(values: readonly number[], label: string): void {
  if (values.length === 0 || !values.every(Number.isFinite)) throw new Error(`Invalid ${label}`);
}
function nonZero(values: readonly number[]): boolean {
  return values.some(value => value !== 0);
}
function seedOf(seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Sensor error seed must be a uint32");
  return seed;
}
/** Standard normal from two uniforms (Box–Muller cosine branch); fixed work. */
function gaussian(random: SeededRandom): number {
  return Math.sqrt(-2 * Math.log(1 - random.nextFloat())) * Math.cos(2 * Math.PI * random.nextFloat());
}

/**
 * IMU observation at the sensor: kinematics at the mounting point, rotation
 * into sensor axes and the delivery delay, then bias and white noise.
 * Inputs are the CG specific force, angular velocity and angular acceleration
 * in body axes for the current physics sample.
 */
export class ConfiguredImu {
  readonly plan: ImuErrorPlan;
  private readonly leverArm: Float64Array;
  private readonly rotation = new Float64Array(9);
  private readonly hasLeverArm: boolean;
  private readonly hasRotation: boolean;
  private readonly accelSigma: number;
  private readonly gyroSigma: number;
  private readonly accelRandom: SeededRandom;
  private readonly gyroRandom: SeededRandom;
  /** Delay in samples: whole part and fraction. */
  private readonly delayWhole: number;
  private readonly delayFraction: number;
  /** Ring of kinematic samples [ax, ay, az, gx, gy, gz]. */
  private readonly history: Float64Array;
  private readonly capacity: number;
  private head = 0;
  private stored = 0;
  private readonly force = new Float64Array(3);
  private readonly rate = new Float64Array(3);

  readonly sampleRateHz: number;

  constructor(plan: ImuErrorPlan, seed: number, sampleRateHz: number) {
    if (!Number.isInteger(sampleRateHz) || sampleRateHz < 1 || sampleRateHz > 10000) throw new Error("Invalid IMU sample rate");
    this.sampleRateHz = sampleRateHz;
    finite([plan.accelNoiseDensityMps2PerSqrtHz, plan.gyroNoiseDensityRadSPerSqrtHz], "IMU noise density");
    if (plan.accelNoiseDensityMps2PerSqrtHz < 0 || plan.gyroNoiseDensityRadSPerSqrtHz < 0) throw new Error("Invalid IMU noise density");
    for (const [vector, label] of [[plan.accelBiasMps2, "accelerometer bias"], [plan.gyroBiasRadS, "gyroscope bias"],
      [plan.leverArmCgM, "lever arm"], [plan.sensorToBodyRad, "sensor orientation"]] as const) {
      if (vector.length !== 3) throw new Error(`Invalid ${label}`);
      finite(vector, label);
    }
    if (!Number.isInteger(plan.latencyUs) || plan.latencyUs < 0 || plan.latencyUs > MAX_IMU_LATENCY_US) throw new Error("Invalid IMU latency");
    this.plan = plan;
    this.leverArm = Float64Array.from(plan.leverArmCgM);
    this.hasLeverArm = nonZero(plan.leverArmCgM);
    this.hasRotation = nonZero(plan.sensorToBodyRad);
    sensorToBodyMatrixInto(plan.sensorToBodyRad[0], plan.sensorToBodyRad[1], plan.sensorToBodyRad[2], this.rotation);
    const perSample = Math.sqrt(sampleRateHz / 2);
    this.accelSigma = plan.accelNoiseDensityMps2PerSqrtHz * perSample;
    this.gyroSigma = plan.gyroNoiseDensityRadSPerSqrtHz * perSample;
    const s = seedOf(seed);
    this.accelRandom = new SeededRandom(s, SENSOR_ERROR_STREAMS.accelNoise);
    this.gyroRandom = new SeededRandom(s, SENSOR_ERROR_STREAMS.gyroNoise);
    // The delay in samples is exact for latencies that are whole sample periods.
    const delay = (plan.latencyUs * sampleRateHz) / 1e6;
    this.delayWhole = Math.floor(delay);
    this.delayFraction = delay - this.delayWhole;
    this.capacity = plan.latencyUs > 0 ? this.delayWhole + 2 : 0;
    this.history = new Float64Array(6 * this.capacity);
  }

  reset(seed: number): void {
    const s = seedOf(seed);
    this.accelRandom.reset(s, SENSOR_ERROR_STREAMS.accelNoise);
    this.gyroRandom.reset(s, SENSOR_ERROR_STREAMS.gyroNoise);
    this.head = 0;
    this.stored = 0;
    this.history.fill(0);
  }

  /** Writes the delivered specific force and angular rate in sensor axes; false on a non-finite input. */
  stepInto(specificForceCg: Float64Array, angularVelocity: Float64Array, angularAcceleration: Float64Array,
    accelOut: Float64Array, gyroOut: Float64Array): boolean {
    for (let i = 0; i < 3; i++) {
      if (!Number.isFinite(specificForceCg[i]) || !Number.isFinite(angularVelocity[i]) || !Number.isFinite(angularAcceleration[i])) return false;
    }
    const f = this.force, w = this.rate;
    if (this.hasLeverArm) specificForceAtInto(specificForceCg, angularVelocity, angularAcceleration, this.leverArm, f);
    else { f[0] = specificForceCg[0]!; f[1] = specificForceCg[1]!; f[2] = specificForceCg[2]!; }
    w[0] = angularVelocity[0]!; w[1] = angularVelocity[1]!; w[2] = angularVelocity[2]!;
    if (this.hasRotation) {
      bodyToSensorInto(this.rotation, f, f);
      bodyToSensorInto(this.rotation, w, w);
    }
    if (this.capacity > 0) this.delay(f, w);
    accelOut[0] = f[0]!; accelOut[1] = f[1]!; accelOut[2] = f[2]!;
    gyroOut[0] = w[0]!; gyroOut[1] = w[1]!; gyroOut[2] = w[2]!;
    const accelBias = this.plan.accelBiasMps2, gyroBias = this.plan.gyroBiasRadS;
    for (let i = 0; i < 3; i++) {
      if (accelBias[i] !== 0) accelOut[i] = accelOut[i]! + accelBias[i]!;
      if (gyroBias[i] !== 0) gyroOut[i] = gyroOut[i]! + gyroBias[i]!;
    }
    if (this.accelSigma > 0) for (let i = 0; i < 3; i++) accelOut[i] = accelOut[i]! + this.accelSigma * gaussian(this.accelRandom);
    if (this.gyroSigma > 0) for (let i = 0; i < 3; i++) gyroOut[i] = gyroOut[i]! + this.gyroSigma * gaussian(this.gyroRandom);
    return true;
  }

  /** Stores the current sample and replaces f and w with the sample delivered latencyUs ago. */
  private delay(f: Float64Array, w: Float64Array): void {
    const h = this.history, capacity = this.capacity;
    const at = 6 * this.head;
    h[at] = f[0]!; h[at + 1] = f[1]!; h[at + 2] = f[2]!; h[at + 3] = w[0]!; h[at + 4] = w[1]!; h[at + 5] = w[2]!;
    this.head = (this.head + 1) % capacity;
    if (this.stored < capacity) this.stored++;
    // Before enough history exists, the oldest stored sample stands in.
    const newest = this.stored - 1;
    const back = Math.min(this.delayWhole, newest), older = Math.min(this.delayWhole + 1, newest);
    const a = 6 * ((this.head - 1 - back + 2 * capacity) % capacity), b = 6 * ((this.head - 1 - older + 2 * capacity) % capacity);
    const t = this.delayFraction;
    if (t === 0 || a === b) {
      f[0] = h[a]!; f[1] = h[a + 1]!; f[2] = h[a + 2]!; w[0] = h[a + 3]!; w[1] = h[a + 4]!; w[2] = h[a + 5]!;
      return;
    }
    f[0] = h[a]! + t * (h[b]! - h[a]!); f[1] = h[a + 1]! + t * (h[b + 1]! - h[a + 1]!); f[2] = h[a + 2]! + t * (h[b + 2]! - h[a + 2]!);
    w[0] = h[a + 3]! + t * (h[b + 3]! - h[a + 3]!); w[1] = h[a + 4]! + t * (h[b + 4]! - h[a + 4]!); w[2] = h[a + 5]! + t * (h[b + 5]! - h[a + 5]!);
  }
}

/** Battery voltage and current measurement; one noise draw per delivered sample. */
export class ConfiguredBattery {
  readonly plan: BatteryErrorPlan;
  private readonly voltageRandom: SeededRandom;
  private readonly currentRandom: SeededRandom;

  constructor(plan: BatteryErrorPlan, seed: number) {
    finite([plan.voltageGainError, plan.voltageOffsetV, plan.voltageNoiseRmsV, plan.currentGainError, plan.currentOffsetA,
      plan.currentNoiseRmsA], "battery measurement error");
    if (plan.voltageNoiseRmsV < 0 || plan.currentNoiseRmsA < 0 || plan.voltageGainError <= -1 || plan.currentGainError <= -1) {
      throw new Error("Invalid battery measurement error");
    }
    this.plan = plan;
    const s = seedOf(seed);
    this.voltageRandom = new SeededRandom(s, SENSOR_ERROR_STREAMS.batteryVoltageNoise);
    this.currentRandom = new SeededRandom(s, SENSOR_ERROR_STREAMS.batteryCurrentNoise);
  }

  reset(seed: number): void {
    const s = seedOf(seed);
    this.voltageRandom.reset(s, SENSOR_ERROR_STREAMS.batteryVoltageNoise);
    this.currentRandom.reset(s, SENSOR_ERROR_STREAMS.batteryCurrentNoise);
  }

  /** out[0] = measured voltage (V), out[1] = measured current (A); false on a non-finite truth. */
  stepInto(trueVoltageV: number, trueCurrentA: number, out: Float64Array): boolean {
    if (!Number.isFinite(trueVoltageV) || !Number.isFinite(trueCurrentA)) return false;
    const p = this.plan;
    let v = trueVoltageV, a = trueCurrentA;
    if (p.voltageGainError !== 0) v = (1 + p.voltageGainError) * v;
    if (p.voltageOffsetV !== 0) v += p.voltageOffsetV;
    if (p.voltageNoiseRmsV > 0) v += p.voltageNoiseRmsV * gaussian(this.voltageRandom);
    if (p.currentGainError !== 0) a = (1 + p.currentGainError) * a;
    if (p.currentOffsetA !== 0) a += p.currentOffsetA;
    if (p.currentNoiseRmsA > 0) a += p.currentNoiseRmsA * gaussian(this.currentRandom);
    out[0] = v;
    out[1] = a;
    return true;
  }
}
