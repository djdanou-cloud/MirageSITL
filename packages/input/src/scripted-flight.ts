// Scripted flight for the TASK-073 G3 capture: a deterministic flight plan
// flown by a closed-loop pilot that only moves the sticks, exactly as a
// person would. It never writes truth; it reads the published flight state
// and produces roll/pitch/yaw/throttle for the normal pilot mailbox.
//
// Plan (times from the first update): idle with throttle 0 and request arm,
// climb over the origin to altitudeM, transit east to the circuit, fly a
// circle of circuitRadiusM around the origin at speedMps, then (when
// durationS allows) return to the origin and descend to the ground.
//
// Control (designed for the rate-commanded demo quad: sticks map to body
// rates of 1.4 rad/s roll/pitch and 1.1 rad/s yaw, hover throttle 0.5):
//   a_cmd   = KP_XY (p_target - p) + KD_XY (v_target - v) + a_feedforward   (|a| <= MAX_ACCEL)
//   a_up    = KP_Z (h_target - h) + KD_Z (vup_target - vup)                 (|a_up| <= MAX_ACCEL)
//   T       = (g + a_up) / (cos(roll) cos(pitch)),  throttle = T / (2 g)
//   roll*   = asin(a_right / T), pitch* = -asin(a_forward / T)  (FRD body, NED world)
//   rate    = K_ATT (attitude* - attitude), stick = rate / stick-rate scale
// Frames: NED world, body FRD, quaternion (w, x, y, z) body -> NED, as in the ABI.
// Constants are tuning values for this demo vehicle, verified by
// tests/scripted-flight.test.ts against DemoDynamics; they are not a model
// of any real aircraft.

const G_MPS2 = 9.80665;
const KP_XY = 0.5, KD_XY = 1.4, KP_Z = 1.0, KD_Z = 1.8;
const MAX_ACCEL_MPS2 = 4;
const K_ATT = 4, K_YAW = 1.5;
const ROLL_PITCH_RATE_RADS = 1.4, YAW_RATE_RADS = 1.1;
const IDLE_S = 1, ARM_AT_S = 0.5, DESCENT_MPS = 1.5;

export interface FlightPlan {
  altitudeM: number;
  circuitRadiusM: number;
  speedMps: number;
  /** Total plan length; the return and landing are flown when it leaves time for them. */
  durationS: number;
}

export function validateFlightPlan(plan: FlightPlan): void {
  const { altitudeM, circuitRadiusM, speedMps, durationS } = plan;
  if (![altitudeM, circuitRadiusM, speedMps, durationS].every(Number.isFinite) || altitudeM < 5 || altitudeM > 120 ||
    circuitRadiusM < 20 || circuitRadiusM > 5000 || speedMps < 1 || speedMps > 20 || durationS < 30 || durationS > 7200) {
    throw new Error("Invalid flight plan");
  }
}

/** The subset of FlightStateV2 the pilot reads (NED metres, m/s, body->NED quaternion). */
export interface FlightObservation {
  simTimeS: number;
  northM: number; eastM: number; downM: number;
  vnMps: number; veMps: number; vdMps: number;
  qw: number; qx: number; qy: number; qz: number;
}

export interface StickCommand {
  roll: number; pitch: number; yaw: number; throttle: number;
  /** True once the plan wants the vehicle armed (throttle is 0 at that moment). */
  arm: boolean;
}

export type FlightPhase = "idle" | "climb" | "transit" | "circuit" | "return" | "descend" | "done";

export function newStickCommand(): StickCommand {
  return { roll: 0, pitch: 0, yaw: 0, throttle: 0, arm: false };
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

export class ScriptedPilot {
  readonly plan: Readonly<FlightPlan>;
  phase: FlightPhase = "idle";
  private startS = Number.NaN;
  private circuitStartS = 0;
  private readonly transitS: number;
  private readonly landingStartS: number;
  // Target state, rewritten each update (no allocation).
  private tn = 0; private te = 0; private tvn = 0; private tve = 0; private tan = 0; private tae = 0;
  private th = 0; private tvup = 0; private heading = 0;
  /** Elapsed plan time of the last update, s (NaN before the first). */
  elapsedS = Number.NaN;

  constructor(plan: FlightPlan) {
    validateFlightPlan(plan);
    this.plan = Object.freeze({ ...plan });
    this.transitS = plan.circuitRadiusM / plan.speedMps;
    // Return to the origin, descend at DESCENT_MPS, and 10 s margin before the plan ends.
    this.landingStartS = plan.durationS - (this.transitS + plan.altitudeM / DESCENT_MPS + 10);
  }

  /** Writes stick commands for observation `s`; allocation-free. */
  update(s: Readonly<FlightObservation>, out: StickCommand): void {
    if (!Number.isFinite(s.simTimeS)) { this.neutral(out, false); return; }
    if (Number.isNaN(this.startS)) this.startS = s.simTimeS;
    const t = s.simTimeS - this.startS;
    this.elapsedS = t;
    const p = this.plan, altitude = -s.downM;
    if (t < IDLE_S) { this.phase = "idle"; this.neutral(out, t >= ARM_AT_S); return; }
    if (this.phase === "idle") this.phase = "climb";
    // Phase transitions.
    if (this.phase === "climb" && altitude > p.altitudeM - 1.5 && Math.abs(s.vdMps) < 1) { this.phase = "transit"; this.circuitStartS = t + this.transitS; }
    if (this.phase === "transit" && t >= this.circuitStartS) this.phase = "circuit";
    if ((this.phase === "circuit" || this.phase === "transit") && this.landingStartS > this.circuitStartS && t >= this.landingStartS) {
      this.phase = "return";
    }
    if (this.phase === "return" && Math.hypot(s.northM, s.eastM) < 3 && Math.hypot(s.vnMps, s.veMps) < 1) this.phase = "descend";
    if (this.phase === "descend" && altitude < 0.05 && Math.abs(s.vdMps) < 0.2) this.phase = "done";
    if (this.phase === "done") { this.neutral(out, false); return; }
    this.target(s, t);
    this.fly(s, out);
  }

  private target(s: Readonly<FlightObservation>, t: number): void {
    const p = this.plan;
    this.tan = 0; this.tae = 0; this.tvup = 0; this.th = p.altitudeM;
    switch (this.phase) {
      case "climb":
        this.tn = 0; this.te = 0; this.tvn = 0; this.tve = 0;
        break;
      case "transit": {
        const d = clamp((t - (this.circuitStartS - this.transitS)) * p.speedMps, 0, p.circuitRadiusM);
        this.tn = 0; this.te = d; this.tvn = 0; this.tve = d < p.circuitRadiusM ? p.speedMps : 0;
        break;
      }
      case "circuit": {
        // Counter-clockwise seen from above (north -> west): start east of the origin heading north.
        const w = p.speedMps / p.circuitRadiusM, a = w * (t - this.circuitStartS);
        const c = Math.cos(a), sn = Math.sin(a), r = p.circuitRadiusM;
        this.te = r * c; this.tn = r * sn;
        this.tve = -r * w * sn; this.tvn = r * w * c;
        this.tae = -r * w * w * c; this.tan = -r * w * w * sn;
        break;
      }
      case "return": {
        // Straight line back to the origin at plan speed from wherever the return began.
        const dist = Math.hypot(s.northM, s.eastM);
        const speed = Math.min(p.speedMps, 0.5 * dist);
        this.tn = 0; this.te = 0;
        this.tvn = dist > 0.1 ? -speed * s.northM / dist : 0; this.tve = dist > 0.1 ? -speed * s.eastM / dist : 0;
        break;
      }
      case "descend":
        this.tn = 0; this.te = 0; this.tvn = 0; this.tve = 0;
        this.th = 0; this.tvup = -DESCENT_MPS;
        break;
      default:
        break;
    }
    const sp = Math.hypot(this.tvn, this.tve);
    if (sp > 1) this.heading = Math.atan2(this.tve, this.tvn);
  }

  private fly(s: Readonly<FlightObservation>, out: StickCommand): void {
    const { qw, qx, qy, qz } = s;
    const roll = Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy));
    const pitch = Math.asin(clamp(2 * (qw * qy - qz * qx), -1, 1));
    const yaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
    // Horizontal acceleration command (NED), limited in magnitude.
    let an = KP_XY * (this.tn - s.northM) + KD_XY * (this.tvn - s.vnMps) + this.tan;
    let ae = KP_XY * (this.te - s.eastM) + KD_XY * (this.tve - s.veMps) + this.tae;
    const ah = Math.hypot(an, ae);
    if (ah > MAX_ACCEL_MPS2) { an *= MAX_ACCEL_MPS2 / ah; ae *= MAX_ACCEL_MPS2 / ah; }
    // During descent the error target is the ground; a fixed sink rate rules instead.
    const descending = this.phase === "descend";
    const aUp = clamp(descending ? KD_Z * (this.tvup + s.vdMps) : KP_Z * (this.th + s.downM) + KD_Z * (this.tvup + s.vdMps), -MAX_ACCEL_MPS2, MAX_ACCEL_MPS2);
    const tilt = Math.max(0.5, Math.cos(roll) * Math.cos(pitch));
    const thrust = (G_MPS2 + aUp) / tilt;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const aForward = an * cy + ae * sy, aRight = -an * sy + ae * cy;
    const rollTarget = Math.asin(clamp(aRight / thrust, -0.6, 0.6));
    const pitchTarget = -Math.asin(clamp(aForward / thrust, -0.6, 0.6));
    out.roll = clamp(K_ATT * (rollTarget - roll) / ROLL_PITCH_RATE_RADS, -1, 1);
    out.pitch = clamp(K_ATT * (pitchTarget - pitch) / ROLL_PITCH_RATE_RADS, -1, 1);
    out.yaw = clamp(K_YAW * wrapPi(this.heading - yaw) / YAW_RATE_RADS, -1, 1);
    out.throttle = clamp(thrust / (2 * G_MPS2), 0.05, 0.95);
    out.arm = true;
  }

  private neutral(out: StickCommand, arm: boolean): void {
    out.roll = 0; out.pitch = 0; out.yaw = 0; out.throttle = 0; out.arm = arm;
  }
}
