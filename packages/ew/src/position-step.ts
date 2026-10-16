// GNSS position-step spoofing (TASK-054), docs/SPECS_SIMULATION_ENGINES.md
// section 5 "Position steps and coherent velocity drift". A step adds a
// constant NED offset to the reported GPS position from a scheduled physics
// tick on, preserving the baseline GPS velocity. The discontinuity is
// intentional and does not imply any particular EKF reaction. Truth and the
// source sample are never modified. Allocation-free after construction.
import { copyGpsInto, validGps, type GpsSample } from "../../mavlink/src/samples.ts";
import { LocalTangentFrame } from "@mirage/sensors/geodesy";
import { NO_GEOID, type GeoidModel } from "@mirage/sensors/geoid";

/** Largest offset magnitude accepted, m (section 5: production offsets up to 10 km). */
export const MAX_OFFSET_M = 10_000;

/**
 * Moves a GPS fix by an NED offset defined in the fix's own local tangent
 * frame, through WGS84 ECEF: MSL height becomes ellipsoidal height with the
 * geoid, the offset is applied, and the result converts back to MSL. Writes
 * latitude/longitude/altitude of `target` only. Returns false (target
 * untouched) for an invalid fix or a pole-crossing that leaves the frame.
 */
export class GpsOffsetApplier {
  private readonly frame = new LocalTangentFrame(0, 0, 0);
  private readonly geodetic = new Float64Array(3);
  constructor(private readonly geoid: GeoidModel = NO_GEOID) {}

  applyInto(source: GpsSample, northM: number, eastM: number, downM: number, target: GpsSample): boolean {
    const g = this.geoid;
    const h = source.altitudeMslM + g.undulationM(source.latitudeRad, source.longitudeRad);
    if (!this.frame.setOrigin(source.latitudeRad, source.longitudeRad, h)) return false;
    const out = this.geodetic;
    this.frame.nedToGeodeticInto(northM, eastM, downM, out);
    const lat = out[0] as number, lon = out[1] as number, height = out[2] as number; // fixed length 3
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(height)) return false;
    target.latitudeRad = lat;
    target.longitudeRad = lon;
    target.altitudeMslM = height - g.undulationM(lat, lon);
    return true;
  }
}

/** One scheduled position step. */
export class PositionStep {
  /** Offset north/east/down, m, applied while active. */
  readonly offsetNedM = new Float64Array(3);
  private readonly pending = new Float64Array(3);
  private pendingTick = -1;
  private active = false;
  private readonly applier: GpsOffsetApplier;

  constructor(geoid: GeoidModel = NO_GEOID) {
    this.applier = new GpsOffsetApplier(geoid);
  }

  get isActive(): boolean { return this.active; }
  /** Physics tick at which the scheduled step applies, or -1. */
  get scheduledTick(): number { return this.pendingTick; }

  /**
   * Schedules an offset to take effect at physics tick `atTick` (a safe
   * integer). Returns false for a non-finite offset, |offset| > 10 km, or an
   * invalid tick. A zero offset is valid and changes nothing.
   */
  schedule(northM: number, eastM: number, downM: number, atTick: number): boolean {
    const magnitude = Math.sqrt(northM * northM + eastM * eastM + downM * downM);
    if (!(magnitude <= MAX_OFFSET_M) || !Number.isSafeInteger(atTick) || atTick < 0) return false;
    this.pending[0] = northM; this.pending[1] = eastM; this.pending[2] = downM;
    this.pendingTick = atTick;
    return true;
  }

  /** Called once per physics tick; applies a due step atomically (all three axes at once). */
  advanceTick(tick: number): void {
    if (this.pendingTick >= 0 && tick >= this.pendingTick) {
      this.offsetNedM.set(this.pending);
      this.active = true;
      this.pendingTick = -1;
    }
  }

  /** Stops spoofing: the next sample is the baseline again. A pending step is cancelled. */
  disable(): void {
    this.active = false;
    this.pendingTick = -1;
    this.offsetNedM.fill(0);
  }

  reset(): void { this.disable(); this.pending.fill(0); }

  /**
   * Copies `source` into `target` and, while active, moves the position by
   * the offset. Velocity, DOP, fix and time are preserved. Returns false
   * with `target` untouched for an invalid source or source === target, and
   * false with `target` equal to the baseline if the conversion fails.
   */
  distortInto(source: GpsSample, target: GpsSample): boolean {
    if (source === target || !validGps(source)) return false;
    const o = this.offsetNedM;
    if (!this.active || (o[0] === 0 && o[1] === 0 && o[2] === 0)) { copyGpsInto(source, target); return true; } // zero is exact identity
    copyGpsInto(source, target);
    if (!this.applier.applyInto(source, o[0] as number, o[1] as number, o[2] as number, target)) {
      copyGpsInto(source, target);
      return false;
    }
    return true;
  }
}
