import {
  SLOT_VALUES,
  SensorKindV2,
  SensorValidityV2,
  type SensorFrameV2,
  type TickId,
} from "@mirage/protocol";
import type { BodyTruth } from "@mirage/wasm-bet/backend";
/** Gravity belongs to inertial acceleration, not accelerometer specific force. */
export interface SensorTruth extends BodyTruth {
  epoch: number;
  tickId: TickId;
  sampleTimeUs: TickId;
  windNedMps: Float64Array;
}
/** SI/FRD synthetic ideal observations. No GNSS/geoid model is implied. */
export class IdealSensors {
  private readonly magnetic: Float64Array;
  private readonly scratch = new Float64Array(SLOT_VALUES);
  constructor(
    magneticNedGauss: readonly [number, number, number],
    private readonly originAltitudeM = 0,
    private readonly gravityMps2 = 9.80665,
  ) {
    if (
      !magneticNedGauss.every(Number.isFinite) ||
      !Number.isFinite(originAltitudeM) ||
      originAltitudeM < 0 ||
      originAltitudeM > 11000 ||
      !Number.isFinite(gravityMps2) ||
      gravityMps2 < 0
    )
      throw new Error("Invalid ideal sensor configuration");
    this.magnetic = new Float64Array(magneticNedGauss);
  }
  /** Body-frame conjugate rotation into reusable scalar storage. */
  private rotateInto(q: Float64Array, x: number, y: number, z: number): void {
    const w = q[0]!,
      qx = -q[1]!,
      qy = -q[2]!,
      qz = -q[3]!;
    const tx = 2 * (qy * z - qz * y),
      ty = 2 * (qz * x - qx * z),
      tz = 2 * (qx * y - qy * x);
    this.scratch[0] = x + w * tx + qy * tz - qz * ty;
    this.scratch[1] = y + w * ty + qz * tx - qx * tz;
    this.scratch[2] = z + w * tz + qx * ty - qy * tx;
  }
  sampleInto(kind: number, t: SensorTruth, out: SensorFrameV2): boolean {
    if (
      kind !== SensorKindV2.Imu &&
      kind !== SensorKindV2.Magnetometer &&
      kind !== SensorKindV2.Barometer &&
      kind !== SensorKindV2.Airspeed
    )
      return false;
    if (
      t.positionNedM.length !== 3 ||
      t.velocityNedMps.length !== 3 ||
      t.windNedMps.length !== 3 ||
      t.accelerationNedMps2.length !== 3 ||
      t.angularVelocityBodyRadS.length !== 3 ||
      t.quaternionBodyToNed.length !== 4 ||
      out.values.length !== SLOT_VALUES ||
      out.geoLatLonAlt.length !== 3 ||
      t.epoch >>> 0 !== t.epoch ||
      t.tickId.lo >>> 0 !== t.tickId.lo ||
      t.tickId.hi >>> 0 !== t.tickId.hi ||
      t.sampleTimeUs.lo >>> 0 !== t.sampleTimeUs.lo ||
      t.sampleTimeUs.hi >>> 0 !== t.sampleTimeUs.hi
    )
      return false;
    for (let i = 0; i < 3; i++)
      if (
        !Number.isFinite(t.positionNedM[i]) ||
        !Number.isFinite(t.velocityNedMps[i]) ||
        !Number.isFinite(t.windNedMps[i]) ||
        !Number.isFinite(t.accelerationNedMps2[i]) ||
        !Number.isFinite(t.angularVelocityBodyRadS[i])
      )
        return false;
    const q = t.quaternionBodyToNed,
      norm = Math.sqrt(
        q[0]! * q[0]! + q[1]! * q[1]! + q[2]! * q[2]! + q[3]! * q[3]!,
      );
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-6) return false;
    this.scratch.fill(0);
    let count = 0;
    if (kind === SensorKindV2.Imu) {
      this.rotateInto(
        q,
        t.accelerationNedMps2[0]!,
        t.accelerationNedMps2[1]!,
        t.accelerationNedMps2[2]! - this.gravityMps2,
      );
      for (let i = 0; i < 3; i++)
        this.scratch[i + 3] = t.angularVelocityBodyRadS[i]!;
      count = 6;
    } else if (kind === SensorKindV2.Magnetometer) {
      this.rotateInto(
        q,
        this.magnetic[0]!,
        this.magnetic[1]!,
        this.magnetic[2]!,
      );
      count = 3;
    } else {
      const altitude = this.originAltitudeM - t.positionNedM[2]!;
      if (altitude < -1000 || altitude > 11000) return false;
      const temperature = 288.15 - 0.0065 * altitude,
        pressure =
          101325 * (temperature / 288.15) ** (9.80665 / (287.05287 * 0.0065));
      if (kind === SensorKindV2.Barometer) {
        this.scratch[0] = pressure;
        this.scratch[1] = altitude;
        this.scratch[2] = temperature;
        count = 3;
      } else {
        const vn = t.velocityNedMps[0]! - t.windNedMps[0]!,
          ve = t.velocityNedMps[1]! - t.windNedMps[1]!,
          vd = t.velocityNedMps[2]! - t.windNedMps[2]!;
        this.scratch[0] =
          ((0.5 * pressure) / (287.05287 * temperature)) *
          (vn * vn + ve * ve + vd * vd);
        count = 1;
      }
    }
    for (let i = 0; i < count; i++)
      if (
        !Number.isFinite(this.scratch[i]) ||
        Math.abs(this.scratch[i]!) > 3e38
      )
        return false;
    out.values.set(this.scratch);
    out.geoLatLonAlt.fill(0);
    out.kind = kind;
    out.valueCount = count;
    out.epoch = t.epoch;
    out.tickId.lo = t.tickId.lo;
    out.tickId.hi = t.tickId.hi;
    out.sampleTimeUs.lo = t.sampleTimeUs.lo;
    out.sampleTimeUs.hi = t.sampleTimeUs.hi;
    out.sourceId = 0;
    out.validityFlags =
      SensorValidityV2.PayloadValid | SensorValidityV2.TimestampValid;
    return true;
  }
}
