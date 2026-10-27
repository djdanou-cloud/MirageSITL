import { ControlFlag, INPUT_CLOCK_TOLERANCE_MS, INPUT_TIMEOUT_MS, StateFlag, isPhysicsHz, newState,
  type FlightState, type PhysicsHz, type PilotInput } from '@mirage/protocol';

const clamp = (x: number) => Math.max(-1, Math.min(1, x));

/** Demonstrator only: rate-controlled toy quad, no rotor BET or autopilot. */
export class DemoDynamics {
  readonly state: FlightState = newState();
  readonly hz: PhysicsHz;
  private readonly dt: number;
  // First-order lags discretized exactly for this dt, so responses match across rates.
  private readonly spoolResponse: number;
  private readonly rateResponse: number;
  constructor(hz: PhysicsHz = 400) {
    if (!isPhysicsHz(hz)) throw new Error('Unsupported physics rate');
    this.hz = hz; this.dt = 1 / hz;
    this.spoolResponse = 1 - Math.exp(-this.dt / 0.075);
    this.rateResponse = 1 - Math.exp(-this.dt / 0.09);
  }
  /** Wall time (ms) for stepNow(); a field, not an argument, so the hot path never boxes a double. */
  nowMs = 0.5;
  reset(): void { Object.assign(this.state, newState()); }
  step(input: PilotInput, nowMs: number): void {
    this.nowMs = nowMs;
    this.stepNow(input);
  }
  /** step() at `this.nowMs`; allocation-free. */
  stepNow(input: PilotInput): void {
    const s = this.state, DT = this.dt, nowMs = this.nowMs;
    const age = nowMs - input.wallTimeMs;
    const valid = (input.flags & (ControlFlag.Connected | ControlFlag.Armed)) === 3 &&
      Number.isFinite(age) && age >= -INPUT_CLOCK_TOLERANCE_MS && age <= INPUT_TIMEOUT_MS &&
      Number.isFinite(input.roll) && Number.isFinite(input.pitch) &&
      Number.isFinite(input.yaw) && Number.isFinite(input.throttle);
    const throttle = valid ? Math.max(0, Math.min(1, input.throttle)) : 0;
    // Fail-safe kills target thrust immediately; rotor momentum still decays.
    s.spool += (throttle - s.spool) * this.spoolResponse;
    const response = this.rateResponse;
    const authority = valid ? Math.min(1, s.spool * 4) : 0;
    s.p += (authority * clamp(input.roll || 0) * 1.4 - s.p) * response;
    s.q += (authority * clamp(input.pitch || 0) * 1.4 - s.q) * response;
    s.r += (authority * clamp(input.yaw || 0) * 1.1 - s.r) * response;
    const { qw: w, qx: x, qy: y, qz: z } = s;
    // q_dot = 1/2 q ⊗ [0, omega_body]. Renormalize each fixed step.
    s.qw += (-x * s.p - y * s.q - z * s.r) * DT / 2;
    s.qx += (w * s.p + y * s.r - z * s.q) * DT / 2;
    s.qy += (w * s.q + z * s.p - x * s.r) * DT / 2;
    s.qz += (w * s.r + x * s.q - y * s.p) * DT / 2;
    // Math.sqrt of the sum of squares: variadic Math.hypot allocates on every call in V8 (TASK-014 measurement).
    const norm = Math.sqrt(s.qw * s.qw + s.qx * s.qx + s.qy * s.qy + s.qz * s.qz);
    s.qw /= norm; s.qx /= norm; s.qy /= norm; s.qz /= norm;
    const thrust = 2 * 9.80665 * s.spool;
    // Body -Z thrust transformed to world NED. Acceleration is inertial,
    // including gravity, NOT accelerometer specific force for HIL_SENSOR.
    s.an = -thrust * 2 * (s.qx * s.qz + s.qw * s.qy) - 0.18 * s.vn;
    s.ae = -thrust * 2 * (s.qy * s.qz - s.qw * s.qx) - 0.18 * s.ve;
    s.ad = 9.80665 - thrust * (1 - 2 * (s.qx ** 2 + s.qy ** 2)) - 0.18 * s.vd;
    s.vn += s.an * DT; s.ve += s.ae * DT; s.vd += s.ad * DT;
    s.north += s.vn * DT; s.east += s.ve * DT; s.down += s.vd * DT;
    s.flags = valid ? 0 : StateFlag.InputFailsafe;
    if (s.down >= 0) {
      // Contact cancels any downward acceleration: report kinematic dv/dt, not free fall.
      s.down = 0; s.vd = Math.min(0, s.vd); s.ad = Math.min(0, s.ad); s.flags |= StateFlag.OnGround;
    }
    s.batteryVoltage = 12.6 - 0.8 * s.spool;
    s.tick++; s.simTime = s.tick / this.hz; s.wallTimeMs = nowMs;
  }
}
