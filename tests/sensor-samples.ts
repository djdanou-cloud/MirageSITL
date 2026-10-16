import type { GpsSample } from "../packages/mavlink/src/samples";
export function gpsSample(): GpsSample {
  return {
    timeLoUs: 1,
    timeHiUs: 0,
    latitudeRad: 0,
    longitudeRad: 0,
    altitudeMslM: 100,
    vnMps: 0,
    veMps: 0,
    vdMps: 0,
    hdop: 1.2,
    vdop: 2.3,
    hdopValid: true,
    vdopValid: true,
    fixType: 3,
    satellites: 14,
    satellitesValid: true,
    velocityValid: true,
    courseRad: 0,
    courseValid: true,
  };
}
