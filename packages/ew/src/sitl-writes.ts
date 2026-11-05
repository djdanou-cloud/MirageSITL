import { JAM_DENIED_SEVERITY, JAM_DOP, JAM_RECOVERY_SEVERITY, JAM_SATELLITES } from "./gnss-jamming.ts";

// What the interference models ask of ArduPilot's own simulated receiver and magnetometers (TASK-169), on a run with stock firmware
// (decision D-10). The state line carries a GNSS position and a magnetometer rotation exactly on a tick; what it has no field for goes
// through SITL's own parameters, each a logged write. Cold path, in the run controller.
//
// libraries/SITL/SIM_GPS.cpp at the pinned commit: NUMSATS is what it reports, ACC is its horizontal and vertical accuracy, and LCKTIME
// delays its lock, here past any run (ENABLE would too, but writing it renumbers ArduPilot's parameter list; see fault-effects.ts).
// SIM_GPS_UBLOX.cpp reports a fixed hDOP of 1.21, so a DOP has no parameter of its own, and a receiver's position accuracy grows in
// proportion to its DOP.

export const SITL_GPS_NUMSATS = "SIM_GPS1_NUMSATS", SITL_GPS_ACC = "SIM_GPS1_ACC", SITL_GPS_LOCK = "SIM_GPS1_LCKTIME";
/** The largest lock delay, s: its AP_Int16 holds no more. */
export const SITL_GPS_NO_LOCK_S = 32767;
/** The hDOP SITL's u-blox reports. */
export const SITL_GPS_HDOP = 1.21;
export const MAG_INSTANCES = [1, 2, 3] as const, MAG_AXES = ["X", "Y", "Z"] as const;
const MILLIGAUSS_PER_GAUSS = 1000;
export interface ParameterWrite { readonly name: string; readonly value: number }

/**
 * The receiver at a settled jamming severity: the same arithmetic as GnssJamming at its steady state, whose half-second low-pass a
 * parameter write does not resolve. `baseline` holds the values the receiver had before the effect, and `denied` whether it is denied
 * now, which holds until the severity falls below the recovery level.
 */
export function jammingWrites(severity: number, baseline: { readonly satellites: number; readonly accuracyM: number; readonly lockS: number }, denied: boolean): readonly ParameterWrite[] {
  const q = Math.min(1, Math.max(0, severity));
  const satellites = Math.min(baseline.satellites, Math.round((1 - q) * baseline.satellites + q * JAM_SATELLITES));
  const dop = Math.max(SITL_GPS_HDOP, (1 - q) * SITL_GPS_HDOP + q * JAM_DOP);
  const lost = q >= JAM_DENIED_SEVERITY || satellites < 4 || (denied && q >= JAM_RECOVERY_SEVERITY);
  return [{ name: SITL_GPS_NUMSATS, value: satellites }, { name: SITL_GPS_ACC, value: baseline.accuracyM * dop / SITL_GPS_HDOP }, { name: SITL_GPS_LOCK, value: lost ? SITL_GPS_NO_LOCK_S : baseline.lockS }];
}
export const JAMMING_PARAMETERS: readonly string[] = [SITL_GPS_NUMSATS, SITL_GPS_ACC, SITL_GPS_LOCK];

export const magOffsetName = (instance: number, axis: string): string => `SIM_MAG${instance}_OFS_${axis}`;
export const MAGNETIC_PARAMETERS: readonly string[] = MAG_INSTANCES.flatMap(instance => MAG_AXES.map(axis => magOffsetName(instance, axis)));
/**
 * A magnetometer bias, gauss in body axes, as SITL's offsets: AP_Compass_SITL subtracts SIM_MAGn_OFS from the field it reports, so the
 * reading gains `b` when the offset falls by `b` from whatever the Sensors tab set. It adds to that value and never replaces it.
 */
export function magneticBiasWrites(biasBodyGauss: readonly [number, number, number], baseline: (name: string) => number): readonly ParameterWrite[] {
  return MAG_INSTANCES.flatMap(instance => MAG_AXES.map((axis, index) => {
    const name = magOffsetName(instance, axis);
    return { name, value: baseline(name) - (biasBodyGauss[index] ?? 0) * MILLIGAUSS_PER_GAUSS };
  }));
}
