import { describe, expect, it } from 'vitest';
import {
  bodyToSensorInto, eulerZyxToQuaternion, sensorToBodyMatrixInto, specificForceAtInto,
} from '../packages/sensors/src/lever-arm.ts';

// TASK-147 lever-arm and misalignment fixtures. Oracles: closed-form rigid-body
// results (centripetal ω²r, tangential αr), and an independent formulation with
// skew-symmetric matrices and explicit elementary rotations multiplied out.

const G = 9.80665;
const v3 = (x: number, y: number, z: number) => Float64Array.of(x, y, z);
function skew(v: readonly number[]): number[][] {
  return [[0, -v[2]!, v[1]!], [v[2]!, 0, -v[0]!], [-v[1]!, v[0]!, 0]];
}
function multiply(a: number[][], b: number[][]): number[][] {
  return a.map(row => b[0]!.map((_, j) => row.reduce((sum, value, k) => sum + value * b[k]![j]!, 0)));
}
function apply(m: number[][], v: readonly number[]): number[] {
  return m.map(row => row.reduce((sum, value, k) => sum + value * v[k]!, 0));
}
const rx = (a: number) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const ry = (a: number) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const rz = (a: number) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
const transpose = (m: number[][]) => m[0]!.map((_, j) => m.map(row => row[j]!));
function close(actual: ArrayLike<number>, expected: readonly number[], tolerance: number, label: string): void {
  expect(actual.length, label).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(Math.abs(actual[i]! - expected[i]!), `${label}[${i}]`).toBeLessThanOrEqual(tolerance);
}

describe('specific force at a lever arm', () => {
  it('adds the centripetal term −ω²r for a steady yaw rate', () => {
    const out = new Float64Array(3);
    // 2 rad/s about body z, IMU 0.1 m forward of the CG: 0.4 m/s² towards the axis.
    specificForceAtInto(v3(0, 0, -G), v3(0, 0, 2), v3(0, 0, 0), v3(0.1, 0, 0), out);
    close(out, [-0.4, 0, -G], 1e-15, 'centripetal');
    // The same rate about x with the IMU 0.2 m to the right: −ω²r along y.
    specificForceAtInto(v3(0, 0, -G), v3(3, 0, 0), v3(0, 0, 0), v3(0, 0.2, 0), out);
    close(out, [0, -1.8, -G], 1e-15, 'roll centripetal');
  });

  it('adds the tangential term αr for an angular acceleration', () => {
    const out = new Float64Array(3);
    // 5 rad/s² about z with the IMU 0.1 m forward: 0.5 m/s² to the right.
    specificForceAtInto(v3(0, 0, -G), v3(0, 0, 0), v3(0, 0, 5), v3(0.1, 0, 0), out);
    close(out, [0, 0.5, -G], 1e-15, 'tangential');
    // A pitch acceleration with the IMU below the CG pushes it forward: α×r = (0, 4, 0)×(0, 0, 0.05) = (0.2, 0, 0).
    specificForceAtInto(v3(1, 2, 3), v3(0, 0, 0), v3(0, 4, 0), v3(0, 0, 0.05), out);
    close(out, [1.2, 2, 3], 1e-15, 'pitch tangential');
  });

  it('matches the skew-matrix form f + [α]×r + [ω]×[ω]×r for arbitrary vectors, and leaves the CG reading unchanged', () => {
    const out = new Float64Array(3);
    const cases: [number[], number[], number[], number[]][] = [
      [[0.3, -0.7, -9.6], [0.8, -1.3, 2.1], [12, -4, 7.5], [0.12, -0.05, 0.03]],
      [[-2, 1, -11], [-5.5, 0.2, 0.9], [-30, 18, 2], [-0.4, 0.31, -0.2]],
      [[0, 0, -G], [0, 0, 0], [0, 0, 0], [1, -1, 0.5]],
    ];
    for (const [f, w, a, r] of cases) {
      const expected = apply(skew(a), r).map((value, i) => f[i]! + value + apply(multiply(skew(w), skew(w)), r)[i]!);
      specificForceAtInto(Float64Array.from(f), Float64Array.from(w), Float64Array.from(a), Float64Array.from(r), out);
      close(out, expected, 1e-13, `case ${String(r)}`);
      specificForceAtInto(Float64Array.from(f), Float64Array.from(w), Float64Array.from(a), v3(0, 0, 0), out);
      close(out, f, 0, 'at the CG');
    }
  });

  it('writes correctly when the output aliases the input', () => {
    const f = v3(1, 2, 3);
    specificForceAtInto(f, v3(0, 0, 2), v3(0, 0, 0), v3(0.1, 0, 0), f);
    close(f, [0.6, 2, 3], 1e-15, 'aliased');
  });
});

describe('sensor misalignment', () => {
  it('builds R = Rz(yaw)·Ry(pitch)·Rx(roll) and reads a body vector as Rᵀ·v', () => {
    const m = new Float64Array(9), out = new Float64Array(3);
    for (const [roll, pitch, yaw] of [[0.3, -0.2, 1.1], [-2.5, 1.2, -3], [0.01, 0.02, -0.03]] as const) {
      sensorToBodyMatrixInto(roll, pitch, yaw, m);
      const expected = multiply(multiply(rz(yaw), ry(pitch)), rx(roll));
      close(m, expected.flat(), 2e-16 * 8, `R(${roll}, ${pitch}, ${yaw})`);
      bodyToSensorInto(m, v3(0.4, -1.2, 9.1), out);
      close(out, apply(transpose(expected), [0.4, -1.2, 9.1]), 1e-14, 'Rᵀv');
    }
  });

  it('reads gravity as the analytic values of a tilted mount', () => {
    const m = new Float64Array(9), out = new Float64Array(3), atRest = v3(0, 0, -G);
    // A 2° pitch reads g·sin 2° forward and −g·cos 2° down.
    sensorToBodyMatrixInto(0, (2 * Math.PI) / 180, 0, m);
    bodyToSensorInto(m, atRest, out);
    close(out, [G * Math.sin(Math.PI / 90), 0, -G * Math.cos(Math.PI / 90)], 1e-15, 'pitch 2°');
    // A mount rolled 90°: the sensor's y axis is body down, so gravity reads −g on sensor y.
    sensorToBodyMatrixInto(Math.PI / 2, 0, 0, m);
    bodyToSensorInto(m, atRest, out);
    close(out, [0, -G, 0], 1e-15, 'roll 90°');
    // A mount yawed 90°: the sensor's x axis is body right, so a forward body rate reads on −y.
    sensorToBodyMatrixInto(0, 0, Math.PI / 2, m);
    bodyToSensorInto(m, v3(1, 0, 0), out);
    close(out, [0, -1, 0], 1e-16, 'yaw 90°');
  });

  it('gives the quaternion of the same rotation, with w ≥ 0', () => {
    const m = new Float64Array(9);
    for (const [roll, pitch, yaw] of [[0.3, -0.2, 1.1], [-2.5, 1.2, -3], [3.1, 0.4, 3.1]] as const) {
      const [w, x, y, z] = eulerZyxToQuaternion(roll, pitch, yaw);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(Math.abs(w * w + x * x + y * y + z * z - 1)).toBeLessThan(1e-15);
      // Rotation matrix of a unit quaternion (independent formula).
      const fromQuaternion = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
      sensorToBodyMatrixInto(roll, pitch, yaw, m);
      close(fromQuaternion, Array.from(m), 1e-15, `q(${roll}, ${pitch}, ${yaw})`);
    }
    expect(eulerZyxToQuaternion(0, 0, 0)).toEqual([1, 0, 0, 0]);
  });
});
