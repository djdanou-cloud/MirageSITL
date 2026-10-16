/** Float64 model observations; separate from quantized transport. Times are u64 words. */
export interface GpsSample {
  timeLoUs: number;
  timeHiUs: number;
  latitudeRad: number;
  longitudeRad: number;
  altitudeMslM: number;
  vnMps: number;
  veMps: number;
  vdMps: number;
  hdop: number;
  vdop: number;
  hdopValid: boolean;
  vdopValid: boolean;
  fixType: number;
  satellites: number;
  satellitesValid: boolean;
  velocityValid: boolean;
  courseRad: number;
  courseValid: boolean;
}
export interface ImuSample {
  timeLoUs: number;
  timeHiUs: number;
  specificForceBodyMps2: Float64Array;
  gyroBodyRadS: Float64Array;
  magBodyGauss: Float64Array;
  pressurePa: number;
  differentialPressurePa: number;
  pressureAltitudeM: number;
  temperatureK: number;
  updatedMask: number;
}
export function copyGpsInto(s: GpsSample, t: GpsSample): void {
  t.timeLoUs = s.timeLoUs;
  t.timeHiUs = s.timeHiUs;
  t.latitudeRad = s.latitudeRad;
  t.longitudeRad = s.longitudeRad;
  t.altitudeMslM = s.altitudeMslM;
  t.vnMps = s.vnMps;
  t.veMps = s.veMps;
  t.vdMps = s.vdMps;
  t.hdop = s.hdop;
  t.vdop = s.vdop;
  t.hdopValid = s.hdopValid;
  t.vdopValid = s.vdopValid;
  t.fixType = s.fixType;
  t.satellites = s.satellites;
  t.satellitesValid = s.satellitesValid;
  t.velocityValid = s.velocityValid;
  t.courseRad = s.courseRad;
  t.courseValid = s.courseValid;
}
export function validGps(s: GpsSample): boolean {
  return (
    s.timeLoUs >>> 0 === s.timeLoUs &&
    s.timeHiUs >>> 0 === s.timeHiUs &&
    Math.abs(s.latitudeRad) <= Math.PI / 2 &&
    Math.abs(s.longitudeRad) <= Math.PI &&
    Number.isFinite(s.altitudeMslM) &&
    Number.isFinite(s.vnMps) &&
    Number.isFinite(s.veMps) &&
    Number.isFinite(s.vdMps) &&
    Number.isFinite(s.hdop) &&
    s.hdop >= 0 &&
    Number.isFinite(s.vdop) &&
    s.vdop >= 0 &&
    Number.isInteger(s.fixType) &&
    s.fixType >= 0 &&
    s.fixType <= 8 &&
    Number.isInteger(s.satellites) &&
    s.satellites >= 0 &&
    (s.satellites <= 254 || (!s.satellitesValid && s.satellites === 255)) &&
    Number.isFinite(s.courseRad)
  );
}
