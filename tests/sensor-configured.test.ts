import { describe, expect, it } from 'vitest';
import {
  ConfiguredBattery, ConfiguredImu, NEUTRAL_BATTERY_PLAN, NEUTRAL_IMU_PLAN, SENSOR_ERROR_STREAMS, type ImuErrorPlan,
} from '../packages/sensors/src/configured.ts';
import { specificForceAtInto } from '../packages/sensors/src/lever-arm.ts';

// TASK-147: the MirageSITL-owned errors of the external-SITL path. Oracles:
// bitwise identity for absent and zero terms, exact arithmetic for biases,
// gains and offsets, sample-indexed delays, and sampling-distribution bounds
// for white noise fixed before the run (5 standard errors of each estimator).

const RATE = 800;
const plan = (change: Partial<ImuErrorPlan>): ImuErrorPlan => ({ ...NEUTRAL_IMU_PLAN, ...change });
const bits = (values: ArrayLike<number>) => Array.from(values, value => (Object.is(value, -0) ? '-0' : String(value)));
/** Deterministic, sign-changing inputs that include −0. */
function input(n: number): [Float64Array, Float64Array, Float64Array] {
  return [Float64Array.of(-0, 0.1 * Math.sin(n), -9.80665 + 0.01 * n), Float64Array.of(0.3 * Math.cos(n), -0, 0.02 * n),
    Float64Array.of(1.5 * Math.sin(0.1 * n), -2, -0)];
}
function run(imu: ConfiguredImu, steps: number): number[][] {
  const accel = new Float64Array(3), gyro = new Float64Array(3), rows: number[][] = [];
  for (let n = 0; n < steps; n++) {
    const [f, w, a] = input(n);
    expect(imu.stepInto(f, w, a, accel, gyro)).toBe(true);
    rows.push([...accel, ...gyro]);
  }
  return rows;
}
function stats(values: readonly number[]): { mean: number; variance: number; lag1: number } {
  const n = values.length, mean = values.reduce((sum, v) => sum + v, 0) / n;
  let variance = 0, lag = 0;
  for (let i = 0; i < n; i++) {
    variance += (values[i]! - mean) ** 2;
    if (i > 0) lag += (values[i]! - mean) * (values[i - 1]! - mean);
  }
  return { mean, variance: variance / (n - 1), lag1: lag / variance };
}

describe('configured IMU', () => {
  it('delivers every input bit unchanged when every term is absent or zero, and draws no random number', () => {
    const neutral = new ConfiguredImu(NEUTRAL_IMU_PLAN, 7, RATE);
    const zeros = new ConfiguredImu(plan({ accelBiasMps2: [0, 0, 0], gyroBiasRadS: [0, 0, 0], leverArmCgM: [0, 0, 0],
      sensorToBodyRad: [0, 0, 0], latencyUs: 0, accelNoiseDensityMps2PerSqrtHz: 0, gyroNoiseDensityRadSPerSqrtHz: 0 }), 99, RATE);
    const accel = new Float64Array(3), gyro = new Float64Array(3);
    for (let n = 0; n < 50; n++) {
      const [f, w, a] = input(n);
      for (const imu of [neutral, zeros]) {
        imu.stepInto(f, w, a, accel, gyro);
        expect(bits(accel), `accel ${n}`).toEqual(bits(f));
        expect(bits(gyro), `gyro ${n}`).toEqual(bits(w));
      }
    }
    // A gyro-only noise leaves the accelerometer bits, and its stream, untouched.
    const gyroOnly = run(new ConfiguredImu(plan({ gyroNoiseDensityRadSPerSqrtHz: 1e-3 }), 7, RATE), 40);
    gyroOnly.forEach((row, n) => expect(bits(row.slice(0, 3))).toEqual(bits(input(n)[0])));
    const both = run(new ConfiguredImu(plan({ gyroNoiseDensityRadSPerSqrtHz: 1e-3, accelNoiseDensityMps2PerSqrtHz: 2e-3 }), 7, RATE), 40);
    expect(both.map(row => row.slice(3))).toEqual(gyroOnly.map(row => row.slice(3)));
  });

  it('adds the bias once, in sensor axes, after the misalignment', () => {
    const accelBias = [0.5, -0.3, 0.2] as const, gyroBias = [0.01, 0, -0.02] as const;
    const rows = run(new ConfiguredImu(plan({ accelBiasMps2: accelBias, gyroBiasRadS: gyroBias }), 1, RATE), 10);
    rows.forEach((row, n) => {
      const [f, w] = input(n);
      expect(row.slice(0, 3)).toEqual([f[0]! + 0.5, f[1]! - 0.3, f[2]! + 0.2]);
      // A zero bias component leaves even −0 untouched.
      expect(bits(row.slice(3))).toEqual(bits([w[0]! + 0.01, w[1]!, w[2]! - 0.02]));
    });
    // Yawed 90°, a forward body bias would read on −y; the sensor-axes bias stays on x.
    const yawed = new ConfiguredImu(plan({ sensorToBodyRad: [0, 0, Math.PI / 2], accelBiasMps2: [1, 0, 0] }), 1, RATE);
    const accel = new Float64Array(3), gyro = new Float64Array(3);
    yawed.stepInto(Float64Array.of(0, 0, 0), Float64Array.of(0, 0, 0), Float64Array.of(0, 0, 0), accel, gyro);
    expect(Array.from(accel)).toEqual([1, 0, 0]);
  });

  it('applies the lever arm from the CG and then the mounting rotation', () => {
    const r = [0.12, -0.05, 0.03] as const, imu = new ConfiguredImu(plan({ leverArmCgM: r, sensorToBodyRad: [0, 0, Math.PI / 2] }), 1, RATE);
    const accel = new Float64Array(3), gyro = new Float64Array(3), expected = new Float64Array(3);
    for (let n = 0; n < 20; n++) {
      const [f, w, a] = input(n);
      imu.stepInto(f, w, a, accel, gyro);
      specificForceAtInto(f, w, a, Float64Array.from(r), expected);
      // Yaw 90°: sensor (x, y) = body (y, −x).
      expect(Math.abs(accel[0]! - expected[1]!)).toBeLessThan(1e-14);
      expect(Math.abs(accel[1]! + expected[0]!)).toBeLessThan(1e-14);
      expect(Math.abs(accel[2]! - expected[2]!)).toBeLessThan(1e-14);
      expect(Math.abs(gyro[0]! - w[1]!) + Math.abs(gyro[1]! + w[0]!) + Math.abs(gyro[2]! - w[2]!)).toBeLessThan(1e-15);
    }
  });

  it('delays the kinematic signal by whole samples exactly and interpolates fractions, holding the first sample at start', () => {
    // 2500 µs at 800 Hz is two samples.
    const whole = run(new ConfiguredImu(plan({ latencyUs: 2500 }), 1, RATE), 30);
    whole.forEach((row, n) => {
      const [f, w] = input(Math.max(0, n - 2));
      expect(bits(row), `sample ${n}`).toEqual(bits([...f, ...w]));
    });
    // 1875 µs is 1.5 samples: a ramp reads the value 1.5 samples back.
    const ramp = new ConfiguredImu(plan({ latencyUs: 1875 }), 1, RATE), accel = new Float64Array(3), gyro = new Float64Array(3);
    for (let n = 0; n < 10; n++) {
      ramp.stepInto(Float64Array.of(n, 2 * n, -n), Float64Array.of(0.5 * n, 0, 0), Float64Array.of(0, 0, 0), accel, gyro);
      const back = n >= 2 ? n - 1.5 : 0;
      expect(Array.from(accel), `ramp ${n}`).toEqual([back, 2 * back, -back]);
      expect(gyro[0]).toBe(0.5 * back);
    }
    // The bias is added at delivery, not delayed.
    const biased = new ConfiguredImu(plan({ latencyUs: 2500, accelBiasMps2: [0, 0, 1] }), 1, RATE);
    biased.stepInto(Float64Array.of(0, 0, 5), Float64Array.of(0, 0, 0), Float64Array.of(0, 0, 0), accel, gyro);
    expect(accel[2]).toBe(6);
  });

  it('adds white noise of σ = N·√(f/2) per axis, independent across axes and samples', () => {
    const density = 1e-3, samples = 200000, imu = new ConfiguredImu(plan({ accelNoiseDensityMps2PerSqrtHz: density }), 20261029, RATE);
    const zero = Float64Array.of(0, 0, 0), accel = new Float64Array(3), gyro = new Float64Array(3);
    const axes: number[][] = [[], [], []];
    for (let n = 0; n < samples; n++) {
      imu.stepInto(zero, zero, zero, accel, gyro);
      for (let i = 0; i < 3; i++) axes[i]!.push(accel[i]!);
    }
    const sigma = density * Math.sqrt(RATE / 2); // 0.02 m/s²
    for (const values of axes) {
      const s = stats(values);
      expect(Math.abs(s.mean)).toBeLessThan((5 * sigma) / Math.sqrt(samples));
      expect(Math.abs(s.variance / (sigma * sigma) - 1)).toBeLessThan(5 * Math.sqrt(2 / (samples - 1)));
      expect(Math.abs(s.lag1)).toBeLessThan(5 / Math.sqrt(samples));
    }
    const cross = axes[0]!.reduce((sum, v, i) => sum + v * axes[1]![i]!, 0) / (samples * sigma * sigma);
    expect(Math.abs(cross)).toBeLessThan(5 / Math.sqrt(samples));
  });

  it('repeats exactly for a seed, after a reset, and differs for another seed', () => {
    const noisy = plan({ accelNoiseDensityMps2PerSqrtHz: 7e-4, gyroNoiseDensityRadSPerSqrtHz: 5e-5, accelBiasMps2: [0.1, 0, 0], latencyUs: 1875 });
    const a = new ConfiguredImu(noisy, 42, RATE), first = run(a, 200);
    expect(run(new ConfiguredImu(noisy, 42, RATE), 200)).toEqual(first);
    a.reset(42);
    expect(run(a, 200)).toEqual(first);
    expect(run(new ConfiguredImu(noisy, 43, RATE), 200)).not.toEqual(first);
    expect(Object.values(SENSOR_ERROR_STREAMS)).toEqual([0x00147001, 0x00147002, 0x00147003, 0x00147004]);
  });

  it('rejects invalid plans and non-finite inputs', () => {
    expect(() => new ConfiguredImu(plan({ latencyUs: 100001 }), 1, RATE)).toThrow('latency');
    expect(() => new ConfiguredImu(plan({ latencyUs: 1.5 }), 1, RATE)).toThrow('latency');
    expect(() => new ConfiguredImu(plan({ accelNoiseDensityMps2PerSqrtHz: -1 }), 1, RATE)).toThrow('noise density');
    expect(() => new ConfiguredImu(plan({ leverArmCgM: [0, Number.NaN, 0] }), 1, RATE)).toThrow('lever arm');
    expect(() => new ConfiguredImu(NEUTRAL_IMU_PLAN, -1, RATE)).toThrow('uint32');
    expect(() => new ConfiguredImu(NEUTRAL_IMU_PLAN, 1, 0)).toThrow('sample rate');
    const imu = new ConfiguredImu(NEUTRAL_IMU_PLAN, 1, RATE), out = new Float64Array(3);
    expect(imu.stepInto(Float64Array.of(0, Number.NaN, 0), Float64Array.of(0, 0, 0), Float64Array.of(0, 0, 0), out, out)).toBe(false);
  });
});

describe('configured battery measurement', () => {
  it('passes the truth bit for bit with no error, and applies gain then offset exactly', () => {
    const out = new Float64Array(2);
    const neutral = new ConfiguredBattery(NEUTRAL_BATTERY_PLAN, 3);
    neutral.stepInto(12.6, -0, out);
    expect(bits(out)).toEqual(['12.6', '-0']);
    const biased = new ConfiguredBattery({ ...NEUTRAL_BATTERY_PLAN, voltageGainError: 0.02, voltageOffsetV: -0.15, currentGainError: -0.05,
      currentOffsetA: 0.4 }, 3);
    biased.stepInto(12.6, 20, out);
    expect(Array.from(out)).toEqual([1.02 * 12.6 - 0.15, 0.95 * 20 + 0.4]);
  });

  it('adds Gaussian noise of the given σ on its own streams, repeatably', () => {
    const p = { ...NEUTRAL_BATTERY_PLAN, voltageNoiseRmsV: 0.05, currentNoiseRmsA: 0.3 };
    const battery = new ConfiguredBattery(p, 11), out = new Float64Array(2), volts: number[] = [], amps: number[] = [];
    const samples = 100000;
    for (let n = 0; n < samples; n++) {
      battery.stepInto(16, 10, out);
      volts.push(out[0]! - 16); amps.push(out[1]! - 10);
    }
    for (const [values, sigma] of [[volts, 0.05], [amps, 0.3]] as const) {
      const s = stats(values);
      expect(Math.abs(s.mean)).toBeLessThan((5 * sigma) / Math.sqrt(samples));
      expect(Math.abs(s.variance / (sigma * sigma) - 1)).toBeLessThan(5 * Math.sqrt(2 / (samples - 1)));
      expect(Math.abs(s.lag1)).toBeLessThan(5 / Math.sqrt(samples));
    }
    battery.reset(11);
    battery.stepInto(16, 10, out);
    expect(out[0]! - 16).toBe(volts[0]);
    // The voltage stream does not depend on the current noise being on.
    const voltageOnly = new ConfiguredBattery({ ...NEUTRAL_BATTERY_PLAN, voltageNoiseRmsV: 0.05 }, 11);
    voltageOnly.stepInto(16, 10, out);
    expect([out[0]! - 16, out[1]]).toEqual([volts[0], 10]);
    expect(() => new ConfiguredBattery({ ...NEUTRAL_BATTERY_PLAN, voltageGainError: -1 }, 1)).toThrow('battery');
    expect(new ConfiguredBattery(NEUTRAL_BATTERY_PLAN, 1).stepInto(Number.NaN, 0, out)).toBe(false);
  });
});
