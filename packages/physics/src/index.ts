import { ControlFlag, DT, INPUT_TIMEOUT_MS, StateFlag, newState,
  type FlightState, type PilotInput } from '@mirage/protocol';

const clamp = (x: number) => Math.max(-1, Math.min(1, x));
const SPOOL_RESPONSE = 1 - Math.exp(-DT / 0.075);
const RATE_RESPONSE = 1 - Math.exp(-DT / 0.09);

/** Demonstrator only: rate-controlled toy quad, no rotor BET or autopilot. */
export class DemoDynamics {
  readonly state: FlightState = newState();
  reset(): void { Object.assign(this.state, newState()); }
  step(input: PilotInput, nowMs: number): void {
    const s = this.state;
    const age = nowMs - input.wallTimeMs;
    const valid = (input.flags & (ControlFlag.Connected | ControlFlag.Armed)) === 3 &&
      Number.isFinite(age) && age >= 0 && age <= INPUT_TIMEOUT_MS &&
      Number.isFinite(input.roll) && Number.isFinite(input.pitch) &&
      Number.isFinite(input.yaw) && Number.isFinite(input.throttle);
    const throttle = valid ? Math.max(0, Math.min(1, input.throttle)) : 0;
    // Fail-safe kills target thrust immediately; rotor momentum still decays.
    s.spool += (throttle - s.spool) * SPOOL_RESPONSE;
    const response = RATE_RESPONSE;
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
    const norm = Math.hypot(s.qw, s.qx, s.qy, s.qz);
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
      s.down = 0; s.vd = Math.min(0, s.vd); s.flags |= StateFlag.OnGround;
    }
    s.batteryVoltage = 12.6 - 0.8 * s.spool;
    s.tick++; s.simTime = s.tick * DT; s.wallTimeMs = nowMs;
  }
}

/** Fixed integration dt; wall-clock deadlines may slip. No unbounded catch-up. */
export class FixedStepClock {
  nextMs = 0;
  droppedSteps = 0;
  overruns = 0;
  readonly stepMs = DT * 1000;
  constructor(readonly maxCatchUp = 8) {}
  reset(nowMs: number) { this.nextMs = nowMs + this.stepMs; }
  advance(nowMs: number, step: () => void): number {
    let count = 0;
    while (nowMs >= this.nextMs && count < this.maxCatchUp) {
      step(); count++; this.nextMs += this.stepMs;
    }
    if (nowMs >= this.nextMs) {
      const dropped = Math.floor((nowMs - this.nextMs) / this.stepMs) + 1;
      this.nextMs += dropped * this.stepMs;
      this.droppedSteps += dropped; this.overruns++;
    }
    return count;
  }
}
