// Coherent GNSS drift (TASK-055), docs/SPECS_SIMULATION_ENGINES.md section 5:
//
//   v_d(k+1) = v_d(k) + a_d dt,  b(k+1) = b(k) + v_d(k) dt + a_d dt^2 / 2,
//   p_GPS' = p_GPS + b,          v_GPS' = v_GPS + v_d.
//
// State advances on every physics step, independently of GNSS or render
// rates. When |v_d| reaches maxSpeed mid-step the step is split at the exact
// cap time and continues at constant velocity, so b stays the integral of v_d.
// On disable, "hold-offset" decelerates v_d at decelMps2 while integrating b
// and then holds b; "step-to-truth" zeroes b and v_d as an explicit
// discontinuity (counted for AAR). b is never faded without its derivative.
// Coherent errors do not guarantee bypassing any EKF gate. Allocation-free.
import { copyGpsInto, validGps, type GpsSample } from "../../mavlink/src/samples.ts";
import { NO_GEOID, type GeoidModel } from "@mirage/sensors/geoid";
import { GpsOffsetApplier, MAX_OFFSET_M } from "./position-step.ts";

export type DriftRecovery = "hold-offset" | "step-to-truth";
export type DriftMode = "off" | "drifting" | "decelerating" | "holding";

export interface DriftPreset {
  /** Constant drift acceleration, NED m/s^2 (typical magnitude 0.1..0.3). */
  accelNedMps2: readonly [number, number, number];
  /** Speed cap for |v_d|, m/s. */
  maxSpeedMps: number;
  /** Deceleration used by hold-offset recovery, m/s^2. */
  decelMps2: number;
  recovery: DriftRecovery;
}

/** Below this horizontal speed course is unknown (section 6). */
const COURSE_MIN_SPEED_MPS = 0.05;
const TWO_PI = 2 * Math.PI;

export class VelocityDrift {
  /** Position offset b, NED m. */
  readonly offsetNedM = new Float64Array(3);
  /** Drift velocity v_d, NED m/s. */
  readonly velocityNedMps = new Float64Array(3);
  /** step-to-truth discontinuities since reset (each needs an AAR event). */
  discontinuities = 0;
  private modeValue: DriftMode = "off";
  private readonly accel = new Float64Array(3);
  private maxSpeed = 0;
  private decel = 0;
  private recovery: DriftRecovery = "hold-offset";
  private readonly applier: GpsOffsetApplier;

  constructor(geoid: GeoidModel = NO_GEOID) {
    this.applier = new GpsOffsetApplier(geoid);
  }

  get mode(): DriftMode { return this.modeValue; }

  /** Starts (or retargets) drift from the current b and v_d; false for an invalid preset. */
  enable(preset: DriftPreset): boolean {
    const [an, ae, ad] = preset.accelNedMps2;
    const aMag = Math.sqrt(an * an + ae * ae + ad * ad);
    if (!Number.isFinite(aMag) || aMag > 5 || !(preset.maxSpeedMps > 0 && preset.maxSpeedMps <= 50) ||
      !(preset.decelMps2 > 0 && preset.decelMps2 <= 5) ||
      (preset.recovery !== "hold-offset" && preset.recovery !== "step-to-truth")) return false;
    this.accel[0] = an; this.accel[1] = ae; this.accel[2] = ad;
    this.maxSpeed = preset.maxSpeedMps;
    this.decel = preset.decelMps2;
    this.recovery = preset.recovery;
    this.modeValue = "drifting";
    return true;
  }

  /** Ends drift according to the preset's recovery policy. */
  disable(): void {
    if (this.modeValue === "off") return;
    if (this.recovery === "step-to-truth") {
      this.offsetNedM.fill(0);
      this.velocityNedMps.fill(0);
      this.modeValue = "off";
      this.discontinuities++;
      return;
    }
    this.modeValue = this.speed() > 0 ? "decelerating" : "holding";
  }

  reset(): void {
    this.offsetNedM.fill(0);
    this.velocityNedMps.fill(0);
    this.accel.fill(0);
    this.modeValue = "off";
    this.discontinuities = 0;
  }

  private speed(): number {
    const v = this.velocityNedMps;
    const x = v[0] as number, y = v[1] as number, z = v[2] as number; // fixed length 3
    return Math.sqrt(x * x + y * y + z * z);
  }

  /** Integrates b and v_d over `a` for `t` seconds (exact for constant a). */
  private integrate(ax: number, ay: number, az: number, t: number): void {
    const b = this.offsetNedM, v = this.velocityNedMps, h = 0.5 * t * t;
    b[0] = (b[0] as number) + (v[0] as number) * t + ax * h;
    b[1] = (b[1] as number) + (v[1] as number) * t + ay * h;
    b[2] = (b[2] as number) + (v[2] as number) * t + az * h;
    v[0] = (v[0] as number) + ax * t;
    v[1] = (v[1] as number) + ay * t;
    v[2] = (v[2] as number) + az * t;
  }

  /** One physics step. Returns false (state unchanged) for an invalid dt or an offset beyond 10 km. */
  advance(dtS: number): boolean {
    if (!(dtS > 0 && dtS <= 0.01)) return false;
    const v = this.velocityNedMps;
    switch (this.modeValue) {
      case "off":
      case "holding":
        return true;
      case "drifting": {
        const ax = this.accel[0] as number, ay = this.accel[1] as number, az = this.accel[2] as number;
        const vx = v[0] as number, vy = v[1] as number, vz = v[2] as number;
        const ex = vx + ax * dtS, ey = vy + ay * dtS, ez = vz + az * dtS;
        const cap = this.maxSpeed;
        if (ex * ex + ey * ey + ez * ez <= cap * cap) {
          this.integrate(ax, ay, az, dtS);
        } else {
          // Smallest t in [0, dt] with |v + a t| = cap: |a|^2 t^2 + 2 (v.a) t + |v|^2 - cap^2 = 0.
          const aa = ax * ax + ay * ay + az * az, va = vx * ax + vy * ay + vz * az;
          const c = vx * vx + vy * vy + vz * vz - cap * cap;
          let tc = 0;
          if (c < 0 && aa > 0) tc = (-va + Math.sqrt(va * va - aa * c)) / aa; // c < 0 gives one positive root
          if (tc > dtS) tc = dtS;
          this.integrate(ax, ay, az, tc);
          const s = this.speed();
          if (s > 0) { const k = cap / s; v[0] = (v[0] as number) * k; v[1] = (v[1] as number) * k; v[2] = (v[2] as number) * k; }
          this.integrate(0, 0, 0, dtS - tc); // constant velocity at the cap
        }
        break;
      }
      case "decelerating": {
        const s = this.speed();
        if (s === 0) { this.modeValue = "holding"; return true; }
        const k = -this.decel / s;
        const ax = (v[0] as number) * k, ay = (v[1] as number) * k, az = (v[2] as number) * k;
        const stopS = s / this.decel;
        if (stopS > dtS) {
          this.integrate(ax, ay, az, dtS);
        } else {
          this.integrate(ax, ay, az, stopS);
          v.fill(0);
          this.modeValue = "holding";
        }
        break;
      }
      default: {
        const never: never = this.modeValue;
        throw new Error(`Unhandled drift mode ${String(never)}`);
      }
    }
    const b = this.offsetNedM;
    const bx = b[0] as number, by = b[1] as number, bz = b[2] as number;
    if (!(bx * bx + by * by + bz * bz <= MAX_OFFSET_M * MAX_OFFSET_M)) {
      // Beyond the supported envelope: stop growing and hold rather than wrap or extrapolate.
      v.fill(0);
      this.modeValue = "holding";
    }
    return true;
  }

  /**
   * Copies `source` into `target`, adds b to the position (through WGS84) and
   * v_d to the velocity, and recomputes course from the corrupted horizontal
   * velocity. Returns false with `target` untouched for an invalid source.
   */
  distortGpsInto(source: GpsSample, target: GpsSample): boolean {
    if (source === target || !validGps(source)) return false;
    copyGpsInto(source, target);
    if (this.modeValue === "off") return true;
    const b = this.offsetNedM, v = this.velocityNedMps;
    if (!this.applier.applyInto(source, b[0] as number, b[1] as number, b[2] as number, target)) {
      copyGpsInto(source, target);
      return false;
    }
    if (source.velocityValid) {
      target.vnMps = source.vnMps + (v[0] as number);
      target.veMps = source.veMps + (v[1] as number);
      target.vdMps = source.vdMps + (v[2] as number);
      const speed = Math.sqrt(target.vnMps * target.vnMps + target.veMps * target.veMps);
      target.courseValid = speed >= COURSE_MIN_SPEED_MPS;
      if (target.courseValid) {
        const course = Math.atan2(target.veMps, target.vnMps);
        target.courseRad = course < 0 ? course + TWO_PI : course;
      }
    }
    return true;
  }
}
