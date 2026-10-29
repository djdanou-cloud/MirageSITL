// Rigid-body kinematics of a sensor mounted away from the centre of gravity
// (TASK-147, the Phase 1 subset of TASK-115). Body axes are FRD. A sensor's
// mounting rotation R maps sensor axes to body axes, R = Rz(yaw)·Ry(pitch)·Rx(roll),
// so a body vector reads v_sensor = Rᵀ·v_body. Allocation-free: callers pass
// preallocated arrays, and an output may alias an input.

/**
 * Specific force at a point r from the CG in a rigid body:
 * f_r = f_cg + ω̇×r + ω×(ω×r). Gravity is uniform, so it cancels between the
 * CG and the point. Writes out[0..2].
 */
export function specificForceAtInto(specificForceCg: Float64Array, angularVelocity: Float64Array,
  angularAcceleration: Float64Array, r: Float64Array, out: Float64Array): void {
  const wx = angularVelocity[0]!, wy = angularVelocity[1]!, wz = angularVelocity[2]!;
  const ax = angularAcceleration[0]!, ay = angularAcceleration[1]!, az = angularAcceleration[2]!;
  const rx = r[0]!, ry = r[1]!, rz = r[2]!;
  // c = ω×r, then ω×c.
  const cx = wy * rz - wz * ry, cy = wz * rx - wx * rz, cz = wx * ry - wy * rx;
  const fx = specificForceCg[0]! + (ay * rz - az * ry) + (wy * cz - wz * cy);
  const fy = specificForceCg[1]! + (az * rx - ax * rz) + (wz * cx - wx * cz);
  const fz = specificForceCg[2]! + (ax * ry - ay * rx) + (wx * cy - wy * cx);
  out[0] = fx; out[1] = fy; out[2] = fz;
}

/** Row-major R = Rz(yaw)·Ry(pitch)·Rx(roll) (sensor to body) into out[0..8]. */
export function sensorToBodyMatrixInto(rollRad: number, pitchRad: number, yawRad: number, out: Float64Array): void {
  const cr = Math.cos(rollRad), sr = Math.sin(rollRad);
  const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
  const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
  out[0] = cy * cp; out[1] = cy * sp * sr - sy * cr; out[2] = cy * sp * cr + sy * sr;
  out[3] = sy * cp; out[4] = sy * sp * sr + cy * cr; out[5] = sy * sp * cr - cy * sr;
  out[6] = -sp; out[7] = cp * sr; out[8] = cp * cr;
}

/** v_sensor = Rᵀ·v_body for a row-major sensor-to-body R. */
export function bodyToSensorInto(rotation: Float64Array, v: Float64Array, out: Float64Array): void {
  const x = v[0]!, y = v[1]!, z = v[2]!;
  out[0] = rotation[0]! * x + rotation[3]! * y + rotation[6]! * z;
  out[1] = rotation[1]! * x + rotation[4]! * y + rotation[7]! * z;
  out[2] = rotation[2]! * x + rotation[5]! * y + rotation[8]! * z;
}

/** The unit wxyz quaternion of R = Rz(yaw)·Ry(pitch)·Rx(roll), with w ≥ 0. Configuration-time. */
export function eulerZyxToQuaternion(rollRad: number, pitchRad: number, yawRad: number): [number, number, number, number] {
  const cr = Math.cos(rollRad / 2), sr = Math.sin(rollRad / 2);
  const cp = Math.cos(pitchRad / 2), sp = Math.sin(pitchRad / 2);
  const cy = Math.cos(yawRad / 2), sy = Math.sin(yawRad / 2);
  const q: [number, number, number, number] = [cy * cp * cr + sy * sp * sr, cy * cp * sr - sy * sp * cr,
    cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr];
  const sign = q[0] < 0 ? -1 : 1, norm = Math.hypot(q[0], q[1], q[2], q[3]);
  return [sign * q[0] / norm, sign * q[1] / norm, sign * q[2] / norm, sign * q[3] / norm];
}
