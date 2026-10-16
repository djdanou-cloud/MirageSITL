// Observation pipeline (TASK-058), docs/SPECS_SIMULATION_ENGINES.md section 5:
// truth -> ideal sample -> noise/bias -> EW -> quantization -> MAVLink.
// Callers pass the baseline (ideal + noise) sample; the pipeline applies the
// EW distorter into its own scratch sample and quantizes with SensorMapping
// into the reusable HIL_GPS/HIL_SENSOR payloads. The baseline is never
// modified, and the distorter is structural so this package does not depend
// on @mirage/ew. Allocation-free after construction.
import type { GpsSample, ImuSample } from "@mirage/mavlink/samples";
import { SensorMapping } from "@mirage/mavlink/sensor-mapping";

export interface ObservationDistorter {
  distortGpsInto(source: GpsSample, target: GpsSample): boolean;
  distortImuInto(source: ImuSample, target: ImuSample): boolean;
}

export class SensorPipeline {
  /** Quantized payloads: mapping.gps (HIL_GPS, 39 B) and mapping.sensor (HIL_SENSOR, 65 B). */
  readonly mapping = new SensorMapping();
  /** Distorted, unquantized observations of the last call (diagnostics/AAR). */
  readonly gps: GpsSample = { timeLoUs: 0, timeHiUs: 0, latitudeRad: 0, longitudeRad: 0, altitudeMslM: 0, vnMps: 0,
    veMps: 0, vdMps: 0, hdop: 0, vdop: 0, hdopValid: false, vdopValid: false, fixType: 0, satellites: 0,
    satellitesValid: false, velocityValid: false, courseRad: 0, courseValid: false };
  readonly imu: ImuSample = { timeLoUs: 0, timeHiUs: 0, specificForceBodyMps2: new Float64Array(3),
    gyroBodyRadS: new Float64Array(3), magBodyGauss: new Float64Array(3), pressurePa: 0, differentialPressurePa: 0,
    pressureAltitudeM: 0, temperatureK: 0, updatedMask: 0 };

  constructor(private readonly ew: ObservationDistorter) {}

  /** EW then quantization into mapping.gps; false if either stage rejects the sample. */
  gpsInto(baseline: GpsSample): boolean {
    return this.ew.distortGpsInto(baseline, this.gps) && this.mapping.gpsInto(this.gps);
  }

  /** EW then quantization into mapping.sensor; false if either stage rejects the sample. */
  imuInto(baseline: ImuSample): boolean {
    return this.ew.distortImuInto(baseline, this.imu) && this.mapping.sensorInto(this.imu);
  }
}
