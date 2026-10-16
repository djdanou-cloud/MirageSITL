import { validGps, type GpsSample, type ImuSample } from "./samples.ts";
/** Reusable payloads. clipped is a diagnostic, never a wrapped integer or reserved sentinel. */
export class SensorMapping {
  readonly gps = new Uint8Array(39);
  readonly sensor = new Uint8Array(65);
  private readonly g = new DataView(this.gps.buffer);
  private readonly s = new DataView(this.sensor.buffer);
  clipped = false;
  private quantize(value: number, min: number, max: number): number {
    const rounded = Math.round(value);
    if (rounded < min || rounded > max) this.clipped = true;
    return Math.max(min, Math.min(max, rounded));
  }
  gpsInto(x: GpsSample): boolean {
    if (!validGps(x)) return false;
    this.clipped = false;
    const g = this.g;
    g.setUint32(0, x.timeLoUs, true);
    g.setUint32(4, x.timeHiUs, true);
    g.setInt32(8, Math.round(((x.latitudeRad * 180) / Math.PI) * 1e7), true);
    g.setInt32(12, Math.round(((x.longitudeRad * 180) / Math.PI) * 1e7), true);
    g.setInt32(
      16,
      this.quantize(x.altitudeMslM * 1000, -2147483648, 2147483647),
      true,
    );
    g.setUint16(
      20,
      x.hdopValid ? this.quantize(x.hdop * 100, 0, 65534) : 65535,
      true,
    );
    g.setUint16(
      22,
      x.vdopValid ? this.quantize(x.vdop * 100, 0, 65534) : 65535,
      true,
    );
    const a = Math.abs(x.vnMps),
      b = Math.abs(x.veMps),
      scale = Math.max(a, b);
    const speed =
      scale === 0
        ? 0
        : scale *
          Math.sqrt((a / scale) * (a / scale) + (b / scale) * (b / scale));
    g.setUint16(
      24,
      x.velocityValid ? this.quantize(speed * 100, 0, 65534) : 65535,
      true,
    );
    g.setInt16(
      26,
      x.velocityValid ? this.quantize(x.vnMps * 100, -32767, 32767) : 0,
      true,
    );
    g.setInt16(
      28,
      x.velocityValid ? this.quantize(x.veMps * 100, -32767, 32767) : 0,
      true,
    );
    g.setInt16(
      30,
      x.velocityValid ? this.quantize(x.vdMps * 100, -32767, 32767) : 0,
      true,
    );
    const course =
      ((((x.courseRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * 180) /
      Math.PI;
    g.setUint16(
      32,
      x.velocityValid && x.courseValid && speed >= 0.05
        ? Math.round(course * 100) % 36000
        : 65535,
      true,
    );
    g.setUint8(34, x.fixType);
    g.setUint8(35, x.satellitesValid ? x.satellites : 255);
    g.setUint8(36, 0);
    g.setUint16(37, 0, true);
    return true;
  }
  sensorInto(x: ImuSample): boolean {
    if (
      x.timeLoUs >>> 0 !== x.timeLoUs ||
      x.timeHiUs >>> 0 !== x.timeHiUs ||
      x.specificForceBodyMps2.length !== 3 ||
      x.gyroBodyRadS.length !== 3 ||
      x.magBodyGauss.length !== 3 ||
      x.updatedMask >>> 0 !== x.updatedMask ||
      (x.updatedMask & 0x7fffe000) !== 0 ||
      !Number.isFinite(x.pressurePa) ||
      !Number.isFinite(x.differentialPressurePa) ||
      !Number.isFinite(x.pressureAltitudeM) ||
      !Number.isFinite(x.temperatureK) ||
      Math.abs(x.pressurePa) > 3e38 ||
      Math.abs(x.differentialPressurePa) > 3e38 ||
      Math.abs(x.pressureAltitudeM) > 3e38 ||
      Math.abs(x.temperatureK) > 3e38
    )
      return false;
    for (let i = 0; i < 3; i++)
      if (
        !Number.isFinite(x.specificForceBodyMps2[i]) ||
        !Number.isFinite(x.gyroBodyRadS[i]) ||
        !Number.isFinite(x.magBodyGauss[i]) ||
        Math.abs(x.specificForceBodyMps2[i]!) > 3e38 ||
        Math.abs(x.gyroBodyRadS[i]!) > 3e38 ||
        Math.abs(x.magBodyGauss[i]!) > 3e38
      )
        return false;
    const s = this.s;
    s.setUint32(0, x.timeLoUs, true);
    s.setUint32(4, x.timeHiUs, true);
    for (let i = 0; i < 3; i++) {
      s.setFloat32(8 + i * 4, x.specificForceBodyMps2[i]!, true);
      s.setFloat32(20 + i * 4, x.gyroBodyRadS[i]!, true);
      s.setFloat32(32 + i * 4, x.magBodyGauss[i]!, true);
    }
    s.setFloat32(44, x.pressurePa / 100, true);
    s.setFloat32(48, x.differentialPressurePa / 100, true);
    s.setFloat32(52, x.pressureAltitudeM, true);
    s.setFloat32(56, x.temperatureK - 273.15, true);
    s.setUint32(60, x.updatedMask, true);
    s.setUint8(64, 0);
    return true;
  }
}
